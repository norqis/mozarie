import io
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image, PngImagePlugin

import mozarie.image_io as image_io
from mozarie.core import ClientError, ImageRecord
from mozarie.image_io import canonical_image, inspect_import_image, open_image

THREAD_TIMEOUT = 30


def join_threads(*threads: threading.Thread) -> None:
    started = [thread for thread in threads if thread.ident is not None]
    for thread in started:
        thread.join(THREAD_TIMEOUT)
    for thread in started:
        if thread.is_alive():
            raise AssertionError(f"thread did not finish: {thread.name}")


class InputImageValidationTests(unittest.TestCase):
    def test_truncated_jpeg_is_rejected(self):
        output = io.BytesIO()
        Image.new("RGB", (4, 4), "white").save(output, format="JPEG")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "truncated.jpg"
            path.write_bytes(output.getvalue()[:-2])
            with self.assertRaises(ClientError):
                inspect_import_image(path, ".jpg")

    def test_valid_jpeg_with_trailing_payload_is_accepted_without_rewriting_source(self):
        output = io.BytesIO()
        Image.new("RGB", (9, 5), "white").save(output, format="JPEG")
        source = output.getvalue() + b"mozarie-trailing-payload"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trailing.jpg"
            path.write_bytes(source)

            self.assertEqual(inspect_import_image(path, ".jpg"), (9, 5))
            self.assertEqual(path.read_bytes(), source)

    def test_truncated_png_and_webp_are_rejected(self):
        for suffix, image_format in ((".png", "PNG"), (".webp", "WEBP")):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                output = io.BytesIO()
                Image.new("RGB", (16, 12), "white").save(output, format=image_format)
                path = Path(directory) / f"truncated{suffix}"
                path.write_bytes(output.getvalue()[:-10])
                with self.assertRaises(ClientError) as raised:
                    inspect_import_image(path, suffix)
                self.assertEqual(raised.exception.error_code, "image_read_failed")

    def test_verify_passes_but_pixel_decode_failure_is_rejected(self):
        """PNG chunk checks alone do not prove that the compressed pixels decode."""
        output = io.BytesIO()
        pixels = np.random.default_rng(3).integers(0, 256, (64, 64, 3), dtype=np.uint8)
        Image.fromarray(pixels).save(output, format="PNG")
        raw = output.getvalue()
        corrupted = bytearray(raw[:8])
        position = 8
        while position < len(raw):
            length = int.from_bytes(raw[position:position + 4], "big")
            chunk_type = raw[position + 4:position + 8]
            chunk = raw[position + 8:position + 8 + length]
            if chunk_type == b"IDAT":
                chunk = chunk[:-5]
            corrupted.extend(len(chunk).to_bytes(4, "big"))
            corrupted.extend(chunk_type)
            corrupted.extend(chunk)
            corrupted.extend((zlib.crc32(chunk_type + chunk) & 0xffffffff).to_bytes(4, "big"))
            position += length + 12
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "decode-failure.png"
            path.write_bytes(corrupted)
            with open_image(path) as image:
                image.verify()
            with self.assertRaises(ClientError) as raised:
                inspect_import_image(path, ".png")
            self.assertEqual(raised.exception.error_code, "image_read_failed")

    def test_import_uses_one_logical_image_wrapper_and_keeps_the_pixel_limit_disabled(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)

            self.assertIsNone(Image.MAX_IMAGE_PIXELS)
            with mock.patch.object(
                image_io,
                "open_image_without_png_text",
                wraps=image_io.open_image_without_png_text,
            ) as open_wrapper:
                self.assertEqual(inspect_import_image(path, ".png"), (2, 2))
            open_wrapper.assert_called_once_with(path, expected_suffix=".png")
            self.assertIsNone(Image.MAX_IMAGE_PIXELS)

    def test_concurrent_actual_reads_keep_the_process_pixel_limit_disabled(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for suffix, image_format in ((".png", "PNG"), (".jpg", "JPEG"), (".webp", "WEBP")):
                path = Path(directory) / f"small{suffix}"
                Image.new("RGB", (20, 10), "white").save(path, format=image_format)
                paths.append((path, suffix))
            start = threading.Barrier(len(paths) + 1)
            failures: list[BaseException] = []
            sizes: list[tuple[int, int]] = []

            def worker(path: Path, suffix: str) -> None:
                try:
                    start.wait(timeout=THREAD_TIMEOUT)
                    sizes.append(inspect_import_image(path, suffix))
                except BaseException as exc:  # test thread failures must be reported by the parent.
                    failures.append(exc)

            threads = [threading.Thread(target=worker, args=entry) for entry in paths]
            for thread in threads:
                thread.start()
            start.wait(timeout=THREAD_TIMEOUT)
            join_threads(*threads)
            self.assertEqual(failures, [])
            self.assertEqual(sorted(sizes), [(20, 10)] * len(paths))
            self.assertIsNone(Image.MAX_IMAGE_PIXELS)

    def test_open_failures_are_reported_as_image_read_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.png"
            path.write_bytes(b"not an image")
            with self.assertRaises(ClientError) as raised:
                inspect_import_image(path, ".png")
            self.assertEqual(raised.exception.error_code, "image_read_failed")

    def test_canonical_image_normalizes_pillow_decode_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (2, 2), "white").save(path)
            stat = path.stat()
            record = ImageRecord("source", path, path.name, 2, 2, stat.st_mtime_ns, stat.st_size)
            with mock.patch("mozarie.image_io.open_image_without_png_text", side_effect=SyntaxError("bad pixels")):
                with self.assertRaises(ClientError) as raised:
                    canonical_image(record)
            self.assertEqual(raised.exception.error_code, "image_read_failed")

    def test_transparent_png_preserves_shape_and_alpha_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transparent.png"
            source = Image.new("RGBA", (3, 2), (10, 20, 30, 255))
            source.putpixel((1, 0), (40, 50, 60, 0))
            source.save(path)
            stat = path.stat()
            record = ImageRecord("transparent", path, path.name, 3, 2, stat.st_mtime_ns, stat.st_size)

            loaded, _raw, _info = canonical_image(record)
            with loaded:
                self.assertEqual(loaded.size, (3, 2))
                self.assertEqual(loaded.mode, "RGBA")
                self.assertEqual(loaded.getpixel((1, 0)), (40, 50, 60, 0))

    def test_png_with_large_text_metadata_is_inspected_from_pixels(self):
        """A valid image must not disappear because optional PNG text is huge."""
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("parameters", "x" * 3_000_000)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.png"
            Image.new("RGB", (11, 7), "white").save(path, pnginfo=metadata)
            source = path.read_bytes()
            self.assertEqual(inspect_import_image(path, ".png"), (11, 7))
            self.assertEqual(path.read_bytes(), source)

    def test_browser_staged_png_uses_the_logical_suffix_for_large_text_metadata(self):
        """A browser upload keeps its PNG format after staging under a .tmp name."""
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("workflow", "x" * 1_200_000, zip=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "browser.upload.tmp"
            Image.new("RGB", (11, 7), "white").save(path, format="PNG", pnginfo=metadata)
            self.assertEqual(inspect_import_image(path, ".png"), (11, 7))
