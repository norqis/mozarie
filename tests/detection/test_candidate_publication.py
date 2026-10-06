"""Real detection publication with disposable images and model boundary fixtures."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from tests import prepare_test_app_config
import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.state import StudioState


class Target:
    def detect(self, rgb, *_args):
        segments = []
        for row, column in ((2, 2), (5, 5)):
            mask = np.zeros(rgb.shape[:2], dtype=np.uint8)
            mask[row, column] = 255
            segments.append({"class_name": "penis", "confidence": .9, "mask": mask, "source": "target"})
        return segments


class BoundaryPredictor:
    def set_image(self, rgb):
        self.shape = rgb.shape[:2]

    def reset_image(self):
        self.shape = None

    def predict(self, **_kwargs):
        return np.ones((1, *self.shape), dtype=bool), np.asarray([.9]), None


class CandidatePublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        app_dir = self.root / "app"
        prepare_test_app_config(app_dir)
        self.enterContext(patch.object(state_module, "APP_DIR", app_dir))
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.addCleanup(self.state.shutdown)
        model = self.root / "fixture.onnx"
        model.write_bytes(b"model boundary fixture")
        self.state.settings["models"].update({
            "provider": "cpu", "target_segmentation": str(model),
            "ntd11_enabled": False, "sensitive_enabled": False,
            "hand_detection_enabled": False, "hand_segmentation_enabled": False,
        })
        self.state.settings["detection"].update({
            "mode": "standard", "fluid_exclusion_enabled": False,
            "default_candidate_padding_px": 0, "default_exclude_candidate_padding_px": 0,
        })
        self.enterContext(patch("mozarie.detection.TargetSegmenter", return_value=Target()))
        self.enterContext(patch("mozarie.detection.runtime_backend", return_value="cpu"))
        source = self.root / "source"
        source.mkdir()
        with Image.new("RGB", (8, 8), "black") as image:
            image.paste("white", (3, 3, 5, 5))
            image.save(source / "source.png")
        self.source_bytes = (source / "source.png").read_bytes()
        self.image_id = self.state.set_root(str(source))[0]["id"]
        self.image_path = source / "source.png"
        self.mask_dir = self.state.cache_dir / self.image_id

    def _detect(self) -> None:
        self.state.start_detection([self.image_id], parallelism=1, target_classes={"penis"})
        self.state.worker_thread.join(10)
        self.assertFalse(self.state.worker_thread.is_alive(), "detection did not terminate")

    def _seed_candidates_with_redo(self) -> None:
        self._detect()
        self.assertEqual(self.state.job.state, "complete")
        candidate_id = self.state.list_candidates(self.image_id)[0]["id"]
        self.state.set_candidate_state(self.image_id, candidate_id, {"enabled": False})
        self.state.restore_project_history(self.image_id, "undo")
        self.assertEqual(self.state.project_history_status(self.image_id), {"canUndo": True, "canRedo": True})
        self.state.combined_candidate_mask(self.image_id)

    def _snapshot(self):
        return (
            self.state.list_candidates(self.image_id),
            self.state.workspace_store.export_state(self.image_id),
            self.state.project_history_status(self.image_id),
            {path.name: path.read_bytes() for path in self.mask_dir.iterdir() if path.is_file()},
        )

    def _assert_failed_publication_preserves(self, before) -> None:
        self.assertEqual(list(self.mask_dir.glob(".mozarie-pending-*")), [])
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(self.image_path.read_bytes(), self.source_bytes)
        self.state.restore_project_history(self.image_id, "redo")
        self.assertEqual(sum(not item["enabled"] for item in self.state.list_candidates(self.image_id)), 1)

    def _boundary(self):
        self.state.sam_predictor = BoundaryPredictor()
        self.state.sam_image_id = None
        self.state.settings["detection"]["fluid_exclusion_enabled"] = True
        return self.state.add_boundary_candidate(self.image_id, {
            "roi": {"left": 0, "top": 0, "right": 8, "bottom": 8},
            "point": {"x": 2, "y": 2},
        })

    @staticmethod
    def _fail_second_save():
        original = Image.Image.save
        saved = []

        def save(image, path, *args, **kwargs):
            if isinstance(path, Path) and path.name.startswith(".mozarie-pending-"):
                saved.append(path)
                if len(saved) == 2:
                    path.write_bytes(b"partial PNG")
                    raise OSError("second mask write failed")
            return original(image, path, *args, **kwargs)

        return save, saved

    def test_started_detection_clamps_large_padding_and_preserves_saved_setting(self) -> None:
        for padding, expected in ((100, 10), (0, 0), (2, 2)):
            with self.subTest(padding=padding):
                self.state.settings["detection"]["default_candidate_padding_px"] = padding
                self._detect()
                self.assertEqual(self.state.job.state, "complete")
                self.assertEqual(self.state.job.completed_image_ids, (self.image_id,))
                candidates = self.state.list_candidates(self.image_id)
                self.assertEqual([item["expandPx"] for item in candidates], [expected, expected])
                durable = self.state.workspace_store.export_state(self.image_id)
                self.assertEqual([item["expandPx"] for item in durable["candidates"]], [expected, expected])
                self.assertEqual(self.state.settings["detection"]["default_candidate_padding_px"], padding)
                for candidate in self.state.candidates[self.image_id]:
                    with Image.open(candidate.mask_path) as image:
                        self.assertEqual(image.format, "PNG")
                        self.assertEqual(np.count_nonzero(np.asarray(image)), 1)
                combined = self.state.combined_candidate_mask(self.image_id)
                if padding == 100:
                    self.assertTrue(np.all(combined == 255))
                elif padding == 0:
                    self.assertEqual(np.count_nonzero(combined), 2)
                else:
                    self.assertGreater(np.count_nonzero(combined), 2)
                    self.assertLess(np.count_nonzero(combined), 64)
                self.assertTrue(self.state.project_history_status(self.image_id)["canUndo"])
                self.assertEqual(list(self.mask_dir.glob(".mozarie-pending-*")), [])
        self.assertEqual(self.image_path.read_bytes(), self.source_bytes)
        self.state.restore_project_history(self.image_id, "undo")
        self.assertEqual([item["expandPx"] for item in self.state.list_candidates(self.image_id)], [0, 0])
        self.state.restore_project_history(self.image_id, "redo")
        self.assertEqual([item["expandPx"] for item in self.state.list_candidates(self.image_id)], [2, 2])

    def test_second_detection_write_discards_complete_and_partial_masks_preserving_history(self) -> None:
        self._seed_candidates_with_redo()
        before = self._snapshot()
        fail_save, saved = self._fail_second_save()
        with patch.object(Image.Image, "save", fail_save):
            self._detect()
        self.assertEqual(len(saved), 2)
        self.assertEqual(self.state.job.state, "error")
        self.assertEqual(self.state.job.completed_image_ids, ())
        self._assert_failed_publication_preserves(before)

    def test_detection_cleanup_failure_logs_without_replacing_original_write_failure(self) -> None:
        self._seed_candidates_with_redo()
        before = self._snapshot()
        fail_save, saved = self._fail_second_save()
        original_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if saved and path == saved[0]:
                raise OSError("mask cleanup denied")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Image.Image, "save", fail_save), patch.object(Path, "unlink", unlink), \
             self.assertLogs("mozarie", level="WARNING") as captured:
            self._detect()
        self.assertEqual(self.state.job.state, "error")
        self.assertEqual(self.state.job.completed_image_ids, ())
        self.assertEqual(len(saved), 2)
        self.assertEqual(list(self.mask_dir.glob(".mozarie-pending-*")), [saved[0]])
        self.assertTrue(any("mask cleanup denied" in record.getMessage() for record in captured.records))
        failures = [record.exc_info[1] for record in captured.records if record.exc_info]
        self.assertEqual([str(error) for error in failures], ["second mask write failed"])
        saved[0].unlink()
        self._assert_failed_publication_preserves(before)

    def test_second_boundary_write_discards_complete_and_partial_masks_preserving_history(self) -> None:
        self._seed_candidates_with_redo()
        before = self._snapshot()
        fail_save, saved = self._fail_second_save()
        with patch.object(Image.Image, "save", fail_save):
            with self.assertRaises(ClientError) as raised:
                self._boundary()
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(len(saved), 2)
        self._assert_failed_publication_preserves(before)

    def test_second_boundary_rename_discards_published_and_pending_masks_preserving_history(self) -> None:
        self._seed_candidates_with_redo()
        before = self._snapshot()
        original = os.replace
        renamed = []

        def replace(source, destination):
            if Path(source).name.startswith(".mozarie-pending-"):
                renamed.append(Path(destination))
                if len(renamed) == 2:
                    raise OSError("second mask rename failed")
            return original(source, destination)

        with patch("mozarie.detection.os.replace", replace):
            with self.assertRaises(ClientError) as raised:
                self._boundary()
        self.assertEqual(raised.exception.error_code, "image_read_failed")
        self.assertEqual(len(renamed), 2)
        self._assert_failed_publication_preserves(before)


if __name__ == "__main__":
    unittest.main()
