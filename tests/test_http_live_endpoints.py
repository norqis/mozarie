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
from mozarie.core import Candidate, CandidateRole


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
        status, _headers, _body = self.request("POST", "/api/projects", {"name": "live flags"}, authorized=True)
        self.assertEqual(status, 200)
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
        status, _headers, _body = self.request("POST", "/api/projects", {"name": "live flags"}, authorized=True)
        self.assertEqual(status, 200)
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        with patch.object(self.state.workspace_store, "set_image_flags", side_effect=sqlite3.DatabaseError("locked")):
            status, _headers, body = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)["error_code"], "workspace_database_error")
        self.assertFalse(self.state.images[image_id].hidden)

    def test_hundred_candidate_bulk_controls_are_one_http_transaction_and_one_undo(self) -> None:
        """Exercise the browser route against SQLite, not a handler mock."""
        status, _headers, _body = self.request("POST", "/api/projects", {"name": "bulk candidates"}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200)
        image_id = json.loads(body)["images"][0]["id"]
        candidates = []
        for role, label in ((CandidateRole.APPLY, "penis"), (CandidateRole.EXCLUDE, "hand")):
            for index in range(100):
                candidate_id = f"{role.value}-{index}"
                mask_path = self.state.cache_dir / image_id / f"{candidate_id}.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (12, 8), 255).save(mask_path)
                candidates.append(Candidate(candidate_id, label, .9, mask_path, role=role, forced=role == CandidateRole.EXCLUDE))
        self.state.candidates[image_id] = candidates
        with self.state.image_io_lock(image_id):
            with self.state.lock:
                self.state._commit_candidate_snapshot(image_id, candidates, replace=True)

        def durable_counts() -> tuple[int, int]:
            with self.state.workspace_store._connect() as db:
                return (
                    int(db.execute("SELECT COUNT(*) FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0]),
                    int(db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()[0]),
                )

        def assert_one_bulk_request(payload: dict[str, object]) -> None:
            statements: list[str] = []
            original_connect = self.state.workspace_store._connect

            def traced_connect():
                db = original_connect()
                db.set_trace_callback(statements.append)
                return db

            before_history, before_revision = durable_counts()
            replacing_redo = self.state.workspace_store.history_status(image_id)["canRedo"]
            with patch.object(self.state.workspace_store, "_connect", side_effect=traced_connect):
                status, _headers, body = self.request("POST", "/api/candidates/batch", {"imageId": image_id, **payload}, authorized=True)
            self.assertEqual(status, 200)
            response = json.loads(body)
            self.assertEqual(response["candidateRevision"], before_revision + 1)
            self.assertEqual(sum(statement == "BEGIN IMMEDIATE" for statement in statements), 1)
            self.assertEqual(durable_counts(), (before_history if replacing_redo else before_history + 1, before_revision + 1))

        assert_one_bulk_request({"role": "apply", "operation": "disable"})
        self.assertTrue(all(not item.enabled for item in self.state.candidates[image_id] if item.role == CandidateRole.APPLY))
        self.assertTrue(all(item.enabled for item in self.state.candidates[image_id] if item.role == CandidateRole.EXCLUDE))
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/undo", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["changedImageIds"], [image_id])
        self.assertTrue(all(item.enabled for item in self.state.candidates[image_id]))

        for payload, role, expected_enabled in (
            ({"role": "apply", "operation": "disable"}, CandidateRole.APPLY, False),
            ({"role": "apply", "operation": "enable"}, CandidateRole.APPLY, True),
            ({"role": "exclude", "operation": "disable"}, CandidateRole.EXCLUDE, False),
            ({"role": "exclude", "operation": "enable"}, CandidateRole.EXCLUDE, True),
        ):
            assert_one_bulk_request(payload)
            self.assertTrue(all(item.enabled is expected_enabled for item in self.state.candidates[image_id] if item.role == role))

        assert_one_bulk_request({"role": "apply", "operation": "set_padding", "expandPx": 4})
        self.assertTrue(all(item.expand_px == 4 for item in self.state.candidates[image_id] if item.role == CandidateRole.APPLY))
        self.assertTrue(all(item.expand_px == 0 for item in self.state.candidates[image_id] if item.role == CandidateRole.EXCLUDE))
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/undo", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["changedImageIds"], [image_id])
        self.assertTrue(all(item.expand_px == 0 for item in self.state.candidates[image_id]))


if __name__ == "__main__":
    unittest.main()
