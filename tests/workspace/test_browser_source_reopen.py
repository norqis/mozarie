"""Browser source identity survives naming, reopening, and legacy aliases."""
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config
from mozarie import state as state_module
from mozarie.state import StudioState


class BrowserSourceReopenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        app = self.root / "app"
        prepare_test_app_config(app)
        with patch.object(state_module, "APP_DIR", app):
            self.state = StudioState(self.root / "cache", self.root / "sessions")

    def tearDown(self):
        self.state.shutdown()
        self.temporary.cleanup()

    def png(self, color):
        output = io.BytesIO()
        with Image.new("RGB", (4, 3), color) as image:
            image.save(output, format="PNG")
        return output.getvalue()

    def import_file(self, name, identity, kind, data, *, intent="add", mtime=1000):
        staged = self.root / "image.upload"
        staged.write_bytes(data)
        return self.state.import_image_file_for_api(
            staged, name=name, relative_path=name, client_key=name, include_images=False,
            source_identity=identity, source_kind=kind, intent=intent,
            mtime_ns=mtime, size_bytes=len(data),
        )[1]

    def test_unnamed_file_and_directory_imports_reopen_every_image_with_its_history(self):
        for kind in ("browser-files", "browser-directory"):
            with self.subTest(kind=kind):
                self.state.close_project()
                data = self.png("white")
                ids = [self.import_file(name, kind, kind, data)[0]["imageId"] for name in ("first.png", "second.png")]
                self.state.set_image_flags(ids[0], {"reviewed": True})
                self.state.set_image_transform(ids[1], {"flipH": True, "flipV": False})
                project = self.state.name_current_project(kind)
                sources = self.state.workspace_store.project_sources(project["id"])
                self.assertEqual(len(sources), 1)
                self.assertEqual(sources[0]["identity"], f"browser:{kind}")
                histories = {image_id: self.state.workspace_store.export_state(image_id) for image_id in ids}
                for _reopen in range(2):
                    self.state.close_project()
                    opened = self.state.open_project(project["id"])
                    self.assertTrue(opened["needsSource"])
                    if kind == "browser-files":
                        self.assertEqual({row["id"] for row in opened["sourceImages"]}, set(ids))
                    restored = [self.import_file(name, sources[0]["id"], kind, data, intent="restore")[0]["imageId"] for name in ("first.png", "second.png")]
                    self.assertEqual(restored, ids)
                    self.assertEqual({image_id: self.state.workspace_store.export_state(image_id) for image_id in ids}, histories)
                    self.assertTrue(self.state.project_history_status(ids[0])["canUndo"])
                    self.assertTrue(self.state.project_history_status(ids[1])["canUndo"])
                    self.assertEqual(len(self.state.workspace_store.project_sources(project["id"])), 1)

    def test_legacy_split_file_sources_keep_same_path_images_and_independent_history(self):
        project = self.state.create_project("Legacy")
        originals = []
        for index, identity in enumerate(("legacy", "browser:legacy")):
            source = self.state.workspace_store.ensure_project_source(project["id"], kind="browser-files", display_name="Files", identity=identity)
            data = self.png((255, 0, 0) if index == 0 else (0, 0, 255))
            record = SimpleNamespace(relative_path="same.png", size_bytes=len(data), mtime_ns=1000 + index, width=4, height=3)
            image_id = self.state.workspace_store.reconcile_images(project["id"], [record], source)["same.png"]["image_id"]
            self.state.workspace_store.set_image_transform(image_id, index == 0, index == 1)
            originals.append((source, image_id, data, 1000 + index))
        before = {image_id: self.state.workspace_store.export_state(image_id) for _, image_id, _, _ in originals}
        for _reopen in range(2):
            self.state.close_project()
            opened = self.state.open_project(project["id"])
            self.assertEqual({(row["id"], row["sourceId"], row["relativePath"]) for row in opened["sourceImages"]},
                             {(image_id, source, "same.png") for source, image_id, _, _ in originals})
            for source, image_id, data, mtime in originals:
                imported = self.import_file("same.png", source, "browser-files", data, intent="restore", mtime=mtime)
                self.assertEqual(imported[0]["imageId"], image_id)
                self.assertEqual(self.state.image_for_id(image_id).path.read_bytes(), data)
            self.assertEqual({image_id: self.state.workspace_store.export_state(image_id) for _, image_id, _, _ in originals}, before)
            self.assertEqual(len(self.state.images), 2)
            self.assertEqual(len(self.state.workspace_store.project_sources(project["id"])), 2)
