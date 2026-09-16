"""Live contract coverage for project HTTP endpoints.

The project API has a few paths that do more than return JSON: it persists a
project lifecycle, renders lossless mask downloads, and has a recovery page
when the local workspace schema must be recreated.  Keep these browser-facing
contracts on a real loopback server so route wiring and response headers stay
covered together.
"""

from __future__ import annotations

import http.client
import io
import json
import base64
import contextlib
import shutil
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import Candidate
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class ProjectHttpCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.source_dir = self.root / "images"
        self.source_dir.mkdir()
        Image.new("RGB", (12, 8), "white").save(self.source_dir / "source.png")

        self._previous_app_dir = state_module.APP_DIR
        self._previous_state = http_module.STATE
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
        http_module.STATE = self._previous_state
        self.state.shutdown()
        state_module.APP_DIR = self._previous_app_dir
        self._temporary_directory.cleanup()

    def request(self, method: str, path: str, payload: object | None = None, *, authorized: bool = False) -> tuple[int, dict[str, str], bytes]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers: dict[str, str] = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authorized:
            headers.update({"Origin": self.origin, "X-Mozarie-Token": self.state.session_token})
            if method != "GET":
                headers.update({
                    "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
                    "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
                })
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def create_and_load(self, name: str = "Project") -> tuple[str, str]:
        status, _headers, body = self.request("POST", "/api/projects", {"name": name}, authorized=True)
        self.assertEqual(status, 200)
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200)
        return project_id, json.loads(body)["images"][0]["id"]

    def test_project_lifecycle_and_source_lookup_routes(self) -> None:
        first_id, image_id = self.create_and_load("First")

        status, _headers, body = self.request("GET", "/api/projects?sort=name_asc")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["projects"][0]["name"], "First")
        status, _headers, body = self.request("GET", f"/api/project/history/{image_id}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"canUndo": False, "canRedo": False})
        status, _headers, body = self.request("GET", "/api/project/mismatches")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"images": []})

        status, _headers, body = self.request("POST", "/api/project/name", {"name": "Renamed"}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["project"]["name"], "Renamed")
        status, _headers, body = self.request("POST", "/api/project/close", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertIsInstance(json.loads(body)["catalogGeneration"], int)

        status, _headers, body = self.request("POST", "/api/projects", {"name": "Second"}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", f"/api/project/source-check?path={self.source_dir}")
        self.assertEqual(status, 200)
        self.assertEqual([project["id"] for project in json.loads(body)["projects"]], [first_id])

        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": first_id}, authorized=True)
        opened = json.loads(body)
        self.assertEqual(status, 200)
        self.assertFalse(opened["needsSource"])
        self.assertEqual([image["id"] for image in opened["images"]], [image_id])
        status, _headers, body = self.request("POST", "/api/project/complete", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["project"]["status"], "completed")
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": first_id}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["readOnly"])
        status, _headers, body = self.request("POST", "/api/project/resume", {"projectId": first_id}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["project"]["status"], "working")
        status, _headers, body = self.request("GET", "/i18n/ja.json")
        self.assertEqual(status, 200)
        translations = json.loads(body)
        self.assertEqual(translations["project.resume"], "作業を再開")
        self.assertIn("workspaceRecovery.confirm", translations)

    def test_project_mask_png_zip_and_cleanup(self) -> None:
        Image.new("RGB", (12, 8), "black").save(self.source_dir / "hidden.png")
        project_id, image_id = self.create_and_load()
        image_id = next(image["id"] for image in self.state.list_images() if image["relativePath"] == "source.png")
        hidden_id = next(image["id"] for image in self.state.list_images() if image["relativePath"] == "hidden.png")
        status, _headers, body = self.request("POST", f"/api/workspace/image/{hidden_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        for kind in ("mosaic", "exclude"):
            status, headers, body = self.request("GET", f"/api/project/mask/{image_id}/{kind}")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertIn(f"source.png.{kind}.png", headers["Content-Disposition"])
            with Image.open(io.BytesIO(body)) as mask:
                self.assertEqual(mask.mode, "L")
                self.assertEqual(mask.size, (12, 8))
                self.assertEqual(mask.getextrema(), (0, 0))

        native_temp = tempfile.NamedTemporaryFile
        archive_paths: list[Path] = []

        def archive_file(*args, **kwargs):
            self.assertEqual(Path(kwargs["dir"]), self.state.cache_dir)
            output = native_temp(*args, **kwargs)
            archive_paths.append(Path(output.name))
            return output

        with patch.object(http_module.tempfile, "NamedTemporaryFile", side_effect=archive_file):
            for kind in ("mosaic", "exclude"):
                status, headers, body = self.request("GET", f"/api/project/masks/{project_id}/{kind}")
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "application/zip")
                self.assertEqual(headers["Content-Disposition"], f'attachment; filename="{kind}-masks.zip"')
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    names = archive.namelist()
                    self.assertEqual(len(names), 1)
                    self.assertTrue(names[0].endswith(f"/source.png.{kind}.png"))
                    self.assertFalse(any("hidden.png" in name for name in names))
                    with Image.open(io.BytesIO(archive.read(names[0]))) as mask:
                        self.assertEqual(mask.size, (12, 8))
        # The final response byte reaches the client just before the handler's
        # ``finally`` block unlinks the archive.  Wait only for that server
        # cleanup boundary rather than accepting a leaked temporary ZIP.
        self.assertTrue(archive_paths)
        self.assertTrue(all(path.parent == self.state.cache_dir for path in archive_paths))
        for _ in range(50):
            if not list(self.state.cache_dir.glob("mozarie-masks-*.zip")):
                break
            time.sleep(.01)
        self.assertEqual(list(self.state.cache_dir.glob("mozarie-masks-*.zip")), [])

        status, _headers, body = self.request("GET", f"/api/project/mask/{image_id}/invalid")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("GET", f"/api/project/masks/{project_id}/invalid")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("GET", "/api/project/mask/missing/mosaic")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "image_not_found")

    def test_project_switch_restores_only_its_durable_candidate_manual_history_and_flags(self) -> None:
        project_a, image_a = self.create_and_load("A")
        mask_path = self.state.cache_dir / image_a / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (12, 8), 255).save(mask_path)
        self.state.candidates[image_a] = [Candidate("a-candidate", "penis", 0.9, mask_path)]
        with self.state.image_io_lock(image_a):
            with self.state.lock:
                self.state._commit_candidate_snapshot(image_a, self.state.candidates[image_a], replace=True)
        raw_mask = io.BytesIO(); Image.new("L", (12, 8), 255).save(raw_mask, format="PNG")
        self.state.save_manual_workspace(image_a, {
            "add": "data:image/png;base64," + base64.b64encode(raw_mask.getvalue()).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": self.state._candidate_revision(image_a), "hasEffectiveMask": True,
        })
        status, _headers, body = self.request("POST", f"/api/workspace/image/{image_a}", {"hidden": True, "reviewed": True}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))

        source_b = self.root / "images-b"; source_b.mkdir()
        Image.new("RGB", (12, 8), "blue").save(source_b / "b.png")
        status, _headers, body = self.request("POST", "/api/projects", {"name": "B"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); project_b = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(source_b)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); image_b = json.loads(body)["images"][0]["id"]
        self.assertNotEqual(image_a, image_b)
        status, _headers, body = self.request("GET", f"/api/candidates/{image_b}")
        self.assertEqual(status, 200); self.assertEqual(json.loads(body)["candidates"], [])
        status, _headers, body = self.request("GET", f"/api/workspace/manual/{image_b}")
        self.assertEqual(status, 200); self.assertIsNone(json.loads(body)["draft"])
        status, _headers, body = self.request("GET", f"/api/project/history/{image_b}")
        self.assertEqual(status, 200); self.assertEqual(json.loads(body), {"canUndo": False, "canRedo": False})

        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": project_a}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); self.assertEqual([image["id"] for image in json.loads(body)["images"]], [image_a])
        status, _headers, body = self.request("GET", f"/api/candidates/{image_a}")
        self.assertEqual(status, 200); self.assertEqual([candidate["id"] for candidate in json.loads(body)["candidates"]], ["a-candidate"])
        status, _headers, body = self.request("GET", f"/api/workspace/manual/{image_a}")
        self.assertEqual(status, 200); self.assertTrue(json.loads(body)["draft"]["add"].startswith("data:image/png;base64,"))
        status, _headers, body = self.request("GET", f"/api/project/history/{image_a}")
        self.assertEqual(status, 200); self.assertTrue(json.loads(body)["canUndo"])
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200); self.assertEqual([(image["id"], image["hidden"], image["reviewed"]) for image in json.loads(body)["images"]], [(image_a, True, True)])
        self.assertNotEqual(project_a, project_b)

    def test_hidden_history_undo_redo_restores_processing_eligibility(self) -> None:
        _project_id, image_id = self.create_and_load()
        status, _headers, body = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200); self.assertTrue(json.loads(body)["images"][0]["hidden"])
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/begin", {"sessionId": "00000000-0000-4000-8000-000000000301", "dirtyLayers": ["add"]}, authorized=True)
        self.assertEqual(status, 400); self.assertEqual(json.loads(body)["error_code"], "image_hidden")
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/undo", {}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); self.assertEqual(json.loads(body)["changedImageIds"], [image_id])
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200); self.assertFalse(json.loads(body)["images"][0]["hidden"])
        session_id = "00000000-0000-4000-8000-000000000302"
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/begin", {"sessionId": session_id, "dirtyLayers": ["add"]}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/cancel", {"sessionId": session_id}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/redo", {}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); self.assertEqual(json.loads(body)["changedImageIds"], [image_id])
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200); self.assertTrue(json.loads(body)["images"][0]["hidden"])
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/begin", {"sessionId": "00000000-0000-4000-8000-000000000303", "dirtyLayers": ["add"]}, authorized=True)
        self.assertEqual(status, 400); self.assertEqual(json.loads(body)["error_code"], "image_hidden")

    def test_startup_removes_a_stale_mask_zip_from_a_process_cache(self) -> None:
        stale_cache = self.root / "process-stale"
        stale_cache.mkdir()
        stale_zip = stale_cache / "mozarie-masks-stale.zip"; stale_zip.write_bytes(b"stale")
        old = time.time() - 61
        __import__("os").utime(stale_cache, (old, old))
        with patch.object(state_module, "CACHE_BASE_DIR", self.root):
            StudioState._cleanup_stale_process_caches()
        self.assertFalse(stale_cache.exists())

    def test_project_history_mismatch_and_malformed_routes(self) -> None:
        project_id, image_id = self.create_and_load()
        status, _headers, body = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", f"/api/project/history/{image_id}")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["canUndo"])
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/undo", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["changedImageIds"], [image_id])
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/redo", {}, authorized=True)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["canUndo"])
        status, _headers, body = self.request("POST", f"/api/project/history/{image_id}/bad", {}, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("POST", "/api/project/mismatches", {"imageIds": "bad"}, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": "missing"}, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "project_not_found")
        status, _headers, body = self.request("POST", "/api/project/source-check", {"path": "missing"}, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "folder_not_found")

        # A changed source is reported first.  Confirming without clearMasks
        # accepts same-size metadata and keeps the project masks/history.
        Image.new("RGB", (12, 8), "black").save(self.source_dir / "source.png")
        status, _headers, body = self.request("POST", "/api/project/close", {}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": project_id}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", "/api/project/mismatches")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["images"][0]["id"], image_id)
        status, _headers, body = self.request("POST", "/api/project/mismatches", {"imageIds": [image_id], "clearMasks": False}, authorized=True)
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["images"][0]["sourceMismatch"])

    def test_workspace_recovery_page_api_and_recreate_route(self) -> None:
        request = MosaicHandler.__new__(MosaicHandler)
        request.headers = {"Host": "127.0.0.1:9876"}
        request.rfile = io.BytesIO()
        request.wfile = io.BytesIO()
        request.close_connection = False
        request.server = SimpleNamespace(server_port=9876)
        request.path = "/api/workspace/recovery"
        request._json = Mock()
        with patch.object(http_module, "STATE", None):
            request.do_GET()
        request._json.assert_called_once_with({"required": True, "errorCode": "workspace_recreate_required"})

        request = MosaicHandler.__new__(MosaicHandler)
        request.headers = {"Host": "127.0.0.1:9876"}
        request.rfile = io.BytesIO()
        request.wfile = io.BytesIO()
        request.close_connection = False
        request.server = SimpleNamespace(server_port=9876)
        request.path = "/"
        request._binary = Mock()
        with patch.object(http_module, "STATE", None):
            request.do_GET()
        page = request._binary.call_args.args[0].decode("utf-8")
        self.assertIn('data-key="workspaceRecovery.title"', page)
        self.assertIn("/api/workspace/recreate", page)
        self.assertIn("/i18n/", page)

        request = MosaicHandler.__new__(MosaicHandler)
        request.headers = {"Host": "127.0.0.1:9876", "Origin": "http://127.0.0.1:9876", "Content-Type": "application/json", "Content-Length": "2"}
        request.rfile = io.BytesIO(b"{}")
        request.wfile = io.BytesIO()
        request.close_connection = False
        request.server = SimpleNamespace(server_port=9876)
        request.path = "/api/workspace/recreate"
        request._json = Mock()
        recreated = Mock()
        with patch.object(http_module, "STATE", None), patch.object(state_module, "recreate_workspace", return_value=recreated):
            request.do_POST()
        request._json.assert_called_once_with({"ok": True})

        # Recovery is intentionally narrower than normal mutations: it has no
        # session token, but still requires the local origin and JSON request.
        for headers in (
            {"Host": "127.0.0.1:9876", "Origin": "http://other", "Content-Type": "application/json", "Content-Length": "2"},
            {"Host": "127.0.0.1:9876", "Origin": "http://127.0.0.1:9876", "Content-Type": "text/plain", "Content-Length": "2"},
        ):
            request = MosaicHandler.__new__(MosaicHandler)
            request.headers = headers
            request.rfile = io.BytesIO(b"{}")
            request.wfile = io.BytesIO()
            request.close_connection = False
            request.server = SimpleNamespace(server_port=9876)
            request.path = "/api/workspace/recreate"
            request._client_error = Mock()
            with patch.object(http_module, "STATE", None):
                request.do_POST()
            self.assertEqual(request._client_error.call_args.args[0].error_code, "session_expired")

        request = MosaicHandler.__new__(MosaicHandler)
        request.headers = {"Host": "127.0.0.1:9876"}
        request.rfile = io.BytesIO()
        request.wfile = io.BytesIO()
        request.close_connection = False
        request.server = SimpleNamespace(server_port=9876)
        request.path = "/api/projects"
        request._client_error = Mock()
        with patch.object(http_module, "STATE", None):
            request.do_POST()
        self.assertEqual(request._client_error.call_args.args[0].error_code, "workspace_recreate_required")

    def test_live_unavailable_workspace_routes_are_strict_and_recover_once(self) -> None:
        """A missing workspace must not leak the regular app or its static aliases."""
        previous = http_module.STATE
        http_module.STATE = None
        try:
            for path in ("/", "/index.html"):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
                self.assertIn(b"fetch(`/i18n/${lang}.json`", body)
                self.assertIn(b"button.disabled = true", body)
                self.assertIn(b"if (response.ok)", body)

            for path in ("/i18n/ja.json", "/i18n/en.json"):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
                self.assertIn("workspaceRecovery.title", json.loads(body))

            for path in ("/index", "/favicon.ico", "/i18n/ja", "/i18n/ja.json/extra"):
                status, _headers, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(body)["error_code"], "api_not_found")

            for method, path in (("GET", "/api"), ("GET", "/api/images"), ("POST", "/api/images"), ("DELETE", "/api/images")):
                status, _headers, body = self.request(method, path, {} if method == "POST" else None)
                self.assertEqual(status, 409)
                self.assertEqual(json.loads(body)["error_code"], "workspace_recreate_required")

            for method in ("POST", "DELETE"):
                status, _headers, body = self.request(method, "/not-api", {} if method == "POST" else None)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(body)["error_code"], "api_not_found")

            with patch.object(state_module, "recreate_workspace", return_value=self.state) as recreate:
                status, _headers, body = self.request("POST", "/api/workspace/recreate", {}, authorized=True)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"ok": True})
            recreate.assert_called_once_with()
            self.assertIs(http_module.STATE, self.state)

            # This forces the outer recovery boundary while STATE is still
            # absent.  It must return one structured 500, not throw again when
            # checking the normal GPU-recovery hook.
            http_module.STATE = None
            with patch.object(MosaicHandler, "_send_workspace_recovery_page", side_effect=RuntimeError("render failed")):
                status, _headers, body = self.request("GET", "/")
            self.assertEqual(status, 500)
            self.assertEqual(json.loads(body)["error_code"], "internal_error")
        finally:
            http_module.STATE = previous

    def test_project_adjacent_batch_and_stream_error_paths(self) -> None:
        # Project batch edits are routed through the shared candidates API;
        # exercise the many-image form so its response stays plural.
        request = MosaicHandler.__new__(MosaicHandler)
        request.path = "/api/candidates/batch"
        request.headers = {
            "X-Mozarie-Expected-Project-Id": "",
            "X-Mozarie-Expected-Catalog-Generation": "0",
        }
        request._require_json_request = Mock()
        request._read_json_body = Mock(return_value={"imageIds": ["one", "two"], "enabled": False})
        request._json = Mock()
        state = Mock()
        state.catalog_request.return_value = contextlib.nullcontext()
        state.batch_update_candidates_many.return_value = {"one": 2, "two": 3}
        with patch.object(http_module, "STATE", state):
            request.do_POST()
        state.batch_update_candidates_many.assert_called_once_with(["one", "two"], {"imageIds": ["one", "two"], "enabled": False})
        request._json.assert_called_once_with({"ok": True, "candidateRevisions": {"one": 2, "two": 3}})

        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "archive.zip"
            archive.write_bytes(b"archive")
            request = MosaicHandler.__new__(MosaicHandler)
            request.close_connection = False
            request.send_response = Mock(side_effect=BrokenPipeError)
            request.send_header = Mock()
            request.end_headers = Mock()
            request.wfile = io.BytesIO()
            request._stream_path(archive, "application/zip", {})
        self.assertTrue(request.close_connection)


if __name__ == "__main__":
    unittest.main()
