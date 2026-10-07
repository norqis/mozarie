"""Same-score NumPy candidates retain order and source ranking during merging."""

import unittest

import numpy as np

from mozarie.core import merge_segment, merge_tile_segment


class TileMergeTests(unittest.TestCase):
    def test_later_duplicate_does_not_compare_an_unrelated_numpy_mask(self):
        first = np.zeros((8, 8), dtype=np.uint8); first[:2, :2] = 255
        second = np.zeros_like(first); second[5:7, 5:7] = 255
        for merge, options in ((merge_segment, {}), (merge_tile_segment, {"x_offset": 0, "y_offset": 0})):
            for score, source, replace in ((.95, "target", True), (.8, "target", False), (.9, "target", False), (.99, "ntd11", False)):
                with self.subTest(merge=merge.__name__, score=score, source=source):
                    segments = []
                    merge(segments, "penis", .9, first, **options)
                    merge(segments, "penis", .9, second, **options)
                    old_first, old_second = segments
                    identity = id(segments)
                    replacement = second.copy()
                    merge(segments, "penis", score, replacement, source=source, **options)
                    self.assertEqual(id(segments), identity)
                    self.assertEqual(len(segments), 2)
                    self.assertIs(segments[0], old_first)
                    if replace:
                        self.assertIs(segments[1]["mask"], replacement)
                        self.assertEqual(segments[1]["confidence"], score)
                    else:
                        self.assertIs(segments[1], old_second)
                    np.testing.assert_array_equal(segments[1]["mask"], second)

    def test_bridge_removes_every_duplicate_without_reordering_other_classes(self):
        first = np.zeros((8, 8), dtype=np.uint8); first[:2, :2] = 255
        second = np.zeros_like(first); second[5:7, 5:7] = 255
        bridge = first | second
        for merge, options in ((merge_segment, {}), (merge_tile_segment, {"x_offset": 0, "y_offset": 0})):
            with self.subTest(merge=merge.__name__):
                segments = []
                merge(segments, "pussy", .9, first, **options)
                merge(segments, "penis", .9, first, **options)
                merge(segments, "penis", .9, second, **options)
                untouched = segments[0]
                merge(segments, "penis", .95, bridge, **options)
                self.assertEqual(len(segments), 2)
                self.assertIs(segments[0], untouched)
                self.assertEqual(segments[1]["confidence"], .95)
                np.testing.assert_array_equal(segments[1]["mask"], bridge)


if __name__ == "__main__":
    unittest.main()
