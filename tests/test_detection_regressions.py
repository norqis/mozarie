from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from mozarie.core import arbitrate_segment_sources
from mozarie.detection import _inference_pixels
from mozarie.state import StudioState


class SamFallbackRegressionTests(unittest.TestCase):
    def test_nonempty_detector_mask_is_preserved_when_sam_selects_nothing(self) -> None:
        source = np.zeros((8, 8), dtype=np.uint8)
        source[2:6, 2:6] = 255
        segment = {"class_name": "penis", "confidence": 0.61, "source": "target", "mask": source.copy()}
        predictor = Mock()
        predictor.predict.return_value = (np.zeros((1, 8, 8), dtype=bool), np.asarray([0.1]), None)

        result = StudioState._high_precision_segments_with_predictor(None, np.zeros((8, 8, 3), dtype=np.uint8), [segment], predictor)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["refinement"], "sam_fallback")
        self.assertTrue(np.array_equal(result[0]["mask"] > 0, source > 0))
        self.assertTrue(np.array_equal(result[0]["_apply_mask"] > 0, source > 0))

    def test_empty_detector_mask_does_not_publish_an_apply_candidate(self) -> None:
        segment = {
            "class_name": "penis", "confidence": 0.61, "source": "target",
            "mask": np.zeros((8, 8), dtype=np.uint8),
        }
        predictor = Mock()

        result = StudioState._high_precision_segments_with_predictor(None, np.zeros((8, 8, 3), dtype=np.uint8), [segment], predictor)

        self.assertEqual(result, [])
        predictor.predict.assert_not_called()


class DetectionIntegrityRegressionTests(unittest.TestCase):
    def test_transparent_pixels_use_black_inference_background_and_clip_every_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pixels = np.zeros((6, 6, 4), dtype=np.uint8)
            pixels[:, :3] = (12, 34, 56, 255)
            pixels[:, 3:] = (250, 240, 230, 0)
            path = root / "transparent.png"
            Image.fromarray(pixels).save(path)
            state = StudioState(root / "cache", root / "sessions")
            try:
                record = state.image_for_id(state.set_root(str(root))[0]["id"])
                full = np.full((6, 6), 255, dtype=np.uint8)
                segment = {
                    "class_name": "penis", "confidence": 0.8, "mask": full.copy(), "source": "target",
                    "image_exclusions": {"hand": full.copy()},
                    "metadata_exclusions": {"fluid": full.copy()},
                    "exclusions": {"fluid": full.copy()},
                }
                seen: list[np.ndarray] = []
                with patch.object(state, "_detect_arbitrated_segments", side_effect=lambda _models, rgb, *_args: seen.append(rgb.copy()) or [segment]), \
                     patch.object(state, "_hand_refinement_context", return_value=([segment], np.zeros_like(full), [])), \
                     patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                     patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items, *_args, **_kwargs: items):
                    candidates = state._detect_image(Mock(), record, .5)
                self.assertTrue(np.all(seen[0][:, :3] == (12, 34, 56)))
                self.assertTrue(np.all(seen[0][:, 3:] == 0))
                self.assertEqual(len(candidates), 4)
                for candidate in candidates:
                    with Image.open(candidate.mask_path) as mask:
                        value = np.asarray(mask)
                    self.assertTrue(np.all(value[:, :3] == 255))
                    self.assertTrue(np.all(value[:, 3:] == 0))
            finally:
                state.shutdown()

    def test_rgb_inference_pixels_are_unchanged(self) -> None:
        image = Image.new("RGB", (2, 1), (7, 8, 9))
        rgb, alpha = _inference_pixels(image)
        self.assertIsNone(alpha)
        self.assertTrue(np.array_equal(rgb, np.asarray(image)))

    def test_broad_auxiliary_mask_confirms_only_the_best_matching_target(self) -> None:
        left = np.zeros((40, 40), dtype=np.uint8); left[5:15, 5:15] = 255
        right = np.zeros((40, 40), dtype=np.uint8); right[20:30, 20:30] = 255
        broad = np.zeros((40, 40), dtype=np.uint8); broad[4:31, 4:31] = 255
        result = arbitrate_segment_sources([
            {"class_name": "penis", "confidence": .9, "mask": left, "source": "target"},
            {"class_name": "penis", "confidence": .8, "mask": right, "source": "target"},
            {"class_name": "penis", "confidence": .6, "mask": broad, "source": "ntd11"},
        ])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["_consensus_sources"], frozenset({"target", "ntd11"}))
        self.assertEqual(result[1]["_consensus_sources"], frozenset({"target"}))

    def test_source_priority_beats_confidence_independent_of_input_order(self) -> None:
        mask = np.zeros((12, 12), dtype=np.uint8); mask[2:10, 2:10] = 255
        for ordered in (
            [("sensitive", .99), ("ntd11", .98), ("target", .20)],
            [("target", .20), ("sensitive", .99), ("ntd11", .98)],
        ):
            with self.subTest(order=[source for source, _confidence in ordered]):
                result = arbitrate_segment_sources([
                    {"class_name": "penis", "confidence": confidence, "mask": mask.copy(), "source": source}
                    for source, confidence in ordered
                ])
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["source"], "target")
                self.assertEqual(result[0]["confidence"], .20)
                self.assertEqual(result[0]["_consensus_sources"], frozenset({"target", "ntd11", "sensitive"}))

    def test_single_auxiliary_duplicate_keeps_existing_consensus(self) -> None:
        mask = np.zeros((8, 8), dtype=np.uint8); mask[2:6, 2:6] = 255
        result = arbitrate_segment_sources([
            {"class_name": "penis", "confidence": .8, "mask": mask, "source": "target"},
            {"class_name": "penis", "confidence": .6, "mask": mask, "source": "ntd11"},
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["_consensus_sources"], frozenset({"target", "ntd11"}))

    def test_hand_box_envelope_matches_the_previous_union_without_stacking_masks(self) -> None:
        left = np.zeros((12, 12), dtype=np.uint8); left[2:4, 3:5] = 255
        right = np.zeros((12, 12), dtype=np.uint8); right[7:10, 8:11] = 255
        boxes = [(0, 0, 6, 6), (6, 6, 12, 12), (0, 8, 4, 12)]
        expected_union = np.any(np.asarray([left, right]) > 0, axis=0)
        rows, columns = np.nonzero(expected_union)
        expected = []
        for box_left, box_top, box_right, box_bottom in boxes:
            overlap = (max(box_left, int(columns.min())), max(box_top, int(rows.min())), min(box_right, int(columns.max()) + 1), min(box_bottom, int(rows.max()) + 1))
            if overlap[0] < overlap[2] and overlap[1] < overlap[3]:
                expected.append(overlap)

        class NoStackList(list[np.ndarray]):
            def __array__(self, *_args, **_kwargs):
                raise AssertionError("hand masks must not be materialized as an N-by-H-by-W array")

        self.assertEqual(StudioState._hand_boxes_over_apply(boxes, NoStackList([left, right])), expected)

        many = NoStackList([left.copy() if index % 2 == 0 else right.copy() for index in range(256)])
        self.assertEqual(StudioState._hand_boxes_over_apply(boxes, many), expected)


if __name__ == "__main__":
    unittest.main()
