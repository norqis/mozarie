"""Regression coverage for loading the HTTP request handler module."""

import ast
import contextlib
import http.client
import importlib
import json
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from http import HTTPStatus

from PIL import Image, PngImagePlugin

from mozarie import catalog as catalog_module
from mozarie import http as http_module
from mozarie import state as state_module
from mozarie.core import ClientError
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class HttpImportRegressionTests(unittest.TestCase):
    def test_http_module_parses_and_imports(self) -> None:
        source = (Path(__file__).parents[1] / "mozarie" / "http.py").read_text(encoding="utf-8")
        ast.parse(source)
        importlib.import_module("mozarie.http")

class FolderLoadLoggingContractTests(unittest.TestCase):
    """Keep the user-visible CMD summary and HTTP operation log bounded."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary_directory.name).resolve()
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).parents[1] / "config", self.app_dir / "config")
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self.states:
            state.shutdown()
        self._temporary_directory.cleanup()

    def new_state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / "cache", self.root / "sessions")
        self.states.append(state)
        return state

    @staticmethod
    def write_png(path: Path, color: str = "white") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), color).save(path)

    def test_folder_scan_keeps_valid_images_and_enumerates_every_failed_file(self) -> None:
        folder = self.root / "mixed"
        folder.mkdir()
        self.write_png(folder / "valid.png")
        (folder / "corrupt.png").write_bytes(b"not an image")
        self.write_png(folder / "changed.png")
        state = self.new_state()
        state.settings["importing"]["parallelism"] = 1
        inspect = catalog_module.inspect_import_image

        def change_after_inspection(path: Path, suffix: str) -> tuple[int, int]:
            dimensions = inspect(path, suffix)
            if path.name == "changed.png":
                self.write_png(path, "black")
            return dimensions

        with patch.object(catalog_module, "inspect_import_image", side_effect=change_after_inspection), \
                self.assertLogs("mozarie.core", "INFO") as captured:
            images = state.set_root(str(folder))

        self.assertEqual([image["relativePath"] for image in images], ["valid.png"])
        log = "\n".join(captured.output)
        self.assertIn("フォルダー走査を開始", log)
        self.assertIn("候補=3件 読込=1件", log)
        self.assertIn("image_read_failed=1件（例: corrupt.png）", log)
        self.assertIn("scan_changed=1件（例: changed.png）", log)
        self.assertIn("- corrupt.png (image_read_failed)", log)
        self.assertIn("- changed.png (scan_changed)", log)
        self.assertEqual(state.last_folder_scan_failures, [
            {"relativePath": "changed.png", "reason": "scan_changed"},
            {"relativePath": "corrupt.png", "reason": "image_read_failed"},
        ])

    def test_folder_scan_keeps_large_ztxt_itxt_pngs_when_a_corrupt_png_is_present(self) -> None:
        folder = self.root / "mixed-large-text"; folder.mkdir()
        ztxt = PngImagePlugin.PngInfo(); ztxt.add_text("workflow", "z" * 1_200_000, zip=True)
        itxt = PngImagePlugin.PngInfo(); itxt.add_itxt("workflow", "i" * 1_200_000, lang="ja", tkey="workflow", zip=True)
        Image.new("RGB", (8, 8), "white").save(folder / "large-ztxt.png", pnginfo=ztxt)
        Image.new("RGB", (8, 8), "black").save(folder / "large-itxt.png", pnginfo=itxt)
        (folder / "corrupt.png").write_bytes(b"not a PNG")
        state = self.new_state(); state.settings["importing"]["parallelism"] = 1

        images = state.set_root(str(folder))

        self.assertEqual([image["relativePath"] for image in images], ["large-itxt.png", "large-ztxt.png"])
        self.assertEqual(state.last_folder_scan_failures, [{"relativePath": "corrupt.png", "reason": "image_read_failed"}])
        self.assertIn(b"zTXt", (folder / "large-ztxt.png").read_bytes())
        self.assertIn(b"iTXt", (folder / "large-itxt.png").read_bytes())

    def test_folder_scan_keeps_the_previous_catalog_when_rglob_loses_access(self) -> None:
        previous = self.root / "previous"; previous.mkdir(); self.write_png(previous / "previous.png")
        folder = self.root / "permission-loss"; folder.mkdir(); self.write_png(folder / "kept.png")
        state = self.new_state(); state.settings["importing"]["parallelism"] = 1
        state.set_root(str(previous)); before = state.catalog_snapshot()
        native_walk = catalog_module.os.walk

        def walk_then_permission_loss(path: Path, *, onerror):
            if path == folder:
                yield str(folder), [], ["kept.png"]
                onerror(PermissionError(13, "access denied", str(folder / "locked")))
                return
            yield from native_walk(path, onerror=onerror)

        with patch.object(catalog_module.os, "walk", walk_then_permission_loss), self.assertRaisesRegex(ClientError, "最後まで") as raised:
            state.set_root(str(folder))

        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(raised.exception.params, {"failures": [{"relativePath": "locked", "reason": "scan_unreadable"}]})
        self.assertEqual(state.catalog_snapshot(), before)

    def test_folder_scan_reports_access_loss_before_any_image_as_incomplete(self) -> None:
        previous = self.root / "previous"; previous.mkdir(); self.write_png(previous / "previous.png")
        folder = self.root / "permission-loss-empty"; folder.mkdir()
        state = self.new_state(); state.set_root(str(previous)); before = state.catalog_snapshot()
        native_walk = catalog_module.os.walk

        def inaccessible_walk(path: Path, *, onerror):
            if path == folder:
                onerror(PermissionError(13, "access denied", str(folder / "locked")))
                return
            yield from native_walk(path, onerror=onerror)

        with patch.object(catalog_module.os, "walk", inaccessible_walk), self.assertRaisesRegex(ClientError, "最後まで") as raised:
            state.set_root(str(folder))

        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(raised.exception.params, {"failures": [{"relativePath": "locked", "reason": "scan_unreadable"}]})
        self.assertEqual(state.catalog_snapshot(), before)

    def test_empty_and_unreadable_folders_keep_the_previous_catalog(self) -> None:
        previous = self.root / "previous"
        previous.mkdir()
        self.write_png(previous / "kept.png")
        state = self.new_state()
        state.set_root(str(previous))
        before = state.catalog_snapshot()
        before_images = state.list_images()

        empty = self.root / "empty"
        empty.mkdir()
        with self.assertLogs("mozarie.core", "INFO") as empty_logs:
            with self.assertRaisesRegex(ClientError, "対応画像がありません") as raised:
                state.set_root(str(empty))
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertIn("候補=0件 読込=0件 スキップ=なし", "\n".join(empty_logs.output))
        self.assertEqual(state.catalog_snapshot(), before)
        self.assertEqual(state.list_images(), before_images)

        unreadable = self.root / "unreadable"
        unreadable.mkdir()
        (unreadable / "broken.png").write_bytes(b"not an image")
        with self.assertLogs("mozarie.core", "INFO") as unreadable_logs:
            with self.assertRaisesRegex(ClientError, "読み込めません") as raised:
                state.set_root(str(unreadable))
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(raised.exception.params, {"failures": [{"relativePath": "broken.png", "reason": "image_read_failed"}]})
        self.assertIn("候補=1件 読込=0件 スキップ=image_read_failed=1件（例: broken.png）", "\n".join(unreadable_logs.output))
        self.assertEqual(state.catalog_snapshot(), before)
        self.assertEqual(state.list_images(), before_images)

    def test_folder_endpoint_returns_mixed_failures_and_all_invalid_failure_list(self) -> None:
        from http.server import ThreadingHTTPServer

        healthy = self.root / "healthy"
        healthy.mkdir()
        self.write_png(healthy / "kept.png")
        mixed = self.root / "mixed-http"
        mixed.mkdir()
        self.write_png(mixed / "valid.png")
        (mixed / "broken.png").write_bytes(b"not an image")
        invalid = self.root / "invalid-http"
        invalid.mkdir()
        (invalid / "only-broken.png").write_bytes(b"not an image")
        state = self.new_state()
        state.set_root(str(healthy))

        with patch.object(http_module, "STATE", state), patch.object(state_module, "STATE", state):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                def folder_request(path: Path) -> tuple[int, dict[str, object]]:
                    body = json.dumps({"path": str(path)}).encode("utf-8")
                    connection.request("POST", "/api/folder", body, {
                        "Host": f"127.0.0.1:{httpd.server_port}",
                        "Origin": f"http://127.0.0.1:{httpd.server_port}",
                        "Content-Type": "application/json",
                        "X-Mozarie-Token": state.session_token,
                        "X-Mozarie-Expected-Project-Id": "",
                        "X-Mozarie-Expected-Catalog-Generation": str(state.catalog_generation),
                    })
                    response = connection.getresponse()
                    return response.status, json.loads(response.read().decode("utf-8"))

                status, payload = folder_request(mixed)
                self.assertEqual(status, 200)
                self.assertEqual([image["relativePath"] for image in payload["images"]], ["valid.png"])
                self.assertEqual(payload["importFailures"], [{"relativePath": "broken.png", "reason": "image_read_failed"}])
                before_all_invalid = state.catalog_snapshot()

                status, payload = folder_request(invalid)
                self.assertEqual(status, 400)
                self.assertEqual(payload, {"error_code": "image_read_failed", "params": {"failures": [{"relativePath": "only-broken.png", "reason": "image_read_failed"}]}})
                self.assertEqual(state.catalog_snapshot()["images"], before_all_invalid["images"])
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()

    def test_binary_browser_import_keeps_later_valid_file_after_a_bad_upload(self) -> None:
        from http.server import ThreadingHTTPServer

        state = self.new_state()
        valid = self.root / "valid.png"
        self.write_png(valid)
        valid_bytes = valid.read_bytes()
        session_id = str(uuid.uuid4())
        source_id = str(uuid.uuid4())
        with patch.object(http_module, "STATE", state), patch.object(state_module, "STATE", state):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                def mutation_headers() -> dict[str, str]:
                    return {
                        "Host": f"127.0.0.1:{httpd.server_port}",
                        "Origin": f"http://127.0.0.1:{httpd.server_port}",
                        "X-Mozarie-Token": state.session_token,
                        "X-Mozarie-Expected-Project-Id": "",
                        "X-Mozarie-Expected-Catalog-Generation": "0",
                    }

                connection.request("POST", "/api/import/start", json.dumps({
                    "sessionId": session_id, "expectedProjectId": None, "expectedCatalogGeneration": 0,
                }).encode("utf-8"), {**mutation_headers(), "Content-Type": "application/json"})
                start_response = connection.getresponse()
                self.assertEqual(start_response.status, 200)
                start_response.read()

                def upload(name: str, body: bytes, client_key: str) -> int:
                    headers = {
                        **mutation_headers(), "Content-Type": "application/octet-stream",
                        "X-Mozarie-Name": name, "X-Mozarie-Relative-Path": name,
                        "X-Mozarie-Client-Key": client_key, "X-Mozarie-File-Mtime": "0",
                        "X-Mozarie-File-Size": str(len(body)), "X-Mozarie-Source-Id": source_id,
                        "X-Mozarie-Source-Kind": "browser-files", "X-Mozarie-Import-Intent": "add",
                        "X-Mozarie-Import-Session": session_id,
                    }
                    connection.request("POST", "/api/import/file", body, headers)
                    response = connection.getresponse()
                    response.read()
                    return response.status

                self.assertEqual(upload("valid-first.png", valid_bytes, "first"), 200)
                self.assertEqual(upload("broken-middle.png", b"not an image", "broken"), 400)
                self.assertEqual(upload("valid-last.png", valid_bytes, "last"), 200)
                connection.request("POST", "/api/import/finish", json.dumps({
                    "sessionId": session_id, "expectedProjectId": None, "expectedCatalogGeneration": 0,
                    "completed": 3, "failed": True, "cancelled": False,
                }).encode("utf-8"), {**mutation_headers(), "Content-Type": "application/json"})
                finish_response = connection.getresponse()
                self.assertEqual(finish_response.status, 200)
                finish_response.read()
                self.assertEqual([image["relativePath"] for image in state.list_images()], ["valid-first.png", "valid-last.png"])
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()

    def test_handler_logs_normalized_routes_without_request_secrets(self) -> None:
        secret_id = "image-id-secret"
        secret_body = "body-secret"
        secret_header = "header-secret"
        payload = {"imageIds": [secret_id], "note": secret_body}
        state = Mock()
        state.catalog_request.return_value = contextlib.nullcontext()
        state.set_image_flags.return_value = {"hidden": True}
        state.recover_gpu_oom_for_request.return_value = None

        def request() -> MosaicHandler:
            handler = object.__new__(MosaicHandler)
            handler.path = f"/api/workspace/image/{secret_id}"
            handler.headers = {"X-Mozarie-Token": secret_header, "Authorization": secret_header}
            handler._require_json_request = lambda: None
            handler._read_json_body = lambda: payload
            handler._catalog_expectation = lambda _payload: (None, 0)
            handler._json = Mock()
            handler._client_error = Mock()
            return handler

        completed = request()
        with patch.object(http_module, "STATE", state), self.assertLogs("mozarie.core", "INFO") as completed_logs:
            completed.do_POST()
        completed._json.assert_called_once_with({"hidden": True})
        success_log = "\n".join(completed_logs.output)
        self.assertIn("操作開始: 画像状態変更 [/api/workspace/image]", success_log)
        self.assertIn("操作対象: 画像状態変更 [/api/workspace/image] 対象=1件", success_log)
        self.assertIn("操作完了: 画像状態変更 [/api/workspace/image] status=200 所要=", success_log)

        state.set_image_flags.side_effect = ClientError("bad request", "input_invalid")
        failed = request()
        with patch.object(http_module, "STATE", state), self.assertLogs("mozarie.core", "WARNING") as failed_logs:
            failed.do_POST()
        failure_log = "\n".join(failed_logs.output)
        self.assertIn("操作失敗: 画像状態変更 [/api/workspace/image] status=400 error_code=input_invalid 所要=", failure_log)
        for secret in (secret_id, secret_body, secret_header):
            self.assertNotIn(secret, success_log)
            self.assertNotIn(secret, failure_log)

    def test_per_image_success_logs_are_suppressed_but_failures_are_safe_warnings(self) -> None:
        secret = "save-token-and-body-secret"
        for path in ("/api/import/file", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"):
            operation = http_module._operation_log_spec("POST", path)
            self.assertIsNotNone(operation)
            with self.assertNoLogs("mozarie.core", "INFO"):
                started = http_module._log_operation_started(operation, path, {"token": secret, "body": secret})
                http_module._log_operation_finished(operation, started)
            with self.assertLogs("mozarie.core", "WARNING") as warning_logs:
                http_module._log_operation_failed(operation, started, HTTPStatus.BAD_REQUEST, ClientError(secret, "input_invalid"))
            warning = "\n".join(warning_logs.output)
            self.assertIn("status=400 error_code=input_invalid", warning)
            self.assertNotIn(secret, warning)

    def test_dynamic_mutation_routes_log_normalized_success_and_failure_without_ids(self) -> None:
        secret = "candidate-and-workspace-secret"
        routes = [
            ("POST", f"/api/candidate/{secret}/{secret}", "候補変更", "/api/candidate"),
            ("DELETE", f"/api/candidate/{secret}/{secret}", "候補削除", "/api/candidate"),
            ("DELETE", f"/api/workspace/manual/{secret}", "手描き範囲削除", "/api/workspace/manual"),
            ("POST", f"/api/workspace/manual/{secret}/cancel", "手描きマスク一時転送を破棄", "/api/workspace/manual/cancel"),
            ("POST", "/api/workspace/recreate", "作業データ再作成", "/api/workspace/recreate"),
        ]
        for method, path, label, route in routes:
            operation = http_module._operation_log_spec(method, path)
            self.assertEqual(operation, (label, route))
            with self.assertLogs("mozarie.core", "INFO") as completed_logs:
                started = http_module._log_operation_started(operation, path, {"token": secret, "body": secret})
                http_module._log_operation_finished(operation, started)
            with self.assertLogs("mozarie.core", "WARNING") as failed_logs:
                http_module._log_operation_failed(operation, started, HTTPStatus.BAD_REQUEST, ClientError(secret, "input_invalid"))
            for log in ("\n".join(completed_logs.output), "\n".join(failed_logs.output)):
                self.assertIn(f"[{route}]", log)
                self.assertNotIn(secret, log)
