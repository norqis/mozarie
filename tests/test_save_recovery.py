import tempfile
import unittest
import sys
import types
import gc
import os
import shutil
import sqlite3
import threading
import ctypes
from pathlib import Path
from unittest import mock

from mozarie.save_journal import SaveJournal
# The workspace module imports mask helpers, but these receipt tests do not
# invoke OpenCV. Keep the database contract runnable on the lean CI Python.
sys.modules.setdefault("cv2", types.SimpleNamespace())
from mozarie.workspace import WorkspaceStore
from mozarie.saving import SavingMixin


def receipt(token: str = "token") -> dict[str, object]:
    return {"token": token, "imageId": "image", "revision": 1,
            "sourceAction": "keep", "cleared": True, "stale": False,
            "deleted": False, "catalogGeneration": 3, "outputPath": ""}


class _AckOwner:
    def __init__(self, journal: SaveJournal, store: WorkspaceStore) -> None:
        self.save_journal = journal
        self.workspace_store = store
        self.browser_save_receipts = {}
        self.lock = threading.RLock()


class SaveRecoveryTests(unittest.TestCase):
    def _replacement_backup(self, root: Path, token: str) -> tuple[SaveJournal, Path, Path]:
        source = root / "source.png"; backup = root / ".source.png.mozarie-backup-token"; staged = root / "rendered.stage"
        source.write_bytes(b"original")
        source_stat = source.stat(); source_identity = SaveJournal.file_identity(source, source_stat)
        shutil.copy2(source, backup)
        backup_stat = backup.stat(); backup_identity = SaveJournal.file_identity(backup, backup_stat)
        staged.write_bytes(b"rendered")
        os.utime(staged, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        replacement_stat = staged.stat(); replacement_identity = SaveJournal.file_identity(staged, replacement_stat)
        staged.replace(source)
        journal = SaveJournal(root)
        journal.reserve(token, "image", 1, None, staged)
        journal.replacement_backup(token, source, backup, (backup_stat.st_mtime_ns, backup_stat.st_size), backup_identity,
                                   source_identity, (replacement_stat.st_mtime_ns, replacement_stat.st_size), replacement_identity)
        return journal, source, backup

    def _format_replacement_backup(self, root: Path, token: str, image_id: str = "image") -> tuple[SaveJournal, Path, Path, Path]:
        """Model a PNG→JPG publish after the old path has been deleted."""
        source = root / "source.png"; destination = root / "source.jpg"
        source.write_bytes(b"original-png")
        source_stat = source.stat(); source_identity = SaveJournal.file_identity(source, source_stat)
        backup = root / ".source.png.mozarie-backup-token"; shutil.copy2(source, backup)
        backup_stat = backup.stat(); backup_identity = SaveJournal.file_identity(backup, backup_stat)
        destination.write_bytes(b"rendered-jpeg")
        destination_stat = destination.stat(); destination_identity = SaveJournal.file_identity(destination, destination_stat)
        journal = SaveJournal(root)
        journal.reserve(token, image_id, 1, None, None)
        journal.replacement_backup(token, source, backup, (backup_stat.st_mtime_ns, backup_stat.st_size), backup_identity,
                                   source_identity, (destination_stat.st_mtime_ns, destination_stat.st_size), destination_identity)
        journal.destination(token, destination)
        journal.published(token, (destination_stat.st_mtime_ns, destination_stat.st_size), destination_identity)
        source.unlink()
        return journal, source, destination, backup

    def test_workspace_receipt_is_durable(self):
        with tempfile.TemporaryDirectory() as raw:
            store = WorkspaceStore(Path(raw))
            store.commit_save("image", clear_workspace=False, save_receipt={
                "token": "save-token", "imageId": "image", "revision": 4,
                "sourceAction": "keep", "cleared": True, "stale": False,
                "deleted": False, "catalogGeneration": 9,
            })
            self.assertEqual(store.browser_save_receipt("save-token")["catalogGeneration"], 9)
            self.assertTrue(store.acknowledge_browser_save_receipt("save-token"))
            self.assertIsNone(store.browser_save_receipt("save-token"))

    @unittest.skipUnless(os.name == "nt", "Windows overwrite recovery contract")
    def test_replacement_backup_restores_an_owned_overwrite_without_receipt(self):
        with tempfile.TemporaryDirectory() as raw:
            journal, source, backup = self._replacement_backup(Path(raw), "rollback")
            self.assertTrue(journal.recover_token("rollback"))
            self.assertEqual(source.read_bytes(), b"original")
            self.assertFalse(backup.exists())
            self.assertEqual(journal.row("rollback")["state"], "cancelled")

    @unittest.skipUnless(os.name == "nt", "Windows overwrite recovery contract")
    def test_replacement_backup_discards_an_owned_backup_after_receipt(self):
        with tempfile.TemporaryDirectory() as raw:
            journal, source, backup = self._replacement_backup(Path(raw), "commit")
            self.assertTrue(journal.recover_token("commit", lambda _token: receipt("commit")))
            self.assertEqual(source.read_bytes(), b"rendered")
            self.assertFalse(backup.exists())
            self.assertEqual(journal.row("commit")["state"], "committed")

    @unittest.skipUnless(os.name == "nt", "Windows overwrite recovery contract")
    def test_replacement_backup_preserves_an_externally_replaced_source(self):
        with tempfile.TemporaryDirectory() as raw:
            journal, source, backup = self._replacement_backup(Path(raw), "external")
            source.write_bytes(b"external")
            self.assertFalse(journal.recover_token("external"))
            self.assertEqual(source.read_bytes(), b"external")
            self.assertTrue(backup.exists())
            self.assertEqual(journal.row("external")["state"], "cleanup_pending")

    @unittest.skipUnless(os.name == "nt", "Windows conversion recovery contract")
    def test_format_replacement_startup_rollback_restores_the_old_path_and_removes_the_new_path(self):
        with tempfile.TemporaryDirectory() as raw:
            journal, source, destination, backup = self._format_replacement_backup(Path(raw), "format-rollback")
            journal.recover()
            self.assertEqual(source.read_bytes(), b"original-png")
            self.assertFalse(destination.exists())
            self.assertFalse(backup.exists())
            self.assertIsNone(journal.row("format-rollback"))

    @unittest.skipUnless(os.name == "nt", "Windows conversion recovery contract")
    def test_format_replacement_startup_commit_keeps_new_path_and_durable_catalogue_path(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); store = WorkspaceStore(root / "workspace")
            catalog = str(store.create_project("Format recovery")["id"])
            source = root / "source.png"; source.write_bytes(b"original-png")
            source_stat = source.stat()
            image_id = str(store.reconcile_images(catalog, [types.SimpleNamespace(
                relative_path="source.png", size_bytes=source_stat.st_size, mtime_ns=source_stat.st_mtime_ns, width=4, height=4,
            )])["source.png"]["image_id"])
            journal, source, destination, backup = self._format_replacement_backup(root, "format-commit", image_id)
            destination_stat = destination.stat()
            save_receipt = {
                "token": "format-commit", "imageId": image_id, "revision": 1,
                "sourceAction": "overwrite", "cleared": False, "stale": False,
                "deleted": False, "catalogGeneration": 1, "outputPath": str(destination),
            }
            store.commit_save(
                image_id, mtime_ns=destination_stat.st_mtime_ns, size_bytes=destination_stat.st_size,
                relative_path="source.jpg", clear_workspace=False, save_receipt=save_receipt,
            )
            journal.recover(store.browser_save_receipt)
            self.assertFalse(source.exists())
            self.assertEqual(destination.read_bytes(), b"rendered-jpeg")
            self.assertFalse(backup.exists())
            self.assertEqual(store.project_image(image_id)["relativePath"], "source.jpg")
            self.assertEqual(journal.row("format-commit")["state"], "committed")

    def test_cleanup_keeps_an_unowned_final(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); destination = root / "result.png"; destination.write_bytes(b"external")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, destination, None)
            journal.placeholder("token", "different:file")
            self.assertFalse(journal.cleanup("token"))
            self.assertEqual(destination.read_bytes(), b"external")
            del journal
            gc.collect()

    def test_cleanup_removes_the_verified_final(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); destination = root / "result.png"; destination.write_bytes(b"owned")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, destination, None)
            journal.placeholder("token", journal.file_identity(destination))
            self.assertIsNotNone(journal.file_identity(destination))
            self.assertTrue(journal.cleanup("token"))
            self.assertFalse(destination.exists())
            del journal
            gc.collect()

    def test_workspace_receipt_wins_and_keeps_the_final_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); final = root / "result.png"; final.write_bytes(b"owned")
            stage = root / "private.stage"; stage.write_bytes(b"stage")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, final, stage)
            stat = final.stat(); journal.published("token", (stat.st_mtime_ns, stat.st_size), journal.file_identity(final))
            stage_stat = stage.stat(); journal.update_stage("token", stage, (stage_stat.st_mtime_ns, stage_stat.st_size))
            self.assertTrue(journal.recover_token("token", lambda _token: receipt()))
            self.assertTrue(final.exists())
            self.assertFalse(stage.exists())
            self.assertEqual(journal.row("token")["state"], "committed")
            del journal
            gc.collect()

    def test_stage_failure_keeps_rollback_pending_until_it_is_clean(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); stage = root / "private.stage"; stage.write_bytes(b"stage")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, stage)
            stat = stage.stat(); journal.update_stage("token", stage, (stat.st_mtime_ns, stat.st_size))
            with mock.patch.object(SaveJournal, "_unlink", return_value=False):
                self.assertFalse(journal.cleanup("token"))
            row = journal.row("token")
            self.assertEqual(row["state"], "cleanup_pending")
            self.assertEqual(row["recovery_decision"], "rollback")
            self.assertTrue(journal.cleanup("token"))
            self.assertEqual(journal.row("token")["state"], "cancelled")
            del journal
            gc.collect()

    def test_restore_conflict_never_overwrites_the_source(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; source.write_bytes(b"new")
            quarantine = root / ".source.png.mozarie-delete-token"; quarantine.write_bytes(b"old")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            journal.phase("token", "source_quarantined", quarantine)
            self.assertFalse(journal.cleanup("token"))
            self.assertEqual(source.read_bytes(), b"new")
            self.assertEqual(quarantine.read_bytes(), b"old")
            self.assertEqual(journal.row("token")["state"], "cleanup_pending")
            del journal
            gc.collect()

    def test_multiple_cleanup_failures_stay_pending_together(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; source.write_bytes(b"old")
            source_stat = source.stat(); quarantine = root / ".source.png.mozarie-delete-token"
            stage = root / "private.stage"; stage.write_bytes(b"stage")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, stage)
            stat = stage.stat(); journal.update_stage("token", stage, (stat.st_mtime_ns, stat.st_size))
            journal.phase("token", "source_quarantined", quarantine)
            journal.quarantine("token", source, quarantine, (source_stat.st_mtime_ns, source_stat.st_size), journal.file_identity(source))
            source.replace(quarantine); source.write_bytes(b"new")
            with mock.patch.object(SaveJournal, "_unlink", return_value=False):
                self.assertFalse(journal.cleanup("token"))
            row = journal.row("token")
            self.assertEqual(row["state"], "cleanup_pending")
            self.assertIn("source restore", row["cleanup_note"])
            self.assertIn("stage cleanup", row["cleanup_note"])
            del journal
            gc.collect()

    def test_committed_quarantine_conflict_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; source.write_bytes(b"old")
            source_stat = source.stat()
            quarantine = root / ".source.png.mozarie-delete-token"
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            journal.phase("token", "source_quarantined", quarantine)
            journal.quarantine("token", source, quarantine, (source_stat.st_mtime_ns, source_stat.st_size), journal.file_identity(source))
            source.replace(quarantine)
            source.write_bytes(b"new")
            self.assertFalse(journal.recover_token("token", lambda _token: receipt()))
            self.assertTrue(source.exists())
            self.assertTrue(quarantine.exists())
            self.assertEqual(journal.row("token")["recovery_decision"], "commit")
            del journal
            gc.collect()

    def test_quarantine_replacement_is_never_restored_or_deleted(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "weird.mozarie-delete-name.png"; source.write_bytes(b"owned")
            source_stat = source.stat(); quarantine = root / f".{source.name}.mozarie-delete-token"
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            journal.phase("token", "source_quarantined", quarantine)
            journal.quarantine("token", source, quarantine, (source_stat.st_mtime_ns, source_stat.st_size), journal.file_identity(source))
            source.replace(quarantine)
            quarantine.unlink(); quarantine.write_bytes(b"outside")
            self.assertFalse(journal.cleanup("token"))
            self.assertFalse(source.exists())
            self.assertEqual(quarantine.read_bytes(), b"outside")
            self.assertEqual(journal.row("token")["state"], "cleanup_pending")
            del journal
            gc.collect()

    def test_owned_quarantine_restores_to_the_recorded_source_path(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "has.mozarie-delete-text.png"; source.write_bytes(b"owned")
            source_stat = source.stat(); quarantine = root / f".{source.name}.mozarie-delete-token"
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            journal.phase("token", "source_quarantined", quarantine)
            journal.quarantine("token", source, quarantine, (source_stat.st_mtime_ns, source_stat.st_size), journal.file_identity(source))
            source.replace(quarantine)
            self.assertTrue(journal.cleanup("token"))
            self.assertEqual(source.read_bytes(), b"owned")
            self.assertFalse(quarantine.exists())
            del journal
            gc.collect()

    @unittest.skipUnless(__import__("os").name == "nt", "Windows source delete identity contract")
    def test_verified_source_rename_rejects_same_fingerprint_replacement(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; quarantine = root / ".source.png.mozarie-delete-token"
            source.write_bytes(b"owned!")
            expected_stat = source.stat(); expected_identity = SaveJournal.file_identity(source, expected_stat)
            self.assertTrue(SaveJournal.rename_windows_verified(source, quarantine, str(expected_identity), (expected_stat.st_mtime_ns, expected_stat.st_size)))
            self.assertTrue(SaveJournal.rename_windows_verified(quarantine, source, str(expected_identity), (expected_stat.st_mtime_ns, expected_stat.st_size)))
            foreign = root / "foreign.png"; foreign.write_bytes(b"alien!")
            __import__("os").utime(foreign, ns=(expected_stat.st_atime_ns, expected_stat.st_mtime_ns))
            foreign.replace(source)
            replaced_stat = source.stat()
            self.assertEqual((replaced_stat.st_mtime_ns, replaced_stat.st_size), (expected_stat.st_mtime_ns, expected_stat.st_size))
            self.assertFalse(SaveJournal.rename_windows_verified(source, quarantine, str(expected_identity), (expected_stat.st_mtime_ns, expected_stat.st_size)))
            self.assertEqual(source.read_bytes(), b"alien!")
            self.assertFalse(quarantine.exists())

    @unittest.skipUnless(__import__("os").name == "nt", "Windows handle rename contract")
    def test_quarantine_source_uses_verified_handle_and_rejects_missing_identity(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; source.write_bytes(b"owned")
            quarantine = root / ".source.png.mozarie-delete-token"; journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            with mock.patch.object(SaveJournal, "_windows_handle_identity", return_value=None):
                self.assertFalse(journal.quarantine_source("token", source, quarantine))
            self.assertTrue(source.exists())
            self.assertFalse(quarantine.exists())
            self.assertTrue(journal.quarantine_source("token", source, quarantine))
            self.assertFalse(source.exists())
            self.assertEqual(quarantine.read_bytes(), b"owned")
            del journal
            gc.collect()

    @unittest.skipUnless(__import__("os").name == "nt", "Windows handle publish contract")
    def test_publish_stage_records_its_handle_identity_before_replacement_can_win(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); stage = root / "private.stage"; destination = root / "result.png"
            stage.write_bytes(b"owned")
            journal = SaveJournal(root)
            journal.reserve("token", "image", 1, destination, stage)
            original_placeholder = journal.placeholder
            blocked_replacement = False
            def record(token, identity):
                nonlocal blocked_replacement
                with self.assertRaises(PermissionError):
                    destination.unlink()
                blocked_replacement = True
                original_placeholder(token, identity)
            with mock.patch.object(journal, "placeholder", side_effect=record):
                identity = journal.publish_staged_windows("token", stage, destination)
            self.assertTrue(blocked_replacement)
            self.assertIsNotNone(identity)
            self.assertEqual(journal.row("token")["destination_identity"], identity)
            destination.unlink(); destination.write_bytes(b"foreign")
            self.assertFalse(journal.cleanup("token"))
            self.assertEqual(destination.read_bytes(), b"foreign")
            del journal
            gc.collect()

    @unittest.skipUnless(__import__("os").name == "nt", "Windows handle rename contract")
    def test_quarantine_source_does_not_replace_an_existing_target(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; source.write_bytes(b"owned")
            quarantine = root / ".source.png.mozarie-delete-token"; quarantine.write_bytes(b"outside")
            journal = SaveJournal(root); journal.reserve("token", "image", 1, None, None)
            self.assertFalse(journal.quarantine_source("token", source, quarantine))
            self.assertEqual(source.read_bytes(), b"owned")
            self.assertEqual(quarantine.read_bytes(), b"outside")
            del journal
            gc.collect()

    def test_zero_windows_file_id_is_not_ownership_evidence(self):
        class _Function:
            argtypes = None
            restype = None
            def __call__(self, *_args): return True
        class _Kernel:
            GetFileInformationByHandleEx = _Function()
        with mock.patch("os.name", "nt"), mock.patch.object(ctypes, "WinDLL", return_value=_Kernel(), create=True):
            self.assertIsNone(SaveJournal._windows_handle_identity(1))

    def test_reserve_never_reassigns_an_existing_token(self):
        with tempfile.TemporaryDirectory() as raw:
            journal = SaveJournal(Path(raw))
            journal.reserve("token", "image-a", 1, None, None)
            with self.assertRaises(ValueError):
                journal.reserve("token", "image-b", 1, None, None)
            self.assertEqual(journal.row("token")["image_id"], "image-a")
            del journal
            gc.collect()

    def test_failed_quarantine_intent_is_cleared_before_commit_recovery(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); journal = SaveJournal(root)
            journal.reserve("token", "image", 1, None, None)
            journal.phase("token", "source_quarantined", root / ".source.png.mozarie-delete-token")
            journal.clear_quarantine("token")
            row = journal.row("token")
            self.assertEqual(row["state"], "published")
            self.assertIsNone(row["quarantine"])
            self.assertTrue(journal.recover_token("token", lambda _token: receipt()))
            del journal
            gc.collect()

    def test_receipt_ack_retries_after_workspace_delete_failure(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); journal = SaveJournal(root); store = WorkspaceStore(root)
            store.commit_save("image", clear_workspace=False, save_receipt=receipt())
            journal.reserve("token", "image", 1, None, None)
            journal.finish("token", True, False, False, 3)
            owner = _AckOwner(journal, store)
            original = store.acknowledge_browser_save_receipt
            with mock.patch.object(store, "acknowledge_browser_save_receipt", side_effect=OSError("offline")):
                with self.assertRaises(OSError):
                    SavingMixin.acknowledge_browser_save(owner, "token")
            self.assertIsNotNone(store.browser_save_receipt("token"))
            self.assertIsNone(journal.row("token"))
            self.assertEqual(SavingMixin.acknowledge_browser_save(owner, "token"), {"acknowledged": True})
            self.assertIsNone(store.browser_save_receipt("token"))
            self.assertTrue(callable(original))
            del owner, journal
            gc.collect()

    def test_ack_keeps_receipt_when_commit_cleanup_is_pending(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); stage = root / "private.stage"; stage.write_bytes(b"stage")
            journal = SaveJournal(root); store = WorkspaceStore(root)
            store.commit_save("image", clear_workspace=False, save_receipt=receipt())
            journal.reserve("token", "image", 1, None, stage)
            stat = stage.stat(); journal.update_stage("token", stage, (stat.st_mtime_ns, stat.st_size))
            owner = _AckOwner(journal, store)
            with mock.patch.object(SaveJournal, "_unlink", return_value=False):
                self.assertEqual(SavingMixin.acknowledge_browser_save(owner, "token"), {"acknowledged": False})
            self.assertIsNotNone(store.browser_save_receipt("token"))
            self.assertEqual(journal.row("token")["state"], "cleanup_pending")
            del owner, journal
            gc.collect()

    def test_ack_keeps_receipt_when_journal_is_temporarily_unavailable(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); journal = SaveJournal(root); store = WorkspaceStore(root)
            store.commit_save("image", clear_workspace=False, save_receipt=receipt())
            journal.reserve("token", "image", 1, None, None)
            journal.finish("token", True, False, False, 3)
            owner = _AckOwner(journal, store)

            with mock.patch.object(journal, "recover_token", side_effect=sqlite3.OperationalError("journal locked")):
                self.assertEqual(SavingMixin.acknowledge_browser_save(owner, "token"), {"acknowledged": False})

            self.assertIsNotNone(store.browser_save_receipt("token"))
            self.assertEqual(SavingMixin.acknowledge_browser_save(owner, "token"), {"acknowledged": True})
            self.assertIsNone(store.browser_save_receipt("token"))
            del owner, journal
            gc.collect()

    def test_legacy_cleanup_pending_uses_workspace_receipt_not_note_text(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); db_path = root / "save-journal.sqlite3"
            db = sqlite3.connect(db_path)
            try:
                db.execute("""CREATE TABLE saves (token TEXT PRIMARY KEY,image_id TEXT NOT NULL,revision INTEGER NOT NULL,
                    state TEXT NOT NULL,destination TEXT,staged TEXT,staged_mtime INTEGER,staged_size INTEGER,
                    quarantine TEXT,cleared INTEGER,stale INTEGER,deleted INTEGER,catalog_generation INTEGER,
                    updated_at INTEGER NOT NULL)""")
                db.execute("INSERT INTO saves VALUES ('token','image',1,'cleanup_pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1)")
                db.commit()
            finally:
                db.close()
            journal = SaveJournal(root)
            self.assertTrue(journal.recover_token("token", lambda _token: receipt()))
            row = journal.row("token")
            self.assertEqual(row["state"], "committed")
            self.assertEqual(row["recovery_decision"], "commit")
            del journal
            gc.collect()

    def test_legacy_cleanup_pending_without_receipt_is_held(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); db_path = root / "save-journal.sqlite3"
            db = sqlite3.connect(db_path)
            try:
                db.execute("""CREATE TABLE saves (token TEXT PRIMARY KEY,image_id TEXT NOT NULL,revision INTEGER NOT NULL,
                    state TEXT NOT NULL,destination TEXT,staged TEXT,staged_mtime INTEGER,staged_size INTEGER,
                    quarantine TEXT,cleared INTEGER,stale INTEGER,deleted INTEGER,catalog_generation INTEGER,
                    updated_at INTEGER NOT NULL)""")
                db.execute("INSERT INTO saves VALUES ('token','image',1,'cleanup_pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1)")
                db.commit()
            finally:
                db.close()
            journal = SaveJournal(root)
            self.assertFalse(journal.recover_token("token"))
            self.assertEqual(journal.row("token")["state"], "cleanup_pending")
            self.assertIsNone(journal.row("token")["recovery_decision"])
            del journal
            gc.collect()

    def test_startup_compacts_only_cancelled_rows(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); journal = SaveJournal(root)
            journal.reserve("cancel", "image", 1, None, None)
            self.assertTrue(journal.cleanup("cancel"))
            journal.reserve("commit", "image", 1, None, None)
            journal.finish("commit", True, False, False, 1)
            journal.recover()
            self.assertIsNone(journal.row("cancel"))
            self.assertEqual(journal.row("commit")["state"], "committed")
            del journal
            gc.collect()


if __name__ == "__main__":
    unittest.main()
