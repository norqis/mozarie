from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import numpy as np

from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter
from mozarie.inference.yolo_segment import TargetSegmenter


class SegmentationGeometryTests(unittest.TestCase):
    def detect_mask(self, model_type, shape, model_box, *, split_axis=None):
        # Only the external inference session is replaced. Preprocessing,
        # ONNX run dispatch, box restoration, NMS and mask decoding are real.
        detector = model_type.__new__(model_type)
        detector.input_size = 1024
        detector.input_name = "images"
        detector.device = "cpu"
        detector.run_options = None
        detector.class_names = ("penis",)
        target = model_type is TargetSegmenter
        prediction = np.zeros((1, 43 if target else 37, 1), dtype=np.float32)
        prediction[0, :4, 0] = model_box
        prediction[0, 6 if target else 4, 0] = 0.9
        prediction[0, -32:, 0] = 1
        prototype = np.ones((1, 32, 32, 32), dtype=np.float32)
        if split_axis == "x":
            prototype[:, :, :, 16:] = -1
        elif split_axis == "y":
            prototype[:, :, 16:, :] = -1
        run = Mock(return_value=[prediction, prototype])
        detector.session = SimpleNamespace(run=run)
        rgb = np.full((*shape, 3), (20, 40, 60), dtype=np.uint8)
        before = rgb.copy()
        arguments = {} if target else {"source": "fixture"}
        segments = detector.detect(rgb, 0.5, **arguments)
        run.assert_called_once()
        tensor = run.call_args.args[1]["images"]
        self.assertEqual(tensor.shape, (1, 3, 1024, 1024))
        self.assertEqual(tensor.dtype, np.float32)
        np.testing.assert_array_equal(rgb, before)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["class_name"], "penis")
        self.assertEqual(segments[0]["source"], "target" if target else "fixture")
        self.assertAlmostEqual(segments[0]["confidence"], 0.9)
        mask = segments[0]["mask"]
        self.assertEqual(mask.shape, shape)
        self.assertEqual(mask.dtype, np.uint8)
        return mask

    def assert_thin_masks(self, model_type):
        cases = (
            ((1, 4096), (512, 511.125, 768, 0.25), (512, 0, 3584, 1)),
            ((4096, 1), (511.125, 512, 0.25, 768), (0, 512, 1, 3584)),
        )
        for shape, model_box, source_box in cases:
            with self.subTest(shape=shape):
                mask = self.detect_mask(model_type, shape, model_box)
                expected = np.zeros(shape, dtype=np.uint8)
                left, top, right, bottom = source_box
                expected[top:bottom, left:right] = 255
                np.testing.assert_array_equal(mask, expected)

    def test_target_detect_preserves_one_pixel_edges_and_constrains_the_mask(self):
        self.assert_thin_masks(TargetSegmenter)

    def test_generic_detect_preserves_one_pixel_edges_and_constrains_the_mask(self):
        self.assert_thin_masks(GenericYoloSegmenter)

    def test_normal_aspect_and_odd_padding_preserve_mask_position(self):
        cases = (
            ((96, 128), (512, 512, 768, 576), "x", (16, 12, 64, 84)),
            ((128, 96), (512, 512, 576, 768), "y", (12, 16, 84, 64)),
            # 511 source pixels leave 256/257 pixels of asymmetric padding.
            ((511, 1024), (512, 511.5, 512, 255), "y", (256, 128, 768, 256)),
            ((1024, 511), (511.5, 512, 255, 512), "x", (128, 256, 256, 768)),
        )
        for model_type in (TargetSegmenter, GenericYoloSegmenter):
            for shape, model_box, split_axis, mask_box in cases:
                with self.subTest(model=model_type.__name__, shape=shape):
                    mask = self.detect_mask(model_type, shape, model_box, split_axis=split_axis)
                    expected = np.zeros(shape, dtype=np.uint8)
                    left, top, right, bottom = mask_box
                    expected[top:bottom, left:right] = 255
                    np.testing.assert_array_equal(mask, expected)


if __name__ == "__main__":
    unittest.main()
