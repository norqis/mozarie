"""Integration coverage for native-project reload and relink boundaries."""

from __future__ import annotations

import base64
import http.client
import io
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.domain import Candidate
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class ProjectNativeRelinkHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.native = self.root / "native"; self.native.mkdir()
        self.relinked = self.root / "relinked"; self.relinked.mkdir()
        self.other_native = self.root / "other-native"; self.other_native.mkdir()
        for directory in (self.native, self.relinked, self.other_native):
            Image.new("RGB", (8, 8), "white").save(directory / "native.png")
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
        self.server.shutdown(); self.server.server_close(); self.thread.join(5)
        http_module.STATE = self._previous_state
        self.state.shutdown()
        state_module.APP_DIR = self._previous_app_dir
        self._temporary.cleanup()

    @staticmethod
    def png(pixel: tuple[int, int] | None = None) -> bytes:
        image = Image.new("L", (8, 8), 0)
        if pixel is not None:
            image.putpixel(pixel, 255)
        output = io.BytesIO(); image.save(output, format="PNG")
        return output.getvalue()

    def request(self, method: str, path: str, payload: object | None = None, *, authorized: bool = False,
                expected_project_id: str | None = None, expected_generation: int | None = None) -> tuple[int, dict[str, str], bytes]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers: dict[str, str] = {"Content-Type": "application/json"} if payload is not None else {}
        if authorized:
            headers.update({"Origin": self.origin, "X-Mozarie-Token": self.state.session_token})
            if method != "GET":
                headers.update({
                    "X-Mozarie-Expected-Project-Id": expected_project_id if expected_project_id is not None else (self.state.catalog_id or ""),
                    "X-Mozarie-Expected-Catalog-Generation": str(expected_generation if expected_generation is not None else self.state.catalog_generation),
                })
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def create_mixed_project(self) -> tuple[str, str, str]:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "mixed"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.native)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        native_id = json.loads(body)["images"][0]["id"]

        upload = self.root / "browser.upload"; upload.write_bytes(self.png())
        _images, imported = self.state.import_image_file_for_api(
            upload, name="browser.png", relative_path="browser.png", client_key="browser-source",
            source_identity="browser-source", source_kind="browser-files", intent="add", include_images=False,
            mtime_ns=1, size_bytes=upload.stat().st_size,
        )
        browser_id = imported[0]["imageId"]
        candidate_path = self.state.cache_dir / browser_id / "candidate.png"
        candidate_path.parent.mkdir(parents=True, exist_ok=True); candidate_path.write_bytes(self.png((2, 2)))
        candidate = Candidate("candidate", "penis", .9, candidate_path)
        with self.state.image_io_lock(browser_id):
            with self.state.lock:
                self.state._commit_candidate_snapshot(browser_id, [candidate], replace=True)
        manual = "data:image/png;base64," + base64.b64encode(self.png((3, 3))).decode("ascii")
        self.state.save_manual_workspace(browser_id, {
            "add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": self.state._candidate_revision(browser_id),
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        self.state.set_image_flags(browser_id, {"reviewed": True})
        self.state.set_image_transform(browser_id, {"flipH": True, "flipV": False})
        return project_id, native_id, browser_id

    def test_source_status_and_native_reload_relink_keep_other_source_state(self) -> None:
        project_id, native_id, browser_id = self.create_mixed_project()
        native_source_id = next(source["id"] for source in self.state.catalog_sources if source["kind"] == "native-folder")
        for project, image, exists in ((project_id, browser_id, True), (project_id, "missing", False), ("missing", browser_id, False)):
            status, _headers, body = self.request("GET", f"/api/project/source-status?projectId={project}&imageId={image}")
            self.assertEqual(status, 200); self.assertEqual(json.loads(body), {"exists": exists})

        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.native)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); self.assertEqual({image["id"] for image in json.loads(body)["images"]}, {native_id, browser_id})
        for path in (f"/api/image/{browser_id}", f"/api/thumbnail/{browser_id}", f"/api/candidates/{browser_id}", f"/api/mask/{browser_id}/candidate?v=1-candidate"):
            status, _headers, body = self.request("GET", path)
            self.assertEqual(status, 200, f"{path}: {body.decode('utf-8', errors='replace')}")
        self.assertEqual(([candidate.candidate_id for candidate in self.state.candidates[browser_id]], self.state._candidate_revision(browser_id)), (["candidate"], 1))
        self.assertTrue(self.state.manual_workspace(browser_id)["add"].startswith("data:image/png;base64,"))
        self.assertTrue(self.state.project_history_status(browser_id)["canUndo"])
        browser = next(image for image in self.state.list_images() if image["id"] == browser_id)
        self.assertEqual((browser["reviewed"], browser["flipH"], browser["flipV"]), (True, True, False))
        status, _headers, body = self.request("POST", f"/api/workspace/manual/{browser_id}", {
            "add": "data:image/png;base64," + base64.b64encode(self.png((4, 4))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": 1, "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True,
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))

        status, _headers, body = self.request("POST", "/api/project/source/relink", {
            "projectId": project_id, "sourceId": native_source_id, "path": str(self.relinked),
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8")); self.assertEqual({image["id"] for image in json.loads(body)["images"]}, {native_id, browser_id})
        for path in (f"/api/image/{browser_id}", f"/api/thumbnail/{browser_id}", f"/api/candidates/{browser_id}", f"/api/mask/{browser_id}/candidate?v=1-candidate"):
            status, _headers, body = self.request("GET", path)
            self.assertEqual(status, 200, f"{path}: {body.decode('utf-8', errors='replace')}")
        self.assertEqual(self.state._candidate_revision(browser_id), 1)
        self.assertEqual(Path(str(self.state.workspace_store.native_source(project_id, native_source_id)["nativePath"])).resolve(), self.relinked.resolve())

    def test_relink_publish_failure_restores_durable_source_and_retries(self) -> None:
        project_id, native_id, browser_id = self.create_mixed_project()
        native_source_id = next(source["id"] for source in self.state.catalog_sources if source["kind"] == "native-folder")
        previous_source = self.state.workspace_store.native_source(project_id, native_source_id)
        previous_path = self.state.images[native_id].path

        def fail_reset() -> None:
            raise RuntimeError("GPU image cache reset failed")

        self.state.sam_predictor = SimpleNamespace(reset_image=fail_reset)
        try:
            status, _headers, body = self.request("POST", "/api/project/source/relink", {
                "projectId": project_id, "sourceId": native_source_id, "path": str(self.relinked),
            }, authorized=True)
        finally:
            self.state.sam_predictor = None
        self.assertEqual(status, 500, body.decode("utf-8"))
        self.assertEqual(self.state.workspace_store.native_source(project_id, native_source_id), previous_source)
        self.assertEqual(self.state.images[native_id].path, previous_path)
        self.assertEqual(self.state._candidate_revision(browser_id), 1)
        self.assertTrue(self.state.manual_workspace(browser_id)["add"].startswith("data:image/png;base64,"))
        self.assertTrue(self.state.project_history_status(browser_id)["canUndo"])
        self.assertEqual(next(source for source in self.state.catalog_sources if source["id"] == native_source_id), previous_source)

        status, _headers, body = self.request("POST", "/api/project/source/relink", {
            "projectId": project_id, "sourceId": native_source_id, "path": str(self.relinked),
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        self.assertEqual(Path(str(self.state.workspace_store.native_source(project_id, native_source_id)["nativePath"])).resolve(), self.relinked.resolve())

    def test_relink_rejections_leave_source_and_live_catalog_unchanged(self) -> None:
        project_id, native_id, browser_id = self.create_mixed_project()
        native_source_id = next(source["id"] for source in self.state.catalog_sources if source["kind"] == "native-folder")
        self.state.workspace_store.ensure_project_source(
            project_id, kind="native-folder", display_name=self.other_native.name, identity=str(self.other_native.resolve()),
        )
        previous_path = self.state.images[native_id].path
        previous_ids = tuple(self.state.order)
        def relink(path: Path, *, generation: int | None = None) -> tuple[int, dict[str, object]]:
            status, _headers, body = self.request("POST", "/api/project/source/relink", {
                "projectId": project_id, "sourceId": native_source_id, "path": str(path),
            }, authorized=True, expected_generation=generation)
            return status, json.loads(body)

        status, error = relink(self.other_native)
        self.assertEqual((status, error["error_code"]), (400, "project_source_conflict"))
        unmatched = self.root / "unmatched"; unmatched.mkdir(); Image.new("RGB", (8, 8), "white").save(unmatched / "other.png")
        status, error = relink(unmatched)
        self.assertEqual((status, error["error_code"]), (400, "project_source_no_match"))
        status, error = relink(self.native, generation=self.state.catalog_generation - 1)
        self.assertEqual((status, error["error_code"]), (409, "stale_catalog"))
        self.state.worker_thread = SimpleNamespace(is_alive=lambda: True)
        try:
            status, error = relink(self.native)
        finally:
            self.state.worker_thread = None
        self.assertEqual((status, error["error_code"]), (400, "operation_in_progress"))
        status, _headers, body = self.request("POST", "/api/project/complete", {}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": project_id}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, error = relink(self.native)
        self.assertEqual((status, error["error_code"]), (400, "project_read_only"))
        self.assertEqual(Path(str(self.state.workspace_store.native_source(project_id, native_source_id)["nativePath"])).resolve(), self.native.resolve())
        self.assertEqual(self.state.images[native_id].path, previous_path)
        self.assertIn(native_id, self.state.images)
