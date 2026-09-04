"""Mozarie local image-review and mosaic editor.

The server never accepts a client supplied file path.  Files are first found
under a user-selected root, then addressed through opaque catalogue ids.
"""

from __future__ import annotations

import sys
from contextlib import ExitStack
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import base64
import binascii
import argparse
import atexit
from concurrent.futures import ThreadPoolExecutor, wait
import io
import json
import logging
import math
import mimetypes
import msvcrt
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import webbrowser
import zlib
from dataclasses import dataclass, field, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from mozarie.domain import Candidate, CandidateRole, CANDIDATE_LABEL_TOKENS, CANDIDATE_REFINEMENT_TOKENS, CANDIDATE_SOURCE_TOKENS
from mozarie.masks import compose_masks
from mozarie.boundary import polygon_roi_and_point
from mozarie.config import SettingsError, SettingsStore


STATIC_DIR = APP_DIR / "static"
CACHE_BASE_DIR = APP_DIR / ".mozarie-cache"
SESSION_BASE_DIR = Path(tempfile.gettempdir()) / "Mozarie"


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_CLASSES = {"pussy", "penis"}
# NTD reports testicles as part of the penis target.  The setting remains the
# simple penis/pussy choice, while detection keeps that companion class.
DETECTED_TARGET_CLASSES = TARGET_CLASSES | {"testicles"}
SOURCE_PRIORITY = {"target": 3, "ntd11": 2, "sensitive": 1}
TARGET_OVERLAP_IOU = 0.20
TARGET_CONTAINMENT = 0.60
HAND_CONFIDENCE = 0.395
HAND_SAM_MIN_SCORE = 0.88
HAND_MAX_REMOVAL_RATIO = 0.70
HAND_MIN_OVERLAP_PIXELS = 32
HAND_MIN_REMAINING_RATIO = 0.15
HAND_MIN_REMAINING_PIXELS = 32
HAND_BOX_PADDING_RATIO = 0.03
HAND_BOX_PADDING_MIN = 2
HAND_BOX_PADDING_MAX = 16
# Candidate metadata crosses the API as stable tokens.  The browser owns every
# user-facing label, so successful API payloads never carry localized copy.
DEFAULT_COLORS = {
    "pussy": "#ed6a5a",
    "penis": "#e6b450",
    "anus": "#a8c256",
    "testicles": "#5bb6d5",
}
DEFAULT_DETECTION_CONFIDENCE = 0.50
SECONDARY_MIN_CONFIDENCE = 0.50
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_BODY_BYTES = 80 * 1024 * 1024
IO_CHUNK_BYTES = 1024 * 1024
THUMBNAIL_WORKERS = 4
SAVE_TOKEN_TTL_SECONDS = 10 * 60
LOGGER = logging.getLogger(__name__)
PUBLIC_ERROR_PARAMS: dict[str, frozenset[str]] = {
    "gpu_out_of_memory": frozenset({"parallelism"}),
}


def public_error_params(error_code: str, params: dict[str, Any]) -> dict[str, Any]:
    """Return the small, documented parameter set that may cross the HTTP boundary."""
    allowed = PUBLIC_ERROR_PARAMS.get(error_code, frozenset())
    return {name: params[name] for name in allowed if name in params}


def torch_module() -> Any:
    """Load PyTorch only for GPU-backed operations, never during test startup."""
    try:
        import torch
        return torch
    except ImportError:
        return type("NoTorch", (), {"cuda": type("NoCuda", (), {
            "is_available": staticmethod(lambda: False),
            "device_count": staticmethod(lambda: 0),
            "get_device_name": staticmethod(lambda _index: ""),
        })})()
LOG_FORMAT = "%(asctime)s | %(levelname)s | %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
JOB_LABELS = {"detect": "自動検出", "apply": "ファイル保存"}

class ClientError(ValueError):
    """An invalid request that can be shown directly in the UI."""

    def __init__(self, message: str, error_code: str, params: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.params = params or {}


class ForbiddenClientError(ClientError):
    """A request that was not issued by this local browser session."""


class StaleMaskError(LookupError):
    """A candidate mask was removed while a browser still referenced it."""


def oriented_image_size(image: Image.Image) -> tuple[int, int]:
    width, height = image.size
    if image.getexif().get(274, 1) in {5, 6, 7, 8}:
        return height, width
    return width, height


def safe_import_relative_path(value: Any) -> Path:
    """Validate a client-provided TEMP-session relative path."""
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ClientError("画像の相対パスが不正です。", "input_invalid")
    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) >= 2 and normalized[1] == ":"):
        raise ClientError("画像の相対パスが不正です。", "input_invalid")
    parts = normalized.split("/")
    if any(not part or part in {".", ".."} or ":" in part for part in parts):
        raise ClientError("画像の相対パスが不正です。", "input_invalid")
    return Path(*parts)


@dataclass
class ImageRecord:
    image_id: str
    path: Path
    relative_path: str
    width: int
    height: int
    mtime_ns: int
    size_bytes: int = 0
    # Browser imports are copied to Mozarie's session directory.  Their source
    # File metadata remains the durable project fingerprint, while this pair
    # tracks the copied asset actually served and edited in this process.
    # These values deliberately never enter workspace.sqlite3.
    asset_mtime_ns: int | None = field(default=None, repr=False)
    asset_size_bytes: int | None = field(default=None, repr=False)
    source_kind: str = "filesystem"
    asset_revision: int = 0
    hidden: bool = False
    reviewed: bool = False
    # A project may combine independent folders or browser selections.  The
    # opaque source id keeps identical relative paths distinct.
    source_id: str | None = None
    source_root: Path | None = None

    def asset_fingerprint(self) -> tuple[int, int]:
        if self.asset_mtime_ns is None or self.asset_size_bytes is None:
            return self.mtime_ns, self.size_bytes
        return self.asset_mtime_ns, self.asset_size_bytes

    def set_asset_fingerprint(self, mtime_ns: int, size_bytes: int) -> None:
        self.asset_mtime_ns = mtime_ns
        self.asset_size_bytes = size_bytes


@dataclass(frozen=True)
class BrowserSaveToken:
    image_id: str
    candidate_revision: int
    source_fingerprint: tuple[int, int]
    catalog_generation: int
    issued_at: float
    rendered_path: Path | None
    # Only a newly-created Mozarie copy is cancellable.  Existing source files
    # are never represented here.
    output_path: Path | None = None
    output_fingerprint: tuple[int, int] | None = None
    allow_copy_action: bool = False


@dataclass(frozen=True)
class BrowserSaveRender:
    """Rendered output and the opaque confirmation token for one browser save."""

    output: bytes
    record: ImageRecord
    candidate_revision: int
    save_token: str
    output_path: Path | None

    def __iter__(self):
        yield self.output
        yield self.record
        yield self.candidate_revision
        yield self.save_token


@dataclass(frozen=True)
class BrowserSaveReceipt:
    """Completed browser save kept briefly so a lost response can be retried safely."""

    image_id: str
    candidate_revision: int
    source_action: str
    cleared: bool
    stale: bool
    deleted: bool
    completed_at: float


@dataclass
class Job:
    kind: str = "idle"
    state: str = "idle"
    total: int = 0
    completed: int = 0
    current: str = ""
    error: str = ""
    error_code: str = ""
    cancel_requested: bool = False
    params: dict[str, Any] = field(default_factory=dict)
    started_at: float | None = None
    ended_at: float | None = None
    paused_at: float | None = None
    paused_seconds: float = 0.0
    outputs: list[str] = field(default_factory=list)
    image_ids: tuple[str, ...] = ()
    completed_image_ids: tuple[str, ...] = ()
    active_count: int = 0
    parallelism: int = 0
    preparing_models: int = 0

    def as_dict(self) -> dict[str, Any]:
        active_elapsed = 0.0
        if self.started_at is not None:
            active_elapsed = max(0.0, (self.paused_at or self.ended_at or time.time()) - self.started_at - self.paused_seconds)
        return {
            "kind": self.kind,
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "current": self.current,
            "errorCode": self.error_code,
            "params": public_error_params(self.error_code, self.params),
            "startedAt": self.started_at,
            "activeElapsed": active_elapsed,
            "outputs": self.outputs,
            "imageIds": list(self.image_ids),
            "completedImageIds": list(self.completed_image_ids),
            "activeCount": self.active_count,
            "parallelism": self.parallelism,
            "phase": "preparing_models" if self.preparing_models else "",
            "cancelRequested": self.cancel_requested,
        }


@dataclass
class JobControl:
    pause_requested: threading.Event = field(default_factory=threading.Event)
    cancel_requested: threading.Event = field(default_factory=threading.Event)
    claim_lock: threading.Lock = field(default_factory=threading.Lock)
    failed: threading.Event = field(default_factory=threading.Event)


class InferenceGate:
    """Re-entrant inference gate with the Lock inspection used by tests/UI guards."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._depth = threading.local()

    def __enter__(self) -> "InferenceGate":
        depth = getattr(self._depth, "value", 0)
        if depth == 0:
            self._lock.acquire()
        self._depth.value = depth + 1
        return self

    def __exit__(self, *_args: Any) -> None:
        depth = self._depth.value - 1
        self._depth.value = depth
        if depth == 0:
            self._lock.release()

    def locked(self) -> bool:
        return self._lock.locked()


def detection_tiles(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Full image plus 65%-sized overlapping horizontal, vertical, and corner tiles."""
    tile_width = min(width, max(1, math.ceil(width * 0.65)))
    tile_height = min(height, max(1, math.ceil(height * 0.65)))
    x_offsets = (0, max(0, width - tile_width))
    y_offsets = (0, max(0, height - tile_height))
    specs = [(0, 0, width, height)]
    specs.extend((x, 0, tile_width, height) for x in x_offsets)
    specs.extend((0, y, width, tile_height) for y in y_offsets)
    specs.extend((x, y, tile_width, tile_height) for x in x_offsets for y in y_offsets)
    unique_specs: list[tuple[int, int, int, int]] = []
    for spec in specs:
        if spec not in unique_specs:
            unique_specs.append(spec)
    return unique_specs


def restore_tile_mask(mask: np.ndarray, full_width: int, full_height: int, x_offset: int, y_offset: int) -> np.ndarray:
    """Place a tile-local binary mask in its exact original-image coordinates."""
    tile_height, tile_width = mask.shape[:2]
    restored = np.zeros((full_height, full_width), dtype=np.uint8)
    restored[y_offset:y_offset + tile_height, x_offset:x_offset + tile_width] = mask
    return restored


def tile_mask_area(mask: np.ndarray) -> int:
    """Count a tile-local binary mask once for sparse duplicate arbitration."""
    return int(np.count_nonzero(mask))


def tile_mask_bbox(mask: np.ndarray, x_offset: int, y_offset: int) -> tuple[int, int, int, int]:
    """Return the original-image bounding box without materialising that image."""
    occupied_rows = np.flatnonzero(np.any(mask > 0, axis=1))
    occupied_columns = np.flatnonzero(np.any(mask > 0, axis=0))
    if not len(occupied_rows) or not len(occupied_columns):
        return (x_offset, y_offset, x_offset, y_offset)
    return (
        x_offset + int(occupied_columns[0]),
        y_offset + int(occupied_rows[0]),
        x_offset + int(occupied_columns[-1]) + 1,
        y_offset + int(occupied_rows[-1]) + 1,
    )


def tile_mask_overlap(left: dict[str, Any], right: dict[str, Any]) -> int:
    """Count overlap between two masks kept in their own tile coordinates."""
    left_x, left_y = left["tile_offset"]
    right_x, right_y = right["tile_offset"]
    left_mask = np.asarray(left["mask"]) > 0
    right_mask = np.asarray(right["mask"]) > 0
    left_box = left["tile_bbox"]
    right_box = right["tile_bbox"]
    x0 = max(left_box[0], right_box[0])
    y0 = max(left_box[1], right_box[1])
    x1 = min(left_box[2], right_box[2])
    y1 = min(left_box[3], right_box[3])
    if x0 >= x1 or y0 >= y1:
        return 0
    left_region = left_mask[y0 - left_y:y1 - left_y, x0 - left_x:x1 - left_x]
    right_region = right_mask[y0 - right_y:y1 - right_y, x0 - right_x:x1 - right_x]
    return int(np.count_nonzero(left_region & right_region))


def tile_segments_overlap(left: dict[str, Any], right: dict[str, Any], iou_threshold: float, containment_threshold: float) -> bool:
    """Match ``segment_overlaps`` without allocating original-image masks."""
    if left["class_name"] != right["class_name"]:
        return False
    overlap = tile_mask_overlap(left, right)
    if overlap == 0:
        return False
    left_area = int(left["tile_area"])
    right_area = int(right["tile_area"])
    union = left_area + right_area - overlap
    return (
        overlap / union >= iou_threshold
        or overlap / min(left_area, right_area) >= containment_threshold
    )


def materialize_tile_mask(segment: dict[str, Any], full_width: int, full_height: int) -> dict[str, Any]:
    """Convert a surviving sparse tile candidate to the established full mask."""
    output = dict(segment)
    x_offset, y_offset = output.pop("tile_offset")
    output.pop("tile_area", None)
    output.pop("tile_bbox", None)
    output["mask"] = restore_tile_mask(output["mask"], full_width, full_height, x_offset, y_offset)
    return output


def mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    left_bool = left > 0
    right_bool = right > 0
    union = np.count_nonzero(left_bool | right_bool)
    if union == 0:
        return 0.0
    return float(np.count_nonzero(left_bool & right_bool) / union)


def mask_containment(left: np.ndarray, right: np.ndarray) -> float:
    """Return overlap relative to the smaller non-empty mask."""
    left_bool = left > 0
    right_bool = right > 0
    smallest = min(np.count_nonzero(left_bool), np.count_nonzero(right_bool))
    if smallest == 0:
        return 0.0
    return float(np.count_nonzero(left_bool & right_bool) / smallest)


def segment_overlaps(left: dict[str, Any], right: dict[str, Any], iou_threshold: float, containment_threshold: float) -> bool:
    return (
        left["class_name"] == right["class_name"]
        and (
            mask_iou(left["mask"], right["mask"]) >= iou_threshold
            or mask_containment(left["mask"], right["mask"]) >= containment_threshold
        )
    )


def _segment_rank(segment: dict[str, Any]) -> tuple[int, float]:
    return (SOURCE_PRIORITY.get(str(segment["source"]), 0), float(segment["confidence"]))


def merge_segment(
    segments: list[dict[str, Any]],
    class_name: str,
    confidence: float,
    mask: np.ndarray,
    source: str = "target",
    iou_threshold: float = 0.75,
    containment_threshold: float = 0.95,
) -> None:
    """Keep one precise representative for overlapping tile/model duplicates."""
    matching = [
        segment
        for segment in segments
        if segment["class_name"] == class_name
        and (
            mask_iou(segment["mask"], mask) >= iou_threshold
            or mask_containment(segment["mask"], mask) >= containment_threshold
        )
    ]
    if not matching:
        segments.append({"class_name": class_name, "confidence": confidence, "mask": mask, "source": source})
        return
    candidate = {"class_name": class_name, "confidence": confidence, "mask": mask, "source": source}
    winner = max([*matching, candidate], key=_segment_rank)
    for duplicate in matching:
        segments.remove(duplicate)
    segments.append(winner)


def merge_tile_segment(
    segments: list[dict[str, Any]],
    class_name: str,
    confidence: float,
    mask: np.ndarray,
    x_offset: int,
    y_offset: int,
    source: str = "target",
    iou_threshold: float = 0.75,
    containment_threshold: float = 0.95,
) -> None:
    """Keep tile masks sparse until duplicate removal has finished.

    This mirrors ``merge_segment`` including its ordering/tie behaviour, but
    does not allocate a full-resolution zero-filled array for every candidate.
    """
    candidate = {
        "class_name": class_name,
        "confidence": confidence,
        "mask": mask,
        "source": source,
        "tile_offset": (x_offset, y_offset),
        "tile_area": tile_mask_area(mask),
        "tile_bbox": tile_mask_bbox(mask, x_offset, y_offset),
    }
    matching = [
        segment
        for segment in segments
        if tile_segments_overlap(segment, candidate, iou_threshold, containment_threshold)
    ]
    if not matching:
        segments.append(candidate)
        return
    winner = max([*matching, candidate], key=_segment_rank)
    for duplicate in matching:
        segments.remove(duplicate)
    segments.append(winner)


def arbitrate_segment_sources(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer tighter precise segments without merging distinct nearby organs."""
    ordered = sorted(
        segments,
        key=lambda segment: (-SOURCE_PRIORITY.get(str(segment["source"]), 0), -float(segment["confidence"])),
    )
    accepted: list[dict[str, Any]] = []
    for segment in ordered:
        duplicate = False
        for winner in accepted:
            if winner["source"] == segment["source"]:
                continue
            if winner["source"] == "target" or segment["source"] == "target":
                iou_threshold, containment_threshold = TARGET_OVERLAP_IOU, TARGET_CONTAINMENT
            else:
                iou_threshold, containment_threshold = 0.75, 0.95
            if segment_overlaps(winner, segment, iou_threshold, containment_threshold):
                duplicate = True
                break
        if not duplicate:
            accepted.append(segment)
    return accepted


def refine_mask_with_hand(mask: np.ndarray, hand_mask: np.ndarray) -> tuple[np.ndarray, str]:
    """Remove a SAM-confirmed hand overlap while retaining a usable genital mask."""
    genital = np.asarray(mask > 0, dtype=np.uint8)
    hand = np.asarray(hand_mask > 0, dtype=np.uint8)
    area = int(np.count_nonzero(genital))
    if area == 0 or hand.shape != genital.shape:
        return mask, "skipped"
    removed = (genital > 0) & (hand > 0)
    removal_count = int(np.count_nonzero(removed))
    if removal_count < HAND_MIN_OVERLAP_PIXELS:
        return mask, "unchanged"
    if removal_count / area > HAND_MAX_REMOVAL_RATIO:
        return mask, "over_cap"
    remaining = area - removal_count
    if remaining < max(math.ceil(area * HAND_MIN_REMAINING_RATIO), HAND_MIN_REMAINING_PIXELS):
        return mask, "too_small"
    refined = genital.copy()
    refined[removed] = 0
    return refined.astype(np.uint8) * 255, "refined"


def padded_hand_box(box: tuple[int, int, int, int], shape: tuple[int, int]) -> tuple[int, int, int, int] | None:
    """Expand a detected hand box slightly while keeping it inside the image."""
    left, top, right, bottom = box
    height, width = shape
    padding = max(HAND_BOX_PADDING_MIN, min(HAND_BOX_PADDING_MAX, math.ceil(max(right - left, bottom - top) * HAND_BOX_PADDING_RATIO)))
    left, top = max(0, left - padding), max(0, top - padding)
    right, bottom = min(width, right + padding), min(height, bottom + padding)
    return (left, top, right, bottom) if left < right and top < bottom else None


def accepted_hand_sam_mask(
    masks: np.ndarray, scores: np.ndarray, expected_shape: tuple[int, int], box: tuple[int, int, int, int]
) -> np.ndarray | None:
    """Return a high-confidence SAM hand mask contained by its padded detection box."""
    left, top, right, bottom = box
    if len(masks) == 0 or len(scores) == 0 or len(masks) != len(scores):
        raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。", "outline_not_found")
    box_area = (right - left) * (bottom - top)
    for index in np.argsort(-np.asarray(scores), kind="stable"):
        score = float(scores[index])
        if score < HAND_SAM_MIN_SCORE:
            break
        hand_mask = np.asarray(masks[index])
        if hand_mask.shape[:2] != expected_shape:
            continue
        hand = np.asarray(hand_mask > 0, dtype=np.uint8)
        total = int(np.count_nonzero(hand))
        if total == 0:
            continue
        inside = int(np.count_nonzero(hand[top:bottom, left:right]))
        if inside / total < 0.85:
            continue
        clipped = np.zeros_like(hand, dtype=np.uint8)
        clipped[top:bottom, left:right] = hand[top:bottom, left:right]
        clipped_area = int(np.count_nonzero(clipped))
        if 0.03 <= clipped_area / box_area <= 0.95:
            return clipped * 255
    return None


def accepted_specialist_hand_mask(
    masks: np.ndarray, expected_shape: tuple[int, int], box: tuple[int, int, int, int],
) -> np.ndarray | None:
    """Accept a bounded HandSegNet result."""
    left, top, right, bottom = box
    box_area = max(1, (right - left) * (bottom - top))
    for raw_mask in masks:
        mask = np.asarray(raw_mask > 0, dtype=np.uint8)
        if mask.shape != expected_shape or not np.any(mask):
            continue
        inside = int(np.count_nonzero(mask[top:bottom, left:right]))
        total = int(np.count_nonzero(mask))
        if inside / total < 0.85 or not 0.03 <= inside / box_area <= 0.95:
            continue
        clipped = np.zeros_like(mask, dtype=np.uint8)
        clipped[top:bottom, left:right] = mask[top:bottom, left:right]
        return clipped * 255
    return None


def read_detection_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("判定しきい値が正しくありません。", "input_invalid") from exc
    if not 0.10 <= confidence <= 1.00:
        raise ClientError("判定しきい値は0.10から1.00の範囲で指定してください。", "input_invalid")
    return confidence


def read_boundary_request(payload: dict[str, Any], width: int, height: int) -> tuple[tuple[int, int, int, int], tuple[float, float]]:
    """Validate a SAM point prompt and its limiting ROI in image coordinates."""
    try:
        roi_data = payload["roi"]
        point_data = payload["point"]
        left = int(round(float(roi_data["left"])))
        top = int(round(float(roi_data["top"])))
        right = int(round(float(roi_data["right"])))
        bottom = int(round(float(roi_data["bottom"])))
        point = (float(point_data["x"]), float(point_data["y"]))
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ClientError("境界の範囲またはクリック位置が正しくありません。", "input_invalid") from exc

    if not all(math.isfinite(value) for value in (*point,)):
        raise ClientError("境界のクリック座標が正しくありません。", "input_invalid")
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ClientError("境界の範囲は画像内にドラッグしてください。", "input_invalid")
    inside_x = left <= point[0] < right or (right == width and point[0] == width)
    inside_y = top <= point[1] < bottom or (bottom == height and point[1] == height)
    if not (inside_x and inside_y):
        raise ClientError("クリック位置は選択範囲の内側にしてください。", "input_invalid")
    return (left, top, right, bottom), (min(point[0], width - 1), min(point[1], height - 1))


def read_polygon_boundary_request(payload: dict[str, Any], width: int, height: int) -> tuple[tuple[int, int, int, int], tuple[float, float], np.ndarray]:
    """Validate a four-point boundary and return one SAM box/point prompt."""

    raw_points = payload.get("points")
    if not isinstance(raw_points, list):
        raise ClientError("4点境界の座標が正しくありません。", "input_invalid")
    try:
        points = tuple((float(point["x"]), float(point["y"])) for point in raw_points)
        return polygon_roi_and_point(points, width, height)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ClientError("4点境界は画像内の4点で指定してください。", "input_invalid") from exc


def clip_mask_to_roi(mask: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    """Keep only the part of a SAM mask inside the user-selected ROI."""
    left, top, right, bottom = roi
    clipped = np.zeros_like(mask, dtype=np.uint8)
    clipped[top:bottom, left:right] = np.asarray(mask[top:bottom, left:right] > 0, dtype=np.uint8) * 255
    return clipped


def select_best_sam_mask(masks: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, float]:
    """Select SAM's highest-scoring proposed object mask."""
    if len(masks) == 0 or len(scores) == 0 or len(masks) != len(scores):
        raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。", "outline_not_found")
    index = int(np.argmax(scores))
    return np.asarray(masks[index]), float(scores[index])


def sam_refinement_prompts(source_mask: np.ndarray, hand_mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Build deterministic SAM points from detector certainty, never fluid proposals."""
    source = np.asarray(source_mask > 0, dtype=np.uint8)
    hand = np.asarray(hand_mask > 0, dtype=np.uint8)
    if source.shape != hand.shape or not np.any(source):
        return np.empty((0, 2), dtype=np.float32), np.empty((0,), dtype=np.int32)
    safe = source & (1 - hand)
    eroded = cv2.erode(safe, np.ones((3, 3), dtype=np.uint8))
    if not np.any(eroded):
        distance = cv2.distanceTransform(source, cv2.DIST_L2, 3)
        y, x = np.unravel_index(int(np.argmax(distance)), distance.shape)
        return np.asarray([[x, y]], dtype=np.float32), np.asarray([1], dtype=np.int32)
    source_distance = cv2.distanceTransform(eroded, cv2.DIST_L2, 3)
    count = 1 if np.count_nonzero(eroded) < 64 else 3
    first_y, first_x = np.unravel_index(int(np.argmax(source_distance)), source_distance.shape)
    selected = [(int(first_y), int(first_x))]
    # Distance-transforming the inverse seed mask avoids materializing every
    # candidate coordinate or an N-by-selected-point distance matrix.
    inverse_seeds = np.ones_like(eroded, dtype=np.uint8)
    inverse_seeds[first_y, first_x] = 0
    for _index in range(1, count):
        selected_distance = cv2.distanceTransform(inverse_seeds, cv2.DIST_L2, 3)
        farthest_distance = np.where(eroded > 0, selected_distance, -1.0)
        farthest = farthest_distance == np.max(farthest_distance)
        # np.argmax remains row-major on equal source depth, preserving the
        # previous y/x tie-break without a candidate sort.
        choice_y, choice_x = np.unravel_index(
            int(np.argmax(np.where(farthest, source_distance, -1.0))), source_distance.shape
        )
        selected.append((int(choice_y), int(choice_x)))
        inverse_seeds[choice_y, choice_x] = 0
    points = [[x, y] for y, x in selected]
    negative = source & hand
    if np.any(negative):
        distance = cv2.distanceTransform(negative, cv2.DIST_L2, 3)
        y, x = np.unravel_index(int(np.argmax(distance)), distance.shape)
        points.append([int(x), int(y)])
        labels = [1] * len(selected) + [0]
    else:
        labels = [1] * len(selected)
    return np.asarray(points, dtype=np.float32), np.asarray(labels, dtype=np.int32)


def select_semantic_sam_mask(
    masks: np.ndarray, scores: np.ndarray, source_mask: np.ndarray, hand_mask: np.ndarray,
    point_coords: np.ndarray, point_labels: np.ndarray,
) -> tuple[np.ndarray, int] | None:
    """Choose only a SAM proposal that preserves detector semantics and avoids hands."""
    source = np.asarray(source_mask > 0, dtype=bool)
    hand = np.asarray(hand_mask > 0, dtype=bool)
    source_area = int(np.count_nonzero(source))
    if source_area == 0 or len(masks) != len(scores):
        return None
    positive = point_coords[point_labels == 1].astype(int)
    negative = point_coords[point_labels == 0].astype(int)
    choices: list[tuple[tuple[float, float, float, int], np.ndarray, int]] = []
    for index, raw_mask in enumerate(masks):
        mask = np.asarray(raw_mask > 0, dtype=bool)
        if mask.shape != source.shape:
            continue
        if any(not (0 <= x < mask.shape[1] and 0 <= y < mask.shape[0]) or not mask[y, x] for x, y in positive):
            continue
        if any(0 <= x < mask.shape[1] and 0 <= y < mask.shape[0] and mask[y, x] for x, y in negative):
            continue
        area = int(np.count_nonzero(mask))
        if not source_area // 4 <= area <= source_area * 3:
            continue
        overlap = int(np.count_nonzero(mask & source))
        hand_overlap = int(np.count_nonzero(mask & hand))
        hand_ratio = hand_overlap / max(1, area)
        if hand_ratio > 0.15:
            continue
        retention = overlap / source_area
        if retention < 0.50:
            continue
        # Deterministic selection is intentionally limited to the semantic
        # gates above, then retention and SAM's own score.
        choices.append(((-retention, -float(scores[index]), hand_ratio, index), mask.astype(np.uint8) * 255, index))
    if not choices:
        return None
    _rank, mask, index = min(choices, key=lambda choice: choice[0])
    return mask, index


def confidence_for_source(source: str, confidence: float) -> float:
    if source == "ntd11":
        return max(0.10, confidence - 0.15)
    if source == "sensitive":
        return max(confidence, SECONDARY_MIN_CONFIDENCE)
    return confidence


def _read_mosaic_divisor(value: Any) -> int:
    try:
        divisor = int(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("モザイク粗さが正しくありません。", "input_invalid") from exc
    if not 1 <= divisor <= 10000:
        raise ClientError("モザイク粗さの分母は1から10000の範囲で指定してください。", "input_invalid")
    return divisor


def _read_detection_parallelism(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 4:
        raise ClientError("並列数は1から4で指定してください。", "input_invalid")
    return value


def _read_save_suffix(value: Any) -> str:
    if not isinstance(value, str) or any(ord(character) < 32 or character in '<>:"/\\|?*' for character in value):
        raise ClientError("ファイル名の末尾に使えない文字があります。", "input_invalid")
    return value


def _read_target_classes(value: Any) -> set[str]:
    if not isinstance(value, (list, tuple, set)):
        raise ClientError("検出対象の形式が正しくありません。", "input_invalid")
    targets = {str(item) for item in value}
    if not targets or not targets <= TARGET_CLASSES:
        raise ClientError("検出対象は penis または pussy を選択してください。", "input_invalid")
    return targets
