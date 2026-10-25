"""Real files and SQLite exercise numbered source rotations and rollback."""
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
import uuid
import base64
import json
import os
import subprocess

from PIL import Image

from mozarie.core import ClientError
from mozarie.numbered_batch import commit_batch, abort_batch, batch_rows, recover_batches
from tests import test_settings_import_regressions as import_fixture


class NumberedOverwriteBatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = import_fixture.SettingsImportRegressionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state = self.fixture.state
        (self.fixture.source / "source.png").unlink()
        for number, color in enumerate(["red", "green", "blue"], 1):
            with Image.new("RGB", (12, 8), color) as image:
                image.save(self.fixture.source / f"{number:02}.png")
        self.state.set_root(str(self.fixture.source))
        self.original = {image_id: record.path.read_bytes() for image_id, record in self.state.images.items()}
        self.paths = {image_id: record.path for image_id, record in self.state.images.items()}

    def render(self, ids):
        prepared = self.state.prepare_browser_save(ids, 100, "", False,
            numbering={"digits": 2, "placement": "only"})
        self.assertTrue(all(entry["batchOverwrite"] for entry in prepared))
        entries = []
        for entry in prepared:
            kwargs = dict(copy_to_default=False, suffix="", output_format="original", keep_metadata=True,
                          output_filename=entry["outputFilename"])
            token = str(uuid.uuid4())
            self.state.reserve_browser_save(entry["imageId"], entry["candidateRevision"], token, **kwargs)
            self.state.render_browser_save(entry["imageId"], entry["candidateRevision"], 100, None,
                stream_image=False, batch_overwrite=True, client_save_token=token, **kwargs)
            entries.append({**entry, "saveToken": token})
        commit_batch(self.state, entries, prepare=True)
        return entries

    def assert_originals(self):
        for image_id, path in self.paths.items():
            self.assertEqual(path.read_bytes(), self.original[image_id])
            self.assertEqual(self.state.images[image_id].path, path)
            self.assertEqual(self.state.workspace_store.image_relative_path(image_id), path.name)

    def test_two_cycle_with_unchanged_third_and_three_cycle_keep_identity_and_pixels(self):
        original_ids = list(self.state.order)
        for ids in [[original_ids[1], original_ids[0], original_ids[2]],
                    [original_ids[0], original_ids[2], original_ids[1]]]:
            with self.subTest(ids=ids):
                entries = self.render(ids)
                result = commit_batch(self.state, entries)
                self.assertEqual(len(result["entries"]), 3)
                for number, image_id in enumerate(ids, 1):
                    path = self.fixture.source / f"{number:02}.png"
                    self.assertEqual(path.read_bytes(), self.original[image_id])
                    self.assertEqual(self.state.images[image_id].path, path)
                    self.assertEqual(self.state.workspace_store.image_relative_path(image_id), path.name)
                self.assertFalse(batch_rows(self.state.save_journal))
                self.assertFalse(list(self.fixture.source.glob(".*mozarie-numbered-*")))

    def test_external_conflicts_are_all_reported_before_tokens_or_writes(self):
        before = {path.name: path.read_bytes() for path in self.fixture.source.iterdir()}
        with self.assertRaises(ClientError) as caught:
            self.state.prepare_browser_save([self.state.order[2]], 100, "", False,
                numbering={"digits": 2, "placement": "only"})
        self.assertEqual(caught.exception.error_code, "output_files_exist")
        self.assertIn("01.png", caught.exception.params["files"])
        self.assertFalse(self.state.browser_save_tokens)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.fixture.source.iterdir()})
        self.fixture.output.mkdir()
        for name in ["01.png", "03.png"]:
            (self.fixture.output / name).write_bytes(b"unrelated")
        status, response = self.fixture.request("/api/save/prepare", {
            "imageIds": self.state.order, "divisor": 100, "suffix": "", "copyToDefault": True,
            "numbering": {"digits": 2, "placement": "only"}})
        self.assertEqual(status, 400, response)
        self.assertEqual(response["error_code"], "output_files_exist")
        self.assertEqual(response["params"]["files"].splitlines(), [str(self.fixture.output / "01.png"), str(self.fixture.output / "03.png")])
        status, collected = self.fixture.request("/api/save/prepare", {
            "imageIds": self.state.order, "divisor": 100, "suffix": "", "copyToDefault": True,
            "numbering": {"digits": 2, "placement": "only"}, "collectConflicts": True})
        self.assertEqual(status, 200, collected)
        self.assertEqual(len(collected["entries"]), 3)
        self.assertEqual(collected["conflicts"], response["params"]["files"].splitlines())
        self.assertFalse(self.state.browser_save_tokens)

    def test_database_failure_rolls_back_complete_cycle_and_recovery_is_idempotent(self):
        entries = self.render(list(reversed(self.state.order)))
        with patch.object(self.state.workspace_store, "commit_numbered_saves", side_effect=sqlite3.OperationalError("test write failure")):
            with self.assertRaises(sqlite3.OperationalError):
                commit_batch(self.state, entries)
        self.assert_originals()
        recover_batches(self.state)
        self.assert_originals()
        self.assertFalse(batch_rows(self.state.save_journal))
        self.assertTrue(all(self.state.workspace_store.browser_save_receipt(entry["saveToken"]) is None for entry in entries))

    def test_second_publish_failure_restores_every_original(self):
        entries = self.render(list(reversed(self.state.order)))
        publish = self.state._publish_staged_copy
        count = 0
        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("test disk failure")
            return publish(*args)
        with patch.object(self.state, "_publish_staged_copy", side_effect=fail_second):
            with self.assertRaises(OSError):
                commit_batch(self.state, entries)
        self.assert_originals()
        self.assertFalse(batch_rows(self.state.save_journal))

    def test_abort_before_mutation_releases_all_tokens_without_touching_sources(self):
        entries = self.render(list(reversed(self.state.order)))
        abort_batch(self.state, entries[0]["saveToken"])
        for entry in entries:
            self.state.cancel_browser_save(entry["imageId"], entry["candidateRevision"], entry["saveToken"])
        self.assertFalse(self.state.browser_save_claims)
        self.assert_originals()

    def test_external_file_created_after_source_staging_is_preserved_for_recovery(self):
        entries = self.render(list(reversed(self.state.order)))
        publish = self.state._publish_staged_copy
        external = self.fixture.source / "01.png"
        def race(*args):
            external.write_bytes(b"external file created during save")
            return publish(*args)
        with patch.object(self.state, "_publish_staged_copy", side_effect=race):
            with self.assertRaises(ClientError) as error:
                commit_batch(self.state, entries)
        self.assertEqual(error.exception.error_code, "save_recovery_pending")
        self.assertEqual(external.read_bytes(), b"external file created during save")
        self.assertTrue(batch_rows(self.state.save_journal))
        self.state.save_journal.recover(self.state.workspace_store.browser_save_receipt)
        self.assertEqual(external.read_bytes(), b"external file created during save")
        external.unlink()
        recover_batches(self.state)
        self.assert_originals()

    def test_missing_file_identity_rejects_before_any_source_moves(self):
        entries = self.render(list(reversed(self.state.order)))
        with patch("mozarie.numbered_batch.SaveJournal.file_identity", return_value=None):
            with self.assertRaises(ClientError) as error:
                commit_batch(self.state, entries)
        self.assertEqual(error.exception.error_code, "source_write_unsupported")
        self.assert_originals()
        self.assertFalse(batch_rows(self.state.save_journal))

    def test_all_tokens_are_validated_before_source_mutation(self):
        entries = self.render(list(reversed(self.state.order)))
        entries[-1]["candidateRevision"] += 1
        with self.assertRaises(ClientError):
            commit_batch(self.state, entries)
        self.assert_originals()
        self.assertFalse(batch_rows(self.state.save_journal))

    def test_committed_cleanup_failure_retains_receipt_until_recovery(self):
        entries = self.render(list(reversed(self.state.order)))
        with patch("mozarie.numbered_batch.SaveJournal._unlink", return_value=False):
            with self.assertRaises(ClientError):
                commit_batch(self.state, entries)
            self.assertFalse(self.state.acknowledge_browser_save(entries[0]["saveToken"])["acknowledged"])
            self.assertIsNotNone(self.state.workspace_store.browser_save_receipt(entries[0]["saveToken"]))
        recover_batches(self.state)
        for number, entry in enumerate(entries, 1):
            self.assertEqual((self.fixture.source / f"{number:02}.png").read_bytes(), self.original[entry["imageId"]])
        self.assertTrue(self.state.acknowledge_browser_save(entries[0]["saveToken"])["acknowledged"])

    def test_recovery_before_workspace_commit_restores_every_source(self):
        entries = self.render(list(reversed(self.state.order)))
        with patch.object(self.state.workspace_store, "commit_numbered_saves", side_effect=SystemExit("simulated process stop")), \
             patch("mozarie.numbered_batch.recover_batch", return_value=False):
            with self.assertRaises(ClientError):
                commit_batch(self.state, entries)
        self.assertTrue(batch_rows(self.state.save_journal))
        recover_batches(self.state)
        recover_batches(self.state)
        self.assert_originals()

    def test_same_physical_source_selected_twice_is_rejected_before_render(self):
        from dataclasses import replace
        image_id = self.state.order[0]
        alias = replace(self.state.images[image_id], image_id="duplicate-source-alias")
        self.state.images[alias.image_id] = alias
        self.state.order.append(alias.image_id)
        with self.assertRaises(ClientError) as error:
            self.state.prepare_browser_save([image_id, alias.image_id], 100, "", False,
                numbering={"digits": 2, "placement": "only"})
        self.assertEqual(error.exception.error_code, "output_name_conflict")
        self.assertFalse(self.state.browser_save_tokens)
        self.assert_originals()

    def live_rotation(self, browser_sources, failure=None):
        if failure in {"create-gap", "chain"}:
            (self.fixture.source / "03.png").rename(self.fixture.source / "05.png")
            self.state.set_root(str(self.fixture.source))
            self.paths = {image_id: record.path for image_id, record in self.state.images.items()}
        self.fixture.output.mkdir()
        args = ["node", str(Path(__file__).with_name("numbered_overwrite_live_browser.cjs")), self.fixture.origin]
        if browser_sources:
            args.append(json.dumps({path.name: base64.b64encode(path.read_bytes()).decode("ascii") for path in self.paths.values()}))
        if failure:
            args.append(failure)
        result = subprocess.run(args, cwd=Path(__file__).resolve().parents[2], capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=90,
                                env={**os.environ, "PYTHONUTF8": "1"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        if not browser_sources:
            for number, image_id in enumerate(self.state.order, 1):
                self.assertEqual((self.fixture.source / f"{number:02}.png").read_bytes(), self.original[image_id])

    def test_real_browser_native_cycle(self):
        self.live_rotation(False)

    def test_real_browser_dropped_handle_cycle(self):
        self.live_rotation(True)

    def test_real_browser_second_write_failure_restores_all_slots(self):
        self.live_rotation(True, "write")

    def test_real_browser_closed_tab_rolls_back_abandoned_slots_and_recovers_handles(self):
        self.live_rotation(True, "restart")

    def test_real_browser_close_after_write_before_journal_recovers(self):
        self.live_rotation(True, "write-gap")

    def test_real_browser_close_after_restore_before_journal_recovers(self):
        self.live_rotation(True, "restore-gap")

    def test_real_browser_unrecorded_created_slot_preserves_backups_until_resolved(self):
        self.live_rotation(True, "create-gap")

    def test_prepared_batch_claim_prevents_new_save_of_same_image(self):
        entries = self.render(list(reversed(self.state.order)))
        entry = entries[0]
        with self.assertRaises(ClientError) as caught:
            self.state.reserve_browser_save(entry["imageId"], entry["candidateRevision"], str(uuid.uuid4()),
                copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
        self.assertEqual(caught.exception.error_code, "operation_in_progress")
        self.assert_originals()

    def test_real_browser_successful_chain_publishes_new_slot_and_removes_old_name(self):
        self.live_rotation(True, "chain")

    def test_nonselected_native_alias_keeps_desired_transform_and_edited_filename(self):
        from dataclasses import replace
        image_id = self.state.order[0]
        owner = self.state.images[image_id]
        alias = replace(owner, image_id=uuid.uuid4().hex)
        catalog, _source, _stored = self.state.workspace_store.create_projectless_native_workspace(self.fixture.source, [alias])
        self.state.workspace_store.set_image_edited_filename(alias.image_id, "alias.png")
        self.state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        entries = self.render(list(reversed(self.state.order)))
        commit_batch(self.state, entries)
        with self.state.workspace_store._connect() as db:
            row = dict(db.execute("SELECT * FROM images WHERE image_id=?", (alias.image_id,)).fetchone())
        self.assertEqual(row["relative_path"], "03.png")
        self.assertEqual(row["edited_filename"], "alias.png")
        self.assertEqual(row["mtime_ns"], self.state.images[image_id].mtime_ns)
        transform = self.state.workspace_store.image_transform(alias.image_id)
        self.assertFalse(transform["flipHorizontal"])
        self.assertTrue(transform["sourceFlipHorizontal"])

    def test_pending_mixed_batch_keeps_session_backups_during_stale_cleanup(self):
        import time
        session_dir = self.state.session_base_dir / "session-abandoned"
        session_dir.mkdir(parents=True)
        record = self.state.images[self.state.order[1]]
        moved = session_dir / record.path.name
        record.path.rename(moved)
        record.path = moved
        record.source_kind = "session"
        self.state.session_imports_dir = session_dir
        entries = self.render(list(reversed(self.state.order)))
        next(entry for entry in entries if entry["imageId"] == record.image_id)["sourceMetadata"] = {"sourceMtimeMs": record.mtime_ns // 1000000, "sourceSizeBytes": record.size_bytes}
        native = next(self.state.images[entry["imageId"]] for entry in entries if self.state.images[entry["imageId"]].source_kind == "filesystem")
        conflict = self.fixture.source / entries[next(index for index, entry in enumerate(entries) if entry["imageId"] == native.image_id)]["outputFilename"]
        publish = self.state._publish_staged_copy
        def race(*args):
            conflict.write_bytes(b"external")
            return publish(*args)
        with patch.object(self.state, "_publish_staged_copy", side_effect=race):
            with self.assertRaises(ClientError):
                commit_batch(self.state, entries)
        os.utime(session_dir, (time.time() - 120, time.time() - 120))
        recover_batches(self.state)
        self.state._cleanup_stale_sessions()
        self.assertTrue(session_dir.is_dir())
        self.assertTrue(list(session_dir.glob(".*mozarie-numbered-*")))
        conflict.unlink()
        recover_batches(self.state)
        self.assertEqual(moved.read_bytes(), self.original[record.image_id])
        self.assertFalse(batch_rows(self.state.save_journal))

    def test_real_browser_mixed_source_conflicts_are_combined_before_any_render(self):
        self.live_rotation(True, "mixed-conflicts")

    def test_native_chain_preserves_timestamps_and_publishes_new_slot(self):
        (self.fixture.source / "03.png").rename(self.fixture.source / "05.png")
        self.state.workspace_store.rename_native_source_records(self.fixture.source / "03.png", self.fixture.source / "05.png")
        self.state.set_root(str(self.fixture.source))
        ids = list(self.state.order[1:]) + [self.state.order[0]]
        originals = {image_id: (record.path.read_bytes(), record.mtime_ns) for image_id, record in self.state.images.items()}
        entries = self.render(ids)
        commit_batch(self.state, entries)
        for number, image_id in enumerate(ids, 1):
            output = self.fixture.source / f"{number:02}.png"
            self.assertEqual(output.read_bytes(), originals[image_id][0])
            self.assertEqual(output.stat().st_mtime_ns, originals[image_id][1])
        self.assertFalse((self.fixture.source / "05.png").exists())

    def test_stale_session_cleanup_keeps_files_if_recovery_database_cannot_be_read(self):
        import time
        session_dir = self.state.session_base_dir / "session-abandoned"
        session_dir.mkdir(parents=True)
        (session_dir / "original.png").write_bytes(b"original")
        os.utime(session_dir, (time.time() - 120, time.time() - 120))
        with patch("mozarie.numbered_batch.batch_rows", side_effect=sqlite3.OperationalError("unavailable")):
            self.state._cleanup_stale_sessions()
        self.assertEqual((session_dir / "original.png").read_bytes(), b"original")
