"""Real loopback, SQLite, and file contracts for DI-081 through DI-125."""

from __future__ import annotations

import base64
import http.client
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import Candidate
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class DataIntegrityHttpContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.app_dir = self.root / "app"
        prepare_test_app_config(self.app_dir)
        self.sources = self.root / "images"
        self.sources.mkdir()
        for name in "ABCDEFGH":
            Image.new("RGB", (12, 8), (ord(name), 40, 90)).save(self.sources / f"{name}.png")
        self.originals = {path.name: path.read_bytes() for path in self.sources.glob("*.png")}
        self.previous_app_dir = state_module.APP_DIR
        self.previous_state = http_module.STATE
        state_module.APP_DIR = self.app_dir
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        http_module.STATE = self.state
        self.server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        http_module.STATE = self.previous_state
        self.state.shutdown()
        state_module.APP_DIR = self.previous_app_dir
        self.temporary.cleanup()

    def request(self, method: str, path: str, payload: object | None = None):
        body = None if payload is None else json.dumps(payload).encode()
        headers = {
            "Origin": self.origin,
            "X-Mozarie-Token": self.state.session_token,
            "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
            "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def request_as(self, method: str, path: str, payload: object | None, project_id: str | None, generation: int):
        body = None if payload is None else json.dumps(payload).encode()
        headers = {
            "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
            "X-Mozarie-Expected-Project-Id": project_id or "",
            "X-Mozarie-Expected-Catalog-Generation": str(generation),
            **({"Content-Type": "application/json"} if payload is not None else {}),
        }
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    @staticmethod
    def mask_uri() -> str:
        output = io.BytesIO()
        Image.new("L", (12, 8), 255).save(output, format="PNG")
        return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()

    def add_range(self, image_id: str, name: str) -> None:
        path = self.state.cache_dir / image_id / f"candidate-{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (12, 8), 255).save(path)
        self.state._commit_candidate_snapshot(image_id, [Candidate(f"candidate-{name}", "penis", .9, path)], replace=True)
        self.state.save_manual_workspace(image_id, {
            "add": self.mask_uri(), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })

    def snapshot(self):
        status, payload = self.request("GET", "/api/images")
        self.assertEqual(status, 200)
        return {Path(item["relativePath"]).stem: item for item in payload["images"]}

    def db_state(self, image_ids: dict[str, str]):
        db = sqlite3.connect(self.state.workspace_store.path)
        try:
            return {
                name: {
                    "reviewed": bool(db.execute("SELECT reviewed FROM images WHERE image_id=?", (image_id,)).fetchone()[0]),
                    "hidden": bool(db.execute("SELECT hidden FROM images WHERE image_id=?", (image_id,)).fetchone()[0]),
                    "candidates": db.execute("SELECT COUNT(*) FROM candidates WHERE image_id=? AND deleted=0", (image_id,)).fetchone()[0],
                    "manual": db.execute("SELECT COUNT(*) FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()[0],
                }
                for name, image_id in image_ids.items()
            }
        finally:
            db.close()

    def test_clear_mask_http_catalogue_and_sqlite_share_the_exact_A_to_H_state(self) -> None:
        project = self.state.create_project("clear-http")
        image_ids = {Path(item["relativePath"]).stem: item["id"] for item in self.state.set_root(str(self.sources))}
        for name in ("A", "B", "E", "F"):
            self.add_range(image_ids[name], name)
        for name in ("A", "C", "E", "G"):
            self.state.set_image_flags(image_ids[name], {"reviewed": True})
        for name in ("E", "F", "G", "H"):
            self.state.set_image_flags(image_ids[name], {"hidden": True})

        status, payload = self.request("POST", "/api/masks/clear", {"imageIds": [image_ids["A"]]})
        self.assertEqual((status, payload["cleared"]), (200, 1))
        api = self.snapshot()
        db = self.db_state(image_ids)
        self.assertEqual((api["A"]["hasEffectiveMask"], api["A"]["reviewed"], db["A"]),
                         (False, False, {"reviewed": False, "hidden": False, "candidates": 0, "manual": 0}))
        self.assertEqual((api["B"]["hasEffectiveMask"], db["B"]["candidates"], db["B"]["manual"]), (True, 1, 1))
        self.assertTrue(api["C"]["reviewed"])
        self.assertEqual({name: (api[name]["reviewed"], api[name]["hidden"]) for name in "EFGH"},
                         {"E": (True, True), "F": (False, True), "G": (True, True), "H": (False, True)})

        status, undo = self.request("POST", f"/api/project/history/{image_ids['A']}/undo", {})
        self.assertEqual(status, 200)
        self.assertEqual(undo["changedImageIds"], [image_ids["A"]])
        api = self.snapshot(); db = self.db_state(image_ids)
        self.assertTrue(api["A"]["hasEffectiveMask"] and api["A"]["reviewed"])
        self.assertEqual((db["A"]["candidates"], db["A"]["manual"], db["A"]["reviewed"]), (1, 1, True))
        status, redo = self.request("POST", f"/api/project/history/{image_ids['A']}/redo", {})
        self.assertEqual((status, redo["changedImageIds"]), (200, [image_ids["A"]]))
        api = self.snapshot(); db = self.db_state(image_ids)
        self.assertEqual((api["A"]["hasEffectiveMask"], api["A"]["reviewed"], db["A"]["candidates"], db["A"]["manual"]),
                         (False, False, 0, 0))

        status, payload = self.request("POST", "/api/masks/clear", {"imageIds": [image_ids[name] for name in "AB"]})
        self.assertEqual((status, payload["cleared"]), (200, 2))
        api = self.snapshot(); db = self.db_state(image_ids)
        for name in "AB":
            self.assertEqual((api[name]["hasEffectiveMask"], api[name]["reviewed"], db[name]["candidates"], db[name]["manual"]),
                             (False, False, 0, 0), name)
        self.assertEqual((db["E"]["candidates"], db["E"]["manual"], db["F"]["candidates"], db["F"]["manual"]), (1, 1, 1, 1))

        status, payload = self.request("POST", "/api/masks/clear", {"imageIds": [image_ids[name] for name in "ABCD"]})
        self.assertEqual((status, payload["cleared"]), (200, 4))
        api = self.snapshot(); db = self.db_state(image_ids)
        for name in "ABCD":
            self.assertEqual((api[name]["hasEffectiveMask"], api[name]["reviewed"], db[name]["candidates"], db[name]["manual"]),
                             (False, False, 0, 0), name)
        self.assertEqual({name: db[name] for name in "EFGH"}, {
            "E": {"reviewed": True, "hidden": True, "candidates": 1, "manual": 1},
            "F": {"reviewed": False, "hidden": True, "candidates": 1, "manual": 1},
            "G": {"reviewed": True, "hidden": True, "candidates": 0, "manual": 0},
            "H": {"reviewed": False, "hidden": True, "candidates": 0, "manual": 0},
        })
        self.assertEqual({path.name: path.read_bytes() for path in self.sources.glob("*.png")}, self.originals)
        self.assertEqual(self.state.catalog_id, project["id"])

    def test_delayed_old_project_candidate_request_is_stale_and_candidate_failures_publish_nothing(self) -> None:
        project_a = self.state.create_project("A")
        ids_a = {Path(item["relativePath"]).stem: item["id"] for item in self.state.set_root(str(self.sources))}
        self.add_range(ids_a["A"], "A")
        generation_a = self.state.catalog_generation
        a_before = self.state.workspace_store.export_state(ids_a["A"])
        a_history_before = self.state.workspace_store.history_status(ids_a["A"])

        other = self.root / "other"; other.mkdir(); Image.new("RGB", (12, 8), "blue").save(other / "B.png")
        project_b = self.state.create_project("B")
        id_b = self.state.set_root(str(other))[0]["id"]
        b_before = self.state.workspace_store.export_state(id_b)
        generation_b = self.state.catalog_generation
        status, stale_flag = self.request_as("POST", f"/api/workspace/image/{ids_a['A']}", {"hidden": True}, project_a["id"], generation_a)
        self.assertEqual((status, stale_flag["error_code"]), (409, "stale_catalog"))
        self.assertEqual(self.state.catalog_id, project_b["id"])
        self.assertEqual(self.state.workspace_store.export_state(id_b), b_before)
        self.assertEqual(self.state.workspace_store.export_state(ids_a["A"]), a_before)
        status, payload = self.request_as("POST", f"/api/candidate/{ids_a['A']}/candidate-A", {"enabled": False}, project_a["id"], generation_a)
        self.assertEqual((status, payload["error_code"]), (409, "stale_catalog"))
        self.assertEqual(self.state.catalog_id, project_b["id"])
        self.assertEqual(self.state.catalog_generation, generation_b)
        self.assertEqual(self.state.workspace_store.export_state(id_b), b_before)
        self.assertEqual(self.state.workspace_store.export_state(ids_a["A"]), a_before)
        self.assertEqual(self.state.workspace_store.history_status(ids_a["A"]), a_history_before)
        status, stale_batch = self.request_as("POST", "/api/candidates/batch", {
            "imageIds": [ids_a["A"], ids_a["B"]], "role": "apply", "operation": "disable",
        }, project_a["id"], generation_a)
        self.assertEqual((status, stale_batch["error_code"]), (409, "stale_catalog"))
        self.assertEqual(self.state.catalog_id, project_b["id"])
        self.assertEqual(self.state.workspace_store.export_state(id_b), b_before)

        self.state.open_project(project_a["id"])
        revision = self.state._candidate_revision(ids_a["A"])
        history = self.state.workspace_store.history_status(ids_a["A"])
        status, missing = self.request("POST", f"/api/candidate/{ids_a['A']}/missing", {"enabled": False})
        self.assertEqual((status, missing["error_code"]), (400, "candidate_not_found"))
        self.assertEqual(self.state._candidate_revision(ids_a["A"]), revision)
        self.assertEqual(self.state.workspace_store.history_status(ids_a["A"]), history)
        self.assertTrue(self.state.candidates[ids_a["A"]][0].enabled)

        batch_before = {
            image_id: (self.state.workspace_store.export_state(image_id), self.state.workspace_store.history_status(image_id))
            for image_id in (ids_a["A"], ids_a["B"])
        }
        status, missing_batch = self.request("POST", "/api/candidates/batch", {
            "imageIds": [ids_a["A"], ids_a["B"]], "role": "apply", "operation": "disable",
        })
        self.assertEqual((status, missing_batch["error_code"]), (400, "candidate_not_found"))
        self.assertEqual({
            image_id: (self.state.workspace_store.export_state(image_id), self.state.workspace_store.history_status(image_id))
            for image_id in (ids_a["A"], ids_a["B"])
        }, batch_before, "a missing candidate rolls back both requested images and both histories")

        with patch.object(self.state.workspace_store, "commit_candidate_state", side_effect=sqlite3.OperationalError("read/write failed")):
            status, failed = self.request("POST", f"/api/candidate/{ids_a['A']}/candidate-A", {"enabled": False})
        self.assertEqual((status, failed["error_code"]), (500, "workspace_database_error"))
        self.assertEqual(self.state._candidate_revision(ids_a["A"]), revision)
        self.assertEqual(self.state.workspace_store.history_status(ids_a["A"]), history)
        self.assertTrue(self.state.candidates[ids_a["A"]][0].enabled)
        self.state.open_project(project_b["id"])
        self.assertEqual(self.state.workspace_store.export_state(id_b), b_before)

    def test_next_import_session_starts_before_prior_file_success_response_returns(self) -> None:
        first = "00000000-0000-4000-8000-000000000115"
        second = "00000000-0000-4000-8000-000000000116"
        generation = self.state.catalog_generation
        self.assertEqual(self.request("POST", "/api/import/start", {
            "sessionId": first, "expectedProjectId": None, "expectedCatalogGeneration": generation,
        })[0], 200)
        response_blocked = threading.Event(); release = threading.Event(); result = {}
        original_json = MosaicHandler._json

        def delayed_json(handler, payload, status=200):
            if handler.path == "/api/import/file":
                response_blocked.set(); release.wait(5)
            return original_json(handler, payload, status)

        def upload():
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request("POST", "/api/import/file", b"x", {
                    "Content-Type": "application/octet-stream", "Content-Length": "1",
                    "X-Mozarie-Name": "image.png", "X-Mozarie-Relative-Path": "image.png", "X-Mozarie-Client-Key": "client",
                    "X-Mozarie-Token": self.state.session_token, "Origin": self.origin,
                    "X-Mozarie-Import-Session": first, "X-Mozarie-Import-Intent": "add", "X-Mozarie-File-Size": "1",
                    "X-Mozarie-Expected-Project-Id": "", "X-Mozarie-Expected-Catalog-Generation": str(generation),
                })
                response = connection.getresponse(); result["status"] = response.status; response.read()
            finally: connection.close()

        with patch.object(MosaicHandler, "_json", delayed_json), \
             patch.object(self.state, "import_image_file_for_api", return_value=([], [])):
            thread = threading.Thread(target=upload); thread.start()
            try:
                self.assertTrue(response_blocked.wait(5), "the prior import committed before its HTTP success was released")
                status, payload = self.request("POST", "/api/import/start", {
                    "sessionId": second, "expectedProjectId": None, "expectedCatalogGeneration": self.state.catalog_generation,
                })
                self.assertEqual((status, payload["ok"]), (200, True))
                self.assertIn(second, self.state._import_sessions)
                self.assertNotIn(first, self.state._import_sessions)
            finally:
                release.set(); thread.join(5)
        self.assertEqual(result.get("status"), 200)


if __name__ == "__main__":
    unittest.main()
