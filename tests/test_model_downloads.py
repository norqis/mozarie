from __future__ import annotations

import hashlib
import tempfile
import threading
import time
import unittest
from urllib.error import URLError
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.model_downloads import ModelDownload, ModelDownloadCancelled, ModelDownloadError, ModelDownloadInProgress, ModelDownloadManager

THREAD_TIMEOUT = 30


def join_threads(*threads: threading.Thread) -> None:
    started = [thread for thread in threads if thread.ident is not None]
    for thread in started:
        thread.join(THREAD_TIMEOUT)
    for thread in started:
        if thread.is_alive():
            raise AssertionError(f"thread did not finish: {thread.name}")


class _Response:
    def __init__(self, payload: bytes, url: str = "https://models.example/file", content_length: str | None = None, status: int = 200, content_range: str | None = None) -> None:
        self.payload = payload
        self.offset = 0
        self.url = url
        self.status = status
        self.headers = {} if content_length is None else {"Content-Length": content_length}
        if content_range is not None: self.headers["Content-Range"] = content_range

    def __enter__(self): return self
    def __exit__(self, *args): return False
    def close(self) -> None: return None
    def geturl(self) -> str: return self.url
    def read(self, size: int) -> bytes:
        part = self.payload[self.offset:self.offset + size]; self.offset += len(part); return part


class _Opener:
    def __init__(self, response: _Response) -> None: self.response = response
    def open(self, request, timeout: int): return self.response


class ModelDownloadTests(unittest.TestCase):
    def entry(self, payload: bytes) -> ModelDownload:
        return ModelDownload("fixture", "target_segmentation", "https://models.example/file", "models/file.onnx", len(payload), hashlib.sha256(payload).hexdigest())

    def download(self, payload: bytes, entry: ModelDownload | None = None, **response) -> tuple[Path, ModelDownloadManager]:
        root = Path(tempfile.mkdtemp())
        manager = ModelDownloadManager(root)
        model = entry or self.entry(payload)
        fake = _Response(payload, **response)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(fake)):
            return manager._download(model), manager

    def test_verified_download_replaces_only_after_match(self) -> None:
        destination, _manager = self.download(b"model")
        self.assertEqual(destination.read_bytes(), b"model")
        self.assertFalse(destination.with_name(".file.onnx.part").exists())

    def test_short_or_excess_downloads_leave_existing_file_untouched(self) -> None:
        for payload, expected in ((b"short", b"longer"), (b"too-long", b"tiny")):
            with self.subTest(payload=payload):
                root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root); entry = self.entry(expected)
                destination = entry.destination(root); destination.parent.mkdir(parents=True); destination.write_bytes(b"existing")
                with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
                    with self.assertRaises(ModelDownloadError): manager._download(entry)
                self.assertEqual(destination.read_bytes(), b"existing")

    def test_hash_mismatch_is_not_installed(self) -> None:
        payload = b"model"; entry = self.entry(b"other")
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
            with self.assertRaises(ModelDownloadError): manager._download(entry)
        self.assertFalse(entry.destination(root).exists())

    def test_cancelled_download_is_not_installed(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root); manager._cancel.set()
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
            with self.assertRaises(ModelDownloadCancelled): manager._download(entry)
        self.assertFalse(entry.destination(root).exists())

    def test_partial_hash_check_reports_checking_and_verifying_progress(self) -> None:
        payload = b"a" * (128 * 1024 + 3)
        entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        temporary = entry.destination(root).with_name(".file.onnx.part")
        partial_size = 64 * 1024
        temporary.parent.mkdir(parents=True); temporary.write_bytes(payload[:partial_size])
        updates: list[dict] = []
        original_set = manager._set

        def observe(**changes):
            updates.append(changes); original_set(**changes)

        with patch.object(manager, "_set", side_effect=observe), \
                patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload[partial_size:], content_length=str(len(payload) - partial_size), status=206, content_range=f"bytes {partial_size}-{len(payload) - 1}/{len(payload)}"))):
            manager._download(entry)
        self.assertTrue(any(update.get("phase") == "checking" and update.get("received") == partial_size for update in updates))
        self.assertTrue(any(update.get("phase") == "verifying" and update.get("received") == len(payload) for update in updates))

    def test_cancelling_during_partial_hash_check_keeps_the_resume_file(self) -> None:
        payload = b"a" * (128 * 1024 + 3)
        entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        temporary = entry.destination(root).with_name(".file.onnx.part")
        temporary.parent.mkdir(parents=True); temporary.write_bytes(payload[:128 * 1024])
        original_set = manager._set

        def cancel_after_first_hash_chunk(**changes):
            original_set(**changes)
            if changes.get("phase") == "checking" and changes.get("received") == 128 * 1024:
                manager._cancel.set()

        with patch.object(manager, "_set", side_effect=cancel_after_first_hash_chunk):
            with self.assertRaises(ModelDownloadCancelled):
                manager._download(entry)
        self.assertTrue(temporary.is_file())
        self.assertFalse(entry.destination(root).exists())

    def test_insufficient_disk_space_stops_before_network_or_temp_write(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        with patch("mozarie.model_downloads.shutil.disk_usage", return_value=type("Disk", (), {"free": len(payload) - 1})()), \
                patch("mozarie.model_downloads.build_opener") as opener:
            with self.assertRaises(OSError):
                manager._download(entry)
        opener.assert_not_called()
        self.assertFalse(entry.destination(root).exists())
        self.assertFalse(entry.destination(root).with_name(".file.onnx.part").exists())

    def test_resumed_download_needs_space_only_for_the_remaining_bytes(self) -> None:
        payload = b"model-data"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        part = entry.destination(root).with_name(".file.onnx.part"); part.parent.mkdir(parents=True); part.write_bytes(payload[:4])
        opener = _Opener(_Response(payload[4:], content_length=str(len(payload) - 4), status=206, content_range=f"bytes 4-{len(payload) - 1}/{len(payload)}"))
        with patch("mozarie.model_downloads.shutil.disk_usage", return_value=type("Disk", (), {"free": len(payload) - 4})()), \
                patch("mozarie.model_downloads.build_opener", return_value=opener):
            destination = manager._download(entry)
        self.assertEqual(destination.read_bytes(), payload)

    def test_resumed_download_rejects_when_remaining_space_is_short(self) -> None:
        payload = b"model-data"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        part = entry.destination(root).with_name(".file.onnx.part"); part.parent.mkdir(parents=True); part.write_bytes(payload[:4])
        with patch("mozarie.model_downloads.shutil.disk_usage", return_value=type("Disk", (), {"free": len(payload) - 5})()), \
                patch("mozarie.model_downloads.build_opener") as opener:
            with self.assertRaises(OSError): manager._download(entry)
        opener.assert_not_called()
        self.assertEqual(part.read_bytes(), payload[:4])

    def test_download_resumes_a_partial_file_after_a_valid_range_response(self) -> None:
        payload = b"model-data"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        part = entry.destination(root).with_name(".file.onnx.part"); part.parent.mkdir(parents=True); part.write_bytes(payload[:4])
        opener = _Opener(_Response(payload[4:], content_length=str(len(payload) - 4), status=206, content_range=f"bytes 4-{len(payload) - 1}/{len(payload)}"))
        with patch("mozarie.model_downloads.build_opener", return_value=opener):
            destination = manager._download(entry)
        self.assertEqual(destination.read_bytes(), payload)
        self.assertEqual(opener.response.offset, len(payload) - 4)

    def test_download_restarts_when_the_server_ignores_range(self) -> None:
        payload = b"model-data"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        part = entry.destination(root).with_name(".file.onnx.part"); part.parent.mkdir(parents=True); part.write_bytes(b"old")
        opener = _Opener(_Response(payload, content_length=str(len(payload))))
        with patch("mozarie.model_downloads.build_opener", return_value=opener):
            destination = manager._download(entry)
        self.assertEqual(destination.read_bytes(), payload)

    def test_complete_verified_part_is_installed_without_another_request(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        part = entry.destination(root).with_name(".file.onnx.part"); part.parent.mkdir(parents=True); part.write_bytes(payload)
        with patch("mozarie.model_downloads.build_opener") as build:
            destination = manager._download(entry)
        build.assert_not_called()
        self.assertEqual(destination.read_bytes(), payload)

    def test_http_response_is_rejected(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload, url="http://models.example/file"))):
            with self.assertRaises(ModelDownloadError): manager._download(entry)

    def test_all_download_stops_after_the_first_failure_and_keeps_prior_path(self) -> None:
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        calls: list[str] = []
        def download(entry: ModelDownload) -> Path:
            calls.append(entry.key)
            if len(calls) == 2: raise ModelDownloadError("fixture failure")
            path = entry.destination(root); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"ok"); return path
        with patch.object(manager, "_download", side_effect=download):
            worker = None
            try:
                with manager._lock:
                    manager.start("all", "vit_b")
                    worker = manager._thread
                assert worker is not None
                join_threads(worker)
            finally:
                if worker is not None:
                    join_threads(worker)
        job = manager.snapshot()
        self.assertEqual(calls, ["sam_vit_b", "hand_detection"])
        self.assertEqual(job["state"], "failed")
        self.assertIn("sam_vit_b", job["paths"])
        self.assertIsNone(manager._thread)

    def test_download_failures_have_specific_safe_error_codes(self) -> None:
        cases = (
            (URLError("offline"), "model_download_network"),
            (OSError("disk full"), "model_download_write_failed"),
            (ModelDownloadError("bad hash"), "model_download_integrity"),
        )
        for failure, error_code in cases:
            with self.subTest(error_code=error_code):
                manager = ModelDownloadManager(Path(tempfile.mkdtemp()))
                with patch.object(manager, "_download", side_effect=failure):
                    manager._run(["hand_detection"])
                job = manager.snapshot()
                self.assertEqual(job["state"], "failed")
                self.assertEqual(job["errorCode"], error_code)
                self.assertNotIn("error", job)

    def test_only_manifest_keys_can_start_a_download(self) -> None:
        manager = ModelDownloadManager(Path(tempfile.mkdtemp()))
        with self.assertRaises(ModelDownloadError): manager.start("https://example.invalid/model", "vit_b")
        with self.assertRaises(ModelDownloadError): manager.start("all", "vit_unknown")

    def test_cancel_then_immediate_start_keeps_the_original_worker_cancelled(self) -> None:
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        entered = threading.Event(); release = threading.Event()
        def blocked_download(entry: ModelDownload) -> Path:
            entered.set(); self.assertTrue(release.wait(THREAD_TIMEOUT))
            if manager._cancel.is_set(): raise ModelDownloadCancelled()
            return entry.destination(root)
        with patch.object(manager, "_download", side_effect=blocked_download) as download:
            worker = None
            try:
                with manager._lock:
                    manager.start("sam_vit_b", "vit_b")
                    worker = manager._thread
                assert worker is not None
                self.assertTrue(entered.wait(THREAD_TIMEOUT))
                original_cancel = manager._cancel
                manager.cancel()
                with self.assertRaises(ModelDownloadInProgress):
                    manager.start("hand_detection", "vit_b")
                self.assertIs(manager._cancel, original_cancel)
                self.assertTrue(original_cancel.is_set())
                self.assertEqual(download.call_count, 1)
                release.set()
            finally:
                manager.cancel()
                release.set()
                if worker is not None:
                    join_threads(worker)
        self.assertEqual(manager.snapshot()["state"], "cancelled")
        self.assertIsNone(manager._thread)

    def test_shutdown_cancels_a_running_worker_and_returns_when_it_finishes(self) -> None:
        manager = ModelDownloadManager(Path(tempfile.mkdtemp()))
        entered = threading.Event(); release = threading.Event()
        def blocked_download(_entry: ModelDownload) -> Path:
            entered.set(); self.assertTrue(release.wait(THREAD_TIMEOUT))
            if manager._cancel.is_set(): raise ModelDownloadCancelled()
            raise AssertionError("shutdown did not cancel the worker")
        with patch.object(manager, "_download", side_effect=blocked_download):
            worker = None
            shutdown_result: dict[str, object] = {}
            shutdown_returned = threading.Event()

            def shutdown() -> None:
                try:
                    shutdown_result["value"] = manager.shutdown()
                except BaseException as exc:
                    shutdown_result["error"] = exc
                finally:
                    shutdown_returned.set()

            shutdown_thread = threading.Thread(target=shutdown)
            try:
                with manager._lock:
                    manager.start("hand_detection", "vit_b")
                    worker = manager._thread
                assert worker is not None
                self.assertTrue(entered.wait(THREAD_TIMEOUT))
                shutdown_thread.start()
                self.assertFalse(shutdown_returned.wait(.1))
                release.set()
                self.assertTrue(shutdown_returned.wait(THREAD_TIMEOUT))
            finally:
                manager.cancel()
                release.set()
                join_threads(shutdown_thread)
                if worker is not None:
                    join_threads(worker)
        self.assertNotIn("error", shutdown_result)
        self.assertTrue(shutdown_result["value"])
        self.assertEqual(manager.snapshot()["state"], "cancelled")

    def test_shutdown_waits_for_the_cancelled_worker_to_finish(self) -> None:
        manager = ModelDownloadManager(Path(tempfile.mkdtemp()))
        entered = threading.Event(); release = threading.Event()
        def blocked_download(_entry: ModelDownload) -> Path:
            entered.set(); self.assertTrue(release.wait(THREAD_TIMEOUT)); raise ModelDownloadCancelled()
        with patch.object(manager, "_download", side_effect=blocked_download):
            worker = None
            shutdown_result: dict[str, object] = {}
            shutdown_returned = threading.Event()

            def shutdown() -> None:
                try:
                    shutdown_result["value"] = manager.shutdown()
                except BaseException as exc:
                    shutdown_result["error"] = exc
                finally:
                    shutdown_returned.set()

            shutdown_thread = threading.Thread(target=shutdown)
            try:
                with manager._lock:
                    manager.start("hand_detection", "vit_b")
                    worker = manager._thread
                assert worker is not None
                self.assertTrue(entered.wait(THREAD_TIMEOUT))
                shutdown_thread.start()
                self.assertFalse(shutdown_returned.wait(.1))
                release.set()
                self.assertTrue(shutdown_returned.wait(THREAD_TIMEOUT))
            finally:
                manager.cancel()
                release.set()
                join_threads(shutdown_thread)
                if worker is not None:
                    join_threads(worker)
        self.assertNotIn("error", shutdown_result)
        self.assertTrue(shutdown_result["value"])
        self.assertEqual(manager.snapshot()["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
