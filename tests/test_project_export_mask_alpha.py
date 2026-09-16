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

import mozarie.saving as saving_module
import mozarie.state as state_module
from mozarie.domain import Candidate
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

    @staticmethod
    def candidate_mask(mode: str, pixel: tuple[int, int]) -> bytes:
        image = Image.new(mode, (4, 4), (255, 255, 255, 0) if mode == "RGBA" else (255, 0))
        image.putpixel(pixel, (255, 255, 255, 255) if mode == "RGBA" else (255, 255))
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

    def test_rgba_and_la_candidates_use_alpha_for_preview_save_and_exports(self) -> None:
        source = self.root / "candidate-images"
        source.mkdir()
        for mode in ("RGBA", "LA"):
            Image.new("RGB", (4, 4), "white").save(source / f"{mode}.png")
        with patch.object(state_module, "APP_DIR", self.app_dir):
            self.state = StudioState(self.root / "cache", self.root / "sessions")
        project = self.state.create_project("candidate alpha")
        image_ids = {Path(item["relativePath"]).stem: item["id"] for item in self.state.set_root(str(source))}
        for index, mode in enumerate(("RGBA", "LA")):
            with self.subTest(mode=mode):
                image_id = image_ids[mode]
                pixel = (index, 3 - index)
                candidate_path = self.state.cache_dir / image_id / f"{mode}.png"
                candidate_path.parent.mkdir(parents=True, exist_ok=True)
                candidate_path.write_bytes(self.candidate_mask(mode, pixel))
                candidate = Candidate(mode, "penis", .9, candidate_path)
                with self.state.image_io_lock(image_id):
                    with self.state.lock:
                        revision = self.state._commit_candidate_snapshot(image_id, [candidate], replace=True)
                combined = self.state.combined_candidate_mask(image_id)
                self.assertEqual(Image.fromarray(combined).getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                with Image.open(io.BytesIO(self.state.read_candidate_mask_png(image_id, mode, expected_revision=revision))) as preview:
                    self.assertEqual(preview.getchannel("A").getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                exported = Image.open(io.BytesIO(self.state.export_mask_png(image_id, "mosaic"))).convert("L")
                self.assertEqual(exported.getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                project_png = dict((item["id"], png) for item, png in self.state.iter_project_mask_exports(project["id"], "mosaic"))[image_id]
                self.assertEqual(Image.open(io.BytesIO(project_png)).convert("L").getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                captured: list[object] = []
                original = saving_module.render_output
                def render_output(*args, **kwargs):
                    captured.append(args[1].copy())
                    return original(*args, **kwargs)
                token = f"00000000-0000-4000-8000-000000000{index + 501:03d}"
                self.state.reserve_browser_save(image_id, revision, token, copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
                with patch.object(saving_module, "render_output", side_effect=render_output):
                    rendered = self.state.render_browser_save(image_id, revision, 2, None, client_save_token=token)
                self.assertEqual(Image.fromarray(captured[0]).getbbox(), (pixel[0], pixel[1], pixel[0] + 1, pixel[1] + 1))
                self.state.cancel_browser_save(image_id, rendered.candidate_revision, rendered.save_token)
