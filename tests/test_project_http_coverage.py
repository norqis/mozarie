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
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))

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
        _project_id, image_id = self.create_and_load()
        for kind in ("mosaic", "exclude"):
            status, headers, body = self.request("GET", f"/api/project/mask/{image_id}/{kind}")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertIn(f"source.png.{kind}.png", headers["Content-Disposition"])
            with Image.open(io.BytesIO(body)) as mask:
                self.assertEqual(mask.mode, "L")
                self.assertEqual(mask.size, (12, 8))
                self.assertEqual(mask.getextrema(), (0, 0))

        archive_dir = self.root / "archives"
        archive_dir.mkdir()
        native_temp = tempfile.NamedTemporaryFile

        def archive_file(*args, **kwargs):
            kwargs["dir"] = archive_dir
            return native_temp(*args, **kwargs)

        with patch.object(http_module.tempfile, "NamedTemporaryFile", side_effect=archive_file):
            for kind in ("mosaic", "exclude"):
                status, headers, body = self.request("GET", f"/api/project/masks/{kind}")
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "application/zip")
                self.assertEqual(headers["Content-Disposition"], f'attachment; filename="{kind}-masks.zip"')
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    names = archive.namelist()
                    self.assertEqual(len(names), 1)
                    self.assertTrue(names[0].endswith(f"/source.png.{kind}.png"))
                    with Image.open(io.BytesIO(archive.read(names[0]))) as mask:
                        self.assertEqual(mask.size, (12, 8))
        # The final response byte reaches the client just before the handler's
        # ``finally`` block unlinks the archive.  Wait only for that server
        # cleanup boundary rather than accepting a leaked temporary ZIP.
        for _ in range(50):
            if not list(archive_dir.iterdir()):
                break
            time.sleep(.01)
        self.assertEqual(list(archive_dir.iterdir()), [])

        status, _headers, body = self.request("GET", f"/api/project/mask/{image_id}/invalid")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("GET", "/api/project/masks/invalid")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")
        status, _headers, body = self.request("GET", "/api/project/mask/missing/mosaic")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "image_not_found")

    def test_project_history_mismatch_and_malformed_routes(self) -> None:
        Image.new("RGB", (12, 8), "gray").save(self.source_dir / "second.png")
        project_id, _image_id = self.create_and_load()
        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200)
        image_ids = {image["relativePath"]: image["id"] for image in json.loads(body)["images"]}
        image_id = image_ids["source.png"]
        second_id = image_ids["second.png"]
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

        # Only the requested mismatch is acknowledged; its new source
        # metadata remains accepted across a later project reopen.
        self.source_dir.joinpath("source.png").write_bytes(self.source_dir.joinpath("source.png").read_bytes() + b"changed")
        self.source_dir.joinpath("second.png").write_bytes(self.source_dir.joinpath("second.png").read_bytes() + b"changed")
        status, _headers, body = self.request("POST", "/api/project/close", {}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": project_id}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", "/api/project/mismatches")
        self.assertEqual(status, 200)
        self.assertEqual({item["id"] for item in json.loads(body)["images"]}, {image_id, second_id})
        status, _headers, body = self.request("POST", "/api/project/mismatches", {"imageIds": [image_id], "clearMasks": False}, authorized=True)
        self.assertEqual(status, 200)
        images = {image["id"]: image for image in json.loads(body)["images"]}
        self.assertFalse(images[image_id]["sourceMismatch"])
        self.assertTrue(images[second_id]["sourceMismatch"])
        status, _headers, body = self.request("POST", "/api/project/close", {}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": project_id}, authorized=True)
        self.assertEqual(status, 200)
        status, _headers, body = self.request("GET", "/api/project/mismatches")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in json.loads(body)["images"]], [second_id])

    def test_workspace_recovery_page_api_and_recreate_route(self) -> None:
        request = MosaicHandler.__new__(MosaicHandler)
        request.headers = {"Host": "127.0.0.1:9876", "Origin": "http://127.0.0.1:9876", "Content-Type": "application/json", "Content-Length": "2"}
        request.rfile = io.BytesIO(b"{}")
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
        request._require_json_request = Mock()
        request._read_json_body = Mock(return_value={"imageIds": ["one", "two"], "enabled": False})
        request._json = Mock()
        state = Mock()
        state.batch_update_candidates_many.return_value = {"one": 2, "two": 3}
        with patch.object(http_module, "STATE", state):
            request.do_POST()
        state.batch_update_candidates_many.assert_called_once_with(["one", "two"], {"imageIds": ["one", "two"], "enabled": False})
        request._json.assert_called_once_with({"ok": True, "candidateRevisions": {"one": 2, "two": 3}})

        request = MosaicHandler.__new__(MosaicHandler)
        request.path = "/api/import/file"
        request.headers = {"X-Mozarie-Source-Id": "x" * 129, "X-Mozarie-Source-Kind": "browser-files", "X-Mozarie-File-Mtime": "0", "X-Mozarie-File-Size": "0"}
        request._require_binary_import_request = Mock()
        request._client_error = Mock()
        with patch.object(http_module, "STATE", Mock()):
            request.do_POST()
        self.assertEqual(request._client_error.call_args.args[0].error_code, "input_invalid")

        # Keep the one-line validation branches explicit.  They are easy to
        # accidentally bypass when a later route is inserted above them.
        for path, workspace in (
            ("/api/project/mask/missing/mosaic", SimpleNamespace(project_image=lambda _image_id: None)),
            ("/api/project/masks/unknown", SimpleNamespace()),
        ):
            request = MosaicHandler.__new__(MosaicHandler)
            request.path = path
            request._require_local_host = Mock()
            request._client_error = Mock()
            state = Mock()
            state.workspace_store = workspace
            with patch.object(http_module, "STATE", state):
                request.do_GET()
            self.assertEqual(request._client_error.call_args.args[0].error_code, "input_invalid" if path.endswith("unknown") else "image_not_found")

        for path, payload in (
            ("/api/project/mismatches", {"imageIds": "not-a-list"}),
            ("/api/candidates/batch", {"imageIds": "not-a-list"}),
        ):
            request = MosaicHandler.__new__(MosaicHandler)
            request.path = path
            request._require_json_request = Mock()
            request._read_json_body = Mock(return_value=payload)
            request._client_error = Mock()
            with patch.object(http_module, "STATE", Mock()):
                request.do_POST()
            self.assertEqual(request._client_error.call_args.args[0].error_code, "input_invalid")

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
