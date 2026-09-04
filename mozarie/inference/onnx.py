"""Direct ONNX Runtime helpers for the Mozarie detection models."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import cv2
import numpy as np

from ..core import torch_module
from ..runtime import (
    _dxgi_adapter_names,
    directml_module,
    directml_onnx_device_id,
    runtime_backend,
)


def _gpu_unavailable_error() -> Exception:
    from ..core import ClientError
    return ClientError("GPU推論を初期化できません。CPUへ切り替えるか、Mozarieを再セットアップしてください。", "gpu_unavailable")


def _model_load_error() -> Exception:
    from ..core import ClientError
    return ClientError("検出モデルを読み込めません。モデルファイルを確認して、もう一度実行してください。", "model_load_failed")


import onnxruntime as ort
from onnxruntime.capi import _pybind_state as ort_state


@dataclass(frozen=True)
class Letterbox:
    scale: float
    pad_x: int
    pad_y: int
    input_width: int
    input_height: int
    source_width: int
    source_height: int


def _directml_onnx_device_id(logical_device_id: int) -> int:
    """Map a torch-directml selection to one unique DXGI adapter."""
    try:
        return directml_onnx_device_id(
            int(logical_device_id),
            module=directml_module(),
            adapters=_dxgi_adapter_names(),
        )
    except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
        raise _gpu_unavailable_error() from exc


def available_providers(device: str, gpu_device: int = 0) -> list[object]:
    available = set(ort.get_available_providers())
    if device.lower() == "cpu":
        return ["CPUExecutionProvider"]
    backend = runtime_backend(ort_module=ort)
    if backend == "directml":
        if "DmlExecutionProvider" not in available:
            raise _gpu_unavailable_error()
        directml_index = _directml_onnx_device_id(int(gpu_device))
        return [("DmlExecutionProvider", {"device_id": directml_index}), "CPUExecutionProvider"]
    if backend != "cuda" or "CUDAExecutionProvider" not in available:
        raise _gpu_unavailable_error()
    options = {
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0",
        "do_copy_in_default_stream": "1",
    }
    if int(gpu_device) != 0:
        options["device_id"] = int(gpu_device)
    return [("CUDAExecutionProvider", options), "CPUExecutionProvider"]


def _create_session(model: str | bytes, device: str, gpu_device: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    backend = "cpu" if device.lower() == "cpu" else runtime_backend(ort_module=ort)
    if backend == "directml":
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    try:
        providers = available_providers(device, gpu_device)
        if backend == "cuda":
            torch_module()
        session = ort.InferenceSession(model, sess_options=options, providers=providers)
    except Exception as exc:
        if getattr(exc, "error_code", None):
            raise
        raise _model_load_error() from exc
    session.disable_fallback()
    expected = {"cuda": "CUDAExecutionProvider", "directml": "DmlExecutionProvider"}.get(backend)
    active_providers = session.get_providers()
    if expected is not None and (not active_providers or active_providers[0] != expected):
        raise _gpu_unavailable_error()
    return session


def create_session(path: Path, device: str = "gpu", gpu_device: int = 0) -> ort.InferenceSession:
    if not path.is_file():
        raise _model_load_error()
    try:
        return _create_session(str(path), device, gpu_device)
    except Exception as exc:
        if getattr(exc, "error_code", None):
            if device.lower() != "cpu" and getattr(exc, "error_code", None) == "model_load_failed":
                diagnose_runtime(device, gpu_device)
            raise
        raise _model_load_error() from exc


def diagnose_session(path: Path, device: str = "gpu", gpu_device: int = 0) -> tuple[str, ...]:
    """Create and run one disposable session to validate the chosen runtime."""
    session = create_session(path, device, gpu_device)
    input_meta = session.get_inputs()[0]
    shape = [1 if not isinstance(value, int) or value <= 0 else value for value in input_meta.shape]
    tensor = np.zeros(shape, dtype=np.float32)
    session.run(None, {input_meta.name: tensor})
    return tuple(session.get_providers())


def diagnose_runtime(device: str = "gpu", gpu_device: int = 0) -> tuple[str, ...]:
    """Run a disposable identity model on the selected ONNX Runtime provider."""
    from onnx import TensorProto, helper

    input_value = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 1])
    output_value = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1])
    graph = helper.make_graph([helper.make_node("Identity", ["input"], ["output"])], "mozarie-diagnostic", [input_value], [output_value])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    try:
        session = _create_session(model.SerializeToString(), device, gpu_device)
        session.run(None, {"input": np.zeros((1, 1), dtype=np.float32)})
    except Exception as exc:
        if getattr(exc, "error_code", None) == "gpu_unavailable":
            raise
        raise _gpu_unavailable_error() from exc
    return tuple(session.get_providers())


def letterbox_bgr(rgb: np.ndarray, size: int) -> tuple[np.ndarray, Letterbox]:
    height, width = rgb.shape[:2]
    scale = min(size / width, size / height)
    resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
    resized = cv2.resize(rgb, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    pad_x, pad_y = (size - resized_width) // 2, (size - resized_height) // 2
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[pad_y:pad_y + resized_height, pad_x:pad_x + resized_width] = resized
    tensor = np.ascontiguousarray(canvas.transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
    return tensor, Letterbox(scale, pad_x, pad_y, size, size, width, height)


def restore_box(box: np.ndarray, letterbox: Letterbox, *, xywh: bool = True) -> tuple[int, int, int, int] | None:
    values = np.asarray(box, dtype=np.float32).copy()
    if xywh:
        values = np.asarray((values[0] - values[2] / 2, values[1] - values[3] / 2, values[0] + values[2] / 2, values[1] + values[3] / 2))
    values[[0, 2]] = (values[[0, 2]] - letterbox.pad_x) / letterbox.scale
    values[[1, 3]] = (values[[1, 3]] - letterbox.pad_y) / letterbox.scale
    left, top = np.floor(values[:2]).astype(int)
    right, bottom = np.ceil(values[2:]).astype(int)
    left, top = max(0, left), max(0, top)
    right, bottom = min(letterbox.source_width, right), min(letterbox.source_height, bottom)
    return (left, top, right, bottom) if right > left and bottom > top else None


def nms_indices(boxes: list[tuple[int, int, int, int]], scores: list[float], iou_threshold: float = 0.7) -> list[int]:
    if not boxes:
        return []
    indexed = sorted(range(len(boxes)), key=lambda index: scores[index], reverse=True)
    selected: list[int] = []
    while indexed:
        current = indexed.pop(0)
        selected.append(current)
        left, top, right, bottom = boxes[current]
        area = max(1, (right - left) * (bottom - top))
        survivors: list[int] = []
        for other in indexed:
            other_left, other_top, other_right, other_bottom = boxes[other]
            overlap_left, overlap_top = max(left, other_left), max(top, other_top)
            overlap_right, overlap_bottom = min(right, other_right), min(bottom, other_bottom)
            overlap = max(0, overlap_right - overlap_left) * max(0, overlap_bottom - overlap_top)
            other_area = max(1, (other_right - other_left) * (other_bottom - other_top))
            if overlap / (area + other_area - overlap) <= iou_threshold:
                survivors.append(other)
        indexed = survivors
    return selected


def class_aware_nms_indices(
    boxes: list[tuple[int, int, int, int]],
    scores: list[float],
    classes: list[object],
    iou_threshold: float = 0.7,
) -> list[int]:
    selected: list[int] = []
    for class_name in dict.fromkeys(classes):
        class_indices = [index for index, value in enumerate(classes) if value == class_name]
        class_boxes = [boxes[index] for index in class_indices]
        class_scores = [scores[index] for index in class_indices]
        selected.extend(class_indices[index] for index in nms_indices(class_boxes, class_scores, iou_threshold))
    return sorted(selected, key=lambda index: scores[index], reverse=True)


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -60, 60)))


class BaseOnnxModel:
    def __init__(self, path: Path, *, device: str = "gpu", gpu_device: int = 0) -> None:
        self.path = path
        self.device = device
        self.gpu_device = int(gpu_device)
        self.session = create_session(path, device, gpu_device)
        self.input_name = self.session.get_inputs()[0].name
        self.run_options = None
        provider = self.session.get_providers()[0]
        self.run_lock = threading.RLock() if provider in {"CUDAExecutionProvider", "DmlExecutionProvider"} else None
        if provider == "CUDAExecutionProvider":
            self.run_options = ort.RunOptions()
            self.run_options.add_run_config_entry("memory.enable_memory_arena_shrinkage", f"gpu:{self.gpu_device}")

    def run(self, tensor: np.ndarray) -> list[np.ndarray]:
        feeds = {self.input_name: tensor}
        try:
            run_lock = getattr(self, "run_lock", None)
            if run_lock is not None:
                with run_lock:
                    outputs = self.session.run(None, feeds) if self.run_options is None else self.session.run(None, feeds, self.run_options)
            else:
                outputs = self.session.run(None, feeds) if self.run_options is None else self.session.run(None, feeds, self.run_options)
        except ort_state.EPFail as exc:
            if self.device.lower() != "cpu":
                raise _gpu_unavailable_error() from exc
            raise
        return [np.asarray(value) for value in outputs]

    @property
    def providers(self) -> tuple[str, ...]:
        return tuple(self.session.get_providers())
