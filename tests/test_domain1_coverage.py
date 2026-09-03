"""Regression coverage for durable workspace and catalogue edge cases.

These tests deliberately use a real temporary SQLite database and real PNGs.
They exercise failure paths that otherwise occur only after an interrupted
write, a stale editor tab, or an invalid request.
"""

from __future__ import annotations

import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import Candidate, CandidateRole, ClientError
from mozarie.state import StudioState
from mozarie.workspace import WorkspaceStore


def png(mode: str = "L", size: tuple[int, int] = (4, 4)) -> bytes:
    output = io.BytesIO()
    Image.new(mode, size, 255 if mode in {"L", "1"} else "white").save(output, format="PNG")
    return output.getvalue()


def image_record(name: str = "image.png", size: int = 10, mtime: int = 20) -> SimpleNamespace:
    return SimpleNamespace(relative_path=name, size_bytes=size, mtime_ns=mtime)


class WorkspaceCoverageTests(unittest.TestCase):
    def new_store(self, root: Path) -> tuple[WorkspaceStore, str, str]:
        store = WorkspaceStore(root)
        catalog = store.ensure_catalog()
        image_id = str(store.reconcile_images(catalog, [image_record()])["image.png"]["image_id"])
        return store, catalog, image_id

    def test_workspace_simple_noops_and_manifest_ties(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, catalog, image_id = self.new_store(root)
            self.assertEqual(store.reconcile_images(catalog, []), {})
            self.assertIsNone(store.best_catalog_for_manifest([], catalog))
            self.assertEqual(store.image_state("missing"), (False, False))
            store.set_image_flags(image_id)
            store.delete_images([])
            store.clear_image_workspaces({})
            store.delete_manual([])

            first = store.ensure_catalog()
            second = store.ensure_catalog()
            for target, name in ((first, "one.png"), (second, "two.png")):
                target_id = str(store.reconcile_images(target, [image_record(name) ])[name]["image_id"])
                self.assertTrue(store.has_image(target_id))
            self.assertIsNone(store.best_catalog_for_manifest([("one.png", "same"), ("two.png", "same")], catalog))

    def test_workspace_source_change_and_commit_variants(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, catalog, image_id = self.new_store(root)
            store.set_image_flags(image_id, hidden=True, reviewed=True)
            changed = store.reconcile_images(catalog, [image_record(size=11)])["image.png"]
            self.assertTrue(changed["changed"])
            self.assertFalse(changed["reviewed"])
            store.commit_save(image_id, mtime_ns=22, size_bytes=12, candidate_revision=4, clear_workspace=True)
            self.assertEqual(store.hydrate_candidates(image_id, root / "cache", lambda *_args: None)[0], 4)
            store.commit_save(image_id, mtime_ns=23, size_bytes=13, clear_workspace=False)
            store.commit_save(image_id, clear_workspace=False, delete_image=True)
            self.assertFalse(store.has_image(image_id))

    def test_workspace_masks_hydration_and_manual_normalization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog, image_id = self.new_store(root)
            self.assertIsNone(store._decode_png_mask(None))
            self.assertEqual(store._decode_png_mask(png("L")).mode, "L")
            self.assertEqual(store._decode_png_mask(png("RGBA")).mode, "L")
            with self.assertRaisesRegex(ValueError, "alpha"):
                store._decode_png_mask(png("RGB"))

            mask_path = root / "candidate.png"; mask_path.write_bytes(png())
            candidate = Candidate("candidate", "penis", 0.5, mask_path)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            revision, restored = store.hydrate_candidates(image_id, root / "cache", lambda row, path: (row["candidate_id"], path))
            self.assertEqual((revision, restored[0][0]), (1, "candidate"))
            self.assertEqual(store.hydrate_candidates("missing", root / "cache", lambda *_args: None), (0, []))
            self.assertEqual(store.hydrate_candidates_bulk([], root / "cache", lambda *_args: None), {})
            self.assertEqual(store.candidate_png(image_id, "missing"), None)
            self.assertEqual(store.valid_candidate_ids(image_id), {"candidate"})

            store.save_manual(image_id, {
                "add": png(), "exclusion": None, "exclusionErase": None,
                "removedCandidateIds": ["candidate", "missing", "candidate"], "hasEffectiveMask": True,
                "manualEnabled": False, "manualExclusionEnabled": False,
                "manualExclusionEraseEnabled": False, "manualExclusionForced": False,
            }, lambda value: value)
            manual = store.manual(image_id, lambda value: value)
            self.assertEqual(manual["removedCandidateIds"], ["candidate"])
            self.assertFalse(manual["manualEnabled"])
            self.assertEqual(store.manual_mask_statuses([image_id]), {image_id: (True, 1)})
            store.delete_manual([image_id])
            self.assertIsNone(store.manual(image_id, lambda value: value))

    def test_workspace_write_rollbacks_preserve_rows(self) -> None:
        """SQLite triggers reproduce disk/constraint failures inside transactions."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, catalog, image_id = self.new_store(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("CREATE TRIGGER fail_image_delete BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'blocked'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.delete_images([image_id])
            self.assertTrue(store.has_image(image_id))

            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER fail_image_delete")
                db.execute("CREATE TRIGGER fail_catalog_delete BEFORE DELETE ON catalogs BEGIN SELECT RAISE(ABORT, 'blocked'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.delete_catalog(catalog)
            self.assertTrue(store.catalog_exists(catalog))

            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER fail_catalog_delete")
                db.execute("CREATE TRIGGER fail_image_update BEFORE UPDATE ON images BEGIN SELECT RAISE(ABORT, 'blocked'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.clear_image_workspaces({image_id: 2})
            with self.assertRaises(sqlite3.DatabaseError):
                store.commit_save(image_id, candidate_revision=2, clear_workspace=False)


class StateAndCatalogCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = self.root / "app"; (self.app / "config").mkdir(parents=True)
        defaults = Path(__file__).resolve().parents[1] / "config" / "defaults.json"
        (self.app / "config" / "defaults.json").write_bytes(defaults.read_bytes())
        self.cache = self.root / "cache"
        with patch.object(state_module, "APP_DIR", self.app):
            self.state = StudioState(self.cache, self.root / "sessions")

    def tearDown(self) -> None:
        self.state.shutdown()
        self.temp.cleanup()

    def add_image(self) -> str:
        source = self.root / "source.png"
        Image.new("RGB", (8, 8), "white").save(source)
        return self.state.set_root(str(self.root))[0]["id"]

    def test_state_gpu_and_import_guards(self) -> None:
        self.state.active_import_count = 1
        with self.assertRaises(ClientError) as context:
            self.state.update_settings({})
        self.assertEqual(context.exception.error_code, "job_running")
        with self.assertRaises(ClientError):
            self.state.reset_settings()
        with self.assertRaises(ClientError):
            self.state.diagnose_gpu_runtime()
        self.state.end_import_transfer()
        self.assertEqual(self.state.active_import_count, 0)
        self.assertEqual(self.state.active_import_count, 0)
        with self.assertRaises(ClientError):
            self.state.preview_settings_status({"models": {"provider": "nope"}})

    def test_catalog_request_and_mask_validation_paths(self) -> None:
        image_id = self.add_image()
        for value in (None, 3, "data:image/jpeg;base64,AAAA", "data:image/png;base64,%%%"):
            with self.subTest(value=value):
                if value is None:
                    self.assertIsNone(self.state._decode_workspace_mask(value))
                else:
                    with self.assertRaises(ClientError):
                        self.state._decode_workspace_mask(value)
        with self.assertRaises(ClientError):
            self.state.set_image_flags(image_id, "bad")
        with self.assertRaises(ClientError):
            self.state.set_image_flags(image_id, {"hidden": "yes"})
        with self.assertRaises(ClientError):
            self.state.set_image_flags("missing", {})
        with self.assertRaises(ClientError):
            self.state.set_candidate_state(image_id, "missing", {})
        with self.assertRaises(ClientError):
            self.state.batch_update_candidates(image_id, {"role": "bad", "operation": "bad"})
        self.assertFalse(self.state.delete_candidate(image_id, "missing"))
        with self.assertRaises(ClientError):
            self.state.import_image_file_for_api(self.root / "missing", name="x.png", relative_path="x.png", client_key="")

    def test_catalog_candidate_and_session_branches(self) -> None:
        image_id = self.add_image()
        record = self.state.images[image_id]
        self.assertEqual(self.state._allowed_root_for_record(record, self.root, None), self.root)
        self.assertIsNone(self.state._allowed_root_for_record(SimpleNamespace(source_kind="other"), self.root, None))
        self.assertTrue(self.state.delete_candidate(image_id, "missing") is False)
        mask = self.cache / image_id / "candidate.png"; mask.parent.mkdir(parents=True); mask.write_bytes(png(size=(8, 8)))
        self.state.candidates[image_id] = [Candidate("candidate", "penis", 0.5, mask, role=CandidateRole.APPLY)]
        self.state._commit_candidate_snapshot(image_id, self.state.candidates[image_id], replace=True)
        with self.assertRaises(ClientError):
            self.state.set_candidate_state(image_id, "candidate", {"forced": True})
        with self.assertRaises(ClientError):
            self.state.set_candidate_state(image_id, "candidate", {"enabled": "yes"})
        with self.assertRaises(ClientError):
            self.state.set_candidate_state(image_id, "candidate", {"color": "red"})
        self.assertTrue(self.state.delete_candidate(image_id, "candidate"))
        session = self.state._ensure_session()
        self.assertEqual(self.state._ensure_session(), session)
        detached = self.state._detach_session_unchecked()
        self.state._release_detached_session(detached)
        self.assertFalse(session.exists())
