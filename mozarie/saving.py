from __future__ import annotations

import tempfile
import time
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .core import (
    IO_CHUNK_BYTES, SAVE_TOKEN_TTL_SECONDS, BrowserSaveReceipt,
    BrowserSaveRender, CandidateRole, ClientError,
    ImageRecord, JobControl, safe_import_relative_path, _read_mosaic_divisor,
    _read_save_suffix,
)
from .config import SettingsError, validate_output_directory_ready
from .image_io import (
    _assert_source_stat_matches, _stage_record_replacement, _stage_save_with_mask, calculate_block_size, read_stable_source_bytes, render_with_mask, render_output, output_format_matches_source,
    decode_draft_masks, draft_manual_exclusion_forced, save_with_mask,
    unique_session_import_destination, write_rendered_copy,
)
from .masks import compose_masks, expand_mask, union_mask

_SAVE_RENDER_MEMORY_BUDGET = 512 * 1024 * 1024

class SavingMixin:
    def start_apply(
        self,
        image_ids: list[str],
        divisor: int,
        drafts: dict[str, dict[str, Any]],
        copy_to_default: bool = False,
        suffix: str = "_censored",
        output_format: str = "original",
        keep_metadata: bool = True,
    ) -> bool:
        if not image_ids:
            return False
        with self.lock:
            self._assert_catalog_mutable()
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        if not copy_to_default and any(record.source_kind != "filesystem" for record in records):
            raise ClientError("一時画像はコピー保存を選んでください。", "save_state_changed")
        if not isinstance(drafts, dict):
            raise ClientError("手描きマスクの形式が正しくありません。", "input_invalid")
        suffix = _read_save_suffix(suffix)
        if output_format not in {"original", "png", "jpg"} or not isinstance(keep_metadata, bool) or (output_format == "jpg" and keep_metadata):
            raise ClientError("保存形式が正しくありません。", "input_invalid")
        with self.lock:
            if self.catalog_generation != catalog_generation or any(self.images.get(record.image_id) is not record for record in records):
                raise ClientError("画像一覧が更新されたため、もう一度実行してください。", "save_state_changed")
            records = [replace(record) for record in records]
            output_directory = Path(self.settings["saving"]["default_output_directory"])
            saving_parallelism = int(self.settings.get("saving", {}).get("parallelism", 2))
        if copy_to_default:
            try:
                output_directory = validate_output_directory_ready(output_directory)
            except SettingsError as exc:
                raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable") from exc
        drafts = {str(image_id): (dict(draft) if isinstance(draft, dict) else draft) for image_id, draft in drafts.items()}
        self._start_job(
            "apply", records, self._apply_worker, divisor, drafts, copy_to_default, suffix,
            saving_parallelism, output_directory, output_format, keep_metadata,
            expected_catalog_generation=catalog_generation,
        )
        return True

    def _reserve_output_destination(self, record: ImageRecord, suffix: str, output_directory: Path) -> Path:
        """Reserve a copy name while another worker may be choosing one."""
        with self.output_destination_lock:
            relative = safe_import_relative_path(record.relative_path)
            target = (output_directory / relative).with_suffix(record.path.suffix)
            destination = unique_session_import_destination(
                target.with_name(f"{target.stem}{_read_save_suffix(suffix)}{target.suffix}"), self.reserved_output_paths,
            )
            self.reserved_output_paths.add(destination)
            return destination

    def _release_output_destination(self, destination: Path) -> None:
        with self.output_destination_lock:
            self.reserved_output_paths.discard(destination)

    def prepare_browser_save(
        self,
        image_ids: list[str],
        divisor: int,
        suffix: str,
        delete_original: bool,
    ) -> list[dict[str, Any]]:
        with self.lock:
            self._assert_catalog_mutable()
        records, _catalog_generation = self._records_for_ids_with_catalog(image_ids)
        _read_mosaic_divisor(divisor)
        _read_save_suffix(suffix)
        with self.lock:
            if any(self.images.get(record.image_id) is not record for record in records):
                raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
            return [
                {
                    "imageId": record.image_id,
                    "relativePath": record.relative_path,
                    "sourceKind": record.source_kind,
                    "candidateRevision": self._candidate_revision(record.image_id),
                    "sourceAction": "deleted" if delete_original and record.source_kind == "filesystem" else "keep",
                }
                for record in records
            ]

    def render_browser_save(
        self,
        image_id: str,
        revision: int,
        divisor: int,
        draft: Any,
        *,
        copy_to_default: bool = False,
        copy_to_browser: bool = False,
        suffix: str = "_censored",
        output_format: str = "original",
        keep_metadata: bool = True,
    ) -> BrowserSaveRender:
        self._assert_image_editable(image_id)
        record = self.image_snapshot(image_id)
        if draft is None:
            draft = self.workspace_store.manual(image_id, self._encode_workspace_mask)
        draft_masks = decode_draft_masks(draft, record.width, record.height)
        manual_exclude_forced = draft_manual_exclusion_forced(draft, self.settings["detection"].get("exclude_forced_default", True))
        removed_candidate_ids = {str(value) for value in draft.get("removedCandidateIds", [])} if isinstance(draft, dict) else set()
        divisor = _read_mosaic_divisor(divisor)
        if output_format not in {"original", "png", "jpg"} or not isinstance(keep_metadata, bool):
            raise ClientError("保存形式が正しくありません。", "input_invalid")
        if output_format == "jpg" and keep_metadata:
            raise ClientError("JPG形式ではメタ情報を保持できません。", "input_invalid")
        rendered_path: Path | None = None
        output_path: Path | None = None
        output_fingerprint: tuple[int, int] | None = None
        configured_output_directory: Path | None = None
        image_lock = self.image_io_lock(image_id)
        try:
            # The per-image lock comes first.  The state lock only captures an
            # immutable epoch; PNG decode, source reads and rendering do
            # not block requests for other images.
            with image_lock:
                with self.lock:
                    current_record = self.images.get(image_id)
                    if current_record is None or current_record.path != record.path:
                        raise ClientError("画像が見つかりません。フォルダを再読込してください。", "image_not_found")
                    record = replace(current_record)
                    if self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存できません。完了後にもう一度実行してください。", "operation_in_progress")
                    current_revision = self._candidate_revision(image_id)
                    if revision != current_revision:
                        raise ClientError("候補が変更されました。保存をやり直してください。", "save_state_changed")
                    catalog_generation = self.catalog_generation
                    # Disabled candidates have no effect on the rendered mask;
                    # do not decode their full-resolution PNGs for every
                    # browser-save request.
                    candidates = [
                        replace(candidate)
                        for candidate in self.candidates.get(image_id, [])
                        if candidate.enabled and candidate.candidate_id not in removed_candidate_ids
                    ]
                    if copy_to_default:
                        configured_output_directory = Path(self.settings["saving"]["default_output_directory"]).resolve()
                # A candidate can disappear between the metadata snapshot and the
                # disk read.  Do not compose a silently reduced mask.
                shape = (record.height, record.width)
                apply_union = np.zeros(shape, dtype=np.uint8)
                exclude_union = np.zeros(shape, dtype=np.uint8)
                forced_exclude_union = np.zeros(shape, dtype=np.uint8)
                has_apply = False
                has_exclude = False
                has_forced_exclude = False
                add_mask, exclusion_mask, exclusion_erase_mask = draft_masks
                for candidate in candidates:
                    try:
                        self.materialize_candidate_mask(candidate, image_id)
                        with Image.open(candidate.mask_path) as mask_image:
                            candidate_mask = expand_mask(np.asarray(mask_image.convert("L"), dtype=np.uint8), candidate.expand_px)
                    except FileNotFoundError as exc:
                        with self.lock:
                            if self.images.get(image_id) is not None:
                                self._commit_candidate_snapshot(
                                    image_id,
                                    [item for item in self.candidates.get(image_id, []) if item.candidate_id != candidate.candidate_id],
                                    replace=True,
                                )
                        raise ClientError("候補が変更されました。保存をやり直してください。", "save_state_changed") from exc
                    if candidate_mask.shape != shape:
                        raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                    if candidate.role == CandidateRole.APPLY:
                        union_mask(apply_union, candidate_mask)
                        has_apply = True
                    else:
                        union_mask(exclude_union, candidate_mask)
                        has_exclude = True
                        if candidate.forced:
                            union_mask(forced_exclude_union, candidate_mask)
                            has_forced_exclude = True
                mask = compose_masks(
                    shape, [apply_union] if has_apply else [], [exclude_union] if has_exclude else [], add_mask, exclusion_mask,
                    [forced_exclude_union] if has_forced_exclude else [], manual_exclude_forced, exclusion_erase_mask,
                )
                no_effect = (mask is None or not np.any(mask)) and output_format_matches_source(record, output_format) and keep_metadata and \
                    record.flip_horizontal == record.source_flip_horizontal and record.flip_vertical == record.source_flip_vertical
                source_fingerprint = record.asset_fingerprint()
                # Saving every listed image means an image without a mosaic is
                # copied as-is.  An overwrite deliberately becomes a commit
                # with ``keep`` instead of touching its source file.
                if no_effect:
                    output = read_stable_source_bytes(record, source_fingerprint); output_suffix = record.path.suffix.lower()
                    _output_mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(output_suffix, "application/octet-stream")
                else:
                    output, output_suffix, _output_mime = render_output(record, mask, calculate_block_size(record.width, record.height, divisor), output_format, keep_metadata)
                if copy_to_default:
                    if not configured_output_directory.is_dir():
                        raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable")
                    target_record = replace(record, path=record.path.with_suffix(output_suffix))
                    output_path = self._reserve_output_destination(target_record, _read_save_suffix(suffix), configured_output_directory)
                    try:
                        write_rendered_copy(output_path, output)
                        output_stat = output_path.stat()
                        output_fingerprint = (output_stat.st_mtime_ns, output_stat.st_size)
                    except OSError as exc:
                        raise ClientError("保存先フォルダへ保存できませんでした。設定で変更してください。", "save_write_failed") from exc
                    finally:
                        self._release_output_destination(output_path)
                elif not copy_to_browser and not no_effect:
                    # Browser copies stream the render straight to the chosen
                    # File System Access destination.  Keeping a second cache
                    # file until the browser acknowledges the commit made large
                    # batches both memory- and disk-bound for no benefit.  An
                    # overwrite still needs this staged replacement.
                    rendered_dir = self.cache_dir / "browser-save"
                    rendered_dir.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(dir=rendered_dir, suffix=output_suffix, delete=False) as handle:
                        rendered_path = Path(handle.name)
                        handle.write(output)
                        handle.flush()

                with self.lock:
                    _assert_source_stat_matches(record, source_fingerprint)
                    if (
                        self.images.get(image_id) is None
                        or self.catalog_generation != catalog_generation
                        or (configured_output_directory is not None
                            and Path(self.settings["saving"]["default_output_directory"]).resolve() != configured_output_directory)
                    ):
                        raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
                    if self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存できません。完了後にもう一度実行してください。", "operation_in_progress")
                    save_token = self._issue_browser_save_token_unchecked(
                        record, current_revision, source_fingerprint, catalog_generation, rendered_path, output_path, output_fingerprint,
                        allow_copy_action=copy_to_browser or no_effect,
                        no_effect=no_effect,
                        output_format=output_format, keep_metadata=keep_metadata,
                    )
                    rendered_path = None
            return BrowserSaveRender(output, record, current_revision, save_token, output_path, no_effect, output_format, _output_mime, output_suffix)
        finally:
            if rendered_path is not None:
                rendered_path.unlink(missing_ok=True)
            if output_path is not None and 'save_token' not in locals():
                output_path.unlink(missing_ok=True)

    def commit_browser_save(self, image_id: str, revision: int, save_token: str, source_action: str, *, source_mtime_ns: int | None = None, source_size_bytes: int | None = None) -> dict[str, Any]:
        self._assert_image_editable(image_id)
        if not isinstance(save_token, str) or not save_token:
            raise ClientError("保存確認トークンがありません。保存をやり直してください。", "save_state_changed")
        if source_action not in {"keep", "overwrite", "deleted"}:
            raise ClientError("元画像の処理は keep、overwrite、deleted のいずれかで指定してください。", "input_invalid")
        if (source_mtime_ns is None) != (source_size_bytes is None) or (source_mtime_ns is not None and (source_mtime_ns < 0 or source_size_bytes < 0)):
            raise ClientError("保存後の元画像情報が正しくありません。", "input_invalid")
        rendered_path: Path | None = None
        cleanup_paths: list[tuple[Path, tuple[int, int] | None]] = []
        mask_paths: list[Path] = []
        candidate_dirs: list[Path] = []
        thumbnail_paths: list[Path] = []
        source_stage = None
        quarantine_path: Path | None = None
        expired_token = False

        def token_allows_action(details: BrowserSaveToken) -> bool:
            if details.no_effect:
                return source_action in {"keep", "deleted"}
            # A copy token is issued only after the server has written the copy;
            # it may keep or remove the source. A streamed render token owns a
            # temporary replacement and may only overwrite the source.
            return source_action in ({"keep", "deleted"} if details.rendered_path is None or details.allow_copy_action else {"overwrite"})

        with self.import_lock, ExitStack() as exit_stack:
            with self.lock:
                receipt = self.browser_save_receipts.get(save_token)
                if receipt is not None:
                    if receipt.image_id != image_id or receipt.candidate_revision != revision or receipt.source_action != source_action:
                        raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                    return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted}
                token_details = self.browser_save_tokens.get(save_token)
                if token_details is None:
                    raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。", "save_state_changed")
                if token_details.image_id != image_id or token_details.candidate_revision != revision:
                    raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                if not token_allows_action(token_details):
                    raise ClientError("保存確認トークンと元画像の処理が一致しません。保存をやり直してください。", "save_state_changed")
            image_lock = self.image_io_lock(image_id)
            with image_lock:
                with self.lock:
                    receipt = self.browser_save_receipts.get(save_token)
                    if receipt is not None:
                        if receipt.image_id != image_id or receipt.candidate_revision != revision or receipt.source_action != source_action:
                            raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                        return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted}
                    token_details = self.browser_save_tokens.get(save_token)
                    record = self.images.get(image_id)
                    if token_details is None:
                        raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。", "save_state_changed")
                    if token_details.image_id != image_id or token_details.candidate_revision != revision:
                        raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                    if (record is None or token_details.transform_revision != record.transform_revision
                            or token_details.flip_horizontal != record.flip_horizontal or token_details.flip_vertical != record.flip_vertical
                            or token_details.source_flip_horizontal != record.source_flip_horizontal or token_details.source_flip_vertical != record.source_flip_vertical):
                        raise ClientError("反転状態が変更されました。保存をやり直してください。", "save_state_changed")
                    if source_action == "overwrite" and not output_format_matches_source(record, token_details.output_format):
                        raise ClientError("形式変換はコピー保存で行ってください。", "input_invalid")
                    if not token_allows_action(token_details):
                        raise ClientError("保存確認トークンと元画像の処理が一致しません。保存をやり直してください。", "save_state_changed")
                    if token_details.issued_at < time.monotonic() - SAVE_TOKEN_TTL_SECONDS:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                        expired_token = True
                    catalog_invalid = token_details.catalog_generation != self.catalog_generation or record is None
                    if expired_token:
                        pass
                    elif catalog_invalid:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                    elif self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存を完了できません。完了後にもう一度実行してください。", "operation_in_progress")
                    else:
                        # The expiry poll runs without ``import_lock``. Claim
                        # first, then release in ExitStack's finally path so it
                        # cannot delete a copy during this commit.
                        self.browser_save_claims.add(save_token)
                        exit_stack.callback(self._release_browser_save_claim, save_token)
                        record_snapshot = replace(record)
                        catalog_generation = self.catalog_generation
                        # The per-image lock keeps this render alive through
                        # source I/O; retain its token until the DB commit so a
                        # failed commit can be retried safely.

                if expired_token:
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。", "save_state_changed")
                if catalog_invalid:
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")

                try:
                    if source_action == "overwrite":
                        assert token_details.rendered_path is not None
                        source_stage = _stage_record_replacement(record_snapshot, token_details.rendered_path, token_details.source_fingerprint)
                    else:
                        self._assert_record_stat_matches(record_snapshot)
                    if source_action == "deleted":
                        # Browser-imported files are removed through their File
                        # System Access handle before this commit.  The server
                        # owns deletion for filesystem catalogue records.
                        if record_snapshot.source_kind != "session" or record_snapshot.path.exists():
                            quarantine_path = record_snapshot.path.with_name(f".{record_snapshot.path.name}.mozarie-delete-{save_token}")
                            record_snapshot.path.replace(quarantine_path)
                except ClientError:
                    with self.lock:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    raise
                except OSError as exc:
                    raise ClientError("元画像を変更できませんでした。候補は保持しています。", "save_write_failed") from exc

                try:
                    with self.lock:
                        record = self.images.get(image_id)
                        if record is None or self.catalog_generation != catalog_generation:
                            raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
                        current_revision = self._candidate_revision(image_id)
                        deleted = source_action == "deleted"
                        # A save only writes an image. It must retain the
                        # candidate/manual workspace and both image flags.
                        cleared = revision == current_revision
                        persisted_mtime = record_snapshot.mtime_ns
                        persisted_size = record_snapshot.size_bytes
                        if source_action == "overwrite" and record_snapshot.source_kind == "session":
                            persisted_mtime = source_mtime_ns
                            persisted_size = source_size_bytes
                        self.workspace_store.commit_save(
                            image_id,
                            mtime_ns=persisted_mtime if source_action == "overwrite" else None,
                            size_bytes=persisted_size if source_action == "overwrite" else None,
                            clear_workspace=deleted,
                            delete_image=deleted,
                            source_flip_horizontal=record_snapshot.flip_horizontal if source_action == "overwrite" else None,
                            source_flip_vertical=record_snapshot.flip_vertical if source_action == "overwrite" else None,
                        )
                except Exception:
                    if source_stage is not None:
                        source_stage.rollback()
                    if quarantine_path is not None and quarantine_path.exists():
                        quarantine_path.replace(record_snapshot.path)
                    raise

                with self.lock:
                    record = self.images.get(image_id)
                    if record is None:
                        raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
                    if source_action == "overwrite":
                        record.source_flip_horizontal = record.flip_horizontal; record.source_flip_vertical = record.flip_vertical
                        record.transform_revision += 1
                        record.set_asset_fingerprint(*record_snapshot.asset_fingerprint())
                        if record.source_kind == "filesystem":
                            record.mtime_ns = record_snapshot.mtime_ns
                            record.size_bytes = record_snapshot.size_bytes
                        elif source_mtime_ns is not None and source_size_bytes is not None:
                            record.mtime_ns = source_mtime_ns
                            record.size_bytes = source_size_bytes
                        record.asset_revision = record_snapshot.asset_revision + 1
                    if deleted:
                        mask_paths = [candidate.mask_path for candidate in self.candidates.get(image_id, [])]
                        candidate_dirs = [self.cache_dir / image_id]
                        self.images.pop(image_id, None)
                        self.order = [current_id for current_id in self.order if current_id != image_id]
                        self.candidate_revisions.pop(image_id, None)
                        self.candidates.pop(image_id, None)
                        self.projectless_manual_drafts.pop(image_id, None)
                        self._image_io_locks.pop(image_id, None)
                    self.browser_save_tokens.pop(save_token, None)
                    self.browser_save_receipts[save_token] = BrowserSaveReceipt(image_id, revision, source_action, cleared, not cleared, deleted, time.monotonic())
                    rendered_path = token_details.rendered_path
                    if deleted:
                        self._discard_browser_save_tokens_for_image_unchecked(image_id)
                if source_action == "overwrite" or deleted:
                    thumbnail_paths = list((self.cache_dir / "thumbnails").glob(f"{image_id}-*.jpg"))
                if mask_paths:
                    self._delete_mask_files(mask_paths, candidate_dirs)
                if deleted:
                    self.cleanup_expired_browser_save_tokens()
                for thumbnail_path in thumbnail_paths:
                    thumbnail_path.unlink(missing_ok=True)
                if rendered_path is not None:
                    rendered_path.unlink(missing_ok=True)
                if source_stage is not None:
                    source_stage.finalize()
                if quarantine_path is not None:
                    quarantine_path.unlink(missing_ok=True)
                if source_action != "keep":
                    self.invalidate_sam_image(image_id)
                return {"cleared": cleared, "stale": not cleared, "deleted": deleted}

    def browser_save_status(self, image_id: str, revision: int, save_token: str, source_action: str) -> dict[str, Any]:
        """Report only the finite state of one opaque save token."""
        with self.lock:
            receipt = self.browser_save_receipts.get(save_token)
            if receipt is not None:
                if receipt.image_id == image_id and receipt.candidate_revision == revision and receipt.source_action == source_action:
                    return {"state": "committed", "cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted}
                return {"state": "unknown"}
            details = self.browser_save_tokens.get(save_token)
            if details is not None and details.image_id == image_id and details.candidate_revision == revision:
                return {"state": "pending"}
        return {"state": "unknown"}

    def cancel_browser_save(self, image_id: str, revision: int, save_token: str) -> dict[str, Any]:
        """Cancel a still-pending token and remove only its own new copy."""
        # Serialise claiming and cancellation with commit; once commit has
        # detached a token, cancellation must never remove its successful copy.
        with self.import_lock:
            with self.lock:
                details = self.browser_save_tokens.get(save_token)
                if details is None or details.image_id != image_id or details.candidate_revision != revision:
                    return {"state": "unknown"}
                self._discard_browser_save_token_unchecked(save_token)
                cleanup_paths = self._take_browser_save_cleanup_unchecked()
        self._unlink_browser_save_cleanup(cleanup_paths)
        return {"state": "pending"}


    def _apply_worker(
        self,
        records: list[ImageRecord],
        divisor: int,
        drafts_or_masks: dict[str, Any],
        copy_to_default: bool = False,
        suffix: str = "_censored",
        saving_parallelism: int = 1,
        output_directory: Path | None = None,
        output_format: str = "original",
        keep_metadata: bool = True,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            output_directory = output_directory or Path(self.settings["saving"]["default_output_directory"])

            def save_record(index: int, record: ImageRecord) -> None:
                with self.image_io_lock(record.image_id):
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    draft_or_mask = drafts_or_masks.get(record.image_id)
                    try:
                        if isinstance(draft_or_mask, np.ndarray):
                            mask = draft_or_mask
                        else:
                            if draft_or_mask is None:
                                draft_or_mask = self.workspace_store.manual(record.image_id, self._encode_workspace_mask)
                            draft_masks = decode_draft_masks(draft_or_mask, record.width, record.height)
                            manual_exclude_forced = draft_manual_exclusion_forced(
                                draft_or_mask, self.settings["detection"].get("exclude_forced_default", True),
                            )
                            removed_candidate_ids = {str(value) for value in draft_or_mask.get("removedCandidateIds", [])} if isinstance(draft_or_mask, dict) else set()
                            mask = self.combined_candidate_mask(
                                record.image_id, draft_masks,
                                manual_exclude_forced=manual_exclude_forced,
                                removed_candidate_ids=removed_candidate_ids,
                            )
                    except Exception:
                        raise
                    no_effect = (mask is None or not np.any(mask)) and output_format_matches_source(record, output_format) and keep_metadata and \
                        record.flip_horizontal == record.source_flip_horizontal and record.flip_vertical == record.source_flip_vertical
                    source_fingerprint = record.asset_fingerprint()
                    source_stage = None
                    if not output_format_matches_source(record, output_format) and not copy_to_default:
                        raise ClientError("形式変換はコピー保存で行ってください。", "input_invalid")
                    if no_effect:
                        output = read_stable_source_bytes(record, source_fingerprint); output_suffix = record.path.suffix.lower()
                    else:
                        output, output_suffix, _mime = render_output(record, mask, calculate_block_size(record.width, record.height, divisor), output_format, keep_metadata)
                    target_record = replace(record, path=record.path.with_suffix(output_suffix))
                    output_path = self._reserve_output_destination(target_record, suffix, output_directory) if copy_to_default else record.path
                    if copy_to_default:
                        try:
                            write_rendered_copy(output_path, output)
                        finally:
                            self._release_output_destination(output_path)
                    else:
                        if not no_effect:
                            rendered_dir = self.cache_dir / "apply-render"; rendered_dir.mkdir(parents=True, exist_ok=True)
                            with tempfile.NamedTemporaryFile(dir=rendered_dir, suffix=output_suffix, delete=False) as handle:
                                stage_path = Path(handle.name); handle.write(output); handle.flush()
                            try:
                                source_stage = _stage_record_replacement(record, stage_path, source_fingerprint)
                            finally:
                                stage_path.unlink(missing_ok=True)
                            output_stat = record.path.stat()
                    # Files are fully written before the state mutation. Saving
                    # never clears candidates or manual workspace.
                    try:
                        if no_effect:
                            _assert_source_stat_matches(record, source_fingerprint)
                        with self.lock:
                            if not self._job_is_current(job_generation, catalog_generation):
                                if source_stage is not None:
                                    source_stage.rollback()
                                return
                            self.workspace_store.commit_save(
                                record.image_id,
                                mtime_ns=None if copy_to_default or no_effect else output_stat.st_mtime_ns,
                                size_bytes=None if copy_to_default or no_effect else output_stat.st_size,
                                clear_workspace=False,
                                source_flip_horizontal=record.flip_horizontal if not copy_to_default and not no_effect else None,
                                source_flip_vertical=record.flip_vertical if not copy_to_default and not no_effect else None,
                            )
                            if not copy_to_default and not no_effect:
                                live_record = self.images[record.image_id]
                                live_record.mtime_ns = output_stat.st_mtime_ns
                                live_record.size_bytes = output_stat.st_size
                                live_record.set_asset_fingerprint(*record.asset_fingerprint())
                                live_record.asset_revision += 1
                                live_record.source_flip_horizontal = live_record.flip_horizontal
                                live_record.source_flip_vertical = live_record.flip_vertical
                                live_record.transform_revision += 1
                            self._record_job_success(index, record.image_id, str(output_path), job_generation, catalog_generation)
                    except Exception:
                        if source_stage is not None:
                            source_stage.rollback()
                        # A copy is not committed until its workspace update
                        # succeeds.  Remove it so retry keeps the same name.
                        if copy_to_default:
                            output_path.unlink(missing_ok=True)
                        raise
                    if source_stage is not None:
                        source_stage.finalize()
                        for thumbnail_path in (self.cache_dir / "thumbnails").glob(f"{record.image_id}-*.jpg"):
                            thumbnail_path.unlink(missing_ok=True)
                    if not no_effect:
                        self.invalidate_sam_image(record.image_id)
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)

            # Rendering holds decoded pixels, a mask and an encoder buffer at
            # once.  Bound workers by the largest image instead of letting
            # eight 4K encodes reserve roughly a gigabyte at the same time.
            largest_render_bytes = max((record.width * record.height * 32 for record in records), default=1)
            memory_workers = max(1, _SAVE_RENDER_MEMORY_BUDGET // largest_render_bytes)
            worker_count = min(8, max(1, saving_parallelism), memory_workers)
            failures = self._run_fixed_workers(
                records, worker_count, save_record,
                control, job_generation, catalog_generation,
            )
            if failures:
                self._fail_job(failures[0][1], job_generation, catalog_generation)
            elif control is not None and control.cancel_requested.is_set():
                self._cancel_job(job_generation, catalog_generation)
            else:
                self._finish_job(job_generation, catalog_generation)
        except Exception as exc:
            self._fail_job(exc, job_generation, catalog_generation)
