import sqlite3
import shutil
import subprocess
import sys
import tempfile
import unittest
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from mozarie.catalog import CatalogMixin
import mozarie.workspace as workspace_module
from mozarie.workspace import WorkspaceOpenError, WorkspaceStore


class WorkspaceTests(unittest.TestCase):
    def _image(self, root: Path):
        return SimpleNamespace(relative_path="001.png", size_bytes=10, mtime_ns=20)

    @staticmethod
    def _png(value: int = 255) -> bytes:
        output = io.BytesIO()
        Image.new("L", (4, 4), value).save(output, format="PNG")
        return output.getvalue()

    def test_manual_effective_presence_uses_scalar_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"]
            store.save_manual(str(image_id), {"add": "x", "manualEnabled": True, "hasEffectiveMask": True}, lambda value: self._png() if value else None)
            self.assertEqual(store.manual_mask_statuses([str(image_id)]), {str(image_id): (True, 0)})

    def test_manual_effective_mask_requires_the_client_scalar(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            with self.assertRaisesRegex(ValueError, "effective mask"):
                store.save_manual(image_id, {"add": "x"}, lambda value: b"png" if value else None)

    def test_hydrate_candidates_reads_metadata_without_decoding_masks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                for candidate_id, mask in (("valid", self._png()), ("broken", b"not a PNG")):
                    db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                        image_id, candidate_id, "penis", 0.9, mask, 1, "#123456", "detector",
                        "automatic", None, "apply", 0, 0,
                    ))
            connection.close()
            constructed: list[str] = []
            store.hydrate_candidates(image_id, root / "cache", lambda row, _path: constructed.append(str(row["candidate_id"])))
            self.assertEqual(set(constructed), {"valid", "broken"})

            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE candidates SET mask_png=0 WHERE image_id=? AND candidate_id=?", (image_id, "broken"))
            connection.close()
            self.assertEqual(store.hydrate_candidates(image_id, root / "cache", lambda _row, _path: None)[0], 0)

    def test_hydrate_candidates_propagates_invalid_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, "candidate", "penis", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", None, "invalid-role", 0, 0,
                ))
            connection.close()
            with self.assertRaisesRegex(ValueError, "invalid-role"):
                store.hydrate_candidates(image_id, root / "cache", CatalogMixin._candidate_from_workspace)

    def test_manual_rejects_corrupt_persisted_values_and_propagates_encoder_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            store.save_manual(image_id, {
                "add": "add", "exclusion": "exclusion", "exclusionErase": "erase",
                "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": False,
            }, lambda _value: self._png())
            for column in ("add_png", "exclusion_png", "exclusion_erase_png"):
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute(f"UPDATE manual_edits SET {column}=? WHERE image_id=?", (b"not a PNG", image_id))
                connection.close()
                with self.assertRaisesRegex(ValueError, "PNG"):
                    store.manual(image_id, lambda value: value)
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute(f"UPDATE manual_edits SET {column}=? WHERE image_id=?", (self._png(), image_id))
                connection.close()
            for removed in ("not JSON", '["candidate", 1]'):
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute("UPDATE manual_edits SET removed_candidate_ids=? WHERE image_id=?", (removed, image_id))
                connection.close()
                with self.assertRaises(ValueError):
                    store.manual(image_id, lambda value: value)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE manual_edits SET removed_candidate_ids='[]' WHERE image_id=?", (image_id,))
            connection.close()
            with self.assertRaisesRegex(RuntimeError, "encoder failed"):
                store.manual(image_id, lambda _value: (_ for _ in ()).throw(RuntimeError("encoder failed")))

    def test_manual_returns_none_only_when_no_row_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            self.assertIsNone(store.manual("missing", lambda value: value))

    def test_history_restores_one_image_and_discards_its_redo_after_new_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [SimpleNamespace(relative_path="001.png", size_bytes=1, mtime_ns=1, width=4, height=4)])["001.png"]["image_id"])
            before = store.history_state(image_id)
            payload = {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": False, "history": {}}
            store.save_manual(image_id, payload, lambda _value: None)
            store.record_history(image_id, before, store.history_state(image_id))
            self.assertEqual(store.history_status(image_id), {"canUndo": True, "canRedo": False})
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertIsNone(store.manual(image_id, lambda value: value))
            self.assertEqual(store.restore_history(image_id, "redo"), [image_id])
            self.assertIsNotNone(store.manual(image_id, lambda value: value))
            store.restore_history(image_id, "undo")
            store.save_manual(image_id, {**payload, "manualEnabled": False}, lambda _value: None)
            store.record_history(image_id, before, store.history_state(image_id))
            self.assertEqual(store.history_status(image_id), {"canUndo": True, "canRedo": False})

    def test_history_group_restores_every_affected_image(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"{index}.png", size_bytes=1, mtime_ns=1, width=4, height=4) for index in range(2)]
            ids = [str(value["image_id"]) for value in store.reconcile_images(catalog, records).values()]
            payload = {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": False, "history": {}}
            group = "detection"
            for image_id in ids:
                before = store.history_state(image_id); store.save_manual(image_id, payload, lambda _value: None)
                store.record_history(image_id, before, store.history_state(image_id), group_id=group)
            self.assertEqual(set(store.restore_history(ids[0], "undo")), set(ids))
            self.assertTrue(all(store.manual(image_id, lambda value: value) is None for image_id in ids))
            self.assertEqual(set(store.restore_history(ids[1], "redo")), set(ids))

    def test_history_uses_manual_xor_delta_without_candidate_blob_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [SimpleNamespace(relative_path="001.png", size_bytes=1, mtime_ns=1, width=8, height=8)])["001.png"]["image_id"])
            before = store.history_state(image_id)
            mask = Image.new("L", (8, 8), 0); mask.putpixel((3, 4), 255)
            output = io.BytesIO(); mask.save(output, format="PNG")
            store.save_manual(image_id, {"add": "draw", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": True, "history": {"browser": "ignored"}}, lambda value: output.getvalue() if value else None)
            after = store.history_state(image_id); store.record_history(image_id, before, after)
            db = sqlite3.connect(store.path)
            before_json, after_json, delta_json, history_json = db.execute("""SELECT history_entries.before_json,history_entries.after_json,
                history_entries.delta_json,manual_edits.history_json FROM history_entries JOIN manual_edits USING(image_id)""").fetchone()
            db.close()
            self.assertNotIn("base64", before_json + after_json)
            delta = json.loads(delta_json)["manual"]["add"]
            self.assertEqual(delta["box"][:2], [3, 4])
            self.assertEqual(history_json, "{}")
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertIsNone(store.manual(image_id, lambda value: value))
            self.assertEqual(store.restore_history(image_id, "redo"), [image_id])
            self.assertIsNotNone(store.manual(image_id, lambda value: value))

    def test_candidate_history_references_existing_png_and_restores_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [SimpleNamespace(relative_path="001.png", size_bytes=1, mtime_ns=1, width=4, height=4)])["001.png"]["image_id"])
            db = sqlite3.connect(store.path); db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (image_id, "candidate", "penis", .9, self._png(), 1, "#fff", "auto", "auto", None, "apply", 0, 0)); db.commit(); db.close()
            before = store.history_state(image_id)
            store.commit_candidate_state(image_id, 1, [SimpleNamespace(candidate_id="candidate", label_token="penis", confidence=.9, mask_path=Path("missing"), enabled=False, color="#fff", source="auto", origin="auto", refinement=None, role=SimpleNamespace(value="apply"), forced=False, expand_px=12)], False, replace=False)
            store.record_history(image_id, before, store.history_state(image_id))
            db = sqlite3.connect(store.path); before_json, after_json, blob_count = db.execute("SELECT before_json,after_json,(SELECT COUNT(*) FROM candidates) FROM history_entries").fetchone(); db.close()
            self.assertNotIn("iVBOR", before_json + after_json)
            self.assertEqual(blob_count, 1)
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            db = sqlite3.connect(store.path); self.assertEqual(db.execute("SELECT enabled FROM candidates WHERE image_id=?", (image_id,)).fetchone()[0], 1); db.close()
            self.assertEqual(store.restore_history(image_id, "redo"), [image_id])
            db = sqlite3.connect(store.path); self.assertEqual(db.execute("SELECT expand_px FROM candidate_metadata WHERE image_id=?", (image_id,)).fetchone()[0], 12); db.close()

    def test_future_database_is_not_touched(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(WorkspaceStore.VERSION + 1),))
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(WorkspaceOpenError, "newer"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_invalid_schema_version_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", ("not-a-version",))
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(WorkspaceOpenError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_v1_and_missing_schema_versions_are_rejected_without_mutation(self):
        for version in ("1", None):
            with self.subTest(version=version), tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
                root = Path(directory)
                store = WorkspaceStore(root)
                connection = sqlite3.connect(store.path)
                with connection as db:
                    if version is None:
                        db.execute("DELETE FROM meta WHERE key='schema_version'")
                    else:
                        db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (version,))
                connection.close()
                before = store.path.read_bytes()
                with self.assertRaisesRegex(WorkspaceOpenError, "recreated|not a Mozarie"):
                    WorkspaceStore(root)
                self.assertEqual(store.path.read_bytes(), before)

    def test_v2_database_is_rejected_without_schema_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(WorkspaceOpenError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)
            connection = sqlite3.connect(store.path)
            self.assertEqual(connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "2")
            self.assertNotIn("has_effective_mask", {row[1] for row in connection.execute("PRAGMA table_info(manual_edits)")})
            connection.close()

    def test_v3_database_missing_required_constraints_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            path = root / "workspaces.sqlite3"
            connection = sqlite3.connect(path)
            with connection as db:
                db.executescript("""
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    INSERT INTO meta VALUES('schema_version', '3');
                    CREATE TABLE catalogs (catalog_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                    CREATE TABLE images (catalog_id TEXT NOT NULL, relative_path TEXT NOT NULL, image_id TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, candidate_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(catalog_id, relative_path));
                    CREATE TABLE candidates (image_id TEXT NOT NULL, candidate_id TEXT NOT NULL, class_name TEXT NOT NULL, confidence REAL, mask_png BLOB NOT NULL, enabled INTEGER NOT NULL, color TEXT NOT NULL, source TEXT NOT NULL, origin TEXT NOT NULL, refinement TEXT, role TEXT NOT NULL, forced INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(image_id, candidate_id));
                    CREATE TABLE manual_edits (image_id TEXT PRIMARY KEY, add_png BLOB, exclusion_png BLOB, exclusion_erase_png BLOB, manual_enabled INTEGER NOT NULL DEFAULT 1, exclusion_enabled INTEGER NOT NULL DEFAULT 1, exclusion_erase_enabled INTEGER NOT NULL DEFAULT 1, exclusion_forced INTEGER NOT NULL DEFAULT 1, removed_candidate_ids TEXT NOT NULL DEFAULT '[]', candidate_revision INTEGER NOT NULL DEFAULT 0, has_effective_mask INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
                """)
            connection.close()
            before = path.read_bytes()
            with self.assertRaisesRegex(WorkspaceOpenError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(path.read_bytes(), before)

    def test_save_commit_persists_the_cleared_candidate_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            store.commit_save(image_id, candidate_revision=1, clear_workspace=True)
            reopened = WorkspaceStore(root)
            self.assertEqual(reopened.hydrate_candidates(image_id, root / "cache", lambda *_args: None)[0], 1)

    def test_empty_and_garbage_existing_databases_are_rejected_without_changes(self):
        for content in (b"", b"not sqlite"):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "workspaces.sqlite3"
                path.write_bytes(content)
                before = path.read_bytes()
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore(path.parent)
                self.assertEqual(path.read_bytes(), before)

    def test_explicit_recreate_removes_only_workspace_database_files(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"; data.mkdir()
            database = data / "workspaces.sqlite3"; database.write_bytes(b"not sqlite")
            wal = Path(f"{database}-wal"); wal.write_bytes(b"wal")
            shm = Path(f"{database}-shm"); shm.write_bytes(b"shm")
            source = Path(directory) / "source.png"; source.write_bytes(b"source")
            WorkspaceStore.recreate(data)
            self.assertFalse(database.exists()); self.assertFalse(wal.exists()); self.assertFalse(shm.exists())
            self.assertEqual(source.read_bytes(), b"source")

    def test_empty_candidate_set_keeps_nonzero_revision_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            store.commit_candidate_state(image_id, 7, [], False, replace=True)
            reopened = WorkspaceStore(Path(directory))
            restored = reopened.reconcile_images(catalog, [self._image(Path(directory))])
            self.assertEqual(restored["001.png"]["revision"], 7)

    def test_manual_save_normalizes_removed_ids_to_current_candidates_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE images SET candidate_revision=9 WHERE image_id=?", (image_id,))
                db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, "current", "penis", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", None, "apply", 0, 0,
                ))
            connection.close()
            store.save_manual(image_id, {
                "add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": ["stale", "current", "current"],
                "candidateRevision": 2, "hasEffectiveMask": False,
            }, lambda value: self._png() if value else None)
            manual = store.manual(image_id, lambda value: value)
            self.assertEqual(manual["removedCandidateIds"], ["current"])
            self.assertEqual(manual["candidateRevision"], 9)

    def test_bulk_workspace_queries_accept_more_than_sqlite_variable_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"{index}.png", size_bytes=10, mtime_ns=20) for index in range(1100)]
            ids = [item["image_id"] for item in store.reconcile_images(catalog, records).values()]
            store.delete_images(ids)
            self.assertEqual(store.manual_mask_statuses(ids), {})

    def test_reconcile_images_fetches_existing_rows_once_for_a_large_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"nested/{index:05}.png", size_bytes=10, mtime_ns=20) for index in range(5000)]
            store.reconcile_images(catalog, records)
            statements: list[str] = []
            original_connect = store._connect

            def counted_connect():
                connection = original_connect()
                connection.set_trace_callback(statements.append)
                return connection

            store._connect = counted_connect  # type: ignore[method-assign]
            store.reconcile_images(catalog, records)
            selects = [statement for statement in statements if statement.lstrip().upper().startswith("SELECT")]
            self.assertEqual(len(selects), 1)
            self.assertIn("workspace_reconcile_records", selects[0])

    def test_manifest_scoring_joins_the_manifest_once_for_a_large_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            entries = [(f"nested/{index:05}.png", f"hash-{index}") for index in range(5000)]
            store.reconcile_images(catalog, [SimpleNamespace(relative_path=path, size_bytes=10, mtime_ns=20) for path, _hash in entries])
            statements: list[str] = []
            original_connect = store._connect

            def counted_connect():
                connection = original_connect()
                connection.set_trace_callback(statements.append)
                return connection

            store._connect = counted_connect  # type: ignore[method-assign]
            self.assertIsNone(store.best_catalog_for_manifest(entries, "f" * 32))

    def test_schema_type_or_default_tampering_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            # Rebuild a current-named table with a subtly incompatible default.
            with sqlite3.connect(store.path) as db:
                db.execute("ALTER TABLE images RENAME TO images_old")
                db.execute("CREATE TABLE images (catalog_id TEXT NOT NULL, relative_path TEXT NOT NULL, image_id TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, candidate_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(catalog_id, relative_path))")
                db.execute("DROP TABLE images_old")
            before = store.path.read_bytes()
            with self.assertRaises(WorkspaceOpenError):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_schema_type_and_notnull_tampering_are_rejected_without_mutation(self):
        for definition in ("key BLOB PRIMARY KEY, value TEXT NOT NULL", "key TEXT PRIMARY KEY, value TEXT"):
            with self.subTest(definition=definition), tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
                root = Path(directory)
                store = WorkspaceStore(root)
                with sqlite3.connect(store.path) as db:
                    db.execute("ALTER TABLE meta RENAME TO meta_old")
                    db.execute(f"CREATE TABLE meta ({definition})")
                    db.execute("INSERT INTO meta SELECT * FROM meta_old")
                    db.execute("DROP TABLE meta_old")
                before = store.path.read_bytes()
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore(root)
                self.assertEqual(store.path.read_bytes(), before)

    def test_schema_quick_check_failure_is_rejected_without_mutation(self):
        class QuickCheckFailure:
            def __init__(self, connection):
                object.__setattr__(self, "connection", connection)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.connection.__exit__(*args)

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def __setattr__(self, name, value):
                if name == "connection":
                    object.__setattr__(self, name, value)
                else:
                    setattr(self.connection, name, value)

            def execute(self, statement, *args):
                if statement == "PRAGMA quick_check(1)":
                    return [("not ok",)]
                return self.connection.execute(statement, *args)

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            before = store.path.read_bytes()
            original_connect = workspace_module.sqlite3.connect

            def failing_connect(*args, **kwargs):
                return QuickCheckFailure(original_connect(*args, **kwargs))

            with patch.object(workspace_module.sqlite3, "connect", side_effect=failing_connect):
                with self.assertRaisesRegex(WorkspaceOpenError, "cannot be opened"):
                    WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_schema_foreign_key_violation_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            with sqlite3.connect(store.path) as db:
                db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    "missing-image", "orphan", "penis", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", None, "apply", 0, 0,
                ))
            before = store.path.read_bytes()
            with self.assertRaises(WorkspaceOpenError):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_history_restores_image_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            before = store.history_state(image_id)
            store.set_image_flags(image_id, hidden=True, reviewed=True)
            store.record_history(image_id, before, store.history_state(image_id))
            self.assertEqual(store.image_state(image_id), (True, True))
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertEqual(store.image_state(image_id), (False, False))

    def test_dimension_acknowledgement_stays_blocked_until_masks_are_cleared(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            initial = SimpleNamespace(relative_path="001.png", size_bytes=10, mtime_ns=20, width=4, height=4)
            image_id = str(store.reconcile_images(catalog, [initial])["001.png"]["image_id"])
            changed = SimpleNamespace(image_id=image_id, relative_path="001.png", size_bytes=11, mtime_ns=21, width=8, height=8)
            store.accept_source_metadata([changed], preserve_mask_dimensions=True)
            reopened = store.reconcile_images(catalog, [changed])["001.png"]
            self.assertTrue(reopened["changed"]); self.assertTrue(reopened["dimensions_changed"])
            store.clear_image_workspaces({image_id: 1})
            store.accept_source_metadata([changed])
            accepted = store.reconcile_images(catalog, [changed])["001.png"]
            self.assertFalse(accepted["changed"]); self.assertFalse(accepted["dimensions_changed"])

    def test_atomic_mutations_roll_back_when_the_history_insert_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            with patch.object(store, "_record_history_db", side_effect=sqlite3.OperationalError("history failed")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.set_image_flags(image_id, hidden=True)
            self.assertEqual(store.image_state(image_id), (False, False))
            with patch.object(store, "_record_history_db", side_effect=sqlite3.OperationalError("history failed")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.save_manual(image_id, {"add": "mask", "hasEffectiveMask": True}, lambda _value: self._png())
            self.assertIsNone(store.manual(image_id, lambda value: value))
            self.assertEqual(store.history_status(image_id), {"canUndo": False, "canRedo": False})

    def test_4k_manual_history_stores_only_changed_bbox_delta(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            record = SimpleNamespace(relative_path="4k.png", size_bytes=1, mtime_ns=1, width=3840, height=2160)
            image_id = str(store.reconcile_images(catalog, [record])["4k.png"]["image_id"])
            mask = Image.new("L", (3840, 2160), 0)
            for y in range(100, 132):
                for x in range(200, 232): mask.putpixel((x, y), 255)
            payload = io.BytesIO(); mask.save(payload, format="PNG")
            store.save_manual(image_id, {"add": "draw", "hasEffectiveMask": True}, lambda _value: payload.getvalue())
            db = sqlite3.connect(store.path)
            delta_json = db.execute("SELECT delta_json FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0]
            stored = db.execute("SELECT add_png FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()[0]
            db.close()
            delta = json.loads(delta_json)["manual"]["add"]
            self.assertEqual(delta["box"], [200, 100, 32, 32])
            self.assertLess(len(delta["png"]), len(stored) // 8)

    def test_candidate_metadata_history_never_copies_the_detector_png(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = WorkspaceStore(root); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            mask_path = root / "candidate.png"; mask_path.write_bytes(self._png())
            candidate = SimpleNamespace(candidate_id="candidate", label_token="penis", confidence=.9, mask_path=mask_path,
                                        enabled=True, color="#fff", source="auto", origin="auto", refinement=None,
                                        role=SimpleNamespace(value="apply"), forced=False, expand_px=0)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            for revision in range(2, 102):
                candidate.enabled = not candidate.enabled
                candidate.expand_px = revision
                store.commit_candidate_state(image_id, revision, [candidate], True, replace=False)
            db = sqlite3.connect(store.path)
            masks = db.execute("SELECT COUNT(*),SUM(length(mask_png)) FROM candidates WHERE image_id=?", (image_id,)).fetchone()
            history = db.execute("SELECT before_json||after_json FROM history_entries WHERE image_id=?", (image_id,)).fetchall()
            db.close()
            self.assertEqual(masks[0], 1)
            self.assertEqual(masks[1], len(self._png()))
            self.assertTrue(all("iVBOR" not in row[0] for row in history))

    def test_project_listing_never_selects_mask_blobs(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog("a" * 32)
            store.reconcile_images(catalog, [self._image(Path(directory))])
            statements: list[str] = []; original_connect = store._connect
            def traced():
                db = original_connect(); db.set_trace_callback(statements.append); return db
            store._connect = traced  # type: ignore[method-assign]
            store.projects(); store.project(catalog); store.project_images(catalog)
            select_sql = "\n".join(query for query in statements if query.lstrip().upper().startswith("SELECT")).lower()
            self.assertNotIn("mask_png", select_sql)

    def test_building_batch_is_not_undoable_until_it_is_finished(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"{index}.png", size_bytes=1, mtime_ns=1, width=4, height=4) for index in range(2)]
            ids = [str(item["image_id"]) for item in store.reconcile_images(catalog, records).values()]
            group = store.begin_history_group()
            store.clear_image_workspaces({ids[0]: 1, ids[1]: 1}, history_group=group)
            self.assertFalse(store.history_status(ids[1])["canUndo"])
            store.finish_history_group(group)
            self.assertTrue(store.history_status(ids[1])["canUndo"])

    def test_image_delete_cascades_history_and_its_group(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory)); catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            group = store.begin_history_group()
            store.clear_image_workspaces({image_id: 1}, history_group=group)
            store.finish_history_group(group)
            store.delete_images([image_id])
            db = sqlite3.connect(store.path)
            counts = [db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                      for table in ("images", "candidates", "manual_edits", "history_entries", "history_candidate_refs", "history_cursors", "history_groups")]
            db.close()
            self.assertEqual(counts, [0] * len(counts))

if __name__ == "__main__":
    unittest.main()
