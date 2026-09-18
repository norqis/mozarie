from __future__ import annotations

import os
import sqlite3
import tempfile
import time
import uuid
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .core import (
    IO_CHUNK_BYTES, BrowserSaveReceipt, BrowserSaveToken,
    BrowserSaveRender, CandidateRole, ClientError,
    ImageRecord, JobControl, LOGGER, output_relative_path, _read_mosaic_divisor,
    _read_save_suffix,
)
from .config import SettingsError, validate_output_directory_ready
from .image_io import (
    _assert_source_stat_matches, _stage_record_replacement, _stage_record_format_replacement, _stage_save_with_mask, calculate_block_size, mask_alpha_or_luma, open_image, read_stable_source_bytes, render_with_mask, render_output, output_format_matches_source,
    decode_draft_masks, draft_manual_exclusion_forced, save_with_mask,
    unique_session_import_destination, write_rendered_copy,
)
from .masks import compose_masks, expand_mask, union_mask

class SavingMixin:
    @staticmethod
    def _overwrite_destination(record: ImageRecord, output_format: str) -> Path:
        relative = output_relative_path(record)
        if output_format == "original" or output_format_matches_source(record, output_format):
            return record.path.with_name(relative.name)
        return record.path.with_name(relative.with_suffix(f".{output_format}").name)

    def _preserve_directory_structure(self) -> bool:
        value = self.settings["saving"].get("preserve_directory_structure", True)
        if not isinstance(value, bool):
            raise ClientError("保存設定が正しくありません。", "input_invalid")
        return value

    @staticmethod
    def _copy_relative_path(record: ImageRecord, suffix: str, output_format: str, preserve_directory_structure: bool) -> Path:
        """Build one final copy name from the immutable catalogue snapshot."""
        relative = output_relative_path(record)
        if not preserve_directory_structure:
            relative = Path(relative.name)
        target = relative if output_format == "original" else relative.with_suffix(f".{output_format}")
        return target.with_name(f"{target.stem}{_read_save_suffix(suffix)}{target.suffix}")

    def _copy_destinations_are_available(
        self, records: list[ImageRecord], suffix: str, output_format: str, output_directory: Path,
        preserve_directory_structure: bool,
    ) -> None:
        """Reject every flattened collision before a save job or stage exists."""
        if preserve_directory_structure:
            return
        names: set[str] = set()
        for record in records:
            relative = self._copy_relative_path(record, suffix, output_format, False)
            name = relative.as_posix().casefold()
            destination = output_directory / relative
            if name in names or destination.exists():
                raise ClientError("平坦化後の保存名が重複しています。フォルダー構成を保持するか、ファイル名を変更してください。", "output_name_conflict")
            names.add(name)

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
            preserve_directory_structure = self._preserve_directory_structure()
        if copy_to_default:
            self._copy_destinations_are_available(
                records, suffix, output_format, output_directory, preserve_directory_structure,
            )
            try:
                output_directory = validate_output_directory_ready(output_directory)
            except SettingsError as exc:
                raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable") from exc
        drafts = {str(image_id): (dict(draft) if isinstance(draft, dict) else draft) for image_id, draft in drafts.items()}
        self._start_job(
            "apply", records, self._apply_worker, divisor, drafts, copy_to_default, suffix,
            saving_parallelism, output_directory, output_format, keep_metadata, preserve_directory_structure,
            expected_catalog_generation=catalog_generation,
        )
        return True

    def _reserve_output_destination(
        self, record: ImageRecord, suffix: str, output_directory: Path, output_format: str = "original",
        preserve_directory_structure: bool = True,
    ) -> Path:
        """Reserve a copy name while another worker may be choosing one."""
        with self.output_destination_lock:
            target = output_directory / self._copy_relative_path(
                record, suffix, output_format, preserve_directory_structure,
            )
            if not preserve_directory_structure:
                if target.exists() or target in self.reserved_output_paths:
                    raise ClientError("平坦化後の保存名が重複しています。フォルダー構成を保持するか、ファイル名を変更してください。", "output_name_conflict")
                self.reserved_output_paths.add(target)
                return target
            destination = unique_session_import_destination(
                target, self.reserved_output_paths,
            )
            self.reserved_output_paths.add(destination)
            return destination

    def _release_output_destination(self, destination: Path) -> None:
        with self.output_destination_lock:
            self.reserved_output_paths.discard(destination)

    def _reassign_output_destination(self, destination: Path) -> Path:
        with self.output_destination_lock:
            self.reserved_output_paths.discard(destination)
            replacement = unique_session_import_destination(destination, self.reserved_output_paths)
            self.reserved_output_paths.add(replacement)
            return replacement

    def _file_identity(self, path: Path, stat: os.stat_result) -> str | None:
        return self.save_journal.file_identity(path, stat)

    def _publish_staged_copy(self, token: str, staged: Path, destination: Path,
                             staged_fingerprint: tuple[int, int]) -> tuple[str | None, tuple[int, int]] | None:
        """Publish one exclusive final and retain the identity of that exact file."""
        if os.name == "nt":
            identity = self.save_journal.publish_staged_windows(token, staged, destination)
            return (identity, staged_fingerprint) if identity is not None else None
        try:
            # O_EXCL maps to CREATE_NEW on filesystems without a link-based
            # no-clobber primitive.  Keep the descriptor's identity and final
            # fingerprint; the path is checked once after close below.
            with destination.open("xb") as target, staged.open("rb") as source:
                identity = self._file_identity(destination, os.fstat(target.fileno()))
                self.save_journal.placeholder(token, identity)
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
                stat = os.fstat(target.fileno())
            return identity, (stat.st_mtime_ns, stat.st_size)
        except FileExistsError:
            return None

    def reserve_browser_save(self, image_id: str, revision: int, client_save_token: str, *, copy_to_default: bool, suffix: str, output_format: str, keep_metadata: bool) -> dict[str, Any]:
        """Create the durable token before decoding masks or rendering pixels."""
        suffix = _read_save_suffix(suffix)
        if output_format not in {"original", "png", "jpg"} or not isinstance(keep_metadata, bool) or (output_format == "jpg" and keep_metadata):
            raise ClientError("保存形式が正しくありません。", "input_invalid")
        record = self.image_snapshot(image_id)
        with self.lock:
            self._assert_image_editable(image_id)
            current_revision = self._candidate_revision(image_id)
            if revision != current_revision:
                raise ClientError("候補が変更されました。保存をやり直してください。", "save_state_changed")
            existing = self.browser_save_tokens.get(client_save_token)
            if existing is not None:
                if existing.image_id != image_id or existing.candidate_revision != revision:
                    raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                return {"state": existing.state, "outputPath": str(existing.output_destination) if existing.output_destination else ""}
            durable = self.save_journal.row(client_save_token)
            receipt = self.workspace_store.browser_save_receipt(client_save_token)
            if receipt is not None:
                if receipt.get("imageId") != image_id or receipt.get("revision") != revision:
                    raise ClientError("保存確認トークンと保存対象が一致しません。保存をやり直してください。", "save_state_changed")
                return {"state": "committed", "outputPath": str(receipt.get("outputPath") or "")}
            if durable is not None:
                if durable["image_id"] != image_id or int(durable["revision"]) != revision:
                    raise ClientError("保存確認トークンと保存対象が一致しません。保存をやり直してください。", "save_state_changed")
                return {"state": str(durable["state"]), "outputPath": str(durable["destination"] or "")}
            catalog_generation = self.catalog_generation
            configured_output_directory = Path(self.settings["saving"]["default_output_directory"]).resolve() if copy_to_default else None
            preserve_directory_structure = self._preserve_directory_structure()
        destination = None; staged = None; initial_fingerprint = None
        if configured_output_directory is not None:
            self._copy_destinations_are_available(
                [record], suffix, output_format, configured_output_directory, preserve_directory_structure,
            )
            try:
                configured_output_directory = validate_output_directory_ready(configured_output_directory)
            except SettingsError as exc:
                raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable") from exc
            destination = self._reserve_output_destination(
                record, suffix, configured_output_directory, output_format, preserve_directory_structure,
            )
            staged = destination.parent / ".mozarie-staging" / f"{client_save_token}.stage"
            try:
                self.save_journal.reserve(client_save_token, image_id, revision, destination, staged)
            except (OSError, sqlite3.Error):
                self._release_output_destination(destination)
                raise
            try:
                staged.parent.mkdir(parents=True, exist_ok=True)
                with staged.open("xb") as handle:
                    handle.flush(); os.fsync(handle.fileno())
                stat = staged.stat(); initial_fingerprint = (stat.st_mtime_ns, stat.st_size)
            except OSError as exc:
                self.save_journal.phase(client_save_token, "cancelled")
                self._release_output_destination(destination)
                raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable") from exc
        else:
            self.save_journal.reserve(client_save_token, image_id, revision, None, None)
        with self.lock:
            if self.catalog_generation != catalog_generation or self.images.get(image_id) is None:
                self.save_journal.phase(client_save_token, "cancelled")
                if staged is not None: self._unlink_browser_save_cleanup([(staged, initial_fingerprint)])
                if destination is not None: self._release_output_destination(destination)
                raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
            self.browser_save_tokens[client_save_token] = BrowserSaveToken(
                image_id=image_id, candidate_revision=revision, source_fingerprint=record.asset_fingerprint(),
                catalog_generation=catalog_generation, issued_at=time.monotonic(), rendered_path=None,
                output_path=staged, output_fingerprint=initial_fingerprint, output_destination=destination,
                state="rendering", allow_copy_action=copy_to_default, output_format=output_format,
                keep_metadata=keep_metadata, preserve_directory_structure=preserve_directory_structure,
                transform_revision=record.transform_revision,
                flip_horizontal=record.flip_horizontal, flip_vertical=record.flip_vertical,
                source_flip_horizontal=record.source_flip_horizontal, source_flip_vertical=record.source_flip_vertical,
            )
        return {"state": "rendering", "outputPath": str(destination) if destination else ""}

    def _browser_response_directory(self) -> Path:
        rendered_dir = self.cache_dir / "browser-save"
        try:
            rendered_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ClientError(
                "保存用の一時ファイルを作成できませんでした。空き容量と書込権限を確認してください。",
                "save_write_failed",
            ) from exc
        return rendered_dir

    def _stage_browser_response_output(self, output: bytes, suffix: str) -> Path:
        """Stage rendered browser output and remove a partial file on failure."""
        staged_path: Path | None = None
        try:
            try:
                with tempfile.NamedTemporaryFile(
                    dir=self._browser_response_directory(), suffix=suffix, delete=False,
                ) as destination:
                    staged_path = Path(destination.name)
                    destination.write(output)
                    destination.flush()
            except OSError as exc:
                raise ClientError(
                    "保存用の一時ファイルへ書き込めませんでした。空き容量と書込権限を確認してください。",
                    "save_write_failed",
                ) from exc
            result = staged_path
            staged_path = None
            return result
        finally:
            if staged_path is not None:
                staged_path.unlink(missing_ok=True)

    def _stage_browser_response_source(
        self,
        record: ImageRecord,
        fingerprint: tuple[int, int],
        suffix: str,
    ) -> Path:
        """Copy one unchanged source to a response file without a bytes buffer."""
        rendered_dir = self._browser_response_directory()
        staged_path: Path | None = None
        try:
            try:
                with record.path.open("rb") as source:
                    before = os.fstat(source.fileno())
                    if (before.st_mtime_ns, before.st_size) != fingerprint:
                        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
                    try:
                        with tempfile.NamedTemporaryFile(dir=rendered_dir, suffix=suffix, delete=False) as destination:
                            staged_path = Path(destination.name)
                            while True:
                                try:
                                    chunk = source.read(IO_CHUNK_BYTES)
                                except OSError as exc:
                                    raise ClientError(
                                        "元画像を読み込めません。画像を再読み込みしてください。",
                                        "stale_asset",
                                    ) from exc
                                if not chunk:
                                    break
                                destination.write(chunk)
                            destination.flush()
                    except OSError as exc:
                        raise ClientError(
                            "保存用の一時ファイルへ書き込めませんでした。空き容量と書込権限を確認してください。",
                            "save_write_failed",
                        ) from exc
                    after = os.fstat(source.fileno())
                    if (after.st_mtime_ns, after.st_size) != fingerprint:
                        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
            except OSError as exc:
                raise ClientError(
                    "元画像を読み込めません。画像を再読み込みしてください。",
                    "stale_asset",
                ) from exc
            result = staged_path
            staged_path = None
            return result
        finally:
            if staged_path is not None:
                staged_path.unlink(missing_ok=True)

    def prepare_browser_save(
        self,
        image_ids: list[str],
        divisor: int,
        suffix: str,
        delete_original: bool,
        *,
        copy_to_default: bool = False,
        output_format: str = "original",
        keep_metadata: bool = True,
    ) -> list[dict[str, Any]]:
        with self.lock:
            self._assert_catalog_mutable()
        records, _catalog_generation = self._records_for_ids_with_catalog(image_ids)
        for record in records:
            self._assert_image_editable(record.image_id)
        _read_mosaic_divisor(divisor)
        suffix = _read_save_suffix(suffix)
        if output_format not in {"original", "png", "jpg"} or not isinstance(keep_metadata, bool) or (output_format == "jpg" and keep_metadata):
            raise ClientError("保存形式が正しくありません。", "input_invalid")
        with self.lock:
            if any(self.images.get(record.image_id) is not record for record in records):
                raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
            for record in records:
                self._assert_image_editable(record.image_id)
            if copy_to_default:
                output_directory = Path(self.settings["saving"]["default_output_directory"])
                self._copy_destinations_are_available(
                    records, suffix, output_format, output_directory,
                    self._preserve_directory_structure(),
                )
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
        client_save_token: str | None = None,
        suffix: str = "_censored",
        output_format: str = "original",
        keep_metadata: bool = True,
    ) -> BrowserSaveRender:
        self._assert_image_editable(image_id)
        record = self.image_snapshot(image_id)
        if draft is None:
            draft = self.workspace_store.manual(image_id, self._encode_workspace_mask)
        try:
            draft_masks = decode_draft_masks(draft, record.width, record.height)
        except (MemoryError, OSError) as exc:
            raise ClientError("保存用の手描きマスクを読み込めません。使用可能なメモリを確認してください。", "image_read_failed") from exc
        manual_exclude_forced = draft_manual_exclusion_forced(draft, self.settings["detection"].get("exclude_forced_default", True))
        removed_candidate_ids = {str(value) for value in draft.get("removedCandidateIds", [])} if isinstance(draft, dict) else set()
        divisor = _read_mosaic_divisor(divisor)
        if output_format not in {"original", "png", "jpg"} or not isinstance(keep_metadata, bool):
            raise ClientError("保存形式が正しくありません。", "input_invalid")
        if output_format == "jpg" and keep_metadata:
            raise ClientError("JPG形式ではメタ情報を保持できません。", "input_invalid")
        rendered_path: Path | None = None
        response_path: Path | None = None
        response_path_is_temporary = False
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
                    self._assert_image_editable(image_id)
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
                    if client_save_token is None:
                        raise ClientError("保存確認トークンがありません。保存をやり直してください。", "save_state_changed")
                    reserved = self.browser_save_tokens.get(client_save_token)
                    if reserved is None or reserved.image_id != image_id or reserved.candidate_revision != revision or reserved.state != "rendering":
                        raise ClientError("保存確認トークンが無効または取消済みです。保存をやり直してください。", "save_state_changed")
                    if copy_to_default:
                        configured_output_directory = Path(self.settings["saving"]["default_output_directory"]).resolve()
                        output_path = reserved.output_path
                        output_destination = reserved.output_destination
                        if output_path is None or output_destination is None:
                            raise ClientError("保存先の準備が見つかりません。保存をやり直してください。", "save_state_changed")
                # A candidate can disappear between the metadata snapshot and the
                # disk read.  Do not compose a silently reduced mask.
                shape = (record.height, record.width)
                apply_union: np.ndarray | None = None
                exclude_union: np.ndarray | None = None
                forced_exclude_union: np.ndarray | None = None
                add_mask, exclusion_mask, exclusion_erase_mask = draft_masks
                try:
                    for candidate in candidates:
                        try:
                            self.materialize_candidate_mask(candidate, image_id)
                            with open_image(candidate.mask_path) as mask_image:
                                candidate_mask = expand_mask(mask_alpha_or_luma(mask_image), candidate.expand_px)
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
                            apply_union = union_mask(apply_union, candidate_mask)
                        else:
                            exclude_union = union_mask(exclude_union, candidate_mask)
                            if candidate.forced:
                                forced_exclude_union = union_mask(forced_exclude_union, candidate_mask)
                    mask = compose_masks(
                        shape, [apply_union] if apply_union is not None else [], [exclude_union] if exclude_union is not None else [], add_mask, exclusion_mask,
                        [forced_exclude_union] if forced_exclude_union is not None else [], manual_exclude_forced, exclusion_erase_mask,
                    )
                    no_effect = (mask is None or not np.any(mask)) and record.edited_filename is None and output_format_matches_source(record, output_format) and keep_metadata and \
                        record.flip_horizontal == record.source_flip_horizontal and record.flip_vertical == record.source_flip_vertical
                    source_fingerprint = record.asset_fingerprint()
                    # Saving every listed image means an image without a mosaic is
                    # copied as-is.  An overwrite deliberately becomes a commit
                    # with ``keep`` instead of touching its source file.
                    if no_effect:
                        output = read_stable_source_bytes(record, source_fingerprint) if copy_to_default else None
                        output_suffix = record.path.suffix.lower()
                        _output_mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(output_suffix, "application/octet-stream")
                    else:
                        output, output_suffix, _output_mime = render_output(record, mask, calculate_block_size(record.width, record.height, divisor), output_format, keep_metadata)
                except (MemoryError, OSError) as exc:
                    raise ClientError("保存用の画像またはマスクを処理できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
                if copy_to_default:
                    if configured_output_directory is None or not configured_output_directory.is_dir() or output_path is None:
                        raise ClientError("保存先フォルダを使用できません。設定で変更してください。", "output_folder_unavailable")
                    try:
                        assert output is not None
                        write_rendered_copy(output_path, output)
                        output_stat = output_path.stat()
                        output_fingerprint = (output_stat.st_mtime_ns, output_stat.st_size)
                    except OSError as exc:
                        raise ClientError("保存先フォルダへ保存できませんでした。設定で変更してください。", "save_write_failed") from exc
                elif not no_effect:
                    # Stream rendered data from a file instead of retaining a
                    # second response-sized browser buffer.  Overwrites keep
                    # their staged file until commit; copy saves discard it as
                    # soon as the response finishes streaming.
                    assert output is not None
                    rendered_path = self._stage_browser_response_output(output, output_suffix)
                    response_path = rendered_path
                    response_path_is_temporary = copy_to_browser
                    output = None
                elif not copy_to_default:
                    # A no-effect response must still be a stable snapshot:
                    # the image lock ends before the HTTP handler streams it.
                    # Copy it in chunks, never through a response-sized bytes
                    # object, then let the handler own cleanup.
                    rendered_path = self._stage_browser_response_source(record, source_fingerprint, output_suffix)
                    response_path = rendered_path
                    response_path_is_temporary = True
                    output = None

                with self.lock:
                    self._assert_image_editable(image_id)
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
                        record, current_revision, source_fingerprint, catalog_generation,
                        None if response_path_is_temporary else rendered_path, output_path, output_fingerprint,
                        output_destination=output_destination if copy_to_default else None, client_token=client_save_token,
                        allow_copy_action=copy_to_browser or copy_to_default or no_effect,
                        no_effect=no_effect,
                        output_format=output_format, keep_metadata=keep_metadata,
                    )
                    # The token or the HTTP handler now owns the staged file.
                    rendered_path = None
            return BrowserSaveRender(
                output=output,
                record=record,
                candidate_revision=current_revision,
                save_token=save_token,
                output_path=output_destination if copy_to_default else output_path,
                no_effect=no_effect,
                output_format=output_format,
                mime_type=_output_mime,
                extension=output_suffix,
                response_path=response_path,
                response_path_is_temporary=response_path_is_temporary,
            )
        finally:
            if rendered_path is not None:
                rendered_path.unlink(missing_ok=True)
            if response_path_is_temporary and response_path is not None and 'save_token' not in locals():
                response_path.unlink(missing_ok=True)
            if output_path is not None and 'save_token' not in locals():
                self.save_journal.cleanup(client_save_token or "")

    def commit_browser_save(self, image_id: str, revision: int, save_token: str, source_action: str, *, source_mtime_ns: int | None = None, source_size_bytes: int | None = None) -> dict[str, Any]:
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
        quarantine_path: Path | None = None
        published_output: tuple[Path, tuple[int, int], str | None] | None = None
        source_delete_pending = False
        format_replaced = False
        source_stage: Any | None = None
        native_source_old_path: Path | None = None

        def token_allows_action(details: BrowserSaveToken) -> bool:
            if details.no_effect:
                return source_action in {"keep", "deleted"}
            # A copy token is issued only after the server has written the copy;
            # it may keep or remove the source. A streamed render token owns a
            # temporary replacement and may only overwrite the source.
            return source_action in ({"keep", "deleted"} if details.rendered_path is None or details.allow_copy_action else {"overwrite"})

        with self.import_lock, ExitStack() as exit_stack:
            durable_receipt = self.workspace_store.browser_save_receipt(save_token)
            if durable_receipt is not None:
                if (durable_receipt.get("imageId") != image_id or durable_receipt.get("revision") != revision):
                    raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                return {"cleared": bool(durable_receipt.get("cleared")), "stale": bool(durable_receipt.get("stale")),
                        "deleted": bool(durable_receipt.get("deleted")), "catalogGeneration": int(durable_receipt.get("catalogGeneration") or 0),
                        "outputPath": str(durable_receipt.get("outputPath") or ""),
                        "relativePath": durable_receipt.get("relativePath"), "editedFilename": durable_receipt.get("editedFilename"),
                        "sourceDeletePending": bool(durable_receipt.get("sourceDeletePending")),
                        "sourceAction": str(durable_receipt.get("sourceAction") or "keep")}
            with self.lock:
                receipt = self.browser_save_receipts.get(save_token)
                if receipt is not None:
                    if receipt.image_id != image_id or receipt.candidate_revision != revision:
                        raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                    return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted,
                            "catalogGeneration": receipt.catalog_generation, "sourceDeletePending": receipt.source_delete_pending,
                            "sourceAction": receipt.source_action, "relativePath": receipt.relative_path,
                            "editedFilename": receipt.edited_filename}
                self._assert_request_catalog_expectation()
                self._assert_image_editable(image_id)
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
                        if receipt.image_id != image_id or receipt.candidate_revision != revision:
                            raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。", "save_state_changed")
                        return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted,
                                "catalogGeneration": receipt.catalog_generation, "sourceDeletePending": receipt.source_delete_pending,
                                "sourceAction": receipt.source_action, "relativePath": receipt.relative_path,
                                "editedFilename": receipt.edited_filename}
                    self._assert_request_catalog_expectation()
                    self._assert_image_editable(image_id)
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
                    if not token_allows_action(token_details):
                        raise ClientError("保存確認トークンと元画像の処理が一致しません。保存をやり直してください。", "save_state_changed")
                    catalog_invalid = token_details.catalog_generation != self.catalog_generation or record is None
                    if catalog_invalid:
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
                        if record_snapshot.source_kind == "filesystem":
                            native_source_old_path = record_snapshot.path.resolve()
                        catalog_generation = self.catalog_generation
                        # The per-image lock keeps this render alive through
                        # source I/O; retain its token until the DB commit so a
                        # failed commit can be retried safely.

                if catalog_invalid:
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")

                try:
                    if token_details.output_path is not None and token_details.output_destination is not None:
                        staged_stat = token_details.output_path.stat()
                        if token_details.output_fingerprint is None or (staged_stat.st_mtime_ns, staged_stat.st_size) != token_details.output_fingerprint:
                            raise ClientError("保存先の準備が変更されました。保存をやり直してください。", "save_state_changed")
                        self.save_journal.phase(save_token, "publishing")
                        staged_fingerprint = (staged_stat.st_mtime_ns, staged_stat.st_size)
                        publication = self._publish_staged_copy(save_token, token_details.output_path, token_details.output_destination, staged_fingerprint)
                        if publication is None:
                            if not token_details.preserve_directory_structure:
                                raise ClientError("平坦化後の保存名が重複しています。フォルダー構成を保持するか、ファイル名を変更してください。", "output_name_conflict")
                            replacement = self._reassign_output_destination(token_details.output_destination)
                            token_details = replace(token_details, output_destination=replacement)
                            with self.lock:
                                self.browser_save_tokens[save_token] = token_details
                            self.save_journal.destination(save_token, replacement)
                            publication = self._publish_staged_copy(save_token, token_details.output_path, replacement, staged_fingerprint)
                            if publication is None:
                                raise ClientError("同名ファイルが追加されました。保存をやり直してください。", "save_state_changed")
                        identity, destination_fingerprint = publication
                        try:
                            current_identity = self._file_identity(token_details.output_destination, token_details.output_destination.stat())
                        except OSError as exc:
                            raise ClientError("保存先の出力が変更されました。保存をやり直してください。", "save_state_changed") from exc
                        if identity is None or current_identity != identity:
                            raise ClientError("保存先の出力が変更されました。保存をやり直してください。", "save_state_changed")
                        published_output = (token_details.output_destination, destination_fingerprint, identity)
                        self.save_journal.published(save_token, destination_fingerprint, identity)
                    if source_action == "overwrite":
                        assert token_details.rendered_path is not None
                        destination = self._overwrite_destination(record_snapshot, token_details.output_format)
                        destination_changed = os.path.normcase(str(destination)) != os.path.normcase(str(record_snapshot.path))
                        if destination_changed or not output_format_matches_source(record_snapshot, token_details.output_format):
                            source_stage = _stage_record_format_replacement(
                                record_snapshot, token_details.rendered_path, token_details.source_fingerprint, destination,
                                lambda staged, final_path, staged_fingerprint:
                                    self._publish_staged_copy(save_token, staged, final_path, staged_fingerprint),
                                lambda final_path, fingerprint, identity: (
                                    self.save_journal.destination(save_token, final_path),
                                    self.save_journal.published(save_token, fingerprint, identity),
                                ),
                                lambda backup, backup_fingerprint, backup_identity, source_identity, replacement_fingerprint, replacement_identity:
                                    self.save_journal.replacement_backup(
                                        save_token, record_snapshot.path, backup, backup_fingerprint, backup_identity,
                                        source_identity, replacement_fingerprint, replacement_identity,
                                    ),
                            )
                            format_replaced = True
                        else:
                            source_stage = _stage_record_replacement(
                                record_snapshot, token_details.rendered_path, token_details.source_fingerprint,
                                lambda backup, backup_fingerprint, backup_identity, source_identity, replacement_fingerprint, replacement_identity:
                                    self.save_journal.replacement_backup(
                                        save_token, record_snapshot.path, backup, backup_fingerprint, backup_identity,
                                        source_identity, replacement_fingerprint, replacement_identity,
                                    ),
                            )
                            record_snapshot.relative_path = Path(record_snapshot.relative_path).with_name(destination.name).as_posix()
                    else:
                        self._assert_record_stat_matches(record_snapshot)
                    if source_action == "deleted":
                        # Browser-imported files are removed through their File
                        # System Access handle before this commit.  The server
                        # owns deletion for filesystem catalogue records.
                        if record_snapshot.source_kind != "session" or record_snapshot.path.exists():
                            quarantine_path = record_snapshot.path.with_name(f".{record_snapshot.path.name}.mozarie-delete-{save_token}")
                            self.save_journal.phase(save_token, "source_quarantined", quarantine_path)
                            if not self.save_journal.quarantine_source(save_token, record_snapshot.path, quarantine_path):
                                # The copy has already published.  Keep it and
                                # retain the original when this filesystem
                                # cannot prove an atomic recoverable deletion.
                                quarantine_path = None
                                source_action = "keep"
                                source_delete_pending = True
                                self.save_journal.clear_quarantine(save_token)
                except ClientError:
                    self.save_journal.phase(save_token, "cleanup_pending")
                    with self.lock:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    if published_output is not None:
                        self._unlink_browser_save_cleanup([published_output])
                    self.save_journal.cleanup(save_token)
                    raise
                except OSError as exc:
                    self.save_journal.phase(save_token, "cleanup_pending")
                    with self.lock:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    if published_output is not None:
                        self._unlink_browser_save_cleanup([published_output])
                    self.save_journal.cleanup(save_token)
                    raise ClientError("元画像を変更できませんでした。候補は保持しています。", "save_write_failed") from exc

                workspace_committed = False
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
                        if source_action == "deleted": self.save_journal.phase(save_token, "workspace_committing")
                        receipt_generation = catalog_generation + (1 if deleted else 0)
                        durable_save_receipt = {"token": save_token, "imageId": image_id, "revision": revision,
                                                "sourceAction": source_action, "cleared": cleared, "stale": not cleared,
                                                "deleted": deleted, "catalogGeneration": receipt_generation,
                                                "sourceDeletePending": source_delete_pending,
                                                "relativePath": record_snapshot.relative_path if source_action == "overwrite" else record.relative_path,
                                                "editedFilename": None if source_action == "overwrite" else record.edited_filename,
                                                "outputPath": str(token_details.output_destination) if token_details.output_destination is not None else ""}
                        alias_paths = self.workspace_store.commit_save(
                            image_id,
                            mtime_ns=persisted_mtime if source_action == "overwrite" else None,
                            size_bytes=persisted_size if source_action == "overwrite" else None,
                            relative_path=record_snapshot.relative_path if source_action == "overwrite" else None,
                            clear_edited_filename=source_action == "overwrite",
                            native_source_old_path=native_source_old_path if source_action == "overwrite" else None,
                            native_source_new_path=record_snapshot.path if native_source_old_path is not None and source_action == "overwrite" else None,
                            native_source_flip_horizontal=record_snapshot.flip_horizontal,
                            native_source_flip_vertical=record_snapshot.flip_vertical,
                            clear_workspace=deleted,
                            delete_image=deleted,
                            source_flip_horizontal=record_snapshot.flip_horizontal if source_action == "overwrite" else None,
                            source_flip_vertical=record_snapshot.flip_vertical if source_action == "overwrite" else None,
                            save_receipt=durable_save_receipt,
                        )
                        workspace_committed = True
                        # The receipt was inserted in the Workspace transaction.
                        # A journal write after this point is best effort only.
                        try:
                            self.save_journal.decide_commit(save_token)
                        except (OSError, sqlite3.Error) as exc:
                            LOGGER.warning("保存ジャーナルの確定記録を保留しました: %s", exc)
                except Exception:
                    if workspace_committed:
                        # The workspace receipt is the irreversible boundary.
                        # A journal outage must not restore the source or
                        # cancel an output that the workspace already recorded.
                        raise
                    if source_stage is not None:
                        source_stage.rollback()
                    self.save_journal.phase(save_token, "cleanup_pending")
                    with self.lock:
                        self._discard_browser_save_token_unchecked(save_token)
                        cleanup_paths = self._take_browser_save_cleanup_unchecked()
                    self._unlink_browser_save_cleanup(cleanup_paths)
                    if published_output is not None:
                        self._unlink_browser_save_cleanup([published_output])
                    self.save_journal.cleanup(save_token)
                    raise

                with self.lock:
                    record = self.images.get(image_id)
                    if record is None:
                        raise ClientError("画像一覧が変更されました。保存をやり直してください。", "save_state_changed")
                    if source_action == "overwrite":
                        for alias_id, relative_path in alias_paths.items():
                            live = self.images.get(alias_id)
                            if live is None:
                                continue
                            live.path = record_snapshot.path
                            live.relative_path = relative_path
                            live.set_asset_fingerprint(*record_snapshot.asset_fingerprint())
                            if live.source_kind == "filesystem":
                                live.mtime_ns = record_snapshot.mtime_ns; live.size_bytes = record_snapshot.size_bytes
                            if alias_id != image_id:
                                live.source_flip_horizontal = record_snapshot.flip_horizontal
                                live.source_flip_vertical = record_snapshot.flip_vertical
                                live.transform_revision += 1
                            live.asset_revision += 1
                        record.path = record_snapshot.path
                        record.relative_path = record_snapshot.relative_path
                        record.edited_filename = None
                        record.source_flip_horizontal = record.flip_horizontal; record.source_flip_vertical = record.flip_vertical
                        record.transform_revision += 1
                        record.set_asset_fingerprint(*record_snapshot.asset_fingerprint())
                        if record.source_kind == "filesystem":
                            record.mtime_ns = record_snapshot.mtime_ns
                            record.size_bytes = record_snapshot.size_bytes
                        elif source_mtime_ns is not None and source_size_bytes is not None:
                            record.mtime_ns = source_mtime_ns; record.size_bytes = source_size_bytes
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
                        self.catalog_generation += 1
                    self.browser_save_tokens.pop(save_token, None)
                    if token_details.output_destination is not None:
                        self._release_output_destination(token_details.output_destination)
                    response_generation = self.catalog_generation
                    self.browser_save_receipts[save_token] = BrowserSaveReceipt(image_id, revision, source_action, cleared, not cleared, deleted, response_generation, source_delete_pending, time.monotonic(), record.relative_path, record.edited_filename)
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
                try:
                    self.save_journal.finish(save_token, cleared, not cleared, deleted, response_generation)
                except (OSError, sqlite3.Error) as exc:
                    LOGGER.warning("保存ジャーナルの完了記録を保留しました: %s", exc)
                # Keep the receipt authoritative while journal-owned cleanup
                # removes only this token's quarantine and private stage.
                try:
                    self.save_journal.recover_token(save_token, lambda _token: durable_save_receipt)
                except (OSError, sqlite3.Error) as exc:
                    LOGGER.warning("保存ジャーナルの回復を保留しました: %s", exc)
                if source_action != "keep":
                    self.invalidate_sam_image(image_id)
                return {"cleared": cleared, "stale": not cleared, "deleted": deleted,
                        "catalogGeneration": response_generation,
                        "sourceAction": source_action,
                        "sourceDeletePending": source_delete_pending,
                        "relativePath": record.relative_path,
                        "editedFilename": record.edited_filename,
                        "outputPath": str(token_details.output_destination) if token_details.output_destination is not None else ""}

    def browser_save_status(self, image_id: str, revision: int, save_token: str, source_action: str) -> dict[str, Any]:
        """Report only the finite state of one opaque save token."""
        with self.lock:
            receipt = self.browser_save_receipts.get(save_token)
            if receipt is not None:
                if receipt.image_id == image_id and receipt.candidate_revision == revision:
                    return {"state": "committed", "cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted,
                            "catalogGeneration": receipt.catalog_generation, "sourceDeletePending": receipt.source_delete_pending,
                            "sourceAction": receipt.source_action, "relativePath": receipt.relative_path,
                            "editedFilename": receipt.edited_filename}
                return {"state": "unknown"}
            self._assert_request_catalog_expectation()
            details = self.browser_save_tokens.get(save_token)
            if details is not None and details.image_id == image_id and details.candidate_revision == revision:
                return {"state": details.state, "outputPath": str(details.output_destination) if details.output_destination is not None else "", "noEffect": details.no_effect}
        durable_receipt = self.workspace_store.browser_save_receipt(save_token)
        if (durable_receipt is not None and durable_receipt.get("imageId") == image_id
                and durable_receipt.get("revision") == revision):
            return {"state": "committed", "cleared": bool(durable_receipt.get("cleared")),
                    "stale": bool(durable_receipt.get("stale")), "deleted": bool(durable_receipt.get("deleted")),
                    "catalogGeneration": int(durable_receipt.get("catalogGeneration") or 0),
                    "outputPath": str(durable_receipt.get("outputPath") or ""),
                    "relativePath": durable_receipt.get("relativePath"), "editedFilename": durable_receipt.get("editedFilename"),
                    "sourceDeletePending": bool(durable_receipt.get("sourceDeletePending")),
                    "sourceAction": str(durable_receipt.get("sourceAction") or "keep")}
        journal = self.save_journal.row(save_token)
        if journal is not None and journal["image_id"] == image_id and int(journal["revision"]) == revision:
            if journal["state"] == "committed":
                return {"state": "committed", "cleared": bool(journal["cleared"]), "stale": bool(journal["stale"]),
                        "deleted": bool(journal["deleted"]), "catalogGeneration": int(journal["catalog_generation"] or 0)}
            return {"state": str(journal["state"]), "outputPath": str(journal["destination"] or "")}
        return {"state": "unknown"}

    def acknowledge_browser_save(self, save_token: str) -> dict[str, Any]:
        receipt = self.workspace_store.browser_save_receipt(save_token)
        if receipt is not None:
            try:
                if not self.save_journal.recover_token(save_token, lambda _token: receipt):
                    return {"acknowledged": False}
                if not self.save_journal.acknowledge(save_token):
                    return {"acknowledged": False}
            except (OSError, sqlite3.Error) as exc:
                LOGGER.warning("保存ジャーナルの確認応答を保留しました: %s", exc)
                return {"acknowledged": False}
            # A second acknowledgement after the journal deletion is safe:
            # the Workspace receipt remains the authority until this succeeds.
            deleted = self.workspace_store.acknowledge_browser_save_receipt(save_token)
            acknowledged = deleted or self.workspace_store.browser_save_receipt(save_token) is None
        else:
            # Both durable records absent is an idempotent successful ACK.  A
            # non-terminal journal row is not silently discarded.
            journal = self.save_journal.row(save_token)
            acknowledged = journal is None
        if acknowledged:
            with self.lock: self.browser_save_receipts.pop(save_token, None)
        return {"acknowledged": acknowledged}

    def cancel_browser_save(self, image_id: str, revision: int, save_token: str) -> dict[str, Any]:
        """Cancel a still-pending token and remove only its own new copy."""
        # Serialise claiming and cancellation with commit; once commit has
        # detached a token, cancellation must never remove its successful copy.
        with self.import_lock:
            receipt = self.workspace_store.browser_save_receipt(save_token)
            if receipt is not None:
                try:
                    self.save_journal.recover_token(save_token, lambda _token: receipt)
                except (OSError, sqlite3.Error) as exc:
                    LOGGER.warning("保存ジャーナルの回復を保留しました: %s", exc)
                return {"state": "committed"}
            with self.lock:
                self._assert_request_catalog_expectation()
                details = self.browser_save_tokens.get(save_token)
                if details is None or details.image_id != image_id or details.candidate_revision != revision:
                    journal = self.save_journal.row(save_token)
                    if journal is not None and journal.get("recovery_decision") == "commit":
                        return {"state": "committed"}
                    return {"state": str(journal["state"])} if journal is not None else {"state": "unknown"}
                self._discard_browser_save_token_unchecked(save_token)
                cleanup_paths = self._take_browser_save_cleanup_unchecked()
        self._unlink_browser_save_cleanup(cleanup_paths)
        cleaned = self.save_journal.cleanup(save_token)
        return {"state": "cancelled" if cleaned else "cleanup_pending"}


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
        preserve_directory_structure: bool = True,
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
                    no_effect = (mask is None or not np.any(mask)) and record.edited_filename is None and output_format_matches_source(record, output_format) and keep_metadata and \
                        record.flip_horizontal == record.source_flip_horizontal and record.flip_vertical == record.source_flip_vertical
                    source_fingerprint = record.asset_fingerprint()
                    save_token: str | None = None
                    durable_apply_receipt: dict[str, Any] | None = None
                    source_before: ImageRecord | None = None
                    format_replaced = False

                    def restore_source_record() -> None:
                        if source_before is None:
                            return
                        record.path = source_before.path
                        record.relative_path = source_before.relative_path
                        record.mtime_ns = source_before.mtime_ns
                        record.size_bytes = source_before.size_bytes
                        record.asset_mtime_ns = source_before.asset_mtime_ns
                        record.asset_size_bytes = source_before.asset_size_bytes
                        record.asset_revision = source_before.asset_revision

                    def rollback_apply_source() -> None:
                        assert save_token is not None
                        if source_before is None:
                            # Copy outputs have no source-side mutation to
                            # restore.  A foreign replacement may deliberately
                            # keep its journal row pending, but must not turn
                            # the original image into a recovery failure.
                            self.save_journal.cleanup(save_token)
                            return
                        if self.save_journal.cleanup(save_token):
                            restore_source_record()
                            return
                        try:
                            stat = record.path.stat()
                        except OSError:
                            stat = None
                        if stat is not None:
                            record.set_asset_fingerprint(stat.st_mtime_ns, stat.st_size)
                            if record.source_kind == "filesystem":
                                record.mtime_ns = stat.st_mtime_ns
                                record.size_bytes = stat.st_size
                        with self.lock:
                            live_record = self.images.get(record.image_id)
                            if stat is not None and live_record is not None and live_record is not record:
                                live_record.set_asset_fingerprint(stat.st_mtime_ns, stat.st_size)
                                if live_record.source_kind == "filesystem":
                                    live_record.mtime_ns = stat.st_mtime_ns
                                    live_record.size_bytes = stat.st_size
                            if live_record is not None:
                                self.source_mismatches[record.image_id] = False
                        raise ClientError(
                            "元画像の復元を保留しました。外部の変更を確認してMozarieを再起動してください。",
                            "save_recovery_pending",
                        )
                    if no_effect:
                        output = read_stable_source_bytes(record, source_fingerprint); output_suffix = record.path.suffix.lower()
                    else:
                        output, output_suffix, _mime = render_output(record, mask, calculate_block_size(record.width, record.height, divisor), output_format, keep_metadata)
                    output_path = (
                        self._reserve_output_destination(
                            record, suffix, output_directory, output_format, preserve_directory_structure,
                        ) if copy_to_default else record.path
                    )
                    if copy_to_default:
                        output_path.parent.mkdir(parents=True, exist_ok=True)
                    rendered_dir = (output_path.parent / ".mozarie-staging") if copy_to_default else (self.cache_dir / "apply-render")
                    rendered_dir.mkdir(parents=True, exist_ok=True)
                    stage_path: Path | None = None
                    try:
                        with tempfile.NamedTemporaryFile(dir=rendered_dir, suffix=output_suffix, delete=False) as handle:
                            stage_path = Path(handle.name); handle.write(output); handle.flush(); os.fsync(handle.fileno())
                    except OSError:
                        if stage_path is not None:
                            stage_path.unlink(missing_ok=True)
                            SaveJournal._cleanup_staging_parent(stage_path)
                        raise
                    assert stage_path is not None
                    save_token = f"apply-{uuid.uuid4().hex}"
                    stage_stat = stage_path.stat()
                    self.save_journal.reserve(save_token, record.image_id, record.asset_revision, output_path if copy_to_default else None, stage_path)
                    self.save_journal.update_stage(save_token, stage_path, (stage_stat.st_mtime_ns, stage_stat.st_size))
                    if copy_to_default:
                        try:
                            publication = self._publish_staged_copy(save_token, stage_path, output_path, (stage_stat.st_mtime_ns, stage_stat.st_size))
                            if publication is None:
                                if preserve_directory_structure:
                                    output_path = self._reassign_output_destination(output_path)
                                    self.save_journal.destination(save_token, output_path)
                                    publication = self._publish_staged_copy(save_token, stage_path, output_path, (stage_stat.st_mtime_ns, stage_stat.st_size))
                            if publication is None:
                                raise ClientError("同名ファイルが追加されました。保存をやり直してください。", "save_state_changed")
                            identity, destination_fingerprint = publication
                            if identity is None or self._file_identity(output_path, output_path.stat()) != identity:
                                raise ClientError("保存先の出力が変更されました。保存をやり直してください。", "save_state_changed")
                            self.save_journal.published(save_token, destination_fingerprint, identity)
                        except Exception:
                            rollback_apply_source()
                            self._release_output_destination(output_path)
                            raise
                        finally:
                            stage_path.unlink(missing_ok=True)
                    else:
                        if not no_effect:
                            source_before = replace(record)
                            try:
                                destination = self._overwrite_destination(record, output_format)
                                destination_changed = os.path.normcase(str(destination)) != os.path.normcase(str(record.path))
                                if not destination_changed and output_format_matches_source(record, output_format):
                                    _stage_record_replacement(
                                        record, stage_path, source_fingerprint,
                                        lambda backup, backup_fingerprint, backup_identity, source_identity, replacement_fingerprint, replacement_identity:
                                            self.save_journal.replacement_backup(
                                                save_token, record.path, backup, backup_fingerprint, backup_identity,
                                                source_identity, replacement_fingerprint, replacement_identity,
                                            ),
                                    )
                                    record.relative_path = Path(record.relative_path).with_name(destination.name).as_posix()
                                else:
                                    _stage_record_format_replacement(
                                        record, stage_path, source_fingerprint, destination,
                                        lambda staged, final_path, staged_fingerprint:
                                            self._publish_staged_copy(save_token, staged, final_path, staged_fingerprint),
                                        lambda final_path, fingerprint, identity: (
                                            self.save_journal.destination(save_token, final_path),
                                            self.save_journal.published(save_token, fingerprint, identity),
                                        ),
                                        lambda backup, backup_fingerprint, backup_identity, source_identity, replacement_fingerprint, replacement_identity:
                                            self.save_journal.replacement_backup(
                                                save_token, record.path, backup, backup_fingerprint, backup_identity,
                                                source_identity, replacement_fingerprint, replacement_identity,
                                            ),
                                    )
                                    format_replaced = True
                                    output_path = record.path
                            except Exception:
                                rollback_apply_source()
                                raise
                            finally:
                                stage_path.unlink(missing_ok=True)
                            output_stat = record.path.stat()
                        else:
                            stage_path.unlink(missing_ok=True)
                    # Files are fully written before the state mutation. Saving
                    # never clears candidates or manual workspace.
                    workspace_committed = False
                    try:
                        if no_effect:
                            _assert_source_stat_matches(record, source_fingerprint)
                        with self.lock:
                            if not self._job_is_current(job_generation, catalog_generation):
                                if save_token is not None:
                                    rollback_apply_source()
                                return
                            if save_token is not None:
                                durable_apply_receipt = {
                                    "token": save_token, "kind": "apply", "imageId": record.image_id,
                                    "revision": record.asset_revision, "sourceAction": "keep" if copy_to_default else "overwrite",
                                    "cleared": False, "stale": False, "deleted": False,
                                    "catalogGeneration": self.catalog_generation, "outputPath": str(output_path),
                                }
                            alias_paths = self.workspace_store.commit_save(
                                record.image_id,
                                mtime_ns=None if copy_to_default or no_effect else output_stat.st_mtime_ns,
                                size_bytes=None if copy_to_default or no_effect else output_stat.st_size,
                                relative_path=record.relative_path if not copy_to_default and not no_effect else None,
                                clear_edited_filename=not copy_to_default and not no_effect,
                                native_source_old_path=source_before.path if source_before is not None and source_before.source_kind == "filesystem" else None,
                                native_source_new_path=record.path if source_before is not None and source_before.source_kind == "filesystem" else None,
                                native_source_flip_horizontal=record.flip_horizontal,
                                native_source_flip_vertical=record.flip_vertical,
                                clear_workspace=False,
                                source_flip_horizontal=record.flip_horizontal if not copy_to_default and not no_effect else None,
                                source_flip_vertical=record.flip_vertical if not copy_to_default and not no_effect else None,
                                save_receipt=durable_apply_receipt,
                            )
                            workspace_committed = True
                            if not copy_to_default and not no_effect:
                                for alias_id, relative_path in alias_paths.items():
                                    if alias_id == record.image_id:
                                        continue
                                    alias = self.images.get(alias_id)
                                    if alias is None:
                                        continue
                                    alias.path = record.path; alias.relative_path = relative_path
                                    alias.set_asset_fingerprint(*record.asset_fingerprint())
                                    if alias.source_kind == "filesystem":
                                        alias.mtime_ns = output_stat.st_mtime_ns; alias.size_bytes = output_stat.st_size
                                    alias.source_flip_horizontal = record.flip_horizontal
                                    alias.source_flip_vertical = record.flip_vertical
                                    alias.transform_revision += 1
                                    alias.asset_revision += 1
                                live_record = self.images[record.image_id]
                                live_record.path = record.path
                                live_record.relative_path = record.relative_path
                                live_record.edited_filename = None
                                live_record.mtime_ns = output_stat.st_mtime_ns
                                live_record.size_bytes = output_stat.st_size
                                live_record.set_asset_fingerprint(*record.asset_fingerprint())
                                live_record.asset_revision += 1
                                live_record.source_flip_horizontal = live_record.flip_horizontal
                                live_record.source_flip_vertical = live_record.flip_vertical
                                live_record.transform_revision += 1
                            if save_token is not None:
                                try:
                                    self.save_journal.decide_commit(save_token)
                                except (OSError, sqlite3.Error) as exc:
                                    LOGGER.warning("保存ジャーナルの確定記録を保留しました: %s", exc)
                            self._record_job_success(index, record.image_id, str(output_path), job_generation, catalog_generation)
                    except Exception:
                        if save_token is not None and not workspace_committed:
                            rollback_apply_source()
                        if copy_to_default:
                            self._release_output_destination(output_path)
                        raise
                    if save_token is not None and durable_apply_receipt is not None:
                        try:
                            if self.save_journal.recover_token(save_token, lambda _token: durable_apply_receipt) and self.save_journal.acknowledge(save_token):
                                self.workspace_store.acknowledge_browser_save_receipt(save_token)
                        except (OSError, sqlite3.Error) as exc:
                            LOGGER.warning("保存ジャーナルの後処理を保留しました: %s", exc)
                        for thumbnail_path in (self.cache_dir / "thumbnails").glob(f"{record.image_id}-*.jpg"):
                            thumbnail_path.unlink(missing_ok=True)
                    if copy_to_default:
                        self._release_output_destination(output_path)
                    if not no_effect:
                        self.invalidate_sam_image(record.image_id)
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)

            requested_parallelism = max(1, int(saving_parallelism))
            worker_count = min(requested_parallelism, len(records))
            self._set_job_parallelism(worker_count, job_generation, catalog_generation)
            LOGGER.info("ファイル保存の並列数: 対象=%d件 要求並列=%d 実効並列=%d", len(records), requested_parallelism, worker_count)
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
