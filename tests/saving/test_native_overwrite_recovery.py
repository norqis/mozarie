"""Failed native saves restore owned files and preserve concurrent external edits."""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from PIL import Image
from tests import prepare_test_app_config
from mozarie.core import ClientError
from mozarie.save_journal import SaveJournal
import mozarie.state as state_module
from mozarie.state import StudioState


class NativeOverwriteRecoveryTests(unittest.TestCase):
    @contextmanager
    def fixture(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            prepare_test_app_config(root / "app")
            source = root / "images" / "source.png"
            source.parent.mkdir()
            with Image.new("RGB", (16, 16), "white") as image:
                image.putpixel((0, 0), (0, 0, 0))
                image.save(source)
            with patch.object(state_module, "APP_DIR", root / "app"):
                state = StudioState(root / "cache", root / "sessions")
                try:
                    image_id = state.set_root(str(source.parent))[0]["id"]
                    state.set_image_transform(image_id, {"flipH": True, "flipV": False})
                    state.set_image_flags(image_id, {"reviewed": True})
                    if mode == "rename":
                        state.rename_catalog_image(image_id, "renamed.png")
                    target = source.with_name("renamed.png") if mode == "rename" else source.with_suffix(".jpg") if mode == "jpg" else source
                    yield state, image_id, source, target, root
                finally:
                    state.shutdown()

    def prepare_save(self, state, image_id, mode):
        token = uuid.uuid4().hex
        revision = state._candidate_revision(image_id)
        options = dict(copy_to_default=False, suffix="_censored", output_format="jpg" if mode == "jpg" else "original", keep_metadata=mode != "jpg")
        state.reserve_browser_save(image_id, revision, token, **options)
        state.render_browser_save(image_id, revision, 100, None, stream_image=False, client_save_token=token, **options)
        return token, revision

    @contextmanager
    def fail_receipt(self, database, before_failure):
        connect = sqlite3.connect
        with connect(database) as db:
            db.execute("CREATE TRIGGER reject_save_receipt BEFORE INSERT ON browser_save_receipts BEGIN SELECT external_edit(); SELECT RAISE(ABORT, 'receipt unavailable'); END")
        db.close()

        def open_database(path, *args, **kwargs):
            connection = connect(path, *args, **kwargs)
            if Path(path) == database:
                connection.create_function("external_edit", 0, before_failure)
            return connection

        try:
            with patch.object(sqlite3, "connect", side_effect=open_database):
                yield
        finally:
            with connect(database) as db:
                db.execute("DROP TRIGGER reject_save_receipt")
            db.close()

    def test_receipt_failure_restores_original_and_allows_retry_for_each_output_path(self):
        for mode in ("same", "rename", "jpg"):
            with self.subTest(mode=mode), self.fixture(mode) as (state, image_id, source, target, _root):
                original = source.read_bytes()
                workspace = state.workspace_store.export_state(image_id)
                history = state.project_history_status(image_id)
                token, revision = self.prepare_save(state, image_id, mode)
                with self.fail_receipt(state.workspace_store.path, lambda: None), self.assertRaises(sqlite3.IntegrityError):
                    state.commit_browser_save(image_id, revision, token, "overwrite")
                self.assertEqual(source.read_bytes(), original)
                if target != source:
                    self.assertFalse(target.exists())
                self.assertEqual(state.images[image_id].path, source)
                self.assertNotIn(image_id, state.source_mismatches)
                self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                self.assertEqual(state.project_history_status(image_id), history)
                self.assertTrue(state.images[image_id].reviewed)
                self.assertIsNone(state.workspace_store.browser_save_receipt(token))
                row = state.save_journal.row(token)
                self.assertEqual(row["state"], "cancelled")
                self.assertFalse(Path(row["quarantine"]).exists())
                token, revision = self.prepare_save(state, image_id, mode)
                state.commit_browser_save(image_id, revision, token, "overwrite")
                self.assertNotEqual(target.read_bytes(), original)
                self.assertEqual(state.images[image_id].path, target)

    def check_external_edit(self, mode):
        with self.fixture(mode) as (state, image_id, source, target, root):
            original = source.read_bytes()
            workspace = state.workspace_store.export_state(image_id)
            history = state.project_history_status(image_id)
            token, revision = self.prepare_save(state, image_id, mode)
            external = root / ("external" + target.suffix)
            with Image.new("RGB", (16, 16), "red") as image:
                image.save(external)
            external_bytes = external.read_bytes()

            def replace_published_image():
                os.replace(external, target)

            with self.fail_receipt(state.workspace_store.path, replace_published_image), self.assertRaises((ClientError, sqlite3.IntegrityError, OSError)) as raised:
                state.commit_browser_save(image_id, revision, token, "overwrite")
            self.assertEqual(target.read_bytes(), external_bytes)
            self.assertIsInstance(raised.exception, ClientError)
            self.assertEqual(raised.exception.error_code, "save_recovery_pending")
            row = state.save_journal.row(token)
            self.assertEqual(row["state"], "cleanup_pending")
            # Format/rename rollback may already have put the original back.
            original_path = source if target != source else Path(row["quarantine"])
            self.assertEqual(original_path.read_bytes(), original)
            live = state.images[image_id]
            self.assertEqual(live.path, target)
            self.assertEqual(live.relative_path, target.name)
            self.assertEqual(live.asset_fingerprint(), (target.stat().st_mtime_ns, target.stat().st_size))
            self.assertIn(image_id, state.source_mismatches)
            self.assertTrue(live.reviewed)
            self.assertEqual(state.workspace_store.export_state(image_id), workspace)
            self.assertEqual(state.project_history_status(image_id), history)
            self.assertIsNone(state.workspace_store.browser_save_receipt(token))
            with self.assertRaises(ClientError) as retry:
                self.prepare_save(state, image_id, mode)
            self.assertEqual(retry.exception.error_code, "source_mismatch")
            # Reopen the durable journal and run the startup recovery entrypoint.
            restarted = SaveJournal(root / "app" / "data")
            restarted.recover(state.workspace_store.browser_save_receipt)
            self.assertEqual(target.read_bytes(), external_bytes)
            self.assertEqual(original_path.read_bytes(), original)
            self.assertEqual(restarted.row(token)["state"], "cleanup_pending")

    def test_external_edit_at_same_path_survives_receipt_failure_and_recovery(self):
        self.check_external_edit("same")

    def test_external_edit_at_renamed_path_survives_receipt_failure_and_recovery(self):
        self.check_external_edit("rename")

    def test_external_edit_at_converted_path_survives_receipt_failure_and_recovery(self):
        self.check_external_edit("jpg")
