"""Processing a reopened project respects every registered native source."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

from tests import prepare_test_app_config
import mozarie.state as state_module
from mozarie.state import StudioState


class MultiSourceJobTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        app = self.root / "app"
        prepare_test_app_config(app)
        self.enterContext(patch.object(state_module, "APP_DIR", app))
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.addCleanup(self.state.shutdown)
        project = self.state.workspace_store.create_project("two native folders")
        self.originals = {}
        for index in range(2):
            source = self.root / f"source-{index}"
            source.mkdir()
            path = source / f"image-{index}.png"
            pixels = np.indices((18, 24)).sum(axis=0).astype(np.uint8) % 2 * 255
            with Image.fromarray(pixels) as image:
                image.save(path)
            self.originals[path] = path.read_bytes()
            stat = path.stat()
            source_id = self.state.workspace_store.ensure_project_source(
                project["id"], kind="native-folder", display_name=source.name, identity=str(source.resolve()),
            )
            self.state.workspace_store.reconcile_images(project["id"], [SimpleNamespace(
                relative_path=path.name, size_bytes=stat.st_size, mtime_ns=stat.st_mtime_ns, width=24, height=18,
            )], source_id)
        self.ids = [image["id"] for image in self.state.open_project(project["id"])["images"]]
        self.output = self.root / "output"
        self.output.mkdir()
        self.state.settings["saving"].update({"default_output_directory": str(self.output), "parallelism": 2})

    def test_browser_single_and_bulk_save_accept_every_reopened_source(self):
        for ids in ([image_id] for image_id in self.ids):
            with self.subTest(ids=ids):
                entries = self.state.prepare_browser_save(ids, 4, "_copy", False, copy_to_default=True)
                self.assertEqual([entry["imageId"] for entry in entries], ids)
                self.assertEqual(entries[0]["sourceKind"], "filesystem")
        entries = self.state.prepare_browser_save(self.ids, 4, "_copy", False, copy_to_default=True)
        self.assertEqual([entry["imageId"] for entry in entries], self.ids)

    def test_detection_and_copy_save_process_all_reopened_native_sources(self):
        model = self.root / "fixture.onnx"
        model.write_bytes(b"external model boundary")
        self.state.settings["models"].update({
            "provider": "cpu", "target_segmentation": str(model),
            "ntd11_enabled": False, "sensitive_enabled": False,
            "hand_detection_enabled": False, "hand_segmentation_enabled": False,
        })
        self.state.settings["detection"].update({
            "mode": "standard", "fluid_exclusion_enabled": False,
            "default_candidate_padding_px": 0,
        })

        class Target:
            def detect(self, rgb, *_args):
                return [{"class_name": "penis", "confidence": .9, "source": "target",
                         "mask": np.full(rgb.shape[:2], 255, dtype=np.uint8)}]

        with patch("mozarie.detection.TargetSegmenter", return_value=Target()), patch("mozarie.detection.runtime_backend", return_value="cpu"):
            self.state.start_detection(self.ids, parallelism=2, target_classes={"penis"})
            self.state.worker_thread.join(30)
            self.assertFalse(self.state.worker_thread.is_alive())
        self.assertEqual(self.state.job.state, "complete", self.state.job.error)
        self.assertEqual(set(self.state.job.completed_image_ids), set(self.ids))
        for image_id in self.ids:
            self.assertEqual(len(self.state.list_candidates(image_id)), 1)
        self.assertTrue(self.state.start_apply(self.ids, 4, {}, copy_to_default=True, suffix="_copy"))
        self.state.worker_thread.join(30)
        self.assertFalse(self.state.worker_thread.is_alive())
        self.assertEqual(self.state.job.state, "complete", self.state.job.error)
        self.assertEqual(set(self.state.job.completed_image_ids), set(self.ids))
        self.assertEqual(sorted(path.name for path in self.output.glob("*.png")), ["image-0_copy.png", "image-1_copy.png"])
        for path, original in self.originals.items():
            self.assertEqual(path.read_bytes(), original)
            with Image.open(self.output / f"{path.stem}_copy.png") as saved:
                self.assertEqual(saved.size, (24, 18))
                self.assertTrue(np.all(np.asarray(saved.convert("RGB"))[..., 0] == 128))


if __name__ == "__main__":
    unittest.main()
