from __future__ import annotations

import io
import inspect
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from mozarie import runtime_profile


class RuntimeProfileTests(unittest.TestCase):
    @staticmethod
    def _probe_dependencies(providers: list[str], output: object = None):
        session = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: providers,
            run=lambda *_args: [[[1.0]]] if output is None else output,
        )
        options = SimpleNamespace(add_session_config_entry=lambda *_args: None)
        ort = SimpleNamespace(
            SessionOptions=lambda: options,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=lambda *_args, **_kwargs: session,
        )
        ort.options = options
        helper = SimpleNamespace(
            make_tensor_value_info=lambda *_args: object(),
            make_node=lambda *_args: object(),
            make_graph=lambda *_args: object(),
            make_opsetid=lambda *_args: object(),
            make_model=lambda *_args, **_kwargs: SimpleNamespace(SerializeToString=lambda: b"model"),
        )
        onnx = SimpleNamespace(helper=helper, TensorProto=SimpleNamespace(FLOAT=1))
        np = SimpleNamespace(float32="float32", ones=lambda *_args, **_kwargs: [[1.0]])
        return ort, onnx, np

    def test_normalize_and_read_marker_inputs(self) -> None:
        self.assertIsNone(runtime_profile.normalize_profile(None))
        self.assertEqual(runtime_profile.normalize_profile(" CUDA "), "cuda")
        with self.assertRaises(runtime_profile.ProfileError):
            runtime_profile.normalize_profile("openvino")
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker = venv / runtime_profile.MARKER_NAME
            marker.write_text("not json", encoding="utf-8")
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker.write_text("[]", encoding="utf-8")
            self.assertIsNone(runtime_profile.read_marker(venv))
            marker.write_text('{"schema": 1, "profile": "cpu"}', encoding="utf-8")
            self.assertEqual(runtime_profile.read_marker(venv), {"schema": 1, "profile": "cpu"})

    def test_installed_distributions_and_profiles(self) -> None:
        def version(name: str) -> str:
            if name == "onnxruntime-directml":
                return "1.24.4"
            raise runtime_profile.metadata.PackageNotFoundError

        with patch.object(runtime_profile.metadata, "version", side_effect=version):
            self.assertEqual(runtime_profile.installed_distributions(), {"onnxruntime-directml": "1.24.4"})
        with patch.object(runtime_profile, "installed_distributions", return_value={}):
            self.assertIsNone(runtime_profile.installed_profile())
        with patch.object(runtime_profile, "installed_distributions", return_value={"onnxruntime": "1.24.4"}):
            self.assertEqual(runtime_profile.installed_profile(), "cpu")

    def test_preflight_allows_empty_environment_and_rejects_unusable_runtime(self) -> None:
        with patch.object(runtime_profile, "installed_profile", return_value=None):
            runtime_profile.preflight("cuda")
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"):
            with patch.dict(sys.modules, {"onnxruntime": None}):
                with self.assertRaisesRegex(runtime_profile.ProfileError, "cannot be imported"):
                    runtime_profile.preflight("cuda")
        ort = type("Ort", (), {"get_available_providers": staticmethod(lambda: ["CPUExecutionProvider"])})
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), \
                patch.dict(sys.modules, {"onnxruntime": ort}):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "does not expose"):
                runtime_profile.preflight("cuda")

    def test_show_returns_no_profile_for_missing_or_unsupported_marker_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(venv))
            runtime_profile.write_marker(venv, {"schema": 2, "profile": "cuda"})
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(venv))

    def test_onnx_probe_rejects_directml_without_identity(self) -> None:
        ort, onnx, np = self._probe_dependencies(["DmlExecutionProvider"])
        with self.assertRaisesRegex(runtime_profile.ProfileError, "identity is required"):
            runtime_profile._probe_onnx(ort, onnx, np, "directml", 1)

    def test_onnx_probe_requires_the_selected_cuda_provider_first(self) -> None:
        ort, onnx, np = self._probe_dependencies(["CUDAExecutionProvider", "CPUExecutionProvider"])
        self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, "cuda", 0), "CUDAExecutionProvider")
        wrong = SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CPUExecutionProvider", "CUDAExecutionProvider"],
            run=Mock(),
        )
        ort, onnx, np = self._probe_dependencies(["CPUExecutionProvider", "CUDAExecutionProvider"])
        ort.InferenceSession = lambda *_args, **_kwargs: wrong
        with self.assertRaisesRegex(runtime_profile.ProfileError, "selected"):
            runtime_profile._probe_onnx(ort, onnx, np, "cuda", 0)
        wrong.run.assert_not_called()

    def test_onnx_gpu_probe_keeps_cpu_ep_after_the_selected_provider(self) -> None:
        ort, onnx, np = self._probe_dependencies(["CUDAExecutionProvider"])
        config = []
        ort.options.add_session_config_entry = lambda key, value: config.append((key, value))
        created = []
        ort.InferenceSession = lambda *_args, **kwargs: (created.append(kwargs) or SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["CUDAExecutionProvider"],
            run=lambda *_args: [[[1.0]]],
        ))
        self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, "cuda", 2), "CUDAExecutionProvider")
        self.assertEqual(created[0]["providers"], [("CUDAExecutionProvider", {"device_id": 2}), "CPUExecutionProvider"])
        self.assertEqual(config, [])

    def test_onnx_directml_probe_keeps_cpu_ep_after_directml(self) -> None:
        ort, onnx, np = self._probe_dependencies(["DmlExecutionProvider"])
        config = []
        ort.options.add_session_config_entry = lambda key, value: config.append((key, value))
        created = []
        ort.InferenceSession = lambda *_args, **kwargs: (created.append(kwargs) or SimpleNamespace(
            disable_fallback=lambda: None,
            get_providers=lambda: ["DmlExecutionProvider"],
            run=lambda *_args: [[[1.0]]],
        ))
        with patch("mozarie.runtime.directml_onnx_device_id", return_value=5):
            self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, "directml", 2, directml_identity=object()), "DmlExecutionProvider")
        self.assertEqual(created[0]["providers"], [("DmlExecutionProvider", {"device_id": 5}), "CPUExecutionProvider"])
        self.assertEqual(config, [])

    def test_validate_imports_torch_before_onnxruntime(self) -> None:
        source = inspect.getsource(runtime_profile.validate)
        self.assertLess(source.index("import torch"), source.index("import onnxruntime as ort"))

    def test_onnx_probe_supports_cuda_and_cpu_and_rejects_bad_results(self) -> None:
        for profile, provider in (("cuda", "CUDAExecutionProvider"), ("cpu", "CPUExecutionProvider")):
            with self.subTest(profile=profile):
                ort, onnx, np = self._probe_dependencies([provider])
                self.assertEqual(runtime_profile._probe_onnx(ort, onnx, np, profile, 2), provider)
        ort, onnx, np = self._probe_dependencies([], output=[])
        with self.assertRaisesRegex(runtime_profile.ProfileError, "probe failed"):
            runtime_profile._probe_onnx(ort, onnx, np, "cpu", 0)

    def test_validate_cpu_and_main_commands(self) -> None:
        class CpuProbe:
            def __add__(self, _value: object) -> "CpuProbe":
                return self

            def item(self) -> float:
                return 2.0

        cpu_probe = CpuProbe()
        fake_torch = SimpleNamespace(ones=lambda *_args, **_kwargs: cpu_probe)
        fake_ort = SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"), \
                patch.object(runtime_profile, "_probe_onnx", return_value="CPUExecutionProvider"), \
                patch.dict(sys.modules, {
                    "numpy": SimpleNamespace(),
                    "onnx": SimpleNamespace(),
                    "onnxruntime": fake_ort,
                    "torch": fake_torch,
                }):
            result = runtime_profile.validate("cpu")
        self.assertEqual(result["profile"], "cpu")
        self.assertIsNone(result["validated_device"])

        stdout = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "show"]), \
                patch.object(runtime_profile, "selected_profile", return_value="cuda"), redirect_stdout(stdout):
            self.assertEqual(runtime_profile.main(), 0)
        self.assertEqual(stdout.getvalue(), "cuda\n")

        stdout = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "show"]), \
                patch.object(runtime_profile, "selected_profile", return_value=None), redirect_stdout(stdout):
            self.assertEqual(runtime_profile.main(), 0)
        self.assertEqual(stdout.getvalue(), "")

        with patch.object(sys, "argv", ["runtime_profile.py", "preflight", "cpu"]), \
                patch.object(runtime_profile, "preflight") as preflight:
            self.assertEqual(runtime_profile.main(), 0)
        preflight.assert_called_once_with("cpu")

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "preflight"]), redirect_stderr(stderr):
            self.assertEqual(runtime_profile.main(), 1)
        self.assertIn("runtime profile is required", stderr.getvalue())

    def test_rejects_cross_profile_install_before_pip(self) -> None:
        with patch.object(runtime_profile, "installed_profile", return_value="directml"):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "selected cuda"):
                runtime_profile.preflight("cuda")

    def test_rejects_both_onnx_runtime_distributions(self) -> None:
        with patch.object(runtime_profile, "installed_distributions", return_value={
            "onnxruntime-gpu": "1.27.0",
            "onnxruntime-directml": "1.24.4",
        }):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "must not share"):
                runtime_profile.installed_profile()

    def test_cpu_preflight_requires_the_cpu_provider(self) -> None:
        ort = type("Ort", (), {"get_available_providers": staticmethod(lambda: ["CPUExecutionProvider"])})
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"):
            with patch.dict("sys.modules", {"onnxruntime": ort}):
                runtime_profile.preflight("cpu")

    def test_marker_round_trip_and_explicit_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            runtime_profile.write_marker(venv, {"schema": 1, "profile": "directml"})
            self.assertEqual(json.loads((venv / runtime_profile.MARKER_NAME).read_text(encoding="utf-8"))["profile"], "directml")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(runtime_profile.selected_profile(venv), "directml")
            with patch.dict(os.environ, {"MOZARIE_RUNTIME": "cuda"}):
                self.assertEqual(runtime_profile.selected_profile(venv), "cuda")

    def test_markerless_profile_is_not_inferred_from_installed_packages(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_profile, "installed_profile", side_effect=AssertionError("must not infer")):
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(runtime_profile.selected_profile(Path(directory)))

    def test_invalid_marker_profile_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            runtime_profile.write_marker(venv, {"schema": 1, "profile": "invalid"})
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(runtime_profile.ProfileError):
                    runtime_profile.selected_profile(venv)

    def test_validate_cuda_and_directml_runtime_profiles(self) -> None:
        class Probe:
            def __add__(self, _value: object) -> "Probe":
                return self

            def cpu(self) -> "Probe":
                return self

            def item(self) -> float:
                return 2.0

        probe = Probe()
        cuda = SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: 2,
            get_device_name=lambda index: ["RTX A", "RTX B"][index],
        )
        fake_torch = SimpleNamespace(version=SimpleNamespace(cuda="13.0"), cuda=cuda, ones=lambda *_args, **_kwargs: probe)
        fake_ort = SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), \
                patch.object(runtime_profile, "_probe_onnx", return_value="CUDAExecutionProvider"), \
                patch.dict(sys.modules, {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": fake_ort, "torch": fake_torch}):
            result = runtime_profile.validate("cuda", 1)
        self.assertEqual(result["validated_device"], 1)
        self.assertEqual(result["devices"], ["RTX A", "RTX B"])

        directml = SimpleNamespace(device_count=lambda: 1, device_name=lambda _index: "AMD\0", device=lambda index: ("dml", index))
        directml_ort = SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), \
                patch.object(runtime_profile, "_probe_onnx", return_value="DmlExecutionProvider"), \
                patch.dict(sys.modules, {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": directml_ort, "torch": fake_torch, "torch_directml": directml}):
            result = runtime_profile.validate("directml")
        self.assertEqual(result["devices"], ["AMD"])

    def test_validate_rejects_unavailable_runtime_devices_and_providers(self) -> None:
        torch = SimpleNamespace(version=SimpleNamespace(cuda=None), cuda=SimpleNamespace(is_available=lambda: False, device_count=lambda: 0))
        missing = SimpleNamespace(get_available_providers=lambda: [])
        modules = {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": missing, "torch": torch}
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "CUDA PyTorch"):
                runtime_profile.validate("cuda")
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "DmlExecutionProvider"):
                runtime_profile.validate("directml")
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "CPUExecutionProvider"):
                runtime_profile.validate("cpu")

    def test_main_validate_writes_marker_and_reports_profile_errors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            venv = Path(directory)
            stdout = io.StringIO()
            with patch.object(sys, "argv", ["runtime_profile.py", "validate", "cpu", "--venv", str(venv), "--write-marker"]), \
                    patch.object(runtime_profile, "validate", return_value={"schema": 1, "profile": "cpu"}), redirect_stdout(stdout):
                self.assertEqual(runtime_profile.main(), 0)
            self.assertEqual(runtime_profile.read_marker(venv), {"schema": 1, "profile": "cpu"})
        stderr = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "validate", "cpu"]), \
                patch.object(runtime_profile, "validate", side_effect=runtime_profile.ProfileError("bad runtime")), redirect_stderr(stderr):
            self.assertEqual(runtime_profile.main(), 1)
        self.assertIn("bad runtime", stderr.getvalue())

    def test_runtime_profile_reports_every_device_probe_failure(self) -> None:
        class BadProbe:
            def __add__(self, _value: object) -> "BadProbe":
                return self

            def cpu(self) -> "BadProbe":
                return self

            def item(self) -> float:
                return 0.0

        cuda = SimpleNamespace(is_available=lambda: False, device_count=lambda: 1, get_device_name=lambda _index: "GPU")
        torch = SimpleNamespace(version=SimpleNamespace(cuda="13"), cuda=cuda, ones=lambda *_args, **_kwargs: BadProbe())
        cuda_ort = SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        modules = {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": cuda_ort, "torch": torch}
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "no usable"):
                runtime_profile.validate("cuda")
        cuda.is_available = lambda: True
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "device 1"):
                runtime_profile.validate("cuda", 1)
        with patch.object(runtime_profile, "installed_profile", return_value="cuda"), patch.object(runtime_profile, "_probe_onnx", return_value="CUDAExecutionProvider"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "tensor probe"):
                runtime_profile.validate("cuda")

        directml_ort = SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider"])
        directml_modules = {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": directml_ort, "torch": torch, "torch_directml": None}
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), patch.dict(sys.modules, directml_modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "cannot be imported"):
                runtime_profile.validate("directml")
        directml = SimpleNamespace(device_count=lambda: 0, device_name=lambda _index: "", device=lambda _index: "dml")
        directml_modules["torch_directml"] = directml
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), patch.dict(sys.modules, directml_modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "did not find"):
                runtime_profile.validate("directml")
        directml.device_count = lambda: 1
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), patch.dict(sys.modules, directml_modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "device 1"):
                runtime_profile.validate("directml", 1)
        cpu_ort = SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"), patch.object(runtime_profile, "_probe_onnx", return_value="CPUExecutionProvider"), patch.dict(sys.modules, {"numpy": SimpleNamespace(), "onnx": SimpleNamespace(), "onnxruntime": cpu_ort, "torch": torch}):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "CPU tensor"):
                runtime_profile.validate("cpu")

    def test_probe_bad_output_and_module_main_entrypoint(self) -> None:
        ort, onnx, np = self._probe_dependencies(["CPUExecutionProvider"], output=[[[0.0]]])
        with self.assertRaisesRegex(runtime_profile.ProfileError, "probe failed"):
            runtime_profile._probe_onnx(ort, onnx, np, "cpu", 0)
        import runpy
        with patch.object(sys, "argv", ["runtime_profile.py", "show"]):
            with self.assertRaises(SystemExit) as raised:
                runpy.run_module("mozarie.runtime_profile", run_name="__main__")
        self.assertEqual(raised.exception.code, 0)

    def test_validate_import_mismatch_and_directml_tensor_failures(self) -> None:
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"), patch.dict(sys.modules, {"numpy": None}):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "cannot be imported"):
                runtime_profile.validate("cpu")
        with patch.object(runtime_profile, "installed_profile", return_value="cpu"):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "not cuda"):
                runtime_profile.validate("cuda")
        class BadProbe:
            def __add__(self, _value: object) -> "BadProbe": return self
            def cpu(self) -> "BadProbe": return self
            def item(self) -> float: return 0.0
        directml = SimpleNamespace(device_count=lambda: 1, device_name=lambda _index: "DML", device=lambda _index: "dml")
        modules = {
            "numpy": SimpleNamespace(), "onnx": SimpleNamespace(),
            "onnxruntime": SimpleNamespace(get_available_providers=lambda: ["DmlExecutionProvider"]),
            "torch": SimpleNamespace(ones=lambda *_args, **_kwargs: BadProbe()), "torch_directml": directml,
        }
        with patch.object(runtime_profile, "installed_profile", return_value="directml"), patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(runtime_profile.ProfileError, "DirectML tensor"):
                runtime_profile.validate("directml")

    def test_direct_script_main_entrypoint_is_covered(self) -> None:
        import runpy
        source = Path(runtime_profile.__file__)
        with patch.object(sys, "argv", [str(source), "show"]):
            with self.assertRaises(SystemExit) as raised:
                runpy.run_path(str(source), run_name="__main__")
        self.assertEqual(raised.exception.code, 0)

    def test_main_validate_without_marker_prints_result(self) -> None:
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["runtime_profile.py", "validate", "cpu"]), \
                patch.object(runtime_profile, "validate", return_value={"profile": "cpu"}), redirect_stdout(stdout):
            self.assertEqual(runtime_profile.main(), 0)
        self.assertIn('"cpu"', stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
