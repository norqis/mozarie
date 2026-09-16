"""Unnamed folder reloads retain editable durable workspace state."""

import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.state import StudioState


class UnnamedFolderReloadTests(unittest.TestCase):
    def test_same_folder_reload_keeps_history_manual_edits_and_allows_switch(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            app_dir = root / "app"
            (app_dir / "config").mkdir(parents=True)
            shutil.copyfile(Path(__file__).resolve().parents[1] / "config" / "defaults.json", app_dir / "config" / "defaults.json")
            source = root / "first"
            source.mkdir()
            Image.new("RGB", (8, 8), "white").save(source / "image.png")
            other = root / "second"
            other.mkdir()
            Image.new("RGB", (8, 8), "black").save(other / "other.png")
            states = []

            def new_state():
                with patch.object(state_module, "APP_DIR", app_dir):
                    state = StudioState(root / "cache", root / "sessions")
                states.append(state)
                return state

            def manual(pixel):
                mask = Image.new("L", (8, 8), 0)
                mask.putpixel(pixel, 255)
                data = io.BytesIO()
                mask.save(data, format="PNG")
                return {"add": data.getvalue(), "dirtyLayers": ["add"], "manualEnabled": True}

            try:
                state = new_state()
                image_id = state.set_root(str(source))[0]["id"]
                workspace_id = state.workspace_id
                state.save_manual_workspace(image_id, manual((1, 1)))
                self.assertTrue(state.project_history_status(image_id)["canUndo"])

                self.assertEqual(state.set_root(str(source))[0]["id"], image_id)
                self.assertEqual(state.workspace_id, workspace_id)
                self.assertTrue(state.manual_workspace(image_id)["add"])
                self.assertTrue(state.project_history_status(image_id)["canUndo"])
                state.save_manual_workspace(image_id, manual((2, 2)))
                expected = state.manual_workspace(image_id)["add"]
                state.shutdown()

                reopened = new_state()
                self.assertEqual(reopened.workspace_id, workspace_id)
                reopened.set_root(str(source))
                self.assertEqual(reopened.list_images()[0]["id"], image_id)
                self.assertEqual(reopened.manual_workspace(image_id)["add"], expected)
                self.assertTrue(reopened.project_history_status(image_id)["canUndo"])
                switched = reopened.set_root(str(other))
                self.assertEqual([image["relativePath"] for image in switched], ["other.png"])
                self.assertNotEqual(reopened.workspace_id, workspace_id)
                reopened.save_manual_workspace(switched[0]["id"], manual((3, 3)))
                self.assertTrue(reopened.project_history_status(switched[0]["id"])["canUndo"])
            finally:
                for state in states:
                    state.shutdown()
