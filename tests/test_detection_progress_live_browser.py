"""Real job/HTTP/browser progress with CPU-only model boundary barriers."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class LiveDetectionProgressBrowserTests(unittest.TestCase):
    def test_real_model_loading_pause_inference_completion_error_and_cancel_are_visible(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"
            shutil.copytree(repository / "config", app / "config")
            source = root / "source"
            source.mkdir()
            Image.new("RGB", (16, 12), "white").save(source / "progress.png")
            model = root / "fixture.onnx"
            model.write_bytes(b"external model boundary fixture")
            gates = {name: threading.Event() for name in ("runtime", "target", "inference", "hand")}
            target_entered = threading.Event()
            fail_load = False
            target_loads = 0

            def wait_gate(name: str) -> None:
                if not gates[name].wait(30):
                    raise RuntimeError(f"browser did not release {name}")

            class Target:
                def detect(self, *_args):
                    wait_gate("inference")
                    return []

            class Hand:
                def detect_boxes(self, *_args):
                    return []

            def target_factory(*_args, **_kwargs):
                nonlocal target_loads
                target_loads += 1
                target_entered.set()
                wait_gate("target")
                if fail_load:
                    raise RuntimeError("fixture model load failed")
                return Target()

            def hand_factory(*_args, **_kwargs):
                wait_gate("hand")
                return Hand()

            def runtime_backend(*_args, **_kwargs):
                wait_gate("runtime")
                return "cpu"

            with patch.object(state_module, "APP_DIR", app):
                state = StudioState(root / "cache", root / "sessions")
                state.settings["models"].update({
                    "provider": "cpu", "target_segmentation": str(model),
                    "ntd11_enabled": False, "sensitive_enabled": False,
                    "hand_detection": str(model), "hand_detection_enabled": True,
                    "hand_segmentation_enabled": False,
                })
                state.settings["detection"]["mode"] = "standard"
                state.set_root(str(source))

                class Handler(MosaicHandler):
                    def do_GET(self):
                        nonlocal fail_load
                        if self.path.startswith("/__fixture__/"):
                            action = self.path.rsplit("/", 1)[-1]
                            if action in gates:
                                gates[action].set()
                                if action == "runtime" and not target_entered.wait(10):
                                    raise RuntimeError("target constructor did not start")
                            elif action in {"reset-error", "reset-cancel"}:
                                state.worker_thread.join(10)
                                if state.worker_thread.is_alive():
                                    raise RuntimeError("previous detector did not finish")
                                state.models = None
                                fail_load = action == "reset-error"
                                gates["target"].clear()
                            else:
                                raise AssertionError(action)
                            self._json({"ok": True})
                            return
                        super().do_GET()

                server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                try:
                    with patch.object(http_module, "STATE", state), \
                         patch("mozarie.detection.TargetSegmenter", side_effect=target_factory), \
                         patch("mozarie.detection.runtime_backend", side_effect=runtime_backend), \
                         patch("mozarie.detection.HandDetector", side_effect=hand_factory):
                        thread.start()
                        result = subprocess.run(
                            ["node", str(repository / "tests" / "detection_progress_live_browser_helper.cjs"), f"http://127.0.0.1:{server.server_port}"],
                            cwd=repository, env={**os.environ, "PYTHONUTF8": "1"},
                            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=90,
                        )
                        self.assertEqual(result.returncode, 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
                        self.assertEqual(target_loads, 3, "cached CPU models must avoid a second constructor")
                        self.assertEqual(state.job.preparing_models, 0)
                finally:
                    for gate in gates.values():
                        gate.set()
                    if state.worker_thread:
                        state.worker_thread.join(10)
                    server.shutdown()
                    server.server_close()
                    thread.join(5)
                    state.shutdown()


if __name__ == "__main__":
    unittest.main()
