"""Mosaicked PNGs retain visible pixels and alpha independently of metadata."""
from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

from mozarie.core import ImageRecord
from mozarie.detection import _inference_pixels, _clip_detection_masks_to_alpha
from mozarie.image_io import parse_png_chunks, render_output, render_with_mask


class MosaicTransparencyTests(unittest.TestCase):
    def test_colorkey_detection_blacks_out_and_clips_invisible_pixels(self):
        for mode in ("RGB", "L"):
            with self.subTest(mode=mode):
                path, _, _ = self.source(mode)
                with Image.open(path) as image:
                    pixels, alpha = _inference_pixels(image)
                np.testing.assert_array_equal(alpha, [[0, 255, 255, 255]])
                np.testing.assert_array_equal(pixels[0, 0], [0, 0, 0])
                np.testing.assert_array_equal(pixels[0, 1], [20, 30, 40] if mode == "RGB" else [20, 20, 20])
                mask = np.full((1, 4), 255, dtype=np.uint8)
                segments = [{"mask": mask, "_detector_mask": mask, "exclusions": {"hand": mask}}]
                _clip_detection_masks_to_alpha(segments, alpha)
                for result in (segments[0]["mask"], segments[0]["_detector_mask"], segments[0]["exclusions"]["hand"]):
                    np.testing.assert_array_equal(result, [[0, 255, 255, 255]])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def source(self, mode, *, key_matches_average=True):
        path = self.root / f"{mode}.png"
        key = (60, 70, 80) if mode == "RGB" else 60
        if not key_matches_average:
            key = (1, 2, 3) if mode == "RGB" else 7
        values = [(20, 30, 40), (100, 110, 120), (200, 210, 220)] if mode == "RGB" else [20, 100, 200]
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("parameters", "keep only when selected")
        significant_bits = b"\x08\x08\x08" if mode == "RGB" else b"\x08"
        background = b"\0\xff" * (3 if mode == "RGB" else 1)
        metadata.add(b"sBIT", significant_bits)
        metadata.add(b"bKGD", background)
        with Image.new(mode, (4, 1)) as image:
            image.putdata([key, *values])
            image.save(path, transparency=key, pnginfo=metadata)
        return path, significant_bits, background

    @staticmethod
    def record(path):
        stat = path.stat()
        return ImageRecord("image", path, path.name, 4, 1, stat.st_mtime_ns, stat.st_size)

    def test_colorkey_mosaic_preserves_alpha_pixels_and_selected_metadata(self):
        for mode in ("RGB", "L"):
            path, significant_bits, background = self.source(mode)
            original = path.read_bytes()
            for keep in (False, True):
                for selected in ([0, 1, 1, 0], [1, 1, 1, 0]):
                    with self.subTest(mode=mode, keep=keep, selected=selected):
                        mask = np.array([selected], dtype=np.uint8) * 255
                        payload = render_output(self.record(path), mask, 4, "original", keep)[0]
                        with Image.open(io.BytesIO(payload)) as saved, saved.convert("RGBA") as rgba:
                            pixels = np.asarray(rgba)
                            self.assertEqual(pixels[0, :, 3].tolist(), [0, 255, 255, 255])
                            # The visible average equals the old transparency key.
                            # Those selected pixels must remain opaque.
                            average = [60, 70, 80] if mode == "RGB" else [60, 60, 60]
                            self.assertEqual(pixels[0, 1, :3].tolist(), average)
                            self.assertEqual(pixels[0, 2, :3].tolist(), average)
                            last = [200, 210, 220] if mode == "RGB" else [200] * 3
                            self.assertEqual(pixels[0, 3, :3].tolist(), last)
                            self.assertEqual("parameters" in saved.info, keep)
                        chunks = {kind: chunk[8:-4] for kind, chunk in parse_png_chunks(payload)}
                        self.assertNotIn(b"tRNS", chunks, "explicit alpha replaces the color key")
                        if keep:
                            self.assertEqual(chunks[b"sBIT"], significant_bits + b"\x08")
                            self.assertEqual(chunks[b"bKGD"], background)
                        else:
                            self.assertNotIn(b"sBIT", chunks)
                            self.assertNotIn(b"bKGD", chunks)
                        self.assertEqual(path.read_bytes(), original)

    def test_transparent_colors_do_not_contribute_to_the_visible_average(self):
        for mode in ("RGB", "L"):
            path, _bits, _background = self.source(mode, key_matches_average=False)
            for keep in (False, True):
                with self.subTest(mode=mode, keep=keep):
                    mask = np.array([[1, 1, 1, 0]], dtype=np.uint8) * 255
                    payload = render_output(self.record(path), mask, 4, "png", keep)[0]
                    with Image.open(io.BytesIO(payload)) as saved, saved.convert("RGBA") as rgba:
                        expected = (60, 70, 80, 255) if mode == "RGB" else (60, 60, 60, 255)
                        self.assertEqual(rgba.getpixel((1, 0)), expected)
                        self.assertEqual(rgba.getpixel((2, 0)), expected)
                        self.assertEqual(rgba.getpixel((0, 0))[3], 0)

    def test_alpha_expansion_remains_editable_and_legacy_renderer_matches(self):
        for mode in ("RGB", "L"):
            with self.subTest(mode=mode):
                path, _bits, _background = self.source(mode)
                mask = np.array([[1, 1, 1, 0]], dtype=np.uint8) * 255
                rendered = render_with_mask(self.record(path), mask, 4)
                again = self.root / f"again-{mode}.png"
                again.write_bytes(rendered)
                rerendered = render_output(self.record(again), mask, 4, "png", True)[0]
                with Image.open(io.BytesIO(rendered)) as first, Image.open(io.BytesIO(rerendered)) as second:
                    with first.convert("RGBA") as first_rgba, second.convert("RGBA") as second_rgba:
                        np.testing.assert_array_equal(np.asarray(first_rgba), np.asarray(second_rgba))
                    self.assertEqual(second.info["parameters"], "keep only when selected")


if __name__ == "__main__":
    unittest.main()
