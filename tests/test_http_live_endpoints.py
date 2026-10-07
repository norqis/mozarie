"""Live HTTP coverage for the local-only request handler.

These tests deliberately use a real loopback server and a real StudioState.
They cover the browser-facing contract without substituting handler methods.
"""

from __future__ import annotations

import http.client
import base64
import hashlib
import io
import json
import sqlite3
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
import warnings
from unittest.mock import patch
from pathlib import Path

from PIL import Image, ImageOps, PngImagePlugin
from tests import prepare_test_app_config
import numpy as np

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import Candidate, ClientError, Job
from mozarie.runtime_types import DetectionModels
from mozarie.http import MosaicHandler
from mozarie.state import StudioState

THREAD_TIMEOUT = 30


def join_threads(*threads: threading.Thread) -> None:
    started = [thread for thread in threads if thread.ident is not None]
    for thread in started:
        thread.join(THREAD_TIMEOUT)
    for thread in started:
        if thread.is_alive():
            raise AssertionError(f"thread did not finish: {thread.name}")


class LiveHttpEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name).resolve()
        self.app_dir = root / "app"
        prepare_test_app_config(self.app_dir)
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

    def test_manual_revision_conflicts_keep_pixels_and_empty_delete_is_undoable(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        endpoint = f"/api/workspace/manual/{image_id}"
        status, _, body = self.request("GET", endpoint)
        self.assertEqual((status, json.loads(body)), (200, {"draft": None, "manualRevision": 0}))
        with Image.new("RGBA", (12, 8)) as mask, io.BytesIO() as output:
            mask.putpixel((2, 2), (255, 255, 255, 255))
            mask.putpixel((8, 4), (255, 255, 255, 255))
            mask.save(output, format="PNG")
            png = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
        payload = {"add": png, "hasEffectiveMask": True, "expectedManualRevision": 0}
        status, _, body = self.request("POST", endpoint, payload, authorized=True)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["manualRevision"], 1)
        with self.state.workspace_store._connect() as db:
            db.execute("CREATE TRIGGER reject_manual_history BEFORE INSERT ON history_entries BEGIN SELECT RAISE(ABORT, 'history unavailable'); END")
        try:
            status, _, body = self.request("DELETE", endpoint, {"expectedManualRevision": 1}, authorized=True)
            self.assertNotEqual(status, 200, body)
            self.assertEqual(self.state.workspace_store.manual_revisions([image_id]), {image_id: 1})
            self.assertEqual(self.state.manual_workspace(image_id)["add"], png)
        finally:
            with self.state.workspace_store._connect() as db: db.execute("DROP TRIGGER reject_manual_history")
        for method, value in (("POST", {**payload, "add": ""}), ("DELETE", {"expectedManualRevision": 0})):
            status, _, body = self.request(method, endpoint, value, authorized=True)
            self.assertEqual(json.loads(body).get("error_code"), "manual_revision_conflict", (status, body))
            self.assertEqual(self.state.manual_workspace(image_id)["add"], png)
        session_id = "a1000000-0000-4000-8000-000000000001"
        status, _, body = self.request("POST", endpoint + "/begin", {"sessionId": session_id, "dirtyLayers": ["add"]}, authorized=True)
        self.assertEqual(status, 200, body)
        status, _, body = self.request("POST", endpoint + "/commit", {
            "sessionId": session_id, "dirtyLayers": ["add"], "emptyLayers": ["add"], "expectedManualRevision": 0,
        }, authorized=True)
        self.assertEqual(json.loads(body).get("error_code"), "manual_revision_conflict", (status, body))
        self.assertEqual(self.state.workspace_store.manual_revisions([image_id]), {image_id: 1})
        status, _, body = self.request("DELETE", endpoint, {"expectedManualRevision": 1}, authorized=True)
        self.assertEqual((status, json.loads(body)["manualRevision"]), (200, 2))
        self.assertIsNone(self.state.manual_workspace(image_id))
        status, _, body = self.request("GET", endpoint)
        self.assertEqual((status, json.loads(body)), (200, {"draft": None, "manualRevision": 2}))
        self.state.restore_project_history(image_id, "undo")
        restored = self.state._decode_workspace_mask(self.state.manual_workspace(image_id)["add"])
        with Image.open(io.BytesIO(restored)) as mask:
            self.assertEqual(mask.getpixel((2, 2))[3], 255)
            self.assertEqual(mask.getpixel((8, 4))[3], 255)
        self.assertEqual(self.state.workspace_store.manual_revisions([image_id]), {image_id: 3})
        status, _, body = self.request("POST", endpoint, {**payload, "expectedManualRevision": 2}, authorized=True)
        self.assertEqual(json.loads(body).get("error_code"), "manual_revision_conflict", (status, body))
        self.state.restore_project_history(image_id, "redo")
        self.assertIsNone(self.state.manual_workspace(image_id))
        status, _, body = self.request("DELETE", endpoint, {"expectedManualRevision": 4}, authorized=True)
        self.assertEqual((status, json.loads(body)["manualRevision"]), (200, 4))
        snapshot = self.state.catalog_snapshot()
        self.assertEqual(snapshot["images"][0]["manualRevision"], 4)

    def test_manual_png_processing_does_not_block_catalog_reads(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]

        def mask_url(x):
            with Image.new("RGBA", (12, 8)) as mask, io.BytesIO() as output:
                mask.putpixel((x, 3), (255, 255, 255, 255))
                mask.save(output, format="PNG")
                return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")

        self.state.save_manual_workspace(image_id, {"add": mask_url(2), "expectedManualRevision": 0})
        payload = {"add": mask_url(4), "dirtyLayers": ["add"], "expectedManualRevision": 1}
        decoding = threading.Event(); release_decode = threading.Event(); listed = threading.Event()
        failures = []; responses = []
        original_load = PngImagePlugin.PngImageFile.load

        def load(image, *args, **kwargs):
            if threading.current_thread() is writer and not decoding.is_set() and image.tile:
                decoding.set()
                if not release_decode.wait(THREAD_TIMEOUT):
                    raise TimeoutError("PNG decode was not released")
            return original_load(image, *args, **kwargs)

        def save():
            try: self.state.save_manual_workspace(image_id, payload)
            except BaseException as error: failures.append(error)

        def read():
            try: responses.append(self.request("GET", "/api/images"))
            except BaseException as error: failures.append(error)
            finally: listed.set()

        writer = threading.Thread(target=save); reader = threading.Thread(target=read)
        with patch.object(PngImagePlugin.PngImageFile, "load", load):
            try:
                writer.start(); self.assertTrue(decoding.wait(THREAD_TIMEOUT))
                reader.start(); self.assertTrue(listed.wait(THREAD_TIMEOUT))
                self.assertEqual(failures, [], "catalogue reads must finish before PNG processing resumes")
            finally:
                release_decode.set(); join_threads(writer, reader)
        self.assertEqual(failures, [])
        status, _, body = responses[0]
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["images"][0]["manualRevision"], 1)
        self.assertEqual(self.state.manual_workspace_snapshot(image_id)["manualRevision"], 2)
        self.assertEqual(self.state.manual_workspace(image_id)["add"], payload["add"])

    def test_copy_delete_rejects_new_edits_before_commit_and_browser_delete_claim(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        output = self.source_dir.parent / "output"; output.mkdir()
        self.state.update_settings({"saving": {"default_output_directory": str(output)}})
        source = self.source_dir / "source.png"
        original = source.read_bytes()

        def render_copy(suffix: str) -> str:
            token = str(uuid.uuid4())
            payload = {"imageId": image_id, "candidateRevision": self.state._candidate_revision(image_id),
                       "clientSaveToken": token, "copyToDefault": True, "divisor": 100, "suffix": suffix,
                       "expectedManualRevision": self.state.workspace_store.manual_revisions([image_id])[image_id]}
            for endpoint in ("reserve", "render"):
                status, _, body = self.request("POST", f"/api/save/{endpoint}", payload, authorized=True)
                self.assertEqual(status, 200, body)
            return token

        def edit() -> None:
            self.state.save_manual_workspace(image_id, {"add": "", "manualEnabled": False, "hasEffectiveMask": False})

        def commit(token: str, action: str) -> tuple[int, dict]:
            status, _, body = self.request("POST", "/api/save/commit", {
                "imageId": image_id, "candidateRevision": self.state._candidate_revision(image_id), "saveToken": token, "sourceAction": action,
            }, authorized=True)
            return status, json.loads(body)

        token = render_copy("_stale"); edit()
        status, result = commit(token, "deleted")
        self.assertEqual((status, result.get("error_code")), (400, "save_state_changed"))
        self.assertTrue(self.state.workspace_store.has_image(image_id)); self.assertEqual(source.read_bytes(), original)
        status, result = commit(token, "keep")
        self.assertEqual(status, 200); self.assertTrue(result["stale"])
        saved_edits = {"candidateRevision": result["candidateRevision"], "manualRevision": result["manualRevision"], "transformRevision": result["transformRevision"]}
        self.state.acknowledge_browser_save(token)
        status, _, body = self.request("POST", "/api/catalog/delete-source/prepare", {
            "imageIds": [image_id], "deleteToken": str(uuid.uuid4()), "savedEdits": saved_edits,
        }, authorized=True)
        self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
        for phase in ("claim", "commit"):
            token = render_copy("_" + phase)
            status, result = commit(token, "keep")
            self.assertEqual(status, 200)
            saved_edits = {"candidateRevision": result["candidateRevision"], "manualRevision": result["manualRevision"], "transformRevision": result["transformRevision"]}
            self.state.acknowledge_browser_save(token)
            delete_token = str(uuid.uuid4())
            status, _, body = self.request("POST", "/api/catalog/delete-source/prepare", {
                "imageIds": [image_id], "deleteToken": delete_token, "savedEdits": saved_edits,
            }, authorized=True)
            self.assertEqual(status, 200, body)
            if phase == "commit":
                self.state.claim_source_delete(delete_token)
            edit()
            endpoint = "/api/catalog/delete-source/claim" if phase == "claim" else "/api/catalog/delete-source"
            status, _, body = self.request("POST", endpoint, {"deleteToken": delete_token, "imageIds": [image_id]}, authorized=True)
            self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
            self.assertTrue(self.state.workspace_store.has_image(image_id)); self.assertEqual(source.read_bytes(), original)
            if phase == "commit": self.state.release_source_delete_claim(delete_token)
            self.state.cancel_source_delete(delete_token)
        token = render_copy("_candidate")
        revision = self.state._candidate_revision(image_id)
        with self.state.image_io_lock(image_id), self.state.lock:
            self.state._commit_candidate_snapshot(image_id, [], replace=True)
        status, _, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": revision, "saveToken": token, "sourceAction": "deleted",
        }, authorized=True)
        self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
        self.assertEqual(source.read_bytes(), original)
        self.assertTrue(self.state.workspace_store.has_image(image_id))

    def _check_copy_delete_transform_race(self, phase: str) -> None:
        source = self.source_dir / "source.png"
        with Image.new("RGB", (12, 8), "red") as image:
            image.paste("blue", (6, 0, 12, 8)); image.save(source)
        original = source.read_bytes()
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        output = self.source_dir.parent / "output"; output.mkdir()
        self.state.update_settings({"saving": {"default_output_directory": str(output)}})
        save_token = str(uuid.uuid4()); delete_token = str(uuid.uuid4())
        payload = {"imageId": image_id, "candidateRevision": 0, "expectedManualRevision": 0,
                   "clientSaveToken": save_token, "copyToDefault": True, "divisor": 100, "suffix": "_copy"}
        for endpoint in ("reserve", "render"):
            status, _, body = self.request("POST", f"/api/save/{endpoint}", payload, authorized=True)
            self.assertEqual(status, 200, body)
        status, _, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": 0, "saveToken": save_token, "sourceAction": "keep",
        }, authorized=True)
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        saved = {"candidateRevision": result["candidateRevision"], "manualRevision": result["manualRevision"], "transformRevision": result["transformRevision"]}
        prepare = {"imageIds": [image_id], "deleteToken": delete_token, "savedEdits": saved}
        copied = output / "source_copy.png"
        with Image.open(copied) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
        self.state.acknowledge_browser_save(save_token)
        if phase != "prepare":
            status, _, body = self.request("POST", "/api/catalog/delete-source/prepare", prepare, authorized=True)
            self.assertEqual(status, 200, body)
        if phase == "commit":
            status, _, body = self.request("POST", "/api/catalog/delete-source/claim", {"deleteToken": delete_token}, authorized=True)
            self.assertEqual(status, 200, body)
        status, _, body = self.request("POST", f"/api/images/{image_id}/transform", {"flipH": True, "flipV": False}, authorized=True)
        self.assertEqual(status, 200, body)
        endpoint = "/api/catalog/delete-source" + ("" if phase == "commit" else "/" + phase)
        status, _, body = self.request("POST", endpoint, prepare if phase == "prepare" else {"deleteToken": delete_token, "imageIds": [image_id]}, authorized=True)
        self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
        self.assertEqual(source.read_bytes(), original)
        self.assertTrue(self.state.workspace_store.has_image(image_id))
        self.assertTrue(self.state.images[image_id].flip_horizontal)
        with Image.open(copied) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
        if phase == "commit": self.state.release_source_delete_claim(delete_token)
        if phase != "prepare": self.state.cancel_source_delete(delete_token)

    def test_copy_delete_preserves_flip_added_before_prepare(self) -> None:
        self._check_copy_delete_transform_race("prepare")

    def test_copy_delete_preserves_flip_added_before_claim(self) -> None:
        self._check_copy_delete_transform_race("claim")

    def test_copy_delete_preserves_flip_added_before_commit(self) -> None:
        self._check_copy_delete_transform_race("commit")

    def test_copy_delete_without_a_saved_transform_revision_retains_the_source(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        source = self.state.images[image_id].path
        original = source.read_bytes()
        for phase in ("prepare", "claim", "commit"):
            with self.subTest(phase=phase):
                token = str(uuid.uuid4())
                saved = {"candidateRevision": 0, "manualRevision": 0}
                payload = {"imageIds": [image_id], "deleteToken": token, "savedEdits": saved}
                if phase != "prepare":
                    saved["transformRevision"] = 0
                    self.state.prepare_source_delete(payload)
                    if phase == "commit": self.state.claim_source_delete(token)
                    with self.state.workspace_store._connect() as db:
                        row = db.execute("SELECT items_json FROM source_delete_operations WHERE token=?", (token,)).fetchone()
                        items = json.loads(row[0])
                        for item in items: item.pop("saveTransformRevision")
                        db.execute("UPDATE source_delete_operations SET items_json=? WHERE token=?", (json.dumps(items), token))
                endpoint = "/api/catalog/delete-source" + ("" if phase == "commit" else "/" + phase)
                status, _, body = self.request("POST", endpoint, payload, authorized=True)
                self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
                self.assertEqual(source.read_bytes(), original)
                self.assertTrue(self.state.workspace_store.has_image(image_id))
                if phase == "commit": self.state.release_source_delete_claim(token)
                if phase != "prepare": self.state.cancel_source_delete(token)

    def test_render_rejects_a_dialog_draft_from_before_peer_manual_edit(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        token = str(uuid.uuid4())
        self.state.reserve_browser_save(image_id, 0, token, copy_to_default=False, suffix="_saved", output_format="original", keep_metadata=True)
        self.state.save_manual_workspace(image_id, {"hasEffectiveMask": False, "manualEnabled": False})
        status, _, body = self.request("POST", "/api/save/render", {
            "imageId": image_id, "candidateRevision": 0, "expectedManualRevision": 0,
            "clientSaveToken": token, "divisor": 100, "draft": {"manualEnabled": True},
        }, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual((status, json.loads(body).get("error_code")), (400, "save_state_changed"))
        self.assertEqual(self.state.browser_save_tokens[token].state, "rendering")
        self.assertFalse(self.state.manual_workspace(image_id)["manualEnabled"])

    def test_concurrent_first_uploads_share_one_session_and_close_its_handle(self) -> None:
        first_open = threading.Event(); release_open = threading.Event(); second_started = threading.Event(); second_open = threading.Event()
        opened = []; paths = []; failures = []
        original_open = Path.open

        def controlled_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path.name == ".active.lock":
                opened.append(handle)
                self.addCleanup(handle.close)
                if len(opened) == 1:
                    first_open.set()
                    if not release_open.wait(THREAD_TIMEOUT):
                        handle.close(); raise TimeoutError("session open was not released")
                else:
                    second_open.set()
            return handle

        def ensure(second=False):
            try:
                if second: second_started.set()
                paths.append(self.state._ensure_session())
            except BaseException as error: failures.append(error)

        first = threading.Thread(target=ensure); second = threading.Thread(target=ensure, args=(True,))
        with patch.object(Path, "open", controlled_open):
            try:
                first.start(); self.assertTrue(first_open.wait(THREAD_TIMEOUT))
                second.start(); self.assertTrue(second_started.wait(THREAD_TIMEOUT))
                self.assertFalse(second_open.wait(0.1), "the second upload must wait for the first session publication")
            finally:
                release_open.set(); join_threads(first, second)
        self.assertEqual(failures, [])
        self.assertEqual(len(set(paths)), 1)
        self.assertEqual(len(opened), 1)
        self.assertIs(self.state._session_lock_handle, opened[0])
        self.assertEqual(len(list(self.state.session_base_dir.glob("session-*"))), 1)
        self.state.shutdown()
        self.assertTrue(opened[0].closed)

    def test_named_project_open_discards_active_projectless_catalog_across_restart(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Named target"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        named_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/project/close", {}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")

        session_id = "cc1cfba8-f5d9-4cd5-a64c-5a3ce14ad125"
        source_id = "cc1cfba8-f5d9-4cd5-a64c-5a3ce14ad126"
        expected_generation = self.state.catalog_generation
        status, _headers, body = self.request("POST", "/api/import/start", {"sessionId": session_id}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        encoded = io.BytesIO(); Image.new("RGB", (9, 7), "blue").save(encoded, format="PNG")
        image_bytes = encoded.getvalue()
        status, _headers, body = self.raw_request("POST", "/api/import/file", image_bytes, {
            "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
            "Content-Type": "application/octet-stream", "X-Mozarie-Name": "browser.png",
            "X-Mozarie-Relative-Path": "browser.png", "X-Mozarie-Client-Key": "projectless-browser-file",
            "X-Mozarie-Source-Kind": "browser-files", "X-Mozarie-Source-Id": source_id,
            "X-Mozarie-Import-Intent": "add", "X-Mozarie-Import-Session": session_id,
            "X-Mozarie-File-Mtime": "0", "X-Mozarie-File-Size": str(len(image_bytes)),
        })
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        imported = json.loads(body); old_workspace_id = self.state.workspace_id
        self.assertEqual(len(imported["imported"]), 1)
        finish_payload = json.dumps({
            "sessionId": session_id, "expectedProjectId": "", "expectedCatalogGeneration": expected_generation,
            "completed": 1, "failed": False, "cancelled": False,
        }).encode("utf-8")
        status, _headers, body = self.raw_request("POST", "/api/import/finish", finish_payload, {
            "Origin": self.origin, "X-Mozarie-Token": self.state.session_token, "Content-Type": "application/json",
            "X-Mozarie-Expected-Project-Id": "", "X-Mozarie-Expected-Catalog-Generation": str(expected_generation),
        })
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertIsNotNone(old_workspace_id)
        self.assertEqual(self.state.workspace_store.active_projectless_catalog(), old_workspace_id)
        self.assertIsNotNone(self.state.workspace_store.project(old_workspace_id or ""))
        self.assertEqual([image.relative_path for image in self.state.images.values()], ["browser.png"])
        projectless_sources = self.state.workspace_store.project_sources(old_workspace_id)
        self.assertEqual(len(projectless_sources), 1)
        self.assertEqual((projectless_sources[0]["kind"], projectless_sources[0]["identity"]), ("browser-files", f"browser:{source_id}"))

        status, _headers, body = self.request("POST", "/api/project/open", {"projectId": named_id}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertEqual(self.state.catalog_id, named_id)
        self.assertEqual(self.state.workspace_id, named_id, "named projects use their project ID as the live durable workspace")
        self.assertIsNone(self.state.workspace_store.active_projectless_catalog())
        self.assertIsNone(self.state.workspace_store.project(old_workspace_id or ""))
        self.assertIsNotNone(self.state.workspace_store.project(named_id))

        self.state.shutdown()
        reopened = StudioState(self.state.cache_dir, self.state.session_base_dir)
        try:
            self.assertIsNone(reopened.workspace_id)
            self.assertIsNone(reopened.workspace_store.active_projectless_catalog())
            self.assertEqual(reopened.order, [])
            self.assertIsNone(reopened.workspace_store.project(old_workspace_id or ""))
            opened = reopened.open_project(named_id)
            self.assertEqual(opened["project"]["id"], named_id)
        finally:
            reopened.shutdown()

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

    def test_public_api_has_no_relative_path_partial_delete_route(self) -> None:
        """DI-243.1: deletion accepts opaque image IDs, never path fragments."""
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        for method, route in (
            ("DELETE", "/api/catalog/path/source.png"),
            ("POST", "/api/catalog/delete-relative-path"),
            ("POST", "/api/project/image/source.png/delete"),
        ):
            status, _headers, response = self.request(method, route, {"relativePath": "source.png"}, authorized=True)
            self.assertEqual(status, 404, (method, route, response.decode("utf-8")))
            self.assertEqual(json.loads(response)["error_code"], "api_not_found")
        self.assertEqual([item["id"] for item in self.state.list_images()], [image_id])
        self.assertTrue((self.source_dir / "source.png").is_file())

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

    def test_json_staging_failure_closes_before_unread_bytes_become_a_request(self) -> None:
        for failure in ("create", "write"):
            with self.subTest(failure=failure):
                payload = json.dumps({"value": "x" * (http_module.IO_CHUNK_BYTES + 32 if failure == "write" else 32)}).encode()
                request = (
                    f"POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n"
                    f"Origin: {self.origin}\r\nX-Mozarie-Token: {self.state.session_token}\r\n"
                    f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n"
                ).encode() + payload + (
                    f"GET /api/images HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nConnection: close\r\n\r\n"
                ).encode()
                if failure == "create":
                    boundary = patch.object(tempfile, "SpooledTemporaryFile", side_effect=OSError("injected staging creation failure"))
                else:
                    boundary = patch.object(tempfile.SpooledTemporaryFile, "write", side_effect=OSError("injected staging disk full"))
                with boundary, self.assertLogs("mozarie", level="ERROR"):
                    with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5) as client:
                        client.sendall(request)
                        chunks = []
                        try:
                            while chunk := client.recv(65536):
                                chunks.append(chunk)
                        except ConnectionResetError:
                            pass  # Closing a socket with unread input may reset it on Windows.
                response = b"".join(chunks)
                headers, body = response.split(b"\r\n\r\n", 1)
                self.assertTrue(headers.startswith(b"HTTP/1.1 500"), headers)
                self.assertIn(b"Connection: close", headers)
                self.assertEqual(response.count(b"HTTP/1.1 "), 1)
                self.assertEqual(json.loads(body)["error_code"], "internal_error")
                self.assertEqual(self.state.list_images(), [])

    def test_fully_read_invalid_json_preserves_the_next_request(self) -> None:
        for payload in (b"{invalid}", b"[]", b'{"value":"\xff"}'):
            with self.subTest(payload=payload):
                connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
                try:
                    connection.request("POST", "/api/settings", body=payload, headers={
                        "Origin": self.origin, "X-Mozarie-Token": self.state.session_token,
                        "Content-Type": "application/json",
                    })
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    self.assertEqual(json.loads(response.read())["error_code"], "input_invalid")
                    original_socket = connection.sock
                    self.assertIsNotNone(original_socket)
                    connection.request("GET", "/api/health")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertTrue(json.loads(response.read())["ok"])
                    self.assertIs(connection.sock, original_socket)
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

    def test_unlimited_png_jpeg_webp_catalog_and_assets_preserve_dimensions(self) -> None:
        for extension, image_format in [("png", "PNG"), ("jpg", "JPEG"), ("webp", "WEBP")]:
            with Image.new("RGB", (40, 20), "#d04020") as source:
                options = {}
                if image_format == "JPEG":
                    exif = Image.Exif()
                    exif[274] = 6
                    options["exif"] = exif
                source.save(self.source_dir / f"over-limit.{extension}", format=image_format, **options)

        self.assertIsNone(Image.MAX_IMAGE_PIXELS)
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        records = {item["relativePath"]: item for item in json.loads(body)["images"]}
        self.assertEqual(set(records), {"source.png", "over-limit.png", "over-limit.jpg", "over-limit.webp"})
        assets = []
        for name, record in records.items():
            expected = (20, 40) if name.endswith(".jpg") else ((12, 8) if name == "source.png" else (40, 20))
            self.assertEqual((record["width"], record["height"]), expected)
            for route in ("image", "thumbnail"):
                status, _headers, asset = self.request("GET", f"/api/{route}/{record['id']}")
                self.assertEqual(status, 200, name)
                assets.append((asset, expected))
        self.assertIsNone(Image.MAX_IMAGE_PIXELS)

        for asset, expected in assets:
            with Image.open(io.BytesIO(asset)) as source, ImageOps.exif_transpose(source) as visible:
                self.assertEqual(visible.size, expected)

    def test_exif_rotated_thumbnail_and_editor_asset_have_identical_visual_orientation(self) -> None:
        rotated = self.source_dir / "rotated.jpg"
        exif = Image.Exif(); exif[274] = 6
        source = Image.new("RGB", (40, 20), "black")
        for x in range(20):
            for y in range(20): source.putpixel((x, y), (255, 0, 0))
        source.save(rotated, format="JPEG", quality=100, exif=exif)
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200)
        record = next(item for item in json.loads(body)["images"] if item["relativePath"] == "rotated.jpg")
        self.assertEqual((record["width"], record["height"]), (20, 40))
        status, _headers, editor_body = self.request("GET", f"/api/image/{record['id']}")
        self.assertEqual(status, 200)
        status, _headers, thumbnail_body = self.request("GET", f"/api/thumbnail/{record['id']}")
        self.assertEqual(status, 200)
        with Image.open(io.BytesIO(editor_body)) as raw_editor, Image.open(io.BytesIO(thumbnail_body)) as raw_thumbnail:
            editor = ImageOps.exif_transpose(raw_editor).convert("RGB")
            thumbnail = ImageOps.exif_transpose(raw_thumbnail).convert("RGB")
            self.assertEqual(editor.size, thumbnail.size)
            self.assertEqual(editor.size, (20, 40))
            self.assertGreater(editor.crop((0, 0, 20, 20)).resize((1, 1)).getpixel((0, 0))[0], 200)
            self.assertGreater(thumbnail.crop((0, 0, 20, 20)).resize((1, 1)).getpixel((0, 0))[0], 200)

    def test_thumbnail_pixels_remain_in_source_orientation_before_and_after_flip(self) -> None:
        pixels = np.zeros((40, 40, 3), dtype=np.uint8)
        pixels[:20, :20] = (255, 0, 0)
        pixels[:20, 20:] = (0, 255, 0)
        pixels[20:, :20] = (0, 0, 255)
        pixels[20:, 20:] = (255, 255, 0)
        source = self.source_dir / "quadrants.png"
        with Image.fromarray(pixels) as image:
            image.save(source)
        status, _headers, _body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200)
        record = next(record for record in self.state.images.values() if record.path == source)
        version = self.state.asset_version(record)
        for horizontal, vertical in [(True, False), (False, True), (True, True), (False, False)]:
            with self.subTest(horizontal=horizontal, vertical=vertical):
                status, _headers, _body = self.request("POST", f"/api/images/{record.image_id}/transform",
                    {"flipH": horizontal, "flipV": vertical}, authorized=True)
                self.assertEqual(status, 200)
                thumbnail_path = self.state.cache_dir / "thumbnails" / f"{record.image_id}-{version}.jpg"
                thumbnail_path.unlink(missing_ok=True)
                for cache in ["cold", "warm"]:
                    status, _headers, body = self.request("GET", f"/api/thumbnail/{record.image_id}?v={version}")
                    self.assertEqual(status, 200, cache)
                    with Image.open(io.BytesIO(body)) as thumbnail:
                        for x, y in [(5, 5), (35, 5), (5, 35), (35, 35)]:
                            np.testing.assert_allclose(thumbnail.getpixel((x, y)), pixels[y, x], atol=3,
                                err_msg="CSS applies the view flip once, so thumbnail bytes must retain source orientation")

    def test_history_branch_uses_fresh_mask_urls_and_keeps_manual_revision_current(self) -> None:
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        mask_path = self.state.cache_dir / "point.png"
        with Image.new("L", (12, 8)) as mask:
            mask.putpixel((6, 4), 255)
            mask.save(mask_path)
        self.state._commit_candidate_snapshot(image_id, [Candidate("point", "penis", .9, mask_path)], replace=True)
        self.state.save_manual_workspace(image_id, {
            "add": "data:image/png;base64," + base64.b64encode(mask_path.read_bytes()).decode("ascii"),
            "manualEnabled": True, "candidateRevision": self.state._candidate_revision(image_id),
            "hasEffectiveMask": True,
        })

        def action(path, payload):
            status, _headers, body = self.request("POST", path, payload, authorized=True)
            self.assertEqual(status, 200, body.decode("utf-8"))

        def current_mask():
            revision = self.state._candidate_revision(image_id)
            self.assertEqual(self.state.manual_workspace(image_id)["candidateRevision"], revision)
            url = f"/api/mask/{image_id}/point?v={revision}-point"
            status, headers, body = self.request("GET", url)
            self.assertEqual(status, 200)
            self.assertIn("immutable", headers["Cache-Control"])
            with Image.open(io.BytesIO(body)) as mask:
                pixels = np.asarray(mask).copy()
            return revision, url, pixels

        action("/api/candidates/batch", {"imageId": image_id, "role": "apply", "operation": "set_padding", "expandPx": 1})
        first = current_mask()
        action(f"/api/project/history/{image_id}/undo", {})
        undone = current_mask()
        action("/api/candidates/batch", {"imageId": image_id, "role": "apply", "operation": "set_padding", "expandPx": 3})
        branch = current_mask()
        self.assertGreater(branch[0], undone[0])
        self.assertGreater(undone[0], first[0])
        self.assertNotEqual(first[1], branch[1])
        self.assertGreater(np.count_nonzero(branch[2]), np.count_nonzero(first[2]))
        action(f"/api/project/history/{image_id}/undo", {})
        second_undo = current_mask()
        action(f"/api/project/history/{image_id}/redo", {})
        redone = current_mask()
        self.assertGreater(redone[0], second_undo[0])
        np.testing.assert_array_equal(redone[2], branch[2])

        revision_before_failure = redone[0]
        with patch.object(self.state.workspace_store, "hydrate_candidates", side_effect=OSError("cache unavailable")):
            with self.assertRaisesRegex(OSError, "cache unavailable"):
                self.state.restore_project_history(image_id, "undo")
        self.assertEqual(self.state._candidate_revision(image_id), revision_before_failure)
        self.assertEqual(self.state.workspace_store.candidate_revisions([image_id])[image_id], revision_before_failure)
        np.testing.assert_array_equal(current_mask()[2], branch[2])
        action("/api/candidates/batch", {"imageId": image_id, "role": "apply", "operation": "set_padding", "expandPx": 2})
        self.assertGreater(current_mask()[0], revision_before_failure)

    def test_overwritten_same_stat_image_has_fresh_asset_urls_after_reopen_and_restart(self) -> None:
        source = self.source_dir / "source.png"
        with Image.new("RGB", (2, 1)) as image:
            image.putpixel((0, 0), (255, 0, 0)); image.putpixel((1, 0), (0, 0, 255))
            image.save(source)
        project = self.state.create_project("Cache identity")
        record = self.state.set_root(str(self.source_dir))[0]
        image_id = record["id"]
        original_stat = source.stat()
        initial_version = record["assetVersion"]
        initial_bytes = self.request("GET", f"/api/image/{image_id}?v={initial_version}")[2]
        self.state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        options = {"imageId": image_id, "candidateRevision": self.state._candidate_revision(image_id),
                   "clientSaveToken": "00000000-0000-4000-8000-000000000099", "copyToDefault": False,
                   "format": "original", "keepMetadata": True, "streamImage": False, "divisor": 100, "draft": None}
        for path in ("/api/save/reserve", "/api/save/render"):
            status, _headers, body = self.request("POST", path, options, authorized=True)
            self.assertEqual(status, 200, body.decode("utf-8"))
        status, _headers, body = self.request("POST", "/api/save/commit", {
            "imageId": image_id, "candidateRevision": options["candidateRevision"],
            "saveToken": options["clientSaveToken"], "sourceAction": "overwrite",
        }, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        self.assertEqual((source.stat().st_mtime_ns, source.stat().st_size), (original_stat.st_mtime_ns, original_stat.st_size))
        versions = {initial_version, self.state.list_images()[0]["assetVersion"]}
        self.assertEqual(len(versions), 2)
        for restart in (False, True):
            self.state.close_project()
            if restart:
                cache, sessions = self.state.cache_dir, self.state.session_base_dir
                self.state.shutdown()
                self.state = StudioState(cache, sessions)
                http_module.STATE = self.state
            current = self.state.open_project(project["id"])["images"][0]
            self.assertNotIn(current["assetVersion"], versions)
            versions.add(current["assetVersion"])
            self.assertEqual(self.state.asset_version(self.state.image_snapshot(image_id)), current["assetVersion"])
            status, headers, image_bytes = self.request("GET", f"/api/image/{image_id}?v={current['assetVersion']}")
            self.assertEqual(status, 200)
            self.assertIn("immutable", headers["Cache-Control"])
            self.assertNotEqual(image_bytes, initial_bytes)
            with Image.open(io.BytesIO(image_bytes)) as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 255))
            self.assertEqual(self.request("GET", f"/api/thumbnail/{image_id}?v={current['assetVersion']}")[0], 200)
        self.state.remove_images_from_catalog([image_id])
        self.assertEqual(list((self.state.cache_dir / "thumbnails").glob(f"{image_id}-*.jpg")), [])

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
        with patch.object(self.state, "save_manual_workspace", side_effect=ClientError("保存に失敗しました。", "workspace_write_failed")), \
             self.assertLogs("mozarie", level="WARNING") as failure_log:
            status, _headers, response = self.request(
                "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": failed}, authorized=True,
            )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(response)["error_code"], "workspace_write_failed")
        self.assertNotIn(failed, self.state._manual_uploads)
        self.assertEqual(self.state.manual_workspace(image_id)["add"], persisted["add"])
        self.assertTrue(any("error_code=workspace_write_failed" in line and "所要=" in line for line in failure_log.output))

        retry = "00000000-0000-4000-8000-000000000105"
        begin(retry, ["add"]); layer(retry, "add", layers["add"])
        status, _headers, response = self.request(
            "POST", f"/api/workspace/manual/{image_id}/commit", {**base_payload, "sessionId": retry}, authorized=True,
        )
        self.assertEqual(status, 200, response.decode("utf-8") if status != 200 else "")
        self.assertNotIn(retry, self.state._manual_uploads)

    def _check_stream_framing(self, kind: str, change: str) -> None:
        source = self.source_dir / "source.png"
        with Image.new("RGB", (12, 8), "white") as image:
            image.save(source)
        if kind == "export":
            status, _, body = self.request("POST", "/api/projects", {"name": "Stream " + change}, authorized=True)
            self.assertEqual(status, 200, body)
            project_id = json.loads(body)["project"]["id"]
            self.state.set_root(str(self.source_dir))
            route = f"/api/project/masks/{project_id}/mosaic"
            content_type = b"Content-Type: application/zip"
        else:
            image_id = self.state.set_root(str(self.source_dir))[0]["id"]
            route = f"/api/image/{image_id}"
            content_type = b"Content-Type: image/png"
        write = socketserver._SocketWriter.write
        open_file = Path.open
        originals = []

        def mutate_after_headers(writer, data):
            if not originals and data.startswith(b"HTTP/1.1 200") and content_type in data:
                path = next(self.state.cache_dir.glob("mozarie-masks-*.zip")) if kind == "export" else source
                with open_file(path, "rb") as handle:
                    originals.append(handle.read())
                if change == "grow":
                    with open_file(path, "ab") as handle:
                        handle.write(b"EXTRA-BYTES")
                elif change == "shrink":
                    with open_file(path, "r+b") as handle:
                        handle.truncate(16)
            return write(writer, data)

        class UnreadableSource:
            def __init__(self, handle): self.handle = handle
            def __enter__(self): return self
            def __exit__(self, *args): return self.handle.__exit__(*args)
            def fileno(self): return self.handle.fileno()
            def read(self, _size): raise OSError("injected source read failure")

        def fail_source_read(path, *args, **kwargs):
            handle = open_file(path, *args, **kwargs)
            return UnreadableSource(handle) if path == source and args == ("rb",) and change == "read_error" else handle

        request = (
            f"GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n\r\n"
            f"GET /api/images HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nConnection: close\r\n\r\n"
        ).encode("ascii")
        with patch.object(socketserver._SocketWriter, "write", mutate_after_headers), patch.object(Path, "open", fail_source_read):
            with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5) as client:
                client.sendall(request)
                chunks = []
                while chunk := client.recv(65536):
                    chunks.append(chunk)
        self.assertEqual(len(originals), 1)
        headers, body = b"".join(chunks).split(b"\r\n\r\n", 1)
        self.assertTrue(headers.startswith(b"HTTP/1.1 200"), headers)
        length = int(next(line.split(b":", 1)[1] for line in headers.split(b"\r\n") if line.startswith(b"Content-Length:")))
        self.assertEqual(length, len(originals[0]))
        if change in {"shrink", "read_error"}:
            self.assertEqual(body, originals[0][:16] if change == "shrink" else b"")
        else:
            self.assertEqual(body[:length], originals[0])
            next_headers, next_body = body[length:].split(b"\r\n\r\n", 1)
            self.assertTrue(next_headers.startswith(b"HTTP/1.1 200"), next_headers)
            next_length = int(next(line.split(b":", 1)[1] for line in next_headers.split(b"\r\n") if line.startswith(b"Content-Length:")))
            self.assertEqual(len(next_body), next_length)
            self.assertIn("images", json.loads(next_body))
        self.assertEqual(list(self.state.cache_dir.glob("mozarie-masks-*.zip")), [])

    def test_image_stream_keeps_response_boundaries_when_source_size_changes(self) -> None:
        for change in ("unchanged", "grow", "shrink"):
            with self.subTest(change=change):
                self._check_stream_framing("image", change)

    def test_export_stream_keeps_response_boundaries_when_file_size_changes(self) -> None:
        for change in ("unchanged", "grow", "shrink"):
            with self.subTest(change=change):
                self._check_stream_framing("export", change)

    def test_stream_read_failure_closes_without_a_second_response(self) -> None:
        self._check_stream_framing("image", "read_error")

    def test_project_mask_export_succeeds_when_warnings_are_errors(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Masks"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        before = {
            "catalog": self.state.catalog_snapshot(include_sources=True),
            "workspace": self.state.workspace_store.export_state(image_id),
            "projects": self.state.projects(),
        }
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            status, headers, body = self.request("GET", f"/api/project/mask/{image_id}/mosaic")
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        self.assertEqual(headers["Content-Type"], "image/png")
        with Image.open(io.BytesIO(body)) as mask:
            self.assertEqual((mask.mode, mask.size), ("L", (12, 8)))
        self.assertEqual({
            "catalog": self.state.catalog_snapshot(include_sources=True),
            "workspace": self.state.workspace_store.export_state(image_id),
            "projects": self.state.projects(),
        }, before, "warnings-as-errors export preserves the complete project state")

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

    def test_source_delete_commit_failure_is_written_to_cmd_log(self) -> None:
        """DI-230.2: a server-reached commit exception is logged with its safe code."""
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]
        token = "00000000-0000-4000-8000-000000230201"
        for route, payload in (
            ("/api/catalog/delete-source/prepare", {"imageIds": [image_id], "deleteToken": token}),
            ("/api/catalog/delete-source/claim", {"deleteToken": token}),
        ):
            status, _headers, body = self.request("POST", route, payload, authorized=True)
            self.assertEqual(status, 200, body.decode("utf-8"))
        with patch.object(self.state, "delete_images_with_sources", side_effect=ClientError("commit failed", "workspace_write_failed")), \
             self.assertLogs("mozarie", level="WARNING") as captured:
            status, _headers, body = self.request("POST", "/api/catalog/delete-source", {
                "imageIds": [image_id], "deleteToken": token, "browserDeletedImageIds": [],
            }, authorized=True)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error_code"], "workspace_write_failed")
        self.assertTrue(any("操作失敗: 元画像を完全削除" in line and "error_code=workspace_write_failed" in line and "所要=" in line for line in captured.output))

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

    def test_chromium_save_stream_survives_revision_change_and_releases_temporary_output(self) -> None:
        pixels = np.random.default_rng(73).integers(0, 256, (1024, 1024, 3), dtype=np.uint8)
        with Image.fromarray(pixels) as source:
            source.save(self.source_dir / "source.png")
        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        self.state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        captured = []
        render = self.state.render_browser_save
        revision_changed = threading.Event()
        first_chunk_sent = threading.Event()
        transform = self.state.set_image_transform
        stream_path = MosaicHandler._stream_path

        def capture_render(*args, **kwargs):
            result = render(*args, **kwargs)
            if result.response_path is not None:
                captured.append((result.response_path, hashlib.sha256(result.response_path.read_bytes()).hexdigest()))
            return result

        def change_revision(*args, **kwargs):
            self.assertTrue(first_chunk_sent.is_set())
            self.assertTrue(captured[0][0].exists(), "the first response is still streaming when the browser changes its revision")
            result = transform(*args, **kwargs)
            revision_changed.set()
            return result

        def hold_after_first_chunk(handler, path, content_type, headers):
            write = handler.wfile.write
            writes = 0

            def write_and_wait(data):
                nonlocal writes
                result = write(data)
                writes += 1
                if writes == 2:  # Headers, then the first image chunk.
                    first_chunk_sent.set()
                    if not revision_changed.wait(THREAD_TIMEOUT):
                        raise AssertionError("the browser did not edit the image while the response was streaming")
                return result

            with patch.object(handler.wfile, "write", side_effect=write_and_wait):
                return stream_path(handler, path, content_type, headers)

        try:
            with patch.object(self.state, "render_browser_save", side_effect=capture_render), \
                    patch.object(self.state, "set_image_transform", side_effect=change_revision), \
                    patch.object(MosaicHandler, "_stream_path", hold_after_first_chunk):
                result = subprocess.run(
                    ["node", str(Path(__file__).with_name("save_stream_live_browser_helper.cjs")), self.origin],
                    cwd=Path(__file__).resolve().parents[1], text=True, encoding="utf-8", errors="replace",
                    capture_output=True, timeout=60, check=False,
                )
        finally:
            revision_changed.set()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        browser_result = json.loads(result.stdout)
        self.assertEqual(len(captured), 1)
        response_path, digest = captured[0]
        self.assertEqual(browser_result["digest"], digest, "the full browser response retains the version opened before the concurrent edit")
        self.assertFalse(response_path.exists(), "response completion releases the temporary output")

    def test_live_browser_save_render_streams_a_stable_image_response(self) -> None:
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8") if status != 200 else "")
        image_id = json.loads(body)["images"][0]["id"]
        mask_path = self.state.cache_dir / image_id / "stable-render.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("L", (12, 8), 255).save(mask_path)
        with self.state.image_io_lock(image_id), self.state.lock:
            self.state._commit_candidate_snapshot(
                image_id,
                [Candidate("stable-render", "penis", .9, mask_path)],
                replace=True,
            )
        self.state.set_candidate_state(image_id, "stable-render", {"enabled": False})
        self.state.set_image_flags(image_id, {"reviewed": True})
        state_before_render = {
            "catalog": self.state.catalog_snapshot(include_sources=True),
            "candidate": self.state.candidate_snapshot(image_id),
            "reviewed": self.state.images[image_id].reviewed,
        }
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
        response_paths: list[Path] = []
        original_render = self.state.render_browser_save

        def capture_render(*args, **kwargs):
            rendered = original_render(*args, **kwargs)
            if rendered.response_path is not None:
                response_paths.append(rendered.response_path)
            return rendered

        with patch.object(self.state, "render_browser_save", side_effect=capture_render):
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
        with self.assertLogs("mozarie", level="INFO") as status_log:
            status_code, _status_headers, status_body = self.request("POST", "/api/save/status", {
                "imageId": image_id,
                "candidateRevision": self.state._candidate_revision(image_id),
                "saveToken": headers["X-Mozarie-Save-Token"],
                "sourceAction": "overwrite",
            }, authorized=True)
        self.assertEqual(status_code, 200, status_body.decode("utf-8"))
        self.assertTrue(any("操作開始: ブラウザー保存状態確認" in line for line in status_log.output))
        self.assertTrue(any("操作完了: ブラウザー保存状態確認" in line and "所要=" in line for line in status_log.output))
        with Image.open(io.BytesIO(body)) as rendered:
            self.assertEqual((rendered.mode, rendered.size), ("RGB", (12, 8)))
        self.assertTrue(response_paths)
        for _ in range(50):
            if all(not path.exists() for path in response_paths):
                break
            time.sleep(.01)
        self.assertTrue(all(not path.exists() for path in response_paths), "response completion removes every temporary render")
        self.assertEqual({
            "catalog": self.state.catalog_snapshot(include_sources=True),
            "candidate": self.state.candidate_snapshot(image_id),
            "reviewed": self.state.images[image_id].reviewed,
        }, state_before_render, "streaming the response does not mutate image, candidate, or review state")

    def test_live_edited_name_moves_native_source_only_after_overwrite_and_reopens_canonically(self) -> None:
        status, _headers, body = self.request("POST", "/api/projects", {"name": "Edited HTTP save"}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        project_id = json.loads(body)["project"]["id"]
        status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        image_id = json.loads(body)["images"][0]["id"]

        status, _headers, body = self.request(
            "POST", "/api/catalog/rename", {"imageId": image_id, "filename": "edited.png"}, authorized=True,
        )
        self.assertEqual(status, 200, body.decode("utf-8"))
        renamed = json.loads(body)["images"][0]
        self.assertEqual((renamed["relativePath"], renamed["editedFilename"]), ("source.png", "edited.png"))
        self.assertTrue((self.source_dir / "source.png").is_file())
        self.assertFalse((self.source_dir / "edited.png").exists())

        options = {
            "imageId": image_id, "candidateRevision": 0,
            "clientSaveToken": "00000000-0000-4000-8000-000000000063",
            "copyToDefault": False, "suffix": "_censored", "format": "original", "keepMetadata": True,
        }
        status, _headers, body = self.request("POST", "/api/save/reserve", options, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        status, headers, body = self.request("POST", "/api/save/render", {**options, "divisor": 100, "draft": None}, authorized=True)
        self.assertEqual(status, 200)
        with Image.open(io.BytesIO(body)) as rendered:
            self.assertEqual((rendered.format, rendered.size), ("PNG", (12, 8)))

        commit = {"imageId": image_id, "candidateRevision": 0, "saveToken": headers["X-Mozarie-Save-Token"], "sourceAction": "overwrite"}
        status, _headers, body = self.request("POST", "/api/save/commit", commit, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        committed = json.loads(body)
        self.assertEqual((committed["sourceAction"], committed["relativePath"], committed["editedFilename"]), ("overwrite", "edited.png", None))
        self.assertFalse((self.source_dir / "source.png").exists())
        with Image.open(self.source_dir / "edited.png") as saved:
            self.assertEqual((saved.format, saved.size), ("PNG", (12, 8)))

        status, _headers, body = self.request("POST", "/api/save/commit", commit, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        retried = json.loads(body)
        self.assertEqual((retried["relativePath"], retried["editedFilename"]), ("edited.png", None))
        status, _headers, body = self.request("POST", "/api/save/status", {**commit}, authorized=True)
        self.assertEqual(status, 200, body.decode("utf-8"))
        receipt = json.loads(body)
        self.assertEqual((receipt["state"], receipt["relativePath"], receipt["editedFilename"]), ("committed", "edited.png", None))

        reopened = StudioState(self.state.cache_dir, self.state.session_base_dir)
        try:
            reopened.open_project(project_id)
            restored = reopened.catalog_snapshot()["images"]
            self.assertEqual([(image["relativePath"], image["editedFilename"]) for image in restored], [("edited.png", None)])
        finally:
            reopened.shutdown()

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
        self.state.set_image_flags(image_id, {"reviewed": True})
        history_before_save = self.state.workspace_store.history_status(image_id)
        self.assertTrue(history_before_save["canUndo"])

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
            self.assertTrue(reopened.images[image_id].reviewed)
            self.assertEqual(reopened.workspace_store.history_status(image_id), history_before_save)
        finally:
            reopened.shutdown()

    def test_flag_write_keeps_catalogue_state_consistent_across_a_sqlite_wait(self) -> None:
        _status, _headers, body = self.request("POST", "/api/folder", {"path": str(self.source_dir)}, authorized=True)
        image_id = json.loads(body)["images"][0]["id"]
        entered = threading.Event(); release = threading.Event(); result: dict[str, object] = {}
        original = self.state.workspace_store.set_image_flags
        def delayed(*args, **kwargs):
            entered.set(); self.assertTrue(release.wait(THREAD_TIMEOUT)); return original(*args, **kwargs)
        def flag_request() -> None:
            try:
                result["response"] = self.request("POST", f"/api/workspace/image/{image_id}", {"hidden": True}, authorized=True)
            except BaseException as exc:
                result["error"] = exc
        with patch.object(self.state.workspace_store, "set_image_flags", side_effect=delayed):
            worker = threading.Thread(target=flag_request)
            try:
                worker.start()
                self.assertTrue(entered.wait(THREAD_TIMEOUT))
                # The write holds the catalogue transition until SQLite confirms it.
                # Release it before reading state so the test verifies the durable
                # transition rather than relying on an implementation-specific lock order.
                release.set()
            finally:
                release.set()
                join_threads(worker)
            status, _headers, body = self.request("GET", "/api/job")
            self.assertEqual(status, 200)
            self.assertIn("state", json.loads(body))
        self.assertNotIn("error", result)
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
