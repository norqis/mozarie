"""Boundary regression tests for HTTP paths that are hard to reach through a browser.

These use actual request handlers and temporary files; narrow patches only inject
the operating-system or model-manager failures that a local application can hit.
"""

from __future__ import annotations

import base64
import contextlib
import io
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

from mozarie import http as http_module
from mozarie.core import BrowserSaveRender, ClientError, ImageRecord
from mozarie.model_downloads import ModelDownloadError


def handler(*, headers: dict[str, str] | None = None, body: bytes = b"") -> http_module.MosaicHandler:
    instance = http_module.MosaicHandler.__new__(http_module.MosaicHandler)
    instance.headers = headers or {}
    instance.rfile = io.BytesIO(body)
    instance.wfile = io.BytesIO()
    instance.close_connection = False
    instance.server = SimpleNamespace(server_port=9876)
    return instance


class HttpBoundaryCoverageTests(unittest.TestCase):
    def test_picker_os_failures_and_invalid_native_result_are_reported(self) -> None:
        state = SimpleNamespace(native_picker_lock=threading.Lock())
        with patch("mozarie.http.Path.is_file", return_value=True), patch(
            "mozarie.http.subprocess.run", side_effect=OSError("no desktop session")
        ):
            with self.assertRaisesRegex(ClientError, "failed"):
                http_module._run_native_picker("x", {}, failed_message="failed", busy_message="busy", state=state)

        invalid = SimpleNamespace(returncode=0, stdout=base64.b64encode(b"not base64 output")[1:])
        with patch("mozarie.http.Path.is_file", return_value=True), patch(
            "mozarie.http.subprocess.run", return_value=invalid
        ):
            with self.assertRaisesRegex(ClientError, "選択結果"):
                http_module._run_native_picker("x", {}, failed_message="failed", busy_message="busy", state=state)

    def test_unexpected_request_faults_preserve_gpu_recovery_contract_for_each_verb(self) -> None:
        failures: list[tuple[object, object]] = []

        def capture(error, status, *_args, **_kwargs):
            failures.append((error, status))

        state = Mock()
        state.recover_gpu_oom_for_request.return_value = ClientError("GPU", "gpu_oom")
        state.catalog_snapshot.side_effect = RuntimeError("GPU out of memory")
        get_handler = handler(); get_handler.path = "/api/images"
        get_handler._require_local_host = lambda: "127.0.0.1:9876"
        get_handler._client_error = capture
        with patch.object(http_module, "STATE", state):
            get_handler.do_GET()

        state.recover_gpu_oom_for_request.return_value = None
        state.add_boundary_candidate.side_effect = RuntimeError("disk fault")
        post_handler = handler(); post_handler.path = "/api/boundary"
        post_handler._require_json_request = lambda: None
        post_handler._read_json_body = lambda: {"imageId": "image"}
        post_handler._client_error = capture
        with patch.object(http_module, "STATE", state):
            post_handler.do_POST()

        state.remove_image_from_catalog.side_effect = RuntimeError("database fault")
        delete_handler = handler(); delete_handler.path = "/api/catalog/image/image"
        delete_handler._require_mutation_request = lambda: None
        delete_handler._client_error = capture
        with patch.object(http_module, "STATE", state):
            delete_handler.do_DELETE()

        self.assertEqual([getattr(error, "error_code", None) for error, _status in failures], ["gpu_oom", None, None])

    def test_upload_catalog_conflicts_and_provisional_fallback_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory) / "upload.png"
            staged.write_bytes(b"fixture")

            def run_upload(*, catalog_id: str | None, requested: str) -> tuple[Mock, list[object]]:
                state = Mock()
                state.catalog_id = catalog_id
                state.browser_catalog_provisional = False
                state.import_staging_gate = threading.RLock()
                state.import_lock = threading.RLock()
                state.workspace_store.ensure_provisional_catalog.return_value = "provisional"
                state.import_image_file_for_api.return_value = ([], True)
                emitted: list[object] = []
                request = handler(headers={"X-Mozarie-Catalog-Id": requested})
                request.path = "/api/import/file"
                request._require_binary_import_request = lambda: None
                request._read_binary_body_to_file = lambda: staged
                request._client_error = lambda error, *_args, **_kwargs: emitted.append(error)
                request._json = lambda payload, *_args, **_kwargs: emitted.append(payload)
                with patch.object(http_module, "STATE", state):
                    request.do_POST()
                return state, emitted

            conflict, emitted = run_upload(catalog_id="active", requested="other")
            self.assertEqual(getattr(emitted[0], "error_code", None), "operation_in_progress")
            conflict.end_import_transfer.assert_called_once()

            staged.write_bytes(b"fixture")
            fallback, emitted = run_upload(catalog_id=None, requested="")
            self.assertEqual(emitted[-1]["catalogId"], "provisional")
            self.assertTrue(fallback.browser_catalog_provisional)

    def test_post_optional_error_and_response_paths_have_stable_results(self) -> None:
        request = handler(); request._require_json_request = lambda: None
        emitted: list[object] = []
        request._json = lambda payload, *_args, **_kwargs: emitted.append(payload)
        request._binary = lambda *_args, **_kwargs: emitted.append("binary")
        request._client_error = lambda error, *_args, **_kwargs: emitted.append(error)
        state = Mock()
        state.settings = {"detection": {"threshold": 0.5, "parallelism": 1}}
        state.model_downloads.start.side_effect = ModelDownloadError("unavailable")
        state.render_browser_save.return_value = BrowserSaveRender(
            b"png", SimpleNamespace(path=Path("source.png")), 7, "save-token", Path("copy.png")
        )
        state.recover_gpu_oom_for_request.return_value = None
        with patch.object(http_module, "STATE", state), patch.object(http_module, "_reserve_update_start", side_effect=(False, True)), patch(
            "mozarie.http.threading.Thread"
        ) as thread:
            request.path = "/api/model-download/start"
            request._read_json_body = lambda: {"modelKey": "target", "samType": ""}
            request.do_POST()
            request.path = "/api/update/start"
            request._read_json_body = lambda: {}
            request.do_POST()
            request.path = "/api/update/start"
            request.do_POST()
            request.path = "/api/save/render"
            request._read_json_body = lambda: {"imageId": "image", "candidateRevision": 0, "divisor": 100, "copyToDefault": True}
            request.do_POST()
            request.path = "/api/settings?status=0"
            request._read_json_body = lambda: {}
            request.do_POST()
        self.assertEqual(getattr(emitted[0], "error_code", None), "model_download_invalid")
        self.assertEqual(getattr(emitted[1], "error_code", None), "operation_in_progress")
        self.assertEqual(emitted[-2]["output"], "copy.png")
        thread.assert_called_once()

    def test_binary_reader_rejects_oversize_and_thumbnail_staleness_cleans_temp_file(self) -> None:
        with self.assertRaises(ClientError):
            handler(headers={"Content-Length": str(http_module.MAX_BODY_BYTES + 1)})._read_binary_body_to_file()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (8, 8), "white").save(source)
            record = ImageRecord("image", source, "source.png", 8, 8, source.stat().st_mtime_ns, source.stat().st_size)

            class ChangingImages(dict):
                def __init__(self):
                    super().__init__({"image": record}); self.reads = 0
                def get(self, key, default=None):
                    self.reads += 1
                    return record if self.reads == 1 else None

            state = SimpleNamespace(
                cache_dir=root / "cache", images=ChangingImages(), lock=threading.RLock(),
                thumbnail_gate=threading.RLock(), image_io_lock=lambda _id: contextlib.nullcontext(),
                image_snapshot=lambda _id: record, _assert_record_stat_matches=lambda _record: None,
                asset_version=lambda _record: "v1",
            )
            request = handler(); request._stream_file = lambda *_args: None
            with patch.object(http_module, "STATE", state):
                with self.assertRaisesRegex(ClientError, "更新"):
                    request._send_image("image", thumbnail=True, version="v1")
            self.assertEqual(list((state.cache_dir / "thumbnails").glob("*.tmp")), [])

    def test_static_non_html_log_parse_failure_and_update_status(self) -> None:
        request = handler()
        request._binary = Mock()
        with tempfile.TemporaryDirectory() as directory:
            static = Path(directory)
            (static / "app.css").write_text("body{}", encoding="utf-8")
            with patch.object(http_module, "STATIC_DIR", static):
                request._send_static("/app.css")
        request.command = "GET"; request.path = "/broken"
        with patch.object(http_module.LOGGER, "warning") as warning:
            request.log_message("%s", "only-one-argument")
        warning.assert_called_once()

        with patch("updater.read_local_version", return_value="v1.0.0"), patch(
            "updater.display_version", side_effect=lambda value: str(value)
        ), patch("updater.fetch_latest_release", return_value={"tag_name": "v1.1.0"}), patch(
            "updater.parse_version", side_effect=lambda value: tuple(int(piece) for piece in value.removeprefix("v").split("."))
        ):
            self.assertEqual(http_module._local_version(), "v1.0.0")
            self.assertTrue(http_module._update_status()["available"])

    def test_rejected_binary_requests_and_missing_import_length_close_the_request(self) -> None:
        request = handler(headers={"Host": "127.0.0.1:9876", "Origin": "http://127.0.0.1:9876", "X-Mozarie-Token": "token", "Content-Type": "text/plain"})
        request._reject_unread_request = lambda error: (_ for _ in ()).throw(error)
        with patch.object(http_module, "STATE", SimpleNamespace(session_token="token")):
            with self.assertRaises(ClientError):
                request._require_binary_import_request()
        with self.assertRaises(ClientError):
            handler()._read_binary_body_to_file()

    def test_error_routes_cover_non_gpu_faults_and_explicit_client_failures(self) -> None:
        emitted: list[tuple[object, object]] = []
        capture = lambda error, status, *_args, **_kwargs: emitted.append((error, status))

        get_state = Mock()
        get_state.catalog_snapshot.side_effect = RuntimeError("read failure")
        get_state.recover_gpu_oom_for_request.return_value = None
        request = handler(); request.path = "/api/images"; request._require_local_host = lambda: "127.0.0.1:9876"; request._client_error = capture
        with patch.object(http_module, "STATE", get_state):
            request.do_GET()

        post_state = Mock()
        post_state.add_boundary_candidate.side_effect = RuntimeError("GPU memory")
        post_state.recover_gpu_oom_for_request.return_value = ClientError("GPU", "gpu_oom")
        request = handler(); request.path = "/api/boundary"; request._require_json_request = lambda: None; request._read_json_body = lambda: {"imageId": "image"}; request._client_error = capture
        with patch.object(http_module, "STATE", post_state):
            request.do_POST()

        delete_state = Mock()
        delete_state.remove_image_from_catalog.side_effect = RuntimeError("GPU memory")
        delete_state.recover_gpu_oom_for_request.return_value = ClientError("GPU", "gpu_oom")
        request = handler(); request.path = "/api/catalog/image/image"; request._require_mutation_request = lambda: None; request._client_error = capture
        with patch.object(http_module, "STATE", delete_state):
            request.do_DELETE()

        request = handler(); request.path = "/api/catalog/image/image"; request._require_mutation_request = lambda: (_ for _ in ()).throw(http_module.ForbiddenClientError("no", "session_expired")); request._client_error = capture
        request.do_DELETE()
        request = handler(); request.path = "/api/candidate/image"; request._require_mutation_request = lambda: None; request._client_error = capture
        with patch.object(http_module, "STATE", Mock()):
            request.do_DELETE()
        self.assertEqual([status for _error, status in emitted], [http_module.HTTPStatus.INTERNAL_SERVER_ERROR, http_module.HTTPStatus.BAD_REQUEST, http_module.HTTPStatus.BAD_REQUEST, http_module.HTTPStatus.FORBIDDEN, http_module.HTTPStatus.BAD_REQUEST])

    def test_upload_activates_requested_catalog_and_rejects_invalid_provisional_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory) / "upload.png"; staged.write_bytes(b"fixture")
            state = Mock()
            state.catalog_id = None; state.browser_catalog_provisional = False
            state.import_staging_gate = threading.RLock(); state.import_lock = threading.RLock()
            state.import_image_file_for_api.return_value = ([], True)
            request = handler(headers={"X-Mozarie-Catalog-Id": "catalog"}); request.path = "/api/import/file"
            request._require_binary_import_request = lambda: None; request._read_binary_body_to_file = lambda: staged; request._json = Mock()
            with patch.object(http_module, "STATE", state):
                request.do_POST()
            state.activate_browser_catalog.assert_called_once_with("catalog")

            staged.write_bytes(b"fixture")
            state.catalog_id = "catalog"
            request = handler(headers={}); request.path = "/api/import/file"
            request._require_binary_import_request = lambda: None; request._read_binary_body_to_file = lambda: staged; request._json = Mock()
            with patch.object(http_module, "STATE", state):
                request.do_POST()
            state.workspace_store.ensure_provisional_catalog.assert_not_called()

        state = Mock(); request = handler(); request.path = "/api/workspace/catalog"
        request._require_json_request = lambda: None; request._read_json_body = lambda: {"provisional": True, "catalogId": "not-allowed"}
        errors: list[object] = []; request._client_error = lambda error, *_args, **_kwargs: errors.append(error)
        with patch.object(http_module, "STATE", state):
            request.do_POST()
        self.assertEqual(getattr(errors[0], "error_code", None), "input_invalid")

    def test_thumbnail_initial_stale_missing_file_and_stream_disconnects_are_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; Image.new("RGB", (8, 8), "white").save(source)
            record = ImageRecord("image", source, "source.png", 8, 8, source.stat().st_mtime_ns, source.stat().st_size)
            base_state = dict(cache_dir=root / "cache", lock=threading.RLock(), thumbnail_gate=threading.RLock(), image_io_lock=lambda _id: contextlib.nullcontext(), image_snapshot=lambda _id: record, _assert_record_stat_matches=lambda _record: None, asset_version=lambda _record: "v1")
            stale = SimpleNamespace(**base_state, images={})
            with patch.object(http_module, "STATE", stale), self.assertRaises(ClientError):
                handler()._send_image("image", thumbnail=True, version="v1")

            thumbnail_dir = base_state["cache_dir"] / "thumbnails"; thumbnail_dir.mkdir(parents=True, exist_ok=True); (thumbnail_dir / "image-v1.jpg").write_bytes(b"cached")
            current = SimpleNamespace(**base_state, images={"image": record})
            request = handler(); request._stream_file = Mock()
            with patch.object(http_module, "STATE", current), patch.object(Path, "open", side_effect=FileNotFoundError):
                with self.assertRaisesRegex(ClientError, "サムネイル"):
                    request._send_image("image", thumbnail=True, version="v1")

            waiting_thumbnail = thumbnail_dir / "image-v1.jpg"
            waiting_thumbnail.unlink()
            class Gate:
                def __enter__(self):
                    waiting_thumbnail.write_bytes(b"cached")
                def __exit__(self, *_args):
                    return False
            waiter = SimpleNamespace(**(base_state | {"images": {"image": record}, "thumbnail_gate": Gate()}))
            request = handler(); request._stream_file = Mock()
            with patch.object(http_module, "STATE", waiter):
                request._send_image("image", thumbnail=True, version="v1")
            request._stream_file.assert_called_once()

            request = handler(); request.send_response = Mock(side_effect=BrokenPipeError); request.send_header = Mock(); request.end_headers = Mock()
            with source.open("rb") as stream:
                request._stream_file(stream, None, "text/plain", "no-store")
            self.assertTrue(request.close_connection)
            request = handler(); request.send_response = Mock(); request.send_header = Mock(); request.end_headers = Mock(); request.wfile = Mock(); request.wfile.write.side_effect = ConnectionResetError
            with source.open("rb") as stream:
                request._stream_file(stream, None, "text/plain", "no-store")
            self.assertTrue(request.close_connection)

    def test_missing_candidate_mask_is_stale_not_a_server_error(self) -> None:
        request = handler(); state = SimpleNamespace(lock=threading.RLock(), images={})
        with patch.object(http_module, "STATE", state):
            with self.assertRaises(http_module.StaleMaskError):
                request._send_candidate_mask("missing", "candidate", None)
