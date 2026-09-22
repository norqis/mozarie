"""Stateful protocol and retry contracts for data-integrity verification.

The fixtures in this module use real SQLite workspaces, real image files and a
real loopback HTTP server.  Only accelerator inference and an injected image
read are replaced at their external boundaries.
"""

from __future__ import annotations

import http.client
import json
import shutil
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import mozarie.http as http_module
import mozarie.saving as saving_module
import mozarie.state as state_module
from mozarie.core import Candidate, ClientError
from mozarie.http import MosaicHandler
from mozarie.runtime_types import DetectionModels
from mozarie.state import StudioState


THREAD_TIMEOUT = 30


def join_worker(state: StudioState) -> None:
    thread = state.worker_thread
    if thread is None:
        return
    thread.join(THREAD_TIMEOUT)
    if thread.is_alive():
        raise AssertionError(f"worker did not finish: {thread.name}")


class StatefulRetryContracts(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        config_dir = self.app_dir / "config"
        config_dir.mkdir(parents=True)
        shutil.copyfile(
            Path(__file__).resolve().parents[1] / "config" / "defaults.json",
            config_dir / "defaults.json",
        )
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in reversed(self.states):
            state.shutdown()
        self._temporary.cleanup()

    def new_state(self, name: str) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / f"cache-{name}", self.root / f"sessions-{name}")
        self.states.append(state)
        return state

    def source_image(self, name: str) -> tuple[Path, Path]:
        source_dir = self.root / name
        source_dir.mkdir()
        pixels = np.zeros((16, 16, 3), dtype=np.uint8)
        pixels[:, :, 0] = np.arange(16, dtype=np.uint8)[None, :] * 15
        pixels[:, :, 1] = np.arange(16, dtype=np.uint8)[:, None] * 15
        path = source_dir / "source.png"
        Image.fromarray(pixels).save(path)
        return source_dir, path

    @staticmethod
    def add_candidate(state: StudioState, image_id: str) -> int:
        path = state.cache_dir / image_id / "candidate.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        mask = np.zeros((16, 16), dtype=np.uint8)
        mask[2:14, 2:14] = 255
        Image.fromarray(mask).save(path)
        candidate = Candidate("retry-candidate", "penis", .95, path, source="auto")
        with state.image_io_lock(image_id), state.lock:
            return state._commit_candidate_snapshot(image_id, [candidate], replace=True)

    def test_detection_gpu_memory_failure_releases_job_and_same_state_retry_publishes_mask(self) -> None:
        """WS-132: an accelerator OOM is terminal, then the same state can detect."""
        source_dir, _source = self.source_image("detect")
        state = self.new_state("detect")
        image_id = state.set_root(str(source_dir))[0]["id"]
        mask = np.zeros((16, 16), dtype=np.uint8)
        mask[3:13, 4:12] = 255

        class RetryTarget:
            calls = 0

            def detect(self, _rgb: np.ndarray, _confidence: float, *_args: object) -> list[dict[str, object]]:
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("CUDA out of memory while allocating inference tensor")
                return [{
                    "class_name": "penis",
                    "confidence": .91,
                    "mask": mask.copy(),
                    "source": "target",
                }]

        target = RetryTarget()
        models = DetectionModels(target=target)
        # Keep the product in its GPU error-mapping mode while replacing the
        # hardware/runtime probe and inference session at their boundaries.
        state.settings["models"]["provider"] = "gpu"
        state.settings["models"]["hand_detection_enabled"] = False
        state.settings["models"]["hand_segmentation_enabled"] = False
        with patch.object(state, "_require_supported_gpu"), \
                patch.object(state, "_ensure_models", return_value=models):
            state.start_detection([image_id], .5, 1)
            join_worker(state)
            failed = state.job_snapshot()
            self.assertEqual((failed["state"], failed["errorCode"]), ("error", "gpu_out_of_memory"))
            self.assertFalse(state._has_active_worker())
            self.assertEqual(state._candidate_revision(image_id), 0)
            self.assertEqual(state.candidate_snapshot(image_id)["candidates"], [])

            state.start_detection([image_id], .5, 1)
            join_worker(state)

        completed = state.job_snapshot()
        self.assertEqual((completed["state"], completed["completed"]), ("complete", 1))
        self.assertFalse(state._has_active_worker())
        snapshot = state.candidate_snapshot(image_id)
        self.assertEqual(snapshot["candidateRevision"], 1)
        self.assertEqual([item["labelToken"] for item in snapshot["candidates"]], ["penis"])
        published = state.candidates[image_id][0].mask_path
        self.assertTrue(published.is_file())
        with Image.open(published) as image:
            self.assertTrue(np.array_equal(np.asarray(image.convert("L")), mask))
        self.assertEqual(target.calls, 2)

    def test_apply_render_read_failure_releases_job_and_same_state_retry_writes_output(self) -> None:
        """WS-133: failed image rendering leaves the next apply usable."""
        source_dir, source = self.source_image("apply")
        output_dir = self.root / "apply-output"
        output_dir.mkdir()
        state = self.new_state("apply")
        state.settings["saving"]["default_output_directory"] = str(output_dir)
        image_id = state.set_root(str(source_dir))[0]["id"]
        mask = np.zeros((16, 16), dtype=np.uint8)
        mask[1:15, 1:15] = 255
        original_render = saving_module.render_output

        with patch.object(saving_module, "render_output", side_effect=OSError("decoder read failed")):
            self.assertTrue(state.start_apply([image_id], 2, {image_id: mask}, copy_to_default=True, suffix="_retry"))
            join_worker(state)
        failed = state.job_snapshot()
        self.assertEqual((failed["state"], failed["errorCode"]), ("error", "output_unavailable"))
        self.assertFalse(state._has_active_worker())
        self.assertEqual(list(output_dir.rglob("*.*")), [])

        with patch.object(saving_module, "render_output", wraps=original_render) as rendered:
            self.assertTrue(state.start_apply([image_id], 2, {image_id: mask}, copy_to_default=True, suffix="_retry"))
            join_worker(state)
        completed = state.job_snapshot()
        self.assertEqual((completed["state"], completed["completed"]), ("complete", 1))
        self.assertFalse(state._has_active_worker())
        self.assertEqual(rendered.call_count, 1)
        self.assertEqual(len(completed["outputs"]), 1)
        output = Path(completed["outputs"][0])
        self.assertTrue(output.is_file())
        with Image.open(source) as before, Image.open(output) as after:
            self.assertFalse(np.array_equal(np.asarray(before), np.asarray(after)))

    def test_browser_mask_read_failure_keeps_token_retryable_and_same_state_retry_overwrites_source(self) -> None:
        """WS-134: a failed candidate read can retry the same reserved save."""
        source_dir, source = self.source_image("browser")
        state = self.new_state("browser")
        image_id = state.set_root(str(source_dir))[0]["id"]
        revision = self.add_candidate(state, image_id)
        token = str(uuid.uuid4())
        state.reserve_browser_save(
            image_id,
            revision,
            token,
            copy_to_default=False,
            suffix="_censored",
            output_format="original",
            keep_metadata=True,
        )
        before = source.read_bytes()

        with patch.object(saving_module, "open_image", side_effect=OSError("mask decoder failed")):
            with self.assertRaises(ClientError) as raised:
                state.render_browser_save(image_id, revision, 2, None, client_save_token=token)
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(state.browser_save_tokens[token].state, "rendering")
        self.assertIsNone(state.browser_save_tokens[token].rendered_path)

        rendered = state.render_browser_save(image_id, revision, 2, None, client_save_token=token)
        self.assertEqual(state.browser_save_tokens[token].state, "pending")
        self.assertIsNotNone(rendered.response_path)
        self.assertTrue(rendered.response_path.is_file())
        with Image.open(rendered.response_path) as image:
            image.verify()
        committed = state.commit_browser_save(image_id, revision, rendered.save_token, "overwrite")
        self.assertEqual(committed["sourceAction"], "overwrite")
        self.assertNotEqual(source.read_bytes(), before)
        self.assertNotIn(token, state.browser_save_tokens)


class SourceDeleteProtocolContracts(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name).resolve()
        self.app_dir = self.root / "app"
        config_dir = self.app_dir / "config"
        config_dir.mkdir(parents=True)
        shutil.copyfile(
            Path(__file__).resolve().parents[1] / "config" / "defaults.json",
            config_dir / "defaults.json",
        )
        self.source_dir = self.root / "images"
        self.source_dir.mkdir()
        self.source = self.source_dir / "source.png"
        Image.new("RGB", (12, 8), "blue").save(self.source)
        self._previous_state = http_module.STATE
        with patch.object(state_module, "APP_DIR", self.app_dir):
            self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.image_id = self.state.set_root(str(self.source_dir))[0]["id"]
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
        self._temporary.cleanup()

    def post(self, path: str, payload: dict[str, object]) -> tuple[int, dict[str, object]]:
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Origin": self.origin,
            "X-Mozarie-Token": self.state.session_token,
            "X-Mozarie-Expected-Project-Id": self.state.catalog_id or "",
            "X-Mozarie-Expected-Catalog-Generation": str(self.state.catalog_generation),
        }
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", path, body, headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw)
        finally:
            connection.close()

    def prepare(self) -> str:
        token = str(uuid.uuid4())
        status, result = self.post("/api/catalog/delete-source/prepare", {
            "imageIds": [self.image_id],
            "deleteToken": token,
        })
        self.assertEqual(status, 200, result)
        self.assertEqual(result["state"], "prepared")
        return token

    def assert_source_and_catalog_unchanged(self, source_bytes: bytes, generation: int) -> None:
        self.assertEqual(self.source.read_bytes(), source_bytes)
        self.assertEqual(self.state.catalog_generation, generation)
        self.assertEqual([item["id"] for item in self.state.list_images()], [self.image_id])

    def test_source_delete_cancel_and_ack_obey_durable_protocol_states(self) -> None:
        """DI-226.3: cancel/ack never consume an unconfirmed deletion."""
        source_bytes = self.source.read_bytes()
        generation = self.state.catalog_generation

        prepared = self.prepare()
        status, rejected = self.post("/api/catalog/delete-source/ack", {"deleteToken": prepared})
        self.assertEqual((status, rejected["error_code"]), (400, "source_delete_cleanup_pending"))
        status, receipt = self.post("/api/catalog/delete-source/status", {"deleteToken": prepared})
        self.assertEqual((status, receipt["state"], receipt["preparedImageIds"]), (200, "prepared", [self.image_id]))
        self.assert_source_and_catalog_unchanged(source_bytes, generation)

        status, cancelled = self.post("/api/catalog/delete-source/cancel", {"deleteToken": prepared})
        self.assertEqual((status, cancelled["state"]), (200, "cancelled"))
        status, cancelled_again = self.post("/api/catalog/delete-source/cancel", {"deleteToken": prepared})
        self.assertEqual((status, cancelled_again["state"]), (200, "cancelled"))
        status, receipt = self.post("/api/catalog/delete-source/status", {"deleteToken": prepared})
        self.assertEqual((status, receipt["state"]), (200, "cancelled"))
        self.assert_source_and_catalog_unchanged(source_bytes, generation)
        status, acknowledged = self.post("/api/catalog/delete-source/ack", {"deleteToken": prepared})
        self.assertEqual((status, acknowledged["acknowledged"]), (200, True))
        status, missing = self.post("/api/catalog/delete-source/status", {"deleteToken": prepared})
        self.assertEqual((status, missing["error_code"]), (400, "source_delete_not_prepared"))

        claimed = self.prepare()
        status, result = self.post("/api/catalog/delete-source/claim", {"deleteToken": claimed})
        self.assertEqual((status, result["state"]), (200, "claimed"))
        status, rejected = self.post("/api/catalog/delete-source/ack", {"deleteToken": claimed})
        self.assertEqual((status, rejected["error_code"]), (400, "source_delete_cleanup_pending"))
        status, no_op = self.post("/api/catalog/delete-source/cancel", {"deleteToken": claimed})
        self.assertEqual((status, no_op["state"]), (200, "claimed"))
        status, still_claimed = self.post("/api/catalog/delete-source/status", {"deleteToken": claimed})
        self.assertEqual((status, still_claimed["state"]), (200, "claimed"))
        self.assert_source_and_catalog_unchanged(source_bytes, generation)

        status, released = self.post("/api/catalog/delete-source/release", {"deleteToken": claimed})
        self.assertEqual((status, released["state"]), (200, "prepared"))
        status, reclaimed = self.post("/api/catalog/delete-source/claim", {"deleteToken": claimed})
        self.assertEqual((status, reclaimed["state"]), (200, "claimed"))
        status, released = self.post("/api/catalog/delete-source/release", {"deleteToken": claimed})
        self.assertEqual((status, released["state"]), (200, "prepared"))
        status, cancelled = self.post("/api/catalog/delete-source/cancel", {"deleteToken": claimed})
        self.assertEqual((status, cancelled["state"]), (200, "cancelled"))
        status, acknowledged = self.post("/api/catalog/delete-source/ack", {"deleteToken": claimed})
        self.assertEqual((status, acknowledged["acknowledged"]), (200, True))

        committed = self.prepare()
        status, result = self.post("/api/catalog/delete-source/claim", {"deleteToken": committed})
        self.assertEqual((status, result["state"]), (200, "claimed"))
        self.state.workspace_store.update_source_delete_operation(
            committed,
            "committed",
            {"removedImageIds": [], "failed": [], "state": "committed"},
            expected_states={"claimed"},
        )
        status, no_op = self.post("/api/catalog/delete-source/cancel", {"deleteToken": committed})
        self.assertEqual((status, no_op["state"]), (200, "committed"))
        status, receipt = self.post("/api/catalog/delete-source/status", {"deleteToken": committed})
        self.assertEqual((status, receipt["state"]), (200, "committed"))
        self.assert_source_and_catalog_unchanged(source_bytes, generation)
        status, acknowledged = self.post("/api/catalog/delete-source/ack", {"deleteToken": committed})
        self.assertEqual((status, acknowledged["acknowledged"]), (200, True))
        status, missing = self.post("/api/catalog/delete-source/status", {"deleteToken": committed})
        self.assertEqual((status, missing["error_code"]), (400, "source_delete_not_prepared"))


if __name__ == "__main__":
    unittest.main()
