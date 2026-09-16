from __future__ import annotations

import re
import sqlite3
import warnings
import atexit
import msvcrt
import os
import secrets
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .core import (
    APP_DIR, CACHE_BASE_DIR, DEFAULT_COLORS, LOGGER, SESSION_BASE_DIR,
    BrowserSaveReceipt, BrowserSaveToken, Candidate, ClientError, ImageRecord,
    InferenceGate, Job, JobControl, torch_module,
)
from .config import SettingsError, SettingsStore, validate_output_directory_ready
from .runtime_types import DetectionModels
from .runtime import directml_devices, onnx_execution_status, runtime_backend
from .catalog import CatalogMixin
from .saving import SavingMixin
from .detection import DetectionMixin
from .jobs import JobsMixin
from .model_downloads import ModelDownloadManager
from .workspace import WorkspaceOpenError, WorkspaceStore
from .save_journal import SaveJournal


def cuda_device_statuses(torch: Any) -> list[dict[str, object]]:
    """List CUDA devices that this PyTorch build can actually execute on."""
    cuda = torch.cuda
    # PyTorch emits a process-wide warning while merely enumerating an older
    # adapter. The Settings check reports that incompatibility itself.
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"\s*Found GPU\d+",
            category=UserWarning,
        )
        warnings.filterwarnings(
            "ignore",
            message=r"\s*NVIDIA .* with CUDA capability sm_\d+ is not compatible with the current PyTorch installation",
            category=UserWarning,
        )
        if not cuda.is_available():
            return []
        arch_list = cuda.get_arch_list()
        supported_majors = {
            int(match.group(1)) // 10
            for arch in arch_list
            if (match := re.fullmatch(r"sm_(\d+)(?:[af])?", arch))
        }
        devices = []
        for index in range(cuda.device_count()):
            major, minor = cuda.get_device_capability(index)
            architecture = f"sm_{major}{minor}"
            devices.append({
                "id": index,
                "name": cuda.get_device_name(index),
                "architecture": architecture,
                "totalMemory": int(cuda.get_device_properties(index).total_memory),
                # Match PyTorch's CUDA cubin check: an NVIDIA cubin is
                # compatible with devices from the same compute major.
                # With no embedded cubin list, PyTorch skips that warning.
                "supported": not arch_list or major in supported_majors,
            })
    return devices


def gpu_device_statuses(torch: Any, *, backend: str | None = None) -> list[dict[str, object]]:
    backend = backend or runtime_backend(torch_module=torch)
    if backend == "directml":
        try:
            return directml_devices()
        except (ImportError, OSError, RuntimeError):
            return []
    return cuda_device_statuses(torch) if backend == "cuda" else []


class StudioState(CatalogMixin, SavingMixin, DetectionMixin, JobsMixin):
    def __init__(self, cache_dir: Path | None = None, session_base_dir: Path | None = None) -> None:
        self.settings_store = SettingsStore(APP_DIR)
        self.workspace_store = WorkspaceStore(APP_DIR / "data")
        self.save_journal = SaveJournal(APP_DIR / "data")
        try:
            self.save_journal.recover(self.workspace_store.browser_save_receipt)
        except (OSError, sqlite3.Error) as exc:
            LOGGER.warning("保存ジャーナルの起動時回復を保留しました: %s", exc)
        # The pass above resolves file ownership.  Background apply receipts
        # have no browser ACK, so compact them only after that succeeds.
        for receipt in self.workspace_store.apply_save_receipts():
            token = str(receipt["token"])
            try:
                if self.save_journal.recover_token(token, lambda _token, receipt=receipt: receipt) and self.save_journal.acknowledge(token):
                    self.workspace_store.acknowledge_browser_save_receipt(token)
            except (OSError, sqlite3.Error) as exc:
                LOGGER.warning("保存ジャーナルの起動時後処理を保留しました: %s", exc)
        # ``catalog_id`` is the public named-project identity.  An unnamed
        # screen uses ``workspace_id`` too, but that internal catalog never
        # appears in the projects list or request expectations.
        self.catalog_id: str | None = None
        self.workspace_id: str | None = self.workspace_store.active_projectless_catalog()
        self.project_read_only = False
        self.source_mismatches: dict[str, bool] = {}
        self.settings = self.settings_store.load()
        self._active_detection_default_padding = int(self.settings["detection"]["default_candidate_padding_px"])
        self._active_detection_default_exclude_padding = int(self.settings["detection"]["default_exclude_candidate_padding_px"])
        self.lock = threading.RLock()
        self.import_lock = threading.RLock()
        self._request_catalog_expectation = threading.local()
        self.shutdown_requested = threading.Event()
        self.active_import_count = 0
        self._import_sessions: dict[str, dict[str, Any]] = {}
        self._manual_uploads: dict[str, dict[str, Any]] = {}
        self._pending_manual_upload_cleanup: list[Path] = []
        self._cache_lock_handle: Any | None = None
        self._owns_process_cache = cache_dir is None
        if cache_dir is None:
            self._cleanup_stale_process_caches()
            self.cache_dir = CACHE_BASE_DIR / f"process-{os.getpid()}-{uuid.uuid4().hex}"
            self.cache_dir.mkdir(parents=True, exist_ok=False)
            self._cache_lock_handle = self._lock_directory(self.cache_dir)
        else:
            self.cache_dir = Path(cache_dir)
        self.session_base_dir = Path(session_base_dir) if session_base_dir is not None else SESSION_BASE_DIR
        self.session_dir: Path | None = None
        self.session_imports_dir: Path | None = None
        self._session_lock_handle: Any | None = None
        self.root: Path | None = None
        # The latest native-folder scan is returned by the folder endpoint so
        # the browser can name every unreadable file while keeping valid files.
        self.last_folder_scan_failures: list[dict[str, str]] = []
        self.source_roots: dict[str, Path] = {}
        # Published with the catalogue; never read a newer durable source list
        # into an older live image/root generation.
        self.catalog_sources: list[dict[str, Any]] = []
        self.images: dict[str, ImageRecord] = {}
        self.order: list[str] = []
        self.candidates: dict[str, list[Candidate]] = {}
        self.candidate_revisions: dict[str, int] = {}
        # Kept only for opening databases written by older app processes.
        # New unnamed workspaces use SQLite just like named projects.
        self.projectless_manual_drafts: dict[str, dict[str, Any]] = {}
        # These locks only serialize work for the same catalogue record.  State
        # mutation still uses ``lock``; never acquire an image lock while that
        # global lock is held.
        self._image_io_locks: dict[str, threading.RLock] = {}
        self.browser_save_tokens: dict[str, BrowserSaveToken] = {}
        # A claimed token is being committed outside ``lock``. A later prepare
        # must leave its already-written copy alone until the commit finishes.
        self.browser_save_claims: set[str] = set()
        self.browser_save_receipts: dict[str, BrowserSaveReceipt] = {}
        self.source_delete_receipts: dict[str, dict[str, Any]] = {}
        self._pending_browser_save_cleanup: list[tuple[Path, tuple[int, int] | None]] = []
        self.output_destination_lock = threading.Lock()
        # Windows native dialogs are process-modal. Keep folder and model
        # pickers mutually exclusive without blocking unrelated work.
        self.native_picker_lock = threading.Lock()
        self.model_downloads = ModelDownloadManager(APP_DIR)
        self.reserved_output_paths: set[Path] = set()
        self.session_token = secrets.token_urlsafe(32)
        self.job = Job()
        self._job_snapshot = self._copy_job_snapshot(self.job.as_dict())
        self.catalog_generation = 0
        self.job_generation = 0
        self.worker_thread: threading.Thread | None = None
        self.job_control: JobControl | None = None
        self.models: DetectionModels | None = None
        self.hand_model: Any | None = None
        self.sam_predictor: Any | None = None
        self.sam_image_id: str | None = None
        self.sam_lock = threading.RLock()
        self.hand_segmentation_predictor: Any | None = None
        self.hand_segmentation_image_id: str | None = None
        # SAM and HandSegNet both retain large CUDA embeddings. One shared
        # re-entrant lock prevents their peak allocations from overlapping.
        self.hand_segmentation_lock = self.sam_lock
        self.inference_lock = InferenceGate()
        self.retry_source_delete_cleanups()
        self._cleanup_stale_sessions()

    def begin_shutdown(self) -> None:
        """Let long-lived local operations leave cleanly during process shutdown."""
        self.shutdown_requested.set()
        self.workspace_store.shutdown()

    def set_image_flags_bulk(self, payload: dict[str, Any]) -> dict[str, dict[str, bool]]:
        """Keep durable bulk flags and a concurrent catalog publication in one state epoch."""
        return super().set_image_flags_bulk(payload)

    @contextmanager
    def catalog_request(self, expected_project_id: str | None, expected_catalog_generation: int):
        """Make one HTTP mutation verify its captured catalogue at commit points."""
        previous = getattr(self._request_catalog_expectation, "value", None)
        self._request_catalog_expectation.value = (expected_project_id, expected_catalog_generation)
        try:
            yield
        finally:
            self._request_catalog_expectation.value = previous

    @staticmethod
    def _copy_job_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
        return {
            **snapshot,
            "params": dict(snapshot.get("params", {})),
            "outputs": list(snapshot.get("outputs", [])),
            "imageIds": list(snapshot.get("imageIds", [])),
            "completedImageIds": list(snapshot.get("completedImageIds", [])),
        }

    def _publish_job_snapshot_unchecked(self) -> dict[str, Any]:
        self._job_snapshot = self._copy_job_snapshot(self.job.as_dict())
        return self._job_snapshot

    def job_snapshot(self) -> dict[str, Any]:
        if self.lock.acquire(blocking=False):
            try:
                snapshot = self._publish_job_snapshot_unchecked()
            finally:
                self.lock.release()
        else:
            snapshot = self._job_snapshot
        return self._copy_job_snapshot(snapshot)

    def update_settings(self, update: dict[str, Any]) -> dict[str, Any]:
        """Persist user-selected options and release only model objects that changed."""
        if not isinstance(update, dict):
            raise ClientError("設定の形式が正しくありません。", "invalid_settings")
        with self.inference_lock, self.lock:
            if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            try:
                settings = self.settings_store.validate_update(update)
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
            try:
                validate_output_directory_ready(settings["saving"]["default_output_directory"])
            except (SettingsError, OSError) as exc:
                raise ClientError("保存先フォルダを使用できません。", "output_folder_unavailable") from exc
            # Selecting an output folder must remain available when a previously
            # configured GPU is temporarily unavailable. Model changes still
            # receive the same validation before they are persisted.
            if settings["models"] != previous_models:
                self._require_supported_gpu(settings["models"])
            settings = self.settings_store.save(settings)
            self.settings = settings
            detection_keys = {
                "target_segmentation", "ntd11", "ntd11_enabled", "sensitive", "sensitive_enabled",
                "hand_detection", "hand_detection_enabled", "provider", "gpu_device",
            }
            sam_keys = {"sam_checkpoints", "sam_model_type", "provider", "gpu_device"}
            if any(settings["models"].get(key) != previous_models.get(key) for key in detection_keys):
                self.models = None
                self.hand_model = None
            if any(settings["models"].get(key) != previous_models.get(key) for key in sam_keys):
                self.sam_predictor = None
                self.sam_image_id = None
            if any(settings["models"].get(key) != previous_models.get(key) for key in {"hand_segmentation", "hand_segmentation_enabled", "provider", "gpu_device"}):
                self.hand_segmentation_predictor = None
                self.hand_segmentation_image_id = None
            resource_keys = detection_keys | sam_keys | {"hand_segmentation", "hand_segmentation_enabled"}
            if (previous_models.get("provider") == "gpu"
                    and any(settings["models"].get(key) != previous_models.get(key) for key in resource_keys)):
                self._release_gpu_cache(provider="gpu", gpu_device=int(previous_models.get("gpu_device", 0)))
            return self.settings

    @staticmethod
    def _gpu_selection_error() -> ClientError:
        return ClientError("選択したGPUは使用できません。対応しているGPUを選ぶか、CPUへ切り替えてください。", "gpu_unsupported")

    def _require_supported_gpu(self, models: dict[str, Any] | None = None, *, require_runtime: bool = True) -> None:
        models = models or self.settings["models"]
        if models["provider"] != "gpu":
            return
        backend, runtime_ready = onnx_execution_status()
        if require_runtime and (backend not in {"cuda", "directml"} or not runtime_ready):
            raise ClientError(
                "選択したGPU用のONNX Runtimeを開始できません。Mozarieを再セットアップしてください。",
                "gpu_runtime_unavailable",
            )
        selected_gpu = next(
            (gpu for gpu in gpu_device_statuses(torch_module(), backend=backend) if gpu["id"] == models["gpu_device"]),
            None,
        )
        if not selected_gpu or not selected_gpu["supported"]:
            raise self._gpu_selection_error()

    def diagnose_gpu_runtime(self) -> tuple[str, ...]:
        """Exercise a disposable ONNX session without retaining it in model state."""
        from .inference.onnx import diagnose_runtime
        with self.inference_lock:
            with self.lock:
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中はGPU推論を確認できません。", "operation_in_progress")
                models = dict(self.settings["models"])
            self._require_supported_gpu(models, require_runtime=False)
            try:
                return diagnose_runtime("gpu", int(models.get("gpu_device", 0)))
            except ClientError:
                raise
            except Exception as exc:
                raise ClientError("GPU推論を確認できません。CUDA環境とモデルファイルを確認してください。", "gpu_unavailable") from exc

    def reset_settings(self) -> dict[str, Any]:
        with self.inference_lock, self.lock:
            if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            try:
                settings = self.settings_store.default_settings()
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
            try:
                validate_output_directory_ready(settings["saving"]["default_output_directory"])
            except (SettingsError, OSError) as exc:
                raise ClientError("保存先フォルダを使用できません。", "output_folder_unavailable") from exc
            self.settings = self.settings_store.reset(settings)
            self.models = None
            self.hand_model = None
            self.sam_predictor = None
            self.sam_image_id = None
            self.hand_segmentation_predictor = None
            self.hand_segmentation_image_id = None
            if previous_models.get("provider") == "gpu":
                self._release_gpu_cache(provider="gpu", gpu_device=int(previous_models.get("gpu_device", 0)))
            return self.settings

    @staticmethod
    def _valid_import_session_id(session_id: str) -> bool:
        try:
            return str(uuid.UUID(session_id)) == session_id
        except (TypeError, ValueError, AttributeError):
            return False

    def start_import_session(self, session_id: str, expected_project_id: str | None, expected_catalog_generation: int) -> dict[str, int | bool]:
        """Open one browser import explicitly; a later inactive batch is abandoned by the next start."""
        if not self._valid_import_session_id(session_id):
            raise ClientError("画像追加セッションが正しくありません。", "input_invalid")
        with self.import_lock:
            with self.lock:
                if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中は画像を追加できません。", "operation_in_progress")
                self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                current = self._import_sessions.get(session_id)
                if current is not None:
                    if current["project_id"] != expected_project_id or current["generation"] != expected_catalog_generation:
                        raise ClientError("画像追加セッションが更新されています。", "stale_catalog")
                    return {"ok": True, "catalogGeneration": self.catalog_generation}
                for stale_id, stale in tuple(self._import_sessions.items()):
                    if stale["active"]:
                        raise ClientError("別の画像追加が完了するまでお待ちください。", "operation_in_progress")
                    LOGGER.info("ブラウザー画像読込を放棄: bytes=%d 送信成功=%d件 送信失敗=%d件 所要=%.2f秒", stale["bytes"], stale["succeeded"], stale["failed"], time.monotonic() - stale["started_at"])
                    del self._import_sessions[stale_id]
                self._import_sessions[session_id] = {
                    "project_id": expected_project_id, "generation": expected_catalog_generation,
                    "last_generation": expected_catalog_generation, "active": 0, "finish_requested": False,
                    "succeeded": 0, "failed": 0, "bytes": 0, "started_at": time.monotonic(), "outcome": {},
                }
                LOGGER.info("ブラウザー画像読込を開始")
                return {"ok": True, "catalogGeneration": self.catalog_generation}

    def begin_import_transfer(self, session_id: str, expected_project_id: str | None, expected_catalog_generation: int) -> None:
        """Claim one browser import batch without serialising its file I/O."""
        if not self._valid_import_session_id(session_id):
            raise ClientError("画像追加セッションが正しくありません。", "input_invalid")
        with self.import_lock:
            with self.lock:
                if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中は画像を追加できません。", "operation_in_progress")
                session = self._import_sessions.get(session_id)
                if session is None:
                    raise ClientError("画像追加セッションを開始し直してください。", "operation_in_progress")
                if session["project_id"] != expected_project_id or session["generation"] != expected_catalog_generation:
                    raise ClientError("画像追加セッションが更新されています。", "stale_catalog")
                elif session["finish_requested"]:
                    raise ClientError("画像追加セッションは完了しています。", "operation_in_progress")
                elif self.catalog_id != expected_project_id or (session["active"] == 0 and self.catalog_generation != session["last_generation"]):
                    raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")
                session["active"] += 1
                self.active_import_count += 1

    def import_session_is_current(self, session_id: str | None, expected_project_id: str | None,
                                  expected_catalog_generation: int) -> bool:
        session = self._import_sessions.get(session_id or "")
        return bool(session and session["project_id"] == expected_project_id
                    and session["generation"] == expected_catalog_generation
                    and self.catalog_id == expected_project_id
                    and self.catalog_generation >= expected_catalog_generation)

    def record_import_transfer_bytes(self, session_id: str, byte_count: int) -> None:
        with self.lock:
            session = self._import_sessions.get(session_id)
            if session is not None and byte_count >= 0:
                session["bytes"] += byte_count

    def end_import_transfer(self, session_id: str, *, succeeded: bool) -> None:
        with self.import_lock:
            with self.lock:
                if self.active_import_count:
                    self.active_import_count -= 1
                session = self._import_sessions.get(session_id)
                if session is not None:
                    session["active"] = max(0, session["active"] - 1)
                    session["succeeded" if succeeded else "failed"] += 1
                    if not session["active"]:
                        session["last_generation"] = self.catalog_generation
                    if session["finish_requested"] and not session["active"]:
                        self._log_import_session_finished(session)
                        del self._import_sessions[session_id]

    @staticmethod
    def _log_import_session_finished(session: dict[str, Any]) -> None:
        outcome = session.get("outcome", {})
        LOGGER.info(
            "ブラウザー画像読込を完了: bytes=%d 送信成功=%d件 送信失敗=%d件 完了=%d件 失敗=%s 取消=%s 所要=%.2f秒",
            session["bytes"], session["succeeded"], session["failed"], int(outcome.get("completed", session["succeeded"])),
            bool(outcome.get("failed", False)), bool(outcome.get("cancelled", False)), time.monotonic() - session["started_at"],
        )

    def finish_import_session(self, session_id: str, owner_project_id: str | None,
                              owner_catalog_generation: int, outcome: dict[str, Any] | None = None) -> dict[str, int | bool]:
        """Release a batch by its immutable starting owner, even after a view switch."""
        with self.import_lock:
            with self.lock:
                session = self._import_sessions.get(session_id)
                if session is None:
                    return {"ok": True, "catalogGeneration": self.catalog_generation}
                if session["project_id"] != owner_project_id or session["generation"] != owner_catalog_generation:
                    raise ClientError("画像追加セッションが更新されています。", "stale_catalog")
                session["finish_requested"] = True
                session["outcome"] = outcome or {}
                if session["active"]:
                    return {"ok": True, "pending": True, "catalogGeneration": self.catalog_generation}
                self._log_import_session_finished(session)
                del self._import_sessions[session_id]
                return {"ok": True, "catalogGeneration": self.catalog_generation}

    @staticmethod
    def _valid_manual_layer(value: Any) -> bool:
        return value in {"add", "exclusion", "exclusionErase"}

    def _discard_manual_upload_unchecked(self, session_id: str, session: dict[str, Any], reason: str) -> None:
        """Delete a non-writing manual transaction while retaining it if Windows refuses cleanup."""
        try:
            shutil.rmtree(session["directory"])
        except FileNotFoundError:
            pass
        except OSError as exc:
            LOGGER.error("手描きマスク転送を片付けられません: %s", exc)
            raise ClientError("手描きマスクの一時データを片付けられません。もう一度実行してください。", "workspace_write_failed") from exc
        self._manual_uploads.pop(session_id, None)
        LOGGER.info("手描きマスク転送を放棄: %s", reason)

    def cleanup_manual_upload_files(self) -> None:
        """Retry staging cleanup after a completed transaction without changing its result."""
        with self.lock:
            directories = self._pending_manual_upload_cleanup
            self._pending_manual_upload_cleanup = []
        retry: list[Path] = []
        for directory in directories:
            try:
                shutil.rmtree(directory)
            except FileNotFoundError:
                continue
            except OSError as exc:
                LOGGER.warning("手描きマスク転送の確定済み一時データ削除を保留: %s", exc)
                retry.append(directory)
        if retry:
            with self.lock:
                self._pending_manual_upload_cleanup.extend(retry)

    @staticmethod
    def _release_manual_writer(session: dict[str, Any]) -> None:
        writer = session.get("writer")
        if writer is not None and writer.locked():
            writer.release()

    def begin_manual_upload(self, image_id: str, session_id: str, dirty_layers: Any) -> dict[str, str]:
        """Start a small, explicit transaction for streamed hand-drawn PNG layers."""
        if not self._valid_import_session_id(session_id):
            raise ClientError("手描き保存セッションが正しくありません。", "input_invalid")
        if not isinstance(dirty_layers, list) or not dirty_layers or any(not self._valid_manual_layer(layer) for layer in dirty_layers):
            raise ClientError("手描き保存のレイヤーが正しくありません。", "input_invalid")
        requested = set(dirty_layers)
        with self.lock:
            self._assert_request_catalog_expectation()
            self._assert_catalog_mutable()
            self._assert_image_editable(image_id)
            if image_id not in self.images:
                raise ClientError("画像が見つかりません。", "image_not_found")
            stale_sessions = [
                (stale_id, stale) for stale_id, stale in self._manual_uploads.items()
                if stale["image_id"] == image_id and stale["catalog_id"] == self.catalog_id
                and stale["catalog_generation"] == self.catalog_generation
            ]
            claimed: list[dict[str, Any]] = []
            for _stale_id, stale in stale_sessions:
                writer = stale["writer"]
                if not writer.acquire(blocking=False):
                    for claimed_session in claimed: self._release_manual_writer(claimed_session)
                    raise ClientError("手描きマスクを転送中です。完了後にもう一度実行してください。", "operation_in_progress")
                claimed.append(stale)
            try:
                for stale_id, stale in stale_sessions:
                    self._discard_manual_upload_unchecked(stale_id, stale, "次の保存で置換")
            finally:
                for claimed_session in claimed: self._release_manual_writer(claimed_session)
            directory = self.cache_dir / "manual-staging" / session_id
            directory.mkdir(parents=True, exist_ok=False)
            self._manual_uploads[session_id] = {
                "image_id": image_id, "catalog_id": self.catalog_id, "catalog_generation": self.catalog_generation,
                "layers": requested, "uploaded": set(), "directory": directory, "started_at": time.monotonic(), "writing": None,
                "writer": threading.Lock(), "abandon_reason": None,
            }
        LOGGER.info("手描きマスク転送を開始: レイヤー=%d件", len(requested))
        self.cleanup_manual_upload_files()
        return {"sessionId": session_id}

    def manual_upload_layer_path(self, image_id: str, session_id: str, layer: str) -> Path:
        if not self._valid_import_session_id(session_id) or not self._valid_manual_layer(layer):
            raise ClientError("手描き保存セッションが正しくありません。", "input_invalid")
        with self.lock:
            session = self._manual_uploads.get(session_id)
            if (session is None or session["image_id"] != image_id or layer not in session["layers"]
                    or session["catalog_id"] != self.catalog_id or session["catalog_generation"] != self.catalog_generation):
                raise ClientError("手描き保存を開始し直してください。", "stale_catalog")
            if not session["writer"].acquire(blocking=False):
                raise ClientError("手描きマスクを転送中です。完了後にもう一度実行してください。", "operation_in_progress")
            session["writing"] = layer
            return session["directory"] / f"{layer}.png"

    def finish_manual_upload_layer(self, image_id: str, session_id: str, layer: str, byte_count: int) -> None:
        with self.lock:
            session = self._manual_uploads.get(session_id)
            if session is None or session["image_id"] != image_id or layer not in session["layers"] or session["writing"] != layer:
                raise ClientError("手描き保存を開始し直してください。", "stale_catalog")
            try:
                if session["abandon_reason"] is not None:
                    self._discard_manual_upload_unchecked(session_id, session, str(session["abandon_reason"]))
                    raise ClientError("画像一覧が更新されました。もう一度操作してください。", "stale_catalog")
                session["uploaded"].add(layer)
                session["writing"] = None
            finally:
                self._release_manual_writer(session)
        LOGGER.info("手描きマスク転送: レイヤー=%s bytes=%d", layer, byte_count)

    def abort_manual_upload_layer(self, image_id: str, session_id: str, layer: str) -> None:
        """Release a writer claim after a disconnected or failed binary body."""
        with self.lock:
            session = self._manual_uploads.get(session_id)
            if session is None or session["image_id"] != image_id or session["writing"] != layer:
                return
            try:
                if session["abandon_reason"] is not None:
                    self._discard_manual_upload_unchecked(session_id, session, str(session["abandon_reason"]))
                else:
                    session["writing"] = None
            finally:
                self._release_manual_writer(session)

    def commit_manual_upload(self, image_id: str, session_id: str, payload: dict[str, Any]) -> None:
        if not self._valid_import_session_id(session_id):
            raise ClientError("手描き保存セッションが正しくありません。", "input_invalid")
        with self.lock:
            session = self._manual_uploads.get(session_id)
            if (session is None or session["image_id"] != image_id or session["catalog_id"] != self.catalog_id
                    or session["catalog_generation"] != self.catalog_generation):
                raise ClientError("手描き保存を開始し直してください。", "stale_catalog")
            if not session["writer"].acquire(blocking=False):
                raise ClientError("手描きマスクを転送中です。完了後にもう一度実行してください。", "operation_in_progress")
            try:
                session["writing"] = "commit"
                empty_layers = payload.get("emptyLayers", [])
                if not isinstance(empty_layers, list) or any(layer not in session["layers"] for layer in empty_layers):
                    raise ClientError("手描き保存のレイヤーが正しくありません。", "input_invalid")
                empty = set(empty_layers)
                if session["layers"] != session["uploaded"] | empty:
                    raise ClientError("手描きマスクを最後まで受信していません。", "input_invalid")
                directory = session["directory"]
                committed = dict(payload)
                committed["dirtyLayers"] = sorted(session["layers"])
                for layer in session["layers"]:
                    committed[layer] = "" if layer in empty else (directory / f"{layer}.png").read_bytes()
            except Exception:
                session["writing"] = None
                self._release_manual_writer(session)
                raise
        save_succeeded = False
        try:
            self.save_manual_workspace(image_id, committed)
            save_succeeded = True
        finally:
            with self.lock:
                current = self._manual_uploads.get(session_id)
                if current is session:
                    session["writing"] = None
                    try:
                        if save_succeeded:
                            self._manual_uploads.pop(session_id, None)
                            self._pending_manual_upload_cleanup.append(directory)
                        else:
                            reason = str(session["abandon_reason"]) if session["abandon_reason"] is not None else "確定失敗"
                            self._discard_manual_upload_unchecked(session_id, session, reason)
                    finally:
                        self._release_manual_writer(session)
                else:
                    self._release_manual_writer(session)
        self.cleanup_manual_upload_files()
        LOGGER.info("手描きマスク転送を完了: レイヤー=%d件 所要=%.2f秒", len(session["layers"]), time.monotonic() - session["started_at"])

    def cancel_manual_upload(self, image_id: str, session_id: str) -> None:
        with self.lock:
            session = self._manual_uploads.get(session_id)
            if session is None or session["image_id"] != image_id:
                return
            if not session["writer"].acquire(blocking=False):
                raise ClientError("手描きマスクを転送中です。完了後にもう一度実行してください。", "operation_in_progress")
            try:
                # This endpoint is used after an automatic save failure.  It
                # cleans only the private staging files; the visible draft is
                # retained by the browser for retry.
                self._discard_manual_upload_unchecked(session_id, session, "確定失敗後の一時転送を破棄")
            finally:
                self._release_manual_writer(session)

    def _cancel_manual_uploads_unchecked(self, reason: str) -> None:
        """Call while ``lock`` is held when a catalogue transition invalidates staged layers."""
        for session_id, session in tuple(self._manual_uploads.items()):
            if not session["writer"].acquire(blocking=False):
                session["abandon_reason"] = reason
                continue
            try:
                self._discard_manual_upload_unchecked(session_id, session, reason)
            finally:
                self._release_manual_writer(session)

    def settings_status(self, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        """Report configured model files without loading model data."""
        models = (settings or self.settings)["models"]
        sam_enabled = (settings or self.settings)["detection"].get("mode") == "high_precision"
        result: dict[str, dict[str, Any]] = {}
        def add_status(key: str, *, required: bool, enabled: bool, required_suffix: str | None = None, raw_path: str | None = None) -> None:
            raw = str(models.get(key, "") if raw_path is None else raw_path).strip()
            if not required and not enabled:
                result[key] = {
                    "required": False,
                    "enabled": False,
                    "configured": bool(raw),
                    "exists": False,
                    "valid": False,
                    "reasonCode": None,
                }
                return
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            valid = exists and (required_suffix is None or path.suffix.lower() == required_suffix)
            reason_code: str | None = None
            if not raw:
                reason_code = "not_configured"
            elif not exists:
                reason_code = "missing"
            elif not valid:
                reason_code = "invalid_format"
            if valid and key == "sam_checkpoint" and path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
                valid = False
                reason_code = "invalid_format"
            result[key] = {
                "required": required,
                "enabled": enabled,
                "configured": bool(raw),
                "exists": exists,
                "valid": valid,
                "reasonCode": reason_code,
            }

        add_status("target_segmentation", required=True, enabled=True, required_suffix=".onnx")
        add_status("ntd11", required=False, enabled=bool(models["ntd11_enabled"]), required_suffix=".onnx")
        add_status("sensitive", required=False, enabled=bool(models["sensitive_enabled"]), required_suffix=".onnx")
        add_status("hand_detection", required=False, enabled=bool(models["hand_detection_enabled"]), required_suffix=".onnx")
        add_status(
            "hand_segmentation",
            required=False,
            enabled=bool(models.get("hand_detection_enabled")) and bool(models.get("hand_segmentation_enabled")),
            required_suffix=".safetensors",
        )
        add_status("sam_checkpoint", required=sam_enabled, enabled=sam_enabled, raw_path=str(models["sam_checkpoints"].get(models["sam_model_type"], "")))
        sam_files = {
            "vit_b": "sam_vit_b_01ec64.pth",
            "vit_l": "sam_vit_l_0b3195.pth",
            "vit_h": "sam_vit_h_4b8939.pth",
        }
        sam_variants: dict[str, dict[str, Any]] = {}
        app_dir = self.settings_store.defaults_path.parent.parent.resolve()
        for variant, filename in sam_files.items():
            raw = str(models.get("sam_checkpoints", {}).get(variant, "")).strip()
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            suffix_valid = bool(path and path.suffix.lower() in {".pth", ".pt", ".ckpt"})
            known_match = None
            if path:
                known_match = next((key for key, known in sam_files.items() if path.name.lower() == known.lower()), None)
            mismatch = known_match is not None and known_match != variant
            managed_path = (app_dir / "models" / filename).resolve()
            managed = bool(path and path.resolve() == managed_path)
            reason_code = None
            if not raw:
                reason_code = "not_configured"
            elif not exists:
                reason_code = "missing"
            elif not suffix_valid:
                reason_code = "invalid_format"
            elif mismatch:
                reason_code = "type_mismatch"
            sam_variants[variant] = {
                "path": raw,
                "configured": bool(raw),
                "exists": exists,
                "valid": exists and suffix_valid and not mismatch,
                "managed": managed,
                "reasonCode": reason_code,
            }
        torch = torch_module()
        backend, runtime_ready = onnx_execution_status()
        gpus = gpu_device_statuses(torch, backend=backend)
        selected_gpu = next((gpu for gpu in gpus if gpu["id"] == models.get("gpu_device", 0)), None)
        gpu_device_valid = models["provider"] != "gpu" or bool(runtime_ready and backend in {"cuda", "directml"} and selected_gpu and selected_gpu["supported"])
        gpu_reason = None
        if not gpu_device_valid:
            gpu_reason = "gpu_runtime_unavailable" if not runtime_ready or backend not in {"cuda", "directml"} else "gpu_unsupported"
        return {
            "models": result,
            "provider": models["provider"],
            "samModelType": models["sam_model_type"],
            "samVariants": sam_variants,
            "gpus": gpus,
            "runtimeBackend": backend,
            "runtimeReady": runtime_ready,
            "gpuDevice": models.get("gpu_device", 0),
            "gpuDeviceValid": gpu_device_valid,
            "gpuDeviceReasonCode": gpu_reason,
        }

    def preview_settings_status(self, update: dict[str, Any]) -> dict[str, Any]:
        try:
            settings = self.settings_store.validate_update(update)
        except SettingsError as exc:
            raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
        return self.settings_status(settings)

    @staticmethod
    def _lock_directory(directory: Path) -> Any:
        lock_handle = (directory / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
            return lock_handle
        except Exception:
            lock_handle.close()
            raise

    @staticmethod
    def _release_directory_lock(lock_handle: Any | None) -> None:
        if lock_handle is None:
            return
        try:
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        lock_handle.close()

    @classmethod
    def _cleanup_stale_process_caches(cls) -> None:
        if not CACHE_BASE_DIR.is_dir():
            return
        cutoff = time.time() - 60
        for cache_dir in CACHE_BASE_DIR.glob("process-*"):
            if not cache_dir.is_dir():
                continue
            lock_path = cache_dir / ".active.lock"
            try:
                if not lock_path.exists():
                    if cache_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(cache_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(cache_dir, ignore_errors=True)
            except OSError:
                continue

    def _cleanup_stale_sessions(self) -> None:
        """Remove abandoned import sessions without touching a live instance."""
        if not self.session_base_dir.is_dir():
            return
        cutoff = time.time() - 60
        for session_dir in self.session_base_dir.glob("session-*"):
            try:
                if not session_dir.is_dir():
                    continue
                lock_path = session_dir / ".active.lock"
                if not lock_path.exists():
                    if session_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(session_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(session_dir, ignore_errors=True)
            except OSError:
                continue

    def _ensure_session(self) -> Path:
        if self.session_imports_dir is not None:
            return self.session_imports_dir
        self.session_base_dir.mkdir(parents=True, exist_ok=True)
        session_dir = self.session_base_dir / f"session-{uuid.uuid4().hex}"
        imports_dir = session_dir / "imports"
        imports_dir.mkdir(parents=True)
        lock_handle = (session_dir / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
        except Exception:
            lock_handle.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        self.session_dir = session_dir
        self.session_imports_dir = imports_dir
        self._session_lock_handle = lock_handle
        return imports_dir

    def _detach_session_unchecked(self) -> tuple[Path | None, Any | None]:
        session_dir = self.session_dir
        lock_handle = self._session_lock_handle
        self.session_dir = None
        self.session_imports_dir = None
        self._session_lock_handle = None
        return session_dir, lock_handle

    @staticmethod
    def _release_detached_session(session: tuple[Path | None, Any | None]) -> None:
        session_dir, lock_handle = session
        if lock_handle is not None:
            try:
                lock_handle.seek(0)
                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            lock_handle.close()
        if session_dir is not None:
            shutil.rmtree(session_dir, ignore_errors=True)

STATE: StudioState | None
STATE_STARTUP_ERROR: WorkspaceOpenError | sqlite3.DatabaseError | None = None
try:
    STATE = StudioState()
except (WorkspaceOpenError, sqlite3.DatabaseError) as exc:
    STATE = None
    STATE_STARTUP_ERROR = exc
else:
    atexit.register(STATE.shutdown)


def recreate_workspace() -> StudioState:
    """Explicit recovery action; source images are never part of this deletion."""
    global STATE, STATE_STARTUP_ERROR
    try:
        WorkspaceStore.recreate(APP_DIR / "data")
        restored = StudioState()
    except (WorkspaceOpenError, sqlite3.DatabaseError) as exc:
        # Keep the recovery screen active if recreating the local store itself
        # fails; leaving a stale state here would make the next request lie.
        STATE = None
        STATE_STARTUP_ERROR = exc
        raise
    STATE = restored
    STATE_STARTUP_ERROR = None
    atexit.register(STATE.shutdown)
    return STATE
