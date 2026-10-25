"""Changing an output name must not recompress an otherwise unchanged image."""
import unittest
import uuid
import os
from pathlib import Path
import subprocess
import base64

import numpy as np
from PIL import Image
from mozarie.core import ClientError

from tests.saving import test_apply_unchanged_source as save_fixture
from tests.saving import test_native_save_transfer as native_fixture


class FilenameOnlySaveTests(unittest.TestCase):
    def test_numbered_copies_apply_editable_suffix_once_and_remove_staging(self):
        fixture = save_fixture.ApplyUnchangedSourceTests()
        for placement, stem in (("only", "01"), ("prefix", "01_image"), ("suffix", "image_01")):
            with self.subTest(placement=placement), fixture.fixture() as (state, image_id, source, output, _pixels):
                name = f"{stem}_edited.png"
                numbering = {"digits": 2, "placement": placement}
                entries = state.prepare_browser_save([image_id], 100, "_edited", False,
                    copy_to_default=True, numbering=numbering)
                self.assertEqual(entries[0]["outputFilename"], name)
                (output / name).write_bytes(b"unrelated existing file")
                with self.assertRaises(ClientError) as conflict:
                    state.prepare_browser_save([image_id], 100, "_edited", False,
                        copy_to_default=True, numbering=numbering)
                self.assertEqual(conflict.exception.error_code, "output_files_exist")
                self.assertIn(str(output / name), conflict.exception.params["files"])
                self.assertFalse((output / ".mozarie-staging").exists())
                (output / name).unlink()
                token = str(uuid.uuid4())
                options = dict(copy_to_default=True, suffix="_edited", output_format="original",
                    keep_metadata=True, output_filename=name)
                state.reserve_browser_save(image_id, 0, token, **options)
                state.render_browser_save(image_id, 0, 100, None, client_save_token=token, **options)
                state.commit_browser_save(image_id, 0, token, "keep")
                self.assertEqual((output / name).read_bytes(), source.read_bytes())
                self.assertEqual([path.name for path in output.iterdir()], [name])

    def live_rename(self, browser_handle):
        fixture = native_fixture.NativeSaveTransferTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        source = fixture.source.with_suffix(".jpg")
        with Image.fromarray(fixture.pixels) as image:
            image.save(source, quality=83, subsampling=0)
        fixture.source.unlink()
        fixture.state.set_root(str(source.parent))
        output = fixture.root / "copies"
        output.mkdir()
        fixture.state.update_settings({"saving": {"default_output_directory": str(output)}})
        original = source.read_bytes()
        args = ["node", str(Path(__file__).with_name("filename_only_save_live_browser.cjs")), fixture.origin]
        if browser_handle:
            args.append(base64.b64encode(original).decode("ascii"))
        result = subprocess.run(args,
            cwd=Path(__file__).resolve().parents[2], env={**os.environ, "PYTHONUTF8": "1"},
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((output / "renamed.jpg").read_bytes(), original)
        if browser_handle:
            self.assertEqual(source.read_bytes(), original)
            imported = next(record for record in fixture.state.images.values() if record.source_kind == "session")
            self.assertEqual(imported.relative_path, "renamed.jpg")
        else:
            self.assertEqual(source.with_name("renamed.jpg").read_bytes(), original)
            self.assertFalse(source.exists())

    def test_live_rename_single_copy_and_overwrite_preserve_jpeg_bytes(self):
        self.live_rename(False)

    def test_live_drag_handle_rename_preserves_jpeg_bytes_and_replaces_source_handle(self):
        self.live_rename(True)

    def test_numbering_to_original_name_consumes_pending_manual_rename(self):
        fixture = save_fixture.ApplyUnchangedSourceTests()
        with fixture.fixture() as (state, image_id, source, _output, _pixels):
            numbered_source = source.with_name("01.png")
            source.rename(numbered_source)
            source = numbered_source
            image_id = state.set_root(str(source.parent))[0]["id"]
            state.rename_catalog_image(image_id, "pending.png")
            token = str(uuid.uuid4())
            original = source.read_bytes()
            entry = state.prepare_browser_save([image_id], 100, "", False, numbering={"digits": 2, "placement": "only"})[0]
            options = dict(copy_to_default=False, suffix="", output_format="original", keep_metadata=True, output_filename=entry["outputFilename"])
            state.reserve_browser_save(image_id, 0, token, **options)
            rendered = state.render_browser_save(image_id, 0, 100, None, client_save_token=token, **options)
            self.assertFalse(rendered.no_effect, "overwrite must consume the pending output-name change")
            state.commit_browser_save(image_id, 0, token, "overwrite")
            self.assertIsNone(state.images[image_id].edited_filename)
            self.assertEqual(source.read_bytes(), original)

    def test_jpeg_rename_preserves_bytes_and_pixels_for_copy_and_overwrite(self):
        fixture = save_fixture.ApplyUnchangedSourceTests()
        for browser_save in (False, True):
            for copy in (False, True):
                with self.subTest(browser_save=browser_save, copy=copy), fixture.fixture() as (state, _image_id, source, output, pixels):
                    jpeg = source.with_suffix(".jpg")
                    exif = Image.Exif()
                    exif[270] = "retained source description"
                    with Image.fromarray(pixels) as image:
                        image.save(jpeg, quality=83, subsampling=0, exif=exif)
                    source.unlink()
                    image_id = state.set_root(str(jpeg.parent))[0]["id"]
                    original = jpeg.read_bytes()
                    with Image.open(jpeg) as image:
                        original_pixels = np.asarray(image).copy()
                    state.rename_catalog_image(image_id, "renamed.jpg")
                    if browser_save:
                        entry = state.prepare_browser_save([image_id], 100, "", False, copy_to_default=copy)[0]
                        token = str(uuid.uuid4())
                        options = dict(copy_to_default=copy, suffix="", output_format="original", keep_metadata=True)
                        state.reserve_browser_save(image_id, entry["candidateRevision"], token, **options)
                        state.render_browser_save(image_id, entry["candidateRevision"], 100, None, client_save_token=token, **options)
                        state.commit_browser_save(image_id, entry["candidateRevision"], token, "keep" if copy else "overwrite")
                    else:
                        fixture.apply(state, image_id, copy_to_default=copy, suffix="")
                    destination = (output if copy else jpeg.parent) / "renamed.jpg"
                    self.assertEqual(destination.read_bytes(), original, "filename-only saving must preserve the original compressed data")
                    with Image.open(destination) as image:
                        np.testing.assert_array_equal(np.asarray(image), original_pixels)
                        self.assertEqual(image.getexif()[270], "retained source description")
                    if copy:
                        self.assertEqual(jpeg.read_bytes(), original)
                        self.assertEqual(state.images[image_id].edited_filename, "renamed.jpg")
                    else:
                        self.assertFalse(jpeg.exists())
                        self.assertIsNone(state.images[image_id].edited_filename)
