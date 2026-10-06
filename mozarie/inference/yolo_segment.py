"""Decoder for the target YOLO segmentation ONNX export."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .onnx import BaseOnnxModel, Letterbox, class_aware_nms_indices, letterbox_bgr, restore_box, sigmoid


CLASS_NAMES = ("anus", "nipple", "penis", "vagina", "female face", "male face", "pubic hair")


class TargetSegmenter(BaseOnnxModel):
    def __init__(self, path: Path, *, device: str = "gpu", gpu_device: int = 0, input_size: int = 1280) -> None:
        super().__init__(path, device=device, gpu_device=gpu_device)
        self.input_size = input_size

    @staticmethod
    def _prediction_rows(output: np.ndarray) -> np.ndarray:
        rows = np.asarray(output)[0]
        if rows.ndim != 2:
            raise ValueError("Target prediction output must be rank 3")
        if rows.shape[0] == 43:
            return rows.T
        if rows.shape[1] == 43:
            return rows
        raise ValueError("Target prediction output has no 43-channel axis")

    @staticmethod
    def _outputs(values: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        prediction = next((value for value in values if np.asarray(value).ndim == 3 and 43 in np.asarray(value).shape[1:]), None)
        prototype = next((value for value in values if np.asarray(value).ndim == 4 and np.asarray(value).shape[1] == 32), None)
        if prediction is None or prototype is None:
            raise ValueError("Target model outputs do not match Mozarie's segmentation profile")
        return np.asarray(prediction), np.asarray(prototype)

    @staticmethod
    def _mask_from_coefficients(coefficients: np.ndarray, proto: np.ndarray, box: tuple[int, int, int, int], letterbox: Letterbox) -> np.ndarray:
        prototype = np.asarray(proto)[0]
        logits = coefficients @ prototype.reshape(prototype.shape[0], -1)
        low_res = sigmoid(logits).reshape(prototype.shape[1:])
        full = cv2.resize(low_res, (letterbox.input_width, letterbox.input_height), interpolation=cv2.INTER_LINEAR)
        cropped = full[
            letterbox.pad_y:letterbox.pad_y + max(1, round(letterbox.source_height * letterbox.scale)),
            letterbox.pad_x:letterbox.pad_x + max(1, round(letterbox.source_width * letterbox.scale)),
        ]
        restored = cv2.resize(cropped, (letterbox.source_width, letterbox.source_height), interpolation=cv2.INTER_LINEAR)
        left, top, right, bottom = box
        constrained = np.zeros_like(restored, dtype=np.uint8)
        constrained[top:bottom, left:right] = (restored[top:bottom, left:right] >= 0.5).astype(np.uint8) * 255
        return constrained

    def detect(self, rgb: np.ndarray, confidence: float, targets: set[str] | None = None) -> list[dict[str, object]]:
        targets = targets or {"penis", "pussy"}
        tensor, transform = letterbox_bgr(rgb, self.input_size)
        prediction, prototype = self._outputs(self.run(tensor))
        rows = self._prediction_rows(prediction)
        class_ids_for_rows = np.argmax(rows[:, 4:4 + len(CLASS_NAMES)], axis=1)
        scores_for_rows = rows[np.arange(len(rows)), 4 + class_ids_for_rows]
        class_names = {2: "penis", 3: "pussy", 4: "female_face"}
        target_class = np.isin(class_ids_for_rows, tuple(class_id for class_id, name in class_names.items() if name in targets))
        selected_rows = np.flatnonzero(target_class & (scores_for_rows >= confidence))
        boxes: list[tuple[int, int, int, int]] = []
        scores: list[float] = []
        class_ids: list[int] = []
        coefficients: list[np.ndarray] = []
        for row_index in selected_rows:
            row = rows[row_index]
            class_id = int(class_ids_for_rows[row_index])
            score = float(scores_for_rows[row_index])
            class_name = class_names[class_id]
            box = restore_box(row[:4], transform, xywh=True)
            if box is None:
                continue
            boxes.append(box); scores.append(score); class_ids.append(class_id); coefficients.append(np.asarray(row[-32:], dtype=np.float32))
        return [
            {
                "class_name": class_names[class_ids[index]],
                "confidence": scores[index],
                "mask": self._mask_from_coefficients(coefficients[index], prototype, boxes[index], transform),
                "source": "target",
            }
            for index in class_aware_nms_indices(boxes, scores, class_ids, 0.85)
        ]
