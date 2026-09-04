import contextlib
import inspect
import io
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_gpu_check


class SetupGpuCheckTests(unittest.TestCase):
    def run_check(self, *, profile="cuda", cuda=True, providers=("CUDAExecutionProvider",), session=None, cpu_session=None, save_error=None):
        options = SimpleNamespace(add_session_config_entry=Mock())
        session = session if session is not None else SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CUDAExecutionProvider"],
            run=lambda *_args: None,
        )
        cpu_session = cpu_session if cpu_session is not None else SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CPUExecutionProvider"],
            run=lambda *_args: None,
        )
        store = SimpleNamespace(save=Mock(side_effect=save_error), load=Mock(return_value={"models": {"gpu_device": 0}}))
        tensor = Mock(); tensor.add_.return_value = tensor; tensor.cpu.return_value = tensor
        runtime = (
            SimpleNamespace(ones=Mock(return_value=object()), float32=object()),
            SimpleNamespace(
                get_available_providers=lambda: providers,
                SessionOptions=lambda: options,
                InferenceSession=lambda *_args, providers, **_kwargs: session if providers == ["CUDAExecutionProvider"] else cpu_session,
            ),
            SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: cuda, device_count=lambda: 1), ones=Mock(return_value=tensor)),
            SimpleNamespace(get_example=lambda _name: "model.onnx"),
        )
        output = io.StringIO()
        with patch.object(setup_gpu_check, "_runtime_modules", return_value=runtime), \
             patch.object(setup_gpu_check, "selected_profile", return_value=profile), \
             patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             contextlib.redirect_stdout(output):
            result = setup_gpu_check.main()
        return result, store, output.getvalue()

    def test_cuda_unavailable_stops_without_changing_the_provider(self):
        result, store, output = self.run_check(cuda=False)
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CUDA detection runtime could not start", output)

    def test_missing_execution_provider_stops_without_changing_the_provider(self):
        result, store, output = self.run_check(providers=("CPUExecutionProvider",))
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CUDA detection runtime could not start", output)

    def test_session_failure_stops_without_changing_the_provider(self):
        result, store, output = self.run_check(session=SimpleNamespace(
            disable_fallback=lambda: None, get_providers=lambda: ["CUDAExecutionProvider"],
            run=lambda *_args: (_ for _ in ()).throw(RuntimeError("session failed")),
        ))
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CUDA detection runtime could not start", output)

    def test_gpu_provider_fallback_stops_without_changing_the_provider(self):
        wrong_provider = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CPUExecutionProvider"],
            run=lambda *_args: None,
        )
        result, store, output = self.run_check(session=wrong_provider)
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CUDA detection runtime could not start", output)

    def test_runtime_import_failure_stops_without_changing_the_provider(self):
        store = SimpleNamespace(save=Mock(), load=Mock(return_value={"models": {"gpu_device": 0}}))
        output = io.StringIO()
        with patch.object(setup_gpu_check, "_runtime_modules", side_effect=ImportError("DLL load failed")), \
             patch.object(setup_gpu_check, "selected_profile", return_value="cuda"), \
             patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             contextlib.redirect_stdout(output):
            result = setup_gpu_check.main()
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("Required packages could not be loaded", output.getvalue())

    def test_settings_failure_has_its_own_recovery_message(self):
        store = SimpleNamespace(save=Mock(), load=Mock(side_effect=ValueError("bad settings")))
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), contextlib.redirect_stdout(output):
            result = setup_gpu_check.main()
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("Settings could not be read", output.getvalue())

    def test_cpu_smoke_failure_stops_without_changing_the_provider(self):
        failed_cpu = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CPUExecutionProvider"],
            run=lambda *_args: (_ for _ in ()).throw(RuntimeError("session failed")),
        )
        result, store, output = self.run_check(profile="cpu", cpu_session=failed_cpu)
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CPU detection runtime could not start", output)

    def test_cpu_provider_fallback_is_not_accepted(self):
        wrong_provider = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CUDAExecutionProvider"],
            run=lambda *_args: None,
        )
        result, store, output = self.run_check(profile="cpu", cpu_session=wrong_provider)
        self.assertEqual(result, 1)
        store.save.assert_not_called()
        self.assertIn("CPU detection runtime could not start", output)

    def test_gpu_success_keeps_existing_provider(self):
        result, store, output = self.run_check()
        self.assertEqual(result, 0)
        self.assertEqual(output.strip(), "[Mozarie] GPU is ready.")
        # A successful smoke test does not touch an existing CPU selection.
        store.save.assert_not_called()

    def test_cuda_probe_uses_strict_session_options_and_never_registers_cpu(self):
        tensor = Mock(); tensor.add_.return_value = tensor; tensor.cpu.return_value = tensor
        options = SimpleNamespace(add_session_config_entry=Mock())
        session = SimpleNamespace(disable_fallback=Mock(), get_providers=lambda: ["CUDAExecutionProvider"], run=lambda *_args: None)
        ort = SimpleNamespace(
            get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
            SessionOptions=lambda: options,
            InferenceSession=Mock(return_value=session),
        )
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1), ones=Mock(return_value=tensor))
        self.assertTrue(setup_gpu_check._gpu_is_ready(SimpleNamespace(ones=lambda *_args, **_kwargs: object(), float32=object()), ort, torch, SimpleNamespace(get_example=lambda _name: "model.onnx"), 0))
        options.add_session_config_entry.assert_called_once_with("session.disable_cpu_ep_fallback", "1")
        self.assertEqual(ort.InferenceSession.call_args.kwargs["providers"], ["CUDAExecutionProvider"])
        session.disable_fallback.assert_called_once_with()

    def test_directml_validates_the_configured_device_without_switching_provider(self):
        store = SimpleNamespace(save=Mock(), load=Mock(return_value={"models": {"gpu_device": 1}}))
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="directml"), \
             patch.object(setup_gpu_check, "validate") as validate, \
             contextlib.redirect_stdout(output):
            result = setup_gpu_check.main()
        self.assertEqual(result, 0)
        validate.assert_called_once_with("directml", 1)
        store.save.assert_not_called()
        self.assertIn("DirectML GPU 1 is ready", output.getvalue())

    def test_directml_probe_failure_stops_without_changing_the_provider(self):
        store = SimpleNamespace(save=Mock(), load=Mock(return_value={"models": {"gpu_device": 1}}))
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="directml"), \
             patch.object(setup_gpu_check, "validate", side_effect=RuntimeError("DirectML failed")):
            self.assertEqual(setup_gpu_check.main(), 1)
        store.save.assert_not_called()

    def test_cpu_profile_verifies_cpu_runtime_without_a_gpu_probe(self):
        store = SimpleNamespace(save=Mock(), load=Mock(return_value={"models": {"gpu_device": 0}}))
        gpu_ready = Mock()
        cpu_ready = Mock(return_value=True)
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="cpu"), \
             patch.object(setup_gpu_check, "_runtime_modules", return_value=(object(), object(), object(), object())) as runtime_modules, \
             patch.object(setup_gpu_check, "_gpu_is_ready", gpu_ready), \
             patch.object(setup_gpu_check, "_cpu_is_ready", cpu_ready):
            self.assertEqual(setup_gpu_check.main(), 0)
        runtime_modules.assert_called_once()
        cpu_ready.assert_called_once()
        gpu_ready.assert_not_called()
        store.save.assert_called_once_with({"models": {"provider": "cpu"}})

    def test_cpu_profile_save_failure_stops_setup(self):
        result, _store, output = self.run_check(profile="cpu", save_error=OSError("locked"))
        self.assertEqual(result, 1)
        self.assertIn("could not be saved", output)

    def test_missing_profile_stops_without_running_a_runtime_probe(self):
        store = SimpleNamespace(save=Mock(), load=Mock(return_value={"models": {"gpu_device": 0}}))
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value=None), \
             patch.object(setup_gpu_check, "_runtime_modules") as runtime_modules, \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 1)
        runtime_modules.assert_not_called()
        store.save.assert_not_called()
        self.assertIn("selected runtime could not be identified", output.getvalue())

    def test_gpu_probe_rejects_a_negative_device_before_creating_a_tensor(self):
        torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1),
            ones=Mock(),
        )
        ort = SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        self.assertFalse(setup_gpu_check._gpu_is_ready(object(), ort, torch, object(), -1))
        torch.ones.assert_not_called()

    def test_gpu_probe_suppresses_only_the_two_known_enumeration_warnings(self):
        tensor = Mock(); tensor.add_.return_value = tensor; tensor.cpu.return_value = tensor
        torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1),
            ones=Mock(return_value=tensor),
        )
        session = SimpleNamespace(disable_fallback=lambda: None, get_providers=lambda: ["CUDAExecutionProvider"], run=lambda *_args: None)
        ort = SimpleNamespace(
            get_available_providers=lambda: ["CUDAExecutionProvider"],
            SessionOptions=lambda: SimpleNamespace(add_session_config_entry=lambda *_args: None),
            InferenceSession=lambda *_args, **_kwargs: session,
        )
        with patch.object(setup_gpu_check.warnings, "filterwarnings") as filter_warnings:
            self.assertTrue(setup_gpu_check._gpu_is_ready(SimpleNamespace(ones=lambda *_args, **_kwargs: object(), float32=object()), ort, torch, SimpleNamespace(get_example=lambda _name: "model.onnx"), 0))
        self.assertEqual(filter_warnings.call_args_list, [
            call("ignore", category=UserWarning, message=r"\s*Found GPU\d+"),
            call("ignore", category=UserWarning, message=r"\s*NVIDIA .* with CUDA capability sm_\d+ is not compatible with the current PyTorch installation"),
        ])

    def test_runtime_module_loader_imports_torch_before_onnxruntime(self):
        source = inspect.getsource(setup_gpu_check._runtime_modules)
        self.assertLess(source.index("import torch"), source.index("import onnxruntime as ort"))

    @unittest.skipUnless(os.name == "nt", "requires Windows GPU runtime")
    def test_real_cuda_setup_subprocess_is_quiet_when_cuda_runtime_is_available(self):
        try:
            _np, ort, torch, _datasets = setup_gpu_check._runtime_modules()
        except Exception as exc:
            self.skipTest(f"runtime packages unavailable: {exc}")
        if not torch.cuda.is_available() or "CUDAExecutionProvider" not in ort.get_available_providers():
            self.skipTest("CUDA runtime unavailable")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / "setup_gpu_check.py")],
            capture_output=True, text=True, check=False, timeout=60, env={**os.environ, "MOZARIE_RUNTIME": "cuda"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "[Mozarie] GPU is ready.")
        self.assertEqual(result.stderr, "")

    def test_runtime_module_loader_returns_the_installed_runtime_modules(self):
        fake_numpy = object()
        fake_ort = SimpleNamespace(datasets=object())
        fake_torch = object()
        with patch.dict(sys.modules, {"numpy": fake_numpy, "onnxruntime": fake_ort, "torch": fake_torch}):
            self.assertEqual(setup_gpu_check._runtime_modules(), (fake_numpy, fake_ort, fake_torch, fake_ort.datasets))

    def test_script_entrypoint_exits_with_the_same_failure_status_as_main(self):
        with patch("mozarie.runtime_profile.selected_profile", return_value=None), \
             self.assertRaises(SystemExit) as exited, contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(Path(__file__).resolve().parents[1] / "setup_gpu_check.py"), run_name="__main__")
        self.assertEqual(exited.exception.code, 1)

    @unittest.skipUnless(os.name == "nt" and shutil.which("py"), "requires the Windows Python launcher")
    def test_fresh_venv_pip_dry_run_keeps_resolver_output_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            created = subprocess.run(["py", "-3.14-64", "-m", "venv", str(root / "venv")], capture_output=True, text=True, check=False, timeout=120)
            self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
            python = root / "venv" / "Scripts" / "python.exe"
            result = subprocess.run(
                [str(python), "-m", "pip", "install", "--progress-bar", "on", "--dry-run", "--no-deps", "humanize==4.15.0"],
                capture_output=True, text=True, check=False, timeout=120,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"(?m)^(Looking in indexes:|Collecting|Would install) ")
