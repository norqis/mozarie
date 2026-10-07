from __future__ import annotations

import io
import tracemalloc
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from mozarie import detection as detection_module, fluid as fluid_module
from mozarie.boundary import polygon_roi_and_point
from mozarie.detection import DetectionMixin, _mask_bounds
from mozarie.fluid import white_fluid_mask
from mozarie.masks import mask_bounds
from mozarie.workspace import WorkspaceStore


class MaskBoundsMemoryTests(unittest.TestCase):
    @staticmethod
    def png(pixels: np.ndarray) -> bytes:
        with io.BytesIO() as output, Image.fromarray(pixels) as image:
            image.save(output, format="PNG")
            return output.getvalue()

    def assert_mask(self, raw: bytes | None, expected: np.ndarray | None) -> None:
        if expected is None:
            self.assertIsNone(raw)
            return
        image = WorkspaceStore._decode_png_mask(raw)
        self.assertIsNotNone(image)
        with image:
            np.testing.assert_array_equal(np.asarray(image), expected)

    def assert_peak(self, operation, input_bytes: int, working_masks: int):
        # A 1 MiB fixture distinguishes bounded image buffers from two int64
        # coordinates per foreground pixel without wall-clock timing noise.
        tracemalloc.start()
        try:
            result = operation()
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertLess(peak, input_bytes * working_masks + 128 * 1024)
        return result

    def test_detection_bounds_preserve_empty_sparse_dense_strided_thin_and_signed_masks(self):
        sparse = np.zeros((7, 9), dtype=np.uint8)
        sparse[2, 3] = 1
        sparse[5, 7] = 255
        signed = np.full((7, 9), -1, dtype=np.int16)
        signed[2:4, 3:5] = 1
        for mask, expected in (
            (np.zeros((0, 3), dtype=np.uint8), None),
            (np.zeros((3, 0), dtype=np.uint8), None),
            (np.zeros((7, 9), dtype=np.uint8), None),
            (sparse, (3, 2, 8, 6)),
            (sparse[::-1, ::-1], (1, 1, 6, 5)),
            (np.ones((7, 9), dtype=np.uint8), (0, 0, 9, 7)),
            (np.array([[0, 1, 0]], dtype=np.uint8), (1, 0, 2, 1)),
            (np.array([[0], [1], [0]], dtype=np.uint8), (0, 1, 1, 2)),
            (signed, (3, 2, 5, 4)),
        ):
            with self.subTest(shape=mask.shape, expected=expected):
                self.assertEqual(_mask_bounds(mask), expected)

    def test_detection_dense_bounds_memory_stays_near_input_size(self):
        mask = np.full((1024, 1024), 255, dtype=np.uint8)
        bounds = self.assert_peak(lambda: _mask_bounds(mask), mask.nbytes, 3)
        self.assertEqual(bounds, (0, 0, 1024, 1024))

    def test_shared_dense_bounds_allocation_is_bounded_by_axis_lengths(self):
        for height, width in ((128, 8192), (1024, 1024), (8192, 128)):
            with self.subTest(shape=(height, width)):
                foreground = np.ones((height, width), dtype=bool)
                bounds = self.assert_peak(lambda: mask_bounds(foreground), height + width, 16)
                self.assertEqual(bounds, (0, 0, width, height))

    def test_hand_envelope_clips_intersections_and_ignores_empty_or_negative_masks(self):
        left = np.full((9, 11), -1, dtype=np.int16)
        left[2:4, 3:6] = 1
        right = np.zeros(left.shape, dtype=np.uint8)
        right[6, 8] = 255
        boxes = [(-2, -2, 5, 5), (7, 5, 15, 12), (0, 2, 3, 7), (0, 0, 20, 20)]
        self.assertEqual(
            DetectionMixin._hand_boxes_over_apply(boxes, [left, right]),
            [(3, 2, 5, 5), (7, 5, 9, 7), (3, 2, 9, 7)],
        )
        self.assertEqual(
            DetectionMixin._hand_boxes_over_apply([(0, 0, 20, 20)], [left[::-1, ::-1], right[::-1, ::-1]]),
            [(2, 2, 8, 7)],
        )
        for masks in ([], [np.zeros(left.shape, dtype=np.uint8)], [np.full(left.shape, -1, dtype=np.int16)]):
            with self.subTest(count=len(masks)):
                self.assertEqual(DetectionMixin._hand_boxes_over_apply(boxes, masks), [])

    def test_dense_hand_envelope_memory_stays_near_input_size(self):
        mask = np.full((1024, 1024), 255, dtype=np.uint8)
        boxes = self.assert_peak(
            lambda: DetectionMixin._hand_boxes_over_apply([(-2, -2, 1030, 1030)], [mask]), mask.nbytes, 4,
        )
        self.assertEqual(boxes, [(0, 0, 1024, 1024)])

    def test_sam_roi_preserves_padding_clipping_detector_mask_and_empty_behavior(self):
        for shape, target, roi in (
            ((32, 40), (12, 10, 30, 20), (10, 8, 32, 22)),
            ((100, 100), (20, 10, 80, 90), (16, 6, 84, 94)),
            ((32, 40), (0, 0, 40, 32), (0, 0, 40, 32)),
        ):
            with self.subTest(shape=shape, target=target):
                source = np.full(shape, -1, dtype=np.int16)
                left, top, right, bottom = target
                source[top:bottom, left:right] = 255
                predictor = Mock()
                predictor.predict.return_value = (np.ones((1, *shape), dtype=bool), np.asarray([0.9]), None)
                # A confirmed detector mask remains the source of ROI geometry,
                # even when the current segment has a different display mask.
                segment = {"class_name": "penis", "source": "target", "confidence": 0.9,
                           "mask": np.zeros(shape, dtype=np.uint8), "_detector_mask": source}
                result = DetectionMixin._high_precision_segments_with_predictor(
                    None, np.zeros((*shape, 3), dtype=np.uint8), [segment], predictor,
                )
                predictor.predict.assert_called_once()
                np.testing.assert_array_equal(predictor.predict.call_args.kwargs["box"], roi)
                self.assertEqual(result[0]["refinement"], "sam_high_precision")
                expected = np.zeros(shape, dtype=np.uint8)
                x1, y1, x2, y2 = roi
                expected[y1:y2, x1:x2] = 255
                np.testing.assert_array_equal(result[0]["mask"], expected)
        predictor = Mock()
        empty = {"class_name": "penis", "source": "target", "mask": np.zeros((8, 8), dtype=np.uint8)}
        self.assertEqual(DetectionMixin._high_precision_segments_with_predictor(
            None, np.zeros((8, 8, 3), dtype=np.uint8), [empty], predictor,
        ), [])
        predictor.predict.assert_not_called()

    def test_dense_sam_refinement_memory_preserves_detector_fallback(self):
        mask = np.full((1024, 1024), 255, dtype=np.uint8)
        rgb = np.zeros((*mask.shape, 3), dtype=np.uint8)
        predictor = Mock()
        predictor.predict.return_value = (np.zeros((1, *mask.shape), dtype=bool), np.asarray([0.9]), None)
        segment = {"class_name": "penis", "mask": mask, "source": "target", "confidence": 0.9}
        # Later SAM prompt buffers can hide a transient bbox allocation in the
        # total peak. Also require this call site to use the real helper whose
        # axis-sized allocation is measured independently above.
        with patch.object(detection_module, "mask_bounds", wraps=mask_bounds) as bounds:
            result = self.assert_peak(
                lambda: DetectionMixin._high_precision_segments_with_predictor(None, rgb, [segment], predictor),
                mask.nbytes, 30,
            )
        bounds.assert_called_once()
        self.assertEqual(bounds.call_args.args[0].dtype, np.dtype(bool))
        np.testing.assert_array_equal(bounds.call_args.args[0], mask > 0)
        self.assertEqual(result[0]["refinement"], "sam_fallback")
        np.testing.assert_array_equal(result[0]["mask"] > 0, mask > 0)
        predictor.predict.assert_called_once()
        np.testing.assert_array_equal(predictor.predict.call_args.kwargs["box"], (0, 0, 1024, 1024))

    def test_polygon_dense_bounds_memory_preserves_mask_and_interior_point(self):
        size = 1024
        roi, point, mask = self.assert_peak(
            lambda: polygon_roi_and_point(((0, 0), (size, 0), (size, size), (0, size)), size, size),
            size * size, 8,
        )
        self.assertEqual(roi, (0, 0, size, size))
        self.assertTrue(np.all(mask == 255))
        self.assertEqual(mask[int(point[1]), int(point[0])], 255)
        thin_roi, thin_point, thin = polygon_roi_and_point(((1, 1), (18, 1), (18, 2), (1, 2)), 20, 4)
        self.assertEqual(thin_roi, (1, 1, 19, 3))
        self.assertEqual(thin[int(thin_point[1]), int(thin_point[0])], 255)

    def test_fluid_dense_bounds_memory_does_not_allocate_per_pixel_coordinates(self):
        mask = np.full((1024, 1024), 255, dtype=np.uint8)
        rgb = np.zeros((*mask.shape, 3), dtype=np.uint8)
        # Color/component buffers have a larger peak than transient bbox
        # coordinates; inspect helper usage as well as the full operation.
        with patch.object(fluid_module, "mask_bounds", wraps=mask_bounds) as bounds:
            result = self.assert_peak(lambda: white_fluid_mask(rgb, mask), mask.nbytes, 32)
        bounds.assert_called_once()
        self.assertEqual(bounds.call_args.args[0].dtype, np.dtype(bool))
        np.testing.assert_array_equal(bounds.call_args.args[0], mask > 0)
        np.testing.assert_array_equal(result, np.zeros_like(mask))

    def test_fluid_bounds_ignore_negative_target_pixels_and_preserve_selected_region(self):
        mask = np.zeros((32, 40), dtype=np.int16)
        mask[3:27, 4:36] = 255
        mask[24:28, 30:34] = -1
        rgb = np.full((32, 40, 3), (130, 80, 70), dtype=np.uint8)
        rgb[9:13, 10:14] = 250
        rgb[24:28, 30:34] = 250
        expected = np.zeros(mask.shape, dtype=np.uint8)
        expected[9:13, 10:14] = 255
        np.testing.assert_array_equal(white_fluid_mask(rgb, mask), expected)
        np.testing.assert_array_equal(white_fluid_mask(rgb[::-1, ::-1], mask[::-1, ::-1]), expected[::-1, ::-1])

    def test_dense_manual_history_memory_and_exact_undo_redo(self):
        pixels = np.full((1024, 1024), 255, dtype=np.uint8)
        raw = self.png(pixels)
        change = self.assert_peak(lambda: WorkspaceStore._manual_xor(None, raw), pixels.nbytes, 8)
        self.assertEqual(change["box"], [0, 0, 1024, 1024])
        forward = WorkspaceStore._apply_manual_xor(None, change, forward=True)
        self.assert_mask(forward, pixels)
        self.assert_mask(WorkspaceStore._apply_manual_xor(forward, change, forward=False), None)

    def test_manual_history_crops_exact_changed_rectangle_and_reverses_both_directions(self):
        before = np.zeros((9, 11), dtype=np.uint8)
        before[0, 0] = 255
        before[4, 3] = 255
        after = before.copy()
        after[4, 3] = 0
        after[5, 7] = 255
        before_raw, after_raw = self.png(before), self.png(after)
        for roi in (None, (2, 3, 9, 7)):
            with self.subTest(roi=roi):
                change = WorkspaceStore._manual_xor(before_raw, after_raw, roi)
                self.assertEqual(change["box"], [3, 4, 5, 2])
                self.assert_mask(WorkspaceStore._apply_manual_xor(before_raw, change, forward=True), after)
                self.assert_mask(WorkspaceStore._apply_manual_xor(after_raw, change, forward=False), before)
        removed = WorkspaceStore._manual_xor(before_raw, None)
        self.assert_mask(WorkspaceStore._apply_manual_xor(before_raw, removed, forward=True), None)
        self.assert_mask(WorkspaceStore._apply_manual_xor(None, removed, forward=False), before)
        empty = self.png(np.zeros_like(before))
        no_pixels_changed = WorkspaceStore._manual_xor(None, empty)
        self.assertIsNone(no_pixels_changed["box"])
        self.assertFalse(no_pixels_changed["existsBefore"])
        self.assertTrue(no_pixels_changed["existsAfter"])


if __name__ == "__main__":
    unittest.main()
