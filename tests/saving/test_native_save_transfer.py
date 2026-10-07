"""Native overwrite saves publish without downloading the image to the browser."""
from __future__ import annotations

import base64
import http.client
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

import numpy as np
from PIL import Image

from tests import prepare_test_app_config
import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.http import MosaicHandler
from mozarie.save_journal import SaveJournal
from mozarie.state import StudioState


class NativeSaveTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.app_dir = self.root / "app"
        prepare_test_app_config(self.app_dir)
        self.source = self.root / "images" / "source.png"
        self.source.parent.mkdir()
        self.pixels = np.arange(16 * 16 * 3, dtype=np.uint8).reshape((16, 16, 3))
        with Image.fromarray(self.pixels) as image:
            image.save(self.source)
        self.previous_app_dir = state_module.APP_DIR
        self.previous_state = http_module.STATE
        state_module.APP_DIR = self.app_dir
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.image_id = self.state.set_root(str(self.source.parent))[0]["id"]
        http_module.STATE = self.state
        self.server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive())
        http_module.STATE = self.previous_state
        self.state.shutdown()
        state_module.APP_DIR = self.previous_app_dir
        self.temporary.cleanup()

    def request(self, route, payload, connection=None, *, expected_status=200):
        owned = connection is None
        connection = connection or http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", route, json.dumps(payload).encode("utf-8"), {
                "Content-Type": "application/json", "Origin": self.origin,
                "X-Mozarie-Token": self.state.session_token,
                "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
                "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
            })
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, expected_status, body.decode("utf-8", errors="replace"))
            return dict(response.getheaders()), body
        finally:
            if owned:
                connection.close()

    def reserve(self, **options):
        payload = {
            "imageId": self.image_id, "candidateRevision": self.state._candidate_revision(self.image_id),
            "clientSaveToken": str(uuid.uuid4()), "copyToDefault": False,
            "format": "original", "keepMetadata": True, "divisor": 100, "draft": None,
            **options,
        }
        self.request("/api/save/reserve", payload)
        return payload

    def assert_empty_render(self, headers, body, payload, *, no_effect):
        self.assertEqual(body, b"", "native saves must not transfer image bytes")
        self.assertEqual(headers["Content-Length"], "0")
        self.assertEqual(headers["X-Mozarie-Save-Token"], payload["clientSaveToken"])
        self.assertEqual(headers["X-Mozarie-Revision"], str(payload["candidateRevision"]))
        self.assertEqual(headers["X-Mozarie-No-Effect"], "1" if no_effect else "0")

    def test_unchanged_native_save_needs_no_image_read_or_stage_and_reuses_connection(self):
        original = self.source.read_bytes()
        mtime = self.source.stat().st_mtime_ns
        workspace = self.state.workspace_store.export_state(self.image_id)
        stage_dir = self.state.cache_dir / "browser-save"
        payload = self.reserve(streamImage=False)
        original_open, original_mkdir = Path.open, Path.mkdir

        def reject_source_read(path, *args, **kwargs):
            if path == self.source:
                raise PermissionError("unchanged native render must not read the source")
            return original_open(path, *args, **kwargs)

        def reject_response_stage(path, *args, **kwargs):
            if path == stage_dir:
                raise PermissionError("unchanged native render must not create a response stage")
            return original_mkdir(path, *args, **kwargs)

        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            with patch.object(Path, "open", reject_source_read), patch.object(Path, "mkdir", reject_response_stage):
                headers, body = self.request("/api/save/render", payload, connection)
            self.assert_empty_render(headers, body, payload, no_effect=True)
            commit = {"imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
                      "saveToken": payload["clientSaveToken"], "sourceAction": "keep"}
            _headers, body = self.request("/api/save/status", commit, connection)
            self.assertEqual(json.loads(body)["state"], "pending")
            _headers, body = self.request("/api/save/commit", commit, connection)
            self.assertFalse(json.loads(body)["stale"])
        finally:
            connection.close()
        _headers, body = self.request("/api/save/status", commit)
        self.assertEqual(json.loads(body)["state"], "committed", "the receipt remains available after reconnecting")
        self.request("/api/save/ack", {"saveToken": payload["clientSaveToken"]})
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.source.stat().st_mtime_ns, mtime)
        self.assertEqual(self.state.workspace_store.export_state(self.image_id), workspace)
        self.assertFalse(stage_dir.exists())

    def test_changed_native_save_keeps_stage_until_commit_and_publishes_pixels(self):
        self.state.set_image_transform(self.image_id, {"flipH": True, "flipV": False})
        original = self.source.read_bytes()
        payload = self.reserve(streamImage=False)
        headers, body = self.request("/api/save/render", payload)
        self.assert_empty_render(headers, body, payload, no_effect=False)
        staged = Path(self.state.save_journal.row(payload["clientSaveToken"])["staged"])
        self.assertTrue(staged.is_file())
        self.assertEqual(self.source.read_bytes(), original)
        self.request("/api/save/commit", {
            "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
            "saveToken": payload["clientSaveToken"], "sourceAction": "overwrite",
        })
        with Image.open(self.source) as image:
            np.testing.assert_array_equal(np.asarray(image), self.pixels[:, ::-1])
        self.assertFalse(staged.exists())
        self.request("/api/save/ack", {"saveToken": payload["clientSaveToken"]})

    def assert_source_change_rejected(self, phase):
        original = self.source.read_bytes()
        workspace = self.state.workspace_store.export_state(self.image_id)
        payload = self.reserve(streamImage=False)
        if phase == "commit":
            headers, body = self.request("/api/save/render", payload)
            self.assert_empty_render(headers, body, payload, no_effect=True)
        external = original + b"external change"
        self.source.write_bytes(external)
        request = payload if phase == "render" else {
            "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
            "saveToken": payload["clientSaveToken"], "sourceAction": "keep",
        }
        _headers, body = self.request(f"/api/save/{phase}", request, expected_status=400)
        self.assertEqual(json.loads(body)["error_code"], "stale_asset")
        self.assertEqual(self.source.read_bytes(), external)
        self.assertEqual(self.state.workspace_store.export_state(self.image_id), workspace)
        self.assertIsNone(self.state.workspace_store.browser_save_receipt(payload["clientSaveToken"]))

    def test_unchanged_native_save_rechecks_source_before_render(self):
        self.assert_source_change_rejected("render")

    def test_unchanged_native_save_rechecks_source_before_commit(self):
        self.assert_source_change_rejected("commit")

    def test_native_stage_survives_elapsed_time_and_is_released_by_cancel_or_recovery(self):
        self.state.set_image_transform(self.image_id, {"flipH": True, "flipV": False})
        original = self.source.read_bytes()
        for cleanup in ("cancel", "recovery"):
            with self.subTest(cleanup=cleanup):
                payload = self.reserve(streamImage=False)
                headers, body = self.request("/api/save/render", payload)
                self.assert_empty_render(headers, body, payload, no_effect=False)
                token = payload["clientSaveToken"]
                staged = Path(self.state.save_journal.row(token)["staged"])
                with patch("time.monotonic", return_value=time.monotonic() + 31 * 86400):
                    self.state.cleanup_expired_browser_save_tokens()
                _headers, body = self.request("/api/save/status", {
                    "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
                    "saveToken": token, "sourceAction": "overwrite",
                })
                self.assertEqual(json.loads(body)["state"], "pending")
                self.assertTrue(staged.is_file(), "elapsed time cannot discard a durable pending save")
                if cleanup == "cancel":
                    self.request("/api/save/cancel", {
                        "imageId": self.image_id, "candidateRevision": payload["candidateRevision"], "saveToken": token,
                    })
                else:
                    # A new journal connection runs the same recovery used at startup.
                    SaveJournal(self.app_dir / "data").recover(self.state.workspace_store.browser_save_receipt)
                self.assertFalse(staged.exists())
                self.assertEqual(self.source.read_bytes(), original)

    def test_default_and_explicit_streaming_still_return_the_complete_image(self):
        for options in ({}, {"streamImage": True}):
            with self.subTest(options=options):
                payload = self.reserve(**options)
                headers, body = self.request("/api/save/render", payload)
                self.assertEqual(headers["Content-Type"], "image/png")
                self.assertEqual(int(headers["Content-Length"]), len(body))
                self.assertEqual(body, self.source.read_bytes())
                self.request("/api/save/cancel", {
                    "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
                    "saveToken": payload["clientSaveToken"],
                })

    def test_browser_copy_response_keeps_ownership_even_if_streaming_was_disabled(self):
        self.state.set_image_transform(self.image_id, {"flipH": True, "flipV": False})
        payload = self.reserve()
        rendered = self.state.render_browser_save(
            self.image_id, payload["candidateRevision"], 100, None,
            client_save_token=payload["clientSaveToken"], copy_to_browser=True, stream_image=False,
        )
        self.assertIsNotNone(rendered.response_path)
        try:
            self.assertTrue(rendered.response_path_is_temporary)
            self.assertIsNone(self.state.save_journal.row(payload["clientSaveToken"])["staged"])
            with Image.open(rendered.response_path) as image:
                np.testing.assert_array_equal(np.asarray(image), self.pixels[:, ::-1])
        finally:
            rendered.response_path.unlink(missing_ok=True)
        self.request("/api/save/cancel", {
            "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
            "saveToken": payload["clientSaveToken"],
        })

    def test_copy_output_path_header_is_preserved_without_image_transfer(self):
        destination = self.root / "output"
        destination.mkdir()
        self.state.settings["saving"]["default_output_directory"] = str(destination)
        payload = self.reserve(copyToDefault=True, streamImage=False)
        headers, body = self.request("/api/save/render", payload)
        self.assert_empty_render(headers, body, payload, no_effect=True)
        output = Path(base64.urlsafe_b64decode(headers["X-Mozarie-Output-Path-B64"]).decode("utf-8"))
        self.request("/api/save/commit", {
            "imageId": self.image_id, "candidateRevision": payload["candidateRevision"],
            "saveToken": payload["clientSaveToken"], "sourceAction": "keep",
        })
        self.assertEqual(output.parent, destination)
        self.assertEqual(output.read_bytes(), self.source.read_bytes())

    def test_chromium_single_and_batch_native_overwrite_request_no_image_transfer(self):
        try:
            result = subprocess.run(
                ["node", str(Path(__file__).with_name("native_save_transfer_live_browser_helper.cjs")), self.origin],
                cwd=Path(__file__).resolve().parents[2], text=True, encoding="utf-8", errors="replace",
                capture_output=True, timeout=60, check=False,
            )
        except subprocess.TimeoutExpired as error:
            self.fail(f"Chromium native saves timed out: {error.stdout!r}\n{error.stderr!r}")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        saved = json.loads(result.stdout)
        for encoded, expected in ((saved["single"], self.pixels[:, ::-1]), (saved["batch"], self.pixels[::-1, ::-1])):
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
                np.testing.assert_array_equal(np.asarray(image), expected)
        with Image.open(self.source) as image:
            np.testing.assert_array_equal(np.asarray(image), self.pixels[::-1, ::-1])
