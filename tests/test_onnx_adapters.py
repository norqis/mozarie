from __future__ import annotations

import tempfile
import threading
import time
import unittest
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch
import sys

import numpy as np
from onnxruntime.capi import _pybind_state as ort_state

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter, _class_names
from mozarie.inference import onnx as onnx_module
from mozarie.inference.onnx import BaseOnnxModel, Letterbox, available_providers, class_aware_nms_indices, create_session, diagnose_runtime, diagnose_session, nms_indices, restore_box
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter

THREAD_TIMEOUT = 30


def join_threads(*threads: threading.Thread) -> None:
    started = [thread for thread in threads if thread.ident is not None]
    for thread in started:
        thread.join(THREAD_TIMEOUT)
    for thread in started:
        if thread.is_alive():
            raise AssertionError(f"thread did not finish: {thread.name}")


class OnnxAdapterTests(unittest.TestCase):
    def test_cpu_provider_contract_does_not_depend_on_gpu_runtime(self) -> None:
        self.assertEqual(available_providers("cpu"), ["CPUExecutionProvider"])

    def test_gpu_provider_contract_rejects_an_unavailable_runtime(self) -> None:
        with patch("mozarie.inference.onnx.runtime_backend", return_value="cuda"), \
                patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CPUExecutionProvider"]):
            with self.assertRaisesRegex(Exception, "GPU"):
                available_providers("gpu")

    def test_detection_model_constructors_load_only_when_called(self) -> None:
        import mozarie.detection as detection
        with patch("mozarie.inference.yolo_segment.TargetSegmenter", return_value="target"):
            self.assertEqual(detection.TargetSegmenter("model"), "target")
        with patch("mozarie.inference.generic_yolo_segment.GenericYoloSegmenter", return_value="auxiliary"):
            self.assertEqual(detection.GenericYoloSegmenter("model"), "auxiliary")
        with patch("mozarie.inference.yolo_detect.HandDetector", return_value="hand"):
            self.assertEqual(detection.HandDetector("model"), "hand")

    def test_nms_keeps_highest_score_and_other_classes(self) -> None:
        boxes = [(0, 0, 10, 10), (1, 1, 9, 9), (20, 20, 30, 30)]
        self.assertEqual(nms_indices(boxes, [0.9, 0.8, 0.7], 0.5), [0, 2])
        self.assertEqual(class_aware_nms_indices(boxes[:2], [0.9, 0.8], ["penis", "pussy"], 0.5), [0, 1])

    def test_create_session_prefers_cuda_without_runtime_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"model")
            cuda_session = Mock()
            cuda_session.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            cpu_session = Mock()
            cpu_session.get_providers.return_value = ["CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.ort.get_available_providers",
                return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
            ), patch("mozarie.inference.onnx.runtime_backend", return_value="cuda"), \
                    patch("mozarie.inference.onnx.torch_module", return_value=object()), \
                    patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=[cuda_session, cpu_session]) as create:
                self.assertIs(create_session(path, "gpu", 2), cuda_session)
                self.assertIs(create_session(path, "cpu"), cpu_session)
            self.assertEqual(create.call_args_list[0].kwargs["providers"], [(
                "CUDAExecutionProvider",
                {
                    "device_id": 2,
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "HEURISTIC",
                    "cudnn_conv_use_max_workspace": "0",
                    "do_copy_in_default_stream": "1",
                },
            ), "CPUExecutionProvider"])
            self.assertEqual(create.call_args_list[1].kwargs["providers"], ["CPUExecutionProvider"])
            cuda_session.disable_fallback.assert_called_once_with()
            cpu_session.disable_fallback.assert_called_once_with()

    def test_default_gpu_does_not_pass_a_redundant_device_id(self) -> None:
        with patch("mozarie.inference.onnx.runtime_backend", return_value="cuda"), \
                patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider", "CPUExecutionProvider"]):
            self.assertEqual(available_providers("gpu", 0), [("CUDAExecutionProvider", {
                "arena_extend_strategy": "kSameAsRequested",
                "cudnn_conv_algo_search": "HEURISTIC",
                "cudnn_conv_use_max_workspace": "0",
                "do_copy_in_default_stream": "1",
            }), "CPUExecutionProvider"])

    def test_available_providers_rejects_missing_selected_gpu_provider(self) -> None:
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "directml"}), patch("mozarie.inference.onnx.ort.get_available_providers", return_value=[]):
            with self.assertRaisesRegex(Exception, "GPU"):
                available_providers("gpu")
        with patch.dict(os.environ, {"MOZARIE_RUNTIME": "cuda"}), patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CPUExecutionProvider"]):
            with self.assertRaisesRegex(Exception, "GPU"):
                available_providers("gpu")

    def test_directml_session_uses_required_sequential_options(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"model")
            session = Mock()
            session.get_providers.return_value = ["DmlExecutionProvider", "CPUExecutionProvider"]
            directml = SimpleNamespace(
                device_count=lambda: 2,
                device_name=lambda index: ["AMD Radeon(TM) Graphics", "AMD Radeon RX 6600M"][index],
            )
            adapters = [
                SimpleNamespace(index=0, name="AMD Radeon(TM) Graphics"),
                SimpleNamespace(index=1, name="AMD Radeon RX 6600M"),
            ]
            with patch.dict(os.environ, {"MOZARIE_RUNTIME": "directml"}), \
                 patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["DmlExecutionProvider", "CPUExecutionProvider"]), \
                 patch("mozarie.inference.onnx.directml_module", return_value=directml), \
                 patch("mozarie.inference.onnx._dxgi_adapter_names", return_value=adapters), \
                 patch("mozarie.inference.onnx.ort.InferenceSession", return_value=session) as create:
                self.assertIs(create_session(path, "gpu", 1), session)
            options = create.call_args.kwargs["sess_options"]
            self.assertFalse(options.enable_mem_pattern)
            self.assertEqual(options.execution_mode, 0)
            self.assertEqual(create.call_args.kwargs["providers"], [("DmlExecutionProvider", {"device_id": 1}), "CPUExecutionProvider"])

    def test_gpu_session_keeps_model_loading_errors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"invalid")
            diagnostic = Mock(); diagnostic.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider", "CPUExecutionProvider"]), \
                 patch("mozarie.inference.onnx.runtime_backend", return_value="cuda"), \
                 patch("mozarie.inference.onnx.torch_module", return_value=object()), \
                 patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=[RuntimeError("invalid model"), diagnostic]):
                with self.assertRaisesRegex(Exception, "検出モデル"):
                    create_session(path, "gpu", 0)

    def test_gpu_model_shape_error_is_not_reported_as_a_gpu_outage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"invalid")
            diagnostic = Mock(); diagnostic.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider"]), \
                 patch("mozarie.inference.onnx.runtime_backend", return_value="cuda"), \
                 patch("mozarie.inference.onnx.torch_module", return_value=object()), \
                 patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=[RuntimeError("CUDA model input shape is invalid"), diagnostic]):
                with self.assertRaises(Exception) as raised:
                    create_session(path, "gpu", 0)
            self.assertEqual(getattr(raised.exception, "error_code", None), "model_load_failed")

    def test_identity_runtime_failure_is_reported_as_gpu_unavailable(self) -> None:
        session = Mock(); session.get_providers.return_value = ["CUDAExecutionProvider"]
        session.run.side_effect = RuntimeError("provider initialization failed")
        with patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider"]), \
             patch("mozarie.inference.onnx.ort.InferenceSession", return_value=session):
            with self.assertRaises(Exception) as raised:
                diagnose_runtime("gpu", 0)
        self.assertEqual(getattr(raised.exception, "error_code", None), "gpu_unavailable")

    def test_create_session_reports_missing_model_without_its_path(self) -> None:
        with self.assertRaisesRegex(Exception, "検出モデル") as raised:
            create_session(Path("C:/private/missing.onnx"), "cpu")
        self.assertNotIn("private", str(raised.exception))

    def test_session_creation_provider_mismatch_and_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"; path.write_bytes(b"model")
            wrong = Mock(); wrong.get_providers.return_value = ["CPUExecutionProvider", "CUDAExecutionProvider"]
            with patch.dict(os.environ, {"MOZARIE_RUNTIME": "cuda"}), \
                    patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider"]), \
                    patch("mozarie.inference.onnx.ort.InferenceSession", return_value=wrong):
                with self.assertRaisesRegex(Exception, "GPU"):
                    create_session(path)
            wrong.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            with patch.dict(os.environ, {"MOZARIE_RUNTIME": "cuda"}), \
                    patch("mozarie.inference.onnx.ort.get_available_providers", return_value=["CUDAExecutionProvider"]), \
                    patch("mozarie.inference.onnx.ort.InferenceSession", return_value=wrong):
                self.assertIs(create_session(path), wrong)
            self.assertEqual(wrong.disable_fallback.call_count, 2)
            session = Mock()
            session.get_inputs.return_value = [SimpleNamespace(name="image", shape=[None, "dynamic", -1, 3])]
            session.get_providers.return_value = ["CPUExecutionProvider"]
            with patch("mozarie.inference.onnx.create_session", return_value=session):
                self.assertEqual(diagnose_session(path, "cpu"), ("CPUExecutionProvider",))
            session.run.assert_called_once()

    def test_session_error_identity_diagnostic_and_image_tensor_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"; path.write_bytes(b"model")
            unavailable = onnx_module._gpu_unavailable_error()
            with patch("mozarie.inference.onnx.ort.InferenceSession", side_effect=unavailable), \
                    patch("mozarie.inference.onnx.available_providers", return_value=["CPUExecutionProvider"]):
                with self.assertRaisesRegex(Exception, "GPU"):
                    onnx_module._create_session("model", "cpu", 0)
            with patch("mozarie.inference.onnx._create_session", side_effect=RuntimeError("bad model")):
                with self.assertRaisesRegex(Exception, "検出モデル"):
                    create_session(path, "cpu")
            with patch("mozarie.inference.onnx._create_session", side_effect=unavailable):
                with self.assertRaisesRegex(Exception, "GPU"):
                    diagnose_runtime()
        tensor, letterbox = onnx_module.letterbox_bgr(np.zeros((2, 4, 3), dtype=np.uint8), 8)
        self.assertEqual(tuple(tensor.shape), (1, 3, 8, 8))
        self.assertEqual((letterbox.pad_x, letterbox.pad_y), (0, 2))

    def test_base_onnx_model_initialization_directml_cuda_lock_and_providers(self) -> None:
        for provider in ("DmlExecutionProvider", "CUDAExecutionProvider"):
            with self.subTest(provider=provider):
                session = Mock()
                session.get_inputs.return_value = [SimpleNamespace(name="image")]
                session.get_providers.return_value = [provider]
                with patch("mozarie.inference.onnx.create_session", return_value=session), patch("mozarie.inference.onnx.ort.RunOptions", return_value=Mock()) as run_options:
                    model = BaseOnnxModel(Path("model.onnx"), gpu_device=3)
                self.assertEqual(model.providers, (provider,))
                if provider == "DmlExecutionProvider":
                    self.assertIsNotNone(model.run_lock)
                    session.run.return_value = [np.asarray([1])]
                    self.assertEqual(model.run(np.zeros((1,), dtype=np.float32))[0].tolist(), [1])
                else:
                    self.assertIsNotNone(model.run_options)
                    run_options.return_value.add_run_config_entry.assert_called_once_with("memory.enable_memory_arena_shrinkage", "gpu:3")

    def test_cuda_model_serializes_runs_without_blocking_another_model(self) -> None:
        entered = threading.Event(); release = threading.Event(); second_waiting = threading.Event(); active = 0; peak = 0; active_lock = threading.Lock(); failures: list[BaseException] = []; results: dict[str, list[np.ndarray]] = {}
        def run(*_args):
            nonlocal active, peak
            with active_lock:
                active += 1; peak = max(peak, active)
            entered.set(); self.assertTrue(release.wait(THREAD_TIMEOUT))
            with active_lock: active -= 1
            return [np.asarray([1])]
        class ObservedLock:
            def __init__(self):
                self.lock = threading.RLock()

            def __enter__(self):
                if not self.lock.acquire(blocking=False):
                    second_waiting.set()
                    self.lock.acquire()
                return self

            def __exit__(self, *_args):
                self.lock.release()

        model = BaseOnnxModel.__new__(BaseOnnxModel)
        model.device = "gpu"; model.input_name = "image"; model.run_options = Mock(); model.run_lock = ObservedLock()
        model.session = Mock(); model.session.run.side_effect = run
        def run_model(name, item):
            try:
                results[name] = item.run(np.zeros((1,), dtype=np.float32))
            except BaseException as exc:
                failures.append(exc)
        first = threading.Thread(target=lambda: run_model("first", model))
        second = threading.Thread(target=lambda: run_model("second", model))
        try:
            first.start(); self.assertTrue(entered.wait(THREAD_TIMEOUT)); second.start()
            self.assertTrue(second_waiting.wait(THREAD_TIMEOUT))
            self.assertEqual(peak, 1)
            release.set()
        finally:
            release.set()
            join_threads(first, second)
        self.assertEqual(failures, [])
        self.assertEqual({name: output[0].tolist() for name, output in results.items()}, {"first": [1], "second": [1]})

        barrier = threading.Barrier(2); active = 0; peak = 0; independent_results: dict[int, list[np.ndarray]] = {}
        def parallel_run(*_args):
            nonlocal active, peak
            with active_lock:
                active += 1; peak = max(peak, active)
            barrier.wait(timeout=THREAD_TIMEOUT)
            with active_lock: active -= 1
            return [np.asarray([1])]
        models = []
        for _index in range(2):
            other = BaseOnnxModel.__new__(BaseOnnxModel)
            other.device = "gpu"; other.input_name = "image"; other.run_options = Mock(); other.run_lock = threading.RLock()
            other.session = Mock(); other.session.run.side_effect = parallel_run
            models.append(other)
        def run_other(index, item):
            try:
                independent_results[index] = item.run(np.zeros((1,), dtype=np.float32))
            except BaseException as exc:
                failures.append(exc)
        threads = [threading.Thread(target=lambda index=index, item=item: run_other(index, item)) for index, item in enumerate(models)]
        completed = False
        try:
            for thread in threads: thread.start()
            join_threads(*threads)
            completed = True
        finally:
            if not completed:
                barrier.abort()
            join_threads(*threads)
        self.assertEqual(failures, [])
        self.assertEqual({index: output[0].tolist() for index, output in independent_results.items()}, {0: [1], 1: [1]})
        self.assertEqual(peak, 2)

    def test_restore_box_and_empty_nms_paths(self) -> None:
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        self.assertEqual(restore_box(np.asarray([5, 5, 4, 4]), transform), (3, 3, 7, 7))
        self.assertEqual(restore_box(np.asarray([1, 1, 1, 1]), transform, xywh=False), None)
        self.assertEqual(nms_indices([], []), [])

    def test_run_uses_cpu_and_gpu_onnx_runtime_call_shapes(self) -> None:
        cpu = BaseOnnxModel.__new__(BaseOnnxModel)
        cpu.device = "cpu"; cpu.input_name = "image"; cpu.run_options = None; cpu.session = Mock()
        cpu.session.run.return_value = [np.asarray([1])]
        self.assertEqual(cpu.run(np.zeros((1,), dtype=np.float32))[0].tolist(), [1])
        cpu.session.run.assert_called_once_with(None, {"image": ANY})

        gpu = BaseOnnxModel.__new__(BaseOnnxModel)
        gpu.device = "gpu"; gpu.input_name = "image"; gpu.run_options = Mock(); gpu.session = Mock()
        gpu.session.run.return_value = [np.asarray([2])]
        self.assertEqual(gpu.run(np.zeros((1,), dtype=np.float32))[0].tolist(), [2])
        gpu.session.run.assert_called_once_with(None, {"image": ANY}, gpu.run_options)

    def test_gpu_run_maps_execution_provider_failure_to_gpu_unavailable(self) -> None:
        model = BaseOnnxModel.__new__(BaseOnnxModel)
        model.device = "gpu"; model.input_name = "image"; model.run_options = None; model.session = Mock()
        model.session.run.side_effect = ort_state.EPFail("CUDA provider failed")
        with self.assertRaises(Exception) as raised:
            model.run(np.zeros((1,), dtype=np.float32))
        self.assertEqual(getattr(raised.exception, "error_code", None), "gpu_unavailable")

    def test_cpu_run_propagates_execution_provider_failure(self) -> None:
        model = BaseOnnxModel.__new__(BaseOnnxModel)
        model.device = "cpu"; model.input_name = "image"; model.run_options = None; model.session = Mock()
        failure = ort_state.EPFail("CPU provider failed")
        model.session.run.side_effect = failure
        with self.assertRaises(ort_state.EPFail) as raised:
            model.run(np.zeros((1,), dtype=np.float32))
        self.assertIs(raised.exception, failure)

    def test_gpu_run_propagates_model_shape_runtime_error(self) -> None:
        model = BaseOnnxModel.__new__(BaseOnnxModel)
        model.device = "gpu"; model.input_name = "image"; model.run_options = None; model.session = Mock()
        failure = RuntimeError("input shape is invalid")
        model.session.run.side_effect = failure
        with self.assertRaises(RuntimeError) as raised:
            model.run(np.zeros((1,), dtype=np.float32))
        self.assertIs(raised.exception, failure)

    def test_target_decoder_identifies_reversed_outputs_and_channel_first_rows(self) -> None:
        prediction = np.zeros((1, 43, 2), dtype=np.float32)
        prototype = np.zeros((1, 32, 4, 4), dtype=np.float32)
        resolved_prediction, resolved_prototype = TargetSegmenter._outputs([prototype, prediction])
        self.assertIs(resolved_prediction, prediction)
        self.assertIs(resolved_prototype, prototype)
        self.assertEqual(TargetSegmenter._prediction_rows(prediction).shape, (2, 43))

    def test_target_detect_decodes_a_target_class(self) -> None:
        detector = TargetSegmenter.__new__(TargetSegmenter)
        detector.input_size = 10
        prediction = np.zeros((1, 43, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 6, 0] = 0.9  # class 2: penis
        prediction[0, -32:, 0] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5)
        self.assertEqual([(segment["class_name"], segment["source"]) for segment in segments], [("penis", "target")])

    def test_target_detect_vector_filter_keeps_first_ties_and_row_order(self) -> None:
        detector = TargetSegmenter.__new__(TargetSegmenter)
        detector.input_size = 10
        prediction = np.zeros((1, 43, 4), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[2, 8, 2, 8], [2, 8, 2, 8], [2, 2, 2, 2], [2, 2, 2, 2]], dtype=np.float32)
        prediction[0, 6, 0] = 0.9  # penis
        prediction[0, 6:8, 1] = 0.9  # tie remains class 2 (penis)
        prediction[0, 7, 2] = 0.95  # pussy
        prediction[0, 4, 3] = 0.99  # unrelated class is discarded
        prediction[0, -32:, :] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5)
        self.assertEqual([segment["class_name"] for segment in segments], ["pussy", "penis", "penis"])
        self.assertEqual([round(float(segment["confidence"]), 2) for segment in segments], [0.95, 0.9, 0.9])

    def test_generic_decoder_uses_metadata_and_both_row_orientations(self) -> None:
        self.assertEqual(_class_names({"names": "{0: 'vagina', 1: 'penis'}"}), ("vagina", "penis"))
        self.assertEqual(_class_names({"names": "['penis', 'vagina']"}), ("penis", "vagina"))
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.class_names = ("vagina", "penis")
        channels = 4 + len(detector.class_names) + 32
        self.assertEqual(detector._prediction_rows(np.zeros((1, channels, 3), dtype=np.float32)).shape, (3, channels))
        self.assertEqual(detector._prediction_rows(np.zeros((1, 3, channels), dtype=np.float32)).shape, (3, channels))
        with self.assertRaises(ValueError):
            _class_names({"names": "{1: 'penis'}"})

    def test_generic_detect_maps_vagina_to_pussy(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.input_size = 10
        detector.class_names = ("vagina", "penis", "arm")
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 4, 0] = 0.9
        prediction[0, 4 + len(detector.class_names):, 0] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "generic")
        self.assertEqual([(segment["class_name"], segment["source"]) for segment in segments], [("pussy", "generic")])

    def test_generic_detect_keeps_testicles_only_for_penis_target(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.input_size = 10; detector.class_names = ("penis", "testicles")
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 2), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[3, 7], [3, 7], [4, 4], [4, 4]], dtype=np.float32)
        prediction[0, 4, 0] = 0.9
        prediction[0, 5, 1] = 0.95
        prediction[0, 4 + len(detector.class_names):, :] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            penis = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "ntd", {"penis", "testicles"})
            pussy = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "ntd", {"pussy"})
        self.assertEqual({segment["class_name"] for segment in penis}, {"penis", "testicles"})
        self.assertEqual(pussy, [])

    def test_generic_detect_vector_filter_keeps_first_ties_and_target_subset(self) -> None:
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.input_size = 10; detector.class_names = ("vagina", "penis", "arm")
        channels = 4 + len(detector.class_names) + 32
        prediction = np.zeros((1, channels, 3), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[2, 8, 2], [2, 8, 2], [2, 2, 2], [2, 2, 2]], dtype=np.float32)
        prediction[0, 4:6, 0] = 0.9  # tie remains vagina (pussy)
        prediction[0, 5, 1] = 0.95  # penis
        prediction[0, 6, 2] = 0.99  # unrelated class is discarded
        prediction[0, 4 + len(detector.class_names):, :] = 1.0
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            segments = detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, "generic")
        self.assertEqual([segment["class_name"] for segment in segments], ["penis", "pussy"])
        self.assertEqual([round(float(segment["confidence"]), 2) for segment in segments], [0.95, 0.9])

    def test_hand_decoder_accepts_both_export_orientations(self) -> None:
        detector = HandDetector.__new__(HandDetector)
        detector.input_size = 10
        tensor = np.zeros((1, 3, 10, 10), dtype=np.float32)
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(tensor, transform)):
            for output in (
                np.asarray([[[5.0], [5.0], [6.0], [6.0], [0.9]]], dtype=np.float32),
                np.asarray([[[5.0, 5.0, 6.0, 6.0, 0.9]]], dtype=np.float32),
            ):
                detector.run = lambda _tensor, value=output: [value]
                self.assertEqual(detector.detect_boxes(np.zeros((10, 10, 3), dtype=np.uint8), 0.5), [(2, 2, 8, 8)])
