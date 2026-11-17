"""Windows loopback integration for durable manual-mask undo and redo.

The browser helper is deliberately owned by this unittest fixture: the server,
SQLite database, image source, port, and cleanup are all Python-owned.  That
prevents a JavaScript fetch mock from accidentally replacing the persistence
or PNG decoding path this regression needs to protect.
"""

from __future__ import annotations

import os
import base64
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from PIL import Image
from tests import prepare_test_app_config

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.http import MosaicHandler
from mozarie.state import StudioState
from mozarie.domain import Candidate, CandidateRole


class LiveProjectHistoryBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name)
        self.app_dir = root / "app"
        prepare_test_app_config(self.app_dir)
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

    def check_deletion_navigation_controls(self, mode: str) -> None:
        (self.source_dir / "history.png").unlink()
        for name in ("a.png", "b.png", "c.png", "d.png"):
            with Image.new("RGB", (64, 48), "white") as image:
                image.save(self.source_dir / name)
        self.state.create_project("Delete controls")
        images = self.state.set_root(str(self.source_dir))
        ids = {image["relativePath"]: image["id"] for image in images}
        with Image.new("L", (64, 48), 0) as mask:
            mask.putpixel((10, 10), 255)
            stream = io.BytesIO(); mask.save(stream, format="PNG")
        raw = stream.getvalue()
        for image in images:
            image_id = image["id"]
            candidates = []
            for role in (CandidateRole.APPLY, CandidateRole.EXCLUDE):
                path = self.state.cache_dir / image_id / f"{role.value}.png"
                path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
                candidates.append(Candidate(role.value, "penis" if role == CandidateRole.APPLY else "hand", .9, path, role=role))
            with self.state.image_io_lock(image_id), self.state.lock:
                self.state._commit_candidate_snapshot(image_id, candidates, replace=True)
            uri = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            self.state.save_manual_workspace(image_id, {
                "add": uri, "exclusion": uri, "exclusionErase": uri,
                "removedCandidateIds": [], "candidateRevision": self.state._candidate_revision(image_id),
                "hasEffectiveMask": True,
            })
        self.state.set_image_flags(ids["b.png"], {"reviewed": True})
        helper = Path(__file__).with_name("editor") / "delete_navigation_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, mode, json.dumps(ids)],
            cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"delete navigation helper failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(self.state.order, [ids["b.png"]])
        for name in ids:
            self.assertEqual((self.source_dir / name).exists(), mode == "list" or name == "b.png")

    def test_source_delete_navigation_restores_editor_and_candidate_controls(self) -> None:
        self.check_deletion_navigation_controls("source")

    def test_list_removal_navigation_restores_editor_and_candidate_controls(self) -> None:
        self.check_deletion_navigation_controls("list")

    def test_project_keeps_native_paths_picker_and_drop_imports_together(self) -> None:
        other = Path(self._temporary_directory.name) / "other"
        other.mkdir()
        Image.new("RGB", (64, 48), "blue").save(other / "history.png")
        helper = Path(__file__).with_name("workspace") / "project_image_import_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, str(self.source_dir.resolve()), str(other.resolve())],
            cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"project import helper failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(len(self.state.workspace_store.project_sources(self.state.catalog_id)), 5)
        self.assertEqual(len(self.state.images), 5)

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
