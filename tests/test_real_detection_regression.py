from __future__ import annotations

import ctypes
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "real_detection_regression.py"
SPEC = importlib.util.spec_from_file_location("real_detection_regression", SOURCE)
assert SPEC is not None and SPEC.loader is not None
real_detection_regression = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = real_detection_regression
SPEC.loader.exec_module(real_detection_regression)


class _FakeFunction:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *args):
        return self.callback(*args)


class RealDetectionRegressionTests(unittest.TestCase):
    def _fake_libraries(self, *, succeeds: bool):
        handle = 0x1234567887654321
        seen: dict[str, object] = {}

        def get_current_process():
            return handle

        def get_process_memory_info(process_handle, counters_pointer, cb):
            seen["handle"] = process_handle
            seen["cb"] = cb
            if not succeeds:
                return 0
            counters = ctypes.cast(
                counters_pointer,
                ctypes.POINTER(real_detection_regression._ProcessMemoryCountersEx),
            ).contents
            counters.PrivateUsage = 123_456
            counters.WorkingSetSize = 654_321
            return 1

        kernel32 = type("Kernel32", (), {"GetCurrentProcess": _FakeFunction(get_current_process)})()
        psapi = type("Psapi", (), {"GetProcessMemoryInfo": _FakeFunction(get_process_memory_info)})()
        loads: list[tuple[str, bool]] = []

        def win_dll(name, *, use_last_error):
            loads.append((name, use_last_error))
            return {"kernel32": kernel32, "psapi": psapi}[name]

        return win_dll, kernel32.GetCurrentProcess, psapi.GetProcessMemoryInfo, loads, seen, handle

    def test_process_memory_probe_declares_winapi_signatures_and_preserves_handle_width(self) -> None:
        win_dll, get_current_process, get_process_memory_info, loads, seen, handle = self._fake_libraries(succeeds=True)
        with patch.object(real_detection_regression.os, "name", "nt"), \
                patch.object(real_detection_regression.ctypes, "WinDLL", win_dll, create=True):
            self.assertEqual(real_detection_regression._process_memory_bytes(), (123_456, 654_321))

        self.assertEqual(loads, [("kernel32", True), ("psapi", True)])
        self.assertEqual(get_current_process.argtypes, [])
        self.assertIs(get_current_process.restype, real_detection_regression.wintypes.HANDLE)
        self.assertEqual(
            get_process_memory_info.argtypes,
            [
                real_detection_regression.wintypes.HANDLE,
                ctypes.POINTER(real_detection_regression._ProcessMemoryCountersEx),
                real_detection_regression.wintypes.DWORD,
            ],
        )
        self.assertIs(get_process_memory_info.restype, real_detection_regression.wintypes.BOOL)
        self.assertEqual(seen["handle"], handle)
        self.assertEqual(seen["cb"], ctypes.sizeof(real_detection_regression._ProcessMemoryCountersEx))

    def test_process_memory_probe_uses_the_windows_error_code(self) -> None:
        win_dll, _get_current_process, _get_process_memory_info, _loads, _seen, _handle = self._fake_libraries(succeeds=False)
        win_error = Mock(side_effect=OSError)
        with patch.object(real_detection_regression.os, "name", "nt"), \
                patch.object(real_detection_regression.ctypes, "WinDLL", win_dll, create=True), \
                patch.object(real_detection_regression.ctypes, "get_last_error", return_value=6, create=True), \
                patch.object(real_detection_regression.ctypes, "WinError", win_error, create=True):
            with self.assertRaises(OSError):
                real_detection_regression._process_memory_bytes()
        win_error.assert_called_once_with(6)

    def test_process_memory_counter_layout_uses_fixed_width_windows_fields(self) -> None:
        counters = real_detection_regression._ProcessMemoryCountersEx
        self.assertIs(counters._fields_[0][1], ctypes.c_uint32)
        self.assertIs(counters._fields_[1][1], ctypes.c_uint32)
        self.assertIs(counters._fields_[-1][1], ctypes.c_size_t)
        pointer_size = ctypes.sizeof(ctypes.c_size_t)
        self.assertEqual(ctypes.sizeof(counters), 8 + 9 * pointer_size)
        self.assertEqual(counters.WorkingSetSize.offset, 8 + pointer_size)
        self.assertEqual(counters.PrivateUsage.offset, 8 + 8 * pointer_size)

    def test_settled_private_bytes_ignores_warmup_and_rejects_only_sustained_growth(self) -> None:
        baseline = 1_000_000_000
        limit = real_detection_regression.PRIVATE_BYTES_GROWTH_LIMIT
        cases = (
            (
                "minor_monotonic_growth",
                [(0, 0), (baseline, 1), (baseline + 10, 2), (baseline + 20, 3), (baseline + 30, 4)],
                False,
            ),
            (
                "recovered_spike",
                [(0, 0), (baseline, 1), (baseline, 2), (baseline + limit * 2, 3), (baseline, 4)],
                False,
            ),
            (
                "sustained_growth",
                [(0, 0), (baseline, 1), (baseline, 2), (baseline + limit + 1, 3), (baseline + limit + 1, 4)],
                True,
            ),
        )
        for name, samples, should_fail in cases:
            with self.subTest(name=name):
                early, late = real_detection_regression._settled_private_bytes_averages(samples)
                self.assertEqual((late - early) > limit, should_fail)
        early, late = real_detection_regression._settled_private_bytes_averages(
            [(999 * limit, 0), (baseline, 1), (baseline, 2), (baseline, 3), (baseline, 4)]
        )
        self.assertEqual((early, late), (float(baseline), float(baseline)))

    def test_settled_private_bytes_requires_all_five_samples(self) -> None:
        with self.assertRaisesRegex(ValueError, "expected 5 memory samples"):
            real_detection_regression._settled_private_bytes_averages([])

    def test_cowgirl_fluid_contract_and_generic_nonfluid_guard(self) -> None:
        cowgirl = real_detection_regression.SAMPLES["Scene_cowgirl_00023.png"]
        self.assertEqual(cowgirl["candidates"]["fluid"], ("exclude", "fluid_exclusion", False))
        self.assertEqual(cowgirl["fluid_area"], (1, None))
        self.assertEqual(
            cowgirl["negative_regions"],
            (
                ("breasts", (150, 400, 750, 800)),
                ("upper-torso", (250, 800, 650, 1_050)),
                ("far-thigh-background", (0, 900, 170, 1_250)),
            ),
        )

        def candidate(label: str, role: str, source: str, forced: bool):
            return types.SimpleNamespace(
                label_token=label,
                role=types.SimpleNamespace(value=role),
                source=source,
                forced=forced,
                mask_path=Path("unused-mask.png"),
            )

        cowgirl_candidates = [
            candidate("penis", "apply", "target", True),
            candidate("pussy", "apply", "target", True),
            candidate("fluid", "exclude", "fluid_exclusion", False),
        ]
        with patch.object(real_detection_regression, "_mask_metrics", return_value=(1, (200, 500, 300, 600))), \
                patch.object(real_detection_regression, "_region_rate", return_value=0.0):
            lines = real_detection_regression._assert_scene("Scene_cowgirl_00023.png", cowgirl_candidates)
        self.assertIn("  fluid: area=1, bbox=(200, 500, 300, 600)", lines)

        with patch.dict(
            real_detection_regression.SAMPLES,
            {"nonfluid": {"candidates": {"penis": ("apply", "target", True)}}},
        ), patch.object(real_detection_regression, "_mask_metrics", return_value=(1, (0, 0, 1, 1))):
            real_detection_regression._assert_scene(
                "nonfluid", [candidate("penis", "apply", "target", True)]
            )

    def _run_main_with_gpu_samples(self, settled_samples: list[tuple[int, int]]):
        class FakeCuda:
            def __init__(self):
                self._samples = iter([settled_samples[0], *settled_samples])
                self._pending: tuple[int, int] | None = None
                self.synchronized: list[int] = []

            def synchronize(self, device: int) -> None:
                self.synchronized.append(device)

            def memory_allocated(self, _device: int) -> int:
                self._pending = next(self._samples)
                return self._pending[0]

            def memory_reserved(self, _device: int) -> int:
                assert self._pending is not None
                return self._pending[1]

        instances = []

        class FakeState:
            def __init__(self, **_kwargs):
                self.settings_store = types.SimpleNamespace(
                    validate_update=lambda _settings: {"models": {"gpu_device": 7}, "detection": {}}
                )
                self.settings = {}
                self.required = 0
                self.shutdowns = 0
                instances.append(self)

            def _require_supported_gpu(self) -> None:
                self.required += 1

            def _release_gpu_job_memory(self) -> None:
                pass

            def shutdown(self) -> None:
                self.shutdowns += 1

        cuda = FakeCuda()
        with tempfile.TemporaryDirectory() as temporary:
            settings_file = Path(temporary) / "settings.json"
            settings_file.write_text("{}", encoding="utf-8")
            with patch.object(real_detection_regression, "StudioState", FakeState), \
                    patch.object(real_detection_regression, "_run_cycle", return_value=[]), \
                    patch.object(real_detection_regression, "_process_memory_bytes", return_value=(1_000_000, 2_000_000)), \
                    patch.object(sys, "argv", [str(SOURCE), "--settings-file", str(settings_file)]), \
                    patch.dict(sys.modules, {"torch": types.SimpleNamespace(cuda=cuda)}):
                result = real_detection_regression.main()
        return result, cuda, instances

    def test_gpu_cleanup_samples_all_cycles_and_rejects_growth(self) -> None:
        result, cuda, states = self._run_main_with_gpu_samples([(10, 20)] * 5)
        self.assertEqual(result, 0)
        self.assertEqual(cuda.synchronized, [7] * 6)
        self.assertEqual(states[0].required, 1)
        self.assertEqual(states[0].shutdowns, 1)

        with self.assertRaisesRegex(RuntimeError, "GPU memory grew across cleanup cycles"):
            self._run_main_with_gpu_samples([(10, 20), (10, 20), (11, 20), (11, 20), (11, 20)])

    @unittest.skipUnless(os.name == "nt", "requires Windows")
    def test_real_process_memory_probe_returns_positive_private_bytes_and_rss(self) -> None:
        private_bytes, rss_bytes = real_detection_regression._process_memory_bytes()
        self.assertGreater(private_bytes, 0)
        self.assertGreater(rss_bytes, 0)


if __name__ == "__main__":
    unittest.main()
