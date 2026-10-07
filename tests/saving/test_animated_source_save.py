"""Output rendering must not silently flatten supported animated containers."""
from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from PIL import Image

from tests import prepare_test_app_config
import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.image_io import render_output
from mozarie.state import StudioState


class AnimatedSourceSaveTests(unittest.TestCase):
    @contextmanager
    def fixture(self, suffix):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            app = root / "app"
            prepare_test_app_config(app)
            source = root / "source" / f"animated.{suffix}"
            source.parent.mkdir()
            with Image.new("RGB", (8, 8), "red") as first, Image.new("RGB", (8, 8), "blue") as second:
                first.save(source, save_all=True, append_images=[second], duration=[100, 100], loop=0)
            with Image.open(source) as image:
                self.assertEqual(image.n_frames, 2)
            output = root / "output"
            output.mkdir()
            with patch.object(state_module, "APP_DIR", app):
                state = StudioState(root / "cache", root / "sessions")
            try:
                image_id = state.set_root(str(source.parent))[0]["id"]
                state.settings["saving"]["default_output_directory"] = str(output)
                yield state, image_id, source, output
            finally:
                state.shutdown()

    def test_render_rejects_animation_independent_of_format_and_metadata(self):
        for suffix in ("png", "webp"):
            with self.subTest(source=suffix), self.fixture(suffix) as (state, image_id, source, _output):
                original = source.read_bytes()
                for output_format, keep_metadata in (("original", False), ("original", True), ("png", False), ("png", True), ("jpg", False)):
                    with self.subTest(output=output_format, metadata=keep_metadata):
                        with self.assertRaises(ClientError) as error:
                            render_output(state.images[image_id], None, 4, output_format, keep_metadata)
                        self.assertEqual(error.exception.error_code, "image_format_unsupported")
                        self.assertEqual(source.read_bytes(), original)

    def test_native_overwrite_rejects_animation_without_replacing_source(self):
        for suffix in ("png", "webp"):
            with self.subTest(source=suffix), self.fixture(suffix) as (state, image_id, source, _output):
                original = source.read_bytes()
                workspace = state.workspace_store.export_state(image_id)
                for output_format in ("original", "png", "jpg"):
                    with self.subTest(output=output_format):
                        self.assertTrue(state.start_apply([image_id], 4, {}, output_format=output_format, keep_metadata=False))
                        state.worker_thread.join(30)
                        self.assertFalse(state.worker_thread.is_alive())
                        self.assertEqual(state.job.state, "error")
                        self.assertEqual(state.job.error_code, "image_format_unsupported")
                        self.assertEqual(state.job.outputs, [])
                        self.assertEqual(source.read_bytes(), original)
                        self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                        self.assertEqual(list(source.parent.iterdir()), [source])

    def test_browser_render_rejects_animation_before_staging_output(self):
        for suffix in ("png", "webp"):
            with self.subTest(source=suffix), self.fixture(suffix) as (state, image_id, source, output):
                original = source.read_bytes()
                for copy in (False, True):
                    with self.subTest(copy=copy):
                        token = uuid.uuid4().hex
                        revision = state._candidate_revision(image_id)
                        state.reserve_browser_save(image_id, revision, token, copy_to_default=copy,
                                                   suffix="_censored", output_format="original", keep_metadata=False)
                        try:
                            with self.assertRaises(ClientError) as error:
                                state.render_browser_save(image_id, revision, 4, None, client_save_token=token,
                                                          copy_to_default=copy, keep_metadata=False,
                                                          expected_manual_revision=state.workspace_store.manual_revisions([image_id])[image_id])
                            self.assertEqual(error.exception.error_code, "image_format_unsupported")
                        finally:
                            state.cancel_browser_save(image_id, revision, token)
                        self.assertEqual(source.read_bytes(), original)
                        self.assertEqual(list(output.glob("*.png")) + list(output.glob("*.webp")), [])
                        self.assertFalse(state.browser_save_tokens)

    def test_unchanged_animation_copy_and_overwrite_preserve_all_source_bytes(self):
        for suffix in ("png", "webp"):
            with self.subTest(source=suffix), self.fixture(suffix) as (state, image_id, source, output):
                original = source.read_bytes()
                original_mtime = source.stat().st_mtime_ns
                for copy in (True, False):
                    self.assertTrue(state.start_apply([image_id], 4, {}, copy_to_default=copy))
                    state.worker_thread.join(30)
                    self.assertFalse(state.worker_thread.is_alive())
                    self.assertEqual(state.job.state, "complete", state.job.error)
                    self.assertEqual(source.read_bytes(), original)
                    self.assertEqual(source.stat().st_mtime_ns, original_mtime)
                saved = output / f"animated_censored.{suffix}"
                self.assertEqual(saved.read_bytes(), original)
                with Image.open(saved) as image:
                    self.assertEqual(image.n_frames, 2)
