from __future__ import annotations

import warnings
import base64
import binascii
import io
import json
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from .core import (
    IMAGE_SUFFIXES, IO_CHUNK_BYTES, PNG_SIGNATURE,
    BrowserSaveToken, ClientError, ImageRecord, Job, LOGGER, StaleMaskError,
    safe_import_relative_path, torch_module,
)
from .domain import Candidate, CandidateRole
from .image_io import _valid_color, decode_draft_masks, draft_manual_exclusion_forced, inspect_import_image, mask_alpha_or_luma, open_image, oriented_image_size, unique_session_import_destination
from .masks import compose_masks, expand_mask, union_mask
from .runtime import patch_directml_sam_prompt_encoder, runtime_backend, torch_device
from .save_journal import SaveJournal
from .workspace import ProjectNameAlreadyExistsError, ProjectSourceNoMatchError, ProjectSourcePathConflictError, ProjectSourceUnavailableError, WorkspaceStore, native_source_identity

class CatalogMixin:
    @staticmethod
    def _rename_filename(value: Any) -> str:
        if not isinstance(value, str):
            raise ClientError("新しいファイル名が正しくありません。", "input_invalid")
        name = value.strip()
        reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{number}" for number in range(1, 10)), *(f"LPT{number}" for number in range(1, 10))}
        stem = name.split(".", 1)[0].upper()
        if (not name or name in {".", ".."} or name.endswith((".", " "))
                or any(ord(character) < 32 or character in '<>:"/\\|?*' for character in name)
                or stem in reserved):
            raise ClientError("Windowsで使えないファイル名です。", "input_invalid")
        return name

    def rename_catalog_image(self, image_id: str, filename: Any, *, browser_renamed: bool = False) -> dict[str, Any]:
        """Store a requested output name; the source moves only after overwrite."""
        del browser_renamed
        name = self._rename_filename(filename)
        with self.import_lock, self.image_io_lock(image_id):
            with self.lock:
                self._assert_catalog_mutable()
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中はファイル名を変更できません。", "operation_in_progress")
                record = self.images.get(image_id)
                if record is None:
                    raise ClientError("画像が見つかりません。", "image_not_found")
                canonical_name = safe_import_relative_path(record.relative_path).name
                if Path(name).suffix.casefold() != Path(canonical_name).suffix.casefold():
                    raise ClientError("拡張子は変更できません。", "rename_extension_unsupported")
                if self._has_active_browser_save_for_image_unchecked(image_id):
                    raise ClientError("保存中の画像は名前を変更できません。", "operation_in_progress")
                edited_filename = None if name == canonical_name else name
                if record.edited_filename == edited_filename:
                    return {"images": self.list_images(), "catalogGeneration": self.catalog_generation}
                if self.workspace_id is not None:
                    self.workspace_store.set_image_edited_filename(image_id, edited_filename)
                record.edited_filename = edited_filename
                self.catalog_generation += 1
                return {"images": self.list_images(), "catalogGeneration": self.catalog_generation}

    def _assert_catalog_expectation(self, expected_project_id: str | None, expected_catalog_generation: int | None) -> None:
        """Reject a request captured from a different live catalogue."""
        if expected_project_id != self.catalog_id or expected_catalog_generation != self.catalog_generation:
            raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")

    def _assert_request_catalog_expectation(self) -> None:
        expectation = getattr(self._request_catalog_expectation, "value", None)
        if expectation is not None:
            self._assert_catalog_expectation(*expectation)

    def assert_catalog_expectation(self, expected_project_id: str | None, expected_catalog_generation: int) -> None:
        with self.lock:
            self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)

    def _assert_image_processable(self, image_id: str) -> None:
        with self.lock:
            record = self.images.get(image_id)
            if record is None:
                raise ClientError("画像が見つかりません。", "image_not_found")
            if record.hidden:
                raise ClientError("非表示の画像は処理できません。再表示してから実行してください。", "image_hidden")

    def _assert_images_processable(self, image_ids: list[str]) -> None:
        for image_id in image_ids:
            self._assert_image_processable(image_id)

    def _assert_history_images_present(self, image_ids: list[str]) -> None:
        if any(image_id not in self.images for image_id in image_ids):
            raise ClientError("画像が見つかりません。", "image_not_found")

    def _assert_image_editable(self, image_id: str) -> None:
        with self.lock:
            self._assert_catalog_mutable()
            self._assert_image_processable(image_id)
            if image_id in self.source_mismatches:
                raise ClientError("元画像が変更されています。変更確認を完了してから編集してください。", "source_mismatch")

    def _effective_mask_for_draft(self, image_id: str, candidates: list[Candidate], draft: dict[str, Any]) -> bool:
        """Compute the gallery scalar for an unpublished candidate/manual state."""
        record = self.image_snapshot(image_id)
        add, exclusion, erase = decode_draft_masks(draft, record.width, record.height)
        if draft.get("manualEnabled") is False: add = None
        if draft.get("manualExclusionEnabled") is False: exclusion = None
        if draft.get("manualExclusionEraseEnabled") is False: erase = None
        valid_ids = {candidate.candidate_id for candidate in candidates}
        removed = {str(value) for value in draft.get("removedCandidateIds", [])} & valid_ids
        mask = self.combined_candidate_mask(
            image_id, (add, exclusion, erase),
            manual_exclude_forced=draft_manual_exclusion_forced(draft, self.settings["detection"].get("exclude_forced_default", True)),
            removed_candidate_ids=removed, candidate_snapshot=candidates, lock_image=False,
        )
        return bool(mask is not None and np.any(mask))

    def _effective_mask_for_candidates(self, image_id: str, candidates: list[Candidate]) -> bool:
        draft = self.workspace_store.manual(image_id, self._encode_workspace_mask) or {}
        return self._effective_mask_for_draft(image_id, candidates, draft)

    @staticmethod
    def _candidate_from_workspace(row: Any, path: Path) -> Candidate:
        return Candidate(
            candidate_id=str(row["candidate_id"]), label_token=str(row["label_token"]), confidence=row["confidence"], mask_path=path,
            enabled=bool(row["enabled"]), color=str(row["color"]), source=str(row["source"]), origin=str(row["origin"]),
            refinement=row["refinement"], role=CandidateRole(str(row["role"])), forced=bool(row["forced"]), expand_px=int(row["expand_px"]),
        )

    def _restore_workspace_candidates(self, records: list[ImageRecord]) -> None:
        """Materialise only small PNGs for the active catalogue into the disposable cache."""
        restored: list[tuple[str, int, list[Candidate]]] = []
        hydrated = self.workspace_store.hydrate_candidates_bulk(
            [record.image_id for record in records], self.cache_dir, self._candidate_from_workspace,
        )
        for record in records:
            revision, candidates = hydrated.get(record.image_id, (0, []))
            if candidates or revision:
                restored.append((record.image_id, revision, candidates))
        for image_id, revision, candidates in restored:
            self.candidates[image_id] = candidates
            self.candidate_revisions[image_id] = revision

    def _synchronize_workspace_candidate_revisions(self, records: list[ImageRecord]) -> None:
        """Repair a stale process snapshot from the durable workspace before a job starts.

        The caller holds the affected image locks and ``self.lock``. Normal
        mutations publish SQLite and memory together, so this path is used only
        after an interrupted publication or when reopening older workspace
        state.
        """
        if not self.workspace_id or not records:
            return
        image_ids = [record.image_id for record in records]
        durable = self.workspace_store.candidate_revisions(image_ids)
        stale_ids = [
            image_id for image_id in image_ids
            if image_id in durable and self._candidate_revision(image_id) != durable[image_id]
        ]
        if not stale_ids:
            return
        hydrated = self.workspace_store.hydrate_candidates_bulk(
            stale_ids, self.cache_dir, self._candidate_from_workspace,
        )
        # Validate every durable row before discarding the still-usable live
        # cache. A broken workspace row must not damage the current view.
        for image_id in stale_ids:
            shutil.rmtree(self.cache_dir / image_id, ignore_errors=True)
        for image_id in stale_ids:
            revision, candidates = hydrated[image_id]
            self.candidates[image_id] = candidates
            self.candidate_revisions[image_id] = revision
        LOGGER.warning(
            "候補状態を保存領域から再同期: 対象=%d件",
            len(stale_ids),
        )

    def _commit_candidate_snapshot(self, image_id: str, candidates: list[Candidate], *, replace: bool, history_group: str | None = None) -> int:
        """Durably commit a candidate revision, then publish it while the caller holds ``self.lock``."""
        self._assert_request_catalog_expectation()
        revision = self._candidate_revision(image_id) + 1
        if self.workspace_id and self.workspace_store.has_image(image_id):
            self.workspace_store.commit_candidate_state(
                image_id, revision, candidates,
                self._effective_mask_for_candidates(image_id, candidates), replace=replace, history_group=history_group,
            )
        else:
            draft = self.projectless_manual_drafts.get(image_id)
            if draft is not None:
                draft["candidateRevision"] = revision
                draft["hasEffectiveMask"] = self._effective_mask_for_draft(image_id, candidates, draft)
        self.candidates[image_id] = candidates
        self.candidate_revisions[image_id] = revision
        self.images[image_id].reviewed = False
        return revision

    def _commit_candidate_snapshot_outside_state_lock(
        self, image_id: str, candidates: list[Candidate], *, replace: bool,
        expected_revision: int, expected_catalog_generation: int, history_group: str | None = None,
    ) -> int:
        """Persist a detector result while only publishing under ``self.lock``.

        The caller holds the image lock, so edits or a catalogue replacement
        cannot interleave with the expensive PNG composition and SQLite work.
        """
        revision = expected_revision + 1
        pending = None
        projectless_draft = None
        if self.workspace_id and self.workspace_store.has_image(image_id):
            draft = self.workspace_store.manual(image_id, self._encode_workspace_mask) or {}
            effective = self._effective_mask_for_draft(image_id, candidates, draft)
            pending = self.workspace_store.prepare_candidate_state(
                image_id, revision, candidates, effective, replace=replace, history_group=history_group,
                expected_revision=expected_revision, preserve_reviewed=True,
            )
        else:
            projectless_draft = self.projectless_manual_drafts.get(image_id)
            effective = self._effective_mask_for_draft(image_id, candidates, projectless_draft or {})
        with self.lock:
            if self.catalog_generation != expected_catalog_generation or self._candidate_revision(image_id) != expected_revision:
                if pending is not None:
                    pending.rollback()
                raise ClientError("フォルダを再読み込みしたため、検出結果を破棄しました。", "catalog_changed")
            # The durable commit and runtime publication are one short state
            # critical section. A stale detector result is rolled back before
            # either state becomes externally visible.
            if pending is not None:
                pending.commit()
            self.candidates[image_id] = candidates
            self.candidate_revisions[image_id] = revision
            if projectless_draft is not None:
                projectless_draft["candidateRevision"] = revision
                projectless_draft["hasEffectiveMask"] = effective
        return revision

    def _stage_workspace_candidates(self, records: list[ImageRecord]) -> dict[str, tuple[int, list[Candidate]]]:
        """Validate candidate metadata before replacing the live catalogue."""
        return self.workspace_store.hydrate_candidates_bulk(
            [record.image_id for record in records], self.cache_dir, self._candidate_from_workspace,
        )

    def _refresh_catalog_records(self, records: list[ImageRecord]) -> None:
        states = self.workspace_store.image_states([record.image_id for record in records])
        for record in records:
            saved = states.get(record.image_id)
            if saved is None:
                continue
            record.hidden = saved["hidden"]; record.reviewed = saved["reviewed"]
            record.edited_filename = saved.get("edited_filename")
            record.flip_horizontal = saved["flip_horizontal"]; record.flip_vertical = saved["flip_vertical"]
            record.source_flip_horizontal = saved["source_flip_horizontal"]; record.source_flip_vertical = saved["source_flip_vertical"]
            record.transform_revision = saved["transform_revision"]

    @staticmethod
    def _apply_source_state(records: list[ImageRecord], stored: dict[str, dict[str, Any]], source_id: str, root: Path, *, keep_unstored: bool = False) -> tuple[list[ImageRecord], dict[str, bool]]:
        accepted: list[ImageRecord] = []
        mismatches: dict[str, bool] = {}
        for record in records:
            saved = stored.get(record.relative_path)
            if saved is None:
                if keep_unstored:
                    record.source_id = source_id; record.source_root = root; accepted.append(record)
                continue
            record.image_id = str(saved["image_id"])
            record.hidden = bool(saved["hidden"])
            record.reviewed = bool(saved["reviewed"])
            record.edited_filename = saved.get("edited_filename")
            record.flip_horizontal = bool(saved.get("flip_horizontal", False)); record.flip_vertical = bool(saved.get("flip_vertical", False))
            record.source_flip_horizontal = bool(saved.get("source_flip_horizontal", False)); record.source_flip_vertical = bool(saved.get("source_flip_vertical", False))
            record.transform_revision = int(saved.get("transform_revision", 0))
            record.source_id = source_id
            record.source_root = root
            accepted.append(record)
            if saved.get("changed"):
                mismatches[record.image_id] = bool(saved.get("dimensions_changed"))
        return accepted, mismatches

    def _replace_catalog(self, root: Path, records: list[ImageRecord], *, detach_project: bool = False,
                         prehydrated: dict[str, tuple[int, list[Candidate]]] | None = None,
                         publish_catalog_id: str | None = None,
                         publish_workspace_id: str | None = None,
                         publish_active_workspace_id: str | None = None,
                         discard_workspace_id: str | None = None,
                         publish_read_only: bool = False,
                         publish_source_mismatches: dict[str, bool] | None = None,
                         publish_sources: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        new_ids = {record.image_id for record in records}
        with self.lock:
            previous_ids = tuple(self.images)
            lock_ids = set(previous_ids) | new_ids
            locks = []
            for image_id in sorted(lock_ids):
                image_lock = self._image_io_locks.get(image_id)
                if image_lock is None:
                    image_lock = threading.RLock()
                    self._image_io_locks[image_id] = image_lock
                locks.append((image_id, image_lock))
        with ExitStack() as stack:
            for _image_id, image_lock in sorted(locks):
                stack.enter_context(image_lock)
            if prehydrated is not None:
                self._refresh_catalog_records(records)
            session: tuple[Path | None, Any | None]
            with self.lock:
                if publish_catalog_id is None:
                    self._assert_catalog_mutable()
                self._invalidate_sam_cache()
                live_state = {
                    "catalog_id": self.catalog_id,
                    "workspace_id": self.workspace_id,
                    "project_read_only": self.project_read_only,
                    "source_mismatches": self.source_mismatches,
                    "images": self.images,
                    "order": self.order,
                    "candidates": self.candidates,
                    "candidate_revisions": self.candidate_revisions,
                    "projectless_manual_drafts": self.projectless_manual_drafts,
                    "root": self.root,
                    "source_roots": self.source_roots,
                    "catalog_sources": self.catalog_sources,
                }
                activated_workspace = False
                try:
                    # The active pointer becomes durable before the live screen
                    # changes.  If the live swap cannot finish, the except block
                    # restores it before the new workspace is discarded.
                    if publish_active_workspace_id is not None:
                        self.workspace_store.activate_projectless_catalog(publish_active_workspace_id)
                        activated_workspace = True
                    if detach_project:
                        self.catalog_id = None
                        self.workspace_id = None
                        self.project_read_only = False
                        self.source_mismatches = {}
                    self.images = {record.image_id: record for record in records}
                    self.order = [record.image_id for record in records]
                    self.candidates = {} if prehydrated is None else {image_id: candidates for image_id, (_revision, candidates) in prehydrated.items()}
                    self.candidate_revisions = ({record.image_id: 0 for record in records} if prehydrated is None
                                                else {record.image_id: prehydrated.get(record.image_id, (0, []))[0] for record in records})
                    self.projectless_manual_drafts = {}
                    self.root = root
                    self.source_roots = {str(record.source_id): record.source_root for record in records if record.source_id and record.source_root}
                    self.catalog_sources = [dict(source) for source in publish_sources] if publish_sources is not None else ([] if detach_project else self.catalog_sources)
                    if publish_catalog_id is not None:
                        self.catalog_id = publish_catalog_id
                        self.workspace_id = publish_catalog_id
                        self.project_read_only = publish_read_only
                    elif publish_workspace_id is not None:
                        self.catalog_id = None
                        self.workspace_id = publish_workspace_id
                        self.project_read_only = False
                    if publish_source_mismatches is not None:
                        self.source_mismatches = dict(publish_source_mismatches)
                    # Old unnamed data is removed only after the active pointer
                    # and every live catalog field describe the new workspace.
                    if discard_workspace_id and discard_workspace_id != self.workspace_id:
                        self.workspace_store.delete_project(discard_workspace_id)
                except Exception:
                    for field, value in live_state.items():
                        setattr(self, field, value)
                    if activated_workspace:
                        self.workspace_store.restore_active_projectless_catalog(
                            discard_workspace_id, expected_catalog_id=publish_active_workspace_id,
                        )
                    raise
                self._clear_browser_save_tokens_unchecked()
                self.job = Job()
                self._publish_job_snapshot_unchecked()
                self.catalog_generation += 1
                self._cancel_manual_uploads_unchecked("画像一覧を切り替えました")
                keep_session = self.session_imports_dir is not None and any(
                    record.source_kind == "session" and record.path.is_relative_to(self.session_imports_dir)
                    for record in records
                )
                session = (None, None) if keep_session else self._detach_session_unchecked()
            self._clear_cache()
            if prehydrated is None:
                # Cache cleanup intentionally happens before masks are materialised.
                self._restore_workspace_candidates(records)
            self._release_detached_session(session)
            with self.lock:
                for image_id, image_lock in locks:
                    if image_id not in new_ids and self._image_io_locks.get(image_id) is image_lock:
                        self._image_io_locks.pop(image_id, None)
        self.cleanup_browser_save_files()
        return self.list_images()

    def _has_active_worker(self) -> bool:
        return self.worker_thread is not None and self.worker_thread.is_alive()

    def _assert_catalog_mutable(self, *, allow_terminal_cleanup: bool = False) -> None:
        self._assert_request_catalog_expectation()
        if self.project_read_only:
            raise ClientError("完了したプロジェクトは再開するまで編集できません。", "project_read_only")
        worker_cleanup = (
            allow_terminal_cleanup
            and self.job.state in {"complete", "cancelled", "error"}
            and self._has_active_worker()
        )
        if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or (self._has_active_worker() and not worker_cleanup):
            raise ClientError("処理が終了するまで画像一覧を変更できません。", "operation_in_progress")

    def _job_is_current(self, job_generation: int | None, catalog_generation: int | None) -> bool:
        return (
            (job_generation is None or self.job_generation == job_generation)
            and (catalog_generation is None or self.catalog_generation == catalog_generation)
        )

    def set_root(self, raw_path: str, *, expected_project_id: str | None = None,
                 expected_catalog_generation: int | None = None) -> list[dict[str, Any]]:
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
            if not raw_path or not isinstance(raw_path, str):
                return self._set_root(raw_path)
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                return self._set_root(raw_path)
            root = candidate.resolve()
            if not root.is_dir():
                return self._set_root(raw_path)
            with self.lock:
                catalog_id = self.catalog_id
                workspace_id = self.workspace_id
            if catalog_id is None:
                # An unnamed workspace is retained only when its native source
                # is the same folder. A different folder stages a fresh hidden
                # workspace after its scan succeeds.
                if workspace_id is None:
                    return self._set_root(raw_path, inherit_current_catalog=False)
                sources = self.workspace_store.project_sources(workspace_id)
                same_workspace_source = any(
                    source["kind"] == "native-folder" and source.get("nativePath")
                    and native_source_identity(str(source["nativePath"])) == native_source_identity(root)
                    for source in sources
                )
                return self._set_root(raw_path, inherit_current_catalog=same_workspace_source)
            sources = self.workspace_store.project_sources(catalog_id)
            same_project_source = any(
                source["kind"] == "native-folder"
                and source.get("nativePath")
                and native_source_identity(str(source["nativePath"])) == native_source_identity(root)
                for source in sources
            )
            return self._set_root(raw_path, inherit_current_catalog=not sources or same_project_source)

    def _set_root(self, raw_path: str, project_id: str | None = None, *, defer_replace: bool = False,
                   relink_source_id: str | None = None, allow_new: bool = True,
                   inherit_current_catalog: bool = True, staging: bool = False,
                   staged_source_mismatches: dict[str, bool] | None = None,
                   staged_source_id: str | None = None) -> list[Any]:
        if not raw_path or not isinstance(raw_path, str):
            raise ClientError("Windowsフォルダを入力してください。", "input_invalid")
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            raise ClientError("絶対パスのWindowsフォルダを入力してください。", "input_invalid")
        root = candidate.resolve()
        if not root.is_dir():
            raise ClientError("指定フォルダが見つかりません。", "folder_not_found")
        with self.lock:
            if not staging:
                self._assert_catalog_mutable()
            previous_catalog_id = self.catalog_id
            previous_workspace_id = self.workspace_id
            previous_catalog_generation = self.catalog_generation

        catalog_id = project_id or (previous_workspace_id if inherit_current_catalog else None)
        if catalog_id is not None and not self.workspace_store.catalog_exists(catalog_id):
            raise ClientError("プロジェクトが見つかりません。", "project_not_found")
        source_id = None
        stored_metadata: dict[str, tuple[int, int, int, int]] = {}
        if catalog_id is not None:
            if staging:
                if not staged_source_id:
                    raise ValueError("staged project source is missing")
                source_id = staged_source_id
                self.workspace_store.native_source(catalog_id, source_id)
            else:
                source_id = relink_source_id
                if relink_source_id:
                    self.workspace_store.native_source(catalog_id, source_id)
                elif existing_source := next((source for source in self.workspace_store.project_sources(catalog_id)
                                               if source["kind"] == "native-folder"
                                               and source["identity"].casefold() == native_source_identity(root).casefold()), None):
                    source_id = str(existing_source["id"])
            if source_id is not None:
                stored_metadata = self.workspace_store.source_image_metadata(source_id)

        scan_started_at = time.monotonic()
        LOGGER.info("フォルダー走査を開始: パス=%s", root)
        records: list[ImageRecord] = []
        records_lock = threading.Lock()
        skip_counts: dict[str, int] = {}
        skip_examples: dict[str, str] = {}
        scan_failures: list[dict[str, str]] = []
        candidate_count = 0
        candidate_count_lock = threading.Lock()
        worker_count = max(1, int(self.settings["importing"]["parallelism"]))
        path_queue: Queue[Path | None] = Queue(maxsize=worker_count * 2)
        worker_failure = threading.Event()
        worker_errors: list[Exception] = []
        scan_interrupted = False

        def record_skip(reason: str, path: Path) -> None:
            try:
                relative_path = path.resolve().relative_to(root).as_posix()
            except (OSError, ValueError):
                relative_path = path.name
            with records_lock:
                skip_counts[reason] = skip_counts.get(reason, 0) + 1
                skip_examples.setdefault(reason, relative_path)
                scan_failures.append({"relativePath": relative_path, "reason": reason})

        def inspect_path() -> None:
            while True:
                if worker_failure.is_set():
                    return
                try:
                    path = path_queue.get(timeout=0.05)
                except Empty:
                    continue
                if path is None:
                    return
                try:
                    if self.shutdown_requested.is_set():
                        continue
                    resolved = path.resolve()
                    relative_path = resolved.relative_to(root).as_posix()
                    before = resolved.stat()
                    saved = stored_metadata.get(relative_path)
                    if saved is not None and saved[:2] == (before.st_size, before.st_mtime_ns):
                        width, height = saved[2:]
                    else:
                        width, height = inspect_import_image(resolved, resolved.suffix)
                    after = resolved.stat()
                    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                        record_skip("scan_changed", path)
                        continue
                    record = ImageRecord(
                        image_id=uuid.uuid4().hex,
                        path=resolved,
                        relative_path=relative_path,
                        width=width,
                        height=height,
                        mtime_ns=after.st_mtime_ns,
                        size_bytes=after.st_size,
                    )
                except (OSError, UnidentifiedImageError, ValueError, ClientError) as exc:
                    reason = exc.error_code if isinstance(exc, ClientError) else type(exc).__name__
                    record_skip(reason, path)
                    continue
                except Exception as exc:
                    with records_lock:
                        worker_errors.append(exc)
                    worker_failure.set()
                    return
                with records_lock:
                    records.append(record)

        # The producer only holds a bounded queue. Inspection starts while the
        # tree is still being walked, rather than retaining a second full list
        # of paths alongside the finished catalogue records.
        # ``set_root``, relinking, and project opening each enter
        # ``import_lock`` once before calling here. Release and restore that
        # same acquisition around directory I/O; direct internal calls hold
        # none. This keeps the later catalogue transaction serialized without
        # making every other request wait for a large tree walk.
        scan_holds_import_lock = self.import_lock._is_owned()
        if scan_holds_import_lock:
            self.import_lock.release()
        workers: list[threading.Thread] = []

        def start_scan_worker() -> None:
            worker = threading.Thread(target=inspect_path, name=f"MozarieFolderScan-{len(workers)}")
            workers.append(worker)
            worker.start()

        def on_walk_error(exc: OSError) -> None:
            nonlocal scan_interrupted
            # Path.rglob suppresses scan errors on newer Python releases.
            # os.walk exposes them through this callback, so do not silently
            # replace a catalogue with an incomplete prefix.
            scan_interrupted = True
            record_skip("scan_unreadable", Path(exc.filename) if exc.filename else root)

        try:
            for directory, _directories, filenames in os.walk(root, onerror=on_walk_error):
                if self.shutdown_requested.is_set() or scan_interrupted:
                    break
                for filename in filenames:
                    path = Path(directory) / filename
                    try:
                        if path.suffix.lower() not in IMAGE_SUFFIXES:
                            continue
                    except OSError:
                        record_skip("scan_unreadable", path)
                        continue
                    with candidate_count_lock:
                        candidate_count += 1
                    # Do not start idle threads for a tiny folder. The active
                    # pool grows only to the number of discovered images and the
                    # caller's configured parallelism.
                    if len(workers) < worker_count:
                        start_scan_worker()
                    while True:
                        if self.shutdown_requested.is_set() or worker_failure.is_set():
                            break
                        try:
                            path_queue.put(path, timeout=0.05)
                            break
                        except Full:
                            continue
                    if self.shutdown_requested.is_set() or worker_failure.is_set():
                        break
                if self.shutdown_requested.is_set() or worker_failure.is_set():
                    break
        finally:
            for _worker in workers:
                while not worker_failure.is_set():
                    try:
                        path_queue.put(None, timeout=0.05)
                        break
                    except Full:
                        continue
            for worker in workers:
                worker.join()
            if scan_holds_import_lock:
                self.import_lock.acquire()
        if worker_errors:
            raise worker_errors[0]
        if self.shutdown_requested.is_set():
            raise ClientError("アプリを終了するため、フォルダーの読み込みを中止しました。", "operation_cancelled")
        with self.lock:
            if (self.catalog_id != previous_catalog_id or self.workspace_id != previous_workspace_id
                    or self.catalog_generation != previous_catalog_generation):
                raise ClientError("画像一覧が更新されたため、フォルダーの読み込みを中止しました。もう一度追加してください。", "stale_catalog")
            if not staging:
                self._assert_catalog_mutable()
        LOGGER.info("フォルダー候補の列挙を完了: パス=%s 候補=%d件 所要=%.2f秒", root, candidate_count, time.monotonic() - scan_started_at)
        skip_summary = ", ".join(
            f"{reason}={count}件（例: {skip_examples[reason]}）"
            for reason, count in sorted(skip_counts.items())
        ) or "なし"
        LOGGER.info(
            "フォルダー走査を完了: パス=%s 候補=%d件 読込=%d件 スキップ=%s 所要=%.2f秒",
            root, candidate_count, len(records), skip_summary, time.monotonic() - scan_started_at,
        )
        if scan_failures:
            LOGGER.warning(
                "フォルダー走査で読み込めなかった画像: パス=%s\n%s",
                root,
                "\n".join(f"- {failure['relativePath']} ({failure['reason']})" for failure in sorted(scan_failures, key=lambda item: (item["relativePath"].casefold(), item["relativePath"]))),
            )
        if scan_interrupted:
            raise ClientError("指定フォルダーを最後まで読み込めませんでした。", "image_read_failed", {"failures": scan_failures})
        if not candidate_count:
            raise ClientError("指定フォルダーに対応画像がありません。", "image_read_failed")
        if not records:
            raise ClientError("指定フォルダーの対応画像を読み込めませんでした。", "image_read_failed", {"failures": scan_failures})
        # A fresh unnamed folder becomes durable only after every source image
        # has passed the scan above. Failed scans leave the prior workspace and
        # its undo history untouched.
        created_projectless_id: str | None = None
        created_projectless_stored: dict[str, dict[str, Any]] | None = None
        if catalog_id is None:
            created_projectless_id, source_id, created_projectless_stored = self.workspace_store.create_projectless_native_workspace(root, records)
            catalog_id = created_projectless_id
        if source_id is None:
            try:
                source_id = self.workspace_store.ensure_project_source(
                    catalog_id, kind="native-folder", display_name=root.name or str(root), identity=native_source_identity(root),
                )
            except Exception:
                if created_projectless_id is not None:
                    self.workspace_store.delete_project(created_projectless_id)
                raise
        records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path))
        prehydrated: dict[str, tuple[int, list[Candidate]]] | None = None
        relink_previous_source: dict[str, Any] | None = None
        relink_previous_project: dict[str, Any] | None = None
        relink_transform_rollback: list[tuple[str, int, int, int]] = []
        relink_committed = False

        def rollback_native_relink() -> None:
            if not relink_committed or relink_previous_source is None or relink_previous_project is None:
                return
            self.workspace_store.rollback_native_relink(
                catalog_id, source_id, relink_previous_source, relink_previous_project, relink_transform_rollback,
            )

        try:
            if created_projectless_stored is not None:
                stored = created_projectless_stored
            elif staging:
                stored = self.workspace_store.preview_reconcile_images(catalog_id, source_id, records)
            elif relink_source_id:
                relink_previous_source = self.workspace_store.native_source(catalog_id, source_id)
                relink_previous_project = self.workspace_store.project(catalog_id)
                if relink_previous_project is None:
                    raise ValueError("project is missing")
                preview = self.workspace_store.preview_reconcile_images(catalog_id, source_id, records)
                staged_records, _staged_mismatches = self._apply_source_state(records, preview, source_id, root, keep_unstored=allow_new)
                prehydrated = self._stage_workspace_candidates(staged_records)
                stored = self.workspace_store.relink_native_source(
                    catalog_id, source_id, root, records, allow_new=allow_new,
                    transform_rollback=relink_transform_rollback,
                )
                relink_committed = True
            elif catalog_id is not None:
                preview = self.workspace_store.preview_reconcile_images(catalog_id, source_id, records)
                staged_records, _staged_mismatches = self._apply_source_state(records, preview, source_id, root, keep_unstored=allow_new)
                prehydrated = self._stage_workspace_candidates(staged_records)
                stored = (self.workspace_store.reconcile_native_source(catalog_id, source_id, root, records)
                          if allow_new else self.workspace_store.reconcile_images(catalog_id, records, source_id=source_id, allow_new=False))
            else:
                stored = {}
        except ProjectSourcePathConflictError as exc:
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            if relink_source_id:
                raise ClientError("このプロジェクトの別の元フォルダーに同じパスが設定されています。", "project_source_conflict") from exc
            raise
        except ProjectSourceNoMatchError as exc:
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            raise ClientError("指定したフォルダーに、この元フォルダーの画像がありません。", "project_source_no_match") from exc
        except ProjectSourceUnavailableError as exc:
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            raise ClientError("元フォルダーが見つかりません。", "project_source_unavailable") from exc
        except ValueError as exc:
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            if relink_source_id:
                raise ClientError("元フォルダーを読み込めません。", "project_source_unavailable") from exc
            raise
        try:
            records, source_mismatches = self._apply_source_state(records, stored, source_id, root)
        except Exception:
            rollback_native_relink()
            raise
        source_image_ids = {record.image_id for record in records}
        if staged_source_mismatches is not None:
            staged_source_mismatches.update(source_mismatches)
        if inherit_current_catalog and defer_replace:
            # Re-importing one source of a multi-folder project must not dismiss a
            # change acknowledgement still required for another source.
            with self.lock:
                retained_mismatches = {
                    image_id: dimensions_changed
                    for image_id, dimensions_changed in self.source_mismatches.items()
                    if image_id not in source_image_ids
                }
                retained_mismatches.update(source_mismatches)
                self.source_mismatches = retained_mismatches
                if previous_catalog_id is not None:
                    self.catalog_id = catalog_id
                self.workspace_id = catalog_id
        completed = bool(catalog_id and (self.workspace_store.project(catalog_id) or {}).get("status") == "completed")
        if defer_replace:
            return records
        # Adding another folder to an open project is additive.  Replace only
        # this source's live records so same relative names stay independent.
        if catalog_id is not None and previous_workspace_id == catalog_id:
            with self.lock:
                retained = [record for record in self.images.values() if record.source_id != source_id]
            records = retained + records
            records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path, record.image_id))
        try:
            if catalog_id is not None and (
                prehydrated is None or set(prehydrated) != {record.image_id for record in records}
            ):
                prehydrated = self._stage_workspace_candidates(records)
            publish_sources = self.workspace_store.project_sources(catalog_id) if catalog_id is not None else []
        except Exception:
            rollback_native_relink()
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            raise
        with self.lock:
            publish_mismatches = {image_id: dimensions for image_id, dimensions in self.source_mismatches.items()
                                  if image_id not in source_image_ids}
        publish_mismatches.update(source_mismatches)
        try:
            images = self._replace_catalog(root, records, detach_project=not inherit_current_catalog, prehydrated=prehydrated,
                                           publish_workspace_id=catalog_id if previous_catalog_id is None else None,
                                           publish_active_workspace_id=created_projectless_id,
                                           discard_workspace_id=previous_workspace_id if previous_catalog_id is None else None,
                                           publish_source_mismatches=publish_mismatches if catalog_id is not None else None,
                                           publish_sources=publish_sources)
        except Exception:
            rollback_native_relink()
            if created_projectless_id is not None:
                self.workspace_store.delete_project(created_projectless_id)
            raise
        with self.lock:
            self.project_read_only = completed
            self.last_folder_scan_failures = sorted(scan_failures, key=lambda item: (item["relativePath"].casefold(), item["relativePath"]))
        return images

    def relink_project_native_source(self, project_id: str, source_id: str, raw_path: str) -> dict[str, Any]:
        if not isinstance(raw_path, str) or not Path(raw_path).is_absolute() or not Path(raw_path).is_dir():
            raise ClientError("指定フォルダーが見つかりません。", "folder_not_found")
        with self.import_lock:
            with self.lock:
                self._assert_request_catalog_expectation()
                if self.catalog_id != project_id:
                    raise ClientError("開いているプロジェクトの元フォルダーだけ再指定できます。", "project_source_unavailable")
                if self.project_read_only:
                    raise ClientError("完了したプロジェクトの元フォルダーは再指定できません。", "project_read_only")
            try:
                self.workspace_store.native_source(project_id, source_id)
            except ProjectSourceUnavailableError as exc:
                raise ClientError("元フォルダーが見つかりません。", "project_source_unavailable") from exc
            self._set_root(raw_path, project_id, relink_source_id=source_id, allow_new=False)
            return self.catalog_snapshot()

    def projects(self, sort: str = "updated_desc") -> list[dict[str, Any]]:
        return self.workspace_store.projects(sort)

    def projects_for_source_root(self, raw_path: str) -> list[dict[str, Any]]:
        root = Path(raw_path).expanduser()
        if not root.is_absolute() or not root.is_dir():
            raise ClientError("画像フォルダが見つかりません。", "folder_not_found")
        return self.workspace_store.projects_for_source_root(str(root.resolve()), self.workspace_id)

    def create_project(self, name: str | None = None, *, expected_project_id: str | None = None,
                       expected_catalog_generation: int | None = None) -> dict[str, Any]:
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理が終了するまで画像一覧を変更できません。", "operation_in_progress")
            try:
                project = self.workspace_store.create_project(name)
            except ProjectNameAlreadyExistsError as exc:
                raise ClientError("", "project_name_duplicate") from exc
            except ValueError as exc:
                raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
            self._detach_catalog(prune_workspace=False, publish_catalog_id=str(project["id"]), publish_sources=[])
            return project

    def save_current_as_project(self, name: str, project_id: str, *, expected_project_id: str | None = None,
                                expected_catalog_generation: int | None = None) -> dict[str, Any]:
        """Make the current projectless session durable without replacing it."""
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                self._assert_catalog_mutable()
                if self.catalog_id:
                    catalog_id = self.catalog_id
                    try:
                        return self.workspace_store.name_project(catalog_id, name)
                    except ProjectNameAlreadyExistsError as exc:
                        raise ClientError("", "project_name_duplicate") from exc
                    except ValueError as exc:
                        raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
                catalog_id = self.workspace_id
                if not catalog_id:
                    raise ClientError("保存する画像がありません。", "project_not_found")
                try:
                    project = self.workspace_store.name_project(catalog_id, name)
                except ProjectNameAlreadyExistsError as exc:
                    raise ClientError("", "project_name_duplicate") from exc
                except ValueError as exc:
                    raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
                self.catalog_id = catalog_id
                self.catalog_sources = self.workspace_store.project_sources(catalog_id)
                self.projectless_manual_drafts.clear()
                self.catalog_generation += 1
                self._clear_browser_save_tokens_unchecked()
                self._cancel_manual_uploads_unchecked("プロジェクトを保存しました")
            self.cleanup_browser_save_files()
            return project

    def name_current_project(self, name: str, project_id: str = "", *, expected_project_id: str | None = None,
                             expected_catalog_generation: int | None = None) -> dict[str, Any]:
        with self.lock:
            if expected_catalog_generation is not None:
                self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
            catalog_id = self.catalog_id
            if catalog_id:
                try:
                    return self.workspace_store.name_project(catalog_id, name)
                except ProjectNameAlreadyExistsError as exc:
                    raise ClientError("", "project_name_duplicate") from exc
                except ValueError as exc:
                    raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
        return self.save_current_as_project(name, project_id, expected_project_id=expected_project_id,
                                            expected_catalog_generation=expected_catalog_generation)

    def complete_project(self, *, expected_project_id: str | None = None,
                         expected_catalog_generation: int | None = None) -> dict[str, Any]:
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                if not self.catalog_id:
                    raise ClientError("プロジェクトを開いていません。", "project_not_found")
                self._assert_catalog_mutable()
                self._assert_catalog_detachable_unchecked()
                catalog_id = self.catalog_id
                project = self.workspace_store.set_project_status(catalog_id, "completed")
                self.project_read_only = True
            self.detach_catalog()
            return project

    def close_project(self, *, expected_project_id: str | None = None,
                      expected_catalog_generation: int | None = None) -> None:
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
            self.detach_catalog()

    def delete_project(self, catalog_id: str, *, expected_project_id: str | None = None,
                       expected_catalog_generation: int | None = None) -> None:
        """Delete project-only state while leaving every original image untouched."""
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                if self.catalog_id == catalog_id and (self.active_import_count or self._has_active_worker()
                                                      or self.job.state in {"running", "pausing", "paused"}):
                    raise ClientError("処理中のプロジェクトは削除できません。", "operation_in_progress")
                active = self.catalog_id == catalog_id
            if active:
                with self.lock:
                    image_ids_before = tuple(self.images)
                    generation = self.catalog_generation
                locks = [(image_id, self.image_io_lock(image_id)) for image_id in image_ids_before]
                with ExitStack() as stack:
                    for _image_id, image_lock in sorted(locks):
                        stack.enter_context(image_lock)
                    with self.lock:
                        if (self.catalog_id, self.catalog_generation, tuple(self.images)) != (catalog_id, generation, image_ids_before):
                            raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "catalog_changed")
                        try:
                            image_ids = self.workspace_store.delete_project(catalog_id)
                        except ValueError as exc:
                            raise ClientError("プロジェクトが見つかりません。", "project_not_found") from exc
                        _detached_catalog, session = self._detach_catalog_state_unchecked()
                    self._clear_cache()
                    self._release_detached_session(session)
            else:
                try:
                    image_ids = self.workspace_store.delete_project(catalog_id)
                except ValueError as exc:
                    raise ClientError("プロジェクトが見つかりません。", "project_not_found") from exc
            if active:
                self.cleanup_browser_save_files()
            for image_id in image_ids:
                try:
                    shutil.rmtree(self.cache_dir / image_id, ignore_errors=True)
                    for thumbnail_path in (self.cache_dir / "thumbnails").glob(f"{image_id}-*.jpg"):
                        thumbnail_path.unlink(missing_ok=True)
                except OSError:
                    LOGGER.warning("Could not clean deleted-project cache for %s", image_id)

    def resume_project(self, catalog_id: str, *, expected_project_id: str | None = None,
                       expected_catalog_generation: int | None = None) -> dict[str, Any]:
        with self.lock:
            if expected_catalog_generation is not None:
                self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
            project = self.workspace_store.set_project_status(catalog_id, "working")
            if self.catalog_id == catalog_id and self.project_read_only:
                self.project_read_only = False
                self.catalog_generation += 1
                self._clear_browser_save_tokens_unchecked()
                self._cancel_manual_uploads_unchecked("プロジェクトを再開しました")
        self.cleanup_browser_save_files()
        return project

    def open_project(self, catalog_id: str, *, expected_project_id: str | None = None,
                     expected_catalog_generation: int | None = None, resume: bool = False) -> dict[str, Any]:
        with self.import_lock:
            with self.lock:
                if expected_catalog_generation is not None:
                    self._assert_catalog_expectation(expected_project_id, expected_catalog_generation)
                self._assert_catalog_detachable_unchecked()
            return self._open_project(catalog_id, resume=resume)

    def _open_project(self, catalog_id: str, *, resume: bool = False) -> dict[str, Any]:
        project = self.workspace_store.project(catalog_id)
        if not project:
            raise ClientError("プロジェクトが見つかりません。", "project_not_found")
        sources = [
            {**source, "exists": source["kind"] != "native-folder" or bool(source.get("nativePath") and Path(str(source["nativePath"])).is_dir())}
            for source in self.workspace_store.project_sources(catalog_id)
        ]
        native_roots = [Path(str(source["nativePath"])) for source in sources
                        if source["kind"] == "native-folder" and source.get("nativePath") and Path(str(source["nativePath"])).is_dir()]
        if native_roots:
            # Inspect and reconcile every source before replacing the live
            # catalogue. A bad later source must leave the current screen in
            # place instead of exposing a half-open target project.
            records: list[ImageRecord] = []
            staged_source_mismatches: dict[str, bool] = {}
            staged_sources: list[tuple[str, Path, list[ImageRecord]]] = []
            for source in sources:
                native_path = source.get("nativePath")
                if source["kind"] != "native-folder" or not native_path or not Path(str(native_path)).is_dir():
                    continue
                root = Path(str(native_path))
                source_records = self._set_root(
                    str(root), catalog_id, defer_replace=True, allow_new=False, inherit_current_catalog=False, staging=True,
                    staged_source_mismatches=staged_source_mismatches, staged_source_id=str(source["id"]),
                )
                staged_sources.append((str(source["id"]), root, source_records))
                records.extend(source_records)
            records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path, record.image_id))
            prehydrated = self._stage_workspace_candidates(records)
            reconciled_sources, project, rollback = self.workspace_store.reconcile_project_open(catalog_id, staged_sources, resume=resume)
            try:
                records = []
                staged_source_mismatches = {}
                for source_id, root, source_records in staged_sources:
                    accepted, mismatches = self._apply_source_state(source_records, reconciled_sources[source_id], source_id, root)
                    records.extend(accepted)
                    staged_source_mismatches.update(mismatches)
                records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path, record.image_id))
                images = self._replace_catalog(
                    native_roots[0], records, prehydrated=prehydrated,
                    publish_catalog_id=catalog_id, publish_read_only=project["status"] == "completed",
                    publish_source_mismatches=staged_source_mismatches,
                    publish_sources=sources,
                )
            except Exception:
                self.workspace_store.rollback_project_open(catalog_id, rollback)
                raise
            # Browser sources may still need a user-granted handle.  Native
            # images are shown immediately and the UI can add the rest.
            needs_source = any(
                source["kind"] != "native-folder"
                or not source.get("nativePath")
                or not Path(str(source["nativePath"])).is_dir()
                for source in sources
            )
            return {"project": project, "images": images, "needsSource": needs_source, "sources": sources}
        if resume:
            project = self.workspace_store.set_project_status(catalog_id, "working")
        self._detach_catalog(
            prune_workspace=False, publish_catalog_id=catalog_id,
            publish_read_only=project["status"] == "completed", publish_sources=sources,
        )
        return {"project": project, "images": [], "needsSource": bool(sources), "sources": sources}

    def source_mismatch_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return [{"id": image_id, "relativePath": self.images[image_id].relative_path, "dimensionsChanged": dimensions}
                    for image_id, dimensions in self.source_mismatches.items() if image_id in self.images]

    def export_mask_png(self, image_id: str, kind: str) -> bytes:
        """Return original-size grayscale project masks; never touches source files."""
        if kind not in {"mosaic", "exclude"}:
            raise ClientError("マスク種別が正しくありません。", "input_invalid")
        self._assert_image_processable(image_id)
        record = self.image_snapshot(image_id)
        return self._export_workspace_mask(image_id, kind, record.width, record.height)

    def _export_workspace_mask(self, image_id: str, kind: str, width: int, height: int) -> bytes:
        """Render from the durable project state so disconnected sources export too."""
        state = self.workspace_store.export_state(image_id)
        manual = state.get("manual") or {}
        # A size-changed source may deliberately retain its old project
        # masks. Export that stored geometry rather than silently scaling it.
        sample = next((candidate.get("mask") for candidate in state["candidates"] if candidate.get("mask")), None)
        if sample is None: sample = next((manual.get(key) for key in ("add", "exclusion", "erase") if manual.get(key)), None)
        if sample:
            try:
                with open_image(io.BytesIO(base64.b64decode(str(sample), validate=True))) as mask_image:
                    width, height = mask_image.size
            except (OSError, ValueError, binascii.Error) as exc:
                raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
        draft = {
            "add": self._encode_workspace_mask(base64.b64decode(manual["add"])) if manual.get("add") else "",
            "exclusion": self._encode_workspace_mask(base64.b64decode(manual["exclusion"])) if manual.get("exclusion") else "",
            "exclusionErase": self._encode_workspace_mask(base64.b64decode(manual["erase"])) if manual.get("erase") else "",
            "manualEnabled": manual.get("manualEnabled", True), "manualExclusionEnabled": manual.get("exclusionEnabled", True),
            "manualExclusionEraseEnabled": manual.get("eraseEnabled", True), "manualExclusionForced": manual.get("exclusionForced", True),
        }
        try: draft["removedCandidateIds"] = json.loads(manual.get("removed", "[]"))
        except (TypeError, ValueError, json.JSONDecodeError) as exc: raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
        add, manual_exclude, erase = decode_draft_masks(draft, width, height)
        removed = {str(item) for item in draft.get("removedCandidateIds", [])}
        shape = (height, width)
        apply_union: np.ndarray | None = None
        exclude_union: np.ndarray | None = None
        forced_union: np.ndarray | None = None
        for candidate in state["candidates"]:
            if not candidate.get("enabled") or candidate.get("deleted") or candidate.get("id") in removed:
                continue
            try: raw = base64.b64decode(str(candidate["mask"]), validate=True)
            except (KeyError, ValueError, binascii.Error) as exc: raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
            with open_image(io.BytesIO(raw)) as image: mask = expand_mask(mask_alpha_or_luma(image), int(candidate.get("expandPx", 0)))
            if mask.shape != shape:
                raise ValueError("apply mask dimensions do not match the source image" if candidate.get("role") == CandidateRole.APPLY.value else "exclude mask dimensions do not match the source image")
            if candidate.get("role") == CandidateRole.APPLY.value:
                apply_union = union_mask(apply_union, mask)
            else:
                exclude_union = union_mask(exclude_union, mask)
                if candidate.get("forced"):
                    forced_union = union_mask(forced_union, mask)
        if kind == "mosaic":
            value = compose_masks(shape, [apply_union] if apply_union is not None else [], [exclude_union] if exclude_union is not None else [], add if draft.get("manualEnabled") is not False else None, manual_exclude if draft.get("manualExclusionEnabled") is not False else None, [forced_union] if forced_union is not None else [], draft_manual_exclusion_forced(draft, True), erase if draft.get("manualExclusionEraseEnabled") is not False else None)
        else:
            value = exclude_union if exclude_union is not None else np.zeros(shape, dtype=np.uint8)
            if manual_exclude is not None and draft.get("manualExclusionEnabled") is not False: union_mask(value, manual_exclude)
            if erase is not None and draft.get("manualExclusionEraseEnabled") is not False: value[np.asarray(erase) > 0] = 0
        transform = state.get("transform", {})
        if bool(transform.get("flipHorizontal", False)): value = np.fliplr(value)
        if bool(transform.get("flipVertical", False)): value = np.flipud(value)
        output = io.BytesIO(); Image.fromarray(value).save(output, format="PNG"); return output.getvalue()

    def project_mask_images(self) -> list[dict[str, Any]]:
        if not self.catalog_id:
            raise ClientError("プロジェクトを開いていません。", "project_not_found")
        return self.workspace_store.project_images(self.catalog_id)

    def export_project_mask_png(self, image_id: str, kind: str) -> bytes:
        image = self.workspace_store.project_image(image_id)
        if image is None:
            raise ClientError("画像が見つかりません。", "image_not_found")
        if image["hidden"]:
            raise ClientError("非表示の画像は処理できません。再表示してから実行してください。", "image_hidden")
        return self._export_workspace_mask(image_id, kind, int(image["width"]), int(image["height"]))

    def iter_project_mask_exports(self, project_id: str, kind: str):
        """Compose a project ZIP one image at a time from raw workspace BLOBs."""
        if kind not in {"mosaic", "exclude"}:
            raise ClientError("マスク種別が正しくありません。", "input_invalid")
        for state in self.workspace_store.iter_project_export_states(project_id):
            yield state["image"], self._export_workspace_mask_raw(state, kind)

    @staticmethod
    def _raw_workspace_mask(raw: bytes | None, width: int, height: int) -> np.ndarray | None:
        if raw is None:
            return None
        try:
            with open_image(io.BytesIO(raw)) as image:
                if image.format != "PNG" or image.size != (width, height):
                    raise ValueError("workspace mask is invalid")
                if image.mode in {"RGBA", "LA"}:
                    channel = image.getchannel("A")
                elif image.mode in {"L", "1"}:
                    channel = image.convert("L")
                else:
                    raise ValueError("workspace mask has no alpha or grayscale channel")
                return np.asarray(channel.point(lambda value: 255 if value else 0), dtype=np.uint8)
        except (OSError, ValueError) as exc:
            raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc

    def _export_workspace_mask_raw(self, state: dict[str, Any], kind: str) -> bytes:
        image = state["image"]
        width, height = int(image["width"]), int(image["height"])
        manual = state.get("manual") or {}
        sample = next((item.get("mask") for item in state["candidates"] if item.get("mask")), None)
        if sample is None:
            sample = next((manual.get(key) for key in ("add", "exclusion", "erase") if manual.get(key)), None)
        if sample is not None:
            try:
                with open_image(io.BytesIO(sample)) as mask_image:
                    width, height = mask_image.size
            except OSError as exc:
                raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
        try:
            removed = {str(value) for value in json.loads(manual.get("removed", "[]"))}
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
        add = self._raw_workspace_mask(manual.get("add"), width, height)
        manual_exclude = self._raw_workspace_mask(manual.get("exclusion"), width, height)
        erase = self._raw_workspace_mask(manual.get("erase"), width, height)
        shape = (height, width)
        apply_union: np.ndarray | None = None
        exclude_union: np.ndarray | None = None
        forced_union: np.ndarray | None = None
        for candidate in state["candidates"]:
            if not candidate.get("enabled") or candidate["id"] in removed:
                continue
            mask = self._raw_workspace_mask(candidate.get("mask"), width, height)
            if mask is None:
                raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed")
            mask = expand_mask(mask, int(candidate.get("expandPx", 0)))
            if mask.shape != shape:
                raise ValueError("apply mask dimensions do not match the source image" if candidate.get("role") == CandidateRole.APPLY.value else "exclude mask dimensions do not match the source image")
            if candidate.get("role") == CandidateRole.APPLY.value:
                apply_union = union_mask(apply_union, mask)
            else:
                exclude_union = union_mask(exclude_union, mask)
                if candidate.get("forced"):
                    forced_union = union_mask(forced_union, mask)
        if kind == "mosaic":
            value = compose_masks(
                shape, [apply_union] if apply_union is not None else [], [exclude_union] if exclude_union is not None else [],
                add if manual.get("manualEnabled", True) else None,
                manual_exclude if manual.get("exclusionEnabled", True) else None,
                [forced_union] if forced_union is not None else [], bool(manual.get("exclusionForced", True)),
                erase if manual.get("eraseEnabled", True) else None,
            )
        else:
            value = exclude_union if exclude_union is not None else np.zeros(shape, dtype=np.uint8)
            if manual_exclude is not None and manual.get("exclusionEnabled", True):
                union_mask(value, manual_exclude)
            if erase is not None and manual.get("eraseEnabled", True):
                value[np.asarray(erase) > 0] = 0
        if bool(image.get("flipH", False)): value = np.fliplr(value)
        if bool(image.get("flipV", False)): value = np.flipud(value)
        output = io.BytesIO(); Image.fromarray(value).save(output, format="PNG")
        return output.getvalue()

    def resolve_source_mismatches(self, image_ids: list[str], clear_masks: bool) -> None:
        with self.lock:
            self._assert_catalog_mutable()
        requested = set(str(value) for value in image_ids)
        with self.lock:
            known = requested & set(self.source_mismatches) & set(self.images)
        locks = [(image_id, self.image_io_lock(image_id)) for image_id in known]
        with ExitStack() as stack:
            for _image_id, image_lock in sorted(locks):
                stack.enter_context(image_lock)
            resized: set[str] = set()
            with self.lock:
                self._assert_catalog_mutable()
                known = requested & set(self.source_mismatches) & set(self.images)
                records = [self.images[image_id] for image_id in known]
                revisions = ({image_id: self._candidate_revision(image_id) + 1 for image_id in known}
                             if clear_masks else None)
                # The comparison baseline changes only after the user confirms.
                # This one durable operation either commits both the source
                # metadata and an optional mask clear, or leaves both intact.
                resized = self.workspace_store.acknowledge_source_mismatches(records, revisions)
                if clear_masks:
                    for image_id, revision in (revisions or {}).items():
                        self.candidates[image_id] = []
                        self.candidate_revisions[image_id] = revision
                for image_id in known:
                    self.source_mismatches.pop(image_id, None)
        if clear_masks:
            self._delete_mask_files([], [self.cache_dir / image_id for image_id in known])
        elif resized:
            self._delete_mask_files([], [self.cache_dir / image_id for image_id in resized])
            with self.lock:
                self._restore_workspace_candidates([self.images[image_id] for image_id in resized if image_id in self.images])

    def _assert_catalog_detachable_unchecked(self) -> None:
        if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
            raise ClientError("処理が終了するまで画像一覧を変更できません。", "operation_in_progress")

    def _detach_catalog_state_unchecked(self) -> tuple[str | None, tuple[Path | None, Any | None]]:
        catalog_id = self.catalog_id
        self.images = {}
        self.order = []
        self.candidates = {}
        self.candidate_revisions = {}
        self.projectless_manual_drafts.clear()
        self._clear_browser_save_tokens_unchecked()
        self._invalidate_sam_cache()
        self.catalog_id = None
        self.workspace_id = None
        self.project_read_only = False
        self.source_mismatches = {}
        self.root = None
        self.source_roots = {}
        self.catalog_sources = []
        self.catalog_generation += 1
        self._cancel_manual_uploads_unchecked("画像一覧を閉じました")
        session = self._detach_session_unchecked()
        self._image_io_locks.clear()
        return catalog_id, session

    def _detach_catalog(
        self, *, prune_workspace: bool, publish_catalog_id: str | None = None,
        publish_read_only: bool = False, publish_sources: list[dict[str, Any]] | None = None,
    ) -> str | None:
        with self.import_lock:
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_detachable_unchecked()
                catalog_id = self.catalog_id
                workspace_id = self.workspace_id
                catalog_generation = self.catalog_generation
                image_ids = tuple(self.images)
            locks = [(image_id, self.image_io_lock(image_id)) for image_id in image_ids]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_detachable_unchecked()
                    if (self.catalog_id, self.workspace_id, self.catalog_generation, tuple(self.images)) != (catalog_id, workspace_id, catalog_generation, image_ids):
                        raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "catalog_changed")
                    if prune_workspace and workspace_id:
                        self.workspace_store.delete_catalog_images(workspace_id)
                    # An unnamed workspace has no user-visible project entry.
                    # Closing or replacing it must remove both its hidden
                    # catalog and the active-workspace pointer before the live
                    # state is detached, otherwise it reappears after restart.
                    if catalog_id is None and workspace_id:
                        self.workspace_store.delete_project(workspace_id)
                    catalog_id, session = self._detach_catalog_state_unchecked()
                    if publish_catalog_id is not None:
                        self.catalog_id = publish_catalog_id
                        self.workspace_id = publish_catalog_id
                        self.project_read_only = publish_read_only
                        self.catalog_sources = [dict(source) for source in publish_sources or []]
                self._clear_cache()
                self._release_detached_session(session)
        self.cleanup_browser_save_files()
        return catalog_id

    def detach_catalog(self) -> str | None:
        """Clear only the live screen state while retaining durable work."""
        return self._detach_catalog(prune_workspace=False)

    def clear_catalog(self) -> int:
        """Explicit user clear: commit durable removal before detaching the view."""
        with self.import_lock:
            self._detach_catalog(prune_workspace=True)
            with self.lock:
                return self.catalog_generation

    def remove_image_from_catalog(self, image_id: str) -> dict[str, Any]:
        """Remove one image's working state without deleting its source file."""
        return self.remove_images_from_catalog([image_id])

    def prepare_source_delete(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Check the catalogue and native file fingerprints before deletion."""
        if not isinstance(payload, dict) or not isinstance(payload.get("imageIds"), list):
            raise ClientError("削除する画像が正しくありません。", "input_invalid")
        delete_token = payload.get("deleteToken")
        try:
            token_is_valid = isinstance(delete_token, str) and str(uuid.UUID(delete_token)) == delete_token
        except (TypeError, ValueError, AttributeError):
            token_is_valid = False
        if not token_is_valid:
            raise ClientError("削除操作の識別子が正しくありません。", "input_invalid")
        requested_ids = list(dict.fromkeys(str(image_id) for image_id in payload["imageIds"] if str(image_id)))
        if not requested_ids:
            raise ClientError("削除する画像がありません。", "image_not_found")
        with self.import_lock:
            with self.lock:
                operation = self.workspace_store.source_delete_operation(delete_token)
                if operation is not None:
                    result = operation.get("result") or {}
                    return {"committed": operation.get("state") in {"committed", "cancelled"}, "deleteToken": delete_token,
                            "preparedImageIds": [item["imageId"] for item in operation.get("items", [])],
                            "failed": result.get("failed", []), "state": operation.get("state")}
                self._assert_catalog_mutable(allow_terminal_cleanup=True)
                catalog_id, workspace_id, generation = self.catalog_id, self.workspace_id, self.catalog_generation
                records = {image_id: self.images.get(image_id) for image_id in requested_ids}
            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records.values() if record is not None]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks): stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_mutable(allow_terminal_cleanup=True)
                    if (self.catalog_id, self.workspace_id, self.catalog_generation) != (catalog_id, workspace_id, generation):
                        raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "stale_catalog")
                    if any(self.images.get(image_id) is not record for image_id, record in records.items()):
                        raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "stale_catalog")
                    prepared: list[str] = []; failures: list[dict[str, str]] = []; items: list[dict[str, Any]] = []
                    for image_id, record in records.items():
                        if record is None:
                            failures.append({"imageId": image_id, "reason": "image_not_found"}); continue
                        identity = None
                        if record.source_kind == "filesystem":
                            try: stat = record.path.stat()
                            except OSError:
                                failures.append({"imageId": image_id, "reason": "source_unavailable"}); continue
                            if (stat.st_mtime_ns, stat.st_size) != (record.mtime_ns, record.size_bytes):
                                failures.append({"imageId": image_id, "reason": "source_changed"}); continue
                            identity = SaveJournal.file_identity(record.path, stat)
                            if identity is None:
                                failures.append({"imageId": image_id, "reason": "source_unavailable"}); continue
                        prepared.append(image_id)
                        item = {"imageId": image_id, "sourceKind": record.source_kind,
                                "relativePath": record.relative_path, "sourcePath": str(record.path),
                                "mtimeNs": record.mtime_ns, "sizeBytes": record.size_bytes}
                        if identity is not None: item["fileIdentity"] = identity
                        items.append(item)
                    try:
                        self.workspace_store.prepare_source_delete(delete_token, catalog_id, workspace_id, generation, requested_ids, items, failures)
                    except ValueError as exc:
                        raise ClientError("削除操作が別の画面で開始されています。", "source_delete_not_prepared") from exc
        result = {"committed": False, "deleteToken": delete_token, "preparedImageIds": prepared, "failed": failures, "state": "prepared"}
        failure_text = ", ".join(f"{failure['imageId']}:{failure['reason']}" for failure in failures)
        LOGGER.info("元画像を完全削除: 確認完了 対象=%d 準備=%d 失敗=%d%s", len(requested_ids), len(prepared), len(failures), f" 詳細={failure_text}" if failure_text else "")
        return result

    def delete_images_with_sources(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Permanently remove source files and their Mozarie state.

        Native sources are first moved beside themselves.  The durable workspace
        deletion is then committed, and only then is the renamed source
        unlinked.  A database failure therefore leaves the original pathname
        usable.  Browser sources have already been removed through their
        directory handle by the caller; the acknowledgement is intentionally
        checked before their server-side copy is discarded.
        """
        if not isinstance(payload, dict) or not isinstance(payload.get("imageIds"), list):
            raise ClientError("削除する画像が正しくありません。", "input_invalid")
        delete_token = payload.get("deleteToken")
        try:
            token_is_valid = isinstance(delete_token, str) and str(uuid.UUID(delete_token)) == delete_token
        except (TypeError, ValueError, AttributeError):
            token_is_valid = False
        if not token_is_valid:
            raise ClientError("削除操作の識別子が正しくありません。", "input_invalid")
        requested_ids = list(dict.fromkeys(str(image_id) for image_id in payload["imageIds"] if str(image_id)))
        if not requested_ids:
            raise ClientError("削除する画像がありません。", "image_not_found")
        browser_deleted = {str(image_id) for image_id in payload.get("browserDeletedImageIds", [])}
        started_at = time.monotonic()
        LOGGER.info("元画像を完全削除: 開始 対象=%d", len(requested_ids))

        with self.import_lock:
            with self.lock:
                receipt = self.source_delete_receipts.get(delete_token)
                if receipt is not None:
                    return dict(receipt)
                operation = self.workspace_store.source_delete_operation(delete_token)
                if operation is None:
                    raise ClientError("削除確認の有効期限が切れました。もう一度削除を実行してください。", "source_delete_not_prepared")
                if operation.get("state") not in {"claimed", "renaming"}:
                    return dict(operation.get("result") or {})
                self._assert_catalog_mutable(allow_terminal_cleanup=True)
                if (operation.get("catalogId"), operation.get("workspaceId")) != (self.catalog_id, self.workspace_id):
                    raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "stale_catalog")
                prepared_ids = {str(item["imageId"]) for item in operation.get("items", [])}
                records = {image_id: self.images.get(image_id) for image_id in requested_ids if image_id in prepared_ids}

            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records.values() if record is not None]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    if any(self.images.get(image_id) is not record for image_id, record in records.items()):
                        raise ClientError("画像一覧が変更されたため、操作をやり直してください。", "stale_catalog")
                    if operation.get("catalogGeneration") != self.catalog_generation:
                        # A resumed request is safe only after every listed
                        # live record has been rechecked below. Missing native
                        # records are never treated as a successful delete.
                        LOGGER.info("元画像削除を再検証して再開: 保存時世代=%s 現在世代=%s", operation.get("catalogGeneration"), self.catalog_generation)
                return self._commit_prepared_source_delete(delete_token, requested_ids, browser_deleted, records, started_at)

    @staticmethod
    def _valid_source_delete_quarantine(plan: dict[str, Any]) -> tuple[Path | None, Path | None, str | None]:
        """Accept only the exact private rename we recorded for this source."""
        source = Path(str(plan.get("sourcePath", ""))); quarantine = Path(str(plan.get("quarantinePath", "")))
        if not source.name or source.parent != quarantine.parent:
            return source, quarantine, "quarantine_path_invalid"
        if re.fullmatch(rf"\.{re.escape(source.name)}\.mozarie-delete-[0-9a-f]{{32}}", quarantine.name) is None:
            return source, quarantine, "quarantine_name_invalid"
        try: stat = quarantine.stat()
        except FileNotFoundError: return source, quarantine, "quarantine_missing"
        except OSError as exc: return source, quarantine, f"quarantine_unavailable:{type(exc).__name__}"
        try: fingerprint = (int(plan.get("mtimeNs", -1)), int(plan.get("sizeBytes", -1)))
        except (TypeError, ValueError): return source, quarantine, "quarantine_fingerprint_invalid"
        identity = plan.get("fileIdentity")
        if not isinstance(identity, str) or not identity:
            return source, quarantine, "quarantine_identity_invalid"
        if (stat.st_mtime_ns, stat.st_size) != fingerprint or SaveJournal.file_identity(quarantine, stat) != identity:
            return source, quarantine, "quarantine_changed"
        return source, quarantine, None

    @staticmethod
    def _source_delete_plan_matches_item(plan: dict[str, Any], items: list[dict[str, Any]]) -> bool:
        try:
            plan_mtime, plan_size = int(plan.get("mtimeNs", -2)), int(plan.get("sizeBytes", -2))
        except (TypeError, ValueError):
            return False
        for item in items:
            try:
                if (str(item.get("imageId", "")) == str(plan.get("imageId", ""))
                        and str(item.get("sourceKind", "")) == "filesystem"
                        and str(item.get("sourcePath", "")) == str(plan.get("sourcePath", ""))
                        and int(item.get("mtimeNs", -1)) == plan_mtime and int(item.get("sizeBytes", -1)) == plan_size
                        and str(item.get("fileIdentity", "")) == str(plan.get("fileIdentity", ""))):
                    return True
            except (TypeError, ValueError):
                continue
        return False

    def _commit_prepared_source_delete(self, delete_token: str, requested_ids: list[str], browser_deleted: set[str],
                                        records: dict[str, ImageRecord | None], started_at: float) -> dict[str, Any]:
        removable: list[ImageRecord] = []
        durable_only_ids: list[str] = []
        operation = self.workspace_store.source_delete_operation(delete_token) or {}
        failures: list[dict[str, str]] = [dict(failure) for failure in (operation.get("result") or {}).get("prepareFailures", []) if isinstance(failure, dict)]
        items = {str(item["imageId"]): item for item in operation.get("items", [])}
        for image_id in requested_ids:
            record = records.get(image_id)
            item = items.get(image_id)
            if item is None:
                failures.append({"imageId": image_id, "reason": "source_delete_not_prepared"}); continue
            if record is None:
                if item.get("sourceKind") == "session" and image_id in browser_deleted:
                    durable_only_ids.append(image_id); continue
                failures.append({"imageId": image_id, "reason": "image_not_found"}); continue
            if (record.source_kind != item.get("sourceKind") or str(record.path) != str(item.get("sourcePath"))
                    or record.mtime_ns != int(item.get("mtimeNs", -1)) or record.size_bytes != int(item.get("sizeBytes", -1))):
                failures.append({"imageId": image_id, "reason": "source_changed"}); continue
            if record.source_kind == "filesystem":
                try: stat = record.path.stat()
                except OSError:
                    failures.append({"imageId": image_id, "reason": "source_unavailable"}); continue
                if ((stat.st_mtime_ns, stat.st_size) != (int(item["mtimeNs"]), int(item["sizeBytes"]))
                        or SaveJournal.file_identity(record.path, stat) != item.get("fileIdentity")):
                    failures.append({"imageId": image_id, "reason": "source_changed"}); continue
            elif image_id not in browser_deleted:
                failures.append({"imageId": image_id, "reason": "browser_source_not_deleted"}); continue
            removable.append(record)
        renamed: list[tuple[ImageRecord, Path]] = []; confirmed: list[ImageRecord] = []
        native_records = [record for record in removable if record.source_kind == "filesystem"]
        plans = [{"imageId": record.image_id, "relativePath": record.relative_path, "sourcePath": str(record.path),
                  "mtimeNs": record.mtime_ns, "sizeBytes": record.size_bytes,
                  "fileIdentity": str(items[record.image_id].get("fileIdentity", "")),
                  "quarantinePath": str(record.path.with_name(f".{record.path.name}.mozarie-delete-{uuid.uuid4().hex}"))}
                 for record in native_records]
        plan_by_image = {str(plan["imageId"]): plan for plan in plans}
        if plans:
            renaming = {"plannedQuarantines": plans, "renamedImageIds": [], "failed": failures,
                        "prepareFailures": (operation.get("result") or {}).get("prepareFailures", [])}
            self.workspace_store.update_source_delete_operation(delete_token, "renaming", renaming, expected_states={"claimed"})
        plan_paths = {str(plan["imageId"]): Path(str(plan["quarantinePath"])) for plan in plans}
        for record in removable:
            if record.source_kind != "filesystem": confirmed.append(record); continue
            quarantine = plan_paths[record.image_id]
            if not SaveJournal.rename_windows_verified(record.path, quarantine, str(plan_by_image[record.image_id]["fileIdentity"]), (int(plan_by_image[record.image_id]["mtimeNs"]), int(plan_by_image[record.image_id]["sizeBytes"]))):
                failures.append({"imageId": record.image_id, "reason": "source_delete_failed"}); continue
            renamed.append((record, quarantine)); confirmed.append(record)
            progress = {"plannedQuarantines": plans, "renamedImageIds": [current.image_id for current, _path in renamed], "failed": failures,
                        "prepareFailures": (operation.get("result") or {}).get("prepareFailures", [])}
            self.workspace_store.update_source_delete_operation(delete_token, "renaming", progress, expected_states={"renaming"})
        # A direct retry may include an ID already rejected by prepare. Keep
        # the original prepare reason and return one result per image.
        unique_failures: dict[str, dict[str, str]] = {}
        for failure in failures:
            image_id = str(failure.get("imageId", ""))
            if image_id not in unique_failures:
                unique_failures[image_id] = failure
        failures = list(unique_failures.values())
        if confirmed or durable_only_ids:
            try:
                durable_result = {"removedImageIds": [record.image_id for record in confirmed] + durable_only_ids, "failed": failures,
                                  "state": "workspace_committed", "quarantinePaths": [str(path) for _record, path in renamed],
                                  "quarantinePlans": [plan_by_image[record.image_id] for record, _path in renamed],
                                  "quarantineRelativePaths": {str(path): record.relative_path for record, path in renamed}}
                removed = self.remove_images_from_catalog([record.image_id for record in confirmed], source_delete_token=delete_token,
                                                          source_delete_result=durable_result, source_delete_extra_ids=durable_only_ids)
            except Exception:
                committed_operation = self.workspace_store.source_delete_operation(delete_token)
                if committed_operation is not None and committed_operation.get("state") in {"workspace_committed", "cleanup_pending", "committed"}:
                    # SQLite is already authoritative. Never put the source
                    # back because a disposable cache cleanup failed after it.
                    LOGGER.exception("元画像削除後の画面キャッシュ整理に失敗: token=%s", delete_token)
                    with self.lock:
                        removed = {"images": self.list_images(), "removedImageIds": durable_result["removedImageIds"],
                                   "catalogGeneration": self.catalog_generation}
                else:
                    restore_conflicts: list[dict[str, str]] = []
                    for record, _quarantine in reversed(renamed):
                        source, quarantine, reason = self._valid_source_delete_quarantine(plan_by_image[record.image_id])
                        if reason is not None or source is None or quarantine is None:
                            restore_conflicts.append({"imageId": record.image_id, "relativePath": record.relative_path,
                                                      "reason": reason or "quarantine_path_invalid"}); continue
                        if source.exists():
                            restore_conflicts.append({"imageId": record.image_id, "relativePath": record.relative_path,
                                                      "reason": "source_restore_conflict"}); continue
                        if not SaveJournal.rename_windows_verified(quarantine, source, str(plan_by_image[record.image_id]["fileIdentity"]), (int(plan_by_image[record.image_id]["mtimeNs"]), int(plan_by_image[record.image_id]["sizeBytes"]))):
                            restore_conflicts.append({"imageId": record.image_id, "relativePath": record.relative_path,
                                                      "reason": "source_restore_failed"})
                            LOGGER.warning("元画像の削除復元に失敗: 対象=%s", record.relative_path)
                    if restore_conflicts:
                        collision = {"removedImageIds": [], "failed": restore_conflicts, "state": "restore_conflict",
                                     "recoveryConflicts": restore_conflicts, "plannedQuarantines": plans, "quarantinePaths": [], "cleanupPendingCount": len(restore_conflicts)}
                        self.workspace_store.update_source_delete_operation(delete_token, "restore_conflict", collision, expected_states={"renaming"})
                        LOGGER.warning("元画像削除の復元を保留: 衝突=%d", len(restore_conflicts))
                    elif plans:
                        prepared_result = {"failed": (operation.get("result") or {}).get("prepareFailures", []),
                                           "prepareFailures": (operation.get("result") or {}).get("prepareFailures", [])}
                        self.workspace_store.update_source_delete_operation(delete_token, "prepared", prepared_result, expected_states={"renaming"})
                    raise
        else:
            removed = {"images": self.list_images(), "removedImageIds": [], "catalogGeneration": self.catalog_generation}
        removed_ids = set(removed["removedImageIds"]); cleanup_paths: list[str] = []
        cleanup_conflicts: list[dict[str, str]] = []
        for record, quarantine in renamed:
            if record.image_id not in removed_ids: continue
            _source, verified_quarantine, reason = self._valid_source_delete_quarantine(plan_by_image[record.image_id])
            if reason is not None or verified_quarantine is None:
                cleanup_paths.append(str(quarantine))
                cleanup_conflicts.append({"imageId": record.image_id, "relativePath": record.relative_path,
                                          "reason": reason or "quarantine_path_invalid"})
                LOGGER.warning("元画像削除の後処理を保留: 対象=%s 理由=%s", record.relative_path, reason)
                continue
            if not SaveJournal.delete_windows_verified(quarantine, str(plan_by_image[record.image_id]["fileIdentity"])):
                LOGGER.warning("元画像削除の後処理を保留: 対象=%s", record.relative_path)
                cleanup_paths.append(str(quarantine))
        result = {**removed, "failed": failures, "prepareFailures": (operation.get("result") or {}).get("prepareFailures", []),
                  "state": "cleanup_pending" if cleanup_paths else "committed",
                  "quarantinePaths": cleanup_paths,
                  "quarantinePlans": [plan for plan in plans if str(plan["quarantinePath"]) in cleanup_paths],
                  "quarantineRelativePaths": {str(path): record.relative_path for record, path in renamed if str(path) in cleanup_paths},
                  "recoveryConflicts": cleanup_conflicts, "cleanupPendingCount": len(cleanup_paths)}
        names = {image_id: record.relative_path for image_id, record in records.items() if record is not None}
        names.update({str(item["imageId"]): str(item.get("relativePath", item["imageId"])) for item in operation.get("items", [])})
        for failure in result["failed"]:
            if failure.get("imageId") in names: failure["relativePath"] = names[failure["imageId"]]
        with self.lock: self.source_delete_receipts[delete_token] = dict(result)
        self.workspace_store.update_source_delete_operation(delete_token, result["state"], {key: value for key, value in result.items() if key != "images"}, expected_states={"workspace_committed", "renaming", "claimed"})
        failure_text = ", ".join(f"{failure.get('relativePath', failure['imageId'])}:{failure['reason']}" for failure in failures)
        LOGGER.info("元画像を完全削除: 完了 対象=%d 成功=%d 失敗=%d 所要=%.2fs%s", len(operation.get("requestedImageIds", requested_ids)), len(removed["removedImageIds"]), len(failures), time.monotonic() - started_at, f" 詳細={failure_text}" if failure_text else "")
        return result

    def source_delete_status(self, token: str) -> dict[str, Any]:
        try:
            valid = str(uuid.UUID(token)) == token
        except (TypeError, ValueError, AttributeError):
            valid = False
        if not valid:
            raise ClientError("削除操作の識別子が正しくありません。", "input_invalid")
        operation = self.workspace_store.source_delete_operation(token)
        if operation is None:
            raise ClientError("削除操作が見つかりません。", "source_delete_not_prepared")
        result = operation.get("result") or {}
        return {"deleteToken": token, "state": operation.get("state"), "preparedImageIds": [item["imageId"] for item in operation.get("items", [])],
                "preparedSourceKinds": {str(item["imageId"]): str(item.get("sourceKind", "")) for item in operation.get("items", [])}, **result}

    def claim_source_delete(self, token: str) -> dict[str, Any]:
        with self.import_lock:
            operation = self.source_delete_status(token)
            if operation["state"] != "prepared":
                raise ClientError("削除操作が別の画面で開始されています。", "source_delete_not_prepared")
            claimed = self.workspace_store.claim_source_delete(token)
            return {"deleteToken": token, "state": claimed["state"]}

    def release_source_delete_claim(self, token: str) -> dict[str, Any]:
        with self.import_lock:
            operation = self.source_delete_status(token)
            if operation["state"] != "claimed":
                return operation
            released = self.workspace_store.release_source_delete_claim(token)
            return {"deleteToken": token, "state": released["state"]}

    def cancel_source_delete(self, token: str) -> dict[str, Any]:
        with self.import_lock:
            operation = self.source_delete_status(token)
            image_ids = [str(item["imageId"]) for item in (self.workspace_store.source_delete_operation(token) or {}).get("items", [])]
            with self.lock:
                records = [self.images[image_id] for image_id in image_ids if image_id in self.images]
            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks): stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_mutable(allow_terminal_cleanup=True)
                    operation = self.source_delete_status(token)
                    if operation["state"] != "prepared": return operation
                    result = {"removedImageIds": [], "failed": [], "state": "cancelled"}
                    self.workspace_store.update_source_delete_operation(token, "cancelled", result, expected_states={"prepared"})
                    return {"deleteToken": token, **result}

    def acknowledge_source_delete(self, token: str) -> dict[str, Any]:
        operation = self.source_delete_status(token)
        if operation["state"] not in {"committed", "cancelled"}:
            raise ClientError("削除の後処理が完了するまで確認できません。", "source_delete_cleanup_pending")
        self.workspace_store.acknowledge_source_delete(token)
        with self.lock:
            self.source_delete_receipts.pop(token, None)
        return {"acknowledged": True, "deleteToken": token}

    def retry_source_delete_cleanups(self) -> None:
        """Finish source unlinks left after a committed workspace deletion."""
        for token, plans in self.workspace_store.pending_source_delete_renames():
            operation = self.workspace_store.source_delete_operation(token) or {}
            conflicts: list[dict[str, str]] = []
            for plan in plans:
                source, quarantine, reason = self._valid_source_delete_quarantine(plan)
                relative_path = str(plan.get("relativePath", plan.get("imageId", "")))
                if not self._source_delete_plan_matches_item(plan, operation.get("items", [])):
                    conflicts.append({"imageId": str(plan.get("imageId", "")), "relativePath": relative_path,
                                      "reason": "quarantine_item_mismatch"}); continue
                if reason == "quarantine_missing" and source is not None and source.exists():
                    continue
                if reason is not None or source is None or quarantine is None:
                    conflicts.append({"imageId": str(plan.get("imageId", "")), "relativePath": relative_path,
                                      "reason": reason or "quarantine_path_invalid"}); continue
                if source.exists():
                    conflicts.append({"imageId": str(plan.get("imageId", "")), "relativePath": relative_path,
                                      "reason": "source_restore_conflict"}); continue
                if not SaveJournal.rename_windows_verified(quarantine, source, str(plan.get("fileIdentity", "")), (int(plan.get("mtimeNs", -1)), int(plan.get("sizeBytes", -1)))):
                    conflicts.append({"imageId": str(plan.get("imageId", "")), "relativePath": relative_path,
                                      "reason": "source_restore_failed"})
                    LOGGER.warning("元画像削除の名前変更を復元できません: 対象=%s", relative_path)
            if conflicts:
                result = {"removedImageIds": [], "failed": conflicts, "state": "restore_conflict", "recoveryConflicts": conflicts,
                          "plannedQuarantines": plans, "quarantinePaths": [], "cleanupPendingCount": len(conflicts)}
                self.workspace_store.update_source_delete_operation(token, "restore_conflict", result, expected_states={"renaming", "restore_conflict"})
                LOGGER.warning("元画像削除の名前変更を保留: 衝突=%d", len(conflicts))
            else:
                prepared_result = {"failed": (operation.get("result") or {}).get("prepareFailures", []),
                                   "prepareFailures": (operation.get("result") or {}).get("prepareFailures", [])}
                self.workspace_store.update_source_delete_operation(token, "prepared", prepared_result, expected_states={"renaming", "restore_conflict"})
                LOGGER.info("元画像削除の名前変更を復元: token=%s", token)
        for token, raw_paths in self.workspace_store.pending_source_delete_cleanups():
            remaining: list[str] = []
            operation = self.workspace_store.source_delete_operation(token)
            durable_result = dict((operation or {}).get("result") or {})
            plans = {str(plan.get("quarantinePath", "")): plan for plan in durable_result.get("quarantinePlans", []) if isinstance(plan, dict)}
            names = dict(durable_result.get("quarantineRelativePaths", {}))
            conflicts: list[dict[str, str]] = []
            for raw_path in raw_paths:
                plan = plans.get(raw_path)
                _source, quarantine, reason = self._valid_source_delete_quarantine(plan or {})
                if (reason == "quarantine_missing" and operation is not None
                        and operation.get("state") in {"workspace_committed", "cleanup_pending"}
                        and self._source_delete_plan_matches_item(plan or {}, operation.get("items", []))):
                    # The database has already committed the workspace delete;
                    # a missing verified quarantine means unlink completed just
                    # before the receipt update was interrupted.
                    continue
                if (reason is not None or quarantine is None or str(quarantine) != raw_path
                        or not self._source_delete_plan_matches_item(plan or {}, (operation or {}).get("items", []))):
                    remaining.append(raw_path)
                    conflict_reason = reason or "quarantine_item_mismatch"
                    conflicts.append({"relativePath": names.get(raw_path, Path(raw_path).name), "reason": conflict_reason})
                    LOGGER.warning("元画像削除の後処理を再試行しません: 対象=%s 理由=%s", names.get(raw_path, Path(raw_path).name), conflict_reason)
                    continue
                if not SaveJournal.delete_windows_verified(quarantine, str(plan.get("fileIdentity", ""))):
                    remaining.append(raw_path)
                    LOGGER.warning("元画像削除の後処理を再試行できません: 対象=%s", names.get(raw_path, Path(raw_path).name))
            if operation is None:
                continue
            result = dict(operation.get("result") or {})
            result["quarantinePaths"] = remaining
            result["recoveryConflicts"] = conflicts
            result["state"] = "cleanup_pending" if remaining else "committed"
            self.workspace_store.update_source_delete_operation(token, result["state"], result, expected_states={"cleanup_pending", "workspace_committed"})
            if remaining:
                LOGGER.warning("元画像削除の後処理を保留: 対象=%d 成功=%d 失敗=%d", len(raw_paths), len(raw_paths) - len(remaining), len(remaining))
            else:
                LOGGER.info("元画像削除の後処理を完了: 対象=%d", len(raw_paths))

    def remove_images_from_catalog(self, image_ids: list[str], *, source_delete_token: str | None = None,
                                   source_delete_result: dict[str, Any] | None = None,
                                   source_delete_extra_ids: list[str] | None = None) -> dict[str, Any]:
        """Remove saved images from the working catalog without deleting source files."""
        if not isinstance(image_ids, list):
            raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
        requested_ids = list(dict.fromkeys(str(image_id) for image_id in image_ids if str(image_id)))
        requested_extra_ids = list(dict.fromkeys(str(image_id) for image_id in (source_delete_extra_ids or []) if str(image_id)))
        if not requested_ids and not requested_extra_ids:
            raise ClientError("削除する画像がありません。", "image_not_found")
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable(allow_terminal_cleanup=True)
                records = [self.images[image_id] for image_id in requested_ids if image_id in self.images]
                extra_ids = [image_id for image_id in requested_extra_ids if image_id not in self.images]
            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_mutable(allow_terminal_cleanup=True)
                    records = [self.images[record.image_id] for record in records if record.image_id in self.images]
                    removed_ids = [record.image_id for record in records] + extra_ids
                    mask_paths = [candidate.mask_path for record in records for candidate in self.candidates.get(record.image_id, [])]
                    session_paths = [record.path for record in records if record.source_kind == "session"]
                    session_imports_dir = self.session_imports_dir
                    # The durable delete is the transaction boundary. Do it
                    # before publishing the in-memory removal so a database
                    # failure leaves both views intact.
                    if source_delete_token is None:
                        self.workspace_store.delete_images(removed_ids)
                    else:
                        self.workspace_store.commit_source_delete(source_delete_token, removed_ids, source_delete_result or {})
                    for record in records:
                        self.images.pop(record.image_id, None)
                        self.candidates.pop(record.image_id, None)
                        self.candidate_revisions.pop(record.image_id, None)
                        self.projectless_manual_drafts.pop(record.image_id, None)
                        self._image_io_locks.pop(record.image_id, None)
                    if removed_ids:
                        removed_set = set(removed_ids)
                        self.order = [current_id for current_id in self.order if current_id not in removed_set]
                        self.catalog_generation += 1
                    if not self.order and self.catalog_id is None and self.workspace_id:
                        self.workspace_store.delete_project(self.workspace_id)
                        self.workspace_id = None
                        self.catalog_sources = []
                    self._clear_browser_save_tokens_unchecked()
                    self._cancel_manual_uploads_unchecked("画像を削除しました")
                snapshot = self.catalog_snapshot()
                self._delete_mask_files(mask_paths, [self.cache_dir / record.image_id for record in records])
                thumbnail_dir = self.cache_dir / "thumbnails"
                removed_set = set(removed_ids)
                thumbnail_paths = [path for path in thumbnail_dir.glob("*.jpg") if path.stem.rsplit("-", 3)[0] in removed_set]
                for record in records:
                    shutil.rmtree(self.cache_dir / record.image_id, ignore_errors=True)
                for thumbnail_path in thumbnail_paths:
                    try:
                        thumbnail_path.unlink(missing_ok=True)
                    except OSError as exc:
                        LOGGER.warning("Could not remove stale thumbnail %s: %s", thumbnail_path, exc)
                for path in session_paths:
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as exc:
                        LOGGER.warning("Could not remove stale import copy %s: %s", path, exc)
                        continue
                    if session_imports_dir is not None:
                        parent = path.parent
                        while parent != session_imports_dir and parent.is_relative_to(session_imports_dir):
                            try:
                                parent.rmdir()
                            except OSError:
                                break
                            parent = parent.parent
        self.cleanup_browser_save_files()
        for image_id in removed_ids:
            self.invalidate_sam_image(image_id)
        return {"images": snapshot["images"], "removedImageIds": removed_ids,
                "catalogGeneration": snapshot["catalogGeneration"]}

    def shutdown(self) -> None:
        """Stop background work before releasing the session import directory."""
        self.begin_shutdown()
        self.model_downloads.shutdown()
        # Browser-save commits retain this lock from token claim through their
        # durable commit.  Do not discard a claimed copy while one is running.
        self._shutdown_locked()

    def _shutdown_locked(self) -> None:
        with self.import_lock:
            with self.lock:
                worker = self.worker_thread
                control = self.job_control
                self._clear_browser_save_tokens_unchecked()
                self.browser_save_receipts.clear()
                self._cancel_manual_uploads_unchecked("アプリを終了しました")
                for session in self._import_sessions.values():
                    LOGGER.info("ブラウザー画像読込を放棄: アプリを終了しました bytes=%d 送信成功=%d件 送信失敗=%d件", session["bytes"], session["succeeded"], session["failed"])
                self._import_sessions.clear()
                if control is not None:
                    control.cancel_requested.set()
                    control.pause_requested.clear()
        if worker is not None and worker.is_alive():
            worker.join()
        with self.import_lock:
            with self.lock:
                image_ids = tuple(self.images)
            locks = [(image_id, self.image_io_lock(image_id)) for image_id in image_ids]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    session = self._detach_session_unchecked()
                    self._clear_browser_save_tokens_unchecked()
                    self._image_io_locks.clear()
                    cache_lock = self._cache_lock_handle if self._owns_process_cache else None
                    if self._owns_process_cache:
                        self._cache_lock_handle = None
                self._release_detached_session(session)
                self._release_directory_lock(cache_lock)
                if self._owns_process_cache:
                    shutil.rmtree(self.cache_dir, ignore_errors=True)
        self.cleanup_browser_save_files()

    def _touch_candidates(self, image_id: str) -> int:
        revision = self.candidate_revisions.get(image_id, 0) + 1
        self.candidate_revisions[image_id] = revision
        return revision

    def _candidate_revision(self, image_id: str) -> int:
        return self.candidate_revisions.get(image_id, 0)

    def image_io_lock(self, image_id: str) -> threading.RLock:
        """Return the small per-image lock used around filesystem I/O.

        Callers obtain this before taking ``self.lock`` for their final state
        revalidation.  This keeps a slow disk operation for one image from
        blocking the catalogue or a different image.
        """
        with self.lock:
            image_lock = self._image_io_locks.get(image_id)
            if image_lock is not None:
                return image_lock
            if image_id not in self.images:
                raise ClientError("画像が見つかりません。フォルダを再読込してください。", "image_not_found")
            image_lock = threading.RLock()
            self._image_io_locks[image_id] = image_lock
            return image_lock

    def _discard_browser_save_token_unchecked(self, token: str) -> BrowserSaveToken | None:
        details = self.browser_save_tokens.pop(token, None)
        if details is not None:
            if details.rendered_path is not None:
                self._pending_browser_save_cleanup.append((details.rendered_path, None))
            if details.output_path is not None:
                self._pending_browser_save_cleanup.append((details.output_path, details.output_fingerprint))
            if details.output_destination is not None:
                self._release_output_destination(details.output_destination)
        return details

    def _release_browser_save_claim(self, token: str) -> None:
        with self.lock:
            self.browser_save_claims.discard(token)

    @staticmethod
    def _unlink_browser_save_cleanup(paths: list[tuple[Path, tuple[int, int] | None] | tuple[Path, tuple[int, int] | None, str | None]]) -> None:
        """Remove only private staged token files; SaveJournal owns finals."""
        for item in paths:
            path, fingerprint = item[0], item[1]
            if len(item) > 2:
                continue
            if fingerprint is not None:
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    SaveJournal._cleanup_staging_parent(path)
                    continue
                except OSError:
                    continue
                if (stat.st_mtime_ns, stat.st_size) != fingerprint:
                    continue
            try:
                path.unlink(missing_ok=True)
            except FileNotFoundError:
                SaveJournal._cleanup_staging_parent(path)
                continue
            except OSError:
                continue
            if path.parent.name == ".mozarie-staging":
                try:
                    path.parent.rmdir()
                except OSError:
                    pass

    def _take_browser_save_cleanup_unchecked(self) -> list[tuple[Path, tuple[int, int] | None]]:
        paths = self._pending_browser_save_cleanup
        self._pending_browser_save_cleanup = []
        return paths

    def _clear_browser_save_tokens_unchecked(self) -> None:
        for token in tuple(self.browser_save_tokens):
            self._discard_browser_save_token_unchecked(token)
        self.browser_save_claims.clear()

    def _discard_browser_save_tokens_for_image_unchecked(self, image_id: str) -> None:
        for token, details in tuple(self.browser_save_tokens.items()):
            if details.image_id == image_id:
                self._discard_browser_save_token_unchecked(token)

    def _discard_expired_browser_save_tokens_unchecked(self) -> None:
        # Tokens are durable until their terminal receipt is explicitly ACKed.
        return

    def _has_active_browser_save_for_image_unchecked(self, image_id: str) -> bool:
        return any(details.image_id == image_id and (token in self.browser_save_claims or details.state in {"rendering", "pending", "publishing"})
                   for token, details in self.browser_save_tokens.items())

    def cleanup_expired_browser_save_tokens(self) -> None:
        return

    # Existing lifecycle callers invoke this after a response; only private
    # stage files are eligible here, never an output final.
    def cleanup_browser_save_files(self) -> None:
        with self.lock:
            paths = self._take_browser_save_cleanup_unchecked()
        self._unlink_browser_save_cleanup(paths)

    def _issue_browser_save_token_unchecked(
        self, record: ImageRecord, revision: int, source_fingerprint: tuple[int, int],
        catalog_generation: int, rendered_path: Path | None, output_path: Path | None = None,
        output_fingerprint: tuple[int, int] | None = None, output_destination: Path | None = None,
        client_token: str | None = None, allow_copy_action: bool = False, no_effect: bool = False,
        output_format: str = "original", keep_metadata: bool = True,
    ) -> str:
        self._assert_request_catalog_expectation()
        token = client_token or secrets.token_urlsafe(32)
        existing = self.browser_save_tokens.get(token)
        if existing is not None and existing.state == "rendering":
            details = replace(existing, rendered_path=rendered_path, output_path=output_path,
                              output_fingerprint=output_fingerprint, output_destination=output_destination,
                              state="pending", allow_copy_action=allow_copy_action, no_effect=no_effect,
                              output_format=output_format, keep_metadata=keep_metadata)
            self.save_journal.update_stage(token, output_path or rendered_path, output_fingerprint)
            self.browser_save_tokens[token] = details
            return token
        if existing is not None:
            raise ClientError("保存確認トークンが重複しています。保存をやり直してください。", "save_state_changed")
        details = BrowserSaveToken(
            image_id=record.image_id, candidate_revision=revision, source_fingerprint=source_fingerprint,
            catalog_generation=catalog_generation, issued_at=time.monotonic(), rendered_path=rendered_path,
            output_path=output_path, output_fingerprint=output_fingerprint, output_destination=output_destination,
            allow_copy_action=allow_copy_action, no_effect=no_effect, output_format=output_format,
            keep_metadata=keep_metadata, transform_revision=record.transform_revision,
            flip_horizontal=record.flip_horizontal, flip_vertical=record.flip_vertical,
            source_flip_horizontal=record.source_flip_horizontal, source_flip_vertical=record.source_flip_vertical,
        )
        self.save_journal.update_stage(token, output_path or rendered_path, output_fingerprint)
        self.browser_save_tokens[token] = details
        return token

    @staticmethod
    def _assert_record_stat_matches(record: ImageRecord) -> None:
        """Fast transport-path guard against external source changes."""
        try:
            stat = record.path.stat()
        except OSError as exc:
            raise ClientError("元画像が外部で変更または削除されました。画像を再読み込みしてください。", "stale_asset") from exc
        if (stat.st_mtime_ns, stat.st_size) != record.asset_fingerprint():
            raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")

    def clear_masks(self, image_ids: list[str]) -> int:
        with self.lock:
            self._assert_catalog_mutable()
        records = self._records_for_ids(image_ids)
        # Acquire multiple per-image locks in a stable order before briefly
        # taking the catalogue lock.  A mask response therefore cannot race a
        # clear for the same image, while unrelated image reads continue.
        locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
        with ExitStack() as stack:
            for _image_id, image_lock in sorted(locks):
                stack.enter_context(image_lock)
            with self.lock:
                self._assert_catalog_mutable()
                for record in records:
                    self._assert_image_editable(record.image_id)
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中はモザイク候補をクリアできません。", "operation_in_progress")
                mask_paths = [
                    candidate.mask_path
                    for record in records
                    for candidate in self.candidates.get(record.image_id, [])
                ]
                revisions = {record.image_id: self._candidate_revision(record.image_id) + 1 for record in records}
                if self.workspace_id is not None:
                    self.workspace_store.clear_image_workspaces(revisions)
                else:
                    for record in records:
                        self.projectless_manual_drafts.pop(record.image_id, None)
                for record in records:
                    self.candidates[record.image_id] = []
                    self.candidate_revisions[record.image_id] = revisions[record.image_id]
                    record.reviewed = False
            self._delete_mask_files(mask_paths, [self.cache_dir / record.image_id for record in records])
        return len(records)

    @staticmethod
    def _delete_mask_files(mask_paths: list[Path], candidate_dirs: list[Path]) -> None:
        """Best-effort cleanup after the state transition has been published."""
        for mask_path in mask_paths:
            try:
                mask_path.unlink(missing_ok=True)
            except OSError as exc:
                LOGGER.warning("Could not remove stale mask %s: %s", mask_path, exc)
        for candidate_dir in candidate_dirs:
            try:
                if candidate_dir.exists():
                    for mask_path in candidate_dir.glob("*.png"):
                        mask_path.unlink(missing_ok=True)
            except OSError as exc:
                LOGGER.warning("Could not clear stale mask directory %s: %s", candidate_dir, exc)

    def _import_images(
        self,
        files: list[dict[str, Any]],
        *,
        include_images: bool = True,
        transfer_active: bool = False,
        import_session_id: str | None = None,
        import_project_id: str | None = None,
        import_catalog_generation: int | None = None,
        source_identity: str | None = None,
        source_kind: str = "browser-files",
        intent: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(files, list) or not files:
            raise ClientError("追加する画像がありません。", "image_not_found")
        if intent not in {"add", "restore"}:
            raise ClientError("画像追加の目的が正しくありません。", "input_invalid")

        with self.lock:
            root = self.root
            catalog_generation = self.catalog_generation
            if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は画像を追加できません。", "operation_in_progress")
            if intent == "add" and self.project_read_only:
                raise ClientError("完了したプロジェクトには新しい画像を追加できません。", "project_read_only")
            if intent == "restore" and self.catalog_id is None:
                raise ClientError("復元するプロジェクトが見つかりません。", "project_source_unavailable")
            destination_dir = self._ensure_session()
            browser_identity = source_identity or self.session_dir.name
            source_import_dir = destination_dir / f"source-{browser_identity}"
            if not transfer_active:
                self.active_import_count += 1

        pending: list[tuple[Path, str, int, int, str, int, int]] = []
        try:
            # Decoding and staging can overlap across request threads. The short
            # catalogue commit below remains serialized.
            for file_data in files:
                if not isinstance(file_data, dict):
                    raise ClientError("画像データの形式が正しくありません。", "input_invalid")
                client_key = str(file_data.get("clientKey") or uuid.uuid4().hex)
                relative_path = safe_import_relative_path(file_data.get("relativePath", file_data.get("name", "")))
                client_mtime_ns = int(file_data.get("mtimeNs", 0) or 0)
                client_size = int(file_data.get("sizeBytes", 0) or 0)
                if client_mtime_ns < 0 or client_size < 0:
                    raise ClientError("画像の更新情報が正しくありません。", "input_invalid")
                if relative_path.suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                temporary: Path | None = None
                try:
                    staged_path = file_data.get("stagedPath")
                    if not isinstance(staged_path, Path):
                        raise ClientError("追加画像を読み込めません。", "image_read_failed")
                    # HTTP already wrote this upload directly into this
                    # session volume.  Inspect and rename that one file;
                    # copying it again doubles I/O and peak disk use.
                    temporary = staged_path
                    width, height = inspect_import_image(temporary, relative_path.suffix)
                    pending.append((temporary, relative_path.as_posix(), width, height, client_key, client_mtime_ns, client_size))
                except Exception:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
                    raise

            with self.import_lock, self.lock:
                session_current = transfer_active and import_catalog_generation is not None and self.import_session_is_current(
                    import_session_id, import_project_id, import_catalog_generation,
                )
                if (
                    self.root != root
                    or (self.catalog_generation != catalog_generation and not session_current)
                    or self.job.state in {"running", "pausing", "paused"}
                    or self._has_active_worker()
                ):
                    raise ClientError("画像一覧が更新されたため、画像の追加を中止しました。もう一度追加してください。", "catalog_changed")
                added: list[ImageRecord] = []
                final_paths: list[Path] = []
                try:
                    imported: list[dict[str, str]] = []
                    for temporary, name, width, height, client_key, client_mtime_ns, client_size in pending:
                        relative = Path(name)
                        # Browser source identities are durable. Keep their
                        # physical staging trees separate, but never let a
                        # filesystem collision rename the source-relative DB/UI
                        # path that identifies this image within its source.
                        destination = source_import_dir / relative
                        if destination.exists():
                            if source_kind != "browser-directory":
                                raise ClientError("同じソース内に同じ相対パスの画像があります。", "input_invalid")
                            destination = unique_session_import_destination(destination)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(temporary, destination)
                        final_paths.append(destination)
                        stat = destination.stat()
                        if client_size and client_size != stat.st_size:
                            raise ClientError("画像のサイズが一致しません。", "image_read_failed")
                        added.append(ImageRecord(
                            image_id=uuid.uuid4().hex,
                            path=destination,
                            relative_path=relative.as_posix(),
                            width=width,
                            height=height,
                            # Browser staging changes filesystem timestamps;
                            # retain the source File metadata for mismatch
                            # detection instead of this temporary copy's mtime.
                            mtime_ns=client_mtime_ns or stat.st_mtime_ns,
                            size_bytes=client_size or stat.st_size,
                            asset_mtime_ns=stat.st_mtime_ns,
                            asset_size_bytes=stat.st_size,
                            source_kind="session",
                            project_source_kind=source_kind,
                            project_source_identity=f"browser:{browser_identity}",
                            project_source_display=source_kind,
                        ))
                        imported.append({"clientKey": client_key, "imageId": added[-1].image_id})
                except Exception:
                    for destination in final_paths:
                        destination.unlink(missing_ok=True)
                    raise
                live_images = dict(self.images)
                live_order = list(self.order)
                live_candidates = {image_id: list(candidates) for image_id, candidates in self.candidates.items()}
                live_revisions = dict(self.candidate_revisions)
                live_mismatches = dict(self.source_mismatches)
                live_sources = [dict(source) for source in self.catalog_sources]
                durable_source_id: str | None = None
                durable_source_created = False
                durable_created_ids: list[str] = []
                transform_rollback: list[tuple[str, int, int, int]] = []
                created_projectless_id: str | None = None
                stored_images: dict[str, dict[str, Any]] = {}
                try:
                    if self.workspace_id is None:
                        created_projectless_id, durable_source_id, stored_images = self.workspace_store.create_projectless_browser_workspace(
                            added, kind=source_kind, display_name=source_kind, source_identity=browser_identity,
                        )
                        self.workspace_store.activate_projectless_catalog(created_projectless_id)
                        self.workspace_id = created_projectless_id
                        durable_source_created = True
                        durable_created_ids = [str(stored["image_id"]) for stored in stored_images.values()]
                    elif self.workspace_id:
                        try:
                            durable_source_id, durable_source_created = self.workspace_store.resolve_browser_source(
                                self.workspace_id,
                                kind=source_kind,
                                display_name=source_kind,
                                source_identity=browser_identity,
                                create=intent == "add",
                            )
                        except ValueError as exc:
                            raise ClientError("選択した画像ソースをこのプロジェクトに復元できません。", "project_source_unavailable") from exc
                    if self.workspace_id and created_projectless_id is None:
                        try:
                            stored_images = self.workspace_store.reconcile_images(
                                self.workspace_id,
                                added,
                                source_id=durable_source_id,
                                allow_new=intent == "add",
                                transform_rollback=transform_rollback,
                            )
                            durable_created_ids = [
                                str(stored["image_id"])
                                for stored in stored_images.values()
                                if stored["created"]
                            ]
                        except ValueError as exc:
                            raise ClientError("選択した画像ソースをこのプロジェクトに復元できません。", "project_source_unavailable") from exc
                    published_imported: list[dict[str, str]] = []
                    replaced_session_paths: list[Path] = []
                    for index, record in enumerate(added):
                        if self.workspace_id:
                            stored = stored_images.get(record.relative_path)
                            if stored is None:
                                record.path.unlink(missing_ok=True)
                                continue
                            record.image_id = str(stored["image_id"]); record.hidden = bool(stored["hidden"]); record.reviewed = bool(stored["reviewed"])
                            record.edited_filename = stored.get("edited_filename")
                            record.flip_horizontal = bool(stored.get("flip_horizontal", False)); record.flip_vertical = bool(stored.get("flip_vertical", False))
                            record.source_flip_horizontal = bool(stored.get("source_flip_horizontal", False)); record.source_flip_vertical = bool(stored.get("source_flip_vertical", False))
                            record.transform_revision = int(stored.get("transform_revision", 0))
                            record.source_id = durable_source_id
                            if stored.get("changed"):
                                self.source_mismatches[record.image_id] = bool(stored.get("dimensions_changed"))
                            _revision, restored = self.workspace_store.hydrate_candidates(record.image_id, self.cache_dir / record.image_id, self._candidate_from_workspace)
                            if restored or _revision:
                                self.candidates[record.image_id] = restored
                                self.candidate_revisions[record.image_id] = _revision
                        previous = self.images.get(record.image_id)
                        if (
                            previous is not None
                            and previous.source_kind == "session"
                            and previous.project_source_identity == record.project_source_identity
                            and previous.path != record.path
                            and self.session_imports_dir is not None
                            and previous.path.is_relative_to(self.session_imports_dir)
                        ):
                            replaced_session_paths.append(previous.path)
                        imported[index]["imageId"] = record.image_id
                        published_imported.append(imported[index])
                        self.images[record.image_id] = record
                        if previous is None:
                            self.order.append(record.image_id)
                    self.order.sort(key=lambda image_id: self.images[image_id].relative_path.lower())
                    if published_imported:
                        self.catalog_sources = self.workspace_store.project_sources(self.workspace_id) if self.workspace_id else []
                        # Browser imports are committed one request at a time.
                        # Publishing their generation lets another tab reject a
                        # request captured before this visible catalogue change.
                        self.catalog_generation += 1
                        self._clear_browser_save_tokens_unchecked()
                        self._cancel_manual_uploads_unchecked("ブラウザー画像を追加しました")
                    images = self.list_images() if include_images else []
                    for path in set(replaced_session_paths):
                        try:
                            path.unlink(missing_ok=True)
                        except OSError as exc:
                            LOGGER.warning("Could not remove replaced session import %s: %s", path, exc)
                    return images, published_imported
                except Exception:
                    try:
                        if self.workspace_id and durable_source_id:
                            self.workspace_store.rollback_import(
                                self.workspace_id,
                                durable_source_id,
                                durable_created_ids,
                                delete_source=durable_source_created,
                                transform_rollback=transform_rollback,
                            )
                    finally:
                        for destination in final_paths:
                            destination.unlink(missing_ok=True)
                        self.images = live_images
                        self.order = live_order
                        self.candidates = live_candidates
                        self.candidate_revisions = live_revisions
                        self.source_mismatches = live_mismatches
                        self.catalog_sources = live_sources
                        if created_projectless_id:
                            self.workspace_store.delete_project(created_projectless_id)
                            self.workspace_id = None
                    raise
        finally:
            for temporary, _name, _width, _height, _client_key, _mtime, _size in pending:
                temporary.unlink(missing_ok=True)
            if not transfer_active:
                with self.lock:
                    self.active_import_count -= 1

    def import_image_file_for_api(
        self,
        staged_path: Path,
        *,
        name: str,
        relative_path: str,
        client_key: str,
        include_images: bool = True,
        transfer_active: bool = False,
        import_session_id: str | None = None,
        import_project_id: str | None = None,
        import_catalog_generation: int | None = None,
        source_identity: str | None = None,
        source_kind: str = "browser-files",
        intent: str,
        mtime_ns: int = 0,
        size_bytes: int = 0,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(client_key, str) or not client_key:
            raise ClientError("追加画像のclientKeyが不正です。", "input_invalid")
        return self._import_images([{
            "clientKey": client_key,
            "name": name,
            "relativePath": relative_path,
            "stagedPath": staged_path,
            "mtimeNs": mtime_ns,
            "sizeBytes": size_bytes,
        }], include_images=include_images, transfer_active=transfer_active, import_session_id=import_session_id,
        import_project_id=import_project_id, import_catalog_generation=import_catalog_generation,
        source_identity=source_identity, source_kind=source_kind, intent=intent)

    def _clear_cache(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for child in self.cache_dir.iterdir():
            if child.name == ".active.lock":
                continue
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            except OSError as exc:
                LOGGER.warning("Could not clear cache entry %s: %s", child, exc)

    def _invalidate_sam_cache(self) -> None:
        """Discard cached per-image embeddings while retaining loaded models."""
        with self.sam_lock:
            if self.sam_predictor is not None:
                self.sam_predictor.reset_image()
            self.sam_image_id = None
        with self.hand_segmentation_lock:
            if self.hand_segmentation_predictor is not None:
                self.hand_segmentation_predictor.reset_image()
            self.hand_segmentation_image_id = None

    def invalidate_sam_image(self, image_id: str) -> None:
        with self.sam_lock:
            if self.sam_image_id == image_id:
                if self.sam_predictor is not None:
                    self.sam_predictor.reset_image()
                self.sam_image_id = None
        with self.hand_segmentation_lock:
            if self.hand_segmentation_image_id == image_id:
                if self.hand_segmentation_predictor is not None:
                    self.hand_segmentation_predictor.reset_image()
                self.hand_segmentation_image_id = None

    def _sam_predictor_for(self, record: ImageRecord, rgb: np.ndarray) -> Any:
        with self.sam_lock:
            # HandSegNet runs first during detection. Drop its image embedding
            # before SAM allocates a new one, while retaining its weights.
            if self.hand_segmentation_predictor is not None:
                self.hand_segmentation_predictor.reset_image()
            self.hand_segmentation_image_id = None
            if self.sam_predictor is None:
                sam_path = self._configured_sam_path()
                self._set_detection_model_preparation(True)
                try:
                    try:
                        from segment_anything import SamPredictor, sam_model_registry
                        torch = torch_module()
                        with torch.device("meta"):
                            model = sam_model_registry[self.settings["models"]["sam_model_type"]](checkpoint=None)
                        state_dict = torch.load(str(sam_path), map_location="cpu", mmap=True, weights_only=True)
                        model.load_state_dict(state_dict, strict=True, assign=True)
                    except ImportError as exc:
                        raise ClientError("SAMのPythonパッケージを読み込めません。", "model_load_failed") from exc
                    except RuntimeError as exc:
                        raise ClientError("SAMチェックポイントを読み込めません。", "sam_checkpoint_invalid") from exc
                    provider = self.settings["models"]["provider"]
                    backend = runtime_backend(torch_module=torch)
                    if provider == "gpu" and backend == "cpu":
                        raise ClientError("SAMをGPUで実行できません。CPUを選ぶかGPU環境を確認してください。", "sam_provider_unavailable")
                    device = torch_device(torch, provider, int(self.settings["models"].get("gpu_device", 0)), backend=backend)
                    if provider == "gpu" and backend == "directml":
                        patch_directml_sam_prompt_encoder(model, torch)
                    if provider == "gpu" and backend == "cuda":
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
                            model.to(device=device)
                    else:
                        model.to(device=device)
                finally:
                    self._set_detection_model_preparation(False)
                self.sam_predictor = SamPredictor(model)

            if self.sam_image_id != record.image_id:
                self.sam_predictor.set_image(rgb)
                self.sam_image_id = record.image_id
            return self.sam_predictor

    def _hand_segmentation_predictor_for(self, record: ImageRecord, rgb: np.ndarray) -> Any:
        """Load the configured HandSegNet ViT-B checkpoint without substitutions."""
        with self.hand_segmentation_lock:
            if self.hand_segmentation_predictor is None:
                raw_path = str(self.settings["models"].get("hand_segmentation", "")).strip()
                if not raw_path:
                    raise ClientError("HandSegNetモデルが未設定です。設定のモデルタブで .safetensors を指定してください。", "model_not_configured")
                path = Path(raw_path).expanduser()
                if not path.is_absolute():
                    raise ClientError("HandSegNetモデルには絶対パスを指定してください。", "model_file_invalid")
                if not path.is_file():
                    raise ClientError("HandSegNetモデルが見つかりません。設定のモデルタブで選び直してください。", "model_file_missing")
                if path.suffix.lower() != ".safetensors":
                    raise ClientError("HandSegNetモデルは .safetensors ファイルを指定してください。", "model_file_invalid")
                self._set_detection_model_preparation(True)
                try:
                    try:
                        from safetensors.torch import load_file
                        from segment_anything import SamPredictor, sam_model_registry
                        torch = torch_module()
                        state_dict = load_file(str(path), device="cpu")
                        with torch.device("meta"):
                            model = sam_model_registry["vit_b"](checkpoint=None)
                        model.load_state_dict(state_dict, strict=True, assign=True)
                    except ImportError as exc:
                        raise ClientError("HandSegNetに必要なPythonパッケージを読み込めません。", "model_load_failed") from exc
                    except Exception as exc:
                        if self._is_gpu_out_of_memory(exc):
                            raise
                        raise ClientError("HandSegNetモデルを読み込めません。", "model_load_failed") from exc
                    provider = self.settings["models"]["provider"]
                    backend = runtime_backend(torch_module=torch)
                    if provider == "gpu" and backend == "cpu":
                        raise ClientError("HandSegNetをGPUで実行できません。CPUを選ぶかGPU環境を確認してください。", "hand_segmentation_invalid")
                    device = torch_device(torch, provider, int(self.settings["models"].get("gpu_device", 0)), backend=backend)
                    if provider == "gpu" and backend == "directml":
                        patch_directml_sam_prompt_encoder(model, torch)
                    if provider == "gpu" and backend == "cuda":
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
                            model.to(device=device)
                    else:
                        model.to(device=device)
                finally:
                    self._set_detection_model_preparation(False)
                self.hand_segmentation_predictor = SamPredictor(model)
            if self.hand_segmentation_image_id != record.image_id:
                self.hand_segmentation_predictor.set_image(rgb)
                self.hand_segmentation_image_id = record.image_id
            return self.hand_segmentation_predictor

    @staticmethod
    def _allowed_root_for_record(
        record: ImageRecord,
        root: Path | None,
        session_imports_dir: Path | None,
    ) -> Path | None:
        if record.source_kind == "filesystem":
            return root
        if record.source_kind == "session":
            return session_imports_dir
        return None

    def image_for_id(self, image_id: str) -> ImageRecord:
        with self.lock:
            record = self.images.get(image_id)
            root = self.root
            session_imports_dir = self.session_imports_dir
        if record is None:
            raise ClientError("画像が見つかりません。フォルダを再読込してください。", "image_not_found")
        try:
            allowed_root = self._allowed_root_for_record(record, record.source_root or root, session_imports_dir)
            if allowed_root is None:
                raise ValueError
            record.path.resolve().relative_to(allowed_root.resolve())
        except ValueError as exc:
            raise ClientError("許可されていない画像パスです。", "input_invalid") from exc
        if not record.path.is_file():
            raise ClientError("画像ファイルが見つかりません。", "image_not_found")
        self._assert_record_stat_matches(record)
        return record

    def list_images(self) -> list[dict[str, Any]]:
        return self.catalog_snapshot(include_sources=False)["images"]

    def set_image_flags(self, image_id: str, payload: dict[str, Any]) -> dict[str, bool]:
        if not isinstance(payload, dict):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        hidden = payload.get("hidden")
        reviewed = payload.get("reviewed")
        if hidden is not None and not isinstance(hidden, bool) or reviewed is not None and not isinstance(reviewed, bool):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        image_lock = self.image_io_lock(image_id)
        with image_lock:
            with self.lock:
                self._assert_catalog_mutable()
                record = self.images.get(image_id)
                if record is None:
                    raise ClientError("画像が見つかりません。", "image_not_found")
                if hidden is True and (
                    image_id in self.job.image_ids and self.job.state in {"running", "pausing", "paused"}
                    or self._has_active_browser_save_for_image_unchecked(image_id)
                ):
                    raise ClientError("処理対象の非表示は処理完了後に変更してください。", "operation_in_progress")
                # The state lock is the publication boundary. Do not let a stale
                # request write an old project's SQLite row after a switch.
                if self.workspace_id and self.workspace_store.has_image(image_id):
                    self.workspace_store.set_image_flags(image_id, hidden=hidden, reviewed=reviewed)
                if hidden is not None: record.hidden = hidden
                if reviewed is not None: record.reviewed = reviewed
                return {"hidden": record.hidden, "reviewed": record.reviewed}

    def set_image_flags_bulk(self, payload: dict[str, Any]) -> dict[str, dict[str, bool]]:
        if not isinstance(payload, dict) or not isinstance(payload.get("imageIds"), list):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        hidden = payload.get("hidden")
        reviewed = payload.get("reviewed")
        if hidden is not None and not isinstance(hidden, bool) or reviewed is not None and not isinstance(reviewed, bool):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        image_ids = list(dict.fromkeys(str(image_id) for image_id in payload["imageIds"] if isinstance(image_id, str) and image_id))
        if not image_ids:
            raise ClientError("画像が選択されていません。", "image_not_found")
        locks = [(image_id, self.image_io_lock(image_id)) for image_id in image_ids]
        with ExitStack() as stack:
            for _image_id, image_lock in sorted(locks):
                stack.enter_context(image_lock)
            with self.lock:
                self._assert_catalog_mutable()
                records = [self.images.get(image_id) for image_id in image_ids]
                if any(record is None for record in records):
                    raise ClientError("画像が見つかりません。", "image_not_found")
                if hidden is True and (
                    any(image_id in self.job.image_ids for image_id in image_ids) and self.job.state in {"running", "pausing", "paused"}
                    or any(self._has_active_browser_save_for_image_unchecked(image_id) for image_id in image_ids)
                ):
                    raise ClientError("処理対象の非表示は処理完了後に変更してください。", "operation_in_progress")
                if self.workspace_id is not None:
                    self.workspace_store.set_image_flags_bulk(image_ids, hidden=hidden, reviewed=reviewed)
                result: dict[str, dict[str, bool]] = {}
                for image_id, record in zip(image_ids, records):
                    if hidden is not None: record.hidden = hidden
                    if reviewed is not None: record.reviewed = reviewed
                    result[image_id] = {"hidden": record.hidden, "reviewed": record.reviewed}
                return result

    @staticmethod
    def _decode_workspace_mask(value: Any) -> bytes | None:
        if value is None or value == "": return None
        if isinstance(value, bytes):
            raw = value
        else:
            if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
                raise ClientError("手描きマスクが正しくありません。", "input_invalid")
            try:
                raw = base64.b64decode(value.split(",", 1)[1], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ClientError("手描きマスクが正しくありません。", "input_invalid") from exc
        if not raw.startswith(PNG_SIGNATURE):
            raise ClientError("手描きマスクが正しくありません。", "input_invalid")
        # Only dirty layers reach this decoder during an incremental save, so
        # validating here preserves the old API contract without reopening the
        # two unchanged 4K layers.
        try:
            WorkspaceStore._decode_png_mask(raw)
        except ValueError as exc:
            raise ClientError("手描きマスクが正しくありません。", "input_invalid") from exc
        return raw

    @staticmethod
    def _encode_workspace_mask(value: bytes | None) -> str:
        if value is None:
            return ""
        # WorkspaceStore.manual has already opened and validated this PNG. The
        # browser writes its masks as RGBA, so preserve that common 4K path
        # without a second Pillow decode/encode; legacy grayscale forms still
        # pass through the canonical alpha encoder.
        canonical = value if len(value) >= 26 and value[12:16] == b"IHDR" and value[25] == 6 else WorkspaceStore._encode_png_mask(value)
        return f"data:image/png;base64,{base64.b64encode(canonical).decode('ascii')}"

    def save_manual_workspace(self, image_id: str, payload: dict[str, Any]) -> None:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                if image_id not in self.images:
                    raise ClientError("画像が見つかりません。", "image_not_found")
                committed = dict(payload)
                dirty_layers = committed.get("dirtyLayers")
                existing = self.workspace_store.manual(image_id, self._encode_workspace_mask) if self.workspace_id else self.projectless_manual_drafts.get(image_id)
                if dirty_layers is not None:
                    existing = existing or {}
                    for layer in ("add", "exclusion", "exclusionErase"):
                        committed.setdefault(layer, existing.get(layer, ""))
                committed["candidateRevision"] = self._candidate_revision(image_id)
                committed["hasEffectiveMask"] = self._effective_mask_for_draft(
                    image_id, self.candidates.get(image_id, []), committed,
                )
                try:
                    # The manual row, its normalized removal IDs, exact candidate
                    # revision, and gallery scalar are one SQLite transaction.
                    self.workspace_store.save_manual(image_id, committed, self._decode_workspace_mask)
                    self.images[image_id].reviewed = False
                except ValueError as exc:
                    raise ClientError("手描き状態を保存できません。", "workspace_write_failed") from exc

    def manual_workspace(self, image_id: str) -> dict[str, Any] | None:
        self.image_for_id(image_id)
        if not self.workspace_id or not self.workspace_store.has_image(image_id): return self.projectless_manual_drafts.get(image_id)
        return self.workspace_store.manual(image_id, self._encode_workspace_mask)

    def project_history_status(self, image_id: str) -> dict[str, bool]:
        self.image_for_id(image_id)
        if not self.workspace_id or not self.workspace_store.has_image(image_id):
            return {"canUndo": False, "canRedo": False}
        return self.workspace_store.history_status(image_id)

    def restore_project_history(self, image_id: str, direction: str) -> dict[str, Any]:
        # Lock every member before the durable cursor is restored.  A grouped
        # undo must never race a candidate/manual mutation on one of its other
        # images.
        with self.import_lock:
            self.image_for_id(image_id)
            with self.lock:
                self._assert_catalog_mutable()
                catalog_id = self.catalog_id
                workspace_id = self.workspace_id
                catalog_generation = self.catalog_generation
            record_ids = self.workspace_store.history_members(image_id, direction)
            if not record_ids:
                return {"changedImageIds": [], "current": {}, **self.workspace_store.history_status(image_id)}
            locks = [(changed_id, self.image_io_lock(changed_id)) for changed_id in record_ids]
            with ExitStack() as stack:
                for _changed_id, image_lock in sorted(locks): stack.enter_context(image_lock)
                with self.lock:
                    if (self.catalog_id != catalog_id or self.workspace_id != workspace_id
                            or self.catalog_generation != catalog_generation
                            or any(changed_id not in self.images for changed_id in record_ids)):
                        raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")
                    changed_ids = self.workspace_store.restore_history(
                        image_id, direction,
                        member_guard=self._assert_history_images_present,
                        expected_members=record_ids,
                    )
                    if not changed_ids:
                        return {"changedImageIds": [], "current": {}, **self.workspace_store.history_status(image_id)}
                    # Keep the durable cursor restore, its candidate hydration,
                    # and the live-state swap behind one catalogue lock. Cache
                    # masks are lazily materialized from SQLite, so no stale
                    # candidate PNG can become externally visible here.
                    hydrated: dict[str, tuple[int, list[Candidate], bool, bool, dict[str, Any]]] = {}
                    try:
                        for changed_id in record_ids:
                            shutil.rmtree(self.cache_dir / changed_id, ignore_errors=True)
                            revision, candidates = self.workspace_store.hydrate_candidates(
                                changed_id, self.cache_dir / changed_id, self._candidate_from_workspace,
                            )
                            hidden, reviewed = self.workspace_store.image_state(changed_id)
                            hydrated[changed_id] = (revision, candidates, hidden, reviewed, self.workspace_store.image_transform(changed_id))
                    except Exception:
                        self.workspace_store.restore_history(
                            image_id, "redo" if direction == "undo" else "undo",
                            member_guard=self._assert_history_images_present,
                            expected_members=record_ids,
                        )
                        raise
                    for changed_id, (revision, candidates, hidden, reviewed, transform) in hydrated.items():
                        record = self.images[changed_id]
                        record.hidden = hidden
                        record.reviewed = reviewed
                        record.flip_horizontal = bool(transform["flipHorizontal"]); record.flip_vertical = bool(transform["flipVertical"])
                        record.source_flip_horizontal = bool(transform["sourceFlipHorizontal"]); record.source_flip_vertical = bool(transform["sourceFlipVertical"])
                        record.transform_revision = int(transform["transformRevision"])
                        self.candidates[changed_id] = candidates
                        self.candidate_revisions[changed_id] = revision
            with self.lock:
                if self.catalog_id != catalog_id or self.workspace_id != workspace_id or self.catalog_generation != catalog_generation or image_id not in self.images:
                    raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")
                current = {
                    "candidateRevision": self._candidate_revision(image_id),
                    "candidates": [candidate.as_api_dict() for candidate in self.candidates.get(image_id, [])],
                    "manual": self.workspace_store.manual(image_id, self._encode_workspace_mask),
                    "image": {"id": self.images[image_id].image_id, "flipH": self.images[image_id].flip_horizontal, "flipV": self.images[image_id].flip_vertical,
                              "sourceFlipH": self.images[image_id].source_flip_horizontal, "sourceFlipV": self.images[image_id].source_flip_vertical,
                              "transformRevision": self.images[image_id].transform_revision},
                }
            return {"changedImageIds": changed_ids, "current": current, **self.workspace_store.history_status(image_id)}

    def delete_manual_workspace(self, image_id: str) -> None:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                if self.workspace_id is None:
                    self.projectless_manual_drafts.pop(image_id, None)
                else:
                    self.workspace_store.delete_manual([image_id])

    def catalog_snapshot(self, *, include_sources: bool = True) -> dict[str, Any]:
        """Capture one catalogue epoch without holding the state lock for SQLite or filesystem I/O."""
        while True:
            with self.lock:
                catalog_id = self.catalog_id
                workspace_id = self.workspace_id
                generation = self.catalog_generation
                root = str(self.root) if self.root else None
                read_only = self.project_read_only
                records = [replace(self.images[image_id]) for image_id in self.order]
                candidate_state = {
                    image_id: (
                        self._candidate_revision(image_id),
                        len(self.candidates.get(image_id, [])),
                        sum(candidate.enabled and candidate.role == CandidateRole.APPLY for candidate in self.candidates.get(image_id, [])),
                    )
                    for image_id in self.order
                }
                mismatches = dict(self.source_mismatches)
                source_records = [dict(source) for source in self.catalog_sources]

            sources = [] if workspace_id is None or not include_sources else [
                {**source, "exists": source["kind"] != "native-folder" or bool(source.get("nativePath") and Path(str(source["nativePath"])).is_dir())}
                for source in source_records
            ]

            with self.lock:
                if self.catalog_id != catalog_id or self.workspace_id != workspace_id or self.catalog_generation != generation:
                    continue
                if (self.project_read_only != read_only or self.source_mismatches != mismatches
                        or self.catalog_sources != source_records
                        or any(self.images.get(record.image_id) != record for record in records)
                        or candidate_state != {
                            image_id: (
                                self._candidate_revision(image_id),
                                len(self.candidates.get(image_id, [])),
                                sum(candidate.enabled and candidate.role == CandidateRole.APPLY for candidate in self.candidates.get(image_id, [])),
                            )
                            for image_id in self.order
                        }):
                    continue
                # These short indexed reads are the existing atomic manual and
                # project metadata boundary; path checks stay outside this lock.
                manual_mask_statuses = {} if workspace_id is None else self.workspace_store.manual_mask_statuses([record.image_id for record in records])
                project = self.workspace_store.project(catalog_id) if catalog_id else None
                output = []
                for record in records:
                    candidate_revision, candidate_count, enabled_count = candidate_state[record.image_id]
                    fallback_effective = bool(enabled_count)
                    if workspace_id is not None:
                        stored_effective, stored_revision = manual_mask_statuses.get(record.image_id, (False, -1))
                        has_effective_mask = stored_effective if stored_revision == candidate_revision else fallback_effective
                    else:
                        has_effective_mask = fallback_effective
                    item = {
                        "id": record.image_id,
                        "relativePath": record.relative_path,
                        "editedFilename": record.edited_filename,
                        "sourceKind": record.source_kind,
                        "width": record.width,
                        "height": record.height,
                        "mtimeNs": record.mtime_ns,
                        "sizeBytes": record.size_bytes,
                        "assetVersion": self.asset_version(record),
                        "candidateCount": candidate_count,
                        "enabledCandidateCount": enabled_count,
                        "hasEffectiveMask": has_effective_mask,
                        "candidateRevision": candidate_revision,
                        "hidden": record.hidden,
                        "reviewed": record.reviewed,
                        "sourceId": record.source_id,
                        "sourceMismatch": record.image_id in mismatches,
                        "sourceDimensionsChanged": bool(mismatches.get(record.image_id)),
                        "flipH": record.flip_horizontal,
                        "flipV": record.flip_vertical,
                        "sourceFlipH": record.source_flip_horizontal,
                        "sourceFlipV": record.source_flip_vertical,
                        "transformRevision": record.transform_revision,
                    }
                    if record.source_kind == "filesystem":
                        item["sourcePath"] = str(record.path)
                    output.append(item)
                needs_source = any(
                    source["kind"] != "native-folder" or not source.get("nativePath") or not source["exists"]
                    for source in sources
                )
                return {
                    "root": root,
                    "images": output,
                    "catalogGeneration": generation,
                    "workspace": workspace_id is not None,
                    "workspaceId": workspace_id,
                    "historyDurable": workspace_id is not None,
                    "project": project,
                    "readOnly": read_only,
                    "sources": sources,
                    "needsSource": needs_source,
                }

    def set_image_transform(self, image_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._assert_image_editable(image_id)
        flip_h, flip_v = payload.get("flipH"), payload.get("flipV")
        if not isinstance(flip_h, bool) or not isinstance(flip_v, bool):
            raise ClientError("反転状態が正しくありません。", "input_invalid")
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                record = self.images.get(image_id)
                if record is None: raise ClientError("画像が見つかりません。", "image_not_found")
                if self.workspace_id is None:
                    record.flip_horizontal = flip_h; record.flip_vertical = flip_v; record.transform_revision += 1
                else:
                    transform = self.workspace_store.set_image_transform(image_id, flip_h, flip_v)
                    record.flip_horizontal = bool(transform["flipHorizontal"]); record.flip_vertical = bool(transform["flipVertical"])
                    record.source_flip_horizontal = bool(transform["sourceFlipHorizontal"]); record.source_flip_vertical = bool(transform["sourceFlipVertical"])
                    record.transform_revision = int(transform["transformRevision"])
                return {"image": {"id": record.image_id, "flipH": record.flip_horizontal, "flipV": record.flip_vertical,
                                   "sourceFlipH": record.source_flip_horizontal, "sourceFlipV": record.source_flip_vertical,
                                   "transformRevision": record.transform_revision}, **self.workspace_store.history_status(image_id)}

    def list_candidates(self, image_id: str) -> list[dict[str, Any]]:
        return self.candidate_snapshot(image_id)["candidates"]

    def candidate_snapshot(self, image_id: str) -> dict[str, Any]:
        """Return a stat-gated candidate snapshot for the selected image."""
        for _attempt in range(2):
            with self.image_io_lock(image_id):
                with self.lock:
                    record = self.images.get(image_id)
                    if record is None:
                        raise ClientError("画像が見つかりません。", "image_not_found")
                    record = replace(record)
                    revision = self._candidate_revision(image_id)
                    snapshot = [replace(candidate) for candidate in self.candidates.get(image_id, [])]
                self._assert_record_stat_matches(record)
                with self.lock:
                    if self._candidate_revision(image_id) != revision:
                        continue
                    stored_candidates = self.candidates.get(image_id, [])
                    durable_ids = self.workspace_store.valid_candidate_ids(image_id)
                    candidates = [candidate for candidate in stored_candidates if candidate.mask_path.is_file() or candidate.candidate_id in durable_ids]
                    if len(candidates) != len(stored_candidates):
                        self._commit_candidate_snapshot(image_id, candidates, replace=True)
                    return {
                        "candidates": [candidate.as_api_dict() for candidate in candidates],
                        "candidateRevision": self._candidate_revision(image_id),
                    }
        raise ClientError("検出候補が更新されました。もう一度読み込んでください。", "catalog_changed")

    def image_snapshot(self, image_id: str) -> ImageRecord:
        """Capture a checked catalogue record before image I/O begins."""
        with self.lock:
            record = self.images.get(image_id)
            if record is None:
                raise ClientError("画像が見つかりません。", "image_not_found")
            return replace(record)

    @staticmethod
    def asset_version(record: ImageRecord) -> str:
        """The inexpensive HTTP version based on the catalogued file stat."""
        mtime_ns, size_bytes = record.asset_fingerprint()
        return f"{mtime_ns}-{size_bytes}-{record.asset_revision}"

    def read_candidate_mask_png(self, image_id: str, candidate_id: str, *, expected_revision: int | None = None) -> bytes:
        """Read one stable mask, then encode outside its per-image lock."""
        with self.image_io_lock(image_id):
            with self.lock:
                candidate = next(
                    (candidate for candidate in self.candidates.get(image_id, []) if candidate.candidate_id == candidate_id),
                    None,
                )
                if candidate is None:
                    raise StaleMaskError("検出候補は既に更新されています。")
                candidate = replace(candidate)
                revision = self._candidate_revision(image_id)
                if expected_revision is not None and revision != expected_revision:
                    raise StaleMaskError("検出候補は既に更新されています。")
            try:
                raw_mask = candidate.mask_path.read_bytes()
            except FileNotFoundError as exc:
                raw_mask = self.workspace_store.candidate_png(image_id, candidate_id)
                if raw_mask is not None:
                    # Do not keep every restored PNG in the process cache. The
                    # requested candidate alone becomes a short-lived cache file.
                    candidate.mask_path.parent.mkdir(parents=True, exist_ok=True)
                    candidate.mask_path.write_bytes(raw_mask)
                else:
                    with self.lock:
                        if self._candidate_revision(image_id) == revision:
                            candidates = [item for item in self.candidates.get(image_id, []) if item.candidate_id != candidate_id]
                            self._commit_candidate_snapshot(image_id, candidates, replace=True)
                    raise StaleMaskError("検出候補は既に更新されています。") from exc
        with open_image(io.BytesIO(raw_mask)) as mask_image:
            alpha_source = mask_image.getchannel("A") if mask_image.mode in {"RGBA", "LA"} else mask_image.convert("L")
            alpha = alpha_source.point(lambda value: 255 if value else 0)
            alpha = Image.fromarray(expand_mask(np.asarray(alpha, dtype=np.uint8), candidate.expand_px))
            rgba = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
            rgba.putalpha(alpha)
            output = io.BytesIO()
            rgba.save(output, format="PNG")
        with self.image_io_lock(image_id):
            with self.lock:
                current = next(
                    (item for item in self.candidates.get(image_id, []) if item.candidate_id == candidate_id),
                    None,
                )
                if (
                    current is None
                    or current.mask_path != candidate.mask_path
                    or self._candidate_revision(image_id) != revision
                    or (expected_revision is not None and revision != expected_revision)
                ):
                    raise StaleMaskError("検出候補は既に更新されています。")
            return output.getvalue()

    def materialize_candidate_mask(self, candidate: Candidate, image_id: str) -> None:
        if candidate.mask_path.is_file(): return
        raw = self.workspace_store.candidate_png(image_id, candidate.candidate_id)
        if raw is None: return
        candidate.mask_path.parent.mkdir(parents=True, exist_ok=True)
        candidate.mask_path.write_bytes(raw)

    def set_candidate_state(self, image_id: str, candidate_id: str, payload: dict[str, Any]) -> int:
        record = self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                if self._has_active_worker():
                    raise ClientError("バックグラウンド処理中は候補を変更できません。", "operation_in_progress")
                candidates = [replace(item) for item in self.candidates.get(image_id, [])]
                candidate = next((item for item in candidates if item.candidate_id == candidate_id), None)
                if candidate is None:
                    raise ClientError("検出候補が見つかりません。", "catalog_changed")
                replace_snapshot = False
                if "role" in payload:
                    if payload["role"] not in {"apply", "exclude"}:
                        raise ClientError("候補の適用先が正しくありません。", "input_invalid")
                    candidate.role = CandidateRole(str(payload["role"]))
                if "forced" in payload and (candidate.role != CandidateRole.EXCLUDE or not isinstance(payload["forced"], bool)):
                    raise ClientError("除外候補の強制指定が正しくありません。", "input_invalid")
                if "enabled" in payload:
                    if not isinstance(payload["enabled"], bool):
                        raise ClientError("候補のON/OFFは真偽値で指定してください。", "input_invalid")
                    candidate.enabled = payload["enabled"]
                if "color" in payload:
                    color = str(payload["color"])
                    if not _valid_color(color):
                        raise ClientError("色の形式が正しくありません。", "input_invalid")
                    candidate.color = color
                if "forced" in payload:
                    candidate.forced = payload["forced"]
                if "expandPx" in payload:
                    expand_px = payload["expandPx"]
                    max_expand_px = int(np.ceil(np.hypot(record.width - 1, record.height - 1)))
                    if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0:
                        raise ClientError("候補の枠pxは0以上の整数で指定してください。", "input_invalid")
                    expand_px = min(expand_px, max_expand_px)
                    if candidate.expand_px != expand_px:
                        candidate.expand_px = expand_px
                        # Padding is metadata.  Do not rewrite or duplicate
                        # the detector's PNG merely to change this control.
                return self._commit_candidate_snapshot(image_id, candidates, replace=replace_snapshot)

    def batch_update_candidates(self, image_id: str, payload: dict[str, Any], *, history_group: str | None = None) -> int:
        """Apply one simple bulk operation and advance the revision once."""
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        role = payload.get("role")
        operation = payload.get("operation")
        if role not in {"apply", "exclude"} or operation not in {"enable", "disable", "delete", "set_padding"}:
            raise ClientError("候補の一括操作が正しくありません。", "input_invalid")
        expand_px = payload.get("expandPx")
        record = self.image_for_id(image_id)
        if operation == "set_padding":
            max_expand_px = int(np.ceil(np.hypot(record.width - 1, record.height - 1)))
            if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0:
                raise ClientError("候補の枠pxは0以上の整数で指定してください。", "input_invalid")
            expand_px = min(expand_px, max_expand_px)
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                if self._has_active_worker():
                    raise ClientError("バックグラウンド処理中は候補を変更できません。", "operation_in_progress")
                current = self.candidates.get(image_id, [])
                selected = [item for item in current if item.role.value == role]
                if operation == "set_padding":
                    if not selected:
                        raise ClientError("更新する候補がありません。", "candidate_not_found")
                    if all(item.expand_px == expand_px for item in selected):
                        return self._candidate_revision(image_id)
                if operation == "delete":
                    candidates = [replace(item) for item in current if item not in selected]
                    paths = [item.mask_path for item in selected]
                else:
                    paths = []
                    candidates = [replace(item) for item in current]
                    for item in candidates:
                        if item.role.value != role:
                            continue
                        if operation == "set_padding":
                            item.expand_px = expand_px
                        else:
                            item.enabled = operation == "enable"
                revision = self._commit_candidate_snapshot(image_id, candidates, replace=operation == "delete", history_group=history_group)
            # The SQLite revision is already durable. Cache cleanup must not
            # turn that successful user operation into an error.
            self._delete_mask_files(paths, [])
            return revision

    def batch_update_candidates_many(self, image_ids: list[str], payload: dict[str, Any]) -> dict[str, int]:
        unique = list(dict.fromkeys(str(image_id) for image_id in image_ids if str(image_id)))
        if not unique:
            raise ClientError("候補を更新する画像がありません。", "image_not_found")
        role = payload.get("role")
        operation = payload.get("operation")
        if role not in {"apply", "exclude"} or operation not in {"enable", "disable", "delete", "set_padding"}:
            raise ClientError("候補の一括操作が正しくありません。", "input_invalid")
        expand_px = payload.get("expandPx")
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable()
                catalog_id = self.catalog_id
                workspace_id = self.workspace_id
                catalog_generation = self.catalog_generation
                if any(image_id not in self.images for image_id in unique):
                    raise ClientError("画像が見つかりません。", "image_not_found")
            locks = [(image_id, self.image_io_lock(image_id)) for image_id in unique]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                # Image locks keep the target snapshots stable while mask
                # composition and SQLite staging run without the global lock.
                with self.lock:
                    if self.catalog_id != catalog_id or self.workspace_id != workspace_id or self.catalog_generation != catalog_generation:
                        raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")
                    self._assert_catalog_mutable()
                    if self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は候補を変更できません。", "operation_in_progress")
                    updates: dict[str, list[Candidate]] = {}
                    delete_paths: list[Path] = []
                    revisions: dict[str, int] = {}
                    projectless_drafts: dict[str, dict[str, Any]] = {}
                    for image_id in unique:
                        self._assert_image_editable(image_id)
                        record = self.images[image_id]
                        selected = [item for item in self.candidates.get(image_id, []) if item.role.value == role]
                        if not selected:
                            raise ClientError("更新する候補がありません。", "candidate_not_found")
                        if operation == "set_padding":
                            max_expand_px = int(np.ceil(np.hypot(record.width - 1, record.height - 1)))
                            if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0:
                                raise ClientError("候補の枠pxは0以上の整数で指定してください。", "input_invalid")
                            image_expand_px = min(expand_px, max_expand_px)
                        current = self.candidates.get(image_id, [])
                        if operation == "delete":
                            updates[image_id] = [replace(item) for item in current if item not in selected]
                            delete_paths.extend(item.mask_path for item in selected)
                        else:
                            candidates = [replace(item) for item in current]
                            for candidate in candidates:
                                if candidate.role.value == role:
                                    if operation == "set_padding": candidate.expand_px = image_expand_px
                                    else: candidate.enabled = operation == "enable"
                            updates[image_id] = candidates
                        revisions[image_id] = self._candidate_revision(image_id) + 1
                        draft = self.projectless_manual_drafts.get(image_id)
                        if draft is not None:
                            projectless_drafts[image_id] = dict(draft)

                group_id = uuid.uuid4().hex if len(unique) > 1 else None
                durable_ids = {image_id for image_id in unique if workspace_id is not None and self.workspace_store.has_image(image_id)}
                durable_states = [
                    (image_id, revisions[image_id], updates[image_id], self._effective_mask_for_candidates(image_id, updates[image_id]), operation == "delete")
                    for image_id in unique if image_id in durable_ids
                ]
                projectless_effective = {
                    image_id: self._effective_mask_for_draft(image_id, updates[image_id], draft)
                    for image_id, draft in projectless_drafts.items()
                }
                with self.lock:
                    if self.catalog_id != catalog_id or self.workspace_id != workspace_id or self.catalog_generation != catalog_generation:
                        raise ClientError("プロジェクト一覧が更新されました。もう一度操作してください。", "stale_catalog")
                    self._assert_catalog_mutable()
                    if any(self._candidate_revision(image_id) != revisions[image_id] - 1 for image_id in unique):
                        raise ClientError("候補が変更されました。もう一度操作してください。", "catalog_changed")
                    if durable_states:
                        self.workspace_store.commit_candidate_states(durable_states, history_group=group_id)
                    for image_id in unique:
                        draft = self.projectless_manual_drafts.get(image_id)
                        if draft is not None and image_id in projectless_effective:
                            draft["candidateRevision"] = revisions[image_id]
                            draft["hasEffectiveMask"] = projectless_effective[image_id]
                        self.candidates[image_id] = updates[image_id]
                        self.candidate_revisions[image_id] = revisions[image_id]
                        self.images[image_id].reviewed = False
                    result = revisions
                self._delete_mask_files(delete_paths, [])
                return result

    def delete_candidate(self, image_id: str, candidate_id: str) -> bool:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_catalog_mutable()
                self._assert_image_editable(image_id)
                if self._has_active_worker():
                    raise ClientError("バックグラウンド処理中は候補を変更できません。", "operation_in_progress")
                candidates = self.candidates.get(image_id, [])
                candidate = next((item for item in candidates if item.candidate_id == candidate_id), None)
                if candidate is None:
                    return False
                updated = [replace(item) for item in candidates if item.candidate_id != candidate_id]
                self._commit_candidate_snapshot(image_id, updated, replace=True)
            # Candidate masks are disposable cache files. Keep the durable
            # delete and its undo entry successful when Windows still has a
            # preview handle open on the old PNG.
            self._delete_mask_files([candidate.mask_path], [])
            return True
