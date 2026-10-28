"""Errors remain diagnosable in the terminal without changing catalogue state."""

import json
import unittest
from unittest.mock import patch

from mozarie import http as http_module
from mozarie.core import ClientError
from tests import test_settings_import_regressions


class ErrorLoggingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_settings_import_regressions.SettingsImportRegressionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_browser_error_logs_display_and_original_exception_without_catalog_generation(self):
        payload = {"code": "save_write_failed", "message": "disk write failed\r\nsecond line",
                   "displayedCause": "保存先または元画像へ書き込めません。",
                   "action": "空き容量と書込権限を確認して再試行してください。",
                   "cause": {"name": "NotAllowedError", "message": "Permission denied", "stack": "at writer"},
                   "token": "must not be logged", "imageId": "image-1", "saveMode": "overwrite"}
        generation = self.fixture.state.catalog_generation
        with self.assertLogs(http_module.LOGGER.name, "ERROR") as logs:
            status, response = self.fixture.request("/api/client-error", payload, headers={
                "X-Mozarie-Expected-Catalog-Generation": "obsolete", "X-Mozarie-Expected-Project-Id": "old"})
        self.assertEqual((status, response), (200, {"ok": True}))
        self.assertEqual(self.fixture.state.catalog_generation, generation)
        entry = logs.records[0].getMessage()
        self.assertNotIn("\n", entry)
        details = json.loads(entry.split(": ", 1)[1])
        self.assertEqual(details["message"], payload["message"])
        self.assertEqual(details["cause"], payload["cause"])
        self.assertEqual(details["displayedCause"], payload["displayedCause"])
        self.assertNotIn("must not be logged", entry)

    def test_browser_error_requires_same_origin_token_and_string_fields(self):
        for headers in ({"Origin": "http://untrusted.invalid"}, {"X-Mozarie-Token": "wrong"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.fixture.request("/api/client-error", {"message": "forged"}, headers=headers)[0], 403)
        self.assertEqual(self.fixture.request("/api/client-error", {"message": []})[0], 400)
        self.assertEqual(self.fixture.request("/api/client-error", {"cause": "bad"})[0], 400)

    def test_http_save_failure_logs_original_message_and_os_cause(self):
        try:
            raise PermissionError("fixture access denied")
        except PermissionError as cause:
            try:
                raise ClientError("保存用の一時ファイルへ書き込めませんでした。", "save_write_failed") from cause
            except ClientError as error:
                failure = error
        with patch.object(self.fixture.state, "output_directory_status", side_effect=failure):
            with self.assertLogs(http_module.LOGGER.name, "WARNING") as logs:
                status, response = self.fixture.request("/api/output-directory/status", {})
        self.assertEqual(status, 400)
        self.assertEqual(response["error_code"], "save_write_failed")
        self.assertIn("保存用の一時ファイルへ書き込めませんでした。", "\n".join(logs.output))
        self.assertIn("PermissionError: fixture access denied", "\n".join(logs.output))
