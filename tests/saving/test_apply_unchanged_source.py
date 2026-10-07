"""Unchanged overwrites avoid output I/O without skipping requested edits."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, PngImagePlugin

import mozarie.state as state_module
from mozarie.state import StudioState


class ApplyUnchangedSourceTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            app = root / "app"
            (app / "config").mkdir(parents=True)
            shutil.copyfile(Path(__file__).resolve().parents[2] / "config" / "defaults.json", app / "config" / "defaults.json")
            source = root / "source" / "image.png"
            source.parent.mkdir()
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("parameters", "retained image metadata")
            pixels = np.arange(16 * 16 * 3, dtype=np.uint8).reshape((16, 16, 3))
            with Image.fromarray(pixels) as image:
                image.save(source, pnginfo=metadata)
            output = root / "copies"
            output.mkdir()
            with patch.object(state_module, "APP_DIR", app):
                state = StudioState(root / "cache", root / "sessions")
            try:
                image_id = state.set_root(str(source.parent))[0]["id"]
                state.settings["saving"]["default_output_directory"] = str(output)
                state.set_image_flags(image_id, {"reviewed": True})
                yield state, image_id, source, output, pixels
            finally:
                state.shutdown()

    def apply(self, state, image_id, **options):
        drafts = options.pop("drafts", {})
        self.assertTrue(state.start_apply([image_id], 4, drafts, **options))
        state.worker_thread.join(30)
        self.assertFalse(state.worker_thread.is_alive(), "save worker did not finish")
        self.assertEqual(state.job.state, "complete", state.job.error)
        self.assertEqual(state.job.completed_image_ids, (image_id,))

    def test_unchanged_overwrite_does_not_read_or_stage_source_and_preserves_workspace(self):
        for unavailable in ("source_read", "staging_directory"):
            with self.subTest(unavailable=unavailable), self.fixture() as (state, image_id, source, _output, _pixels):
                original = source.read_bytes()
                mtime = source.stat().st_mtime_ns
                workspace = state.workspace_store.export_state(image_id)
                history = state.project_history_status(image_id)
                stage_dir = state.cache_dir / "apply-render"
                operation = Path.open if unavailable == "source_read" else Path.mkdir

                def reject_unneeded_io(path, *args, **kwargs):
                    if path == (source if unavailable == "source_read" else stage_dir):
                        raise PermissionError("unchanged save must not need this I/O")
                    return operation(path, *args, **kwargs)

                with patch.object(Path, "open" if unavailable == "source_read" else "mkdir", new=reject_unneeded_io):
                    self.apply(state, image_id)
                self.assertEqual(state.job.outputs, [str(source)])
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(source.stat().st_mtime_ns, mtime)
                self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                self.assertEqual(state.project_history_status(image_id), history)
                self.assertFalse(stage_dir.exists())
                self.assertEqual(state.workspace_store.apply_save_receipts(), [])
                with state.save_journal._connection() as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM saves").fetchone()[0], 0)

    def test_unchanged_overwrite_rejects_changed_or_missing_source(self):
        for change in ("changed", "missing"):
            with self.subTest(change=change), self.fixture() as (state, image_id, source, _output, _pixels):
                workspace = state.workspace_store.export_state(image_id)
                history = state.project_history_status(image_id)
                with state.image_io_lock(image_id):
                    self.assertTrue(state.start_apply([image_id], 4, {}))
                    if change == "changed":
                        replacement = source.read_bytes() + b"external edit"
                        source.write_bytes(replacement)
                    else:
                        source.unlink()
                state.worker_thread.join(30)
                self.assertFalse(state.worker_thread.is_alive(), "save worker did not finish")
                self.assertEqual(state.job.state, "error")
                self.assertEqual(state.job.error_code, "stale_asset")
                self.assertEqual(state.job.completed_image_ids, ())
                self.assertEqual(state.job.outputs, [])
                self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                self.assertEqual(state.workspace_store.history_status(image_id), history)
                self.assertFalse((state.cache_dir / "apply-render").exists())
                if change == "changed":
                    self.assertEqual(source.read_bytes(), replacement)
                else:
                    self.assertFalse(source.exists())

    def test_copy_and_requested_changes_still_write_output(self):
        for change in ("copy", "metadata", "format", "rename", "flip", "mask"):
            with self.subTest(change=change), self.fixture() as (state, image_id, source, output, pixels):
                original = source.read_bytes()
                options = {}
                destination = source
                if change == "copy":
                    options["copy_to_default"] = True
                    destination = output / "image_censored.png"
                elif change == "metadata":
                    options["keep_metadata"] = False
                elif change == "format":
                    options.update(output_format="jpg", keep_metadata=False)
                    destination = source.with_suffix(".jpg")
                elif change == "rename":
                    state.rename_catalog_image(image_id, "renamed.png")
                    destination = source.with_name("renamed.png")
                elif change == "flip":
                    state.set_image_transform(image_id, {"flipH": True, "flipV": False})
                else:
                    options["drafts"] = {image_id: np.full((16, 16), 255, dtype=np.uint8)}
                history = state.project_history_status(image_id)
                self.apply(state, image_id, **options)
                self.assertEqual(state.job.outputs, [str(destination)])
                self.assertEqual(state.project_history_status(image_id), history)
                with Image.open(destination) as image:
                    self.assertEqual(image.size, (16, 16))
                    if change == "metadata":
                        self.assertNotIn("parameters", image.info)
                        np.testing.assert_array_equal(np.asarray(image), pixels)
                    elif change == "format":
                        self.assertEqual(image.format, "JPEG")
                        self.assertFalse(source.exists())
                    elif change == "rename":
                        self.assertFalse(source.exists())
                        self.assertIsNone(state.images[image_id].edited_filename)
                        np.testing.assert_array_equal(np.asarray(image), pixels)
                    elif change == "flip":
                        np.testing.assert_array_equal(np.asarray(image), pixels[:, ::-1])
                    elif change == "mask":
                        self.assertFalse(np.array_equal(np.asarray(image), pixels))
                    else:
                        self.assertEqual(destination.read_bytes(), original)
                        self.assertEqual(source.read_bytes(), original)
                self.assertEqual(state.workspace_store.apply_save_receipts(), [])
