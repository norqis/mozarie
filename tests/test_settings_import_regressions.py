"""Real settings, HTTP uploads, and browser coverage of stale output folders."""

from __future__ import annotations

import copy
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from PIL import Image

from mozarie import http as http_module
from mozarie import state as state_module
from mozarie.core import ClientError
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class SettingsImportRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.app_dir = self.root / "app"
        (self.app_dir / "config").mkdir(parents=True)
        shutil.copy2(Path(__file__).resolve().parents[1] / "config" / "defaults.json", self.app_dir / "config" / "defaults.json")
        with patch.object(state_module, "APP_DIR", self.app_dir):
            self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.output = self.root / "removed-output"
        self.output.mkdir()
        self.state.update_settings({"saving": {"default_output_directory": str(self.output)}})
        self.output.rmdir()
        self.source = self.root / "source"
        self.source.mkdir()
        Image.new("RGB", (32, 24), "white").save(self.source / "source.png")
        self.http_patch = patch.object(http_module, "STATE", self.state)
        self.http_patch.start()
        self.server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.http_patch.stop()
        self.state.shutdown()
        self.temporary.cleanup()

    def request(self, path: str, payload=None, *, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=15)
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None
        try:
            connection.request("POST" if payload is not None else "GET", path, body, {
                "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
                "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
                "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
                "Content-Type": "application/json", **(headers or {}),
            })
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_stale_output_allows_focused_and_complete_settings_with_equivalent_path(self) -> None:
        for patch_value in [
            {"editing": {"fill_color_tolerance": 47}},
            {"importing": {"parallelism": 17}},
            {"detection": {"threshold": 0.72, "parallelism": 13}},
            {"saving": {"parallelism": 11}},
        ]:
            with self.subTest(update=patch_value):
                self.state.update_settings(patch_value)
        full = copy.deepcopy(self.state.settings)
        full["saving"]["default_output_directory"] = str(self.root / "unused" / ".." / "removed-output").replace("\\", "/").upper()
        full["general"]["language"] = "en"
        self.state.update_settings(full)
        reloaded = self.state.settings_store.load()
        self.assertEqual(reloaded, self.state.settings)
        self.assertEqual(reloaded["editing"]["fill_color_tolerance"], 47)
        self.assertEqual(reloaded["importing"]["parallelism"], 17)
        self.assertEqual(reloaded["detection"]["parallelism"], 13)
        self.assertEqual(reloaded["saving"]["parallelism"], 11)
        self.assertFalse(self.output.exists())

    def test_new_unavailable_or_invalid_output_is_rejected_without_mutating_settings(self) -> None:
        before = copy.deepcopy(self.state.settings)
        raw_before = self.state.settings_store.local_path.read_bytes()
        for value, code in [(str(self.root / "other-missing"), "output_folder_unavailable"),
                            ("relative-output", "invalid_settings"), ("bad\0path", "invalid_settings")]:
            with self.subTest(value=value), self.assertRaises(ClientError) as error:
                self.state.update_settings({"editing": {"fill_color_tolerance": 99}, "saving": {"default_output_directory": value}})
            self.assertEqual(error.exception.error_code, code)
            self.assertEqual(self.state.settings, before)
            self.assertEqual(self.state.settings_store.local_path.read_bytes(), raw_before)

    def test_reset_restores_builtin_output_after_previous_output_disappears(self) -> None:
        settings = self.state.reset_settings()
        self.assertEqual(Path(settings["saving"]["default_output_directory"]), self.app_dir / "output")
        self.assertTrue((self.app_dir / "output").is_dir())
        self.assertFalse(self.state.settings_store.local_path.exists())

    def test_copy_save_still_rejects_the_missing_output_and_preserves_the_source(self) -> None:
        images = self.state.set_root(str(self.source))
        before = (self.source / "source.png").read_bytes()
        self.state.update_settings({"editing": {"fill_color_tolerance": 47}})
        with self.assertRaises(ClientError) as error:
            self.state.start_apply([images[0]["id"]], 12, {}, copy_to_default=True)
        self.assertEqual(error.exception.error_code, "output_folder_unavailable")
        self.assertEqual((self.source / "source.png").read_bytes(), before)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.state.job.state, "idle")

    def test_http_complete_settings_persists_with_missing_unchanged_output(self) -> None:
        full = copy.deepcopy(self.state.settings)
        full["importing"]["parallelism"] = 19
        status, payload = self.request("/api/settings?status=0", full)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["settings"]["importing"]["parallelism"], 19)
        self.assertEqual(self.state.settings_store.load(), payload["settings"])

    def test_binary_batch_builds_catalog_summary_once_and_retains_every_image(self) -> None:
        session_id, source_id = str(uuid.uuid4()), str(uuid.uuid4())
        generation = self.state.catalog_generation
        status, payload = self.request("/api/import/start", {"sessionId": session_id, "expectedProjectId": "", "expectedCatalogGeneration": generation})
        self.assertEqual(status, 200, payload)
        image_bytes = (self.source / "source.png").read_bytes()
        count = 32
        started = time.perf_counter()
        with patch.object(self.state, "catalog_snapshot", wraps=self.state.catalog_snapshot) as snapshot:
            for index in range(count):
                status, payload = self.request("/api/import/file", image_bytes, headers={
                    "Content-Type": "application/octet-stream", "X-Mozarie-Name": f"{index:03}.png",
                    "X-Mozarie-Relative-Path": f"{index:03}.png", "X-Mozarie-Client-Key": str(index),
                    "X-Mozarie-File-Mtime": "12346", "X-Mozarie-File-Size": str(len(image_bytes)),
                    "X-Mozarie-Source-Id": source_id, "X-Mozarie-Source-Kind": "browser-files",
                    "X-Mozarie-Import-Intent": "add", "X-Mozarie-Import-Session": session_id,
                    "X-Mozarie-Expected-Project-Id": "", "X-Mozarie-Expected-Catalog-Generation": str(generation),
                })
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["catalogGeneration"], generation + index + 1)
                self.assertEqual(len(payload["imported"]), 1)
            snapshot.assert_not_called()
            status, final = self.request("/api/images")
            self.assertEqual(status, 200, final)
            self.assertEqual(snapshot.call_count, 1)
        self.assertEqual(len(final["images"]), count)
        self.assertEqual(final["catalogGeneration"], generation + count)
        self.assertEqual({image["mtimeNs"] for image in final["images"]}, {12346000000})
        self.assertEqual(len({image["id"] for image in final["images"]}), count)
        print(f"binary import {count} images: {time.perf_counter() - started:.3f}s; catalog summaries: 1")
        status, payload = self.request("/api/import/finish", {"sessionId": session_id, "expectedProjectId": "", "expectedCatalogGeneration": generation, "completed": count})
        self.assertEqual(status, 200, payload)

    def test_live_browser_settings_detection_and_file_entry_points(self) -> None:
        self.state.set_root(str(self.source))
        path_source = self.root / "path-source"
        shutil.copytree(self.source, path_source)
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("settings_import_live_browser_helper.cjs")), self.origin, str(path_source)],
            cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=120, check=False,
        )
        self.assertEqual(result.returncode, 0, f"browser regression failed\n{result.stdout}\n{result.stderr}")
        print(result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
