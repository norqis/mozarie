"""User-observable flip and export contracts.

These tests intentionally decode the bytes produced by the product renderer.
They protect pixels, container type, transparency, metadata, and orientation;
checking helper calls or source strings would not protect the saved file.
"""

from __future__ import annotations

import io
import gc
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image, ImageOps, PngImagePlugin

from mozarie.core import ClientError, ImageRecord, Job, JobControl
from mozarie.detection import DetectionModels
from mozarie.domain import Candidate
import mozarie.saving as saving_module
from mozarie.image_io import render_output, transform_mask
from mozarie.state import StudioState


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
        dropped_payload = render_output(record, None, 4, "png", False)[0]
        dropped = self.decoded(dropped_payload)
        jpeg, suffix, mime = render_output(record, None, 4, "jpg", False)
        converted = self.decoded(jpeg)
        self.assertEqual({key: kept.text[key] for key in ("parameters", "prompt", "workflow")},
                         {"parameters": "params", "prompt": "prompt", "workflow": "workflow"})
        self.assertTrue(all(key not in dropped.info for key in ("parameters", "prompt", "workflow")))
        self.assertNotEqual(dropped_payload, path.read_bytes(), "metadata-off re-encodes the image instead of returning the original source bytes")
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
                metadata = PngImagePlugin.PngInfo(); metadata.add_text("parameters", f"remove-{name}")
                source.save(path, format="PNG", transparency=transparency, pnginfo=metadata)
                saved = self.decoded(render_output(self.record(path), None, 4, "original", False)[0]).convert("RGBA")
                self.assertEqual([saved.getpixel((x, 0))[3] for x in range(2)], [0, 255])
                self.assertNotIn("parameters", saved.info)

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
        pixels = np.zeros((3, 5, 3), dtype=np.uint8)
        pixels[:, :2] = (220, 30, 40); pixels[:, 2:] = (20, 80, 210)
        Image.fromarray(pixels).save(jpeg_path, format="JPEG", quality=100, subsampling=0, exif=exif, icc_profile=b"source ICC")
        with Image.open(jpeg_path) as source:
            decoded_source = np.asarray(source.convert("RGB")).copy()
        png_payload, suffix, mime = render_output(self.record(jpeg_path), None, 4, "png", True)
        png = self.decoded(png_payload)
        self.assertEqual((suffix, mime, png.format, png.size), (".png", "image/png", "PNG", (5, 3)))
        self.assertEqual(png.info.get("icc_profile"), b"source ICC")
        self.assertEqual(png.getexif().get(270), "source comment")
        self.assertNotIn("prompt", png.info)
        self.assertNotIn("workflow", png.info)
        np.testing.assert_array_equal(np.asarray(png.convert("RGB")), decoded_source, "cross-format PNG keeps the decoded source dimensions, direction, and pixels")

    def test_mixed_format_batch_outputs_each_requested_container_with_its_own_geometry_transform_and_masks(self) -> None:
        sources: list[tuple[Path, str]] = []
        first_pixels = np.zeros((5, 7, 3), dtype=np.uint8)
        for y in range(5):
            for x in range(7): first_pixels[y, x] = (x * 31, y * 41, (x + y) * 19)
        png_info = PngImagePlugin.PngInfo(); png_info.add_text("parameters", "mixed png metadata")
        Image.fromarray(first_pixels).save(self.root / "one.png", pnginfo=png_info); sources.append((self.root / "one.png", "PNG"))
        jpeg_exif = Image.Exif(); jpeg_exif[270] = "mixed jpeg metadata"
        Image.new("RGB", (6, 4), "#42668a").save(self.root / "two.jpg", exif=jpeg_exif, icc_profile=b"mixed jpeg ICC"); sources.append((self.root / "two.jpg", "JPEG"))
        webp_exif = Image.Exif(); webp_exif[270] = "mixed webp metadata"
        Image.new("RGB", (5, 3), "#53779b").save(self.root / "three.webp", exif=webp_exif, icc_profile=b"mixed webp ICC", xmp=b"mixed webp XMP"); sources.append((self.root / "three.webp", "WEBP"))
        fourth_pixels = np.zeros((3, 4, 3), dtype=np.uint8)
        fourth_pixels[:, :2] = (230, 40, 60); fourth_pixels[:, 2:] = (20, 80, 220)
        Image.fromarray(fourth_pixels).save(self.root / "four.png"); sources.append((self.root / "four.png", "PNG"))
        for output_format, expected_format in (("png", "PNG"), ("jpg", "JPEG")):
            rendered: list[Image.Image] = []
            try:
                for index, (path, _source_format) in enumerate(sources):
                    with Image.open(path) as source:
                        source_size = source.size
                    mask = np.zeros((source_size[1], source_size[0]), dtype=np.uint8)
                    mask[0:2, 0:2] = 255
                    mask[0, 0] = 0  # composed exclusion hole
                    payload, suffix, mime = render_output(
                        self.record(path, flip_h=index in {1, 3}, flip_v=index in {2, 3}), mask, 2, output_format, False,
                    )
                    image = self.decoded(payload); rendered.append(image)
                    self.assertEqual(image.format, expected_format)
                    self.assertEqual(suffix, ".png" if output_format == "png" else ".jpg")
                    self.assertEqual(mime, "image/png" if output_format == "png" else "image/jpeg")
                    self.assertEqual(image.size, source_size)
                    self.assertFalse(bool(image.getexif()), "batch conversion with metadata disabled drops source EXIF")
                    self.assertNotIn("icc_profile", image.info)
                    self.assertNotIn("xmp", image.info)
                    self.assertNotIn("parameters", image.info)
                self.assertEqual(len(rendered), 4, "every mixed-format input and all four flip states produce their own output")
                first_output = np.asarray(rendered[0].convert("RGB"))
                self.assertLess(float(np.abs(first_output[0, 0].astype(np.int16) - first_pixels[0, 0].astype(np.int16)).mean()), 18.0, "the composed exclusion hole keeps its source pixel")
                self.assertNotEqual(first_output[0, 1].tolist(), first_pixels[0, 1].tolist(), "the remaining mask applies its mosaic")
            finally:
                for image in rendered: image.close()

    def test_render_releases_every_source_decoder_and_temporary_output_between_repeated_conversions(self) -> None:
        path = self.root / "repeat.png"
        Image.new("RGBA", (128, 96), (20, 40, 60, 128)).save(path)
        record = self.record(path)
        for index in range(5):
            payload, suffix, _mime = render_output(record, None, 8, "jpg" if index % 2 else "png", False)
            with Image.open(io.BytesIO(payload)) as decoded:
                decoded.load(); self.assertEqual(decoded.size, (128, 96))
            self.assertIn(suffix, {".png", ".jpg"})
            del payload
        gc.collect()
        moved = self.root / "released.png"
        path.replace(moved)
        self.assertTrue(moved.is_file(), "the renderer closes the source after every conversion")
        moved.unlink()
        self.assertFalse(moved.exists(), "no conversion retains a source file or output decoder")

    def test_original_jpeg_orientation_and_each_user_flip_are_applied_exactly_once(self) -> None:
        pixels = np.zeros((4, 6, 3), dtype=np.uint8)
        pixels[:, :2] = (240, 20, 20); pixels[:, 2:4] = (20, 230, 20); pixels[:, 4:] = (20, 20, 220)
        path = self.root / "orientation-six.jpg"
        exif = Image.Exif(); exif[274] = 6
        Image.fromarray(pixels).save(path, quality=100, subsampling=0, exif=exif)
        with Image.open(path) as source:
            normalized = np.asarray(ImageOps.exif_transpose(source).convert("RGB"))
        for horizontal, vertical, expected in (
            (True, False, np.fliplr(normalized)),
            (False, True, np.flipud(normalized)),
        ):
            payload = render_output(self.record(path, width=4, height=6, flip_h=horizontal, flip_v=vertical), None, 4, "original", True)[0]
            with Image.open(io.BytesIO(payload)) as saved:
                actual = np.asarray(saved.convert("RGB"))
                self.assertEqual(saved.size, (4, 6))
                self.assertEqual(saved.getexif().get(274), 1)
            self.assertLess(float(np.abs(actual.astype(np.int16) - expected.astype(np.int16)).mean()), 8.0)

    def test_overwritten_flip_is_unwound_for_detection_and_reapplied_to_the_candidate_display(self) -> None:
        canonical = np.zeros((4, 6, 3), dtype=np.uint8)
        canonical[:, :3] = (210, 30, 40); canonical[:, 3:] = (20, 70, 220)
        source_root = self.root / "detect-source"; source_root.mkdir()
        path = source_root / "overwritten.png"
        Image.fromarray(np.fliplr(canonical)).save(path)
        state = StudioState(self.root / "cache-detect", self.root / "sessions-detect")
        seen: list[np.ndarray] = []
        detector_mask = np.zeros((4, 6), dtype=np.uint8); detector_mask[1, 1] = 255
        segment = {"class_name": "penis", "confidence": .9, "source": "target", "mask": detector_mask}
        try:
            image_id = state.set_root(str(source_root))[0]["id"]
            record = state.image_for_id(image_id)
            record.flip_horizontal = True; record.source_flip_horizontal = True
            with patch.object(state, "_detect_arbitrated_segments", side_effect=lambda _models, rgb, *_args: seen.append(rgb.copy()) or [segment]), \
                 patch.object(state, "_hand_refinement_context", return_value=([segment], np.zeros((4, 6), dtype=np.uint8), [])), \
                 patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                 patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items, *_args, **_kwargs: items):
                candidates = state._detect_image(DetectionModels(target=Mock()), record, .5, fluid_exclusion_enabled=False)
            np.testing.assert_array_equal(seen[0], canonical, "the detector receives original canonical coordinates after a flipped overwrite")
            with Image.open(candidates[0].mask_path) as stored:
                canonical_mask = np.asarray(stored).copy()
            np.testing.assert_array_equal(canonical_mask, detector_mask)
            displayed = transform_mask(canonical_mask, record.flip_horizontal, record.flip_vertical)
            self.assertEqual(int(displayed[1, 4]), 255, "the canonical detection candidate is re-flipped onto the visible image")
            self.assertEqual(int(displayed[1, 1]), 0, "the candidate is not left at the opposite canonical position")
        finally:
            state.shutdown()

    def test_projectless_flip_survives_project_naming_reopen_readonly_and_mask_clear(self) -> None:
        source_root = self.root / "project-source"; source_root.mkdir()
        path = source_root / "first.png"; Image.new("RGB", (9, 7), "#7597b9").save(path)
        second = source_root / "second.png"; Image.new("RGB", (9, 7), "#86a8ca").save(second)
        cache = self.root / "project-cache"; sessions = self.root / "project-sessions"
        state = StudioState(cache, sessions)
        reopened = None
        try:
            images = state.set_root(str(source_root)); first_id, second_id = images[0]["id"], images[1]["id"]
            state.set_image_transform(first_id, {"flipH": True, "flipV": False})
            self.assertEqual((state.image_for_id(first_id).flip_horizontal, state.image_for_id(second_id).flip_horizontal), (True, False), "a projectless flip affects only its selected image")
            project = state.name_current_project("flip persistence")
            project_id = str(project["id"])
            state.close_project()
            opened = state.open_project(project_id)
            by_id = {image["id"]: image for image in opened["images"]}
            self.assertEqual((by_id[first_id]["flipH"], by_id[first_id]["flipV"]), (True, False), "naming and reopening a project retains the projectless flip")
            self.assertEqual((by_id[second_id]["flipH"], by_id[second_id]["flipV"]), (False, False), "the other image remains unflipped after reopen")
            state.clear_masks([first_id])
            self.assertEqual((state.image_for_id(first_id).flip_horizontal, state.image_for_id(first_id).flip_vertical), (True, False), "clearing mosaic and exclusion state does not clear image direction")
            state.complete_project()
            reopened = StudioState(cache, sessions)
            completed = reopened.open_project(project_id)
            self.assertTrue(reopened.project_read_only)
            self.assertEqual(completed["project"]["status"], "completed")
            self.assertTrue(next(image for image in completed["images"] if image["id"] == first_id)["flipH"], "a completed project still displays its saved flip")
            with self.assertRaises(ClientError) as blocked:
                reopened.set_image_transform(first_id, {"flipH": False, "flipV": False})
            self.assertEqual(blocked.exception.error_code, "project_read_only", "a completed project exposes direction but blocks another flip")
        finally:
            if reopened is not None: reopened.shutdown()
            state.shutdown()

    def test_overwrite_records_native_flip_once_and_keeps_transform_undo_redo(self) -> None:
        source_root = self.root / "overwrite-source"; source_root.mkdir()
        path, pixels = self.asymmetric_source()
        target = source_root / "source.png"; path.replace(target)
        state = StudioState(self.root / "overwrite-cache", self.root / "overwrite-sessions")
        try:
            state.create_project("overwrite history")
            image_id = state.set_root(str(source_root))[0]["id"]
            state.set_image_transform(image_id, {"flipH": True, "flipV": False})
            revision = state._candidate_revision(image_id)
            state.reserve_browser_save(image_id, revision, "flip-overwrite", copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
            rendered = state.render_browser_save(image_id, revision, 4, None, client_save_token="flip-overwrite", output_format="original", keep_metadata=True)
            state.commit_browser_save(image_id, revision, rendered.save_token, "overwrite")
            state.acknowledge_browser_save(rendered.save_token)
            with Image.open(target) as saved:
                saved_once = np.asarray(saved.convert("RGB")).copy()
            np.testing.assert_array_equal(saved_once, np.fliplr(pixels), "overwrite writes the visible flipped direction")
            record = state.image_for_id(image_id)
            self.assertEqual((record.flip_horizontal, record.source_flip_horizontal), (True, True), "the saved native direction and desired direction agree after overwrite")

            revision = state._candidate_revision(image_id)
            state.reserve_browser_save(image_id, revision, "flip-overwrite-again", copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
            rendered_again = state.render_browser_save(image_id, revision, 4, None, client_save_token="flip-overwrite-again", output_format="original", keep_metadata=True)
            self.assertTrue(rendered_again.no_effect, "a second same-direction save recognizes that native pixels already match")
            state.commit_browser_save(image_id, revision, rendered_again.save_token, "keep")
            state.acknowledge_browser_save(rendered_again.save_token)
            with Image.open(target) as saved:
                saved_twice = np.asarray(saved.convert("RGB")).copy()
            np.testing.assert_array_equal(saved_twice, saved_once, "a second overwrite does not double-apply the flip")

            undone = state.restore_project_history(image_id, "undo")["current"]["image"]
            self.assertEqual((undone["flipH"], undone["flipV"]), (False, False), "undo remains available after overwrite and returns to the direction before the flip")
            redone = state.restore_project_history(image_id, "redo")["current"]["image"]
            self.assertEqual((redone["flipH"], redone["flipV"]), (True, False), "redo returns the image and masks to the saved direction")
        finally:
            state.shutdown()

    def test_overwrite_flip_and_range_reopen_in_saved_direction_without_double_transform(self) -> None:
        source_root = self.root / "reopen-overwrite-source"; source_root.mkdir()
        path, pixels = self.asymmetric_source(); target = source_root / "source.png"; path.replace(target)
        cache = self.root / "reopen-overwrite-cache"; sessions = self.root / "reopen-overwrite-sessions"
        state = StudioState(cache, sessions)
        try:
            project_id = str(state.create_project("reopen overwrite")["id"])
            image_id = state.set_root(str(source_root))[0]["id"]
            candidate_path = cache / image_id / "range.png"; candidate_path.parent.mkdir(parents=True, exist_ok=True)
            candidate_mask = np.zeros((2, 3), dtype=np.uint8); candidate_mask[:, 0:2] = 255
            Image.fromarray(candidate_mask).save(candidate_path)
            with state.image_io_lock(image_id):
                with state.lock:
                    revision = state._commit_candidate_snapshot(image_id, [Candidate("range", "penis", .9, candidate_path)], replace=True)
            state.set_image_transform(image_id, {"flipH": True, "flipV": False})
            state.reserve_browser_save(image_id, revision, "reopen-overwrite", copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
            rendered = state.render_browser_save(image_id, revision, 2, None, client_save_token="reopen-overwrite", output_format="original", keep_metadata=True)
            state.commit_browser_save(image_id, revision, rendered.save_token, "overwrite")
            state.acknowledge_browser_save(rendered.save_token)
            with Image.open(target) as saved_image:
                saved = np.asarray(saved_image.convert("RGB")).copy()
            visible_without_range = np.fliplr(pixels)
            delta = np.abs(saved.astype(np.int16) - visible_without_range.astype(np.int16)).sum(axis=2)
            self.assertGreater(int(delta[:, 1:3].sum()), int(delta[:, :1].sum()), "the saved mosaic range follows the visible flipped side")

            state.close_project(); opened = state.open_project(project_id)
            reopened = next(image for image in opened["images"] if image["id"] == image_id)
            self.assertEqual((reopened["flipH"], reopened["flipV"]), (True, False), "project reopen keeps the saved visible direction")
            record = state.image_for_id(image_id)
            self.assertEqual((record.flip_horizontal, record.source_flip_horizontal), (True, True), "reopened desired and native directions agree")
            rerendered = render_output(record, None, 2, "original", True)[0]
            with Image.open(io.BytesIO(rerendered)) as rerendered_image:
                np.testing.assert_array_equal(np.asarray(rerendered_image.convert("RGB")), saved, "reopen does not double-flip the saved image or move its baked range")
        finally:
            state.shutdown()

    def test_flip_only_copy_save_writes_visible_direction_and_never_changes_source(self) -> None:
        source_root = self.root / "copy-source"; source_root.mkdir()
        path, pixels = self.asymmetric_source(); source = source_root / "source.png"; path.replace(source)
        original = source.read_bytes()
        output = self.root / "copy-output"; output.mkdir()
        state = StudioState(self.root / "copy-cache", self.root / "copy-sessions")
        try:
            state.settings["saving"]["default_output_directory"] = str(output.resolve())
            image_id = state.set_root(str(source_root))[0]["id"]
            state.set_image_transform(image_id, {"flipH": True, "flipV": False})
            revision = state._candidate_revision(image_id)
            state.reserve_browser_save(image_id, revision, "flip-copy", copy_to_default=True, suffix="_copy", output_format="original", keep_metadata=True)
            rendered = state.render_browser_save(image_id, revision, 4, None, client_save_token="flip-copy", copy_to_default=True, suffix="_copy", output_format="original", keep_metadata=True)
            self.assertFalse(rendered.no_effect, "a flip without mosaic is still a saveable edit")
            committed = state.commit_browser_save(image_id, revision, rendered.save_token, "keep")
            self.assertEqual(committed["sourceAction"], "keep")
            copied = output / "source_copy.png"
            self.assertTrue(copied.is_file())
            with Image.open(copied) as saved:
                np.testing.assert_array_equal(np.asarray(saved.convert("RGB")), np.fliplr(pixels), "copy output matches the visible flipped editor")
            self.assertEqual(source.read_bytes(), original, "copy saving never changes the original file")
            self.assertEqual((state.image_for_id(image_id).flip_horizontal, state.image_for_id(image_id).source_flip_horizontal), (True, False), "copy saving does not convert the source into the visible direction")
        finally:
            state.shutdown()

    def test_over_limit_oriented_jpeg_flip_keeps_mask_in_normalized_visible_coordinates(self) -> None:
        source_root = self.root / "large-oriented"; source_root.mkdir()
        source = source_root / "oriented.jpg"
        pixels = np.zeros((4, 6, 3), dtype=np.uint8)
        for y in range(4):
            for x in range(6): pixels[y, x] = (x * 37, y * 53, (x + y) * 29)
        exif = Image.Exif(); exif[274] = 6
        Image.fromarray(pixels).save(source, quality=100, subsampling=0, exif=exif)
        state = StudioState(self.root / "large-cache", self.root / "large-sessions")
        try:
            with patch.object(Image, "MAX_IMAGE_PIXELS", 1):
                image_id = state.set_root(str(source_root))[0]["id"]
                record = state.image_for_id(image_id)
                self.assertEqual((record.width, record.height), (4, 6), "catalog dimensions use the EXIF-normalized direction despite the pixel guard")
                state.set_image_transform(image_id, {"flipH": True, "flipV": False})
                mask = np.zeros((6, 4), dtype=np.uint8); mask[1:3, 0:2] = 255
                payload, _suffix, _mime = render_output(record, mask, 2, "original", True)
                baseline_payload, _suffix, _mime = render_output(record, None, 2, "original", True)
            with Image.open(io.BytesIO(payload)) as saved:
                self.assertEqual(saved.size, (4, 6))
                self.assertEqual(saved.getexif().get(274), 1)
                rendered_pixels = np.asarray(saved.convert("RGB"))
            with Image.open(io.BytesIO(baseline_payload)) as baseline:
                baseline_pixels = np.asarray(baseline.convert("RGB"))
            delta = np.abs(rendered_pixels.astype(np.int16) - baseline_pixels.astype(np.int16)).sum(axis=2)
            self.assertGreater(int(delta[1:3, 2:4].sum()), int(delta[1:3, 0:2].sum()) * 2, "mosaic follows the normalized mask to the displayed flipped side rather than its opposite")
        finally:
            state.shutdown()

    def test_cancelled_jpg_batch_counts_only_completed_files_and_keeps_their_selected_format(self) -> None:
        source_root = self.root / "cancel-source"; source_root.mkdir()
        Image.new("RGB", (12, 8), "#315579").save(source_root / "first.png")
        Image.new("RGB", (12, 8), "#42668a").save(source_root / "second.png")
        output = self.root / "cancel-output"; output.mkdir()
        state = StudioState(self.root / "cancel-cache", self.root / "cancel-sessions")
        try:
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(source_root))]
            masks = {record.image_id: np.pad(np.ones((4, 4), dtype=np.uint8) * 255, ((2, 2), (4, 4))) for record in records}
            control = JobControl()
            state.job = Job(started_at=time.time(), kind="apply", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            original = saving_module.render_output
            def render_then_cancel(*args, **kwargs):
                rendered = original(*args, **kwargs); control.cancel_requested.set(); return rendered
            with patch.object(saving_module, "render_output", side_effect=render_then_cancel):
                state._apply_worker(records, 100, masks, copy_to_default=True, suffix="_saved", output_directory=output, output_format="jpg", keep_metadata=False, control=control)
            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed_image_ids, (records[0].image_id,), "the unstarted second image is not counted as successful")
            completed = output / "first_saved.jpg"; unstarted = output / "second_saved.jpg"
            self.assertTrue(completed.is_file()); self.assertFalse(unstarted.exists())
            with Image.open(completed) as saved:
                self.assertEqual(saved.format, "JPEG", "the already completed output retains the chosen JPG format after cancellation")
        finally:
            state.shutdown()

    def test_mixed_png_jpeg_overwrite_replaces_old_extensions_and_opens_every_result_as_png(self) -> None:
        source_root = self.root / "mixed-overwrite"; source_root.mkdir()
        Image.new("RGB", (10, 8), "#315579").save(source_root / "first.png")
        Image.new("RGB", (9, 7), "#42668a").save(source_root / "second.jpg")
        state = StudioState(self.root / "mixed-cache", self.root / "mixed-sessions")
        try:
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(source_root))]
            masks = {record.image_id: np.ones((record.height, record.width), dtype=np.uint8) * 255 for record in records}
            state.job = Job(started_at=time.time(), kind="apply", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            state._apply_worker(records, 100, masks, copy_to_default=False, output_format="png", keep_metadata=False)
            self.assertEqual(state.job.state, "complete")
            self.assertTrue((source_root / "first.png").is_file())
            self.assertTrue((source_root / "second.png").is_file())
            self.assertFalse((source_root / "second.jpg").exists(), "the old JPEG extension is removed after overwrite conversion")
            for path in (source_root / "first.png", source_root / "second.png"):
                with Image.open(path) as saved:
                    self.assertEqual(saved.format, "PNG")
        finally:
            state.shutdown()

    def test_flat_copy_of_same_stem_mixed_extensions_keeps_every_distinct_output(self) -> None:
        source_root = self.root / "same-stem-source"; source_root.mkdir()
        Image.new("RGB", (10, 8), "#315579").save(source_root / "shared.png")
        Image.new("RGB", (9, 7), "#42668a").save(source_root / "shared.jpeg")
        output = self.root / "same-stem-output"; output.mkdir()
        state = StudioState(self.root / "same-stem-cache", self.root / "same-stem-sessions")
        try:
            by_path = {item["relativePath"]: item["id"] for item in state.set_root(str(source_root))}
            state.rename_catalog_image(by_path["shared.png"], "shared-png.png")
            state.rename_catalog_image(by_path["shared.jpeg"], "shared-jpeg.jpeg")
            records = [state.image_for_id(by_path[name]) for name in ("shared.png", "shared.jpeg")]
            masks = {record.image_id: np.ones((record.height, record.width), dtype=np.uint8) * 255 for record in records}
            state.job = Job(started_at=time.time(), kind="apply", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            state._apply_worker(
                records, 100, masks, copy_to_default=True, suffix="_saved", output_directory=output,
                output_format="png", keep_metadata=False, preserve_directory_structure=False,
            )
            self.assertEqual(state.job.state, "complete")
            outputs = sorted(output.glob("*.png"))
            self.assertEqual([path.name for path in outputs], ["shared-jpeg_saved.png", "shared-png_saved.png"], "same source stem retains every explicitly distinct output name")
            for path in outputs:
                with Image.open(path) as saved:
                    self.assertEqual(saved.format, "PNG")
        finally:
            state.shutdown()

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
