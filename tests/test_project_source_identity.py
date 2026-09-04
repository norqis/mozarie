"""Regression coverage for browser source ownership and durable image IDs."""

from __future__ import annotations

import io
import sqlite3
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.state import StudioState
from mozarie.workspace import WorkspaceStore


class SourceIdentityRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.state: StudioState | None = None

    def tearDown(self) -> None:
        if self.state is not None:
            self.state.shutdown()
        self._temporary.cleanup()

    def studio(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            self.state = StudioState(self.root / "cache", self.root / "sessions")
        return self.state

    @staticmethod
    def png() -> bytes:
        output = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(output, format="PNG")
        return output.getvalue()

    def stage(self, name: str) -> Path:
        path = self.root / "staged" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.png())
        return path

    def import_browser(self, state: StudioState, *, name: str, identity: str, kind: str = "browser-files", mtime_ns: int = 10) -> str:
        staged = self.stage(name)
        _images, imported = state._import_images([{
            "clientKey": name,
            "name": name,
            "relativePath": name,
            "stagedPath": staged,
            "mtimeNs": mtime_ns,
            "sizeBytes": len(self.png()),
        }], source_identity=identity, source_kind=kind)
        return imported[0]["imageId"]

    def test_browser_source_id_is_scoped_to_its_project_and_kind(self) -> None:
        state = self.studio()
        first = state.create_project("first")
        first_image_id = self.import_browser(state, name="first.png", identity="handle")
        source = state.workspace_store.project_sources(first["id"])[0]
        self.assertEqual(source["identity"], "browser:handle")

        state.close_project()
        state.open_project(first["id"])
        self.assertEqual(
            self.import_browser(state, name="first.png", identity=source["id"]),
            first_image_id,
        )
        self.assertEqual(state.workspace_store.project_images(first["id"])[0]["id"], first_image_id)

        with self.assertRaises(ClientError) as wrong_kind:
            self.import_browser(state, name="other.png", identity=source["id"], kind="browser-directory")
        self.assertEqual(wrong_kind.exception.error_code, "project_source_unavailable")

        state.close_project()
        second = state.create_project("second")
        with self.assertRaises(ClientError) as other_project:
            self.import_browser(state, name="other.png", identity=source["id"])
        self.assertEqual(other_project.exception.error_code, "project_source_unavailable")
        self.assertEqual(state.workspace_store.project_sources(second["id"]), [])
        self.assertEqual(state.workspace_store.project_images(second["id"]), [])

    def test_completed_browser_project_only_rehydrates_known_relative_paths(self) -> None:
        state = self.studio()
        project = state.create_project("completed")
        image_id = self.import_browser(state, name="known.png", identity="handle", mtime_ns=10)
        state.set_image_flags(image_id, {"hidden": True, "reviewed": True})
        source_id = state.workspace_store.project_sources(project["id"])[0]["id"]
        state.complete_project()
        state.open_project(project["id"])
        self.assertTrue(state.project_read_only)

        self.assertEqual(
            self.import_browser(state, name="known.png", identity=source_id, mtime_ns=10),
            image_id,
        )
        self.assertTrue(state.images[image_id].hidden)
        self.assertTrue(state.images[image_id].reviewed)
        state.close_project()
        state.open_project(project["id"])

        known = self.stage("known.png")
        unknown_path = self.stage("unknown.png")
        with self.assertRaises(ClientError) as unknown:
            state._import_images([{
                "clientKey": "known", "name": "known.png", "relativePath": "known.png", "stagedPath": known,
                "mtimeNs": 20, "sizeBytes": len(self.png()),
            }, {
                "clientKey": "unknown", "name": "unknown.png", "relativePath": "unknown.png", "stagedPath": unknown_path,
                "mtimeNs": 10, "sizeBytes": len(self.png()),
            }], source_identity=source_id, source_kind="browser-files")
        self.assertEqual(unknown.exception.error_code, "project_read_only")
        self.assertEqual(state.images, {})
        self.assertEqual(state.order, [])
        self.assertEqual([item["id"] for item in state.workspace_store.project_images(project["id"])], [image_id])
        session_dir = state.session_dir
        self.assertIsNotNone(session_dir)
        self.assertFalse((session_dir / "known.png").exists())
        self.assertFalse((session_dir / "unknown.png").exists())

        self.assertEqual(
            self.import_browser(state, name="known.png", identity=source_id, mtime_ns=20),
            image_id,
        )
        self.assertTrue(state.images[image_id].hidden)
        self.assertFalse(state.images[image_id].reviewed)
        self.assertIn(image_id, state.source_mismatches)

    def test_reconcile_rejects_foreign_image_ids_and_preserves_new_session_ids(self) -> None:
        store = WorkspaceStore(self.root / "store")
        first = store.create_project("first")
        second = store.create_project("second")
        first_source = store.ensure_project_source(first["id"], kind="browser-files", display_name="first", identity="browser:first")
        second_source = store.ensure_project_source(second["id"], kind="browser-files", display_name="second", identity="browser:second")
        first_record = SimpleNamespace(relative_path="one.png", image_id="session-image", size_bytes=1, mtime_ns=1, width=8, height=8)
        created = store.reconcile_images(first["id"], [first_record], source_id=first_source)["one.png"]
        self.assertEqual(created["image_id"], "session-image")
        self.assertTrue(created["created"])

        same_path = SimpleNamespace(relative_path="one.png", image_id="new-client-id", size_bytes=1, mtime_ns=1, width=8, height=8)
        existing = store.reconcile_images(first["id"], [same_path], source_id=first_source)["one.png"]
        self.assertEqual(existing["image_id"], "session-image")
        self.assertFalse(existing["created"])

        foreign = SimpleNamespace(relative_path="two.png", image_id="session-image", size_bytes=1, mtime_ns=1, width=8, height=8)
        with self.assertRaisesRegex(ValueError, "image identity already belongs"):
            store.reconcile_images(second["id"], [foreign], source_id=second_source)
        self.assertEqual(store.project_images(second["id"]), [])

    def test_browser_source_rejections_never_create_or_rebind_a_source(self) -> None:
        store = WorkspaceStore(self.root / "store")
        first = store.create_project("first")
        second = store.create_project("second")
        source_id, created = store.resolve_browser_source(
            first["id"], kind="browser-files", display_name="files", source_identity="handle", create=True,
        )
        self.assertTrue(created)
        with self.assertRaisesRegex(ValueError, "kind does not match"):
            store.resolve_browser_source(
                first["id"], kind="browser-directory", display_name="directory", source_identity="handle", create=True,
            )
        with self.assertRaisesRegex(ValueError, "does not belong"):
            store.resolve_browser_source(
                second["id"], kind="browser-files", display_name="files", source_identity=source_id, create=True,
            )
        with self.assertRaisesRegex(ValueError, "missing"):
            store.resolve_browser_source(
                second["id"], kind="browser-files", display_name="files", source_identity="missing", create=False,
            )
        with self.assertRaisesRegex(ValueError, "project is missing"):
            store.resolve_browser_source(
                "missing-project", kind="browser-files", display_name="files", source_identity="new", create=True,
            )
        self.assertEqual(store.project_sources(first["id"])[0]["id"], source_id)
        self.assertEqual(store.project_sources(second["id"]), [])

    def test_bulk_flags_are_atomic_durable_and_undo_as_one_operation(self) -> None:
        state = self.studio()
        project = state.create_project("flags")
        first = self.import_browser(state, name="first.png", identity="handle")
        second = self.import_browser(state, name="second.png", identity="handle")
        for payload in ({}, {"imageIds": "not-a-list"}, {"imageIds": [], "hidden": True}, {"imageIds": [first], "hidden": 1}, {"imageIds": ["missing"], "reviewed": True}):
            with self.subTest(payload=payload), self.assertRaises(ClientError):
                state.set_image_flags_bulk(payload)
        self.assertEqual(
            state.set_image_flags_bulk({"imageIds": [first, first, second], "hidden": True, "reviewed": True}),
            {first: {"hidden": True, "reviewed": True}, second: {"hidden": True, "reviewed": True}},
        )
        self.assertTrue(all(record.hidden and record.reviewed for record in state.images.values()))
        self.assertEqual(state.workspace_store.image_state(first), (True, True))
        self.assertEqual(state.workspace_store.image_state(second), (True, True))
        restored = state.restore_project_history(first, "undo")
        self.assertEqual(set(restored["changedImageIds"]), {first, second})
        self.assertTrue(all(not record.hidden and not record.reviewed for record in state.images.values()))
        self.assertEqual(state.workspace_store.image_state(first), (False, False))
        self.assertEqual(state.workspace_store.image_state(second), (False, False))

    def test_durable_manual_delete_clear_and_invalid_rename_leave_no_hidden_state(self) -> None:
        state = self.studio()
        project = state.create_project("working")
        image_id = self.import_browser(state, name="one.png", identity="handle")
        with self.assertRaises(ClientError) as invalid_name:
            state.save_current_as_project("   ")
        self.assertEqual(invalid_name.exception.error_code, "project_name_invalid")
        payload = {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": False}
        state.save_manual_workspace(image_id, payload)
        self.assertIsNotNone(state.manual_workspace(image_id))
        state.delete_manual_workspace(image_id)
        self.assertIsNone(state.manual_workspace(image_id))
        state.clear_catalog()
        self.assertEqual(state.images, {})
        self.assertEqual(state.workspace_store.project_images(project["id"]), [])

    def test_completed_project_rejects_unknown_browser_source_without_db_writes(self) -> None:
        state = self.studio()
        project = state.create_project("completed")
        image_id = self.import_browser(state, name="known.png", identity="known")
        state.complete_project()
        state.open_project(project["id"])
        with self.assertRaises(ClientError) as rejected:
            self.import_browser(state, name="new.png", identity="unknown")
        self.assertEqual(rejected.exception.error_code, "project_read_only")
        self.assertEqual([item["id"] for item in state.workspace_store.project_images(project["id"])], [image_id])
        self.assertEqual(state.workspace_store.project_sources(project["id"])[0]["identity"], "browser:known")

    def test_durable_import_hydration_failure_rolls_back_db_memory_and_staging(self) -> None:
        state = self.studio()
        project = state.create_project("rollback")
        staged = self.stage("failure.png")
        with patch.object(state.workspace_store, "hydrate_candidates", side_effect=ValueError("corrupt candidate")):
            with self.assertRaisesRegex(ValueError, "corrupt candidate"):
                state._import_images([{
                    "clientKey": "failure", "name": "failure.png", "relativePath": "failure.png", "stagedPath": staged,
                    "mtimeNs": 10, "sizeBytes": len(self.png()),
                }], source_identity="new-handle", source_kind="browser-files")
        self.assertEqual(state.images, {})
        self.assertEqual(state.order, [])
        self.assertEqual(state.candidates, {})
        self.assertEqual(state.candidate_revisions, {})
        self.assertEqual(state.workspace_store.project_images(project["id"]), [])
        self.assertEqual(state.workspace_store.project_sources(project["id"]), [])
        self.assertTrue(state.session_dir is not None)
        self.assertFalse((state.session_dir / "failure.png").exists())
        db = sqlite3.connect(state.workspace_store.path)
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM manual_edits").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM history_entries").fetchone()[0], 0)
        finally:
            db.close()

    def test_hydration_failure_keeps_existing_source_and_live_catalog_state(self) -> None:
        state = self.studio()
        project = state.create_project("existing source")
        existing_id = self.import_browser(state, name="existing.png", identity="handle")
        state.candidates[existing_id] = []
        state.candidate_revisions[existing_id] = 7
        state.source_mismatches[existing_id] = True
        before_images = dict(state.images)
        before_order = list(state.order)
        before_candidates = {image_id: list(candidates) for image_id, candidates in state.candidates.items()}
        before_revisions = dict(state.candidate_revisions)
        before_mismatches = dict(state.source_mismatches)

        staged = self.stage("new.png")
        with patch.object(state.workspace_store, "hydrate_candidates", side_effect=ValueError("corrupt candidate")):
            with self.assertRaisesRegex(ValueError, "corrupt candidate"):
                state._import_images([{
                    "clientKey": "new", "name": "new.png", "relativePath": "new.png", "stagedPath": staged,
                    "mtimeNs": 10, "sizeBytes": len(self.png()),
                }], source_identity="handle", source_kind="browser-files")

        self.assertEqual(state.images, before_images)
        self.assertEqual(state.order, before_order)
        self.assertEqual(state.candidates, before_candidates)
        self.assertEqual(state.candidate_revisions, before_revisions)
        self.assertEqual(state.source_mismatches, before_mismatches)
        self.assertEqual([item["id"] for item in state.workspace_store.project_images(project["id"])], [existing_id])
        self.assertEqual(len(state.workspace_store.project_sources(project["id"])), 1)
        self.assertFalse((state.session_dir / "new.png").exists())

    def test_rollback_failure_still_restores_live_catalog_and_staging(self) -> None:
        state = self.studio()
        state.create_project("rollback cleanup")
        existing_id = self.import_browser(state, name="existing.png", identity="handle")
        before_images = dict(state.images)
        before_order = list(state.order)

        staged = self.stage("new.png")
        with patch.object(state.workspace_store, "hydrate_candidates", side_effect=ValueError("corrupt candidate")), \
             patch.object(state.workspace_store, "rollback_import", side_effect=RuntimeError("rollback failed")):
            with self.assertRaisesRegex(RuntimeError, "rollback failed"):
                state._import_images([{
                    "clientKey": "new", "name": "new.png", "relativePath": "new.png", "stagedPath": staged,
                    "mtimeNs": 10, "sizeBytes": len(self.png()),
                }], source_identity="handle", source_kind="browser-files")

        self.assertEqual(state.images, before_images)
        self.assertEqual(state.order, before_order)
        self.assertFalse((state.session_dir / "new.png").exists())
