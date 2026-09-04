import io
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

from mozarie.catalog import CatalogMixin
from mozarie.detection import _save_binary_mask
from mozarie.domain import Candidate, CandidateRole
from mozarie.masks import compose_masks, expand_mask
from mozarie.workspace import WorkspaceStore


class CandidateExpandTests(unittest.TestCase):
    @staticmethod
    def _png(expand_px: int | None = None) -> bytes:
        image = Image.new("L", (5, 5))
        image.putpixel((2, 2), 255)
        output = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        if expand_px is not None:
            metadata.add_text("mozarie_expand_px", str(expand_px))
        image.save(output, format="PNG", pnginfo=metadata)
        return output.getvalue()

    def test_expand_mask_uses_an_ellipse_and_keeps_zero_unchanged(self):
        source = np.zeros((7, 7), dtype=np.uint8)
        source[3, 3] = 255
        self.assertTrue(np.array_equal(expand_mask(source, 0), source))
        expanded = expand_mask(source, 1)
        self.assertEqual(int(np.count_nonzero(expanded)), 5)
        self.assertEqual(int(expanded[2, 2]), 0)
        self.assertEqual(int(expanded[2, 3]), 255)
        with self.assertRaises(ValueError):
            expand_mask(source, -1)
        with self.assertRaises(ValueError):
            expand_mask(source, 10)

    def test_large_padding_uses_image_space_and_saturates_without_a_large_kernel(self):
        source = np.zeros((17, 31), dtype=np.uint8)
        source[8, 15] = 255
        self.assertTrue(np.all(expand_mask(source, 34) == 255))
        self.assertFalse(np.any(expand_mask(np.zeros_like(source), 34)))

    def test_4k_large_padding_uses_a_bounded_image_space_operation(self):
        source = np.zeros((2160, 3840), dtype=np.uint8)
        source[1080, 1920] = 255
        started = time.perf_counter()
        expanded = expand_mask(source, 129)
        self.assertLess(time.perf_counter() - started, 3.0)
        self.assertEqual(expanded.shape, source.shape)
        self.assertEqual(int(expanded[1080, 1920]), 255)

    def test_new_candidate_png_records_zero_padding_without_changing_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.png"
            source = np.array([[0, 3], [255, 0]], dtype=np.uint8)
            _save_binary_mask(source, path)
            with Image.open(path) as image:
                self.assertEqual(image.text.get("mozarie_expand_px"), "0")
                self.assertTrue(np.array_equal(np.asarray(image.convert("L")), np.array([[0, 255], [255, 0]], dtype=np.uint8)))

    def test_expand_is_applied_before_apply_exclude_and_forced_composition(self):
        source = np.zeros((7, 7), dtype=np.uint8)
        source[3, 3] = 255
        expanded = expand_mask(source, 1)
        result = compose_masks(source.shape, [expanded], [expanded], forced_exclude_masks=[expanded])
        self.assertFalse(np.any(result))

    def test_workspace_hydrates_png_padding_without_a_schema_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.create_project()["id"]
            record = type("Record", (), {"relative_path": "one.png", "size_bytes": 1, "mtime_ns": 1})()
            image_id = str(store.reconcile_images(catalog, [record])["one.png"]["image_id"])
            mask_path = root / "candidate.png"
            raw = self._png(3)
            mask_path.write_bytes(raw)
            candidate = Candidate("candidate", "penis", .9, mask_path, role=CandidateRole.EXCLUDE, forced=True, expand_px=3)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            reopened = WorkspaceStore(root)
            revision, hydrated = reopened.hydrate_candidates(image_id, root / "cache", CatalogMixin._candidate_from_workspace)
            self.assertEqual(revision, 1)
            self.assertEqual(hydrated[0].expand_px, 3)
            self.assertEqual(hydrated[0].role, CandidateRole.EXCLUDE)
            self.assertTrue(hydrated[0].forced)
            self.assertEqual(reopened.candidate_png(image_id, "candidate"), raw)

    def test_workspace_defaults_existing_pngs_to_zero_without_modifying_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.create_project()["id"]
            record = type("Record", (), {"relative_path": "one.png", "size_bytes": 1, "mtime_ns": 1})()
            image_id = str(store.reconcile_images(catalog, [record])["one.png"]["image_id"])
            mask_path = root / "candidate.png"
            raw = self._png()
            mask_path.write_bytes(raw)
            store.commit_candidate_state(image_id, 1, [Candidate("candidate", "penis", .9, mask_path)], True, replace=True)
            revision, hydrated = WorkspaceStore(root).hydrate_candidates(image_id, root / "cache", CatalogMixin._candidate_from_workspace)
            self.assertEqual(revision, 1)
            self.assertEqual(hydrated[0].expand_px, 0)
            self.assertEqual(WorkspaceStore(root).candidate_png(image_id, "candidate"), raw)

    def test_candidate_padding_comes_only_from_current_metadata_column(self):
        with self.assertRaises(KeyError):
            WorkspaceStore._candidate_row({"mask_png": self._png()})
        for value in (True, 1.5, -1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                WorkspaceStore._candidate_row({"expand_px": value})

    def test_candidate_rejects_non_integer_padding(self):
        for value in (True, 1.5, -1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                Candidate("candidate", "penis", .9, Path("mask.png"), expand_px=value)
