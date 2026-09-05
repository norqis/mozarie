from __future__ import annotations

import gc
import sqlite3
import sys
import threading
import time
from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Any

import numpy as np
from PIL import Image

from .core import JOB_LABELS, LOGGER, CandidateRole, ClientError, ImageRecord, Job, JobControl
from .image_io import calculate_block_size
from .masks import compose_masks, expand_mask, union_mask
from .runtime import runtime_backend

class JobsMixin:
    @staticmethod
    def _is_gpu_out_of_memory(exc: BaseException) -> bool:
        """Recognise the OOM forms emitted by PyTorch and ONNX Runtime."""
        if isinstance(exc, MemoryError):
            return False
        if exc.__class__.__name__ == "OutOfMemoryError" and "torch" in exc.__class__.__module__:
            return True
        message = str(exc).casefold()
        return any(marker in message for marker in (
            "cuda out of memory",
            "cuda error out of memory",
            "cuda out of memory",
            "could not allocate cuda",
            "not enough gpu video memory",
            "not enough memory resources are available",
            "e_outofmemory",
            "bfcarena",
        ))

    def _gpu_oom_client_error(self, exc: BaseException) -> ClientError | None:
        """Return a localised-by-code error without exposing runtime exception text."""
        if isinstance(exc, ClientError) or self.settings["models"].get("provider") != "gpu" or not self._is_gpu_out_of_memory(exc):
            return None
        message = "GPUメモリが不足しました。他のGPUアプリを閉じるか、CPUまたは小さいSAMモデル（vit_b）を選択してください。"
        return ClientError(message, "gpu_out_of_memory", {"parallelism": 1})

    @staticmethod
    def _empty_selected_gpu_cache(torch: Any, gpu_device: int) -> None:
        cuda = torch.cuda
        if not cuda.is_available():
            return
        device_context = getattr(cuda, "device", None)
        if callable(device_context):
            context = device_context(int(gpu_device))
            if hasattr(context, "__enter__"):
                with context:
                    cuda.empty_cache()
                return
        cuda.empty_cache()

    def _release_gpu_cache(self, *, provider: str | None = None, gpu_device: int | None = None) -> None:
        """Collect detached GPU objects and empty the selected PyTorch cache."""
        gc.collect()
        selected_provider = provider if provider is not None else str(self.settings["models"].get("provider", "gpu"))
        if selected_provider != "gpu":
            return
        torch = sys.modules.get("torch")
        if torch is not None and runtime_backend(torch_module=torch) == "cuda":
            self._empty_selected_gpu_cache(torch, int(gpu_device if gpu_device is not None else self.settings["models"].get("gpu_device", 0)))

    def _release_gpu_job_memory(self) -> None:
        """Release inference objects after a background job has returned."""
        with self.inference_lock:
            provider = str(self.settings["models"].get("provider", "gpu"))
            # CPU jobs keep their loaded models for the next image.  GPU jobs
            # retain the existing release path so normal completion and OOM
            # recovery still return accelerator memory promptly.
            if provider != "gpu":
                return
            gpu_device = int(self.settings["models"].get("gpu_device", 0))
            with self.sam_lock:
                if self.sam_predictor is not None:
                    self.sam_predictor.reset_image()
                self.sam_predictor = None
                self.sam_image_id = None
                if self.hand_segmentation_predictor is not None:
                    self.hand_segmentation_predictor.reset_image()
                self.hand_segmentation_predictor = None
                self.hand_segmentation_image_id = None
            with self.lock:
                self.models = None
                self.hand_model = None
            self._release_gpu_cache(provider=provider, gpu_device=gpu_device)

    def recover_gpu_oom_for_request(self, exc: BaseException) -> ClientError | None:
        """Map an interactive inference OOM and make the next request reusable."""
        client_error = self._gpu_oom_client_error(exc)
        if client_error is not None:
            exc.__traceback__ = None
            self._release_gpu_job_memory()
        return client_error

    def _set_job_parallelism(
        self,
        parallelism: int,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self.job.parallelism = parallelism

    def _pause_job_clock(self) -> None:
        if self.job.paused_at is None:
            self.job.paused_at = time.time()

    def _resume_job_clock(self) -> None:
        if self.job.paused_at is not None:
            self.job.paused_seconds += max(0.0, time.time() - self.job.paused_at)
            self.job.paused_at = None

    def request_pause(self) -> Job:
        with self.lock:
            if (self.job.kind not in {"apply", "detect"} or self.job.state != "running"
                    or self.job.completed >= self.job.total):
                raise ClientError("一時停止できる処理はありません。", "operation_in_progress")
            assert self.job_control is not None
            control = self.job_control
        # Serialising this with record claims means no new image starts after a
        # successful pause request; already claimed images finish atomically.
        with control.claim_lock:
            with self.lock:
                if self.job_control is not control or self.job.state != "running":
                    raise ClientError("一時停止できる処理はありません。", "operation_in_progress")
                control.pause_requested.set()
                self.job.state = "paused" if self.job.active_count == 0 else "pausing"
                if self.job.state == "paused":
                    self.job.current = ""
                    self._pause_job_clock()
        return self.job

    def resume_job(self) -> Job:
        with self.lock:
            if self.job.kind not in {"apply", "detect"} or self.job.state != "paused":
                raise ClientError("再開できる処理はありません。", "operation_in_progress")
            assert self.job_control is not None
            self.job_control.pause_requested.clear()
            self._resume_job_clock()
            self.job.state = "running"
            return self.job


    def request_cancel(self) -> Job:
        with self.lock:
            if self.job.kind not in {"apply", "detect"} or self.job.state not in {"running", "pausing", "paused"}:
                raise ClientError("キャンセルできる処理はありません。", "operation_in_progress")
            assert self.job_control is not None
            control = self.job_control
        # Use the same lock order as claim(), so a successful cancel cannot be
        # followed by another claim.
        with control.claim_lock:
            with self.lock:
                if self.job_control is not control or self.job.state not in {"running", "pausing", "paused"}:
                    raise ClientError("キャンセルできる処理はありません。", "operation_in_progress")
                control.cancel_requested.set()
                control.pause_requested.clear()
                self.job.cancel_requested = True
                job = self.job
        return job

    def _records_for_ids(self, image_ids: list[str]) -> list[ImageRecord]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。", "input_invalid")
        source_ids = image_ids or self.order
        if len({str(image_id) for image_id in source_ids}) != len(source_ids):
            raise ClientError("同じ画像を複数回指定できません。", "input_invalid")
        records = [self.image_for_id(str(image_id)) for image_id in source_ids]
        if not records:
            raise ClientError("処理する画像がありません。", "image_not_found")
        return records

    def _records_for_ids_with_catalog(self, image_ids: list[str]) -> tuple[list[ImageRecord], int]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。", "input_invalid")
        with self.lock:
            source_ids = image_ids or list(self.order)
            if len({str(image_id) for image_id in source_ids}) != len(source_ids):
                raise ClientError("同じ画像を複数回指定できません。", "input_invalid")
            records = [self.images.get(str(image_id)) for image_id in source_ids]
            root = self.root
            session_imports_dir = self.session_imports_dir
            catalog_generation = self.catalog_generation
        if not records or any(record is None for record in records):
            raise ClientError("処理する画像がありません。", "image_not_found")
        verified_records = [record for record in records if record is not None]
        for record in verified_records:
            try:
                allowed_root = self._allowed_root_for_record(record, root, session_imports_dir)
                if allowed_root is None:
                    raise ValueError
                record.path.resolve().relative_to(allowed_root.resolve())
            except ValueError as exc:
                raise ClientError("許可されていない画像パスです。", "input_invalid") from exc
            if not record.path.is_file():
                raise ClientError("画像ファイルが見つかりません。", "image_not_found")
        for record in verified_records:
            self._assert_record_stat_matches(record)
        return verified_records, catalog_generation

    def _start_job(
        self,
        kind: str,
        records: list[ImageRecord],
        worker: Any,
        *args: Any,
        expected_catalog_generation: int | None = None,
    ) -> None:
        if not self.import_lock.acquire(blocking=False):
            raise ClientError("画像の追加中です。完了後にもう一度実行してください。", "operation_in_progress")
        try:
            self._start_job_unlocked(
                kind,
                records,
                worker,
                *args,
                expected_catalog_generation=expected_catalog_generation,
            )
        finally:
            self.import_lock.release()

    def _start_job_unlocked(
        self,
        kind: str,
        records: list[ImageRecord],
        worker: Any,
        *args: Any,
        expected_catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("別の処理が進行中です。", "operation_in_progress")
            if expected_catalog_generation is not None and self.catalog_generation != expected_catalog_generation:
                raise ClientError("画像一覧が更新されたため、もう一度実行してください。", "catalog_changed")
            self.job_generation += 1
            job_generation = self.job_generation
            catalog_generation = self.catalog_generation
            control = JobControl()
            self.job = Job(
                kind=kind,
                state="running",
                total=len(records),
                started_at=time.time(),
                image_ids=tuple(record.image_id for record in records),
            )
            self._job_output_slots: dict[int, str] = {}
            self.job_control = control
        LOGGER.debug("バックグラウンド処理を開始: %s (%d件)", JOB_LABELS.get(kind, kind), len(records))
        def run_worker() -> None:
            try:
                worker(
                    records,
                    *args,
                    control=control,
                    job_generation=job_generation,
                    catalog_generation=catalog_generation,
                )
            finally:
                self._release_gpu_job_memory()

        thread = threading.Thread(target=run_worker, daemon=True)
        with self.lock:
            self.worker_thread = thread
        thread.start()


    def _wait_while_paused(self, control: JobControl | None, job_generation: int | None, catalog_generation: int | None) -> None:
        while (control is not None and control.pause_requested.is_set()
               and not control.cancel_requested.is_set() and not control.failed.is_set()):
            with self.lock:
                if (self._job_is_current(job_generation, catalog_generation)
                        and control.pause_requested.is_set() and self.job.active_count == 0):
                    self.job.state = "paused"
                    self.job.current = ""
                    self._pause_job_clock()
            time.sleep(0.1)

    def _cancel_job(self, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self._resume_job_clock()
                self.job.state = "cancelled"
                self.job.cancel_requested = False
                self.job.ended_at = time.time()
                self.job.current = ""
                self.job.active_count = 0
    def combined_candidate_mask(
        self,
        image_id: str,
        draft: tuple[np.ndarray | None, np.ndarray | None, np.ndarray | None] | None = None,
        manual_exclude_forced: bool | None = None,
        removed_candidate_ids: set[str] | None = None,
        candidate_snapshot: list[Candidate] | None = None,
        lock_image: bool = True,
    ) -> np.ndarray | None:
        if draft is None:
            add_mask, exclusion_mask, exclusion_erase_mask = None, None, None
        else:
            add_mask, exclusion_mask, *remaining = draft
            exclusion_erase_mask = remaining[0] if remaining else None
        with (self.image_io_lock(image_id) if lock_image else nullcontext()):
            with self.lock:
                current_record = self.images.get(image_id)
                if current_record is None:
                    raise ClientError("画像が見つかりません。", "image_not_found")
                record = replace(current_record)
                removed_candidate_ids = removed_candidate_ids or set()
                source_candidates = candidate_snapshot if candidate_snapshot is not None else self.candidates.get(image_id, [])
                candidates = [replace(candidate) for candidate in source_candidates if candidate.enabled and candidate.candidate_id not in removed_candidate_ids]
                revision = self._candidate_revision(image_id)
                catalog_generation = self.catalog_generation
            apply_candidates = [candidate for candidate in candidates if candidate.role == CandidateRole.APPLY]
            if not apply_candidates and add_mask is None:
                return None
            shape = (record.height, record.width)
            apply_union: np.ndarray | None = None
            exclude_union: np.ndarray | None = None
            forced_exclude_union: np.ndarray | None = None
            for candidate in candidates:
                self.materialize_candidate_mask(candidate, image_id)
                try:
                    with Image.open(candidate.mask_path) as mask_image:
                        mask = expand_mask(np.asarray(mask_image.convert("L"), dtype=np.uint8), candidate.expand_px)
                except FileNotFoundError as exc:
                    raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。", "catalog_changed") from exc
                if mask.shape != shape:
                    raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                if candidate.role == CandidateRole.APPLY:
                    apply_union = union_mask(apply_union, mask)
                else:
                    exclude_union = union_mask(exclude_union, mask)
                    if candidate.forced:
                        forced_exclude_union = union_mask(forced_exclude_union, mask)
            result = compose_masks(
                shape, [apply_union] if apply_union is not None else [], [exclude_union] if exclude_union is not None else [], add_mask, exclusion_mask,
                [forced_exclude_union] if forced_exclude_union is not None else [], True if manual_exclude_forced is None else manual_exclude_forced, exclusion_erase_mask,
            )
            with self.lock:
                current_record = self.images.get(image_id)
                if (current_record is None or current_record.path != record.path
                        or self.catalog_generation != catalog_generation or self._candidate_revision(image_id) != revision):
                    raise ClientError("候補が変更されました。もう一度実行してください。", "catalog_changed")
            return result

    def _set_job_current(
        self,
        current: str,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self.job.current = current
                self.job.completed = len(self.job.completed_image_ids)

    def _set_detection_model_preparation(
        self,
        active: bool,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        """Expose only real model/session loading time to detection progress."""
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation) and self.job.kind == "detect":
                self.job.preparing_models = max(0, self.job.preparing_models + (1 if active else -1))

    def _mark_image_completed(
        self,
        image_id: str,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation) and image_id not in self.job.completed_image_ids:
                completed = {*self.job.completed_image_ids, image_id}
                self.job.completed_image_ids = tuple(item for item in self.job.image_ids if item in completed)
                self.job.completed = len(self.job.completed_image_ids)

    def _record_job_success(
        self,
        index: int,
        image_id: str,
        output: str | None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        """Publish completed records in request order, not completion order."""
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return
            if output is not None:
                slots = getattr(self, "_job_output_slots", {})
                slots[index] = output
                self._job_output_slots = slots
                self.job.outputs = [slots[position] for position in range(len(self.job.image_ids)) if position in slots]
        self._mark_image_completed(image_id, job_generation, catalog_generation)

    def _finish_claimed_task(
        self,
        control: JobControl,
        job_generation: int | None,
        catalog_generation: int | None,
    ) -> int:
        """Release one claimed record and publish a completed pause request."""
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return 0
            self.job.active_count -= 1
            if (control.pause_requested.is_set() and not control.cancel_requested.is_set()
                    and not control.failed.is_set() and self.job.active_count == 0):
                if self.job.completed >= self.job.total:
                    control.pause_requested.clear()
                    return self.job.active_count
                self.job.state = "paused"
                self.job.current = ""
                self._pause_job_clock()
            return self.job.active_count

    def _run_fixed_workers(
        self,
        records: list[ImageRecord],
        worker_count: int,
        process: Any,
        control: JobControl | None,
        job_generation: int | None,
        catalog_generation: int | None,
    ) -> list[tuple[int, Exception]]:
        """Run a bounded worker set that dynamically claims the next input item."""
        if not records:
            return []
        control = control or JobControl()
        next_index = 0
        failures: list[tuple[int, Exception]] = []
        failures_lock = threading.Lock()

        def claim() -> tuple[int, ImageRecord] | None:
            nonlocal next_index
            with control.claim_lock:
                if (control.cancel_requested.is_set() or control.failed.is_set()
                        or not self._job_is_current(job_generation, catalog_generation)
                        or control.pause_requested.is_set()):
                    return None
                if next_index >= len(records):
                    return None
                index = next_index
                next_index += 1
                with self.lock:
                    if self._job_is_current(job_generation, catalog_generation):
                        self.job.active_count += 1
                return index, records[index]

        def worker() -> None:
            while True:
                self._wait_while_paused(control, job_generation, catalog_generation)
                if control.cancel_requested.is_set() or control.failed.is_set():
                    return
                item = claim()
                if item is None:
                    if control.pause_requested.is_set() and not control.cancel_requested.is_set() and not control.failed.is_set():
                        continue
                    return
                index, record = item
                try:
                    process(index, record)
                except Exception as exc:  # Let already claimed records finish.
                    with failures_lock:
                        failures.append((index, exc))
                    control.failed.set()
                finally:
                    self._finish_claimed_task(control, job_generation, catalog_generation)

        with ThreadPoolExecutor(max_workers=min(worker_count, len(records))) as executor:
            futures = [executor.submit(worker) for _ in range(min(worker_count, len(records)))]
            for future in futures:
                future.result()
        return sorted(failures, key=lambda failure: failure[0])

    def _finish_job(self, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return
            self._resume_job_clock()
            self.job.state = "complete"
            self.job.cancel_requested = False
            self.job.ended_at = time.time()
            self.job.completed = self.job.total
            self.job.current = ""
            self.job.active_count = 0
            kind = self.job.kind
            total = self.job.total
        LOGGER.debug("バックグラウンド処理が完了: %s (%d件)", JOB_LABELS.get(kind, kind), total)

    def _fail_job(self, exc: Exception, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        unexpected: Exception | None = None
        gpu_oom = self._gpu_oom_client_error(exc)
        if gpu_oom is not None:
            # The worker retains the original exception until it returns. Do
            # not retain partially-created CUDA models through that traceback.
            exc.__traceback__ = None
        if not isinstance(exc, ClientError):
            if isinstance(exc, sqlite3.DatabaseError):
                exc = ClientError("作業データを保存できませんでした。Mozarieを再起動して、もう一度お試しください。", "workspace_database_error")
            elif self.job.kind == "apply" and isinstance(exc, OSError):
                exc = ClientError("保存先に書き込めませんでした。保存先と空き容量を確認してください。", "output_unavailable")
            elif gpu_oom is not None:
                exc = gpu_oom
            elif isinstance(exc, MemoryError):
                exc = ClientError(
                    "処理用メモリを確保できませんでした。画像サイズを小さくして、もう一度実行してください。",
                    "memory_allocation_failed",
                )
            else:
                unexpected = exc
                exc = ClientError("処理を完了できませんでした。もう一度お試しください。", "internal_error")
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return
            kind = self.job.kind
            self._resume_job_clock()
            self.job.state = "error"
            self.job.cancel_requested = False
            self.job.ended_at = time.time()
            self.job.error = str(exc)
            self.job.error_code = exc.error_code
            self.job.params = dict(exc.params)
            self.job.current = ""
            self.job.active_count = 0
        if unexpected is not None:
            LOGGER.error("バックグラウンド処理に失敗: %s: %s", JOB_LABELS.get(kind, kind), exc, exc_info=unexpected)
        else:
            LOGGER.error("バックグラウンド処理に失敗: %s: %s", JOB_LABELS.get(kind, kind), exc)
