"""Regression coverage for browser source ownership and durable image IDs."""

from __future__ import annotations

import io
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
        self.assertEqual(store.reconcile_images(first["id"], [first_record], source_id=first_source)["one.png"]["image_id"], "session-image")

        same_path = SimpleNamespace(relative_path="one.png", image_id="new-client-id", size_bytes=1, mtime_ns=1, width=8, height=8)
        self.assertEqual(store.reconcile_images(first["id"], [same_path], source_id=first_source)["one.png"]["image_id"], "session-image")

        foreign = SimpleNamespace(relative_path="two.png", image_id="session-image", size_bytes=1, mtime_ns=1, width=8, height=8)
        with self.assertRaisesRegex(ValueError, "image identity already belongs"):
            store.reconcile_images(second["id"], [foreign], source_id=second_source)
        self.assertEqual(store.project_images(second["id"]), [])
