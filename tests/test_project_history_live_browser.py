"""Windows loopback integration for durable manual-mask undo and redo.

The browser helper is deliberately owned by this unittest fixture: the server,
SQLite database, image source, port, and cleanup are all Python-owned.  That
prevents a JavaScript fetch mock from accidentally replacing the persistence
or PNG decoding path this regression needs to protect.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class LiveProjectHistoryBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name)
        self.app_dir = root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.source_dir = root / "source"
        self.source_dir.mkdir()
        Image.new("RGB", (64, 48), "white").save(self.source_dir / "history.png")

        self._previous_app_dir = state_module.APP_DIR
        self._previous_state = http_module.STATE
        state_module.APP_DIR = self.app_dir
        self.state = StudioState(root / "cache", root / "sessions")
        http_module.STATE = self.state
        self.server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        http_module.STATE = self._previous_state
        self.state.shutdown()
        state_module.APP_DIR = self._previous_app_dir
        self._temporary_directory.cleanup()

    def test_browser_undo_redo_round_trips_localized_durable_manual_layers(self) -> None:
        helper = Path(__file__).with_name("project_history_live_browser_helper.cjs")
        result = subprocess.run(
            ["node", str(helper), self.origin, str(self.source_dir.resolve())],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"},
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=90,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"live browser history helper failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
