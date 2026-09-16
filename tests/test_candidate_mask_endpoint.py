from __future__ import annotations

import io
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path

import numpy as np
from PIL import Image

from mozarie.catalog import CatalogMixin
from mozarie.core import Candidate


class CandidateMaskEndpointTests(unittest.TestCase):
    def _png(self, image: Image.Image) -> bytes:
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def _read(self, raw: bytes) -> Image.Image:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.png"
            path.write_bytes(raw)
            catalog = type("Catalog", (), {
                "lock": threading.RLock(),
                "candidates": {"image": [Candidate("candidate", "penis", .9, path)]},
                "image_io_lock": lambda self, _image_id: nullcontext(),
                "_candidate_revision": lambda self, _image_id: 1,
            })()
            encoded = CatalogMixin.read_candidate_mask_png(catalog, "image", "candidate")
        with Image.open(io.BytesIO(encoded)) as image:
            return image.copy()

    def test_candidate_endpoint_uses_alpha_for_rgba_and_la_and_luminance_for_l_and_1(self) -> None:
        rgba = Image.new("RGBA", (2, 1)); rgba.putdata([(255, 255, 255, 0), (0, 0, 0, 128)])
        la = Image.new("LA", (2, 1)); la.putdata([(255, 0), (0, 128)])
        grayscale = Image.new("L", (2, 1)); grayscale.putdata([0, 7])
        binary = Image.new("1", (2, 1)); binary.putdata([0, 1])
        for source, expected in ((rgba, [0, 255]), (la, [0, 255]), (grayscale, [0, 255]), (binary, [0, 255])):
            with self.subTest(mode=source.mode):
                result = self._read(self._png(source))
                self.assertEqual(result.mode, "RGBA")
                self.assertTrue(np.array_equal(np.asarray(result)[0, :, 3], expected))
                self.assertTrue(np.all(np.asarray(result)[..., :3] == 255))
