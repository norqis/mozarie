"""Additional file-backed regression coverage for catalog/state/workspace edges."""

from __future__ import annotations

import base64
import contextlib
import io
import importlib.util
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import BrowserSaveReceipt, Candidate, CandidateRole, ClientError, ImageRecord, SAVE_TOKEN_TTL_SECONDS
from mozarie.state import StudioState, cuda_device_statuses, gpu_device_statuses
from mozarie.workspace import WorkspaceOpenError, WorkspaceStore


def png(mode: str = "L") -> bytes:
    stream = io.BytesIO()
    Image.new(mode, (4, 4), 255 if mode in {"L", "1"} else "white").save(stream, format="PNG")
    return stream.getvalue()


class WorkspaceExtraCoverageTests(unittest.TestCase):
    def make_store(self, root: Path) -> tuple[WorkspaceStore, str, str]:
        store = WorkspaceStore(root)
        catalog_id = str(store.create_project()["id"])
        item = SimpleNamespace(relative_path="one.png", size_bytes=10, mtime_ns=20)
        return store, catalog_id, str(store.reconcile_images(catalog_id, [item])["one.png"]["image_id"])

    def test_schema_and_transaction_failures_are_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = sqlite3.connect(root / "bad.sqlite3")
            try:
                db.execute("CREATE TABLE only_one(value TEXT)")
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(db, {"only_one"})
            finally:
                db.close()
            store, catalog_id, image_id = self.make_store(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("CREATE TRIGGER reject_image_insert BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'no'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.reconcile_images(catalog_id, [SimpleNamespace(relative_path="two.png", size_bytes=1, mtime_ns=1)])
            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER reject_image_insert")
                db.execute("INSERT INTO manual_edits(image_id,removed_candidate_ids,candidate_revision,has_effective_mask,updated_at) VALUES(?, ?, 0, 0, 0)", (image_id, '"bad"'))
                db.commit()
            finally:
                db.close()
            with self.assertRaises(ValueError):
                store.commit_candidate_state(image_id, 1, [], False, replace=False)
            with self.assertRaises(ValueError):
                store.save_manual("missing", {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": False}, lambda value: value)

    def test_candidate_state_round_trip_and_missing_blob(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            mask_path = root / "candidate.png"
            mask_path.write_bytes(png())
            candidate = Candidate("candidate", "penis", .8, mask_path)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            candidate.enabled = False
            store.commit_candidate_state(image_id, 2, [candidate], False, replace=False)
            self.assertEqual(store.valid_candidate_ids(image_id), {"candidate"})
            self.assertEqual(store.hydrate_candidates_bulk([image_id], root / "cache", lambda row, path: (row["candidate_id"], path))[image_id][0], 2)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE candidates SET mask_png='not-bytes' WHERE image_id=?", (image_id,))
                db.commit()
            finally:
                db.close()
            with self.assertRaises(ValueError):
                store.hydrate_candidates_bulk([image_id], root / "cache", lambda *_: None)

    def test_delete_project_cascades_all_workspace_state_but_not_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"; source.write_bytes(png("RGB"))
            store, catalog_id, image_id = self.make_store(root)
            source_id = store.ensure_project_source(catalog_id, kind="native-folder", display_name="source", identity=str(root))
            store.reconcile_images(catalog_id, [SimpleNamespace(relative_path="source.png", size_bytes=source.stat().st_size, mtime_ns=source.stat().st_mtime_ns, width=4, height=4)], source_id)
            mask_path = root / "candidate.png"; mask_path.write_bytes(png())
            store.commit_candidate_state(image_id, 1, [Candidate("candidate", "penis", .8, mask_path)], True, replace=True)
            store.save_manual(image_id, {"add": png(), "exclusion": png(), "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": True}, lambda value: value)
            with store._connect() as db:
                self.assertGreater(db.execute("SELECT COUNT(*) FROM history_entries WHERE catalog_id=?", (catalog_id,)).fetchone()[0], 0)
            store.delete_project(catalog_id)
            self.assertIsNone(store.project(catalog_id))
            self.assertTrue(source.is_file(), "deleting project state never deletes the original image")
            with store._connect() as db:
                for table in ("project_sources", "images", "candidates", "manual_edits", "candidate_metadata", "history_entries", "history_candidate_refs", "history_cursors", "history_groups"):
                    self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)
            with self.assertRaises(ValueError):
                store.delete_project(catalog_id)

    def test_restored_candidate_keeps_its_durable_mask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            mask_path = root / "candidate.png"
            mask_path.write_bytes(png())
            candidate = Candidate("candidate", "penis", .8, mask_path)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            mask_path.unlink()
            candidate.enabled = False
            store.commit_candidate_state(image_id, 2, [candidate], True, replace=True)
            self.assertEqual(store.candidate_png(image_id, "candidate"), png())

    def test_prune_and_unmaterialized_candidate_failures_roll_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, catalog_id, image_id = self.make_store(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("CREATE TRIGGER reject_prune BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'no'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.prune_catalog_images(catalog_id, set())
            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER reject_prune")
                db.commit()
            finally:
                db.close()
            missing = Candidate("not-stored", "penis", .5, root / "not-stored.png")
            store.commit_candidate_state(image_id, 1, [missing], True, replace=True)
            self.assertIsNone(store.candidate_png(image_id, "not-stored"))

    def test_schema_metadata_and_manual_payload_rejections(self) -> None:
        class InvalidPng:
            format = "JPEG"

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def load(self) -> None:
                return None

        class SchemaView:
            def __init__(self, db: sqlite3.Connection, *, bad_primary: bool = False, bad_unique: bool = False, bad_foreign: bool = False) -> None:
                self.db = db
                self.bad_primary = bad_primary
                self.bad_unique = bad_unique
                self.bad_foreign = bad_foreign
                self.catalog_info_calls = 0

            def execute(self, sql: str):
                if sql == "PRAGMA table_info(catalogs)":
                    self.catalog_info_calls += 1
                    rows = list(self.db.execute(sql))
                    if self.bad_primary and self.catalog_info_calls == 1:
                        return [{**dict(row), "pk": 0} for row in rows]
                    return rows
                if self.bad_foreign and sql == "PRAGMA foreign_key_list(images)":
                    return []
                if self.bad_unique and sql == "PRAGMA index_list(catalogs)":
                    return []
                return self.db.execute(sql)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            db = store._connect()
            try:
                tables = {str(row[0]) for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(SchemaView(db, bad_primary=True), tables)
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(SchemaView(db, bad_unique=True), tables)
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(SchemaView(db, bad_foreign=True), tables)
            finally:
                db.close()
            with patch("mozarie.workspace.Image.open", return_value=InvalidPng()):
                with self.assertRaises(ValueError):
                    WorkspaceStore._decode_png_mask(png())
            for payload in (
                {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": "bad", "hasEffectiveMask": False},
                {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": "bad"},
            ):
                with self.assertRaises(ValueError):
                    store.save_manual(image_id, payload, lambda value: value)
            self.assertEqual(store.manual_mask_statuses([]), {})
            store.save_manual(image_id, {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": False}, lambda value: value)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE manual_edits SET removed_candidate_ids='[1]' WHERE image_id=?", (image_id,))
                db.commit()
            finally:
                db.close()
            with self.assertRaises(ValueError):
                store.manual(image_id, lambda value: value)


class StateCatalogExtraCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        app = self.root / "app"
        (app / "config").mkdir(parents=True)
        (app / "config" / "defaults.json").write_bytes((Path(__file__).resolve().parents[1] / "config" / "defaults.json").read_bytes())
        with patch.object(state_module, "APP_DIR", app):
            self.state = StudioState(self.root / "cache", self.root / "sessions")

    def tearDown(self) -> None:
        self.state.shutdown()
        self.temp.cleanup()

    def add_image(self) -> str:
        image = self.root / "source.png"
        Image.new("RGB", (4, 4), "white").save(image)
        return self.state.set_root(str(self.root))[0]["id"]

    def test_gpu_status_reset_and_diagnostic_errors(self) -> None:
        self.assertEqual(cuda_device_statuses(SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))), [])
        cuda = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, get_arch_list=lambda: ["sm_90"], device_count=lambda: 1,
            get_device_capability=lambda _i: (9, 0), get_device_name=lambda _i: "GPU",
            get_device_properties=lambda _i: SimpleNamespace(total_memory=10),
        ))
        self.assertTrue(cuda_device_statuses(cuda)[0]["supported"])
        with patch.object(state_module, "runtime_backend", return_value="directml"), patch.object(state_module, "directml_devices", side_effect=OSError("no adapter")):
            self.assertEqual(gpu_device_statuses(cuda), [])
        supported_gpu = [{"id": 0, "name": "GPU", "backend": "cuda", "supported": True}]
        with patch.object(state_module, "gpu_device_statuses", return_value=supported_gpu), \
                patch("mozarie.inference.onnx.diagnose_runtime", side_effect=RuntimeError("broken")):
            with self.assertRaises(ClientError) as context:
                self.state.diagnose_gpu_runtime()
            self.assertEqual(context.exception.error_code, "gpu_unavailable")
            self.assertEqual(str(context.exception), "GPU推論を確認できません。CUDA環境とモデルファイルを確認してください。")
        self.assertEqual(self.state.reset_settings()["models"]["provider"], self.state.settings["models"]["provider"])

    def test_stale_session_cleanup_does_not_touch_live_imports(self) -> None:
        session_root = self.root / "sessions"
        stale = session_root / "session-old"
        stale.mkdir(parents=True)
        old = 1
        import os
        os.utime(stale, (old, old))
        fresh = session_root / "session-fresh"
        fresh.mkdir()
        self.state._cleanup_stale_sessions()
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())
        imports = self.state._ensure_session()
        self.assertEqual(self.state._ensure_session(), imports)
        detached = self.state._detach_session_unchecked()
        self.state._release_detached_session(detached)
        self.assertFalse(imports.exists())

    def test_windows_lock_failure_and_stale_cache_boundaries(self) -> None:
        class Handle:
            def seek(self, *_args) -> None:
                return None

            def fileno(self) -> int:
                return 1

            def close(self) -> None:
                return None

        lock_dir = self.root / "lock-failure"
        lock_dir.mkdir()
        with patch.object(state_module.msvcrt, "locking", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                self.state._lock_directory(lock_dir)
            self.state._release_directory_lock(Handle())
            self.state._release_detached_session((self.root / "gone", Handle()))
        with tempfile.TemporaryDirectory() as directory, patch.object(state_module, "CACHE_BASE_DIR", Path(directory)):
            cache_base = Path(directory)
            (cache_base / "process-file").write_text("not a directory")
            stale = cache_base / "process-stale"
            stale.mkdir()
            import os
            os.utime(stale, (1, 1))
            locked = cache_base / "process-lock"
            locked.mkdir()
            (locked / ".active.lock").write_bytes(b"1")
            with patch.object(state_module.msvcrt, "locking", side_effect=[None, OSError("unlock")]):
                self.state._cleanup_stale_process_caches()
            self.assertFalse(stale.exists())
            self.assertFalse(locked.exists())

    def test_state_startup_helpers_preserve_error_paths(self) -> None:
        supported_gpu = [{"id": 0, "name": "GPU", "backend": "cuda", "supported": True}]
        known_error = ClientError("known", "known")
        with patch.object(state_module, "gpu_device_statuses", return_value=supported_gpu), \
                patch("mozarie.inference.onnx.diagnose_runtime", side_effect=known_error):
            with self.assertRaises(ClientError) as context:
                self.state.diagnose_gpu_runtime()
            self.assertEqual(context.exception.error_code, "known")
            self.assertIs(context.exception, known_error)
        with patch.object(self.state.settings_store, "default_settings", side_effect=state_module.SettingsError("bad")):
            with self.assertRaises(ClientError) as context:
                self.state.reset_settings()
            self.assertEqual(context.exception.error_code, "invalid_settings")
        with tempfile.TemporaryDirectory() as directory, patch.object(state_module, "CACHE_BASE_DIR", Path(directory) / "absent"):
            self.state._cleanup_stale_process_caches()
        sessions = self.root / "sessions-extra"
        sessions.mkdir()
        (sessions / "session-file").write_text("not a directory")
        locked = sessions / "session-lock"
        locked.mkdir()
        (locked / ".active.lock").write_bytes(b"1")
        previous = self.state.session_base_dir
        self.state.session_base_dir = sessions
        try:
            with patch.object(state_module.msvcrt, "locking", side_effect=[None, OSError("unlock")]):
                self.state._cleanup_stale_sessions()
            self.assertFalse(locked.exists())
            with patch.object(state_module.msvcrt, "locking", side_effect=OSError("locked")):
                with self.assertRaises(OSError):
                    self.state._ensure_session()
        finally:
            self.state.session_base_dir = previous

    def test_import_startup_reports_workspace_open_failure(self) -> None:
        spec = importlib.util.spec_from_file_location("mozarie.state_coverage_probe", state_module.__file__)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        try:
            with patch.object(sqlite3, "connect", side_effect=sqlite3.DatabaseError("unavailable")):
                spec.loader.exec_module(module)  # type: ignore[union-attr]
            self.assertIsNone(module.STATE)
            self.assertIsNotNone(module.STATE_STARTUP_ERROR)
        finally:
            sys.modules.pop(spec.name, None)

    def test_workspace_recreate_replaces_or_preserves_the_recovery_state(self) -> None:
        previous_state, previous_error = state_module.STATE, state_module.STATE_STARTUP_ERROR
        restored = Mock()
        try:
            with patch.object(state_module.WorkspaceStore, "recreate") as recreate, \
                    patch.object(state_module, "StudioState", return_value=restored), \
                    patch.object(state_module.atexit, "register") as register:
                self.assertIs(state_module.recreate_workspace(), restored)
            recreate.assert_called_once_with(state_module.APP_DIR / "data")
            register.assert_called_once_with(restored.shutdown)
            self.assertIs(state_module.STATE, restored)
            self.assertIsNone(state_module.STATE_STARTUP_ERROR)

            failure = WorkspaceOpenError("database remains unavailable")
            with patch.object(state_module.WorkspaceStore, "recreate"), \
                    patch.object(state_module, "StudioState", side_effect=failure):
                with self.assertRaises(WorkspaceOpenError):
                    state_module.recreate_workspace()
            self.assertIsNone(state_module.STATE)
            self.assertIs(state_module.STATE_STARTUP_ERROR, failure)
        finally:
            state_module.STATE, state_module.STATE_STARTUP_ERROR = previous_state, previous_error

    def test_stale_cleanup_os_errors_are_ignored_and_gpu_reset_releases_once(self) -> None:
        self.state.settings["models"]["provider"] = "gpu"
        with patch.object(self.state, "_release_gpu_cache") as release:
            self.state.reset_settings()
        release.assert_called_once()
        self.state.settings["models"]["provider"] = "cpu"
        self.state.reset_settings()
        with tempfile.TemporaryDirectory() as directory, patch.object(state_module, "CACHE_BASE_DIR", Path(directory)):
            stale = Path(directory) / "process-stale"
            stale.mkdir()
            import os
            os.utime(stale, (1, 1))
            with patch.object(state_module.shutil, "rmtree", side_effect=OSError("busy")):
                self.state._cleanup_stale_process_caches()
        sessions = self.root / "sessions-errors"
        stale_session = sessions / "session-stale"
        stale_session.mkdir(parents=True)
        import os
        os.utime(stale_session, (1, 1))
        previous = self.state.session_base_dir
        self.state.session_base_dir = sessions
        try:
            with patch.object(state_module.shutil, "rmtree", side_effect=OSError("busy")):
                self.state._cleanup_stale_sessions()
        finally:
            self.state.session_base_dir = previous

    def test_settings_status_reports_actual_bad_paths(self) -> None:
        settings = self.state.settings_store.default_settings()
        models = settings["models"]
        models["sam_model_type"] = "vit_h"
        models["target_segmentation"] = str(self.root / "wrong.txt")
        (self.root / "wrong.txt").write_text("x")
        settings["detection"]["mode"] = "high_precision"
        checkpoint = self.root / "checkpoint.bin"
        checkpoint.write_text("x")
        models["sam_checkpoints"][models["sam_model_type"]] = str(checkpoint)
        mismatch = self.root / "sam_vit_l_0b3195.pth"
        mismatch.write_text("x")
        models["sam_checkpoints"]["vit_b"] = str(mismatch)
        status = self.state.settings_status(settings)
        self.assertEqual(status["models"]["target_segmentation"]["reasonCode"], "invalid_format")
        self.assertEqual(status["models"]["sam_checkpoint"]["reasonCode"], "invalid_format")
        self.assertEqual(status["samVariants"]["vit_b"]["reasonCode"], "type_mismatch")
        self.state.end_import_transfer()

    def test_catalogue_guards_and_candidate_bulk_state(self) -> None:
        image_id = self.add_image()
        with self.assertRaises(ClientError):
            self.state.remove_images_from_catalog("not-a-list")  # type: ignore[arg-type]
        with self.assertRaises(ClientError):
            self.state._import_images(["invalid"], include_images=False)  # type: ignore[list-item]
        mask = self.root / "mask.png"
        mask.write_bytes(png())
        apply = Candidate("apply", "penis", .9, mask, role=CandidateRole.APPLY)
        excluded = Candidate("exclude", "penis", .9, self.root / "exclude.png", role=CandidateRole.EXCLUDE)
        excluded.mask_path.write_bytes(png())
        self.state.candidates[image_id] = [apply, excluded]
        self.state._commit_candidate_snapshot(image_id, [apply, excluded], replace=True)
        self.state.set_candidate_state(image_id, "exclude", {"forced": True, "color": "#102030"})
        self.state.batch_update_candidates(image_id, {"role": "apply", "operation": "disable"})
        self.state.batch_update_candidates(image_id, {"role": "exclude", "operation": "delete"})
        self.assertTrue(self.state.delete_candidate(image_id, "apply"))

    def test_mask_path_tokens_and_model_configuration_errors(self) -> None:
        image_id = self.add_image()
        item = self.state.images[image_id]
        token = self.state._issue_browser_save_token_unchecked(item, 0, (item.mtime_ns, item.size_bytes), self.state.catalog_generation, None)
        self.state.browser_save_tokens[token] = replace(self.state.browser_save_tokens[token], issued_at=time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state.cleanup_expired_browser_save_tokens()
        self.assertNotIn(token, self.state.browser_save_tokens)
        item.path = self.root / "missing.png"
        with self.assertRaises(ClientError):
            self.state.image_for_id(image_id)
        item.path = self.root / "source.png"
        self.state.settings["models"]["hand_segmentation"] = ""
        with self.assertRaises(ClientError) as context:
            self.state._hand_segmentation_predictor_for(item, object())
        self.assertEqual(context.exception.error_code, "model_not_configured")
        model = self.root / "not-model.txt"
        model.write_text("x")
        self.state.settings["models"]["hand_segmentation"] = str(model)
        with self.assertRaises(ClientError) as context:
            self.state._hand_segmentation_predictor_for(item, object())
        self.assertEqual(context.exception.error_code, "model_file_invalid")

    def test_worker_guard_and_cache_cleanup(self) -> None:
        image_id = self.add_image()
        self.state.worker_thread = SimpleNamespace(is_alive=lambda: True)
        with self.assertRaises(ClientError):
            self.state.clear_masks([image_id])
        with self.assertRaises(ClientError):
            self.state.batch_update_candidates(image_id, {"role": "apply", "operation": "enable"})
        self.state.worker_thread = None
        self.state.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.state.cache_dir / ".active.lock").write_bytes(b"1")
        (self.state.cache_dir / "file").write_text("x")
        self.state._clear_cache()
        self.assertTrue((self.state.cache_dir / ".active.lock").exists())

    def test_browser_token_cleanup_and_predictor_reset(self) -> None:
        image_id = self.add_image()
        item = self.state.images[image_id]
        rendered = self.root / "rendered.png"
        rendered.write_bytes(b"rendered")
        output = self.root / "output.png"
        output.write_bytes(b"output")
        stat = output.stat()
        token = self.state._issue_browser_save_token_unchecked(
            item, 0, (item.mtime_ns, item.size_bytes), self.state.catalog_generation, rendered,
            output, (stat.st_mtime_ns, stat.st_size),
        )
        self.state._discard_browser_save_tokens_for_image_unchecked(image_id)
        self.state._unlink_browser_save_cleanup(self.state._take_browser_save_cleanup_unchecked())
        self.assertFalse(rendered.exists())
        self.assertFalse(output.exists())
        self.state.sam_predictor = Mock()
        self.state.hand_segmentation_predictor = Mock()
        self.state._invalidate_sam_cache()
        self.state.sam_predictor.reset_image.assert_called_once()
        self.state.hand_segmentation_predictor.reset_image.assert_called_once()

    def test_expired_receipt_and_nested_session_removal(self) -> None:
        staged = self.root / "staged.png"; Image.new("RGB", (4, 4), "white").save(staged)
        _images, imported = self.state.import_image_file_for_api(staged, name="nested/photo.png", relative_path="nested/photo.png", client_key="key")
        image_id = imported[0]["imageId"]
        nested = self.state.images[image_id].path.parent
        (nested / "keep.txt").write_text("keep")
        self.state.browser_save_receipts["old"] = BrowserSaveReceipt(image_id, 0, "copy", False, False, False, time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state.cleanup_expired_browser_save_tokens()
        self.assertNotIn("old", self.state.browser_save_receipts)
        self.state.remove_image_from_catalog(image_id)
        self.assertTrue(nested.exists())

    def test_import_validation_and_catalog_change(self) -> None:
        staged = self.root / "staged.png"; Image.new("RGB", (4, 4), "white").save(staged)
        self.assertEqual(self.state._import_images([{"name": "skip.txt", "relativePath": "skip.txt", "stagedPath": staged}], include_images=False), ([], []))
        with self.assertRaises(ClientError):
            self.state._import_images([{"name": "bad.png", "relativePath": "bad.png", "stagedPath": "not-a-path"}], include_images=False)
        def mutate_generation(path, suffix):
            self.state.catalog_generation += 1
            return (4, 4)
        with patch("mozarie.catalog.inspect_import_image", side_effect=mutate_generation):
            with self.assertRaises(ClientError) as context:
                self.state.import_image_file_for_api(staged, name="changed.png", relative_path="changed.png", client_key="changed")
        self.assertEqual(context.exception.error_code, "catalog_changed")

    def test_catalogue_file_cleanup_and_snapshot_errors(self) -> None:
        self.state._unlink_browser_save_cleanup([(self.root / "absent.png", (1, 1))])
        mask = self.root / "mask.png"; mask.write_bytes(png())
        with patch.object(Path, "unlink", side_effect=OSError("busy")):
            self.state._delete_mask_files([mask], [self.root / "missing-cache"])
        cache_file = self.state.cache_dir / "cache-file"
        self.state.cache_dir.mkdir(parents=True, exist_ok=True); cache_file.write_text("x")
        with patch.object(Path, "unlink", side_effect=OSError("busy")):
            self.state._clear_cache()
        with self.assertRaises(ClientError): self.state.image_snapshot("missing")
        with self.assertRaises(ClientError): self.state.candidate_snapshot("missing")

    def test_import_rename_rolls_back_staged_files(self) -> None:
        staged = self.root / "staged.png"; Image.new("RGB", (4, 4), "white").save(staged)
        with patch("mozarie.catalog.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.state.import_image_file_for_api(staged, name="failed.png", relative_path="failed.png", client_key="failed")

    def test_model_provider_and_import_failures(self) -> None:
        image_id = self.add_image(); item = self.state.images[image_id]
        checkpoint = self.root / "checkpoint.pth"; checkpoint.write_bytes(b"x")
        hand = self.root / "hand.safetensors"; hand.write_bytes(b"x")
        self.state.settings["models"]["provider"] = "gpu"
        self.state.settings["models"]["sam_checkpoints"][self.state.settings["models"]["sam_model_type"]] = str(checkpoint)
        self.state.settings["models"]["hand_segmentation"] = str(hand)
        class Model:
            def load_state_dict(self, *_args, **_kwargs): pass
            def to(self, **_kwargs): pass
        class Predictor:
            def __init__(self, _model): pass
            def set_image(self, _image): pass
        class Torch:
            def device(self, _name): return contextlib.nullcontext()
            def load(self, *_args, **_kwargs): return {}
        sam = types.ModuleType("segment_anything"); sam.SamPredictor = Predictor; sam.sam_model_registry = {"vit_b": lambda checkpoint=None: Model(), "vit_l": lambda checkpoint=None: Model(), "vit_h": lambda checkpoint=None: Model()}
        before_sam, before_safe = sys.modules.get("segment_anything"), sys.modules.get("safetensors.torch")
        sys.modules["segment_anything"] = sam
        try:
            with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value="cpu"):
                with self.assertRaises(ClientError) as context: self.state._sam_predictor_for(item, object())
                self.assertEqual(context.exception.error_code, "sam_provider_unavailable")
            sys.modules["safetensors.torch"] = None
            self.state.hand_segmentation_predictor = None
            with self.assertRaises(ClientError) as context: self.state._hand_segmentation_predictor_for(item, object())
            self.assertEqual(context.exception.error_code, "model_load_failed")
        finally:
            if before_sam is None: sys.modules.pop("segment_anything", None)
            else: sys.modules["segment_anything"] = before_sam
            if before_safe is None: sys.modules.pop("safetensors.torch", None)
            else: sys.modules["safetensors.torch"] = before_safe

    def test_owned_cache_shutdown_and_unchecked_receipt_expiry(self) -> None:
        owned_cache = self.root / "owned-cache"
        app = self.root / "app"
        with patch.object(state_module, "APP_DIR", app), patch.object(state_module, "CACHE_BASE_DIR", owned_cache):
            owned = StudioState(None, self.root / "owned-sessions")
        created = owned.cache_dir
        owned.shutdown()
        self.assertFalse(created.exists())
        self.state.browser_save_receipts["old"] = BrowserSaveReceipt("image", 0, "copy", False, False, False, time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state._discard_expired_browser_save_tokens_unchecked()
        self.assertNotIn("old", self.state.browser_save_receipts)

    def test_catalogue_remaining_file_and_durable_state_edges(self) -> None:
        image_id = self.add_image(); item = self.state.images[image_id]
        token = self.state._issue_browser_save_token_unchecked(item, 0, (item.mtime_ns, item.size_bytes), self.state.catalog_generation, None)
        self.state.browser_save_tokens[token] = replace(self.state.browser_save_tokens[token], issued_at=time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state._discard_expired_browser_save_tokens_unchecked()
        cache_dir = self.root / "candidate-dir"; cache_dir.mkdir(); (cache_dir / "old.png").write_bytes(png())
        with patch.object(Path, "unlink", side_effect=OSError("busy")):
            self.state._delete_mask_files([], [cache_dir])
        self.state._image_io_locks["missing"] = __import__("threading").RLock()
        with self.assertRaises(ClientError): self.state.candidate_snapshot("missing")
        absent = Candidate("absent", "penis", .5, self.root / "absent.png")
        self.state.candidates[image_id] = [absent]
        with self.assertRaises(Exception): self.state.read_candidate_mask_png(image_id, "absent")
        self.state.workspace_store.delete_images([image_id])
        self.assertIsNone(self.state.manual_workspace(image_id))
        self.state.delete_manual_workspace(image_id)

    def test_handseg_cpu_provider_failure(self) -> None:
        image_id = self.add_image(); item = self.state.images[image_id]
        hand = self.root / "hand.safetensors"; hand.write_bytes(b"x")
        self.state.settings["models"]["hand_segmentation"] = str(hand)
        self.state.settings["models"]["provider"] = "gpu"
        class Model:
            def load_state_dict(self, *_args, **_kwargs): pass
        class Predictor:
            def __init__(self, _model): pass
            def set_image(self, _image): pass
        class Torch:
            def device(self, _name): return contextlib.nullcontext()
        sam = types.ModuleType("segment_anything"); sam.SamPredictor = Predictor; sam.sam_model_registry = {"vit_b": lambda checkpoint=None: Model()}
        safe = types.ModuleType("safetensors.torch"); safe.load_file = lambda *_args, **_kwargs: {}
        old_sam, old_safe = sys.modules.get("segment_anything"), sys.modules.get("safetensors.torch")
        sys.modules["segment_anything"] = sam; sys.modules["safetensors.torch"] = safe
        try:
            with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value="cpu"):
                with self.assertRaises(ClientError) as context: self.state._hand_segmentation_predictor_for(item, object())
            self.assertEqual(context.exception.error_code, "hand_segmentation_invalid")
        finally:
            if old_sam is None: sys.modules.pop("segment_anything", None)
            else: sys.modules["segment_anything"] = old_sam
            if old_safe is None: sys.modules.pop("safetensors.torch", None)
            else: sys.modules["safetensors.torch"] = old_safe

    def test_project_import_failure_paths(self) -> None:
        self.state.create_project()
        scan = self.root / "scan"; scan.mkdir(); image = scan / "race.png"; Image.new("RGB", (4, 4), "white").save(image)
        def modify_after_read(path, suffix):
            path.write_bytes(path.read_bytes() + b"x")
            return (4, 4)
        with patch("mozarie.catalog.inspect_import_image", side_effect=modify_after_read):
            self.state.set_root(str(scan))
        first = self.root / "one.png"; second = self.root / "two.png"
        Image.new("RGB", (4, 4), "white").save(first); Image.new("RGB", (4, 4), "white").save(second)
        real_replace = __import__("os").replace
        attempts = 0
        def replace_once(source_path, destination_path):
            nonlocal attempts
            attempts += 1
            if attempts == 2: raise OSError("disk full")
            real_replace(source_path, destination_path)
        with patch("mozarie.catalog.os.replace", side_effect=replace_once):
            with self.assertRaises(OSError):
                self.state._import_images([
                    {"name": "one.png", "relativePath": "one.png", "stagedPath": first},
                    {"name": "two.png", "relativePath": "two.png", "stagedPath": second},
                ], include_images=False)

    def test_import_hydrates_durable_candidates(self) -> None:
        staged = self.root / "staged.png"; Image.new("RGB", (4, 4), "white").save(staged)
        self.state.create_project()
        candidate = Candidate("restored", "penis", .5, self.root / "restored.png")
        with patch.object(self.state.workspace_store, "hydrate_candidates", return_value=(1, [candidate])):
            _images, imported = self.state.import_image_file_for_api(staged, name="restored.png", relative_path="restored.png", client_key="restored")
        image_id = imported[0]["imageId"]
        self.assertEqual(self.state.candidate_revisions[image_id], 1)

    def test_catalogue_false_branches_are_stable_noops(self) -> None:
        image_id = self.add_image()
        self.state.remove_images_from_catalog(["not-present"])
        self.state._discard_browser_save_token_unchecked("missing")
        token = self.state._issue_browser_save_token_unchecked(self.state.images[image_id], 0, (1, 1), 0, None)
        self.state._discard_browser_save_tokens_for_image_unchecked("different")
        self.assertIn(token, self.state.browser_save_tokens)
        self.state.browser_save_receipts["fresh"] = BrowserSaveReceipt(image_id, 0, "copy", False, False, False, __import__("time").monotonic())
        self.state._discard_expired_browser_save_tokens_unchecked()
        self.assertIn("fresh", self.state.browser_save_receipts)
        self.state._import_images([{"name": "skip.txt", "relativePath": "skip.txt", "stagedPath": self.root / "source.png"}], include_images=False, transfer_active=True)
        self.state.sam_image_id = image_id; self.state.sam_predictor = None
        self.state.hand_segmentation_image_id = image_id; self.state.hand_segmentation_predictor = None
        self.state.invalidate_sam_image(image_id)
        self.state.workspace_store.delete_images([image_id])
        self.assertEqual(self.state.set_image_flags(image_id, {"hidden": True})["hidden"], True)
        absent = Candidate("absent", "penis", .5, self.root / "absent.png")
        self.state.candidates[image_id] = [absent]
        self.state.candidate_revisions[image_id] = 0
        def missing_then_advance(*_args):
            self.state.candidate_revisions[image_id] = 1
            return None
        with patch.object(self.state.workspace_store, "candidate_png", side_effect=missing_then_advance):
            with self.assertRaises(Exception): self.state.read_candidate_mask_png(image_id, "absent")

    def test_session_record_removal_without_import_root(self) -> None:
        staged = self.root / "staged.png"; Image.new("RGB", (4, 4), "white").save(staged)
        _images, imported = self.state.import_image_file_for_api(staged, name="session.png", relative_path="session.png", client_key="session")
        self.state.session_imports_dir = None
        self.state.remove_image_from_catalog(imported[0]["imageId"])

    def test_manual_mask_validation_and_persistence_errors(self) -> None:
        image_id = self.add_image()
        encoded = "data:image/png;base64," + base64.b64encode(png()).decode("ascii")
        self.assertEqual(self.state._decode_workspace_mask(encoded), png())
        for raw in (b"not-png", png("RGB")):
            invalid = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            with self.assertRaises(ClientError):
                self.state._decode_workspace_mask(invalid)
        payload = {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": []}
        with patch.object(self.state.workspace_store, "save_manual", side_effect=ValueError("bad")):
            with self.assertRaises(ClientError) as context:
                self.state.save_manual_workspace(image_id, payload)
            self.assertEqual(context.exception.error_code, "workspace_write_failed")
        self.state.save_manual_workspace(image_id, payload)
        self.state.delete_manual_workspace(image_id)

    def test_candidate_snapshot_and_mask_staleness_errors(self) -> None:
        image_id = self.add_image()
        with self.assertRaises(ClientError):
            self.state.candidate_snapshot("missing")
        with self.assertRaises(Exception):
            self.state.read_candidate_mask_png(image_id, "missing")
        mask = self.root / "mask.png"
        mask.write_bytes(png())
        candidate = Candidate("candidate", "penis", .8, mask)
        self.state.candidates[image_id] = [candidate]
        self.state._commit_candidate_snapshot(image_id, [candidate], replace=True)
        self.assertEqual(self.state.candidate_snapshot(image_id)["candidateRevision"], self.state._candidate_revision(image_id))
        self.assertEqual(self.state.read_candidate_mask_png(image_id, "candidate")[:8], b"\x89PNG\r\n\x1a\n")

    def test_browser_import_and_detach_lifecycle(self) -> None:
        staged = self.root / "staged.png"
        Image.new("RGB", (4, 4), "white").save(staged)
        catalog_id = str(self.state.create_project()["id"])
        images, imported = self.state.import_image_file_for_api(
            staged, name="nested/photo.png", relative_path="nested/photo.png", client_key="client-1",
        )
        self.assertEqual(len(images), 1)
        self.assertEqual(imported[0]["clientKey"], "client-1")
        self.assertEqual(self.state.detach_catalog(), catalog_id)
        self.assertFalse(self.state.images)

    def test_project_detach_and_missing_project_failure(self) -> None:
        project_id = str(self.state.create_project()["id"])
        self.assertEqual(self.state.detach_catalog(), project_id)
        self.assertTrue(self.state.workspace_store.catalog_exists(project_id))
        with self.assertRaises(ClientError) as context:
            self.state.open_project("a" * 32)
        self.assertEqual(context.exception.error_code, "project_not_found")

    def test_sam_and_handseg_provider_initialisation_paths(self) -> None:
        class Model:
            def load_state_dict(self, *_args, **_kwargs) -> None: pass
            def to(self, **_kwargs) -> None: pass

        class Predictor:
            def __init__(self, model) -> None: self.model = model
            def set_image(self, _image) -> None: pass
            def reset_image(self) -> None: pass

        class Torch:
            def device(self, _name): return contextlib.nullcontext()
            def load(self, *_args, **_kwargs): return {}

        image_id = self.add_image()
        item = self.state.images[image_id]
        checkpoint = self.root / "checkpoint.pth"; checkpoint.write_bytes(b"checkpoint")
        hand = self.root / "hand.safetensors"; hand.write_bytes(b"checkpoint")
        self.state.settings["models"]["sam_checkpoints"][self.state.settings["models"]["sam_model_type"]] = str(checkpoint)
        self.state.settings["models"]["hand_segmentation"] = str(hand)
        self.state.settings["models"]["provider"] = "gpu"
        sam = types.ModuleType("segment_anything")
        sam.SamPredictor = Predictor
        sam.sam_model_registry = {"vit_b": lambda checkpoint=None: Model(), "vit_l": lambda checkpoint=None: Model(), "vit_h": lambda checkpoint=None: Model()}
        safe = types.ModuleType("safetensors.torch"); safe.load_file = lambda *_args, **_kwargs: {}
        before_sam, before_safe = sys.modules.get("segment_anything"), sys.modules.get("safetensors.torch")
        sys.modules["segment_anything"] = sam; sys.modules["safetensors.torch"] = safe
        try:
            with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value="directml"), patch("mozarie.catalog.torch_device", return_value="dml"), patch("mozarie.catalog.patch_directml_sam_prompt_encoder") as patch_prompt:
                self.state._sam_predictor_for(item, object())
                self.state._hand_segmentation_predictor_for(item, object())
            self.assertEqual(patch_prompt.call_count, 2)
            self.state.sam_predictor = None; self.state.hand_segmentation_predictor = None
            with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value="cuda"), patch("mozarie.catalog.torch_device", return_value="cuda"):
                self.state._sam_predictor_for(item, object())
                self.state._hand_segmentation_predictor_for(item, object())
        finally:
            if before_sam is None: sys.modules.pop("segment_anything", None)
            else: sys.modules["segment_anything"] = before_sam
            if before_safe is None: sys.modules.pop("safetensors.torch", None)
            else: sys.modules["safetensors.torch"] = before_safe

    def test_model_and_editor_error_paths_are_explicit(self) -> None:
        image_id = self.add_image()
        item = self.state.images[image_id]
        checkpoint = self.root / "checkpoint.pth"; checkpoint.write_bytes(b"checkpoint")
        self.state.settings["models"]["sam_checkpoints"][self.state.settings["models"]["sam_model_type"]] = str(checkpoint)
        self.state.settings["models"]["provider"] = "gpu"
        previous = sys.modules.get("segment_anything")
        sys.modules["segment_anything"] = None
        try:
            with self.assertRaises(ClientError) as context:
                self.state._sam_predictor_for(item, object())
            self.assertEqual(context.exception.error_code, "model_load_failed")
        finally:
            if previous is None: sys.modules.pop("segment_anything", None)
            else: sys.modules["segment_anything"] = previous
        with patch("mozarie.catalog.runtime_backend", return_value="cpu"):
            with self.assertRaises(ClientError) as context:
                self.state._hand_segmentation_predictor_for(item, object())
            self.assertEqual(context.exception.error_code, "model_not_configured")
        self.state.settings["models"]["hand_segmentation"] = str(self.root / "missing.safetensors")
        with self.assertRaises(ClientError) as context:
            self.state._hand_segmentation_predictor_for(item, object())
        self.assertEqual(context.exception.error_code, "model_file_missing")
        class InvalidPng:
            format = "JPEG"
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def load(self): return None
        encoded = "data:image/png;base64," + base64.b64encode(png()).decode("ascii")
        with patch("mozarie.catalog.Image.open", return_value=InvalidPng()):
            with self.assertRaises(ClientError):
                self.state._decode_workspace_mask(encoded)
        self.state.workspace_store.delete_images([image_id])
        self.state.save_manual_workspace(image_id, {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": []})

    def test_candidate_retries_and_materialises_durable_masks(self) -> None:
        image_id = self.add_image()
        mask = self.root / "mask.png"; mask.write_bytes(png())
        candidate = Candidate("candidate", "penis", .8, mask)
        self.state.candidates[image_id] = [candidate]
        self.state._commit_candidate_snapshot(image_id, [candidate], replace=True)
        mask.unlink()
        self.assertEqual(self.state.read_candidate_mask_png(image_id, "candidate")[:8], b"\x89PNG\r\n\x1a\n")
        original_revision = self.state._candidate_revision
        calls = iter((0, 1, 0, 1))
        with patch.object(self.state, "_candidate_revision", side_effect=lambda _id: next(calls)):
            with self.assertRaises(ClientError) as context:
                self.state.candidate_snapshot(image_id)
            self.assertEqual(context.exception.error_code, "catalog_changed")
        self.state._candidate_revision = original_revision
        self.state.worker_thread = SimpleNamespace(is_alive=lambda: True)
        with self.assertRaises(ClientError): self.state.set_candidate_state(image_id, "candidate", {})
        with self.assertRaises(ClientError): self.state.delete_candidate(image_id, "candidate")
        self.state.worker_thread = None

    def test_root_scan_skips_corrupt_files_and_rejects_missing_folder(self) -> None:
        with self.assertRaises(ClientError):
            self.state.set_root(str(self.root / "absent"))
        (self.root / "broken.png").write_bytes(b"not a png")
        valid = self.root / "valid.png"
        Image.new("RGB", (4, 4), "white").save(valid)
        images = self.state.set_root(str(self.root))
        self.assertEqual([item["relativePath"] for item in images], ["valid.png"])


class FinalCatalogCoverageTests(unittest.TestCase):
    """Regression tests for the remaining file-backed catalogue boundaries."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        app = self.root / "app"
        (app / "config").mkdir(parents=True)
        (app / "config" / "defaults.json").write_bytes(
            (Path(__file__).resolve().parents[1] / "config" / "defaults.json").read_bytes()
        )
        with patch.object(state_module, "APP_DIR", app):
            self.state = StudioState(self.root / "cache", self.root / "sessions")

    def tearDown(self) -> None:
        self.state.shutdown()
        self.temp.cleanup()

    def add_image(self) -> str:
        image = self.root / "source.png"
        Image.new("RGB", (4, 4), "white").save(image)
        return self.state.set_root(str(self.root))[0]["id"]

    def test_catalogue_error_cleanup_and_mask_boundaries(self) -> None:
        image_id = self.add_image()
        record = self.state.images[image_id]
        with self.assertRaises(ClientError):
            self.state.open_project("a" * 32)
        with self.assertRaises(ClientError):
            self.state.remove_images_from_catalog([])
        with self.assertRaises(ClientError):
            self.state._import_images([], include_images=False)
        with self.assertRaises(ClientError):
            self.state._assert_record_stat_matches(replace(record, path=self.root / "gone.png"))
        self.state.images[image_id] = replace(record, source_kind="other")
        with self.assertRaises(ClientError):
            self.state.image_for_id(image_id)
        self.state.images[image_id] = record

        for raw in (b"not-a-png", b"\x89PNG\r\n\x1a\ntruncated", png("RGB")):
            encoded = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            with self.assertRaises(ClientError):
                self.state._decode_workspace_mask(encoded)
        class WrongFormat:
            format = "JPEG"
            mode = "L"
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def load(self): return None
        encoded = "data:image/png;base64," + base64.b64encode(png()).decode("ascii")
        with patch("mozarie.catalog.Image.open", return_value=WrongFormat()):
            with self.assertRaises(ClientError):
                self.state._decode_workspace_mask(encoded)

        payload = {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": []}
        with patch.object(self.state.workspace_store, "save_manual", side_effect=ValueError("disk failure")):
            with self.assertRaises(ClientError):
                self.state.save_manual_workspace(image_id, payload)
        self.state.delete_manual_workspace(image_id)
        self.state.workspace_store.delete_images([image_id])
        self.state.save_manual_workspace(image_id, payload)

    def test_token_expiry_predictor_and_session_directory_cleanup(self) -> None:
        image_id = self.add_image()
        self.state.browser_save_receipts["expired"] = BrowserSaveReceipt(image_id, 0, "copy", False, False, False, time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state._discard_expired_browser_save_tokens_unchecked()
        self.state.browser_save_receipts["fresh"] = BrowserSaveReceipt(
            image_id, 0, "copy", False, False, False, time.monotonic()
        )
        self.state._discard_expired_browser_save_tokens_unchecked()
        self.state.browser_save_receipts["expired"] = BrowserSaveReceipt(image_id, 0, "copy", False, False, False, time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1)
        self.state.cleanup_expired_browser_save_tokens()
        self.state.sam_predictor = Mock()
        self.state.hand_segmentation_predictor = Mock()
        self.state._invalidate_sam_cache()
        self.state.sam_predictor.reset_image.assert_called_once()
        self.state.hand_segmentation_predictor.reset_image.assert_called_once()
        self.state.sam_image_id = image_id
        self.state.hand_segmentation_image_id = image_id
        self.state.sam_predictor = None
        self.state.hand_segmentation_predictor = None
        self.state.invalidate_sam_image(image_id)

        staged = self.root / "staged.png"
        Image.new("RGB", (4, 4), "white").save(staged)
        _images, imported = self.state.import_image_file_for_api(
            staged, name="nested/photo.png", relative_path="nested/photo.png", client_key="nested"
        )
        nested = self.state.images[imported[0]["imageId"]].path.parent
        (nested / "keep.txt").write_text("keep")
        self.state.remove_image_from_catalog(imported[0]["imageId"])
        self.assertTrue(nested.exists())

    def test_model_provider_paths_and_missing_durable_candidate(self) -> None:
        image_id = self.add_image()
        record = self.state.images[image_id]
        checkpoint = self.root / "checkpoint.pth"; checkpoint.write_bytes(b"checkpoint")
        hand = self.root / "hand.safetensors"; hand.write_bytes(b"checkpoint")
        self.state.settings["models"]["provider"] = "gpu"
        self.state.settings["models"]["sam_checkpoints"][self.state.settings["models"]["sam_model_type"]] = str(checkpoint)
        self.state.settings["models"]["hand_segmentation"] = str(hand)

        class Model:
            def load_state_dict(self, *_args, **_kwargs): pass
            def to(self, **_kwargs): pass
        class Predictor:
            def __init__(self, _model): pass
            def set_image(self, _image): pass
            def reset_image(self): pass
        class Torch:
            def device(self, _name): return contextlib.nullcontext()
            def load(self, *_args, **_kwargs): return {}
        sam = types.ModuleType("segment_anything")
        sam.SamPredictor = Predictor
        sam.sam_model_registry = {"vit_b": lambda checkpoint=None: Model()}
        safe = types.ModuleType("safetensors.torch")
        safe.load_file = lambda *_args, **_kwargs: {}
        old_sam, old_safe = sys.modules.get("segment_anything"), sys.modules.get("safetensors.torch")
        sys.modules["segment_anything"] = sam
        sys.modules["safetensors.torch"] = safe
        try:
            with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value="cpu"):
                with self.assertRaises(ClientError): self.state._sam_predictor_for(record, object())
                with self.assertRaises(ClientError): self.state._hand_segmentation_predictor_for(record, object())
            self.state.hand_segmentation_predictor = None
            sys.modules["safetensors.torch"] = None
            with patch("mozarie.catalog.torch_module", return_value=Torch()):
                with self.assertRaises(ClientError): self.state._hand_segmentation_predictor_for(record, object())
            sys.modules["safetensors.torch"] = safe
            for backend in ("directml", "cuda"):
                self.state.sam_predictor = None
                self.state.hand_segmentation_predictor = None
                with patch("mozarie.catalog.torch_module", return_value=Torch()), patch("mozarie.catalog.runtime_backend", return_value=backend), patch("mozarie.catalog.torch_device", return_value=backend), patch("mozarie.catalog.patch_directml_sam_prompt_encoder"):
                    self.state._sam_predictor_for(record, object())
                    self.state._hand_segmentation_predictor_for(record, object())
            self.state.hand_segmentation_predictor = None
            safe.load_file = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("bad checkpoint"))
            with patch("mozarie.catalog.torch_module", return_value=Torch()):
                with self.assertRaises(ClientError): self.state._hand_segmentation_predictor_for(record, object())
        finally:
            if old_sam is None: sys.modules.pop("segment_anything", None)
            else: sys.modules["segment_anything"] = old_sam
            if old_safe is None: sys.modules.pop("safetensors.torch", None)
            else: sys.modules["safetensors.torch"] = old_safe

        missing = Candidate("missing", "penis", .5, self.root / "missing.png")
        self.state.candidates[image_id] = [missing]
        self.state.candidate_revisions[image_id] = 0
        with self.assertRaises(Exception):
            self.state.read_candidate_mask_png(image_id, "missing")
        self.state.candidates[image_id] = [missing]
        self.state.candidate_revisions[image_id] = 0
        revisions = iter((0, 1))
        with patch.object(self.state, "_candidate_revision", side_effect=lambda _image_id: next(revisions)):
            with self.assertRaises(Exception):
                self.state.read_candidate_mask_png(image_id, "missing")
        self.state.workspace_store.delete_images([image_id])
        self.assertTrue(self.state.set_image_flags(image_id, {"hidden": True})["hidden"])

    def test_state_and_workspace_error_boundaries(self) -> None:
        with self.assertRaises(ClientError):
            self.state.update_settings([])  # type: ignore[arg-type]
        with patch.object(self.state.settings_store, "validate_update", side_effect=state_module.SettingsError("bad")):
            with self.assertRaises(ClientError):
                self.state.update_settings({})
        with tempfile.TemporaryDirectory() as directory, patch.object(state_module, "CACHE_BASE_DIR", Path(directory)):
            cache = Path(directory) / "process-locked"; cache.mkdir()
            (cache / ".active.lock").write_bytes(b"1")
            import os
            os.utime(cache, (1, 1))
            with patch.object(state_module.msvcrt, "locking", side_effect=OSError("locked")):
                self.state._cleanup_stale_process_caches()
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            with self.assertRaises(ValueError):
                store.create_project("   ")
            with self.assertRaises(ValueError):
                store._decode_png_mask(b"\x89PNG\r\n\x1a\ntruncated")
