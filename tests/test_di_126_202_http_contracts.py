"""Direct loopback contracts for the DI-186..202 HTTP/1.1 boundaries."""

from __future__ import annotations

import base64
import http.client
import io
import json
import sqlite3
import socket
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
        Image.new("RGB", (12, 8), "white").save(self.sources / "A.png")
        Image.new("RGB", (12, 8), "gray").save(self.sources / "B.png")
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

    def request(self, method: str, path: str, payload: object | None = None, *, authorized: bool = False):
        body = None if payload is None else json.dumps(payload).encode()
        headers: dict[str, str] = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authorized:
            headers.update(self.auth_headers())
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def auth_headers(self) -> dict[str, str]:
        return {
            "Origin": self.origin,
            "X-Mozarie-Token": self.state.session_token,
            "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
            "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
        }

    def open_project(self) -> tuple[str, str, str]:
        status, _, body = self.request("POST", "/api/projects", {"name": "DI HTTP"}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        project_id = json.loads(body)["project"]["id"]
        status, _, body = self.request("POST", "/api/folder", {"path": str(self.sources)}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        image_ids = [item["id"] for item in json.loads(body)["images"]]
        return project_id, image_ids[0], image_ids[1]

    def add_candidate_and_manual(self, image_id: str) -> None:
        mask_path = self.state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (12, 8), 255).save(mask_path)
        self.state._commit_candidate_snapshot(
            image_id, [Candidate("candidate", "penis", 0.9, mask_path)], replace=True,
        )
        encoded = io.BytesIO()
        Image.new("RGBA", (12, 8), (255, 255, 255, 255)).save(encoded, format="PNG")
        data_url = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
        self.state.save_manual_workspace(image_id, {
            "add": data_url, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })

    def raw_exchange(self, request_bytes: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5) as client:
            client.sendall(request_bytes)
            client.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)

    def response_before_body(self, request_headers: bytes) -> bytes:
        """Receive a complete rejection while deliberately withholding its declared body."""
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5) as client:
            client.sendall(request_headers)
            chunks = []
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)

    def raw_request_bytes(self, method: str, path: str, headers: list[tuple[str, str]], body: bytes = b"") -> bytes:
        lines = [f"{method} {path} HTTP/1.1", f"Host: 127.0.0.1:{self.server.server_port}"]
        lines.extend(f"{name}: {value}" for name, value in headers)
        return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body

    def fingerprint(self) -> dict[str, object]:
        snapshot = self.state.catalog_snapshot()
        image_ids = [item["id"] for item in snapshot["images"]]
        return {
            "catalogId": snapshot.get("project", {}).get("id") if snapshot.get("project") else None,
            "generation": snapshot["catalogGeneration"],
            "images": [(item["id"], item["relativePath"]) for item in snapshot["images"]],
            "projects": [(item["id"], item["name"]) for item in self.state.projects()],
            "sourceFiles": sorted(path.name for path in self.sources.iterdir()),
            "uploads": sorted(self.state._manual_uploads),
            "candidates": {
                image_id: [(item.candidate_id, item.role, item.enabled) for item in self.state.candidates.get(image_id, [])]
                for image_id in image_ids
            },
            "manual": {
                image_id: self.state.manual_workspace(image_id)
                for image_id in image_ids
            },
            "activeImportCount": self.state.active_import_count,
            "importSessions": {
                session_id: (item["project_id"], item["generation"], item["last_generation"], item["active"], item["finish_requested"])
                for session_id, item in self.state._import_sessions.items()
            },
        }

    def add_distinct_candidate_and_manual(self, image_id: str, label: str) -> None:
        mask_path = self.state.cache_dir / image_id / f"{label}.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (12, 8), 255).save(mask_path)
        self.state._commit_candidate_snapshot(
            image_id, [*self.state.candidates.get(image_id, []), Candidate(label, "penis", 0.9, mask_path)], replace=True,
        )
        encoded = io.BytesIO()
        Image.new("RGBA", (12, 8), (255, 255, 255, 255)).save(encoded, format="PNG")
        data_url = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
        self.state.save_manual_workspace(image_id, {
            "add": data_url, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })

    def begin_import(self, session_id: str) -> bytes:
        status, _, body = self.request("POST", "/api/import/start", {"sessionId": session_id}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        encoded = io.BytesIO()
        Image.new("RGB", (2, 2), "white").save(encoded, format="PNG")
        return encoded.getvalue()

    def import_headers(self, session_id: str, payload: bytes) -> dict[str, str]:
        return self.auth_headers() | {
            "Content-Type": "application/octet-stream", "X-Mozarie-Name": "new.png",
            "X-Mozarie-Relative-Path": "new.png", "X-Mozarie-Client-Key": "di-import",
            "X-Mozarie-Source-Kind": "browser-files", "X-Mozarie-Import-Intent": "add",
            "X-Mozarie-Import-Session": session_id, "X-Mozarie-File-Mtime": "0",
            "X-Mozarie-File-Size": str(len(payload)), "Content-Length": str(len(payload)),
        }

    def test_legacy_json_delete_body_is_consumed_on_all_four_routes(self) -> None:
        project_id, first, second = self.open_project()
        self.add_candidate_and_manual(first)
        routes = [
            f"/api/candidate/{first}/candidate",
            f"/api/workspace/manual/{first}",
            f"/api/catalog/image/{second}",
            f"/api/project/{project_id}",
        ]
        for path in routes:
            payload = {
                "expectedProjectId": self.state.catalog_id,
                "expectedCatalogGeneration": self.state.catalog_generation,
            }
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request("DELETE", path, json.dumps(payload).encode(), {
                    "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
                    "Content-Type": "application/json",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200, (path, response.read()))
                response.read()
                connection.request("GET", "/api/health")
                follow_up = connection.getresponse()
                self.assertEqual(follow_up.status, 200, path)
                self.assertTrue(json.loads(follow_up.read())["ok"])
            finally:
                connection.close()

    def test_every_delete_route_rejects_malformed_bodies_without_mutation(self) -> None:
        project_id, first, second = self.open_project()
        self.add_candidate_and_manual(first)
        routes = [
            f"/api/catalog/image/{second}", f"/api/project/{project_id}",
            f"/api/candidate/{first}/candidate", f"/api/workspace/manual/{first}",
        ]
        malformed = [
            ("text/plain", b"{}"),
            ("application/json", b"{"),
            ("application/json", b"[]"),
            ("application/json", json.dumps({"expectedProjectId": self.state.catalog_id, "expectedCatalogGeneration": -1}).encode()),
        ]
        baseline = self.fingerprint()
        for route in routes:
            for content_type, body in malformed:
                headers = [("Origin", self.origin), ("X-Mozarie-Token", self.state.session_token),
                           ("Content-Type", content_type), ("Content-Length", str(len(body)))]
                response = self.raw_exchange(self.raw_request_bytes("DELETE", route, headers, body))
                self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0], (route, content_type, body))
                self.assertEqual(response.count(b"HTTP/1.1 "), 1)
                self.assertEqual(self.fingerprint(), baseline)

    def test_ambiguous_delete_framing_and_get_bodies_close_without_a_follow_up(self) -> None:
        _, first, _ = self.open_project()
        route = f"/api/catalog/image/{first}"
        auth = [("Origin", self.origin), ("X-Mozarie-Token", self.state.session_token)]
        cases = [
            self.raw_request_bytes("DELETE", route, auth + [("Transfer-Encoding", "chunked")], b"0\r\n\r\n"),
            self.raw_request_bytes("DELETE", route, auth + [("Content-Length", "1"), ("Content-Length", "1")], b"x"),
            self.raw_request_bytes("DELETE", route, auth + [("Content-Length", "x")]),
            self.raw_request_bytes("DELETE", route, auth + [("Content-Length", "\u00ff")]),
            self.raw_request_bytes("DELETE", route, auth + [("Content-Length", "100000000")]),
            self.raw_request_bytes("DELETE", route, auth + [("Content-Length", "9" * 4301)]),
            self.raw_request_bytes("GET", "/api/images", [("Content-Length", "2")], b"{}"),
        ]
        baseline = self.fingerprint()
        pipelined_get = self.raw_request_bytes("GET", "/api/health", [])
        for request_bytes in cases:
            response = self.raw_exchange(request_bytes + pipelined_get)
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", response)
            self.assertEqual(response.count(b"HTTP/1.1 "), 1)
            self.assertNotIn(b"501", response)
            self.assertNotIn(b"Unsupported method", response)
            self.assertEqual(self.fingerprint(), baseline)

    def test_stale_bodyless_delete_keeps_alive_and_returns_authoritative_snapshot(self) -> None:
        _, first, _ = self.open_project()
        before = self.fingerprint()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            headers = self.auth_headers()
            headers["X-Mozarie-Expected-Catalog-Generation"] = str(self.state.catalog_generation - 1)
            connection.request("DELETE", f"/api/catalog/image/{first}", headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 409)
            self.assertIsNone(response.getheader("Connection"))
            response.read()
            connection.request("GET", "/api/images")
            snapshot_response = connection.getresponse()
            self.assertEqual(snapshot_response.status, 200)
            snapshot = json.loads(snapshot_response.read())
            authoritative = self.state.catalog_snapshot()
            self.assertEqual(snapshot, authoritative)
        finally:
            connection.close()
        self.assertEqual(self.fingerprint(), before)

    def test_bodyless_and_legacy_delete_forms_are_equivalent_for_all_routes(self) -> None:
        project_id, first, second = self.open_project()
        self.add_distinct_candidate_and_manual(first, "candidate-bodyless")
        self.add_distinct_candidate_and_manual(first, "candidate-body")
        self.add_distinct_candidate_and_manual(second, "second")

        def delete(path: str, payload: dict[str, object] | None):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                body = None if payload is None else json.dumps(payload).encode()
                headers = self.auth_headers()
                if body is not None:
                    headers |= {"Content-Type": "application/json", "Content-Length": str(len(body))}
                connection.request("DELETE", path, body=body, headers=headers)
                response = connection.getresponse()
                result = (response.status, dict(response.getheaders()), response.read())
                connection.request("GET", "/api/health")
                followup = connection.getresponse()
                self.assertEqual(followup.status, 200, path)
                self.assertTrue(json.loads(followup.read())["ok"])
                return result
            finally:
                connection.close()

        status, _, body = delete(f"/api/candidate/{first}/candidate-bodyless", None)
        self.assertEqual(status, 200, body.decode())
        status, _, body = delete(f"/api/candidate/{first}/candidate-body", {
            "expectedProjectId": self.state.catalog_id, "expectedCatalogGeneration": self.state.catalog_generation,
        })
        self.assertEqual(status, 200, body.decode())
        self.assertEqual(self.state.candidates[first], [])

        self.state.save_manual_workspace(first, self.state.manual_workspace(second))
        status, _, body = delete(f"/api/workspace/manual/{first}", None)
        self.assertEqual(status, 200, body.decode())
        self.state.save_manual_workspace(first, self.state.manual_workspace(second))
        status, _, body = delete(f"/api/workspace/manual/{first}", {
            "expectedProjectId": self.state.catalog_id, "expectedCatalogGeneration": self.state.catalog_generation,
        })
        self.assertEqual(status, 200, body.decode())
        self.assertIsNone(self.state.manual_workspace(first))

        extra_one = self.sources / "C.png"; extra_two = self.sources / "D.png"
        Image.new("RGB", (12, 8), "red").save(extra_one); Image.new("RGB", (12, 8), "blue").save(extra_two)
        status, _, body = self.request("POST", "/api/folder", {"path": str(self.sources)}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        by_name = {item["relativePath"]: item["id"] for item in json.loads(body)["images"]}
        status, _, body = delete(f"/api/catalog/image/{by_name['C.png']}", None)
        self.assertEqual(status, 200, body.decode())
        status, _, body = delete(f"/api/catalog/image/{by_name['D.png']}", {
            "expectedProjectId": self.state.catalog_id, "expectedCatalogGeneration": self.state.catalog_generation,
        })
        self.assertEqual(status, 200, body.decode())
        self.assertFalse(self.state.workspace_store.project_has_image(project_id, by_name["C.png"]))
        self.assertFalse(self.state.workspace_store.project_has_image(project_id, by_name["D.png"]))

        bodyless_project = self.state.workspace_store.create_project("bodyless project")["id"]
        legacy_project = self.state.workspace_store.create_project("legacy project")["id"]
        status, _, body = delete(f"/api/project/{bodyless_project}", None)
        self.assertEqual(status, 200, body.decode())
        status, _, body = delete(f"/api/project/{legacy_project}", {
            "expectedProjectId": self.state.catalog_id, "expectedCatalogGeneration": self.state.catalog_generation,
        })
        self.assertEqual(status, 200, body.decode())
        self.assertIsNone(self.state.workspace_store.project(bodyless_project))
        self.assertIsNone(self.state.workspace_store.project(legacy_project))

    def test_valid_stale_legacy_delete_body_returns_409_on_all_routes_without_changes(self) -> None:
        project_id, first, second = self.open_project()
        self.add_candidate_and_manual(first)
        baseline = self.fingerprint()
        stale = {"expectedProjectId": project_id, "expectedCatalogGeneration": self.state.catalog_generation - 1}
        for path in (
            f"/api/catalog/image/{second}", f"/api/project/{project_id}",
            f"/api/candidate/{first}/candidate", f"/api/workspace/manual/{first}",
        ):
            status, headers, body = self.request("DELETE", path, stale, authorized=True)
            self.assertEqual(status, 409, (path, body.decode()))
            self.assertIsNone(headers.get("Connection"), path)
            self.assertEqual(json.loads(body)["error_code"], "stale_catalog")
            self.assertEqual(self.fingerprint(), baseline)

    def test_bodyless_image_delete_keeps_alive_for_catalog_and_next_candidate_gets(self) -> None:
        project_id, first, second = self.open_project()
        self.add_distinct_candidate_and_manual(first, "first-candidate")
        self.add_distinct_candidate_and_manual(second, "second-candidate")
        second_manual = self.state.manual_workspace(second)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("DELETE", f"/api/catalog/image/{first}", headers=self.auth_headers())
            deleted = connection.getresponse()
            self.assertEqual(deleted.status, 200)
            self.assertIsNone(deleted.getheader("Connection"))
            deleted.read()
            connection.request("GET", "/api/images")
            images_response = connection.getresponse()
            self.assertEqual(images_response.status, 200)
            images = json.loads(images_response.read())
            self.assertEqual([item["id"] for item in images["images"]], [second])
            connection.request("GET", f"/api/candidates/{second}")
            candidates_response = connection.getresponse()
            self.assertEqual(candidates_response.status, 200)
            candidates = json.loads(candidates_response.read())
            self.assertEqual([item["id"] for item in candidates["candidates"]], ["second-candidate"])
        finally:
            connection.close()
        self.assertFalse(self.state.workspace_store.project_has_image(project_id, first))
        self.assertNotIn(first, self.state.images)
        self.assertNotIn(first, self.state.candidates)
        self.assertEqual([item.candidate_id for item in self.state.candidates[second]], ["second-candidate"])
        self.assertEqual(self.state.manual_workspace(second), second_manual)
        db = sqlite3.connect(self.state.workspace_store.path)
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM candidates WHERE image_id=?", (first,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM manual_edits WHERE image_id=?", (first,)).fetchone()[0], 0)
            self.assertGreater(db.execute("SELECT COUNT(*) FROM candidates WHERE image_id=? AND deleted=0", (second,)).fetchone()[0], 0)
            self.assertGreater(db.execute("SELECT COUNT(*) FROM manual_edits WHERE image_id=?", (second,)).fetchone()[0], 0)
        finally:
            db.close()
        self.assertEqual(sorted(path.name for path in self.sources.iterdir()), ["A.png", "B.png"])

    def test_bodyless_project_delete_keeps_alive_and_updates_projects_and_current_snapshot(self) -> None:
        doomed, _, _ = self.open_project()
        status, _, body = self.request("POST", "/api/projects", {"name": "remaining project"}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        remaining = json.loads(body)["project"]["id"]
        status, _, body = self.request("POST", "/api/folder", {"path": str(self.sources)}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        remaining_images = json.loads(body)["images"]
        self.assertTrue(remaining_images)
        remaining_image = remaining_images[0]["id"]
        self.add_distinct_candidate_and_manual(remaining_image, "remaining-candidate")
        remaining_snapshot = self.state.catalog_snapshot()
        remaining_candidate = self.state.candidate_snapshot(remaining_image)
        remaining_manual = self.state.manual_workspace(remaining_image)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("DELETE", f"/api/project/{doomed}", headers=self.auth_headers())
            deleted = connection.getresponse()
            self.assertEqual(deleted.status, 200)
            self.assertIsNone(deleted.getheader("Connection"))
            deleted.read()
            connection.request("GET", "/api/projects")
            projects_response = connection.getresponse()
            self.assertEqual(projects_response.status, 200)
            projects = json.loads(projects_response.read())["projects"]
            self.assertNotIn(doomed, [item["id"] for item in projects])
            self.assertIn(remaining, [item["id"] for item in projects])
            connection.request("GET", "/api/images")
            images_response = connection.getresponse()
            self.assertEqual(images_response.status, 200)
            snapshot = json.loads(images_response.read())
            self.assertEqual(snapshot, self.state.catalog_snapshot())
            self.assertEqual(snapshot, remaining_snapshot)
            self.assertTrue(snapshot["images"])
            self.assertEqual(snapshot["project"]["id"], remaining)
        finally:
            connection.close()
        self.assertEqual(sorted(path.name for path in self.sources.iterdir()), ["A.png", "B.png"])
        self.assertEqual(self.state.candidate_snapshot(remaining_image), remaining_candidate)
        self.assertEqual(self.state.manual_workspace(remaining_image), remaining_manual)

    def test_bodyless_candidate_and_manual_deletes_preserve_other_image_workspace(self) -> None:
        original_project, first, second = self.open_project()
        self.add_distinct_candidate_and_manual(first, "first-candidate")
        self.add_distinct_candidate_and_manual(second, "second-candidate")
        other_before = {
            "candidate": self.state.candidate_snapshot(second),
            "manual": self.state.manual_workspace(second),
        }
        status, _, body = self.request("POST", "/api/projects", {"name": "other project"}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        other_project = json.loads(body)["project"]["id"]
        status, _, body = self.request("POST", "/api/folder", {"path": str(self.sources)}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        other_project_image = json.loads(body)["images"][0]["id"]
        self.add_distinct_candidate_and_manual(other_project_image, "other-project-candidate")
        other_project_before = (self.state.candidate_snapshot(other_project_image), self.state.manual_workspace(other_project_image))
        status, _, body = self.request("POST", "/api/project/open", {"projectId": original_project}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        for path, get_path, key in (
            (f"/api/candidate/{first}/first-candidate", f"/api/candidates/{first}", "candidates"),
            (f"/api/workspace/manual/{first}", f"/api/workspace/manual/{first}", "draft"),
        ):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request("DELETE", path, headers=self.auth_headers())
                deleted = connection.getresponse()
                self.assertEqual(deleted.status, 200, path)
                self.assertIsNone(deleted.getheader("Connection"))
                deleted.read()
                connection.request("GET", get_path)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                value = json.loads(response.read())[key]
                self.assertIn(value, ([], None), (path, value))
            finally:
                connection.close()
        self.assertEqual(self.state.candidate_snapshot(second), other_before["candidate"])
        self.assertEqual(self.state.manual_workspace(second), other_before["manual"])
        status, _, body = self.request("POST", "/api/project/open", {"projectId": other_project}, authorized=True)
        self.assertEqual(status, 200, body.decode())
        self.assertEqual(self.state.candidate_snapshot(other_project_image), other_project_before[0])
        self.assertEqual(self.state.manual_workspace(other_project_image), other_project_before[1])

    def test_bad_delete_auth_closes_and_a_new_connection_sees_unchanged_state(self) -> None:
        _, first, _ = self.open_project()
        baseline = self.fingerprint()
        payload = json.dumps({
            "expectedProjectId": self.state.catalog_id,
            "expectedCatalogGeneration": self.state.catalog_generation,
        }).encode()
        for bad_header in [("X-Mozarie-Token", "wrong"), ("Origin", "http://example.invalid")]:
            headers = [("Origin", self.origin), ("X-Mozarie-Token", self.state.session_token),
                       ("Content-Type", "application/json"), ("Content-Length", str(len(payload)))]
            headers = [(name, bad_header[1] if name == bad_header[0] else value) for name, value in headers]
            response = self.raw_exchange(self.raw_request_bytes("DELETE", f"/api/catalog/image/{first}", headers, payload)
                                         + self.raw_request_bytes("GET", "/api/images", []))
            self.assertIn(b" 403 ", response.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", response)
            self.assertEqual(response.count(b"HTTP/1.1 "), 1)
            status, _, body = self.request("GET", "/api/images")
            self.assertEqual(status, 200)
            self.assertEqual([item["id"] for item in json.loads(body)["images"]], [item[0] for item in baseline["images"]])
            self.assertEqual(self.fingerprint(), baseline)

    def test_all_delete_routes_reject_bad_token_and_origin_then_new_connections_recover_state(self) -> None:
        project_id, first, second = self.open_project()
        self.add_distinct_candidate_and_manual(first, "candidate")
        baseline = self.fingerprint()
        routes = (
            f"/api/catalog/image/{second}", f"/api/project/{project_id}",
            f"/api/candidate/{first}/candidate", f"/api/workspace/manual/{first}",
        )
        payload = json.dumps({
            "expectedProjectId": self.state.catalog_id,
            "expectedCatalogGeneration": self.state.catalog_generation,
        }).encode()
        for route in routes:
            for bad_name, bad_value in (("X-Mozarie-Token", "wrong"), ("Origin", "http://example.invalid")):
                headers = [("Origin", self.origin), ("X-Mozarie-Token", self.state.session_token),
                           ("Content-Type", "application/json"), ("Content-Length", str(len(payload)))]
                headers = [(name, bad_value if name == bad_name else value) for name, value in headers]
                response = self.raw_exchange(
                    self.raw_request_bytes("DELETE", route, headers, payload)
                    + self.raw_request_bytes("GET", "/api/images", [])
                )
                self.assertIn(b" 403 ", response.split(b"\r\n", 1)[0], (route, bad_name))
                self.assertIn(b"Connection: close", response)
                self.assertEqual(response.count(b"HTTP/1.1 "), 1)
                status, _, body = self.request("GET", "/api/images")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), self.state.catalog_snapshot())
                status, _, body = self.request("GET", "/api/projects")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["projects"], self.state.projects())
                status, _, body = self.request("GET", f"/api/candidates/{first}")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["candidates"], self.state.candidate_snapshot(first)["candidates"])
                status, _, body = self.request("GET", f"/api/workspace/manual/{first}")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["draft"], self.state.manual_workspace(first))
                self.assertEqual(self.fingerprint(), baseline)

    def test_json_post_and_binary_import_framing_failures_do_not_mutate_state(self) -> None:
        project_id, _, _ = self.open_project()
        session_id = "00000000-0000-4000-8000-000000000189"
        payload = self.begin_import(session_id)
        baseline = self.fingerprint()
        auth = [("Origin", self.origin), ("X-Mozarie-Token", self.state.session_token)]
        immediate = (
            self.raw_request_bytes("POST", "/api/workspace/images", auth + [("Transfer-Encoding", "chunked")]),
            self.raw_request_bytes("POST", "/api/workspace/images", auth + [("Content-Type", "application/json")]),
            self.raw_request_bytes("POST", "/api/workspace/images", auth + [("Content-Type", "application/json"), ("Content-Length", "0")]),
            self.raw_request_bytes("POST", "/api/workspace/images", auth + [("Content-Type", "application/json"), ("Content-Length", "bad")]),
            self.raw_request_bytes("POST", "/api/workspace/images", auth + [("Content-Type", "application/json"), ("Content-Length", "9" * 4301)]),
        )
        for request in immediate:
            response = self.raw_exchange(request + self.raw_request_bytes("GET", "/api/images", []))
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", response)
            self.assertEqual(response.count(b"HTTP/1.1 "), 1)
            self.assertEqual(self.fingerprint(), baseline)
        for body in (b"{", b"[]"):
            response = self.raw_exchange(self.raw_request_bytes("POST", "/api/workspace/images", auth + [
                ("Content-Type", "application/json"), ("Content-Length", str(len(body))),
            ], body))
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
            self.assertEqual(self.fingerprint(), baseline)

        for header_name, header_value, expected_status in (
            ("X-Mozarie-File-Mtime", "bad", b" 400 "),
            ("X-Mozarie-Expected-Catalog-Generation", str(self.state.catalog_generation - 1), b" 409 "),
        ):
            headers = self.import_headers(session_id, payload)
            headers[header_name] = header_value
            header_only = self.raw_request_bytes("POST", "/api/import/file", list(headers.items()))
            response = self.response_before_body(header_only)
            self.assertIn(expected_status, response.split(b"\r\n", 1)[0])
            self.assertIn(b"Connection: close", response)
            self.assertEqual(self.fingerprint(), baseline)
        self.assertEqual(self.state.catalog_id, project_id)

    def test_unavailable_workspace_delete_closes_and_only_a_new_connection_recreates(self) -> None:
        self.state.shutdown()
        previous_module_state = state_module.STATE
        previous_startup_error = state_module.STATE_STARTUP_ERROR

        def restore_module_state() -> None:
            recovered = state_module.STATE
            if recovered is not None and recovered is not previous_module_state and recovered is not self.state:
                recovered.shutdown()
            state_module.STATE = previous_module_state
            state_module.STATE_STARTUP_ERROR = previous_startup_error

        self.addCleanup(restore_module_state)
        state_module.STATE = None
        http_module.STATE = None
        response = self.raw_exchange(
            self.raw_request_bytes("DELETE", "/api/catalog/image/missing", [])
            + self.raw_request_bytes("GET", "/api/workspace/recovery", [])
        )
        self.assertIn(b" 409 ", response.split(b"\r\n", 1)[0])
        self.assertIn(b"Connection: close", response)
        self.assertEqual(response.count(b"HTTP/1.1 "), 1)

        body = b"{}"
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/workspace/recreate", body, {
                "Origin": self.origin, "Content-Type": "application/json", "Content-Length": str(len(body)),
            })
            recreated = connection.getresponse()
            self.assertEqual(recreated.status, 200, recreated.read())
            recreated.read()
        finally:
            connection.close()
        self.assertIsNotNone(http_module.STATE)
        self.state = http_module.STATE
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_delete_protocol_matrix_has_only_expected_status_and_connection_results(self) -> None:
        _, first, _ = self.open_project()
        self.add_distinct_candidate_and_manual(first, "success")
        with self.assertLogs(http_module.LOGGER.name, level="INFO") as captured:
            success = self.request("DELETE", f"/api/candidate/{first}/success", authorized=True)
            malformed = self.request("DELETE", f"/api/workspace/manual/{first}", [], authorized=True)
            forbidden_body = json.dumps({"expectedProjectId": self.state.catalog_id}).encode()
            forbidden = self.raw_exchange(self.raw_request_bytes("DELETE", f"/api/workspace/manual/{first}", [
                ("Origin", self.origin), ("X-Mozarie-Token", "wrong"),
                ("X-Mozarie-Expected-Project-Id", self.state.catalog_id or ""),
                ("X-Mozarie-Expected-Catalog-Generation", str(self.state.catalog_generation)),
                ("Content-Type", "application/json"), ("Content-Length", str(len(forbidden_body))),
            ], forbidden_body) + self.raw_request_bytes("GET", "/api/images", []))
            stale_headers = self.auth_headers(); stale_headers["X-Mozarie-Expected-Catalog-Generation"] = str(self.state.catalog_generation - 1)
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request("DELETE", f"/api/workspace/manual/{first}", headers=stale_headers)
                response = connection.getresponse()
                stale = (response.status, response.getheader("Connection"), response.read())
            finally:
                connection.close()
        self.assertEqual(success[0], 200)
        self.assertIsNone(success[1].get("Connection"))
        self.assertEqual(malformed[0], 400)
        self.assertIsNone(malformed[1].get("Connection"))
        self.assertIn(b" 403 ", forbidden.split(b"\r\n", 1)[0])
        self.assertIn(b"Connection: close", forbidden)
        self.assertEqual(forbidden.count(b"HTTP/1.1 "), 1)
        self.assertEqual(stale[0], 409)
        self.assertIsNone(stale[1])
        logs = "\n".join(captured.output)
        self.assertNotIn("501", logs)
        self.assertNotIn("Unsupported method", logs)
        self.assertNotIn('"expectedProjectId"', logs)

    def test_huge_json_integer_is_consumed_and_the_connection_remains_usable(self) -> None:
        self.open_project()
        baseline = self.fingerprint()
        authoritative = self.state.catalog_snapshot()
        body = b'{"imageIds":[],"expectedCatalogGeneration":' + (b"9" * 4301) + b'}'
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        with self.assertLogs(http_module.LOGGER.name, level="WARNING") as captured:
            try:
                connection.request("POST", "/api/workspace/images", body, {
                    "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
                    "Content-Type": "application/json", "Content-Length": str(len(body)),
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                self.assertEqual(json.loads(response.read())["error_code"], "input_invalid")
                self.assertIsNone(response.getheader("Connection"))
                connection.request("GET", "/api/images")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), authoritative)
            finally:
                connection.close()
        logs = "\n".join(captured.output)
        self.assertNotIn("status=500", logs)
        self.assertNotIn("501", logs)
        self.assertNotIn("Unsupported method", logs)
        self.assertEqual(self.fingerprint(), baseline)

    def test_import_session_directory_failure_closes_without_state_change(self) -> None:
        self.open_project()
        session_id = "00000000-0000-4000-8000-000000000201"
        payload = self.begin_import(session_id)
        baseline = self.fingerprint()
        headers = self.import_headers(session_id, payload)
        with patch.object(self.state, "_ensure_session", side_effect=OSError("read only")), \
             self.assertLogs(http_module.LOGGER.name, level="WARNING") as captured:
            response = self.raw_exchange(self.raw_request_bytes("POST", "/api/import/file", list(headers.items()), payload)
                                         + self.raw_request_bytes("GET", "/api/images", []))
        self.assertIn(b" 500 ", response.split(b"\r\n", 1)[0])
        self.assertIn(b"Connection: close", response)
        self.assertEqual(response.count(b"HTTP/1.1 "), 1)
        logs = "\n".join(captured.output)
        self.assertNotIn("501", logs)
        self.assertNotIn("Unsupported method", logs)
        self.assertEqual(self.fingerprint(), baseline)
        self.assertEqual(list(self.state.session_base_dir.rglob("*.upload.tmp")), [])

    def test_huge_import_numeric_headers_close_without_mutation_or_protocol_errors(self) -> None:
        self.open_project()
        session_id = "00000000-0000-4000-8000-000000000197"
        payload = self.begin_import(session_id)
        baseline = self.fingerprint()
        huge = "9" * 4301
        for header_name in (
            "X-Mozarie-Expected-Catalog-Generation", "X-Mozarie-File-Mtime", "X-Mozarie-File-Size",
        ):
            headers = self.import_headers(session_id, payload)
            headers[header_name] = huge
            request = self.raw_request_bytes("POST", "/api/import/file", list(headers.items()))
            with self.assertLogs(http_module.LOGGER.name, level="WARNING") as captured:
                response = self.response_before_body(request)
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0], header_name)
            self.assertIn(b"Connection: close", response)
            self.assertEqual(response.count(b"HTTP/1.1 "), 1)
            logs = "\n".join(captured.output)
            self.assertNotIn("status=500", logs)
            self.assertNotIn("501", logs)
            self.assertNotIn("Unsupported method", logs)
            self.assertEqual(self.fingerprint(), baseline)

    def test_partial_import_write_failure_removes_temporary_file_and_closes(self) -> None:
        self.open_project()
        session_id = "00000000-0000-4000-8000-000000000202"
        payload = self.begin_import(session_id)
        baseline = self.fingerprint()
        headers = self.import_headers(session_id, payload)
        real_named_temporary_file = http_module.tempfile.NamedTemporaryFile

        class FailingFile:
            def __init__(self, handle):
                self.handle = handle
                self.name = handle.name

            def __enter__(self):
                self.handle.__enter__()
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def write(self, value):
                self.handle.write(value[:8])
                raise OSError("disk full")

            def flush(self):
                return self.handle.flush()

        def failing_named_temporary_file(*args, **kwargs):
            return FailingFile(real_named_temporary_file(*args, **kwargs))

        with patch.object(http_module.tempfile, "NamedTemporaryFile", side_effect=failing_named_temporary_file), \
             self.assertLogs(http_module.LOGGER.name, level="WARNING") as captured:
            response = self.raw_exchange(
                self.raw_request_bytes("POST", "/api/import/file", list(headers.items()), payload)
                + self.raw_request_bytes("GET", "/api/images", [])
            )
        self.assertIn(b" 500 ", response.split(b"\r\n", 1)[0])
        self.assertIn(b"Connection: close", response)
        self.assertEqual(response.count(b"HTTP/1.1 "), 1)
        logs = "\n".join(captured.output)
        self.assertNotIn("501", logs)
        self.assertNotIn("Unsupported method", logs)
        self.assertEqual(self.fingerprint(), baseline)
        self.assertEqual(list(self.state.session_base_dir.rglob("*.upload.tmp")), [])


if __name__ == "__main__":
    unittest.main()
