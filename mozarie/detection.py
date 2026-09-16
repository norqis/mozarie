from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import ExitStack
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import cv2
from PIL import Image, ImageOps, PngImagePlugin

from .core import (
    DEFAULT_COLORS, DEFAULT_DETECTION_CONFIDENCE, HAND_CONFIDENCE,
    DETECTED_TARGET_CLASSES, TARGET_CLASSES, Candidate, CandidateRole,
    ClientError, HAND_MAX_REMOVAL_RATIO, ImageRecord, JobControl, LOGGER, accepted_hand_sam_mask,
    accepted_specialist_hand_mask, arbitrate_segment_sources, clip_mask_to_roi,
    confidence_for_source, detection_tiles, mask_iou, materialize_tile_mask,
    merge_tile_segment, padded_hand_box, read_boundary_request,
    read_polygon_boundary_request, sam_refinement_prompts,
    sam_hand_overlap_negative_points,
    refine_mask_with_hand,
    select_best_sam_mask, select_semantic_sam_mask,
    torch_module, _read_detection_parallelism, _read_target_classes,
)
from .fluid import expand_white_fluid_mask, white_fluid_mask
from .image_io import canonical_image
from .runtime import runtime_backend
from .runtime_types import DetectionModels

if TYPE_CHECKING:
    from .inference.generic_yolo_segment import GenericYoloSegmenter
    from .inference.yolo_detect import HandDetector


_SCENE_FLUID_TAGS = frozenset({"cum_on_breasts", "cum on fingers", "cum on ass", "cum in pussy"})


def _scene_fluid_tags(info: dict[str, Any]) -> frozenset[str]:
    """Read only the exact Scene prompt tags that opt into local fluid search."""
    positive = info.get("scene_positive")
    if positive is None:
        scene_info = info.get("scene_info")
        if not isinstance(scene_info, str):
            return frozenset()
        try:
            decoded = json.loads(scene_info)
        except (TypeError, ValueError):
            return frozenset()
        if not isinstance(decoded, dict):
            return frozenset()
        positive = decoded.get("positive")
    if not isinstance(positive, str):
        return frozenset()
    return frozenset(tag for tag in (value.strip().casefold() for value in positive.split(",")) if tag in _SCENE_FLUID_TAGS)


def _mask_bounds(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    rows, columns = np.nonzero(np.asarray(mask) > 0)
    if not rows.size:
        return None
    return int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1


def _fill_metadata_fluid_roi(search: np.ndarray, left: float, top: float, right: float, bottom: float) -> None:
    height, width = search.shape
    search[max(0, round(top)):min(height, round(bottom)), max(0, round(left)):min(width, round(right))] = 1


def _inference_pixels(image: Image.Image) -> tuple[np.ndarray, np.ndarray | None]:
    """Return detector pixels and the visible-image mask in edit coordinates."""
    has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
    if not has_alpha:
        return np.asarray(image.convert("RGB")).copy(), None
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba)[:, :, 3].copy()
    background = Image.new("RGBA", image.size, (0, 0, 0, 255))
    background.alpha_composite(rgba)
    return np.asarray(background.convert("RGB")).copy(), alpha


def _clip_detection_masks_to_alpha(segments: list[dict[str, Any]], alpha: np.ndarray | None) -> None:
    """Keep published APPLY and EXCLUDE masks inside visible source pixels."""
    if alpha is None:
        return
    visible = alpha > 0
    clipped: dict[int, np.ndarray] = {}

    def clip(mask: Any) -> np.ndarray:
        value = np.asarray(mask)
        key = id(value)
        if key not in clipped:
            clipped[key] = np.where(visible, value, 0)
        return clipped[key]

    for segment in segments:
        for key in ("mask", "_detector_mask", "_apply_mask", "_confirmed_hand"):
            if key in segment:
                segment[key] = clip(segment[key])
        for key in ("image_exclusions", "metadata_exclusions", "exclusions"):
            masks = segment.get(key)
            if isinstance(masks, dict):
                segment[key] = {name: clip(mask) for name, mask in masks.items()}


def TargetSegmenter(*args: Any, **kwargs: Any) -> Any:
    from .inference.yolo_segment import TargetSegmenter as implementation
    return implementation(*args, **kwargs)


def GenericYoloSegmenter(*args: Any, **kwargs: Any) -> Any:
    from .inference.generic_yolo_segment import GenericYoloSegmenter as implementation
    return implementation(*args, **kwargs)


def HandDetector(*args: Any, **kwargs: Any) -> Any:
    from .inference.yolo_detect import HandDetector as implementation
    return implementation(*args, **kwargs)


def _save_binary_mask(mask: Any, path: Path) -> None:
    """Persist every non-zero mask pixel as fully opaque PNG data."""

    binary = np.where(np.asarray(mask) > 0, 255, 0).astype(np.uint8)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("mozarie_expand_px", "0")
    Image.fromarray(binary).save(path, format="PNG", pnginfo=metadata)


class DetectionMixin:
    def start_detection(
        self,
        image_ids: list[str],
        confidence: float = DEFAULT_DETECTION_CONFIDENCE,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
        *,
        fluid_color_fill: tuple[bool, int] | None = None,
    ) -> None:
        # The gate makes initial job setup mutually exclusive with boundary
        # inference and model-cache replacement.
        with self.inference_lock:
            self._require_supported_gpu()
            records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    if self.catalog_generation != catalog_generation or any(self.images.get(record.image_id) is not record for record in records):
                        raise ClientError("画像一覧が更新されました。もう一度実行してください。", "catalog_changed")
                    self._synchronize_workspace_candidate_revisions(records)
                    for record in records:
                        self._assert_image_editable(record.image_id)
            targets = _read_target_classes(target_classes or set(self.settings["detection"]["targets"]))
            # Every successfully published result belongs to one undo group.
            # Candidates remain staged until every target is ready, then the
            # group is published as one SQLite transaction.
            history_store = self.workspace_store
            history_group = history_store.begin_history_group()
            try:
                # Capture every per-run option before the worker starts.  A saved
                # settings change must never alter only the latter images of one
                # detection run.
                detection = self.settings["detection"]
                detection_options = {
                    "mode": str(detection["mode"]),
                    "fluid_exclusion_enabled": bool(detection["fluid_exclusion_enabled"]),
                    "fluid_color_fill": fluid_color_fill if fluid_color_fill is not None else (
                        bool(detection["fluid_color_fill_enabled"]),
                        int(detection["fluid_color_fill_tolerance"]),
                    ),
                    "default_padding": int(detection["default_candidate_padding_px"]),
                    "default_exclude_padding": int(detection["default_exclude_candidate_padding_px"]),
                }
                LOGGER.info(
                    "自動検出開始: 対象=%d件 精液候補の色拡張=%s 許容範囲=%d",
                    len(records),
                    "ON" if detection_options["fluid_color_fill"][0] else "OFF",
                    detection_options["fluid_color_fill"][1],
                )
                args: tuple[Any, ...] = (
                    confidence,
                    _read_detection_parallelism(parallelism),
                    targets,
                    detection_options,
                    history_group,
                )
                self._start_job("detect", records, self._detect_worker, *args, expected_catalog_generation=catalog_generation)
            except Exception:
                history_store.finish_history_group(history_group, failed=True)
                raise


    def _load_detection_models(self) -> DetectionModels:
        model_path = self._configured_model_path("target_segmentation", "対象セグメンテーション")
        provider = str(self.settings["models"].get("provider", "gpu"))
        gpu_device = int(self.settings["models"].get("gpu_device", 0))
        try:
            target = TargetSegmenter(model_path, device=provider, gpu_device=gpu_device)
        except ClientError:
            raise
        except Exception as exc:
            raise ClientError("検出モデルを読み込めません。モデルファイルを確認して、もう一度実行してください。", "model_load_failed") from exc
        auxiliaries: list[tuple[str, GenericYoloSegmenter]] = []
        for key, label in (("ntd11", "NTD11補助モデル"), ("sensitive", "Sensitive補助モデル")):
            if not self.settings["models"][f"{key}_enabled"]:
                continue
            try:
                auxiliary = GenericYoloSegmenter(self._configured_model_path(key, label), device=provider, gpu_device=gpu_device)
            except ClientError:
                raise
            except Exception as exc:
                raise ClientError("検出モデルを読み込めません。モデルファイルを確認して、もう一度実行してください。", "model_load_failed") from exc
            auxiliaries.append((key, auxiliary))
        return DetectionModels(target=target, auxiliaries=auxiliaries)

    def _configured_model_path(self, key: str, label: str) -> Path:
        raw_path = str(self.settings.get("models", {}).get(key, "")).strip()
        if not raw_path:
            raise ClientError(f"{label}モデルが未設定です。設定のモデルタブでONNXファイルを指定してください。", "model_not_configured")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            raise ClientError(f"{label}モデルには絶対パスを指定してください。", "model_file_invalid")
        if not path.is_file():
            raise ClientError(f"{label}モデルが見つかりません。設定で指定し直してください。", "model_file_missing")
        if path.suffix.lower() != ".onnx":
            raise ClientError(f"{label}モデルにはONNXファイルを指定してください。", "model_file_invalid")
        return path

    def _configured_sam_path(self) -> Path:
        models = self.settings.get("models", {})
        raw_path = str(models.get("sam_checkpoints", {}).get(models.get("sam_model_type"), "")).strip()
        if not raw_path:
            raise ClientError(
                "SAMモデルが未設定です。設定のモデルタブでチェックポイントを指定してください。",
                "sam_checkpoint_missing",
            )
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            raise ClientError("SAMモデルには絶対パスを指定してください。", "sam_checkpoint_invalid")
        if not path.is_file():
            raise ClientError("SAMモデルが見つかりません。設定で指定し直してください。", "model_file_missing")
        if path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
            raise ClientError("SAMチェックポイントは .pth、.pt、.ckpt のいずれかを指定してください。", "sam_checkpoint_invalid")
        return path

    def _ensure_models(self) -> DetectionModels:
        with self.lock:
            if self.models is not None:
                return self.models
        self._set_detection_model_preparation(True)
        try:
            models = self._load_detection_models()
        finally:
            self._set_detection_model_preparation(False)
        with self.lock:
            self.models = models
        return models

    def _ensure_hand_model(self, models: DetectionModels | None = None) -> HandDetector:
        with self.inference_lock:
            with self.lock:
                hand = self.hand_model
            if hand is None:
                self._set_detection_model_preparation(True)
                try:
                    model_path = self._configured_model_path("hand_detection", "手の検出")
                    provider = str(self.settings["models"].get("provider", "gpu"))
                    hand = HandDetector(model_path, device=provider, gpu_device=int(self.settings["models"].get("gpu_device", 0)))
                except ClientError:
                    raise
                except Exception as exc:
                    raise ClientError("検出モデルを読み込めません。モデルファイルを確認して、もう一度実行してください。", "model_load_failed") from exc
                finally:
                    self._set_detection_model_preparation(False)
                with self.lock:
                    self.hand_model = hand
            if models is not None:
                models.hand = hand
            return hand

    def _boundary_hand_boxes(self, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
        """Load only the hand detector for an interactive boundary request."""
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        return self._ensure_hand_model().detect_boxes(rgb, HAND_CONFIDENCE)

    def _detect_worker(
        self,
        records: list[ImageRecord],
        confidence: float,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
        detection_options: dict[str, Any] | None = None,
        history_group: str | None = None,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        models: DetectionModels | None = None
        staged: dict[str, tuple[int, ImageRecord, list[Candidate]]] = {}
        durable_published = False
        try:
            # Direct workers without a launch epoch snapshot it once before
            # any work; publication must
            # compare against that same value, never against ``None`` or a
            # later catalogue generation.
            if catalog_generation is None:
                with self.lock:
                    catalog_generation = self.catalog_generation
            if detection_options is None:
                detection = self.settings["detection"]
                detection_options = {
                    "mode": str(detection["mode"]),
                    "fluid_exclusion_enabled": bool(detection["fluid_exclusion_enabled"]),
                    "fluid_color_fill": (
                        bool(detection["fluid_color_fill_enabled"]),
                        int(detection["fluid_color_fill_tolerance"]),
                    ),
                    "default_padding": int(detection["default_candidate_padding_px"]),
                    "default_exclude_padding": int(detection["default_exclude_candidate_padding_px"]),
                }
            mode = str(detection_options["mode"])
            requested_parallelism = _read_detection_parallelism(parallelism)
            if runtime_backend(torch_module=torch_module()) == "directml":
                requested_parallelism = 1
            worker_count = min(requested_parallelism, len(records))
            self._set_job_parallelism(worker_count, job_generation, catalog_generation)
            self._wait_while_paused(control, job_generation, catalog_generation)
            if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                if history_group: self.workspace_store.finish_history_group(history_group, failed=True)
                self._cancel_job(job_generation, catalog_generation)
                return
            if not self._job_is_current(job_generation, catalog_generation):
                if history_group: self.workspace_store.finish_history_group(history_group, failed=True)
                return
            models = self._ensure_models()
            stage_lock = threading.Lock()

            def claim_and_run(index: int, record: ImageRecord) -> None:
                candidates: list[Candidate] = []
                try:
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    candidates = self._detect_image(
                        models,
                        record,
                        confidence,
                        mode,
                        target_classes or TARGET_CLASSES,
                        default_padding=int(detection_options["default_padding"]),
                        default_exclude_padding=int(detection_options["default_exclude_padding"]),
                        fluid_exclusion_enabled=bool(detection_options["fluid_exclusion_enabled"]),
                        fluid_color_fill=detection_options["fluid_color_fill"],
                    )
                    if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                        return
                    self._assert_record_stat_matches(record)
                    with self.lock:
                        if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                or not self._job_is_current(job_generation, catalog_generation)
                                or self.images.get(record.image_id) is not record):
                            return
                        expected_revision = self._candidate_revision(record.image_id)
                    with stage_lock:
                        staged[record.image_id] = (index, record, candidates)
                    candidates = []
                    # Staging is complete for this image, but its ID must not
                    # become durable/public until the all-or-nothing commit.
                    self._mark_job_processed(job_generation, catalog_generation)
                finally:
                    self._discard_candidates(candidates)
                    self.invalidate_sam_image(record.image_id)

            failures = self._run_fixed_workers(records, worker_count, claim_and_run, control, job_generation, catalog_generation)
            if failures:
                # ``claim_and_run`` closes over this variable. Clear the final
                # Python reference before OOM recovery drops state-owned models.
                if self._is_gpu_out_of_memory(failures[0][1]):
                    models = None
                if history_group: self.workspace_store.finish_history_group(history_group, failed=True)
                self._fail_job(failures[0][1], job_generation, catalog_generation)
                for _index, _record, candidates in staged.values():
                    self._discard_candidates(candidates)
                return
            if control is not None and control.cancel_requested.is_set():
                if history_group: self.workspace_store.finish_history_group(history_group, failed=True)
                self._cancel_job(job_generation, catalog_generation)
                for _index, _record, candidates in staged.values():
                    self._discard_candidates(candidates)
                return
            if len(staged) != len(records):
                raise ClientError("検出結果を公開できませんでした。", "catalog_changed")

            locks = [(record.image_id, self.image_io_lock(record.image_id)) for record in records]
            with ExitStack() as stack:
                for _image_id, image_lock in sorted(locks):
                    stack.enter_context(image_lock)
                with self.lock:
                    if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                            or not self._job_is_current(job_generation, catalog_generation)
                            or any(self.images.get(record.image_id) is not record for record in records)):
                        raise ClientError("フォルダを再読み込みしたため、検出結果を破棄しました。", "catalog_changed")
                    expected_revisions = {record.image_id: self._candidate_revision(record.image_id) for record in records}
                    previous = {
                        record.image_id: [candidate for candidate in self.candidates.get(record.image_id, [])]
                        for record in records
                    }
                combined: dict[str, list[Candidate]] = {
                    record.image_id: [
                        *[candidate for candidate in previous[record.image_id] if candidate.origin == "boundary"],
                        *staged[record.image_id][2],
                    ]
                    for record in records
                }
                try:
                    # Move each staged PNG before SQLite reads it.  Every
                    # candidate remains in ``staged`` while moving, so one
                    # failed move cleans both already-final files and pending
                    # files from the same run.
                    for record in records:
                        for candidate in staged[record.image_id][2]:
                            if candidate.mask_path.name.startswith(".mozarie-pending-"):
                                final_path = self.cache_dir / record.image_id / f"{candidate.candidate_id}.png"
                                os.replace(candidate.mask_path, final_path)
                                candidate.mask_path = final_path
                    # The source can change while model workers run.  Check it
                    # again with every image lock held directly before the
                    # durable state is prepared.
                    for record in records:
                        self._assert_record_stat_matches(record)
                    states = [
                        (record.image_id, expected_revisions[record.image_id], expected_revisions[record.image_id] + 1,
                         combined[record.image_id], self._effective_mask_for_candidates(record.image_id, combined[record.image_id]))
                        for record in records
                    ]
                    # All state-changing paths use catalogue lock -> workspace
                    # transaction.  Acquiring the catalogue lock before the
                    # prepared write avoids waiting on another edit that holds
                    # that lock while it writes SQLite.
                    with self.lock:
                        if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                or not self._job_is_current(job_generation, catalog_generation)
                                or any(self.images.get(record.image_id) is not record for record in records)
                                or any(self._candidate_revision(record.image_id) != expected_revisions[record.image_id] for record in records)):
                            raise ClientError("フォルダを再読み込みしたため、検出結果を破棄しました。", "catalog_changed")
                        # ``request_cancel`` takes this same lock. Once the
                        # atomic publication starts, it must not accept a
                        # cancellation that would report discarded results
                        # after they have become durable.
                        self.job.publication_started = True
                        try:
                            pending = self.workspace_store.prepare_detection_states(
                                states, history_group=history_group,
                            )
                        except ValueError as exc:
                            if str(exc) == "workspace candidate revision changed":
                                raise ClientError("候補が更新されたため、検出結果を破棄しました。もう一度実行してください。", "catalog_changed") from exc
                            raise
                        # SQLite and the process cache become visible under the
                        # same catalogue lock. A catalog transition cannot
                        # interleave this commit and the in-memory publish.
                        pending.commit()
                        durable_published = True
                        for record in records:
                            self.candidates[record.image_id] = combined[record.image_id]
                            self.candidate_revisions[record.image_id] = expected_revisions[record.image_id] + 1
                            record.reviewed = False
                            self._record_job_success(staged[record.image_id][0], record.image_id, None, job_generation, catalog_generation)
                except Exception:
                    for _index, _record, candidates in staged.values():
                        self._discard_candidates(candidates)
                    raise
                for record in records:
                    for candidate in previous[record.image_id]:
                        if candidate.origin != "boundary":
                            try:
                                candidate.mask_path.unlink(missing_ok=True)
                            except OSError:
                                # Old cache files are disposable.  Their
                                # cleanup must not turn a published history
                                # group into a failed operation.
                                pass
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            models = None
            if not durable_published:
                if history_group: self.workspace_store.finish_history_group(history_group, failed=True)
                for _index, _record, candidates in staged.values():
                    self._discard_candidates(candidates)
            self._fail_job(exc, job_generation, catalog_generation)
        finally:
            # ``claim_and_run`` closes over this value. Drop it before the
            # background runner clears state-owned models and the GPU cache.
            models = None

    def _discard_candidates(self, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            candidate.mask_path.unlink(missing_ok=True)

    def _detect_arbitrated_segments(
        self, models: DetectionModels, rgb: np.ndarray, confidence: float, target_classes: set[str] | None = None,
        scene_fluid_tags: frozenset[str] = frozenset(),
    ) -> list[dict[str, Any]]:
        rgb = np.asarray(rgb)
        height, width = rgb.shape[:2]
        targets = target_classes or TARGET_CLASSES
        model_targets = targets | ({"testicles"} if "penis" in targets else set())
        detector_targets = model_targets | ({"female_face"} if "cum_on_breasts" in scene_fluid_tags else set())
        segments = (models.target.detect(rgb, confidence, detector_targets) if detector_targets != TARGET_CLASSES
                    else models.target.detect(rgb, confidence))
        collected = [segment for segment in segments if segment["class_name"] in detector_targets and segment["mask"].shape == (height, width)]
        for source, model in models.auxiliaries:
            tiled_segments: list[dict[str, Any]] = []
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                tile = rgb[y_offset:y_offset + tile_height, x_offset:x_offset + tile_width]
                detected_segments = model.detect(tile, confidence_for_source(source, confidence), source, model_targets)
                for segment in detected_segments:
                    if segment["class_name"] not in model_targets:
                        continue
                    local_mask = np.asarray(segment["mask"], dtype=np.uint8)
                    if local_mask.shape != (tile_height, tile_width):
                        continue
                    merge_tile_segment(
                        tiled_segments,
                        str(segment["class_name"]),
                        float(segment["confidence"]),
                        local_mask,
                        x_offset,
                        y_offset,
                        source,
                    )
            collected.extend(materialize_tile_mask(segment, width, height) for segment in tiled_segments)
        return arbitrate_segment_sources(collected)

    def _hand_boxes(self, models: DetectionModels, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        hand_model = self._ensure_hand_model(models)
        return hand_model.detect_boxes(rgb, HAND_CONFIDENCE)

    @staticmethod
    def _hand_boxes_over_apply(boxes: list[tuple[int, int, int, int]], masks: list[np.ndarray]) -> list[tuple[int, int, int, int]]:
        """Limit expensive hand segmentation to the final target envelope."""
        if not masks:
            return []
        combined = np.zeros_like(np.asarray(masks[0]), dtype=bool)
        for mask in masks:
            np.logical_or(combined, np.asarray(mask) > 0, out=combined)
        coordinates = np.argwhere(combined)
        if not len(coordinates):
            return []
        top, left = coordinates.min(axis=0); bottom, right = coordinates.max(axis=0) + 1
        clipped: list[tuple[int, int, int, int]] = []
        for box_left, box_top, box_right, box_bottom in boxes:
            overlap = (max(box_left, int(left)), max(box_top, int(top)), min(box_right, int(right)), min(box_bottom, int(bottom)))
            if overlap[0] < overlap[2] and overlap[1] < overlap[3]: clipped.append(overlap)
        return clipped

    @staticmethod
    def _hand_evidence_is_distinct_from_targets(hand_mask: np.ndarray, detected: list[dict[str, Any]]) -> bool:
        return all(mask_iou(hand_mask, np.asarray(segment["mask"])) < 0.75 for segment in detected)

    def _hand_refinement_context(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], np.ndarray, list[tuple[int, int, int, int]]]:
        """Gather all non-SAM hand evidence before the single SAM section."""
        rgb = np.asarray(rgb)
        detected = [segment for segment in segments if segment["class_name"] in DETECTED_TARGET_CLASSES]
        shape = rgb.shape[:2]
        hand_mask = np.zeros(shape, dtype=np.uint8)
        hand_boxes = self._hand_boxes(models, rgb)
        if hand_boxes and self.settings["models"].get("hand_segmentation_enabled"):
            padded_boxes = [box for box in (padded_hand_box(box, shape) for box in hand_boxes) if box is not None]
            candidate_boxes = self._hand_boxes_over_apply(
                padded_boxes,
                [np.asarray(segment["mask"]) for segment in detected],
            ) if detected else padded_boxes
            with self.hand_segmentation_lock:
                specialist_predictor = self._hand_segmentation_predictor_for(record, rgb)
                for padded_box in candidate_boxes:
                    masks, _scores, _ = specialist_predictor.predict(
                        point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=False,
                    )
                    confirmed = accepted_specialist_hand_mask(masks, shape, padded_box)
                    if confirmed is not None and self._hand_evidence_is_distinct_from_targets(confirmed, detected):
                        hand_mask = np.maximum(hand_mask, confirmed)
        # A detector box is only a prompt.  It is never published as a hand
        # exclusion unless a segmentation model confirms its pixels.
        return detected, hand_mask, []

    @staticmethod
    def _attach_hand_evidence(segments: list[dict[str, Any]], detected: list[dict[str, Any]], hand_mask: np.ndarray) -> list[dict[str, Any]]:
        for segment in detected:
            segment["_detector_mask"] = np.asarray(segment["mask"]).copy()
            segment["_confirmed_hand"] = hand_mask
        if np.any(hand_mask):
            if detected:
                detected[0]["image_exclusions"] = {"hand": hand_mask}
            else:
                segments.append({"class_name": "__hand_exclusion__", "image_exclusions": {"hand": hand_mask}})
        return segments

    def _refine_detected_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Collect hand evidence before optional outline refinement.

        This stage deliberately does not change APPLY masks: SAM finalizes them
        first, then the same hand evidence is published as an EXCLUDE mask.
        """
        detected, hand_mask, _ = self._hand_refinement_context(models, record, rgb, segments)
        return self._attach_hand_evidence(segments, detected, hand_mask)

    @staticmethod
    def _metadata_fluid_search(
        rgb: np.ndarray, final_masks: list[np.ndarray], hand_evidence: np.ndarray, faces: list[dict[str, Any]], scene_fluid_tags: frozenset[str],
    ) -> np.ndarray:
        shape = np.asarray(rgb).shape[:2]
        if not scene_fluid_tags:
            return np.zeros(shape, dtype=np.uint8)
        search = np.zeros(shape, dtype=np.uint8)
        if "cum on ass" in scene_fluid_tags:
            for mask in final_masks:
                bounds = _mask_bounds(mask)
                if bounds is None:
                    continue
                left, top, right, bottom = bounds
                width, height = right - left, bottom - top
                center_x = (left + right) / 2
                half_width = max(2 * width, 1.4 * height)
                _fill_metadata_fluid_roi(search, center_x - half_width, top - .2 * height, center_x + half_width, bottom + 2.1 * height)
        if "cum in pussy" in scene_fluid_tags:
            for mask in final_masks:
                bounds = _mask_bounds(mask)
                if bounds is None:
                    continue
                left, top, right, bottom = bounds
                width, height = right - left, bottom - top
                center_x = (left + right) / 2
                half_width = max(1.2 * width, .9 * height)
                _fill_metadata_fluid_roi(search, center_x - half_width, top - .15 * height, center_x + half_width, bottom + .75 * height)
        if "cum on fingers" in scene_fluid_tags:
            count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(np.asarray(hand_evidence > 0, dtype=np.uint8), connectivity=8)
            scale = min(shape) / 896
            for left, top, width, height, _area in stats[1:count]:
                lateral = max(64 * scale, .8 * height)
                _fill_metadata_fluid_roi(search, left - lateral, top - .4 * height, left + width + lateral, top + height * 1.3)
        if "cum_on_breasts" in scene_fluid_tags:
            for face in faces:
                bounds = _mask_bounds(np.asarray(face["mask"]))
                if bounds is None:
                    continue
                left, top, right, bottom = bounds
                width, height = right - left, bottom - top
                center = (left + right) // 2
                _fill_metadata_fluid_roi(
                    search,
                    center - width * .50,
                    bottom + height * .45,
                    center + width * .50,
                    bottom + height * 1.75,
                )
        return search

    def _finalize_exclusions(
        self, rgb: np.ndarray, segments: list[dict[str, Any]], scene_fluid_tags: frozenset[str] = frozenset(),
        *,
        alpha: np.ndarray | None = None,
        fluid_exclusion_enabled: bool | None = None,
        fluid_color_fill: tuple[bool, int] | None = None,
    ) -> list[dict[str, Any]]:
        """Create reviewable non-hand exclusions from the final APPLY mask."""
        shape = np.asarray(rgb).shape[:2]
        if fluid_exclusion_enabled is None:
            fluid_exclusion_enabled = bool(self.settings["detection"]["fluid_exclusion_enabled"])
        expand_fluid = fluid_color_fill is not None and fluid_color_fill[0]
        fluid_tolerance = fluid_color_fill[1] if expand_fluid else 0
        targets = [segment for segment in segments if segment.get("class_name") in DETECTED_TARGET_CLASSES]
        faces = [segment for segment in segments if segment.get("class_name") == "female_face"]
        if not targets and not scene_fluid_tags:
            return segments

        final_masks = [np.asarray(segment["mask"] > 0, dtype=np.uint8) for segment in targets]
        detector_masks = [
            np.asarray(segment.get("_detector_mask", segment["mask"]) > 0, dtype=np.uint8)
            for segment in targets
        ]
        hand_masks = [
            np.asarray(
                segment.get("_confirmed_hand", segment.get("image_exclusions", {}).get("hand", np.zeros(shape))) > 0,
                dtype=np.uint8,
            )
            for segment in targets
        ]
        hand_evidence = np.maximum.reduce(hand_masks) if hand_masks else np.zeros(shape, dtype=np.uint8)

        safe_hand = np.zeros(shape, dtype=np.uint8)
        unsafe_targets = np.zeros(shape, dtype=np.uint8)
        for detector_mask in detector_masks:
            _refined, decision = refine_mask_with_hand(detector_mask, hand_evidence)
            if decision in {"over_cap", "too_small"}:
                unsafe_targets = np.maximum(unsafe_targets, detector_mask)
            elif decision == "refined":
                safe_hand = np.maximum(safe_hand, detector_mask & hand_evidence)
        safe_hand = np.where(unsafe_targets > 0, 0, safe_hand).astype(np.uint8) * 255

        fluid_union = np.zeros(shape, dtype=np.uint8)
        if fluid_exclusion_enabled:
            for final_mask in final_masks:
                if np.any(final_mask):
                    fluid_seed = white_fluid_mask(rgb, final_mask)
                    fluid_mask = (
                        expand_white_fluid_mask(rgb, fluid_seed, final_mask, fluid_tolerance, alpha=alpha)
                        if expand_fluid else fluid_seed
                    )
                    fluid_union = np.maximum(fluid_union, fluid_mask)
        metadata_search = self._metadata_fluid_search(rgb, final_masks, hand_evidence, faces, scene_fluid_tags)
        metadata_seed = white_fluid_mask(rgb, metadata_search) if fluid_exclusion_enabled and np.any(metadata_search) else np.zeros(shape, dtype=np.uint8)
        metadata_fluid = (
            expand_white_fluid_mask(rgb, metadata_seed, metadata_search, fluid_tolerance, alpha=alpha)
            if expand_fluid and np.any(metadata_seed) else metadata_seed
        )
        if not targets:
            if np.any(metadata_fluid):
                segments.append({"class_name": "__fluid_exclusion__", "metadata_exclusions": {"fluid": metadata_fluid}})
            return segments

        # Publish just the reviewable hand and fluid exclusions for final
        # targets. Other detector segments do not participate in APPLY.
        for segment in targets:
            segment["image_exclusions"] = {}
            segment["exclusions"] = {}
        if np.any(safe_hand):
            targets[0]["image_exclusions"]["hand"] = safe_hand
        if np.any(fluid_union):
            targets[0]["exclusions"]["fluid"] = fluid_union
        if np.any(metadata_fluid):
            targets[0]["metadata_exclusions"] = {"fluid": np.maximum(fluid_union, metadata_fluid)}
            targets[0]["exclusions"].pop("fluid", None)
        return segments

    def _high_precision_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Refine target regions without discarding detector evidence."""
        if not any(segment.get("class_name") in DETECTED_TARGET_CLASSES for segment in segments):
            return segments
        with self.sam_lock:
            predictor = self._sam_predictor_for(record, rgb)
            return self._high_precision_segments_with_predictor(rgb, segments, predictor)

    def _high_precision_segments_with_predictor(
        self, rgb: np.ndarray, segments: list[dict[str, Any]], predictor: Any,
    ) -> list[dict[str, Any]]:
        refined_segments: list[dict[str, Any]] = []
        for segment in segments:
            if segment.get("class_name") not in DETECTED_TARGET_CLASSES:
                refined_segments.append(segment)
                continue
            source_mask = (np.asarray(segment.get("_detector_mask", segment["mask"])) > 0).astype(np.uint8)
            hand_mask = np.asarray(segment.get("_confirmed_hand", np.zeros_like(source_mask)) > 0, dtype=np.uint8)
            coordinates = np.argwhere(source_mask > 0)
            if not len(coordinates):
                # No detector pixels means there is no APPLY evidence to
                # preserve or refine. Do not publish an empty PNG candidate.
                continue
            top, left = coordinates.min(axis=0)
            bottom, right = coordinates.max(axis=0) + 1
            height, width = source_mask.shape
            padding = max(2, int(max(bottom - top, right - left) * 0.05))
            roi = (max(0, int(left - padding)), max(0, int(top - padding)),
                   min(width, int(right + padding)), min(height, int(bottom + padding)))
            prompt_points, labels = sam_refinement_prompts(source_mask, hand_mask)
            if not len(prompt_points):
                segment["mask"] = source_mask
                segment["_apply_mask"] = source_mask
                segment["refinement"] = "sam_fallback"
                refined_segments.append(segment)
                continue
            consensus = len(segment.get("_consensus_sources", frozenset({str(segment["source"])}))) >= 2

            def select_mask(
                candidates: np.ndarray, candidate_scores: np.ndarray, *, allow_relaxed: bool = True,
            ) -> tuple[tuple[np.ndarray, int] | None, bool]:
                selected = select_semantic_sam_mask(
                    candidates, candidate_scores, source_mask, hand_mask, prompt_points, labels,
                )
                if selected is None and consensus and allow_relaxed:
                    selected = select_semantic_sam_mask(
                        candidates, candidate_scores, source_mask, hand_mask, prompt_points, labels,
                        max_hand_ratio=HAND_MAX_REMOVAL_RATIO,
                        prioritize_hand_overlap=True,
                    )
                    return selected, selected is not None
                return selected, False

            masks, scores, logits = predictor.predict(
                point_coords=prompt_points,
                point_labels=labels,
                box=np.asarray(roi, dtype=np.float32),
                multimask_output=True,
            )
            clipped_masks = np.asarray([clip_mask_to_roi(mask, roi) for mask in masks])
            selected, initial_relaxed = select_mask(clipped_masks, scores)
            if selected is None:
                segment["mask"] = source_mask
                segment["_apply_mask"] = source_mask
                segment["refinement"] = "sam_fallback"
                refined_segments.append(segment)
                continue
            refined, selected_index = selected
            hand_overlap = int(np.count_nonzero((refined > 0) & (hand_mask > 0)))
            if hand_overlap and logits is not None and len(logits) > selected_index:
                retry_points, retry_labels = sam_hand_overlap_negative_points(
                    refined, hand_mask, prompt_points, labels,
                )
                retry_masks, retry_scores, _ = predictor.predict(
                    point_coords=retry_points, point_labels=retry_labels, box=np.asarray(roi, dtype=np.float32),
                    mask_input=np.asarray(logits[selected_index:selected_index + 1]), multimask_output=False,
                )
                retry, _ = select_mask(
                    np.asarray([clip_mask_to_roi(mask, roi) for mask in retry_masks]), retry_scores,
                    allow_relaxed=initial_relaxed,
                )
                if retry is not None:
                    retry_mask = retry[0]
                    retry_hand = int(np.count_nonzero((retry_mask > 0) & (hand_mask > 0)))
                    source_area = max(1, int(np.count_nonzero(source_mask)))
                    visible_source = (source_mask > 0) & (hand_mask == 0)
                    retained_visible = int(np.count_nonzero((refined > 0) & visible_source))
                    retry_retained = int(np.count_nonzero((retry_mask > 0) & (source_mask > 0))) / source_area
                    retry_visible = int(np.count_nonzero((retry_mask > 0) & visible_source))
                    if retry_hand < hand_overlap and retry_retained >= 0.50 and retry_visible >= retained_visible:
                        refined = retry_mask
            segment["mask"] = refined
            segment["_apply_mask"] = refined
            segment["refinement"] = "sam_high_precision"
            refined_segments.append(segment)
        return refined_segments

    def _detect_image(
        self, models: DetectionModels, record: ImageRecord, confidence: float, mode: str | None = None,
        target_classes: set[str] | None = None,
        default_padding: int | None = None,
        default_exclude_padding: int | None = None,
        fluid_exclusion_enabled: bool | None = None,
        fluid_color_fill: tuple[bool, int] | None = None,
    ) -> list[Candidate]:
        # Decode is a short per-image phase. Do not hold the image
        # lock while detector/SAM inference runs.
        if default_padding is None:
            default_padding = min(
                int(self._active_detection_default_padding),
                int(np.ceil(np.hypot(record.width - 1, record.height - 1))),
            )
        if default_exclude_padding is None:
            default_exclude_padding = int(self._active_detection_default_exclude_padding)
        default_exclude_padding = min(
            default_exclude_padding,
            int(np.ceil(np.hypot(record.width - 1, record.height - 1))),
        )
        with self.image_io_lock(record.image_id):
            self._assert_record_stat_matches(record)
            image, _source, info = canonical_image(record)
            scene_fluid_tags = _scene_fluid_tags(info)
            rgb, alpha = _inference_pixels(image)
        if fluid_exclusion_enabled is None:
            fluid_exclusion_enabled = bool(self.settings["detection"]["fluid_exclusion_enabled"])
        if not fluid_exclusion_enabled:
            scene_fluid_tags = frozenset()
        segments = self._detect_arbitrated_segments(models, rgb, confidence, target_classes or TARGET_CLASSES, scene_fluid_tags)
        _clip_detection_masks_to_alpha(segments, alpha)
        detected, hand_mask, _ = self._hand_refinement_context(models, record, rgb, segments)
        if alpha is not None:
            hand_mask = np.where(alpha > 0, hand_mask, 0)
        needs_high_precision = mode == "high_precision" and bool(detected)
        if needs_high_precision:
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                segments = self._attach_hand_evidence(segments, detected, hand_mask)
                segments = self._high_precision_segments_with_predictor(rgb, segments, predictor)
        else:
            segments = self._attach_hand_evidence(segments, detected, hand_mask)
        segments = self._finalize_exclusions(
            rgb,
            segments,
            scene_fluid_tags,
            alpha=alpha,
            fluid_exclusion_enabled=fluid_exclusion_enabled,
            fluid_color_fill=fluid_color_fill,
        )
        _clip_detection_masks_to_alpha(segments, alpha)
        candidates: list[Candidate] = []
        destination = self.cache_dir / record.image_id
        destination.mkdir(parents=True, exist_ok=True)
        for segment in segments:
            for exclusion_kind, exclusion_mask in dict(segment.get("image_exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                _save_binary_mask(exclusion_mask, exclusion_path)
                candidates.append(Candidate(
                    candidate_id=exclusion_id,
                    label_token=exclusion_kind,
                    confidence=None,
                    mask_path=exclusion_path,
                    color="#4ac3df",
                    source=f"{exclusion_kind}_exclusion",
                    origin="auto",
                    role=CandidateRole.EXCLUDE,
                    forced=self.settings["detection"].get("exclude_forced_default", True),
                    expand_px=default_exclude_padding,
                ))
            for exclusion_kind, exclusion_mask in dict(segment.get("metadata_exclusions", {})).items():
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                _save_binary_mask(exclusion_mask, exclusion_path)
                candidates.append(Candidate(
                    candidate_id=exclusion_id, label_token=exclusion_kind, confidence=None,
                    mask_path=exclusion_path, color="#4ac3df", source=f"{exclusion_kind}_exclusion",
                    origin="auto", role=CandidateRole.EXCLUDE, enabled=True, forced=False,
                    expand_px=default_exclude_padding,
                ))
            if segment["class_name"] not in DETECTED_TARGET_CLASSES:
                continue
            apply_mask = np.asarray(segment["mask"]).copy()
            # Keep the detector/SAM mask intact.  Hands and fluid are separate
            # exclusion candidates, so their checkbox can genuinely restore the
            # underlying target mask when turned off.
            candidate_id = uuid.uuid4().hex
            mask_path = destination / f".mozarie-pending-{candidate_id}.tmp"
            _save_binary_mask(apply_mask, mask_path)
            candidates.append(
                Candidate(
                    candidate_id=candidate_id,
                    label_token=segment["class_name"],
                    confidence=segment["confidence"],
                    mask_path=mask_path,
                    color=DEFAULT_COLORS.get(segment["class_name"], "#5bb6d5"),
                    source=segment["source"],
                    refinement=segment.get("refinement"),
                    expand_px=default_padding,
                )
            )
            for exclusion_kind, exclusion_mask in dict(segment.get("exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                _save_binary_mask(exclusion_mask, exclusion_path)
                candidates.append(Candidate(
                    candidate_id=exclusion_id,
                    label_token=exclusion_kind,
                    confidence=None,
                    mask_path=exclusion_path,
                    color="#4ac3df",
                    source=exclusion_source,
                    origin="auto",
                    role=CandidateRole.EXCLUDE,
                    enabled=True,
                    forced=self.settings["detection"].get("exclude_forced_default", True),
                    expand_px=default_exclude_padding,
                ))
        return candidates

    def add_boundary_candidate(self, image_id: str, payload: dict[str, Any], *, _gate_held: bool = False) -> dict[str, Any]:
        if not _gate_held:
            # Keep this gate for the complete boundary pipeline, including SAM
            # refinement and candidate publication, while allowing its small
            # internal critical sections to re-enter it.
            try:
                with self.inference_lock:
                    return self.add_boundary_candidate(image_id, payload, _gate_held=True)
            finally:
                # Interactive boundary inference has the same accelerator
                # lifetime as a background detection job.  Do not retain its
                # model, SAM image or CUDA cache until another request.
                self._release_gpu_job_memory()
        with self.image_io_lock(image_id):
            self._assert_image_editable(image_id)
            record = self.image_for_id(image_id)
            with self.lock:
                self._assert_request_catalog_expectation()
            self._assert_record_stat_matches(record)
        polygon_mask: np.ndarray | None = None
        try:
            if "points" in payload:
                roi, point, polygon_mask = read_polygon_boundary_request(payload, record.width, record.height)
            else:
                roi, point = read_boundary_request(payload, record.width, record.height)
        except (MemoryError, OSError) as exc:
            raise ClientError("境界候補の範囲を処理できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
        with self.image_io_lock(image_id):
            self._assert_record_stat_matches(record)
            try:
                image, _source, _info = canonical_image(record)
                rgb, alpha = _inference_pixels(image)
            except (MemoryError, OSError) as exc:
                raise ClientError("境界候補用の画像を読み込めません。使用可能なメモリを確認してください。", "image_read_failed") from exc
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。", "operation_in_progress")
            with self.sam_lock:
                try:
                    predictor = self._sam_predictor_for(record, rgb)
                    masks, scores, _logits = predictor.predict(
                        point_coords=np.asarray([point], dtype=np.float32),
                        point_labels=np.asarray([1], dtype=np.int32),
                        box=np.asarray(roi, dtype=np.float32),
                        multimask_output=True,
                    )
                except (MemoryError, OSError) as exc:
                    raise ClientError("境界候補を検出できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
        try:
            mask, confidence = select_best_sam_mask(masks, scores)
            clipped = clip_mask_to_roi(mask, roi)
            if polygon_mask is not None:
                clipped = np.where(polygon_mask > 0, clipped, 0).astype(np.uint8)
            if alpha is not None:
                clipped = np.where(alpha > 0, clipped, 0).astype(np.uint8)
            if not np.any(clipped):
                raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。", "outline_not_found")
        except (MemoryError, OSError) as exc:
            raise ClientError("境界候補のマスクを処理できません。使用可能なメモリを確認してください。", "image_read_failed") from exc

        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダの再読み込み後に境界の検出結果を受け取ったため、破棄しました。", "catalog_changed")
            self._assert_image_editable(image_id)

        # Keep the selected SAM shape as APPLY. Hand/fluid removal is represented
        # by an independently toggleable EXCLUDE candidate just as in auto detect.
        try:
            boundary_segment = {
                "class_name": "penis",
                "confidence": confidence,
                "mask": clipped.copy(),
                "source": "boundary",
            }
        except (MemoryError, OSError) as exc:
            raise ClientError("境界候補のマスクを処理できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。", "operation_in_progress")
            try:
                hand_mask = np.zeros(rgb.shape[:2], dtype=np.uint8)
                hand_boxes = self._hand_boxes_over_apply(
                    [box for box in (padded_hand_box(box, rgb.shape[:2]) for box in self._boundary_hand_boxes(rgb)) if box is not None],
                    [clipped],
                )
                if hand_boxes and self.settings["models"].get("hand_segmentation_enabled"):
                    with self.hand_segmentation_lock:
                        specialist = self._hand_segmentation_predictor_for(record, rgb)
                        for box in hand_boxes:
                            masks, _scores, _ = specialist.predict(
                                point_coords=None, point_labels=None, box=np.asarray(box, dtype=np.float32), multimask_output=False,
                            )
                            confirmed = accepted_specialist_hand_mask(masks, rgb.shape[:2], box)
                            if confirmed is not None:
                                hand_mask = np.maximum(hand_mask, confirmed)
                if np.any(hand_mask):
                    boundary_segment["image_exclusions"] = {"hand": hand_mask}
                boundary_segment = self._finalize_exclusions(rgb, [boundary_segment])[0]
                _clip_detection_masks_to_alpha([boundary_segment], alpha)
                candidate_id = uuid.uuid4().hex
                default_padding = min(int(self.settings["detection"]["default_candidate_padding_px"]), int(np.ceil(np.hypot(record.width - 1, record.height - 1))))
                default_exclude_padding = min(int(self.settings["detection"]["default_exclude_candidate_padding_px"]), int(np.ceil(np.hypot(record.width - 1, record.height - 1))))
                created = [Candidate(
                    candidate_id=candidate_id,
                    label_token="boundary_polygon" if polygon_mask is not None else "boundary",
                    confidence=confidence,
                    mask_path=self.cache_dir / record.image_id / f"{candidate_id}.png",
                    color="#ffffff", source="boundary", origin="boundary", expand_px=default_padding,
                )]
                masks = [np.asarray(clipped, dtype=np.uint8)]
                exclusions = {
                    **dict(boundary_segment.get("image_exclusions", {})),
                    **dict(boundary_segment.get("exclusions", {})),
                }
                for exclusion_kind, exclusion_mask in exclusions.items():
                    if not np.any(exclusion_mask):
                        continue
                    exclusion_source = f"{exclusion_kind}_exclusion"
                    exclusion_id = uuid.uuid4().hex
                    created.append(Candidate(
                        candidate_id=exclusion_id, label_token=exclusion_kind, confidence=None,
                        mask_path=self.cache_dir / record.image_id / f"{exclusion_id}.png", color="#4ac3df",
                        source=exclusion_source, origin="boundary", role=CandidateRole.EXCLUDE,
                        enabled=True,
                        forced=self.settings["detection"].get("exclude_forced_default", True),
                        expand_px=default_exclude_padding,
                    ))
                    masks.append(np.asarray(exclusion_mask, dtype=np.uint8))
            except (MemoryError, OSError) as exc:
                raise ClientError("境界候補の手・除外マスクを処理できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
            temporary_paths: list[Path] = []

            def discard_pending_masks() -> None:
                for path in [*temporary_paths, *(item.mask_path for item in created)]:
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as cleanup_exc:
                        LOGGER.warning("Could not remove failed boundary mask %s: %s", path, cleanup_exc)

            try:
                for item, candidate_mask in zip(created, masks):
                    temporary = item.mask_path.with_name(f".mozarie-pending-{item.candidate_id}.tmp")
                    item.mask_path.parent.mkdir(parents=True, exist_ok=True)
                    _save_binary_mask(candidate_mask, temporary)
                    temporary_paths.append(temporary)
                with self.image_io_lock(image_id):
                    self._assert_record_stat_matches(record)
                    with self.lock:
                        self._assert_request_catalog_expectation()
                        if self.images.get(image_id) is not record:
                            raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。", "catalog_changed")
                    for temporary, candidate in zip(temporary_paths, created):
                        os.replace(temporary, candidate.mask_path)
                    temporary_paths.clear()
                    with self.lock:
                        self._assert_request_catalog_expectation()
                        catalog_current = self.images.get(image_id) is record
                        if catalog_current:
                            revision = self._commit_candidate_snapshot(
                                image_id, [*self.candidates.get(image_id, []), *created], replace=True,
                            )
                    if not catalog_current:
                        raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。", "catalog_changed")
            except (MemoryError, OSError) as exc:
                discard_pending_masks()
                raise ClientError("境界候補のマスクを保存できません。使用可能なメモリを確認してください。", "image_read_failed") from exc
            except Exception:
                discard_pending_masks()
                raise
        return {
            "candidates": [item.as_api_dict() for item in created],
            "candidateRevision": revision,
        }
