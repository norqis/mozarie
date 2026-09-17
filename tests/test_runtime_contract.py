from __future__ import annotations

import unittest
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.http import health_device
from mozarie.runtime import onnx_execution_status


class RuntimeContractTests(unittest.TestCase):
    def test_release_archive_excludes_development_only_files(self):
        root = Path(__file__).resolve().parents[1]
        attributes = (root / ".gitattributes").read_text(encoding="utf-8")
        for path in ("/.github export-ignore", "/.coveragerc export-ignore", "/tests export-ignore", "/scripts export-ignore", "/site export-ignore", "/package.json export-ignore", "/package-lock.json export-ignore", "/requirements-test.txt export-ignore"):
            self.assertIn(path, attributes)
        self.assertIn("output/", (root / ".gitignore").read_text(encoding="utf-8"))

    def test_health_cpu_does_not_expose_or_need_a_gpu(self):
        self.assertEqual(health_device("cpu", 7, []), {"provider": "cpu", "runtimeBackend": "cpu", "gpuDevice": None, "device": "CPU"})

    def test_health_uses_the_selected_gpu_index(self):
        self.assertEqual(
            health_device("gpu", 1, [{"id": 0, "name": "first"}, {"id": 1, "name": "second"}]),
            {"provider": "gpu", "runtimeBackend": "cpu", "runtimeReady": True, "gpuDevice": 1, "gpuName": "second", "device": "GPU 1: second"},
        )

    def test_onnx_status_does_not_treat_cuda_torch_as_a_cuda_execution_provider(self):
        cpu_only = type("Ort", (), {"get_available_providers": staticmethod(lambda: ["CPUExecutionProvider"])})
        with patch.dict("os.environ", {"MOZARIE_RUNTIME": "cuda"}, clear=True):
            self.assertEqual(onnx_execution_status(ort_module=cpu_only), ("cuda", False))


if __name__ == "__main__":
    unittest.main()
