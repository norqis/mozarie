"""Atomic filename rotations for overlapping numbered overwrites."""
from __future__ import annotations

from contextlib import ExitStack
from dataclasses import replace
import json
import os
from pathlib import Path
import uuid
from typing import Any

from .core import ClientError, LOGGER
from .image_io import _assert_source_stat_matches
from .save_journal import SaveJournal


def conflicts_error(paths: list[Path]) -> ClientError:
    return ClientError("保存対象外の同名ファイルがあります。", "output_files_exist",
                       {"files": "\n".join(sorted({str(path) for path in paths}, key=str.casefold))})


def native_plan(state, records, destinations) -> bool:
    sources = {record.path.resolve(): record.image_id for record in records if record.source_kind == "filesystem"}
    if len(sources) != sum(record.source_kind == "filesystem" for record in records):
        raise ClientError("同じ元画像が複数の保存対象に含まれています。", "output_name_conflict")
    names: set[Path] = set()
    conflicts = []
    overlap = False
    for record, destination in zip(records, destinations):
        if record.source_kind != "filesystem":
            continue
        destination = destination.resolve()
        if destination in names:
            raise ClientError("保存名が重複しています。", "output_name_conflict")
        names.add(destination)
        if destination.exists() and destination not in sources:
            conflicts.append(destination)
        elif destination in sources and sources[destination] != record.image_id:
            overlap = True
    if conflicts:
        raise conflicts_error(conflicts)
    return overlap


def _move(source: Path, destination: Path, identity: str, fingerprint: tuple[int, int]) -> None:
    if os.name == "nt":
        if not SaveJournal.rename_windows_verified(source, destination, identity, fingerprint):
            raise OSError("numbered source could not be moved")
    else:
        stat = source.stat()
        if (stat.st_mtime_ns, stat.st_size) != fingerprint or SaveJournal.file_identity(source, stat) != identity:
            raise OSError("numbered source changed")
        os.link(source, destination)
        source.unlink()


def batch_rows(journal):
    with journal._lock, journal._connection() as db:
        batches = []
        for token, plan in db.execute("SELECT token,plan FROM numbered_batches"):
            try:
                batches.append((str(token), json.loads(plan)))
            except json.JSONDecodeError:
                LOGGER.warning("連番保存ジャーナルを読み込めません: %s", token)
        return batches


def store_batch(journal, token, plan):
    with journal._lock, journal._connection() as db:
        db.execute("INSERT INTO numbered_batches(token,plan) VALUES(?,?)", (token, json.dumps(plan)))


def recover_batch(state, token: str, members: list[dict[str, Any]]) -> bool:
    committed = state.workspace_store.browser_save_receipt(token) is not None
    natives = [member for member in members if "backup" in member]
    if not committed:
        # Remove every published slot before restoring any original: in a swap
        # one member's final path is another member's original path.
        for member in natives:
            row = state.save_journal.row(member["token"])
            if row and row["destination"]:
                if not SaveJournal._unlink(row["destination"], row["destination_mtime"], row["destination_size"],
                                           row["destination_identity"], require_identity=True):
                    return False
        with state.save_journal._lock, state.save_journal._connection() as db:
            db.executemany("UPDATE saves SET destination=NULL,destination_identity=NULL WHERE token=?",
                           [(member["token"],) for member in members])
        for member in natives:
            backup = Path(member["backup"])
            source = Path(member["source"])
            if backup.exists():
                try:
                    _move(backup, source, member["identity"], tuple(member["fingerprint"]))
                except OSError:
                    return False
            elif not source.exists() or SaveJournal.file_identity(source) != member["identity"]:
                return False
    else:
        for member in natives:
            if not SaveJournal._unlink(member["backup"], *member["fingerprint"], member["identity"], require_identity=True):
                return False
    with state.save_journal._lock, state.save_journal._connection() as db:
        if not committed:
            db.executemany("UPDATE saves SET destination=NULL,destination_identity=NULL WHERE token=?",
                           [(member["token"],) for member in members])
        db.execute("DELETE FROM numbered_batches WHERE token=?", (token,))
    return True


def recover_batches(state) -> None:
    for token, members in batch_rows(state.save_journal):
        if not recover_batch(state, token, members):
            LOGGER.warning("連番保存の復旧を保留しました: %s", token)


def commit_batch(state, entries: Any, *, prepare: bool = False) -> dict[str, Any]:
    if not isinstance(entries, list) or not entries or any(not isinstance(entry, dict) for entry in entries):
        raise ClientError("保存対象が正しくありません。", "input_invalid")
    ids = [str(entry.get("imageId", "")) for entry in entries]
    if len(set(ids)) != len(ids):
        raise ClientError("保存対象が重複しています。", "input_invalid")
    first = str(entries[0].get("saveToken", ""))
    with state.import_lock, ExitStack() as stack:
        for image_id in sorted(ids):
            stack.enter_context(state.image_io_lock(image_id))
        with state.lock:
            if state._has_active_worker():
                raise ClientError("処理が終了するまで保存できません。", "operation_in_progress")
            receipts = [state.workspace_store.browser_save_receipt(str(entry.get("saveToken", ""))) for entry in entries]
            if all(receipts):
                if any(receipt["imageId"] != image_id for receipt, image_id in zip(receipts, ids)):
                    raise ClientError("保存対象が変更されました。", "save_state_changed")
                return {"entries": receipts, "images": state.list_images()}
            records = []
            tokens = []
            for entry, image_id in zip(entries, ids):
                state._assert_image_editable(image_id)
                record = state.images.get(image_id)
                token = state.browser_save_tokens.get(str(entry.get("saveToken", "")))
                if (record is None or token is None or token.image_id != image_id or token.state != "pending"
                        or token.candidate_revision != entry.get("candidateRevision")
                        or token.catalog_generation != state.catalog_generation
                        or token.candidate_revision != state._candidate_revision(image_id)
                        or token.manual_revision != state.workspace_store.manual_revisions([image_id]).get(image_id, 0)
                        or token.transform_revision != record.transform_revision or not token.output_filename
                        or token.flip_horizontal != record.flip_horizontal or token.flip_vertical != record.flip_vertical
                        or token.source_flip_horizontal != record.source_flip_horizontal or token.source_flip_vertical != record.source_flip_vertical
                        or token.rendered_path is None or token.no_effect or token.output_destination is not None):
                    raise ClientError("保存対象が変更されました。", "save_state_changed")
                _assert_source_stat_matches(record, token.source_fingerprint)
                records.append(replace(record)); tokens.append(token)
            destinations = [state._overwrite_destination(replace(record, edited_filename=token.output_filename), token.output_format)
                            for record, token in zip(records, tokens)]
            native_plan(state, records, destinations)
            file_destinations = [destination if record.source_kind == "filesystem" else record.path
                                 for record, destination in zip(records, destinations)]
            if not prepare and state.numbered_save_batches.get(first) != tuple(entry["saveToken"] for entry in entries):
                raise ClientError("連番保存の準備がありません。", "save_state_changed")
            if not prepare:
                for entry, record in zip(entries, records):
                    if record.source_kind != "filesystem":
                        metadata = entry.get("sourceMetadata", {})
                        if (not isinstance(metadata.get("sourceMtimeMs"), int) or not isinstance(metadata.get("sourceSizeBytes"), int)):
                            raise ClientError("保存後の画像情報が正しくありません。", "input_invalid")
            for entry in entries:
                save_token = str(entry["saveToken"])
                state.browser_save_claims.add(save_token)
                if not prepare:
                    stack.callback(state._release_browser_save_claim, save_token)
            if prepare:
                state.numbered_save_batches[first] = tuple(entry["saveToken"] for entry in entries)
                return {"ready": True}
            stack.callback(state.numbered_save_batches.pop, first, None)
        members = []
        for entry, record, destination in zip(entries, records, file_destinations):
            member = {"token": entry["saveToken"], "imageId": record.image_id}
            member.update(source=str(record.path), destination=str(destination),
                          backup=str(record.path.with_name(f".{record.path.name}.mozarie-numbered-{uuid.uuid4().hex}")),
                          identity=SaveJournal.file_identity(record.path), fingerprint=record.asset_fingerprint())
            members.append(member)
        if any(not member["identity"] for member in members):
            raise ClientError("元画像への安全な書き込みを開始できません。", "source_write_unsupported")
        store_batch(state.save_journal, first, members)
        committed = False
        try:
            for member in members:
                if "backup" in member:
                    _move(Path(member["source"]), Path(member["backup"]), member["identity"], tuple(member["fingerprint"]))
            native_ids = {record.image_id for record in records if record.source_kind == "filesystem"}
            for member, token in zip(members, tokens):
                if "backup" not in member:
                    continue
                destination = Path(member["destination"])
                if member["imageId"] in native_ids:
                    try:
                        os.utime(token.rendered_path, ns=(member["fingerprint"][0], member["fingerprint"][0]))
                    except OSError:
                        LOGGER.warning("画像の更新日時を保持できません: %s", destination)
                stat = token.rendered_path.stat()
                state.save_journal.update_stage(member["token"], token.rendered_path, (stat.st_mtime_ns, stat.st_size))
                state.save_journal.destination(member["token"], destination)
                publication = state._publish_staged_copy(member["token"], token.rendered_path, destination, (stat.st_mtime_ns, stat.st_size))
                if publication is None:
                    raise conflicts_error([destination])
                identity, fingerprint = publication
                state.save_journal.published(member["token"], fingerprint, identity)
            updates = []
            for entry, record, token, destination in zip(entries, records, tokens, file_destinations):
                updated = replace(record)
                updated.path = destination
                stat = destination.stat()
                updated.set_asset_fingerprint(stat.st_mtime_ns, stat.st_size)
                if record.source_kind == "filesystem":
                    updated.mtime_ns = stat.st_mtime_ns; updated.size_bytes = stat.st_size
                else:
                    metadata = entry.get("sourceMetadata", {})
                    updated.mtime_ns = metadata["sourceMtimeMs"] * 1_000_000; updated.size_bytes = metadata["sourceSizeBytes"]
                updated.relative_path = Path(record.relative_path).with_name(token.output_filename).as_posix()
                updated.edited_filename = None
                receipt = {"token": entry["saveToken"], "imageId": record.image_id, "revision": token.candidate_revision,
                           "manualRevision": token.manual_revision, "transformRevision": token.transform_revision,
                           "sourceAction": "overwrite", "cleared": True, "stale": False, "deleted": False,
                           "catalogGeneration": state.catalog_generation, "relativePath": updated.relative_path,
                           "editedFilename": None, "sourceDeletePending": False, "outputPath": ""}
                updates.append((record, updated, receipt))
            with state.lock:
                state._assert_request_catalog_expectation()
                aliases = state.workspace_store.commit_numbered_saves(updates)
                committed = True
                # Publish the completed mapping together; never use a previously
                # updated path as the lookup for the next member of a cycle.
                for image_id, (relative, owner) in aliases.items():
                    live = state.images.get(image_id)
                    if live is None:
                        continue
                    live.path = owner.path; live.relative_path = relative
                    live.mtime_ns = owner.mtime_ns; live.size_bytes = owner.size_bytes
                    live.set_asset_fingerprint(*owner.asset_fingerprint())
                    live.source_flip_horizontal = owner.flip_horizontal; live.source_flip_vertical = owner.flip_vertical
                    live.transform_revision += 1; live.asset_revision += 1
                    if image_id in ids:
                        live.edited_filename = None
                for entry in entries:
                    state.browser_save_tokens.pop(entry["saveToken"], None)
            if not recover_batch(state, first, members):
                raise ClientError("連番保存の後処理を保留しました。", "save_recovery_pending")
            for member in members:
                state.save_journal.recover_token(member["token"], state.workspace_store.browser_save_receipt)
            return {"entries": [item[2] for item in updates], "images": state.list_images()}
        except BaseException:
            if not committed and not recover_batch(state, first, members):
                raise ClientError("元画像の復元を保留しました。", "save_recovery_pending")
            raise


def abort_batch(state, token: str) -> dict[str, bool]:
    with state.import_lock, state.lock:
        for pending, members in batch_rows(state.save_journal):
            if pending == token and not recover_batch(state, token, members):
                raise ClientError("元画像の復元を保留しました。", "save_recovery_pending")
        for member in state.numbered_save_batches.pop(token, ()):
            state.browser_save_claims.discard(member)
    return {"aborted": True}
