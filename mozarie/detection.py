from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import cv2
from PIL import Image, ImageOps, PngImagePlugin

from .core import (
    DEFAULT_COLORS, DEFAULT_DETECTION_CONFIDENCE, HAND_CONFIDENCE,
    DETECTED_TARGET_CLASSES, TARGET_CLASSES, Candidate, CandidateRole,
    ClientError, ImageRecord, JobControl, accepted_hand_sam_mask,
    accepted_specialist_hand_mask, arbitrate_segment_sources, clip_mask_to_roi,
    confidence_for_source, detection_tiles, mask_iou, materialize_tile_mask,
    merge_tile_segment, padded_hand_box, read_boundary_request,
    read_polygon_boundary_request, sam_refinement_prompts,
    refine_mask_with_hand,
    select_best_sam_mask, select_semantic_sam_mask,
    torch_module, _read_detection_parallelism, _read_target_classes,
)
from .fluid import white_fluid_mask
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
    ) -> None:
        # The gate makes initial job setup mutually exclusive with boundary
        # inference and model-cache replacement.
        with self.inference_lock:
            self._require_supported_gpu()
            records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
            for record in records:
                self._assert_image_editable(record.image_id)
            targets = _read_target_classes(target_classes or set(self.settings["detection"]["targets"]))
            # Every successfully published result belongs to one undo group.
            # The worker still commits each image as it finishes, so detection
            # progress and cancellation remain responsive.
            self._detection_history_group = self.workspace_store.begin_history_group()
            # Capture the default here. Settings may be changed after the job
            # starts, but one detection run must use one coherent value.
            self._active_detection_default_padding = int(self.settings["detection"]["default_candidate_padding_px"])
            args: tuple[Any, ...] = (confidence, _read_detection_parallelism(parallelism))
            if targets != TARGET_CLASSES:
                args = (*args, targets)
            self._start_job("detect", records, self._detect_worker, *args, expected_catalog_generation=catalog_generation)


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
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        models: DetectionModels | None = None
        try:
            # Direct workers in tests and integrations do not pass the job
            # launch epoch. Snapshot it once before any work; publication must
            # compare against that same value, never against ``None`` or a
            # later catalogue generation.
            if catalog_generation is None:
                with self.lock:
                    catalog_generation = self.catalog_generation
            mode = str(self.settings["detection"]["mode"])
            requested_parallelism = _read_detection_parallelism(parallelism)
            if runtime_backend(torch_module=torch_module()) == "directml":
                requested_parallelism = 1
            worker_count = min(requested_parallelism, len(records))
            self._set_job_parallelism(worker_count, job_generation, catalog_generation)
            self._wait_while_paused(control, job_generation, catalog_generation)
            if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                self._cancel_job(job_generation, catalog_generation)
                return
            if not self._job_is_current(job_generation, catalog_generation):
                return
            models = self._ensure_models()

            def claim_and_run(index: int, record: ImageRecord) -> None:
                try:
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    candidates = self._detect_image(models, record, confidence, mode, target_classes or TARGET_CLASSES)
                    if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                        self._discard_candidates(candidates)
                        return
                    try:
                        image_lock = self.image_io_lock(record.image_id)
                    except ClientError:
                        self._discard_candidates(candidates)
                        raise
                    with image_lock:
                        with self.lock:
                            if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                    or not self._job_is_current(job_generation, catalog_generation)
                                    or self.images.get(record.image_id) is not record):
                                self._discard_candidates(candidates)
                                return
                        try:
                            self._assert_record_stat_matches(record)
                        except ClientError:
                            self._discard_candidates(candidates)
                            raise
                        with self.lock:
                            if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                    or not self._job_is_current(job_generation, catalog_generation)
                                    or self.images.get(record.image_id) is not record):
                                self._discard_candidates(candidates)
                                return
                            boundary_candidates = [candidate for candidate in self.candidates.get(record.image_id, []) if candidate.origin == "boundary"]
                            stale_paths = [candidate.mask_path for candidate in self.candidates.get(record.image_id, []) if candidate.origin != "boundary"]
                            expected_revision = self._candidate_revision(record.image_id)
                        try:
                            for candidate in candidates:
                                final_path = self.cache_dir / record.image_id / f"{candidate.candidate_id}.png"
                                if candidate.mask_path.name.startswith(".mozarie-pending-"):
                                    os.replace(candidate.mask_path, final_path)
                                    candidate.mask_path = final_path
                        except Exception:
                            self._discard_candidates(candidates)
                            raise
                        if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                            self._discard_candidates(candidates)
                            return
                        try:
                            # PNG publication, effective-mask composition and
                            # SQLite history are all deliberately outside the
                            # global state lock.  The per-image lock above
                            # keeps this epoch stable until the short publish.
                            self._commit_candidate_snapshot_outside_state_lock(
                                record.image_id, [*boundary_candidates, *candidates], replace=True,
                                expected_revision=expected_revision, expected_catalog_generation=catalog_generation,
                                history_group=getattr(self, "_detection_history_group", None),
                            )
                        except Exception:
                            # The durable transaction did not publish this run:
                            # remove every new final-path mask. The previous
                            # candidate generation remains intact.
                            self._discard_candidates(candidates)
                            raise
                        with self.lock:
                            self._record_job_success(index, record.image_id, None, job_generation, catalog_generation)
                        for path in stale_paths:
                            path.unlink(missing_ok=True)
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                finally:
                    self.invalidate_sam_image(record.image_id)

            failures = self._run_fixed_workers(records, worker_count, claim_and_run, control, job_generation, catalog_generation)
            if failures:
                # ``claim_and_run`` closes over this variable. Clear the final
                # Python reference before OOM recovery drops state-owned models.
                if self._is_gpu_out_of_memory(failures[0][1]):
                    models = None
                group_id = getattr(self, "_detection_history_group", None)
                if group_id: self.workspace_store.finish_history_group(group_id, failed=True)
                self._fail_job(failures[0][1], job_generation, catalog_generation)
                return
            if control is not None and control.cancel_requested.is_set():
                group_id = getattr(self, "_detection_history_group", None)
                if group_id: self.workspace_store.finish_history_group(group_id, failed=True)
                self._cancel_job(job_generation, catalog_generation)
                return
            group_id = getattr(self, "_detection_history_group", None)
            if group_id: self.workspace_store.finish_history_group(group_id)
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            models = None
            group_id = getattr(self, "_detection_history_group", None)
            if group_id: self.workspace_store.finish_history_group(group_id, failed=True)
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
        coordinates = np.argwhere(np.any(np.asarray(masks) > 0, axis=0)) if masks else np.empty((0, 2), dtype=int)
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
    def _metadata_fluid_mask(
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
        return white_fluid_mask(rgb, search) if np.any(search) else np.zeros(shape, dtype=np.uint8)

    def _finalize_exclusions(
        self, rgb: np.ndarray, segments: list[dict[str, Any]], scene_fluid_tags: frozenset[str] = frozenset(),
    ) -> list[dict[str, Any]]:
        """Create reviewable non-hand exclusions from the final APPLY mask."""
        shape = np.asarray(rgb).shape[:2]
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
        if self.settings["detection"]["fluid_exclusion_enabled"]:
            for final_mask in final_masks:
                if np.any(final_mask):
                    fluid_union = np.maximum(fluid_union, white_fluid_mask(rgb, final_mask))
        metadata_fluid = (
            self._metadata_fluid_mask(rgb, final_masks, hand_evidence, faces, scene_fluid_tags)
            if self.settings["detection"]["fluid_exclusion_enabled"] else np.zeros(shape, dtype=np.uint8)
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
        """Keep only target regions confirmed by high-precision SAM."""
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
                continue
            top, left = coordinates.min(axis=0)
            bottom, right = coordinates.max(axis=0) + 1
            height, width = source_mask.shape
            padding = max(2, int(max(bottom - top, right - left) * 0.05))
            roi = (max(0, int(left - padding)), max(0, int(top - padding)),
                   min(width, int(right + padding)), min(height, int(bottom + padding)))
            prompt_points, labels = sam_refinement_prompts(source_mask, hand_mask)
            if not len(prompt_points):
                continue
            masks, scores, logits = predictor.predict(
                point_coords=prompt_points,
                point_labels=labels,
                box=np.asarray(roi, dtype=np.float32),
                multimask_output=True,
            )
            clipped_masks = np.asarray([clip_mask_to_roi(mask, roi) for mask in masks])
            selected = select_semantic_sam_mask(clipped_masks, scores, source_mask, hand_mask, prompt_points, labels)
            if selected is None:
                continue
            refined, selected_index = selected
            hand_overlap = int(np.count_nonzero((refined > 0) & (hand_mask > 0)))
            if hand_overlap and logits is not None and len(logits) > selected_index:
                retry_masks, retry_scores, _ = predictor.predict(
                    point_coords=prompt_points, point_labels=labels, box=np.asarray(roi, dtype=np.float32),
                    mask_input=np.asarray(logits[selected_index:selected_index + 1]), multimask_output=False,
                )
                retry = select_semantic_sam_mask(np.asarray([clip_mask_to_roi(mask, roi) for mask in retry_masks]), retry_scores, source_mask, hand_mask, prompt_points, labels)
                if retry is not None:
                    retry_mask = retry[0]
                    retry_hand = int(np.count_nonzero((retry_mask > 0) & (hand_mask > 0)))
                    source_area = max(1, int(np.count_nonzero(source_mask)))
                    retained = int(np.count_nonzero((refined > 0) & (source_mask > 0))) / source_area
                    retry_retained = int(np.count_nonzero((retry_mask > 0) & (source_mask > 0))) / source_area
                    if retry_hand < hand_overlap and retry_retained >= retained and retry_retained >= 0.50:
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
    ) -> list[Candidate]:
        # Decode is a short per-image phase. Do not hold the image
        # lock while detector/SAM inference runs.
        if default_padding is None:
            default_padding = min(
                int(self._active_detection_default_padding),
                int(np.ceil(np.hypot(record.width - 1, record.height - 1))),
            )
        with self.image_io_lock(record.image_id):
            self._assert_record_stat_matches(record)
            with Image.open(record.path) as image:
                scene_fluid_tags = _scene_fluid_tags(dict(image.info))
                rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
        if not self.settings["detection"]["fluid_exclusion_enabled"]:
            scene_fluid_tags = frozenset()
        segments = self._detect_arbitrated_segments(models, rgb, confidence, target_classes or TARGET_CLASSES, scene_fluid_tags)
        detected, hand_mask, _ = self._hand_refinement_context(models, record, rgb, segments)
        needs_high_precision = mode == "high_precision" and bool(detected)
        if needs_high_precision:
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                segments = self._attach_hand_evidence(segments, detected, hand_mask)
                segments = self._high_precision_segments_with_predictor(rgb, segments, predictor)
        else:
            segments = self._attach_hand_evidence(segments, detected, hand_mask)
        segments = (self._finalize_exclusions(rgb, segments, scene_fluid_tags)
                    if scene_fluid_tags else self._finalize_exclusions(rgb, segments))
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
                    expand_px=default_padding,
                ))
            for exclusion_kind, exclusion_mask in dict(segment.get("metadata_exclusions", {})).items():
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                _save_binary_mask(exclusion_mask, exclusion_path)
                candidates.append(Candidate(
                    candidate_id=exclusion_id, label_token=exclusion_kind, confidence=None,
                    mask_path=exclusion_path, color="#4ac3df", source=f"{exclusion_kind}_exclusion",
                    origin="auto", role=CandidateRole.EXCLUDE, enabled=True, forced=False,
                    expand_px=default_padding,
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
                    expand_px=default_padding,
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
            record = self.image_for_id(image_id)
            self._assert_record_stat_matches(record)
        polygon_mask: np.ndarray | None = None
        if "points" in payload:
            roi, point, polygon_mask = read_polygon_boundary_request(payload, record.width, record.height)
        else:
            roi, point = read_boundary_request(payload, record.width, record.height)
        with self.image_io_lock(image_id):
            self._assert_record_stat_matches(record)
            with Image.open(record.path) as image:
                rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。", "operation_in_progress")
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                masks, scores, _logits = predictor.predict(
                    point_coords=np.asarray([point], dtype=np.float32),
                    point_labels=np.asarray([1], dtype=np.int32),
                    box=np.asarray(roi, dtype=np.float32),
                    multimask_output=True,
                )
        mask, confidence = select_best_sam_mask(masks, scores)
        clipped = clip_mask_to_roi(mask, roi)
        if polygon_mask is not None:
            clipped = np.where(polygon_mask > 0, clipped, 0).astype(np.uint8)
        if not np.any(clipped):
            raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。", "outline_not_found")

        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダの再読み込み後に境界の検出結果を受け取ったため、破棄しました。", "catalog_changed")

        # Keep the selected SAM shape as APPLY. Hand/fluid removal is represented
        # by an independently toggleable EXCLUDE candidate just as in auto detect.
        boundary_segment = {
            "class_name": "penis",
            "confidence": confidence,
            "mask": clipped.copy(),
            "source": "boundary",
        }
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。", "operation_in_progress")
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
            candidate_id = uuid.uuid4().hex
            default_padding = min(int(self.settings["detection"]["default_candidate_padding_px"]), int(np.ceil(np.hypot(record.width - 1, record.height - 1))))
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
                    expand_px=default_padding,
                ))
                masks.append(np.asarray(exclusion_mask, dtype=np.uint8))
            temporary_paths: list[Path] = []
            try:
                for item, candidate_mask in zip(created, masks):
                    temporary = item.mask_path.with_name(f".mozarie-pending-{item.candidate_id}.tmp")
                    item.mask_path.parent.mkdir(parents=True, exist_ok=True)
                    _save_binary_mask(candidate_mask, temporary)
                    temporary_paths.append(temporary)
                with self.image_io_lock(image_id):
                    self._assert_record_stat_matches(record)
                    with self.lock:
                        if self.images.get(image_id) is not record:
                            raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。", "catalog_changed")
                    for temporary, candidate in zip(temporary_paths, created):
                        os.replace(temporary, candidate.mask_path)
                    temporary_paths.clear()
                    with self.lock:
                        catalog_current = self.images.get(image_id) is record
                        if catalog_current:
                            revision = self._commit_candidate_snapshot(
                                image_id, [*self.candidates.get(image_id, []), *created], replace=True,
                            )
                    if not catalog_current:
                        raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。", "catalog_changed")
            except Exception:
                for path in [*temporary_paths, *(item.mask_path for item in created)]:
                    path.unlink(missing_ok=True)
                raise
        return {
            "candidates": [item.as_api_dict() for item in created],
            "candidateRevision": revision,
        }
