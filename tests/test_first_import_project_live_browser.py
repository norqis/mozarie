"""First-import project creation against real HTTP, SQLite and browser handles."""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.state import StudioState
from tests import prepare_test_app_config


class LiveFirstImportProjectBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        app = self.root / "app"
        prepare_test_app_config(app)
        previous_app, previous_http, previous_state = state_module.APP_DIR, http_module.STATE, state_module.STATE
        self.addCleanup(setattr, state_module, "APP_DIR", previous_app)
        self.addCleanup(setattr, http_module, "STATE", previous_http)
        self.addCleanup(setattr, state_module, "STATE", previous_state)
        state_module.APP_DIR = app
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.addCleanup(self.state.shutdown)
        state_module.STATE = http_module.STATE = self.state
        self.source = self.root / "Chosen Native Folder"
        self.source.mkdir()
        self.originals = {}
        for name in ("a.png", "b.png"):
            with Image.new("RGB", (64, 48), (32, 80, 144)) as image:
                image.save(self.source / name)
            self.originals[name] = (self.source / name).read_bytes()
        with Image.new("L", (64, 48), 0) as mask, io.BytesIO() as stream:
            mask.paste(255, (10, 10, 20, 20))
            mask.save(stream, format="PNG")
            self.mask = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")

    def run_browser(self, mode: str) -> None:
        server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), http_module.MosaicHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            helper = Path(__file__).with_name("projects") / "first_import_project_live_browser_helper.cjs"
            result = subprocess.run(
                ["node", str(helper), f"http://127.0.0.1:{server.server_port}", mode, str(self.source),
                 base64.b64encode(self.originals["a.png"]).decode("ascii"), self.mask],
                cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
                text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=90, check=False,
            )
            self.assertEqual(result.returncode, 0, f"first import {mode}\n{result.stdout}\n{result.stderr}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
        for name, original in self.originals.items():
            self.assertEqual((self.source / name).read_bytes(), original)
        self.assertEqual(len(self.state.images), 2)
        if mode in {"cancel", "escape"}:
            self.assertIsNone(self.state.catalog_id)
        else:
            self.assertEqual(self.state.catalog_id, self.state.workspace_id)
            self.assertEqual(self.state.workspace_store.project(self.state.catalog_id)["name"], "Edited first project")
            image_id = self.state.order[0]
            self.assertTrue(self.state.project_history_status(image_id)["canUndo"])
            draft = self.state.manual_workspace(image_id)
            with io.BytesIO(base64.b64decode(draft["add"].split(",", 1)[1])) as stream, Image.open(stream) as image:
                with image.getchannel("A") if image.mode == "RGBA" else image.convert("L") as alpha:
                    self.assertEqual(alpha.getpixel((15, 15)), 255)
                    self.assertEqual(alpha.getpixel((25, 25)), 0)

    def test_native_first_import_promotes_the_existing_workspace_and_restores_masks_history_and_sources(self) -> None:
        self.run_browser("native")

    def test_real_file_picker_handles_survive_first_import_project_promotion_and_reopen(self) -> None:
        self.run_browser("files")

    def test_real_directory_picker_handle_survives_first_import_project_promotion_and_reopen(self) -> None:
        self.run_browser("directory")

    def test_declining_first_import_project_creation_keeps_the_unnamed_images(self) -> None:
        self.run_browser("cancel")

    def test_escape_from_first_import_project_creation_keeps_the_unnamed_images(self) -> None:
        self.run_browser("escape")
