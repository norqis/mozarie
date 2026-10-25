"""Exclusion finalization keeps working memory independent of candidate count."""

import tracemalloc
import unittest

import numpy as np

from mozarie.detection import DetectionMixin


class ExclusionMemoryTests(unittest.TestCase):
    def test_many_candidates_do_not_copy_full_image_planes_per_candidate(self):
        subject = DetectionMixin()
        subject.settings = {"detection": {"fluid_exclusion_enabled": False}}
        rgb = np.zeros((512, 512, 3), dtype=np.uint8)
        hand = np.zeros(rgb.shape[:2], dtype=np.uint8)
        segments = []
        for index in range(24):
            mask = np.zeros(hand.shape, dtype=np.uint8)
            mask[index:index + 100, index:index + 100] = 255
            segments.append({"class_name": "penis", "mask": mask, "_detector_mask": mask,
                             "_confirmed_hand": hand, "source": "target", "confidence": .9})
        original_masks = [segment["mask"] for segment in segments]
        tracemalloc.start()
        try:
            result = subject._finalize_exclusions(rgb, segments)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertLess(peak, hand.nbytes * 20 + 128 * 1024)
        self.assertEqual(len(result), 24)
        for index, (before, after) in enumerate(zip(original_masks, result)):
            self.assertIs(after["mask"], before)
            self.assertEqual(np.count_nonzero(after["mask"]), 10000)
            self.assertTrue(np.all(before[index:index + 100, index:index + 100] == 255))
            self.assertEqual(after["exclusions"], {})
            self.assertEqual(after["image_exclusions"], {})
        self.assertFalse(np.any(hand))
        self.assertFalse(np.any(rgb))

    def test_confirmed_hand_precedes_fallback_and_finalization_preserves_inputs(self):
        subject = DetectionMixin()
        subject.settings = {"detection": {"fluid_exclusion_enabled": True}}
        rgb = np.full((64, 64, 3), (150, 100, 80), dtype=np.uint8); rgb[25:29, 25:29] = 255
        mask = np.zeros((64, 64), dtype=np.uint8); mask[8:56, 8:56] = 255
        fallback = np.zeros_like(mask); fallback[10:18, 10:18] = 255
        confirmed = np.zeros_like(mask)
        originals = [array.copy() for array in (rgb, mask, fallback, confirmed)]
        segment = {"class_name": "penis", "mask": mask, "_confirmed_hand": confirmed,
                   "image_exclusions": {"hand": fallback}}
        result = subject._finalize_exclusions(rgb, [segment], fluid_color_fill=(True, 26))
        self.assertEqual(result[0]["image_exclusions"], {})
        self.assertTrue(np.any(result[0]["exclusions"]["fluid"]))
        segment = {"class_name": "penis", "mask": mask, "image_exclusions": {"hand": fallback}}
        result = subject._finalize_exclusions(rgb, [segment])
        np.testing.assert_array_equal(result[0]["image_exclusions"]["hand"], fallback)
        for actual, original in zip((rgb, mask, fallback, confirmed), originals):
            np.testing.assert_array_equal(actual, original)

    def test_negative_hand_and_detector_pixels_do_not_create_exclusions(self):
        subject = DetectionMixin()
        subject.settings = {"detection": {"fluid_exclusion_enabled": False}}
        mask = np.zeros((16, 16), dtype=np.int16); mask[2:14, 2:14] = 255; mask[0, 0] = -1
        hand = np.zeros_like(mask); hand[0, 0] = 255; hand[4:6, 4:6] = -1
        original = mask.copy()
        segment = {"class_name": "penis", "mask": mask, "_confirmed_hand": hand}
        result = subject._finalize_exclusions(np.zeros((16, 16, 3), dtype=np.uint8), [segment])
        self.assertEqual(result[0]["image_exclusions"], {})
        np.testing.assert_array_equal(result[0]["mask"], original)
