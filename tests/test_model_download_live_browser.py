"""Download dialog ownership through real HTTP and the real download worker."""

from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from tests import prepare_test_app_config
import mozarie.http as http_module
import mozarie.model_downloads as downloads
import mozarie.state as state_module


class LiveModelDownloadBrowserTests(unittest.TestCase):
    def run_download(self, mode: str) -> None:
        repository = Path(__file__).resolve().parents[1]
        closed = threading.Event()

        class Response:
            status = 200
            headers = {"Content-Length": "4"}

            def geturl(self): return "https://example.invalid/synthetic"
            def __enter__(self): return self
            def __exit__(self, *_args): self.close()
            def close(self): closed.set()

            def read(self, _size):
                if not closed.wait(40):
                    raise AssertionError("the browser did not cancel the transfer")
                raise OSError("synthetic transport closed")

        class Opener:
            calls = 0

            def open(self, *_args, **_kwargs):
                self.calls += 1
                return Response()

        opener = Opener()
        entry = downloads.ModelDownload(
            "sam_vit_b", "sam_vit_b", "https://example.invalid/synthetic",
            "models/synthetic.bin", 4, hashlib.sha256(b"test").hexdigest(),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            app = root / "app"
            prepare_test_app_config(app)
            with patch.object(state_module, "APP_DIR", app), \
                 patch.dict(downloads.MODEL_DOWNLOADS, {"sam_vit_b": entry}), \
                 patch.object(downloads, "build_opener", return_value=opener):
                state = state_module.StudioState(root / "cache", root / "sessions")
                state.settings["models"]["provider"] = "cpu"
                with patch.object(http_module, "STATE", state):
                    server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), http_module.MosaicHandler)
                    thread = threading.Thread(target=server.serve_forever)
                    thread.start()
                    try:
                        result = subprocess.run(
                            ["node", str(repository / "tests/settings/model_download_live_browser_helper.cjs"),
                             f"http://127.0.0.1:{server.server_port}", mode],
                            cwd=repository, capture_output=True, text=True, encoding="utf-8", timeout=45,
                        )
                        self.assertEqual(result.returncode, 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
                        self.assertEqual(opener.calls, 1, "reconnecting must not start a second transfer")
                        self.assertTrue(closed.is_set(), "cancellation closes the active external response")
                        self.assertEqual(state.model_downloads.snapshot()["state"], "cancelled")
                        self.assertFalse(entry.destination(app).exists())
                    finally:
                        state.model_downloads.cancel()
                        closed.set()
                        state.begin_shutdown()
                        server.shutdown()
                        server.server_close()
                        thread.join()
                        state.shutdown()

    def test_pending_start_retains_progress_and_cancellation(self) -> None:
        self.run_download("pending")

    def test_reload_recovers_the_existing_download_and_cancels_it(self) -> None:
        self.run_download("reload")

    def test_lost_start_response_recovers_the_existing_download_on_retry(self) -> None:
        self.run_download("lost-response")
