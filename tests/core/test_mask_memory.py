"""Empty mask composition does not allocate unused full-image exclusion planes."""
import tracemalloc
import unittest

import numpy as np

from mozarie.masks import compose_masks


class MaskMemoryTests(unittest.TestCase):
    def test_empty_composition_needs_only_result_sized_storage(self):
        tracemalloc.start()
        try:
            mask = compose_masks((1024, 2048), [], [])
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertFalse(np.any(mask))
        self.assertLess(peak, mask.nbytes * 2, "unused exclusion masks must not multiply full-image memory")
