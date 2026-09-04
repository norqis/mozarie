"""Live HTTP coverage for the local-only request handler.

These tests deliberately use a real loopback server and a real StudioState.
They cover the browser-facing contract without substituting handler methods.
"""

from __future__ import annotations

import http.client
import io
import json
import sqlite3
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class LiveHttpEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name)
        self.app_dir = root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.source_dir = root / "images"
        self.source_dir.mkdir()
        Image.new("RGB", (12, 8), "white").save(self.source_dir / "source.png")

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

    def request(
        self,
        method: str,
        path: str,
        payload: object | None = None,
        *,
        authorized: bool = False,
    ) -> tuple[int, dict[str, str], bytes]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers: dict[str, str] = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authorized:
            headers.update({"Origin": self.origin, "X-Mozarie-Token": self.state.session_token})
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def raw_request(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_live_get_routes_and_static_security_headers(self) -> None:
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(self.state.session_token.encode("ascii"), body)
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

        status, _headers, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

        status, _headers, body = self.request("GET", "/api/settings?status=0")
        self.assertEqual(status, 200)
        self.assertNotIn("status", json.loads(body))

        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["images"], [])

        status, _headers, body = self.request("GET", "/missing-file")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error_code": "api_not_found", "params": {}})

    def test_live_mutations_enforce_session_then_change_catalog(self) -> None:
        status, headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)})
        self.assertEqual(status, 403)
        self.assertEqual(headers.get("Connection"), "close")
        self.assertEqual(json.loads(body)["error_code"], "session_expired")

        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200)
        images = json.loads(body)["images"]
        self.assertEqual(len(images), 1)

        status, _headers, body = self.request("DELETE", f"/api/catalog/image/{images[0]['id']}", authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["images"], [])

        status, _headers, body = self.request("POST", "/api/unknown", {}, authorized=True)
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error_code"], "api_not_found")

    def test_live_binary_import_validates_then_stages_an_image(self) -> None:
        headers = {"Origin": self.origin, "X-Mozarie-Token": self.state.session_token}
        status, _headers, body = self.raw_request(
            "POST", "/api/import/file", b"not-an-image", {**headers, "Content-Type": "text/plain"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "session_expired")

        encoded = io.BytesIO()
        Image.new("RGB", (9, 7), "white").save(encoded, format="PNG")
        status, _headers, body = self.raw_request(
            "POST",
            "/api/import/file",
            encoded.getvalue(),
            {
                **headers,
                "Content-Type": "application/octet-stream",
                "X-Mozarie-Name": "source.png",
                "X-Mozarie-Relative-Path": "source.png",
                "X-Mozarie-Client-Key": "live-import",
            },
        )
        self.assertEqual(status, 200)
        response = json.loads(body)
        self.assertIsNone(response["catalogId"], "browser imports remain projectless until explicitly saved")
        self.assertEqual(len(response["imported"]), 1)
        self.assertEqual(list(self.state.session_imports_dir.glob("*.upload.tmp")), [], "the upload is renamed in the session volume instead of copied through cache")

    def test_job_endpoint_stays_responsive_while_a_flag_write_waits_for_sqlite(self) -> None:
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        entered = threading.Event(); release = threading.Event(); result: dict[str, object] = {}
        original = self.state.workspace_store.set_image_flags
        def delayed(*args, **kwargs):
            entered.set(); self.assertTrue(release.wait(2)); return original(*args, **kwargs)
        def flag_request() -> None:
            result["response"] = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        with patch.object(self.state.workspace_store, "set_image_flags", side_effect=delayed):
            worker = threading.Thread(target=flag_request); worker.start()
            self.assertTrue(entered.wait(1))
            started = time.perf_counter()
            status, _headers, body = self.request("GET", "/api/job")
            elapsed = time.perf_counter() - started
            self.assertEqual(status, 200)
            self.assertIn("state", json.loads(body))
            self.assertLess(elapsed, .1)
            self.assertFalse(self.state.images[image_id].hidden)
            release.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        status, _headers, body = result["response"]  # type: ignore[misc]
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["hidden"])

    def test_failed_flag_write_keeps_the_live_image_state_unchanged(self) -> None:
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        with patch.object(self.state.workspace_store, "set_image_flags", side_effect=sqlite3.DatabaseError("locked")):
            status, _headers, body = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)["error_code"], "workspace_database_error")
        self.assertFalse(self.state.images[image_id].hidden)


if __name__ == "__main__":
    unittest.main()
