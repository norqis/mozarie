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
import warnings
from unittest.mock import patch
from pathlib import Path

from PIL import Image, PngImagePlugin

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import Candidate, ClientError, Job
from mozarie.runtime_types import DetectionModels
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class LiveHttpEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name).resolve()
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

    def raw_request(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        if method != "GET" and "X-Mozarie-Expected-Catalog-Generation" not in headers:
            headers = {
                **headers,
                "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
                "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
            }
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

    def test_live_output_directory_picker_updates_settings_without_gpu_probe(self) -> None:
        output = Path(self._temporary_directory.name) / "output"
        output.mkdir()
        gpu_settings = json.loads(json.dumps(self.state.settings))
        gpu_settings["models"]["provider"] = "gpu"
        self.state.settings = self.state.settings_store.save(gpu_settings)
        with patch.object(http_module, "_pick_output_directory", return_value=str(output.resolve())) as picker, \
             patch.object(self.state, "_require_supported_gpu", side_effect=AssertionError("GPU must not be checked")) as probe:
            status, _headers, body = self.request(
                "POST", "/api/output-directory/pick", {"currentPath": str(output)}, authorized=True,
            )
        self.assertEqual(status, 200, body.decode("utf-8"))
        payload = json.loads(body)
        self.assertEqual(payload["path"], str(output.resolve()))
        self.assertEqual(payload["settings"]["saving"]["default_output_directory"], str(output.resolve()))
        picker.assert_called_once_with(current_path=str(output))
        probe.assert_not_called()

    def test_get_body_is_rejected_and_cannot_frame_the_following_request(self) -> None:
        """A failed mutation body before GET must never become the next method token."""
        body = b'{"expectedProjectId":null,"expectedCatalogGeneration":0}'
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("GET", "/api/health", body=body, headers={"Content-Length": str(len(body))})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read())["error_code"], "input_invalid")
            self.assertEqual(response.getheader("Connection"), "close")
        finally:
            connection.close()
        status, _headers, response_body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(response_body)["ok"])

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

    def test_delete_json_body_is_fully_consumed_before_the_next_request(self) -> None:
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        payload = json.dumps({
            "expectedProjectId": self.state.catalog_id,
            "expectedCatalogGeneration": self.state.catalog_generation,
        }).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("DELETE", f"/api/catalog/image/{image_id}", body=payload, headers={
                "Origin": self.origin,
                "X-Mozarie-Token": self.state.session_token,
                "Content-Type": "application/json",
            })
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())["ok"])
        finally:
            connection.close()

    def test_live_binary_import_validates_then_stages_an_image(self) -> None:
        headers = {
            "Origin": self.origin,
            "X-Mozarie-Token": self.state.session_token,
            "X-Mozarie-Source-Kind": "browser-files",
            "X-Mozarie-Import-Parallelism": "1",
            "X-Mozarie-Import-Target-Count": "1",
            "X-Mozarie-File-Mtime": "0",
        }
        status, _headers, body = self.raw_request(
            "POST", "/api/import/file", b"not-an-image", {
                **headers, "Content-Type": "text/plain", "X-Mozarie-File-Size": str(len(b"not-an-image")),
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "session_expired")

        session_id = "cc1cfba8-f5d9-4cd5-a64c-5a3ce14ad014"
        status, _headers, body = self.request(
            "POST", "/api/import/start", {"sessionId": session_id}, authorized=True,
        )
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")

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
                "X-Mozarie-Import-Intent": "add",
                "X-Mozarie-Import-Session": session_id,
                "X-Mozarie-File-Size": str(len(encoded.getvalue())),
            },
        )
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        response = json.loads(body)
        self.assertTrue(response["imported"])
        self.assertEqual(response["catalogId"], self.state.catalog_id)
        self.assertEqual(response["catalogGeneration"], self.state.catalog_generation)

    def test_live_binary_import_accepts_large_png_text_from_browser_staging(self) -> None:
        session_id = "cc1cfba8-f5d9-4cd5-a64c-5a3ce14ad015"
        status, _headers, body = self.request(
            "POST", "/api/import/start", {"sessionId": session_id}, authorized=True,
        )
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")

        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("workflow", "x" * 1_200_000, zip=True)
        encoded = io.BytesIO()
        Image.new("RGB", (13, 9), "white").save(encoded, format="PNG", pnginfo=metadata)
        image_bytes = encoded.getvalue()
        status, _headers, body = self.raw_request(
            "POST", "/api/import/file", image_bytes, {
                "Origin": self.origin,
                "X-Mozarie-Token": self.state.session_token,
                "Content-Type": "application/octet-stream",
                "X-Mozarie-Name": "large-workflow.png",
                "X-Mozarie-Relative-Path": "large-workflow.png",
                "X-Mozarie-Client-Key": "large-workflow-live-import",
                "X-Mozarie-Source-Kind": "browser-files",
                "X-Mozarie-Source-Id": "cc1cfba8-f5d9-4cd5-a64c-5a3ce14ad016",
                "X-Mozarie-Import-Intent": "add",
                "X-Mozarie-Import-Session": session_id,
                "X-Mozarie-File-Mtime": "0",
                "X-Mozarie-File-Size": str(len(image_bytes)),
            },
        )
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        imported = json.loads(body)["imported"]
        self.assertEqual(len(imported), 1)
        image_id = imported[0]["imageId"]
        self.assertEqual(self.state.images[image_id].path.read_bytes(), image_bytes)
        self.assertIn(b"zTXt", image_bytes)

        status, _headers, body = self.request("GET", "/api/images")
        self.assertEqual(status, 200)
        self.assertEqual([item["relativePath"] for item in json.loads(body)["images"]], ["large-workflow.png"])
        status, headers, body = self.request("GET", f"/api/image/{image_id}")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(body, image_bytes)

        status, headers, body = self.request("GET", f"/api/thumbnail/{image_id}")
        self.assertEqual(status, 200)
        self.assertIn(headers["Content-Type"], {"image/jpeg", "image/png"})
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (13, 9))

    def test_live_manual_layer_transfer_persists_and_recovers_after_cancel_or_commit_failure(self) -> None:
        """Run the browser's begin/layer/commit protocol through a real server."""
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Manual transfer"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        def mask_bytes(point: tuple[int, int]) -> bytes:
            encoded = io.BytesIO(); image = Image.new("L", (12, 8), 0)
            image.putpixel(point, 255); image.save(encoded, format="PNG")
            return encoded.getvalue()
        layers = {"add": mask_bytes((3, 4)), "exclusion": mask_bytes((5, 4)), "exclusionErase": mask_bytes((5, 4))}
        base_payload = {
            "emptyLayers": [], "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
            "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": True,
            "dirtyRois": {"add": {"left": 2, "top": 3, "right": 5, "bottom": 6}},
        }

        def begin(session_id: str, dirty_layers: list[str]) -> None:
            status, _headers, response = self.request(
                "POST", f"/api/workspace/manual/{image_id}/begin",
                {"sessionId": session_id, "dirtyLayers": dirty_layers}, authorized=True,
            )
            self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")

        def layer(session_id: str, layer_name: str, value: bytes) -> None:
            status, _headers, response = self.raw_request(
                "POST", f"/api/workspace/manual/{image_id}/layer/{session_id}/{layer_name}", value,
                {
                    "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
                    "Content-Type": "application/octet-stream",
                },
            )
            self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")

        session = "00000000-0000-4000-8000-000000000101"
        begin(session, list(layers))
        for layer_name, value in layers.items(): layer(session, layer_name, value)
        status, _headers, response = self.request(
            "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": session}, authorized=True,
        )
        self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
        persisted = self.state.manual_workspace(image_id)
        self.assertIsNotNone(persisted)
        self.assertTrue(all(persisted[layer_name].startswith("data:image/png;base64,") for layer_name in layers))
        self.assertTrue(persisted["hasEffectiveMask"])
        status, _headers, response = self.request("GET", f"/api/workspace/manual/{image_id}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response)["draft"]["add"], persisted["add"])

        reopened = StudioState(self.state.cache_dir, self.state.session_base_dir)
        previous_state = http_module.STATE
        try:
            reopened.open_project(project_id)
            http_module.STATE = reopened
            status, _headers, response = self.request("GET", f"/api/workspace/manual/{image_id}")
            self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
            restarted = json.loads(response)["draft"]
            self.assertEqual({name: restarted[name] for name in layers}, {name: persisted[name] for name in layers})
        finally:
            http_module.STATE = previous_state
            reopened.shutdown()

        emptied = "00000000-0000-4000-8000-000000000102"
        begin(emptied, ["exclusionErase"])
        status, _headers, response = self.request(
            "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": emptied, "emptyLayers": ["exclusionErase"], "dirtyRois": {}}, authorized=True,
        )
        self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
        persisted = self.state.manual_workspace(image_id)
        self.assertEqual(persisted["exclusionErase"], "")

        cancelled = "00000000-0000-4000-8000-000000000103"
        begin(cancelled, ["add"]); layer(cancelled, "add", layers["add"])
        status, _headers, response = self.request(
            "POST", f"/api/workspace/manual/{image_id}/cancel", {"sessionId": cancelled}, authorized=True,
        )
        self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
        self.assertNotIn(cancelled, self.state._manual_uploads)
        self.assertEqual(self.state.manual_workspace(image_id)["add"], persisted["add"])

        failed = "00000000-0000-4000-8000-000000000104"
        begin(failed, ["add"]); layer(failed, "add", layers["add"])
        with patch.object(self.state, "save_manual_workspace", side_effect=ClientError("保存に失敗しました。", "workspace_write_failed")):
            status, _headers, response = self.request(
                "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": failed}, authorized=True,
            )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(response)["error_code"], "workspace_write_failed")
        self.assertNotIn(failed, self.state._manual_uploads)
        self.assertEqual(self.state.manual_workspace(image_id)["add"], persisted["add"])

        retry = "00000000-0000-4000-8000-000000000105"
        begin(retry, ["add"]); layer(retry, "add", layers["add"])
        status, _headers, response = self.request(
            "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": retry}, authorized=True,
        )
        self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
        self.assertNotIn(retry, self.state._manual_uploads)

    def test_project_mask_export_succeeds_when_warnings_are_errors(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Masks"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            status, headers, body = self.request("GET", f"/api/project/mask/{image_id}/mosaic")
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertEqual(headers["Content-Type"], "image/png")
        with Image.open(io.BytesIO(body)) as mask:
            self.assertEqual((mask.mode, mask.size), ("L", (12, 8)))

    def test_source_delete_rejects_a_same_fingerprint_foreign_replacement(self) -> None:
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        delete_token = "00000000-0000-4000-8000-000000000002"
        status, _headers, body = self.request("POST", "/api/catalog/delete-source/prepare", {
            "imageIds": [image_id], "deleteToken": delete_token,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/catalog/delete-source/claim", {
            "deleteToken": delete_token,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        source = self.source_dir / "source.png"; original = source.read_bytes(); stat = source.stat()
        foreign = self.source_dir / "foreign.png"
        foreign_bytes = bytearray(original); foreign_bytes[-1] ^= 1
        foreign.write_bytes(foreign_bytes)
        __import__("os").utime(foreign, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        foreign.replace(source)
        self.assertEqual((source.stat().st_mtime_ns, source.stat().st_size), (stat.st_mtime_ns, stat.st_size))
        status, _headers, body = self.request("POST", "/api/catalog/delete-source", {
            "imageIds": [image_id], "deleteToken": delete_token,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        result = json.loads(body)
        self.assertEqual(result["removedImageIds"], [])
        self.assertEqual(result["failed"][0]["reason"], "source_changed")
        self.assertEqual(source.read_bytes(), bytes(foreign_bytes))
        self.assertFalse(any(self.source_dir.glob(".source.png.mozarie-delete-*")))

    def test_save_reserve_requires_a_canonical_uuid_token(self) -> None:
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        status, _headers, body = self.request("POST", "/api/save/reserve", {
            "imageId": image_id,
            "candidateRevision": self.state._candidate_revision(image_id),
            "clientSaveToken": "not-a-canonical-uuid",
            "copyToDefault": False,
            "format": "original",
            "keepMetadata": True,
        }, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "input_invalid")

    def test_live_browser_save_render_streams_a_stable_image_response(self) -> None:
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        client_save_token = "00000000-0000-4000-8000-000000000001"
        status, _headers, body = self.request("POST", "/api/save/reserve", {
            "imageId": image_id,
            "candidateRevision": self.state._candidate_revision(image_id),
            "clientSaveToken": client_save_token,
            "copyToDefault": False,
            "format": "original",
            "keepMetadata": True,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, headers, body = self.request("POST", "/api/save/render", {
            "imageId": image_id,
            "candidateRevision": self.state._candidate_revision(image_id),
            "clientSaveToken": client_save_token,
            "divisor": 100,
            "draft": None,
            "copyToDefault": False,
            "format": "original",
            "keepMetadata": True,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertTrue(headers.get("X-Mozarie-Save-Token"))
        with Image.open(io.BytesIO(body)) as rendered:
            self.assertEqual((rendered.mode, rendered.size), ("RGB", (12, 8)))

    def test_live_browser_overwrite_converts_png_to_jpg_and_persists_the_new_path(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Format overwrite"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        options = {
            "imageId": image_id, "candidateRevision": 0,
            "clientSaveToken": "00000000-0000-4000-8000-000000000061",
            "copyToDefault": False, "suffix": "_censored", "format": "jpg", "keepMetadata": False,
        }
        status, _headers, body = self.request("POST", "/api/save/reserve", options, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, headers, body = self.request("POST", "/api/save/render", {**options, "divisor": 100, "draft": None}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": 0, "saveToken": headers["X-Mozarie-Save-Token"], "sourceAction": "overwrite",
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        converted = self.source_dir / "source.jpg"
        self.assertFalse((self.source_dir / "source.png").exists())
        self.assertTrue(converted.is_file())
        with Image.open(converted) as saved:
            self.assertEqual(saved.format, "JPEG")
        self.assertEqual(self.state.image_for_id(image_id).path, converted)
        self.assertEqual(self.state.workspace_store.project_image(image_id)["relativePath"], "source.jpg")
        reopened = StudioState(self.state.cache_dir, self.state.session_base_dir)
        try:
            reopened.open_project(project_id)
            self.assertEqual(reopened.image_for_id(image_id).path, converted)
        finally:
            reopened.shutdown()

    def test_live_background_overwrite_converts_jpg_to_png(self) -> None:
        Image.new("RGB", (12, 8), "white").save(self.source_dir / "second.jpg")
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = next(image["id"] for image in json.loads(body)["images"] if image["relativePath"] == "second.jpg")
        status, _headers, body = self.request("POST", "/api/apply", {
            "imageIds": [image_id], "divisor": 100, "drafts": {}, "copyToDefault": False,
            "suffix": "_censored", "format": "png", "keepMetadata": False,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, _headers, body = self.request("GET", "/api/job")
            self.assertEqual(status, 200)
            if json.loads(body)["state"] in {"complete", "error"}:
                break
            time.sleep(.02)
        self.assertEqual(json.loads(body)["state"], "complete", body.decode("utf-8"))
        converted = self.source_dir / "second.png"
        self.assertFalse((self.source_dir / "second.jpg").exists())
        with Image.open(converted) as saved:
            self.assertEqual(saved.format, "PNG")
        self.assertEqual(self.state.image_for_id(image_id).path, converted)

    def test_live_format_overwrite_rejects_a_same_stem_destination_without_touching_either_file(self) -> None:
        destination = self.source_dir / "source.jpg"; Image.new("RGB", (4, 4), "black").save(destination)
        foreign = destination.read_bytes()
        original = (self.source_dir / "source.png").read_bytes()
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = next(image["id"] for image in json.loads(body)["images"] if image["relativePath"] == "source.png")
        options = {
            "imageId": image_id, "candidateRevision": 0,
            "clientSaveToken": "00000000-0000-4000-8000-000000000062",
            "copyToDefault": False, "suffix": "_censored", "format": "jpg", "keepMetadata": False,
        }
        status, _headers, body = self.request("POST", "/api/save/reserve", options, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, headers, body = self.request("POST", "/api/save/render", {**options, "divisor": 100, "draft": None}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": 0, "saveToken": headers["X-Mozarie-Save-Token"], "sourceAction": "overwrite",
        }, authorized=True)
        self.assertEqual(status, 400, body.decode("utf-8"))
        self.assertEqual(json.loads(body)["error_code"], "save_write_failed")
        self.assertEqual((self.source_dir / "source.png").read_bytes(), original)
        self.assertEqual(destination.read_bytes(), foreign)
        self.assertEqual(self.state.image_for_id(image_id).relative_path, "source.png")

    def test_live_format_overwrite_database_failure_restores_the_original_source_and_catalogue_path(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Format rollback"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        original = (self.source_dir / "source.png").read_bytes()
        options = {
            "imageId": image_id, "candidateRevision": 0,
            "clientSaveToken": "00000000-0000-4000-8000-000000000063",
            "copyToDefault": False, "suffix": "_censored", "format": "jpg", "keepMetadata": False,
        }
        status, _headers, body = self.request("POST", "/api/save/reserve", options, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, headers, body = self.request("POST", "/api/save/render", {**options, "divisor": 100, "draft": None}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        with patch.object(self.state.workspace_store, "commit_save", side_effect=sqlite3.OperationalError("locked")):
            status, _headers, body = self.request("POST", "/api/save/commit", {
                "imageId": image_id, "candidateRevision": 0, "saveToken": headers["X-Mozarie-Save-Token"], "sourceAction": "overwrite",
            }, authorized=True)
        self.assertEqual(status, 500, body.decode("utf-8"))
        self.assertEqual((self.source_dir / "source.png").read_bytes(), original)
        self.assertFalse((self.source_dir / "source.jpg").exists())
        self.assertEqual(self.state.image_for_id(image_id).relative_path, "source.png")
        self.assertEqual(self.state.workspace_store.project_image(image_id)["relativePath"], "source.png")

    def test_live_detect_edit_and_copy_save_preserves_png_metadata(self) -> None:
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("workflow", "w" * 1_200_000, zip=True)
        source = Image.new("RGB", (12, 8), "white")
        for y in range(8):
            for x in range(12):
                source.putpixel((x, y), (x * 20, y * 25, (x + y) * 10))
        source.save(self.source_dir / "source.png", pnginfo=metadata)
        output_dir = Path(self._temporary_directory.name) / "saved"
        output_dir.mkdir()
        self.state.settings["saving"]["default_output_directory"] = str(output_dir.resolve())

        status, _headers, body = self.request("POST", "/api/projects", {"name": "Detect edit save"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        record = self.state.image_for_id(image_id)
        self.state.job = Job(started_at=time.time(), kind="detect", state="running", total=1, image_ids=(image_id,))
        pending_path = self.state.cache_dir / image_id / ".mozarie-pending-detected.png"

        def detect(*_args, **_kwargs):
            pending_path.parent.mkdir(parents=True, exist_ok=True)
            pixels = Image.new("L", (12, 8), 0)
            for y in range(2, 7):
                for x in range(3, 10):
                    pixels.putpixel((x, y), 255)
            pixels.save(pending_path)
            return [Candidate("detected", "penis", .9, pending_path)]

        with patch.object(self.state, "_ensure_models", return_value=DetectionModels(target=object())), \
                patch.object(self.state, "_detect_image", side_effect=detect):
            self.state._detect_worker([record], .5, 1)
        self.assertEqual(self.state.job.state, "complete")
        revision = self.state._candidate_revision(image_id)
        self.assertEqual(revision, 1)

        manual = io.BytesIO()
        manual_mask = Image.new("L", (12, 8), 0)
        manual_mask.putpixel((1, 1), 255)
        manual_mask.save(manual, format="PNG")
        manual_session = "00000000-0000-4000-8000-000000000022"
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/begin", {
            "sessionId": manual_session, "dirtyLayers": ["add"],
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.raw_request(
            "POST", f"/api/workspace/manual/{image_id}/layer/{manual_session}/add", manual.getvalue(),
            {"Origin": self.origin, "X-Mozarie-Token": self.state.session_token, "Content-Type": "application/octet-stream"},
        )
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{image_id}/commit", {
            "sessionId": manual_session, "emptyLayers": [], "manualEnabled": True,
            "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
            "manualExclusionForced": True, "removedCandidateIds": [],
            "candidateRevision": revision, "hasEffectiveMask": True,
            "dirtyRois": {"add": {"left": 0, "top": 0, "right": 3, "bottom": 3}},
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertTrue(self.state.manual_workspace(image_id)["add"].startswith("data:image/png;base64,"))

        client_token = "00000000-0000-4000-8000-000000000021"
        save_options = {
            "imageId": image_id, "candidateRevision": revision, "clientSaveToken": client_token,
            "copyToDefault": True, "suffix": "_saved", "format": "original", "keepMetadata": True,
        }
        status, _headers, body = self.request("POST", "/api/save/reserve", save_options, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        output_path = Path(json.loads(body)["outputPath"])
        status, headers, body = self.request("POST", "/api/save/render", {
            **save_options, "divisor": 4, "draft": None,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertEqual(body, b"")
        save_token = headers["X-Mozarie-Save-Token"]
        status, _headers, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": revision,
            "saveToken": save_token, "sourceAction": "keep",
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertTrue(json.loads(body)["cleared"])
        self.assertTrue(output_path.is_file())
        with patch.object(PngImagePlugin, "MAX_TEXT_CHUNK", 2_000_000), Image.open(output_path) as saved:
            self.assertEqual(saved.info["workflow"], "w" * 1_200_000)
            self.assertNotEqual(saved.getpixel((5, 4)), source.getpixel((5, 4)), "the detected candidate changes its covered pixel")
            self.assertNotEqual(saved.getpixel((1, 1)), source.getpixel((1, 1)), "the uploaded manual mask changes its manual-only pixel")
            self.assertEqual(saved.getpixel((11, 0)), source.getpixel((11, 0)), "pixels outside both masks remain unchanged")
        status, _headers, body = self.request("POST", "/api/save/ack", {"saveToken": save_token}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertTrue(json.loads(body)["acknowledged"])
        self.assertEqual((self.source_dir / "source.png").exists(), True)

        reopened = StudioState(self.state.cache_dir, self.state.session_base_dir)
        try:
            reopened.open_project(project_id)
            reopened_candidates = reopened.candidates.get(image_id, [])
            self.assertEqual([candidate.candidate_id for candidate in reopened_candidates], ["detected"])
            self.assertEqual(reopened._candidate_revision(image_id), revision)
            reopened_manual = reopened.manual_workspace(image_id)
            self.assertIsNotNone(reopened_manual)
            self.assertTrue(reopened_manual["add"].startswith("data:image/png;base64,"))
        finally:
            reopened.shutdown()

    def test_flag_write_keeps_catalogue_state_consistent_across_a_sqlite_wait(self) -> None:
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
            # The write holds the catalogue transition until SQLite confirms it.
            # Release it before reading state so the test verifies the durable
            # transition rather than relying on an implementation-specific lock order.
            release.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            status, _headers, body = self.request("GET", "/api/job")
            self.assertEqual(status, 200)
            self.assertIn("state", json.loads(body))
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

    def test_hidden_images_are_rejected_by_explicit_detect_apply_and_browser_save_requests(self) -> None:
        """A stale client cannot process a hidden image by posting its ID directly."""
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        status, _headers, body = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))

        self.state.settings["models"]["provider"] = "cpu"
        for path, payload in (
            ("/api/detect", {"imageIds": [image_id], "confidence": 0.5, "parallelism": 1, "targetClasses": ["penis"]}),
            ("/api/apply", {"imageIds": [image_id], "divisor": 100, "drafts": {}, "copyToDefault": False, "suffix": "_censored", "format": "original", "keepMetadata": True}),
            ("/api/save/reserve", {"imageId": image_id, "candidateRevision": 0, "clientSaveToken": "00000000-0000-4000-8000-000000000011", "copyToDefault": False, "suffix": "_censored", "format": "original", "keepMetadata": True}),
        ):
            status, _headers, body = self.request("POST", path, payload, authorized=True)
            self.assertEqual(status, 400, f"{path}: {body.decode('utf-8')}")
            self.assertEqual(json.loads(body)["error_code"], "image_hidden")


if __name__ == "__main__":
    unittest.main()
