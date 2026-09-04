"""GPU-free checks for the opt-in real-image regression runner."""

from __future__ import annotations

import importlib.util
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "real_detection_regression.py"
SPEC = importlib.util.spec_from_file_location("real_detection_regression", SCRIPT_PATH)
assert SPEC and SPEC.loader
real_detection_regression = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(real_detection_regression)


class RealDetectionRegressionTests(unittest.TestCase):
    def test_memory_soak_accepts_settled_noise_but_rejects_growth_and_large_delta(self) -> None:
        steady = [(100, 200), (120, 220), (125, 226), (123, 224), (124, 225)]
        real_detection_regression._assert_process_memory_soak(steady)

        with self.assertRaisesRegex(RuntimeError, "grew after every cleanup"):
            real_detection_regression._assert_process_memory_soak([(100, 200), (120, 220), (121, 221), (122, 222)])
        too_large = real_detection_regression.MAX_SETTLED_PROCESS_MEMORY_DELTA
        with self.assertRaisesRegex(RuntimeError, "varied by more than"):
            real_detection_regression._assert_process_memory_soak([(100, 200), (100, 200), (100 + too_large + 1, 200), (100, 200)])
        with self.assertRaisesRegex(ValueError, "at least four"):
            real_detection_regression._assert_process_memory_soak([(1, 1), (1, 1), (1, 1)])

    def test_windows_process_memory_reads_private_and_working_set_without_gpu(self) -> None:
        def memory_info(_handle, counters, _size):
            counters._obj.PrivateUsage = 1234
            counters._obj.WorkingSetSize = 5678
            return 1

        fake_windll = types.SimpleNamespace(
            kernel32=types.SimpleNamespace(GetCurrentProcess=lambda: 1),
            psapi=types.SimpleNamespace(GetProcessMemoryInfo=memory_info),
        )
        with patch.object(real_detection_regression, "os", types.SimpleNamespace(name="nt")), \
             patch.object(real_detection_regression.ctypes, "windll", fake_windll, create=True):
            self.assertEqual(real_detection_regression._process_memory_bytes(), (1234, 5678))

    def test_process_memory_sampling_is_explicitly_windows_only(self) -> None:
        with patch.object(real_detection_regression, "os", types.SimpleNamespace(name="posix")):
            with self.assertRaisesRegex(RuntimeError, "requires Windows"):
                real_detection_regression._process_memory_bytes()


if __name__ == "__main__":
    unittest.main()
