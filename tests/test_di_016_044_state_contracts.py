"""End-to-end data-integrity contracts for checklist DI-030 through DI-044."""

from __future__ import annotations

import base64
import io
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.image_io import mask_alpha_or_luma, render_with_mask
from mozarie.domain import Candidate, CandidateRole
from mozarie.saving import save_with_mask
from mozarie.state import StudioState


class DataIntegrityStateContracts(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.cache = self.root / "cache"
        self.sessions = self.root / "sessions"
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in reversed(self.states):
            state.shutdown()
        self._temporary.cleanup()

    def state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.cache, self.sessions)
        self.states.append(state)
        return state

    @staticmethod
    def mask(size: tuple[int, int], pixels: set[tuple[int, int]]) -> bytes:
        image = Image.new("L", size, 0)
        for pixel in pixels:
            image.putpixel(pixel, 255)
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    @staticmethod
    def uri(raw: bytes) -> str:
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

    def add_candidate(
        self,
        state: StudioState,
        image_id: str,
        candidate_id: str,
        *,
        pixel: tuple[int, int],
        size: tuple[int, int] = (16, 12),
        enabled: bool = True,
        role: CandidateRole = CandidateRole.APPLY,
        forced: bool = False,
        expand_px: int = 0,
    ) -> Candidate:
        path = state.cache_dir / image_id / f"{candidate_id}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.mask(size, {pixel}))
        return Candidate(candidate_id, "penis" if role == CandidateRole.APPLY else "hand", .9, path,
                         enabled=enabled, role=role, forced=forced, expand_px=expand_px)

    @staticmethod
    def commit(state: StudioState, image_id: str, candidates: list[Candidate]) -> int:
        with state.image_io_lock(image_id):
            with state.lock:
                return state._commit_candidate_snapshot(image_id, candidates, replace=True)

    def manual(self, state: StudioState, image_id: str, *, add=(), exclusion=(), erase=(), size=(16, 12)) -> None:
        state.save_manual_workspace(image_id, {
            "add": self.uri(self.mask(size, set(add))),
            "exclusion": self.uri(self.mask(size, set(exclusion))),
            "exclusionErase": self.uri(self.mask(size, set(erase))),
            "removedCandidateIds": [], "candidateRevision": state._candidate_revision(image_id),
            "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
        })

    @staticmethod
    def decoded_uri(value: str) -> bytes:
        return base64.b64decode(value.split(",", 1)[1])

    def test_filtered_and_single_overwrites_leave_every_non_target_file_byte_identical(self) -> None:
        for label, selected in (("all", "ABCD"), ("masked", "AB"), ("reviewed", "AC"), ("single", "A")):
            with self.subTest(label=label):
                source = self.root / f"save-{label}"; source.mkdir()
                for index, name in enumerate("ABCDEFGH"):
                    pixels = np.indices((18, 24)).sum(axis=0).astype(np.uint8)
                    rgb = np.dstack((pixels * 5, pixels * 7, np.full_like(pixels, 30 + index)))
                    Image.fromarray(rgb).save(source / f"{name}.png")
                state = self.state(); state.create_project(f"save-{label}")
                ids = {Path(item["relativePath"]).stem: item["id"] for item in state.set_root(str(source))}
                painted = {(x, y) for y in range(3, 15) for x in range(4, 20)}
                for name in "ABCDEFGH": self.manual(state, ids[name], add=painted, size=(24, 18))
                original = {name: (source / f"{name}.png").read_bytes() for name in "ABCDEFGH"}
                for _repeat in range(2 if label != "single" else 1):
                    before = {name: (source / f"{name}.png").read_bytes() for name in "ABCDEFGH"}
                    for name in selected:
                        record = state.image_for_id(ids[name])
                        with Image.open(io.BytesIO(state.export_mask_png(ids[name], "mosaic"))) as exported:
                            save_with_mask(record, np.asarray(exported.convert("L")), 3)
                    self.assertEqual({name: (source / f"{name}.png").read_bytes() for name in "ABCDEFGH" if name not in selected},
                                     {name: before[name] for name in "ABCDEFGH" if name not in selected})
                for name in selected:
                    self.assertNotEqual((source / f"{name}.png").read_bytes(), original[name], name)

    def test_eight_image_project_reopen_history_switch_and_catalog_removal_are_isolated(self) -> None:
        source = self.root / "eight"
        source.mkdir()
        for name in "ABCDEFGH":
            pixels = np.zeros((12, 16, 3), dtype=np.uint8)
            pixels[:, :, 0] = np.arange(16, dtype=np.uint8)[None, :] * 12
            pixels[:, :, 1] = np.arange(12, dtype=np.uint8)[:, None] * 15
            pixels[:, :, 2] = ord(name)
            Image.fromarray(pixels).save(source / f"{name}.png")
        state = self.state()
        project = state.create_project("eight-state")
        ids = {Path(item["relativePath"]).stem: item["id"] for item in state.set_root(str(source))}

        for index, name in enumerate("ABCDEFGH"):
            candidates = [self.add_candidate(state, ids[name], f"apply-{name}", pixel=(index + 1, 1),
                                             enabled=name not in "CH", expand_px=index,
                                             role=CandidateRole.EXCLUDE if name in "BDFH" else CandidateRole.APPLY,
                                             forced=name in "DH")]
            self.commit(state, ids[name], candidates)
            self.manual(state, ids[name], add={(index + 1, 3)}, exclusion={(index + 1, 5)})
            state.set_image_flags(ids[name], {"reviewed": name in "ACEG", "hidden": name in "EFGH"})

        def durable_snapshot(current: StudioState) -> dict[str, object]:
            result = {}
            for name in "ABCDEFGH":
                candidate = current.candidates[ids[name]][0]
                current.materialize_candidate_mask(candidate, ids[name])
                manual = current.manual_workspace(ids[name])
                result[name] = {
                    "candidate": (candidate.candidate_id, candidate.enabled, candidate.role.value, candidate.forced,
                                  candidate.expand_px, candidate.mask_path.read_bytes()),
                    "manual": tuple(self.decoded_uri(manual[key]) for key in ("add", "exclusion", "exclusionErase")),
                }
            return result

        prepared_snapshot = durable_snapshot(state)

        self.manual(state, ids["A"], add={(10, 3)}, exclusion={(1, 5)})
        history_b = state.project_history_status(ids["B"])
        manual_b = state.manual_workspace(ids["B"])
        undone_a = state.restore_project_history(ids["A"], "undo")
        self.assertEqual(undone_a["changedImageIds"], [ids["A"]])
        restored_a = state.manual_workspace(ids["A"])
        with Image.open(io.BytesIO(self.decoded_uri(restored_a["add"]))) as restored_add:
            self.assertEqual(Image.fromarray(mask_alpha_or_luma(restored_add)).getbbox(), (1, 3, 2, 4), "A undo restores the preceding drawn pixel")
        self.assertEqual(state.project_history_status(ids["B"]), history_b)
        self.assertEqual(state.manual_workspace(ids["B"]), manual_b)

        other_source = self.root / "other"
        other_source.mkdir()
        Image.new("RGB", (16, 12), "white").save(other_source / "other.png")
        other = state.create_project("other-history")
        other_id = state.set_root(str(other_source))[0]["id"]
        self.manual(state, other_id, add={(2, 2)})
        self.manual(state, other_id, add={(3, 3)})
        state.restore_project_history(other_id, "undo")
        other_status = state.project_history_status(other_id)
        state.open_project(project["id"])
        a_status = state.project_history_status(ids["A"])
        state.open_project(other["id"])
        self.assertEqual(state.project_history_status(other_id), other_status)
        with Image.open(io.BytesIO(self.decoded_uri(state.manual_workspace(other_id)["add"]))) as other_add:
            self.assertEqual(Image.fromarray(mask_alpha_or_luma(other_add)).getbbox(), (2, 2, 3, 3), "the other project undo restores its own prior drawing")
        state.open_project(project["id"])
        self.assertEqual(state.project_history_status(ids["A"]), a_status)
        self.assertEqual(durable_snapshot(state), prepared_snapshot, "undo in the other project cannot change this project's candidates or ranges")

        hidden_source_bytes = {name: (source / f"{name}.png").read_bytes() for name in "EFGH"}
        for name in "ABCD":
            record = state.image_for_id(ids[name])
            with Image.open(io.BytesIO(state.export_mask_png(ids[name], "mosaic"))) as exported_mask:
                save_with_mask(record, np.asarray(exported_mask.convert("L")), 3)
            saved_stat = record.path.stat()
            state.workspace_store.commit_save(ids[name], mtime_ns=saved_stat.st_mtime_ns, size_bytes=saved_stat.st_size,
                                              clear_workspace=False)
        self.assertEqual({name: (source / f"{name}.png").read_bytes() for name in "EFGH"}, hidden_source_bytes)

        state.complete_project()
        reopened = self.state()
        with patch("mozarie.catalog.inspect_import_image", side_effect=AssertionError("project reopen imported source again")) as inspected:
            opened = reopened.open_project(project["id"])
        self.assertEqual(inspected.call_count, 0)
        self.assertEqual({Path(item["relativePath"]).stem for item in opened["images"]}, set("ABCDEFGH"))
        restored = {Path(item["relativePath"]).stem: item for item in opened["images"]}
        self.assertEqual({name: (restored[name]["reviewed"], restored[name]["hidden"]) for name in "ABCDEFGH"},
                         {name: (name in "ACEG", name in "EFGH") for name in "ABCDEFGH"})
        for name in "ABCDEFGH":
            self.assertIsNotNone(reopened.manual_workspace(ids[name]), name)
            self.assertEqual(reopened.project_history_status(ids[name])["canUndo"], True, name)
        self.assertEqual(durable_snapshot(reopened), prepared_snapshot, "restart restores every candidate mask/property and manual layer byte-for-byte")
        reopened.resume_project(project["id"])
        for index, name in enumerate("ABCDEFGH"):
            self.assertEqual([(item.candidate_id, item.enabled, item.expand_px) for item in reopened.candidates[ids[name]]],
                             [(f"apply-{name}", name not in "CH", index)], name)
            undone = reopened.restore_project_history(ids[name], "undo")
            self.assertEqual(undone["changedImageIds"], [ids[name]], name)
            redone = reopened.restore_project_history(ids[name], "redo")
            self.assertEqual(redone["changedImageIds"], [ids[name]], name)

        source_a = source / "A.png"
        original_a = source_a.read_bytes()
        reopened.remove_image_from_catalog(ids["A"])
        after_remove = self.state()
        after_remove.open_project(project["id"])
        self.assertNotIn(ids["A"], after_remove.images)
        self.assertEqual({Path(item["relativePath"]).stem for item in after_remove.list_images()}, set("BCDEFGH"))
        self.assertEqual(source_a.read_bytes(), original_a)
        with self.assertRaises(ClientError):
            after_remove.set_candidate_state(ids["A"], "apply-A", {"enabled": False})
        with self.assertRaises(ClientError):
            after_remove.save_manual_workspace(ids["A"], {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": []})
        with self.assertRaises(ClientError):
            after_remove.project_history_status(ids["A"])
        with self.assertRaises(ClientError):
            after_remove.restore_project_history(ids["A"], "undo")
        db = sqlite3.connect(after_remove.workspace_store.path)
        try:
            for table in ("images", "candidates", "manual_edits", "candidate_metadata", "history_entries", "history_cursors"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (ids["A"],)).fetchone()[0], 0, table)
        finally:
            db.close()

    def test_project_delete_cascades_every_owned_row_and_preserves_other_project_and_sources(self) -> None:
        state = self.state()
        projects: dict[str, tuple[str, Path, str]] = {}
        for label in ("delete", "keep"):
            folder = self.root / label
            folder.mkdir()
            path = folder / "source.png"
            Image.new("RGB", (16, 12), label == "keep" and "green" or "red").save(path)
            project = state.create_project(label)
            image_id = state.set_root(str(folder))[0]["id"]
            candidate = self.add_candidate(state, image_id, f"candidate-{label}", pixel=(1, 1))
            self.commit(state, image_id, [candidate])
            self.manual(state, image_id, add={(2, 2)})
            projects[label] = (project["id"], path, image_id)
        delete_project, delete_source, delete_id = projects["delete"]
        keep_project, keep_source, keep_id = projects["keep"]
        delete_bytes, keep_bytes = delete_source.read_bytes(), keep_source.read_bytes()

        before = sqlite3.connect(state.workspace_store.path)
        try:
            for table in ("images", "candidates", "manual_edits", "candidate_metadata", "history_entries", "history_cursors", "history_candidate_refs"):
                self.assertGreater(before.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (delete_id,)).fetchone()[0], 0, table)
        finally:
            before.close()

        state.delete_project(delete_project)
        db = sqlite3.connect(state.workspace_store.path)
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM catalogs WHERE catalog_id=?", (delete_project,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM project_sources WHERE catalog_id=?", (delete_project,)).fetchone()[0], 0)
            for table in ("images", "candidates", "manual_edits", "candidate_metadata", "history_entries", "history_cursors"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (delete_id,)).fetchone()[0], 0, table)
                self.assertGreater(db.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (keep_id,)).fetchone()[0], 0, table)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM history_candidate_refs WHERE image_id=?", (delete_id,)).fetchone()[0], 0)
        finally:
            db.close()
        self.assertEqual(delete_source.read_bytes(), delete_bytes)
        self.assertEqual(keep_source.read_bytes(), keep_bytes)
        self.assertIsNotNone(state.workspace_store.project(keep_project))

    def test_mask_exports_preserve_dimensions_roles_erase_padding_and_disabled_candidates(self) -> None:
        source = self.root / "masks"
        source.mkdir()
        source_pixels = np.zeros((24, 32, 3), dtype=np.uint8)
        source_pixels[:, :, 0] = np.arange(32, dtype=np.uint8)[None, :] * 7
        source_pixels[:, :, 1] = np.arange(24, dtype=np.uint8)[:, None] * 9
        source_pixels[:, :, 2] = 100
        Image.fromarray(source_pixels).save(source / "source.png")
        state = self.state()
        state.create_project("mask-contract")
        image_id = state.set_root(str(source))[0]["id"]
        candidates = [
            self.add_candidate(state, image_id, "apply", pixel=(12, 10), size=(32, 24)),
            self.add_candidate(state, image_id, "off", pixel=(20, 10), size=(32, 24), enabled=False),
            self.add_candidate(state, image_id, "exclude", pixel=(12, 10), size=(32, 24), role=CandidateRole.EXCLUDE, forced=True),
            self.add_candidate(state, image_id, "edge", pixel=(0, 0), size=(32, 24), expand_px=10),
        ]
        self.commit(state, image_id, candidates)
        self.manual(state, image_id, add={(8, 8), (9, 9)}, exclusion={(8, 8), (18, 18)}, erase={(8, 8)}, size=(32, 24))

        mosaic_bytes = state.export_mask_png(image_id, "mosaic")
        exclude_bytes = state.export_mask_png(image_id, "exclude")
        with Image.open(io.BytesIO(mosaic_bytes)) as mosaic, Image.open(io.BytesIO(exclude_bytes)) as excluded:
            mosaic = mask_alpha_or_luma(mosaic)
            excluded = mask_alpha_or_luma(excluded)
            expected_mosaic = np.zeros((24, 32), dtype=np.uint8)
            for y, right in enumerate((10, 10, 10, 10, 9, 9, 8, 7, 6, 4, 0)):
                expected_mosaic[y, :right + 1] = 255
            expected_mosaic[8, 8] = 255; expected_mosaic[9, 9] = 255
            expected_excluded = np.zeros((24, 32), dtype=np.uint8); expected_excluded[10, 12] = 255; expected_excluded[18, 18] = 255
            self.assertTrue(np.array_equal(mosaic, expected_mosaic), "every mosaic-mask pixel matches ON/OFF candidates minus exclusion/erase semantics")
            self.assertTrue(np.array_equal(excluded, expected_excluded), "every exclusion-mask pixel matches candidate plus manual minus eraser")

        record = state.image_for_id(image_id)
        rendered = render_with_mask(record, state.combined_candidate_mask(image_id), 3)
        with Image.open(io.BytesIO(rendered)) as saved:
            saved_pixels = np.asarray(saved.convert("RGB"))
        self.assertTrue(np.array_equal(saved_pixels[10, 12], source_pixels[10, 12]), "excluded pixel keeps the original image value")
        self.assertTrue(np.array_equal(saved_pixels[10, 20], source_pixels[10, 20]), "disabled candidate pixel keeps the original image value")
        self.assertFalse(np.array_equal(saved_pixels[3, 3], source_pixels[3, 3]), "enabled padded candidate changes the saved image")

        project_id = state.catalog_id
        self.assertIsNotNone(project_id)
        for kind, single in (("mosaic", mosaic_bytes), ("exclude", exclude_bytes)):
            exported = list(state.iter_project_mask_exports(str(project_id), kind))
            self.assertEqual(len(exported), 1)
            self.assertEqual(exported[0][1], single, f"project {kind} export matches single-image bytes exactly")

        padding_source = source / "padding.png"; Image.fromarray(source_pixels).save(padding_source)
        state.set_root(str(source))
        padding_id = next(item["id"] for item in state.list_images() if item["relativePath"] == "padding.png")
        edge = self.add_candidate(state, padding_id, "padding", pixel=(0, 0), size=(32, 24), expand_px=0)
        self.commit(state, padding_id, [edge])
        with Image.open(io.BytesIO(state.export_mask_png(padding_id, "mosaic"))) as image:
            zero = mask_alpha_or_luma(image)
        state.set_candidate_state(padding_id, "padding", {"expandPx": 10})
        with Image.open(io.BytesIO(state.export_mask_png(padding_id, "mosaic"))) as image:
            ten = mask_alpha_or_luma(image)
        expected_zero = np.zeros((24, 32), dtype=np.uint8); expected_zero[0, 0] = 255
        expected_ten = np.zeros((24, 32), dtype=np.uint8)
        for y, right in enumerate((10, 10, 10, 10, 9, 9, 8, 7, 6, 4, 0)):
            expected_ten[y, :right + 1] = 255
        self.assertTrue(np.array_equal(zero, expected_zero), "0px output equals the source candidate mask")
        self.assertTrue(np.array_equal(ten, expected_ten), "10px output expands exactly ten pixels and clips at both image edges")

    def test_original_format_overwrite_preserves_each_codec_and_dimensions(self) -> None:
        source = self.root / "formats"
        source.mkdir()
        specifications = {"sample.png": ("PNG", (19, 13)), "sample.jpg": ("JPEG", (17, 11)), "sample.webp": ("WEBP", (15, 9))}
        for filename, (codec, size) in specifications.items():
            Image.new("RGB", size, "#7799bb").save(source / filename, format=codec)
        state = self.state()
        state.create_project("formats")
        images = state.set_root(str(source))
        for item in images:
            record = state.image_for_id(item["id"])
            before_suffix = record.path.suffix.lower()
            mask = np.zeros((record.height, record.width), dtype=np.uint8)
            mask[1:min(7, record.height), 1:min(7, record.width)] = 255
            save_with_mask(record, mask, 3)
            with Image.open(record.path) as saved:
                expected_codec, expected_size = specifications[record.path.name]
                self.assertEqual(saved.format, expected_codec)
                self.assertEqual(saved.size, expected_size)
                saved.load()
            self.assertEqual(record.path.suffix.lower(), before_suffix)


if __name__ == "__main__":
    unittest.main()
