"""Outline refinement selects the object without rewarding added background."""

import unittest

import numpy as np

from mozarie.core import select_semantic_sam_mask


class SamMaskSelectionTests(unittest.TestCase):
    def setUp(self):
        self.source = np.zeros((32, 32), dtype=bool)
        self.source[10:20, 10:20] = True
        self.hand = np.zeros_like(self.source)
        self.points = np.asarray([[15, 15]], dtype=np.float32)
        self.labels = np.asarray([1], dtype=np.int32)

    def select(self, masks, scores, **options):
        return select_semantic_sam_mask(np.asarray(masks), np.asarray(scores), self.source,
                                        self.hand, self.points, self.labels, **options)

    def test_added_background_cannot_win_by_retaining_slightly_more_detector_pixels(self):
        bloated = self.source.copy(); bloated[10:20, 20:28] = True
        tight = self.source.copy(); tight[19, 10:20] = False
        selected = self.select([bloated, tight], [.99, .8])
        self.assertIsNotNone(selected)
        self.assertEqual(selected[1], 1)
        np.testing.assert_array_equal(selected[0] > 0, tight)

    def test_valid_moderate_outline_expansion_is_still_accepted(self):
        expanded = self.source.copy(); expanded[10:20, 20] = True
        selected = self.select([expanded], [.9])
        self.assertIsNotNone(selected)
        np.testing.assert_array_equal(selected[0] > 0, expanded)

    def test_consensus_relaxation_keeps_hand_removal_ahead_of_source_overlap(self):
        self.hand[10, 10:20] = True
        clean = self.source & ~self.hand
        self.assertEqual(self.select([self.source, clean], [.99, .8])[1], 0)
        selected = self.select([self.source, clean], [.99, .8], prioritize_hand_overlap=True)
        self.assertEqual(selected[1], 1)
        self.assertFalse(np.any((selected[0] > 0) & self.hand))

    def test_equal_source_overlap_uses_quality_then_stable_proposal_order(self):
        self.assertEqual(self.select([self.source, self.source], [.8, .9])[1], 1)
        self.assertEqual(self.select([self.source, self.source], [.9, .9])[1], 0)
