"""Regression coverage for project ZIP mask export alpha semantics."""

from __future__ import annotations

import base64
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.state import StudioState


class ProjectExportMaskAlphaTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.state: StudioState | None = None

    def tearDown(self) -> None:
        if self.state is not None:
            self.state.shutdown()
        self._temporary.cleanup()

    @staticmethod
    def rgba_mask(pixel: tuple[int, int]) -> bytes:
        image = Image.new("RGBA", (4, 4), (255, 255, 255, 0))
        image.putpixel(pixel, (255, 255, 255, 255))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def test_project_zip_export_uses_rgba_alpha_for_manual_mosaic_and_exclude_masks(self) -> None:
        source = self.root / "images"
        source.mkdir()
        Image.new("RGB", (4, 4), "white").save(source / "source.png")
        with patch.object(state_module, "APP_DIR", self.app_dir):
            self.state = StudioState(self.root / "cache", self.root / "sessions")
        project = self.state.create_project("alpha export")
        image_id = self.state.set_root(str(source))[0]["id"]
        add = self.rgba_mask((1, 2))
        exclusion = self.rgba_mask((3, 0))
        data_uri = lambda value: "data:image/png;base64," + base64.b64encode(value).decode("ascii")
        self.state.save_manual_workspace(image_id, {
            "add": data_uri(add),
            "exclusion": data_uri(exclusion),
            "exclusionErase": "",
            "removedCandidateIds": [],
            "candidateRevision": self.state._candidate_revision(image_id),
            "manualEnabled": True,
            "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True,
            "manualExclusionForced": True,
        })
        replacement_add = self.rgba_mask((0, 3))
        self.state.save_manual_workspace(image_id, {
            "add": data_uri(replacement_add),
            "exclusion": data_uri(exclusion),
            "exclusionErase": "",
            "removedCandidateIds": [],
            "candidateRevision": self.state._candidate_revision(image_id),
            "manualEnabled": True,
            "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True,
            "manualExclusionForced": True,
        })
        self.assertEqual(self.state.restore_project_history(image_id, "undo")["changedImageIds"], [image_id])
        self.assertEqual(self.state.restore_project_history(image_id, "redo")["changedImageIds"], [image_id])

        mosaic = list(self.state.iter_project_mask_exports(project["id"], "mosaic"))[0][1]
        excluded = list(self.state.iter_project_mask_exports(project["id"], "exclude"))[0][1]
        for exported, pixel in ((mosaic, (0, 3)), (excluded, (3, 0))):
            with Image.open(io.BytesIO(exported)) as image:
                mask = image.convert("L")
                self.assertEqual(mask.size, (4, 4))
                self.assertEqual(mask.getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                self.assertEqual(sum(value > 0 for value in mask.getdata()), 1)
