"""An invalid update must leave the running app available for a retry."""
import hashlib
import io
import json
from pathlib import Path
from unittest.mock import patch
import unittest
import zipfile

from mozarie import http as http_module
from tests.saving import test_native_save_transfer as native_fixture
from tests.test_updater import UPDATE_ARCHIVE_CONTENTS, Response, make_release


class UpdatePreparationTests(unittest.TestCase):
    def test_invalid_downloads_leave_server_running_and_next_request_can_update(self):
        fixture = native_fixture.NativeSaveTransferTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        self.addCleanup(setattr, http_module, "_update_start_requested", False)
        http_module._update_start_requested = False
        for failure in ("network", "digest", "layout", "version", None):
            with self.subTest(failure=failure):
                contents = dict(UPDATE_ARCHIVE_CONTENTS)
                if failure == "layout":
                    contents = {name.removeprefix("wrapper/"): data for name, data in contents.items()}
                if failure == "version":
                    contents["wrapper/VERSION"] = "1.1.9"
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as archive:
                    for name, data in contents.items():
                        archive.writestr(name, data)
                payload = buffer.getvalue()
                release = make_release()
                release["assets"][0].update(size=len(payload), digest="sha256:" + hashlib.sha256(payload).hexdigest())
                if failure == "digest":
                    release["assets"][0]["digest"] = "sha256:" + "0" * 64

                def network(request, **_kwargs):
                    if failure == "network":
                        raise OSError("offline")
                    url = getattr(request, "full_url", request)
                    return Response(json.dumps(release).encode() if "api.github.com" in url else payload)

                with patch("updater.urllib.request.urlopen", side_effect=network):
                    _, response = fixture.request("/api/update/start", {}, expected_status=200 if failure is None else 400)
                if failure is not None:
                    self.assertEqual(json.loads(response)["error_code"], "update_preparation_failed")
                    self.assertFalse(http_module._update_start_requested)
                    self.assertFalse(getattr(fixture.server, "mozarie_update_requested", False))
                    self.assertTrue(fixture.thread.is_alive())
                    fixture.request("/api/settings?status=0", {})
                else:
                    temporary = fixture.server.mozarie_update_workspace
                    self.addCleanup(temporary.cleanup)
                    self.assertTrue(Path(fixture.server.mozarie_update_source, "server.py").is_file())
                    fixture.thread.join(5)
                    self.assertFalse(fixture.thread.is_alive())
                    self.assertTrue(fixture.server.mozarie_update_requested)
