"""Regression coverage for cleanup of unpublished detection candidates."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config

import mozarie.state as state_module
from mozarie.domain import Candidate
from mozarie.state import StudioState


class DetectionCleanupRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        app_dir = self.root / "app"
        prepare_test_app_config(app_dir)
        self._app_dir = patch.object(state_module, "APP_DIR", app_dir)
        self._app_dir.start()
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.source = self.root / "source"
        self.source.mkdir()
        Image.new("RGB", (8, 8), "white").save(self.source / "source.png")
        self.record = self.state.set_root(str(self.source))[0]

    def tearDown(self) -> None:
        self.state.shutdown()
        self._app_dir.stop()
        self._temporary.cleanup()

    def test_stat_failure_after_detection_discards_unpublished_candidate_file(self) -> None:
        record = self.state.images[self.record["id"]]
        staged_path = self.state.cache_dir / record.image_id / ".mozarie-pending-stat-failure.png"
        staged_path.parent.mkdir(parents=True, exist_ok=True)
        staged_path.write_bytes(b"pending")
        candidate = Candidate("stat-failure", "penis", .9, staged_path)
        options = {
            "mode": "sam",
            "fluid_exclusion_enabled": False,
            "fluid_color_fill": (False, 26),
            "default_padding": 0,
            "default_exclude_padding": 0,
        }
        with patch.object(self.state, "_ensure_models", return_value=object()), \
             patch.object(self.state, "_detect_image", return_value=[candidate]), \
             patch.object(self.state, "_assert_record_stat_matches", side_effect=RuntimeError("source changed")):
            self.state._detect_worker([record], .5, parallelism=1, detection_options=options)
        self.assertFalse(staged_path.exists())


if __name__ == "__main__":
    unittest.main()
