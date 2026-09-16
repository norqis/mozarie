import io
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image, PngImagePlugin

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

    def test_pillow_pixel_guard_is_disabled_only_while_opening(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)
            with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                self.assertEqual(inspect_import_image(path, ".png"), (2, 2))
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 1)

    def test_pixel_guard_is_restored_after_concurrent_openers_finish(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.png"
            Image.new("RGB", (2, 2), "white").save(path)
            entered = threading.Barrier(3)
            release = threading.Event()
            failures: list[BaseException] = []

            def worker() -> None:
                try:
                    with open_image(path):
                        entered.wait(timeout=THREAD_TIMEOUT)
                        if not release.wait(THREAD_TIMEOUT):
                            raise RuntimeError("test did not release image openers")
                except BaseException as exc:  # test thread failures must be reported by the parent.
                    failures.append(exc)

            with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                threads = [threading.Thread(target=worker) for _index in range(2)]
                gate_reached = False
                try:
                    for thread in threads:
                        thread.start()
                    entered.wait(timeout=THREAD_TIMEOUT)
                    self.assertIsNone(Image.MAX_IMAGE_PIXELS)
                    release.set()
                    gate_reached = True
                finally:
                    release.set()
                    if not gate_reached:
                        entered.abort()
                    join_threads(*threads)
                self.assertEqual(failures, [])
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 1)

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

    def test_png_with_large_text_metadata_is_inspected_from_pixels(self):
        """A valid image must not disappear because optional PNG text is huge."""
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("parameters", "x" * 3_000_000)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.png"
            Image.new("RGB", (11, 7), "white").save(path, pnginfo=metadata)
            self.assertEqual(inspect_import_image(path, ".png"), (11, 7))

    def test_browser_staged_png_uses_the_logical_suffix_for_large_text_metadata(self):
        """A browser upload keeps its PNG format after staging under a .tmp name."""
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("workflow", "x" * 1_200_000, zip=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "browser.upload.tmp"
            Image.new("RGB", (11, 7), "white").save(path, format="PNG", pnginfo=metadata)
            self.assertEqual(inspect_import_image(path, ".png"), (11, 7))
