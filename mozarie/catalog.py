from __future__ import annotations

import warnings
import base64
import binascii
import io
import json
import os
import secrets
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from .core import (
    IMAGE_SUFFIXES, IO_CHUNK_BYTES, MAX_BODY_BYTES, PNG_SIGNATURE,
    SAVE_TOKEN_TTL_SECONDS,
    BrowserSaveToken, ClientError, ImageRecord, Job, LOGGER, StaleMaskError,
    safe_import_relative_path, torch_module,
)
from .domain import Candidate, CandidateRole
from .image_io import _valid_color, decode_draft_masks, draft_manual_exclusion_forced, inspect_import_image, oriented_image_size, unique_session_import_destination
from .masks import compose_masks, expand_mask
from .runtime import patch_directml_sam_prompt_encoder, runtime_backend, torch_device
from .workspace import ProjectNameAlreadyExistsError, WorkspaceStore

class CatalogMixin:
    def _assert_image_editable(self, image_id: str) -> None:
        with self.lock:
            self._assert_catalog_mutable()
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

    def _commit_candidate_snapshot(self, image_id: str, candidates: list[Candidate], *, replace: bool, history_group: str | None = None) -> int:
        """Durably commit a candidate revision, then publish it while the caller holds ``self.lock``."""
        revision = self._candidate_revision(image_id) + 1
        if self.workspace_store.has_image(image_id):
            self.workspace_store.commit_candidate_state(
                image_id, revision, candidates,
                self._effective_mask_for_candidates(image_id, candidates), replace=replace, history_group=history_group,
            )
        self.candidates[image_id] = candidates
        self.candidate_revisions[image_id] = revision
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
        if self.workspace_store.has_image(image_id):
            draft = self.workspace_store.manual(image_id, self._encode_workspace_mask) or {}
            effective = self._effective_mask_for_draft(image_id, candidates, draft)
            pending = self.workspace_store.prepare_candidate_state(
                image_id, revision, candidates, effective, replace=replace, history_group=history_group,
                expected_revision=expected_revision, preserve_reviewed=True,
            )
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
        return revision

    def _replace_catalog(self, root: Path, records: list[ImageRecord]) -> list[dict[str, Any]]:
        with self.lock:
            previous_ids = tuple(self.images)
        locks = [(image_id, self.image_io_lock(image_id)) for image_id in previous_ids]
        with ExitStack() as stack:
            for _image_id, image_lock in sorted(locks):
                stack.enter_context(image_lock)
            with self.lock:
                self._assert_catalog_mutable()
                self.images = {record.image_id: record for record in records}
                self.order = [record.image_id for record in records]
                self.candidates = {}
                self.candidate_revisions = {record.image_id: 0 for record in records}
                self.projectless_manual_drafts.clear()
                self._clear_browser_save_tokens_unchecked()
                self.root = root
                self.source_roots = {str(record.source_id): record.source_root for record in records if record.source_id and record.source_root}
                self._invalidate_sam_cache()
                self.job = Job()
                self.catalog_generation += 1
                session = self._detach_session_unchecked()
                self._image_io_locks.clear()
            self._clear_cache()
            # Cache cleanup intentionally happens before masks are materialised.
            self._restore_workspace_candidates(records)
            self._release_detached_session(session)
        self.cleanup_expired_browser_save_tokens()
        return self.list_images()

    def _has_active_worker(self) -> bool:
        return self.worker_thread is not None and self.worker_thread.is_alive()

    def _assert_catalog_mutable(self, *, allow_terminal_cleanup: bool = False) -> None:
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

    def set_root(self, raw_path: str) -> list[dict[str, Any]]:
        with self.import_lock:
            return self._set_root(raw_path)

    def _set_root(self, raw_path: str, project_id: str | None = None, *, defer_replace: bool = False) -> list[Any]:
        if not raw_path or not isinstance(raw_path, str):
            raise ClientError("Windowsフォルダを入力してください。", "input_invalid")
        root = Path(raw_path).expanduser().resolve()
        if not root.is_dir():
            raise ClientError("指定フォルダが見つかりません。", "folder_not_found")
        with self.lock:
            self._assert_catalog_mutable()

        previous_catalog_id = self.catalog_id
        catalog_id = project_id or previous_catalog_id
        if catalog_id is not None and not self.workspace_store.catalog_exists(catalog_id):
            raise ClientError("プロジェクトが見つかりません。", "project_not_found")
        source_id = None
        stored_metadata: dict[str, tuple[int, int, int, int]] = {}
        if catalog_id is not None:
            source_id = self.workspace_store.ensure_project_source(
                catalog_id, kind="native-folder", display_name=root.name or str(root), identity=str(root.resolve()),
            )
            stored_metadata = self.workspace_store.source_image_metadata(source_id)

        paths = [path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES]
        records: list[ImageRecord] = []
        records_lock = threading.Lock()
        next_path = 0
        paths_lock = threading.Lock()

        def inspect_path() -> None:
            nonlocal next_path
            while True:
                with paths_lock:
                    if next_path >= len(paths):
                        return
                    path = paths[next_path]
                    next_path += 1
                try:
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
                except (OSError, UnidentifiedImageError, ValueError, ClientError):
                    continue
                with records_lock:
                    records.append(record)

        # Keep a fixed number of streaming workers rather than one Future per
        # file. Folder scans follow the same import-parallelism setting as
        # drag-and-drop imports.
        worker_count = min(int(self.settings["importing"]["parallelism"]), len(paths))
        if worker_count:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                workers = [executor.submit(inspect_path) for _ in range(worker_count)]
                for worker in workers:
                    worker.result()
        records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path))
        stored = self.workspace_store.reconcile_images(catalog_id, records, source_id=source_id) if catalog_id is not None else {}
        # A project can have several sources. Missing files remain durable so
        # their masks can still be exported or relinked later.
        for record in records:
            saved = stored.get(record.relative_path)
            if saved is not None:
                record.image_id = str(saved["image_id"])
                record.hidden = bool(saved["hidden"])
                record.reviewed = bool(saved["reviewed"])
            record.source_id = source_id
            record.source_root = root
        source_image_ids = {record.image_id for record in records}
        source_mismatches = {
            str(saved["image_id"]): bool(saved.get("dimensions_changed"))
            for saved in stored.values() if saved.get("changed")
        }
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
        self.catalog_id = catalog_id
        completed = bool(catalog_id and (self.workspace_store.project(catalog_id) or {}).get("status") == "completed")
        if catalog_id is not None:
            self.workspace_store.set_project_source_root(catalog_id, str(root))
        if defer_replace:
            return records
        # Adding another folder to an open project is additive.  Replace only
        # this source's live records so same relative names stay independent.
        if catalog_id is not None and previous_catalog_id == catalog_id:
            with self.lock:
                retained = [record for record in self.images.values() if record.source_id != source_id]
            records = retained + records
            records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path, record.image_id))
        images = self._replace_catalog(root, records)
        with self.lock:
            self.project_read_only = completed
        return images

    def projects(self, sort: str = "updated_desc") -> list[dict[str, Any]]:
        return self.workspace_store.projects(sort)

    def projects_for_source_root(self, raw_path: str) -> list[dict[str, Any]]:
        root = Path(raw_path).expanduser()
        if not root.is_absolute() or not root.is_dir():
            raise ClientError("画像フォルダが見つかりません。", "folder_not_found")
        return self.workspace_store.projects_for_source_root(str(root.resolve()), self.catalog_id)

    def create_project(self, name: str | None = None) -> dict[str, Any]:
        try:
            project = self.workspace_store.create_project(name)
        except ProjectNameAlreadyExistsError as exc:
            raise ClientError("", "project_name_duplicate") from exc
        except ValueError as exc:
            raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
        self.detach_catalog()
        with self.lock:
            self.catalog_id = str(project["id"]); self.project_read_only = False; self.source_mismatches = {}
        return project

    def save_current_as_project(self, name: str) -> dict[str, Any]:
        """Make the current projectless session durable without replacing it."""
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable()
                if self.catalog_id:
                    catalog_id = self.catalog_id
                    try:
                        return self.workspace_store.name_project(catalog_id, name)
                    except ProjectNameAlreadyExistsError as exc:
                        raise ClientError("", "project_name_duplicate") from exc
                    except ValueError as exc:
                        raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
                records = [self.images[image_id] for image_id in self.order if image_id in self.images]
                candidates = {record.image_id: [replace(item) for item in self.candidates.get(record.image_id, [])] for record in records}
                revisions = {record.image_id: self._candidate_revision(record.image_id) for record in records}
                # Projectless drafts retain their latest incremental-save hints
                # for the browser.  Promotion writes a complete SQLite row, so
                # give it a separate full-snapshot copy without those hints.
                manual_drafts = {
                    record.image_id: {
                        key: value for key, value in self.projectless_manual_drafts[record.image_id].items()
                        if key not in {"dirtyLayers", "dirtyRois"}
                    }
                    for record in records if record.image_id in self.projectless_manual_drafts
                }
                grouped: dict[tuple[str, str, str], list[ImageRecord]] = {}
                for record in records:
                    if record.source_kind == "filesystem":
                        root = (record.source_root or self.root or record.path.parent).resolve()
                        source = ("native-folder", str(root), root.name or str(root))
                    else:
                        kind = record.project_source_kind or "browser-files"
                        identity = record.project_source_identity or f"browser:{self.session_dir.name if self.session_dir else uuid.uuid4().hex}"
                        source = (kind, identity, record.project_source_display or "ブラウザから追加")
                    grouped.setdefault(source, []).append(record)
                effective_masks = {
                    record.image_id: self._effective_mask_for_draft(
                        record.image_id, candidates[record.image_id], manual_drafts.get(record.image_id, {}),
                    )
                    for record in records
                }
                try:
                    project, source_ids = self.workspace_store.promote_projectless(
                        name, [(kind, identity, display_name, members) for (kind, identity, display_name), members in grouped.items()],
                        candidates, revisions, effective_masks, manual_drafts, self._decode_workspace_mask,
                    )
                except ProjectNameAlreadyExistsError as exc:
                    raise ClientError("", "project_name_duplicate") from exc
                except ValueError as exc:
                    raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc
                catalog_id = str(project["id"])
                for record in records:
                    record.source_id = source_ids[record.image_id]
                self.catalog_id = catalog_id
                self.projectless_manual_drafts.clear()
                project["sourceIds"] = source_ids
                return project

    def name_current_project(self, name: str) -> dict[str, Any]:
        with self.lock:
            catalog_id = self.catalog_id
        if not catalog_id:
            return self.save_current_as_project(name)
        try: return self.workspace_store.name_project(catalog_id, name)
        except ProjectNameAlreadyExistsError as exc: raise ClientError("", "project_name_duplicate") from exc
        except ValueError as exc: raise ClientError("プロジェクト名を確認してください。", "project_name_invalid") from exc

    def complete_project(self) -> dict[str, Any]:
        with self.lock:
            if not self.catalog_id:
                raise ClientError("プロジェクトを開いていません。", "project_not_found")
            self._assert_catalog_mutable()
            catalog_id = self.catalog_id
        project = self.workspace_store.set_project_status(catalog_id, "completed")
        self.detach_catalog()
        return project

    def close_project(self) -> None:
        self.detach_catalog()

    def delete_project(self, catalog_id: str) -> None:
        """Delete project-only state while leaving every original image untouched."""
        project = self.workspace_store.project(catalog_id)
        if not project:
            raise ClientError("プロジェクトが見つかりません。", "project_not_found")
        image_ids = [str(image["id"]) for image in self.workspace_store.project_images(catalog_id)]
        with self.import_lock:
            with self.lock:
                if self.catalog_id == catalog_id and self._has_active_worker():
                    raise ClientError("処理中のプロジェクトは削除できません。", "operation_in_progress")
                active = self.catalog_id == catalog_id
                if active:
                    # Deletion is permitted for completed projects too; it is
                    # not an editing operation and intentionally never flushes drafts.
                    self.project_read_only = False
            if active:
                self.detach_catalog()
            self.workspace_store.delete_project(catalog_id)
            for image_id in image_ids:
                shutil.rmtree(self.cache_dir / image_id, ignore_errors=True)
                for thumbnail_path in (self.cache_dir / "thumbnails").glob(f"{image_id}-*.jpg"):
                    try:
                        thumbnail_path.unlink(missing_ok=True)
                    except OSError:
                        LOGGER.warning("Could not remove deleted-project thumbnail %s", thumbnail_path)

    def resume_project(self, catalog_id: str) -> dict[str, Any]:
        project = self.workspace_store.set_project_status(catalog_id, "working")
        with self.lock:
            if self.catalog_id == catalog_id:
                self.project_read_only = False
        return project

    def open_project(self, catalog_id: str) -> dict[str, Any]:
        project = self.workspace_store.project(catalog_id)
        if not project:
            raise ClientError("プロジェクトが見つかりません。", "project_not_found")
        sources = self.workspace_store.project_sources(catalog_id)
        native_roots = [Path(str(source["nativePath"])) for source in sources
                        if source["kind"] == "native-folder" and source.get("nativePath") and Path(str(source["nativePath"])).is_dir()]
        if native_roots:
            self.detach_catalog()
            # Loading source bytes is not an edit.  Temporarily permit the
            # catalogue replacement, then restore completed read-only state.
            self.project_read_only = False
            records: list[ImageRecord] = []
            for root in native_roots:
                self.project_read_only = False
                records.extend(self._set_root(str(root), catalog_id, defer_replace=True))
            records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path, record.image_id))
            images = self._replace_catalog(native_roots[0], records)
            self.project_read_only = project["status"] == "completed"
            # Browser sources may still need a user-granted handle.  Native
            # images are shown immediately and the UI can add the rest.
            needs_source = any(
                source["kind"] != "native-folder"
                or not source.get("nativePath")
                or not Path(str(source["nativePath"])).is_dir()
                for source in sources
            )
            return {"project": project, "images": images, "needsSource": needs_source, "sources": sources}
        self.detach_catalog()
        with self.lock:
            self.catalog_id = catalog_id; self.project_read_only = project["status"] == "completed"; self.source_mismatches = {}
        return {"project": project, "images": [], "needsSource": bool(sources), "sources": sources}

    def source_mismatch_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return [{"id": image_id, "relativePath": self.images[image_id].relative_path, "dimensionsChanged": dimensions}
                    for image_id, dimensions in self.source_mismatches.items() if image_id in self.images]

    def export_mask_png(self, image_id: str, kind: str) -> bytes:
        """Return original-size grayscale project masks; never touches source files."""
        if kind not in {"mosaic", "exclude"}:
            raise ClientError("マスク種別が正しくありません。", "input_invalid")
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
                with Image.open(io.BytesIO(base64.b64decode(str(sample), validate=True))) as mask_image:
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
        apply_masks: list[np.ndarray] = []; exclude_masks: list[np.ndarray] = []; forced: list[np.ndarray] = []
        for candidate in state["candidates"]:
            if not candidate.get("enabled") or candidate.get("deleted") or candidate.get("id") in removed:
                continue
            try: raw = base64.b64decode(str(candidate["mask"]), validate=True)
            except (KeyError, ValueError, binascii.Error) as exc: raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed") from exc
            with Image.open(io.BytesIO(raw)) as image: mask = expand_mask(np.asarray(image.convert("L"), dtype=np.uint8), int(image.text.get("mozarie_expand_px", "0")))
            if candidate.get("role") == CandidateRole.APPLY.value: apply_masks.append(mask)
            else:
                exclude_masks.append(mask)
                if candidate.get("forced"): forced.append(mask)
        if kind == "mosaic":
            value = compose_masks((height, width), apply_masks, exclude_masks, add if draft.get("manualEnabled") is not False else None, manual_exclude if draft.get("manualExclusionEnabled") is not False else None, forced, draft_manual_exclusion_forced(draft, True), erase if draft.get("manualExclusionEraseEnabled") is not False else None)
        else:
            value = np.zeros((height, width), dtype=np.uint8)
            for mask in exclude_masks: value = np.maximum(value, np.asarray(mask > 0, dtype=np.uint8) * 255)
            if manual_exclude is not None and draft.get("manualExclusionEnabled") is not False: value = np.maximum(value, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)
            if erase is not None and draft.get("manualExclusionEraseEnabled") is not False: value[np.asarray(erase) > 0] = 0
        output = io.BytesIO(); Image.fromarray(value, "L").save(output, format="PNG"); return output.getvalue()

    def project_mask_images(self) -> list[dict[str, Any]]:
        if not self.catalog_id:
            raise ClientError("プロジェクトを開いていません。", "project_not_found")
        return self.workspace_store.project_images(self.catalog_id)

    def export_project_mask_png(self, image_id: str, kind: str) -> bytes:
        image = self.workspace_store.project_image(image_id)
        if image is None:
            raise ClientError("画像が見つかりません。", "image_not_found")
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
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG" or image.size != (width, height):
                    raise ValueError("workspace mask is invalid")
                return np.asarray(image.convert("L"), dtype=np.uint8)
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
                with Image.open(io.BytesIO(sample)) as mask_image:
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
        apply_masks: list[np.ndarray] = []; exclude_masks: list[np.ndarray] = []; forced: list[np.ndarray] = []
        for candidate in state["candidates"]:
            if not candidate.get("enabled") or candidate["id"] in removed:
                continue
            mask = self._raw_workspace_mask(candidate.get("mask"), width, height)
            if mask is None:
                raise ClientError("保存済みマスクが正しくありません。", "workspace_write_failed")
            mask = expand_mask(mask, int(candidate.get("expandPx", 0)))
            if candidate.get("role") == CandidateRole.APPLY.value:
                apply_masks.append(mask)
            else:
                exclude_masks.append(mask)
                if candidate.get("forced"):
                    forced.append(mask)
        if kind == "mosaic":
            value = compose_masks(
                (height, width), apply_masks, exclude_masks,
                add if manual.get("manualEnabled", True) else None,
                manual_exclude if manual.get("exclusionEnabled", True) else None,
                forced, bool(manual.get("exclusionForced", True)),
                erase if manual.get("eraseEnabled", True) else None,
            )
        else:
            value = np.zeros((height, width), dtype=np.uint8)
            for mask in exclude_masks:
                value = np.maximum(value, np.asarray(mask > 0, dtype=np.uint8) * 255)
            if manual_exclude is not None and manual.get("exclusionEnabled", True):
                value = np.maximum(value, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)
            if erase is not None and manual.get("eraseEnabled", True):
                value[np.asarray(erase) > 0] = 0
        output = io.BytesIO(); Image.fromarray(value, "L").save(output, format="PNG")
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
            with self.lock:
                self._assert_catalog_mutable()
                known = requested & set(self.source_mismatches) & set(self.images)
                records = [self.images[image_id] for image_id in known]
                revisions = ({image_id: self._candidate_revision(image_id) + 1 for image_id in known}
                             if clear_masks else None)
                # The comparison baseline changes only after the user confirms.
                # This one durable operation either commits both the source
                # metadata and an optional mask clear, or leaves both intact.
                self.workspace_store.acknowledge_source_mismatches(records, revisions)
                if clear_masks:
                    for image_id, revision in (revisions or {}).items():
                        self.candidates[image_id] = []
                        self.candidate_revisions[image_id] = revision
                for image_id in known:
                    self.source_mismatches.pop(image_id, None)
        if clear_masks:
            self._delete_mask_files([], [self.cache_dir / image_id for image_id in known])

    def detach_catalog(self) -> str | None:
        """Clear only the live screen state while retaining durable work."""
        with self.import_lock:
            # Closing a completed project is always allowed; it does not alter
            # project data.
            self.project_read_only = False
            with self.lock:
                image_ids = tuple(self.images)
            locks = [(image_id, self.image_io_lock(image_id)) for image_id in image_ids]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_mutable()
                    self.images = {}
                    self.order = []
                    self.candidates = {}
                    self.candidate_revisions = {}
                    self._clear_browser_save_tokens_unchecked()
                    self._invalidate_sam_cache()
                    catalog_id = self.catalog_id
                    self.catalog_id = None
                    self.source_mismatches = {}
                    self.source_roots = {}
                    self.catalog_generation += 1
                    session = self._detach_session_unchecked()
                    self._image_io_locks.clear()
                self._clear_cache()
                self._release_detached_session(session)
        self.cleanup_expired_browser_save_tokens()
        return catalog_id

    def clear_catalog(self) -> None:
        """Explicit user clear: remove durable rows after detaching the view."""
        catalog_id = self.detach_catalog()
        if catalog_id:
            self.workspace_store.prune_catalog_images(catalog_id, set())

    def remove_image_from_catalog(self, image_id: str) -> list[dict[str, Any]]:
        """Remove one image's working state without deleting its source file."""
        return self.remove_images_from_catalog([image_id])["images"]

    def remove_images_from_catalog(self, image_ids: list[str]) -> dict[str, Any]:
        """Remove saved images from the working catalog without deleting source files."""
        if not isinstance(image_ids, list):
            raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
        requested_ids = list(dict.fromkeys(str(image_id) for image_id in image_ids if str(image_id)))
        if not requested_ids:
            raise ClientError("削除する画像がありません。", "image_not_found")
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable(allow_terminal_cleanup=True)
                records = [self.images[image_id] for image_id in requested_ids if image_id in self.images]
            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    self._assert_catalog_mutable(allow_terminal_cleanup=True)
                    records = [self.images[record.image_id] for record in records if record.image_id in self.images]
                    removed_ids = [record.image_id for record in records]
                    mask_paths = [candidate.mask_path for record in records for candidate in self.candidates.get(record.image_id, [])]
                    session_paths = [record.path for record in records if record.source_kind == "session"]
                    session_imports_dir = self.session_imports_dir
                    # The durable delete is the transaction boundary. Do it
                    # before publishing the in-memory removal so a database
                    # failure leaves both views intact.
                    self.workspace_store.delete_images(removed_ids)
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
                    self._clear_browser_save_tokens_unchecked()
                self._delete_mask_files(mask_paths, [self.cache_dir / record.image_id for record in records])
                thumbnail_dir = self.cache_dir / "thumbnails"
                removed_set = set(removed_ids)
                thumbnail_paths = [path for path in thumbnail_dir.glob("*.jpg") if path.stem.rsplit("-", 3)[0] in removed_set]
                for record in records:
                    shutil.rmtree(self.cache_dir / record.image_id, ignore_errors=True)
                for thumbnail_path in thumbnail_paths:
                    thumbnail_path.unlink(missing_ok=True)
                for path in session_paths:
                    path.unlink(missing_ok=True)
                    if session_imports_dir is not None:
                        parent = path.parent
                        while parent != session_imports_dir and parent.is_relative_to(session_imports_dir):
                            try:
                                parent.rmdir()
                            except OSError:
                                break
                            parent = parent.parent
        self.cleanup_expired_browser_save_tokens()
        for image_id in removed_ids:
            self.invalidate_sam_image(image_id)
        return {"images": self.list_images(), "removedImageIds": removed_ids}

    def shutdown(self) -> None:
        """Stop background work before releasing the session import directory."""
        self.model_downloads.shutdown()
        # Browser-save commits retain this lock from token claim through their
        # durable commit.  Do not discard a claimed copy while one is running.
        with self.import_lock:
            self._shutdown_locked()

    def _shutdown_locked(self) -> None:
        with self.lock:
            worker = self.worker_thread
            control = self.job_control
            self._clear_browser_save_tokens_unchecked()
            self.browser_save_receipts.clear()
            if control is not None:
                control.cancel_requested.set()
                control.pause_requested.clear()
        if worker is not None and worker.is_alive():
            worker.join(timeout=5)
        if worker is not None and worker.is_alive():
            LOGGER.warning("Background worker did not stop before shutdown; retaining this process cache.")
            return
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
        self.cleanup_expired_browser_save_tokens()

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
        return details

    def _release_browser_save_claim(self, token: str) -> None:
        with self.lock:
            self.browser_save_claims.discard(token)

    @staticmethod
    def _unlink_browser_save_cleanup(paths: list[tuple[Path, tuple[int, int] | None]]) -> None:
        """Remove detached token files without touching a replacement at its path."""
        for path, fingerprint in paths:
            if fingerprint is not None:
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if (stat.st_mtime_ns, stat.st_size) != fingerprint:
                    continue
            path.unlink(missing_ok=True)

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
        cutoff = time.monotonic() - SAVE_TOKEN_TTL_SECONDS
        for token, details in tuple(self.browser_save_tokens.items()):
            if token not in self.browser_save_claims and details.issued_at < cutoff:
                self._discard_browser_save_token_unchecked(token)
        for token, receipt in tuple(self.browser_save_receipts.items()):
            if receipt.completed_at < cutoff:
                self.browser_save_receipts.pop(token, None)

    def cleanup_expired_browser_save_tokens(self) -> None:
        """Cheap polling-path expiry: detach under lock, unlink afterwards."""
        cutoff = time.monotonic() - SAVE_TOKEN_TTL_SECONDS
        with self.lock:
            for token, details in tuple(self.browser_save_tokens.items()):
                if token not in self.browser_save_claims and details.issued_at < cutoff:
                    self._discard_browser_save_token_unchecked(token)
            for token, receipt in tuple(self.browser_save_receipts.items()):
                if receipt.completed_at < cutoff:
                    self.browser_save_receipts.pop(token, None)
            expired_paths = self._take_browser_save_cleanup_unchecked()
        self._unlink_browser_save_cleanup(expired_paths)

    def _issue_browser_save_token_unchecked(
        self,
        record: ImageRecord,
        revision: int,
        source_fingerprint: tuple[int, int],
        catalog_generation: int,
        rendered_path: Path | None,
        output_path: Path | None = None,
        output_fingerprint: tuple[int, int] | None = None,
        allow_copy_action: bool = False,
        no_effect: bool = False,
    ) -> str:
        self._discard_expired_browser_save_tokens_unchecked()
        token = secrets.token_urlsafe(32)
        self.browser_save_tokens[token] = BrowserSaveToken(
            image_id=record.image_id,
            candidate_revision=revision,
            source_fingerprint=source_fingerprint,
            catalog_generation=catalog_generation,
            issued_at=time.monotonic(),
            rendered_path=rendered_path,
            output_path=output_path,
            output_fingerprint=output_fingerprint,
            allow_copy_action=allow_copy_action,
            no_effect=no_effect,
        )
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
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中はモザイク候補をクリアできません。", "operation_in_progress")
                mask_paths = [
                    candidate.mask_path
                    for record in records
                    for candidate in self.candidates.get(record.image_id, [])
                ]
                revisions = {record.image_id: self._candidate_revision(record.image_id) + 1 for record in records}
                self.workspace_store.clear_image_workspaces(revisions)
                for record in records:
                    self.candidates[record.image_id] = []
                    self._touch_candidates(record.image_id)
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
        source_identity: str | None = None,
        source_kind: str = "browser-files",
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(files, list) or not files:
            raise ClientError("追加する画像がありません。", "image_not_found")

        with self.lock:
            root = self.root
            catalog_generation = self.catalog_generation
            if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は画像を追加できません。", "operation_in_progress")
            destination_dir = self._ensure_session()
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
                if (
                    self.root != root
                    or self.catalog_generation != catalog_generation
                    or self.job.state in {"running", "pausing", "paused"}
                    or self._has_active_worker()
                ):
                    raise ClientError("画像一覧が更新されたため、画像の追加を中止しました。もう一度追加してください。", "catalog_changed")
                added: list[ImageRecord] = []
                final_paths: list[Path] = []
                try:
                    imported: list[dict[str, str]] = []
                    catalog_relative_paths = {
                        record.relative_path.casefold()
                        for record in self.images.values()
                        if record.source_kind != "session"
                    }
                    used_relative_paths = set(catalog_relative_paths)
                    for temporary, name, width, height, client_key, client_mtime_ns, client_size in pending:
                        relative = Path(name)
                        base_stem, suffix = relative.stem, relative.suffix
                        if relative.as_posix().casefold() in catalog_relative_paths:
                            index = 1
                            while relative.as_posix().casefold() in used_relative_paths or (destination_dir / relative).exists():
                                index += 1
                                relative = relative.with_name(f"{base_stem} ({index}){suffix}")
                            destination = destination_dir / relative
                        else:
                            # Keep the established _2 naming for collisions
                            # among session imports while reserving (2) for a
                            # collision with an existing catalogue image.
                            destination = unique_session_import_destination(destination_dir / relative)
                            relative = destination.relative_to(destination_dir)
                        used_relative_paths.add(relative.as_posix().casefold())
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(temporary, destination)
                        final_paths.append(destination)
                        stat = destination.stat()
                        if client_size and client_size != stat.st_size:
                            raise ClientError("画像のサイズが一致しません。", "image_read_failed")
                        added.append(ImageRecord(
                            image_id=uuid.uuid4().hex,
                            path=destination,
                            relative_path=destination.relative_to(destination_dir).as_posix(),
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
                            project_source_identity=f"browser:{source_identity or self.session_dir.name}",
                            project_source_display="ブラウザから追加",
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
                durable_source_id: str | None = None
                durable_source_created = False
                durable_created_ids: list[str] = []
                try:
                    if self.catalog_id:
                        browser_identity = source_identity or self.session_dir.name
                        try:
                            durable_source_id, durable_source_created = self.workspace_store.resolve_browser_source(
                                self.catalog_id,
                                kind=source_kind,
                                display_name="ブラウザから追加",
                                source_identity=browser_identity,
                                create=not self.project_read_only,
                            )
                        except ValueError as exc:
                            if self.project_read_only:
                                raise ClientError("完了したプロジェクトには新しい画像を追加できません。", "project_read_only") from exc
                            raise ClientError("選択した画像ソースをこのプロジェクトに復元できません。", "project_source_unavailable") from exc
                    stored_images: dict[str, dict[str, Any]] = {}
                    if self.catalog_id:
                        try:
                            stored_images = self.workspace_store.reconcile_images(
                                self.catalog_id,
                                added,
                                source_id=durable_source_id,
                                allow_new=not self.project_read_only,
                            )
                            durable_created_ids = [
                                str(stored["image_id"])
                                for stored in stored_images.values()
                                if stored["created"]
                            ]
                        except ValueError as exc:
                            if self.project_read_only:
                                raise ClientError("完了したプロジェクトには新しい画像を追加できません。", "project_read_only") from exc
                            raise ClientError("選択した画像ソースをこのプロジェクトに復元できません。", "project_source_unavailable") from exc
                    for index, record in enumerate(added):
                        if self.catalog_id:
                            stored = stored_images[record.relative_path]
                            record.image_id = str(stored["image_id"]); record.hidden = bool(stored["hidden"]); record.reviewed = bool(stored["reviewed"])
                            record.source_id = durable_source_id
                            if stored.get("changed"):
                                self.source_mismatches[record.image_id] = bool(stored.get("dimensions_changed"))
                            _revision, restored = self.workspace_store.hydrate_candidates(record.image_id, self.cache_dir / record.image_id, self._candidate_from_workspace)
                            if restored or _revision:
                                self.candidates[record.image_id] = restored
                                self.candidate_revisions[record.image_id] = _revision
                        imported[index]["imageId"] = record.image_id
                        self.images[record.image_id] = record
                        self.order.append(record.image_id)
                    self.order.sort(key=lambda image_id: self.images[image_id].relative_path.lower())
                    images = self.list_images() if include_images else []
                    return images, imported
                except Exception:
                    try:
                        if self.catalog_id and durable_source_id:
                            self.workspace_store.rollback_import(
                                self.catalog_id,
                                durable_source_id,
                                durable_created_ids,
                                delete_source=durable_source_created,
                            )
                    finally:
                        for destination in final_paths:
                            destination.unlink(missing_ok=True)
                        self.images = live_images
                        self.order = live_order
                        self.candidates = live_candidates
                        self.candidate_revisions = live_revisions
                        self.source_mismatches = live_mismatches
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
        source_identity: str | None = None,
        source_kind: str = "browser-files",
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
        }], include_images=include_images, transfer_active=transfer_active, source_identity=source_identity, source_kind=source_kind)

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
        return self.catalog_snapshot()["images"]

    def set_image_flags(self, image_id: str, payload: dict[str, Any]) -> dict[str, bool]:
        if not isinstance(payload, dict):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        hidden = payload.get("hidden")
        reviewed = payload.get("reviewed")
        if hidden is not None and not isinstance(hidden, bool) or reviewed is not None and not isinstance(reviewed, bool):
            raise ClientError("画像の状態が正しくありません。", "input_invalid")
        with self.lock:
            self._assert_catalog_mutable()
            record = self.images.get(image_id)
            if record is None:
                raise ClientError("画像が見つかりません。", "image_not_found")
            catalog_generation = self.catalog_generation
        if self.workspace_store.has_image(image_id):
            self.workspace_store.set_image_flags(image_id, hidden=hidden, reviewed=reviewed)
        with self.lock:
            if self.images.get(image_id) is not record or self.catalog_generation != catalog_generation:
                raise ClientError("画像一覧が更新されました。もう一度お試しください。", "operation_in_progress")
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
        with self.lock:
            self._assert_catalog_mutable()
            records = [self.images.get(image_id) for image_id in image_ids]
            if any(record is None for record in records):
                raise ClientError("画像が見つかりません。", "image_not_found")
            catalog_generation = self.catalog_generation
        if self.catalog_id is not None:
            self.workspace_store.set_image_flags_bulk(image_ids, hidden=hidden, reviewed=reviewed)
        with self.lock:
            if self.catalog_generation != catalog_generation or any(self.images.get(image_id) is not record for image_id, record in zip(image_ids, records)):
                raise ClientError("画像一覧が更新されました。もう一度お試しください。", "operation_in_progress")
            result: dict[str, dict[str, bool]] = {}
            for image_id, record in zip(image_ids, records):
                if hidden is not None: record.hidden = hidden
                if reviewed is not None: record.reviewed = reviewed
                result[image_id] = {"hidden": record.hidden, "reviewed": record.reviewed}
            return result

    @staticmethod
    def _decode_workspace_mask(value: Any) -> bytes | None:
        if value is None or value == "": return None
        if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
            raise ClientError("手描きマスクが正しくありません。", "input_invalid")
        try:
            raw = base64.b64decode(value.split(",", 1)[1], validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ClientError("手描きマスクが正しくありません。", "input_invalid") from exc
        if len(raw) > MAX_BODY_BYTES or not raw.startswith(PNG_SIGNATURE):
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
        return "" if not value else f"data:image/png;base64,{base64.b64encode(value).decode('ascii')}"

    def save_manual_workspace(self, image_id: str, payload: dict[str, Any]) -> None:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                committed = dict(payload)
                dirty_layers = committed.get("dirtyLayers")
                existing = self.workspace_store.manual(image_id, self._encode_workspace_mask) if self.workspace_store.has_image(image_id) else self.projectless_manual_drafts.get(image_id)
                if dirty_layers is not None:
                    existing = existing or {}
                    for layer in ("add", "exclusion", "exclusionErase"):
                        committed.setdefault(layer, existing.get(layer, ""))
                committed["hasEffectiveMask"] = self._effective_mask_for_draft(
                    image_id, self.candidates.get(image_id, []), committed,
                )
                if not self.workspace_store.has_image(image_id):
                    self.projectless_manual_drafts[image_id] = committed
                    return
                try:
                    # The manual row, its normalized removal IDs, exact candidate
                    # revision, and gallery scalar are one SQLite transaction.
                    self.workspace_store.save_manual(image_id, committed, self._decode_workspace_mask)
                except ValueError as exc:
                    raise ClientError("手描き状態を保存できません。", "workspace_write_failed") from exc

    def manual_workspace(self, image_id: str) -> dict[str, Any] | None:
        self.image_for_id(image_id)
        if not self.workspace_store.has_image(image_id): return self.projectless_manual_drafts.get(image_id)
        return self.workspace_store.manual(image_id, self._encode_workspace_mask)

    def project_history_status(self, image_id: str) -> dict[str, bool]:
        self.image_for_id(image_id)
        if not self.workspace_store.has_image(image_id):
            return {"canUndo": False, "canRedo": False}
        return self.workspace_store.history_status(image_id)

    def restore_project_history(self, image_id: str, direction: str) -> dict[str, Any]:
        self.image_for_id(image_id)
        with self.lock:
            self._assert_catalog_mutable()
        changed_ids = self.workspace_store.restore_history(image_id, direction)
        with self.lock:
            record_ids = [changed_id for changed_id in changed_ids if changed_id in self.images]
        locks = [(changed_id, self.image_io_lock(changed_id)) for changed_id in record_ids]
        with ExitStack() as stack:
            for _changed_id, image_lock in sorted(locks): stack.enter_context(image_lock)
            hydrated: dict[str, tuple[int, list[Candidate], bool, bool]] = {}
            for changed_id in record_ids:
                shutil.rmtree(self.cache_dir / changed_id, ignore_errors=True)
                revision, candidates = self.workspace_store.hydrate_candidates(
                    changed_id, self.cache_dir / changed_id, self._candidate_from_workspace,
                )
                hidden, reviewed = self.workspace_store.image_state(changed_id)
                hydrated[changed_id] = (revision, candidates, hidden, reviewed)
            with self.lock:
                for changed_id, (revision, candidates, hidden, reviewed) in hydrated.items():
                    record = self.images[changed_id]
                    record.hidden = hidden
                    record.reviewed = reviewed
                    self.candidates[changed_id] = candidates
                    self.candidate_revisions[changed_id] = revision
        current = {
            "candidateRevision": self._candidate_revision(image_id),
            "candidates": [candidate.as_api_dict() for candidate in self.candidates.get(image_id, [])],
            "manual": self.workspace_store.manual(image_id, self._encode_workspace_mask),
        }
        return {"changedImageIds": changed_ids, "current": current, **self.workspace_store.history_status(image_id)}

    def delete_manual_workspace(self, image_id: str) -> None:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                if self.workspace_store.has_image(image_id):
                    self.workspace_store.delete_manual([image_id])

    def catalog_snapshot(self) -> dict[str, Any]:
        """Capture the complete catalogue payload in one lock epoch."""
        with self.lock:
            manual_mask_statuses = self.workspace_store.manual_mask_statuses(list(self.order))
            output = []
            for image_id in self.order:
                record = self.images[image_id]
                candidate_revision = self._candidate_revision(image_id)
                stored_effective, stored_revision = manual_mask_statuses.get(image_id, (False, -1))
                has_effective_mask = stored_effective if stored_revision == candidate_revision else any(
                    candidate.enabled and candidate.role == CandidateRole.APPLY for candidate in self.candidates.get(image_id, [])
                )
                item = {
                    "id": record.image_id,
                    "relativePath": record.relative_path,
                    "sourceKind": record.source_kind,
                    "width": record.width,
                    "height": record.height,
                    "mtimeNs": record.mtime_ns,
                    "sizeBytes": record.size_bytes,
                    "assetVersion": self.asset_version(record),
                    "candidateCount": len(self.candidates.get(image_id, [])),
                    "enabledCandidateCount": sum(
                        candidate.enabled and candidate.role == CandidateRole.APPLY
                        for candidate in self.candidates.get(image_id, [])
                    ),
                    "hasEffectiveMask": has_effective_mask,
                    "candidateRevision": candidate_revision,
                    "hidden": record.hidden,
                    "reviewed": record.reviewed,
                    "sourceId": record.source_id,
                    "sourceMismatch": record.image_id in self.source_mismatches,
                    "sourceDimensionsChanged": bool(self.source_mismatches.get(record.image_id)),
                }
                if record.source_kind == "filesystem":
                    item["sourcePath"] = str(record.path)
                output.append(item)
            return {
                "root": str(self.root) if self.root else None,
                "images": output,
                "catalogGeneration": self.catalog_generation,
                "workspace": self.catalog_id is not None,
                "project": self.workspace_store.project(self.catalog_id) if self.catalog_id else None,
                "readOnly": self.project_read_only,
            }

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
        with Image.open(io.BytesIO(raw_mask)) as mask_image:
            alpha = mask_image.convert("L").point(lambda value: 255 if value else 0)
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
                    if isinstance(expand_px, bool) or not isinstance(expand_px, int) or not 0 <= expand_px <= max_expand_px:
                        raise ClientError(f"候補の枠pxは0から{max_expand_px}までの整数で指定してください。", "input_invalid")
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
            if (isinstance(expand_px, bool) or not isinstance(expand_px, int)
                    or not 0 <= expand_px <= max_expand_px):
                raise ClientError(f"候補の枠pxは0から{max_expand_px}までの整数で指定してください。", "input_invalid")
        with self.image_io_lock(image_id):
            with self.lock:
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
            for path in paths:
                path.unlink(missing_ok=True)
            return revision

    def batch_update_candidates_many(self, image_ids: list[str], payload: dict[str, Any]) -> dict[str, int]:
        unique = list(dict.fromkeys(str(image_id) for image_id in image_ids if str(image_id)))
        if not unique:
            raise ClientError("候補を更新する画像がありません。", "image_not_found")
        group_id = self.workspace_store.begin_history_group() if len(unique) > 1 else None
        try:
            result = {image_id: self.batch_update_candidates(image_id, payload, history_group=group_id) for image_id in unique}
        except Exception:
            if group_id: self.workspace_store.finish_history_group(group_id, failed=True)
            raise
        if group_id: self.workspace_store.finish_history_group(group_id)
        return result

    def delete_candidate(self, image_id: str, candidate_id: str) -> bool:
        self.image_for_id(image_id)
        self._assert_image_editable(image_id)
        with self.image_io_lock(image_id):
            with self.lock:
                if self._has_active_worker():
                    raise ClientError("バックグラウンド処理中は候補を変更できません。", "operation_in_progress")
                candidates = self.candidates.get(image_id, [])
                candidate = next((item for item in candidates if item.candidate_id == candidate_id), None)
                if candidate is None:
                    return False
                updated = [replace(item) for item in candidates if item.candidate_id != candidate_id]
                self._commit_candidate_snapshot(image_id, updated, replace=True)
            candidate.mask_path.unlink(missing_ok=True)
            return True
