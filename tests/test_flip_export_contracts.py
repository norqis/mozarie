"""User-observable flip and export contracts.

These tests intentionally decode the bytes produced by the product renderer.
They protect pixels, container type, transparency, metadata, and orientation;
checking helper calls or source strings would not protect the saved file.
"""

from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

from mozarie.core import ClientError, ImageRecord
from mozarie.image_io import render_output


class FlipExportContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def record(self, path: Path, *, width: int | None = None, height: int | None = None,
               flip_h: bool = False, flip_v: bool = False) -> ImageRecord:
        stat = path.stat()
        with Image.open(path) as image:
            natural_width, natural_height = image.size
        return ImageRecord(
            image_id="source", path=path, relative_path=path.name,
            width=width or natural_width, height=height or natural_height,
            mtime_ns=stat.st_mtime_ns, size_bytes=stat.st_size,
            flip_horizontal=flip_h, flip_vertical=flip_v,
        )

    @staticmethod
    def decoded(payload: bytes) -> Image.Image:
        image = Image.open(io.BytesIO(payload))
        image.load()
        return image

    def asymmetric_source(self, suffix: str = ".png") -> tuple[Path, np.ndarray]:
        pixels = np.array([
            [[250, 0, 0], [0, 240, 0], [0, 0, 230]],
            [[220, 220, 0], [210, 0, 210], [0, 200, 200]],
        ], dtype=np.uint8)
        path = self.root / f"asymmetric{suffix}"
        Image.fromarray(pixels).save(path)
        return path, pixels

    def test_all_flip_combinations_preserve_dimensions_and_exact_pixel_coordinates(self) -> None:
        path, pixels = self.asymmetric_source()
        expected = {
            (False, False): pixels,
            (True, False): np.fliplr(pixels),
            (False, True): np.flipud(pixels),
            (True, True): np.flipud(np.fliplr(pixels)),
        }
        for flips, expected_pixels in expected.items():
            with self.subTest(flips=flips):
                payload, suffix, mime = render_output(
                    self.record(path, flip_h=flips[0], flip_v=flips[1]), None, 4, "original", True,
                )
                image = self.decoded(payload)
                self.assertEqual((suffix, mime, image.format, image.size), (".png", "image/png", "PNG", (3, 2)))
                np.testing.assert_array_equal(np.asarray(image.convert("RGB")), expected_pixels)

    def test_mosaic_pixels_and_image_are_flipped_together(self) -> None:
        pixels = np.zeros((4, 6, 3), dtype=np.uint8)
        for y in range(4):
            for x in range(6):
                pixels[y, x] = (x * 31, y * 47, (x + y) * 23)
        path = self.root / "masked.png"
        Image.fromarray(pixels).save(path)
        mask = np.zeros((4, 6), dtype=np.uint8)
        mask[0:2, 0:2] = 255
        canonical = np.asarray(self.decoded(render_output(self.record(path), mask, 2, "png", False)[0]).convert("RGB"))
        horizontal = np.asarray(self.decoded(render_output(self.record(path, flip_h=True), mask, 2, "png", False)[0]).convert("RGB"))
        vertical = np.asarray(self.decoded(render_output(self.record(path, flip_v=True), mask, 2, "png", False)[0]).convert("RGB"))
        np.testing.assert_array_equal(horizontal, np.fliplr(canonical))
        np.testing.assert_array_equal(vertical, np.flipud(canonical))

    def test_png_text_is_preserved_or_removed_according_to_the_export_choice(self) -> None:
        path = self.root / "text.png"
        info = PngImagePlugin.PngInfo()
        for key, value in {"parameters": "params", "prompt": "prompt", "workflow": "workflow"}.items():
            info.add_text(key, value)
        Image.new("RGB", (4, 3), "#4a6c8e").save(path, pnginfo=info)
        record = self.record(path)
        kept = self.decoded(render_output(record, None, 4, "png", True)[0])
        dropped = self.decoded(render_output(record, None, 4, "png", False)[0])
        jpeg, suffix, mime = render_output(record, None, 4, "jpg", False)
        converted = self.decoded(jpeg)
        self.assertEqual({key: kept.text[key] for key in ("parameters", "prompt", "workflow")},
                         {"parameters": "params", "prompt": "prompt", "workflow": "workflow"})
        self.assertTrue(all(key not in dropped.info for key in ("parameters", "prompt", "workflow")))
        self.assertEqual((suffix, mime, converted.format), (".jpg", "image/jpeg", "JPEG"))
        self.assertTrue(all(key not in converted.info for key in ("parameters", "prompt", "workflow")))
        with self.assertRaises(ClientError) as raised:
            render_output(record, None, 4, "jpg", True)
        self.assertEqual(raised.exception.error_code, "input_invalid")

    def test_transparency_is_kept_for_png_and_composited_over_white_for_jpeg(self) -> None:
        path = self.root / "alpha.png"
        image = Image.new("RGBA", (2, 1), (10, 20, 30, 0))
        image.putpixel((1, 0), (80, 90, 100, 255))
        image.save(path)
        record = self.record(path)
        png = self.decoded(render_output(record, None, 4, "png", False)[0]).convert("RGBA")
        jpeg = self.decoded(render_output(record, None, 4, "jpg", False)[0]).convert("RGB")
        self.assertEqual([png.getpixel((x, 0))[3] for x in range(2)], [0, 255])
        self.assertTrue(all(channel >= 248 for channel in jpeg.getpixel((0, 0))))
        self.assertTrue(all(abs(actual - expected) <= 10 for actual, expected in zip(jpeg.getpixel((1, 0)), (80, 90, 100))))

    def test_palette_rgb_and_grayscale_colorkey_transparency_survives_metadata_drop(self) -> None:
        fixtures: list[tuple[str, Image.Image, object]] = []
        palette = Image.new("P", (2, 1)); palette.putpalette([0, 0, 0, 90, 100, 110] + [0] * 762); palette.putdata([0, 1])
        fixtures.append(("palette", palette, 0))
        rgb = Image.new("RGB", (2, 1), (1, 2, 3)); rgb.putpixel((1, 0), (80, 90, 100))
        fixtures.append(("rgb", rgb, (1, 2, 3)))
        gray = Image.new("L", (2, 1), 7); gray.putpixel((1, 0), 180)
        fixtures.append(("gray", gray, 7))
        for name, source, transparency in fixtures:
            with self.subTest(mode=name):
                path = self.root / f"{name}.png"
                source.save(path, format="PNG", transparency=transparency)
                saved = self.decoded(render_output(self.record(path), None, 4, "original", False)[0]).convert("RGBA")
                self.assertEqual([saved.getpixel((x, 0))[3] for x in range(2)], [0, 255])

    def test_original_jpeg_preserves_exif_and_icc_but_normalizes_orientation(self) -> None:
        path = self.root / "oriented.jpeg"
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "Mozarie export contract"
        Image.new("RGB", (4, 2), "#7395b7").save(path, format="JPEG", exif=exif, icc_profile=b"contract ICC")
        payload, suffix, mime = render_output(self.record(path, width=2, height=4, flip_h=True), None, 4, "original", True)
        saved = self.decoded(payload)
        self.assertEqual((suffix, mime, saved.format, saved.size), (".jpeg", "image/jpeg", "JPEG", (2, 4)))
        self.assertEqual(saved.getexif().get(274), 1)
        self.assertEqual(saved.getexif().get(270), "Mozarie export contract")
        self.assertEqual(saved.info.get("icc_profile"), b"contract ICC")

    def test_explicit_jpg_export_drops_source_exif_comment_and_icc(self) -> None:
        path = self.root / "metadata.jpg"
        exif = Image.Exif(); exif[270] = "must be removed"
        Image.new("RGB", (4, 3), "#507090").save(path, format="JPEG", exif=exif, icc_profile=b"must be removed")
        original = path.read_bytes()
        comment = b"Mozarie source comment"
        path.write_bytes(original[:2] + b"\xff\xfe" + (len(comment) + 2).to_bytes(2, "big") + comment + original[2:])
        payload, suffix, mime = render_output(self.record(path), None, 4, "jpg", False)
        saved = self.decoded(payload)
        self.assertEqual((suffix, mime, saved.format), (".jpg", "image/jpeg", "JPEG"))
        self.assertFalse(bool(saved.getexif()))
        self.assertNotIn("icc_profile", saved.info)
        self.assertNotIn(comment, payload)

    def test_cross_format_export_does_not_invent_png_text_and_respects_requested_container(self) -> None:
        jpeg_path = self.root / "source.jpg"
        exif = Image.Exif(); exif[270] = "source comment"
        Image.new("RGB", (5, 3), "#2468ac").save(jpeg_path, format="JPEG", exif=exif, icc_profile=b"source ICC")
        png_payload, suffix, mime = render_output(self.record(jpeg_path), None, 4, "png", True)
        png = self.decoded(png_payload)
        self.assertEqual((suffix, mime, png.format, png.size), (".png", "image/png", "PNG", (5, 3)))
        self.assertEqual(png.info.get("icc_profile"), b"source ICC")
        self.assertNotIn("prompt", png.info)
        self.assertNotIn("workflow", png.info)

    def test_webp_metadata_is_preserved_for_original_and_removed_when_disabled(self) -> None:
        path = self.root / "metadata.webp"
        exif = Image.Exif(); exif[270] = "webp contract"
        Image.new("RGB", (4, 3), "#6284a6").save(
            path, format="WEBP", exif=exif, icc_profile=b"webp ICC", xmp=b"<x:xmpmeta>contract</x:xmpmeta>",
        )
        record = self.record(path)
        kept = self.decoded(render_output(record, None, 4, "original", True)[0])
        dropped = self.decoded(render_output(record, None, 4, "original", False)[0])
        self.assertEqual(kept.info.get("icc_profile"), b"webp ICC")
        self.assertEqual(kept.info.get("xmp"), b"<x:xmpmeta>contract</x:xmpmeta>")
        self.assertEqual(kept.getexif().get(270), "webp contract")
        self.assertNotIn("icc_profile", dropped.info)
        self.assertNotIn("xmp", dropped.info)
        self.assertFalse(bool(dropped.getexif()))
