"""End-to-end coverage for project catalogue persistence and mutations."""

from __future__ import annotations

import base64
import io
import shutil
import sqlite3
import tempfile
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.domain import Candidate, CandidateRole
from mozarie.state import StudioState


class ProjectCatalogCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.cache_dir = self.root / "cache"
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self.states:
            state.shutdown()
        self._temporary.cleanup()

    def state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.cache_dir, self.root / "sessions")
        self.states.append(state)
        return state

    @staticmethod
    def png(size: tuple[int, int] = (8, 8), *, pixel: tuple[int, int] | None = None) -> bytes:
        image = Image.new("L", size, 0)
        if pixel is not None:
            image.putpixel(pixel, 255)
        output = io.BytesIO(); image.save(output, format="PNG")
        return output.getvalue()

    def image(self, directory: Path, name: str, size: tuple[int, int] = (8, 8)) -> Path:
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, "white").save(path)
        return path

    def candidate(self, state: StudioState, image_id: str, candidate_id: str, *, role: CandidateRole = CandidateRole.APPLY, enabled: bool = True, forced: bool = False, pixel: tuple[int, int] = (1, 1)) -> Candidate:
        path = state.cache_dir / image_id / f"{candidate_id}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.png(pixel=pixel))
        return Candidate(candidate_id, "penis" if role == CandidateRole.APPLY else "hand", .9, path,
                         enabled=enabled, role=role, forced=forced,
                         source="auto" if role == CandidateRole.APPLY else "hand_exclusion")

    def commit_candidates(self, state: StudioState, image_id: str, candidates: list[Candidate], *, replace: bool = True) -> int:
        with state.image_io_lock(image_id):
            with state.lock:
                return state._commit_candidate_snapshot(image_id, candidates, replace=replace)

    def test_project_lifecycle_sources_exports_mismatch_and_read_only(self) -> None:
        first_root = self.root / "first"; second_root = self.root / "second"
        first_path = self.image(first_root, "a.png")
        self.image(second_root, "nested/b.png")
        state = self.state()
        project = state.create_project("catalog coverage")
        first = state.set_root(str(first_root)); first_id = first[0]["id"]
        both = state.set_root(str(second_root))
        self.assertEqual(len(both), 2)
        # The active project is deliberately excluded: this query drives the
        # warning shown only when another project already owns the folder.
        self.assertEqual(state.projects_for_source_root(str(first_root)), [])
        self.assertEqual(state.projects()[0]["name"], "catalog coverage")

        apply = self.candidate(state, first_id, "apply", pixel=(1, 1))
        exclude = self.candidate(state, first_id, "exclude", role=CandidateRole.EXCLUDE, forced=True, pixel=(2, 2))
        self.commit_candidates(state, first_id, [apply, exclude])
        manual = "data:image/png;base64," + base64.b64encode(self.png(pixel=(3, 3))).decode("ascii")
        state.save_manual_workspace(first_id, {
            "add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(first_id), "manualEnabled": True,
            "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        mosaic = Image.open(io.BytesIO(state.export_mask_png(first_id, "mosaic"))).convert("L")
        excluded = Image.open(io.BytesIO(state.export_mask_png(first_id, "exclude"))).convert("L")
        self.assertEqual(mosaic.size, (8, 8)); self.assertEqual(mosaic.getpixel((1, 1)), 255)
        self.assertEqual(excluded.getpixel((2, 2)), 255)
        self.assertEqual(state.project_mask_images()[0]["id"], first_id)
        self.assertEqual(Image.open(io.BytesIO(state.export_project_mask_png(first_id, "exclude"))).size, (8, 8))
        with self.assertRaises(ClientError): state.export_mask_png(first_id, "bad")
        with self.assertRaises(ClientError): state.export_project_mask_png("missing", "mosaic")

        # A same-size source change can retain masks after explicit confirmation.
        Image.new("RGB", (8, 8), "black").save(first_path)
        state.set_root(str(first_root))
        self.assertEqual(state.source_mismatch_snapshot()[0]["dimensionsChanged"], False)
        with self.assertRaisesRegex(ClientError, "元画像が変更"):
            state.set_candidate_state(first_id, "apply", {"enabled": False})
        state.resolve_source_mismatches([first_id], False)
        self.assertEqual(state.source_mismatch_snapshot(), [])

        # A changed geometry remains blocked until the user selects mask deletion.
        Image.new("RGB", (12, 6), "gray").save(first_path)
        state.set_root(str(first_root))
        self.assertTrue(state.source_mismatch_snapshot()[0]["dimensionsChanged"])
        state.resolve_source_mismatches([first_id], False)
        self.assertTrue(state.source_mismatch_snapshot())
        second_path = second_root / "nested/b.png"
        Image.new("RGB", (9, 9), "gray").save(second_path)
        state.set_root(str(second_root))
        changed_ids = [entry["id"] for entry in state.source_mismatch_snapshot()]
        with patch.object(state.workspace_store, "clear_image_workspaces", side_effect=RuntimeError("clear failed")):
            with self.assertRaisesRegex(RuntimeError, "clear failed"):
                state.resolve_source_mismatches(changed_ids, True)
        state.resolve_source_mismatches(changed_ids, True)
        self.assertEqual(state.source_mismatch_snapshot(), [])
        self.assertEqual(state.candidates[first_id], [])

        completed = state.complete_project()
        self.assertEqual(completed["status"], "completed")
        inactive = state.workspace_store.create_project("inactive resume")
        self.assertEqual(state.resume_project(inactive["id"])["status"], "working")
        reopened = self.state().open_project(project["id"])
        self.assertEqual(reopened["project"]["status"], "completed")
        self.assertTrue(self.states[-1].project_read_only)
        with self.assertRaisesRegex(ClientError, "完了したプロジェクト"):
            self.states[-1].clear_masks([])
        self.states[-1].resume_project(project["id"])
        self.assertFalse(self.states[-1].project_read_only)
        self.states[-1].close_project()

    def test_twenty_thousand_project_reopen_scans_metadata_and_hydrates_once(self) -> None:
        """The actual open_project path is linear metadata work, not PNG decoding."""
        source = self.root / "large-source"; source.mkdir()
        count = 20_000
        records = []
        for index in range(count):
            path = source / f"{index:05}.png"; path.write_bytes(b"x")
            stat = path.stat()
            records.append(SimpleNamespace(relative_path=path.name, size_bytes=stat.st_size,
                                           mtime_ns=stat.st_mtime_ns, width=3840, height=2160))
        state = self.state(); project = state.create_project("large reopen")
        source_id = state.workspace_store.ensure_project_source(
            project["id"], kind="native-folder", display_name=source.name, identity=str(source.resolve()),
        )
        stored = state.workspace_store.reconcile_images(project["id"], records, source_id)
        raw = self.png()
        db = sqlite3.connect(state.workspace_store.path)
        try:
            db.executemany("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                [(str(stored[record.relative_path]["image_id"]), "detector", "hand", .8, raw, 1,
                  "#112233", "auto", "automatic", None, "apply", 0) for record in records])
            db.commit()
        finally:
            db.close()
        started = time.perf_counter()
        with patch("mozarie.catalog.inspect_import_image", side_effect=AssertionError("unchanged file was inspected")) as inspected, \
             patch("mozarie.workspace.Image.open", side_effect=AssertionError("candidate PNG was decoded")) as decoded, \
             patch.object(state.workspace_store, "hydrate_candidates_bulk", wraps=state.workspace_store.hydrate_candidates_bulk) as hydrated:
            reopened = state.open_project(project["id"])
        elapsed = time.perf_counter() - started
        self.assertEqual(len(reopened["images"]), count)
        self.assertEqual(hydrated.call_count, 1)
        self.assertEqual(inspected.call_count, 0)
        self.assertEqual(decoded.call_count, 0)
        self.assertLess(elapsed, 25.0, f"20k project reopen took {elapsed:.3f}s")

    def test_multi_source_reopen_reconciles_before_one_replace_and_keeps_dimension_lock(self) -> None:
        first_root = self.root / "one"; second_root = self.root / "two"
        first_path = self.image(first_root, "first.png", (8, 8)); self.image(second_root, "second.png", (8, 8))
        state = self.state(); project = state.create_project("two sources")
        first_id = state.set_root(str(first_root))[0]["id"]
        state.set_root(str(second_root))
        Image.new("RGB", (12, 6), "black").save(first_path)
        with patch.object(state, "_replace_catalog", wraps=state._replace_catalog) as replaced, \
             patch.object(state.workspace_store, "hydrate_candidates_bulk", wraps=state.workspace_store.hydrate_candidates_bulk) as hydrated:
            state.open_project(project["id"])
        self.assertEqual(replaced.call_count, 1)
        self.assertEqual(hydrated.call_count, 1)
        self.assertEqual(state.source_mismatch_snapshot(), [{"id": first_id, "relativePath": "first.png", "dimensionsChanged": True}])
        state.resolve_source_mismatches([first_id], False)
        self.assertTrue(state.source_mismatch_snapshot(), "dimension change remains locked until mask deletion is chosen")
        state.resolve_source_mismatches([first_id], True)
        self.assertEqual(state.source_mismatch_snapshot(), [])

    def test_candidate_history_batch_and_failure_guards(self) -> None:
        root = self.root / "images"; self.image(root, "one.png"); self.image(root, "two.png")
        state = self.state(); state.create_project("history")
        image_ids = [item["id"] for item in state.set_root(str(root))]
        for index, image_id in enumerate(image_ids):
            self.commit_candidates(state, image_id, [self.candidate(state, image_id, f"apply-{index}")])

        self.assertEqual(state.set_candidate_state(image_ids[0], "apply-0", {"expandPx": 3, "color": "#112233", "enabled": False}), 2)
        self.assertTrue(state.project_history_status(image_ids[0])["canUndo"])
        undone = state.restore_project_history(image_ids[0], "undo")
        self.assertTrue(undone["current"]["candidates"][0]["enabled"])
        self.assertEqual(state.restore_project_history(image_ids[0], "redo")["current"]["candidates"][0]["expandPx"], 3)
        exclusion = self.candidate(state, image_ids[0], "exclude", role=CandidateRole.EXCLUDE, forced=False)
        self.commit_candidates(state, image_ids[0], [*state.candidates[image_ids[0]], exclusion])
        state.set_candidate_state(image_ids[0], "exclude", {"expandPx": 4, "forced": True})
        undone_exclusion = next(item for item in state.restore_project_history(image_ids[0], "undo")["current"]["candidates"] if item["id"] == "exclude")
        self.assertEqual((undone_exclusion["expandPx"], undone_exclusion["forced"]), (0, False))
        redone_exclusion = next(item for item in state.restore_project_history(image_ids[0], "redo")["current"]["candidates"] if item["id"] == "exclude")
        self.assertEqual((redone_exclusion["expandPx"], redone_exclusion["forced"]), (4, True))
        with self.assertRaises(ClientError): state.set_candidate_state(image_ids[0], "apply-0", {"role": "wrong"})
        with self.assertRaises(ClientError): state.set_candidate_state(image_ids[0], "apply-0", {"forced": True})
        with self.assertRaises(ClientError): state.set_candidate_state(image_ids[0], "apply-0", {"expandPx": True})

        revisions = state.batch_update_candidates_many(image_ids + [image_ids[0]], {"role": "apply", "operation": "enable"})
        self.assertEqual(set(revisions), set(image_ids))
        self.assertEqual(set(state.restore_project_history(image_ids[1], "undo")["changedImageIds"]), set(image_ids))
        self.assertGreater(state.batch_update_candidates(image_ids[0], {"role": "apply", "operation": "delete"}), 0)
        self.assertFalse((state.cache_dir / image_ids[0] / "apply-0.png").exists())
        self.assertFalse(state.delete_candidate(image_ids[0], "missing"))
        with self.assertRaises(ClientError): state.batch_update_candidates_many([], {"role": "apply", "operation": "enable"})
        with self.assertRaises(ClientError): state.batch_update_candidates(image_ids[0], {"role": "bad", "operation": "enable"})

        # The clear transaction must mark a batch history group failed if SQLite rejects it.
        with patch.object(state.workspace_store, "clear_image_workspaces", side_effect=RuntimeError("write failed")):
            with self.assertRaisesRegex(RuntimeError, "write failed"):
                state.clear_masks(image_ids)
        state.clear_masks(image_ids)
        self.assertEqual(state.candidates[image_ids[0]], [])

        state.worker_thread = types.SimpleNamespace(is_alive=lambda: True)
        with patch.object(state, "_assert_image_editable"):
            with self.assertRaises(ClientError): state.set_candidate_state(image_ids[0], "missing", {"enabled": True})
            with self.assertRaises(ClientError): state.batch_update_candidates(image_ids[0], {"role": "apply", "operation": "enable"})
            with self.assertRaises(ClientError): state.delete_candidate(image_ids[0], "missing")
        with patch.object(state, "_assert_catalog_mutable", side_effect=[None, None]):
            with self.assertRaises(ClientError): state.clear_masks(image_ids)
        state.worker_thread = None

        state.candidates[image_ids[0]] = [self.candidate(state, image_ids[0], "role", enabled=True)]
        state.set_candidate_state(image_ids[0], "role", {"role": "exclude", "forced": True})

        # A failing member marks the multi-image history group failed.
        with patch.object(state, "batch_update_candidates", side_effect=[1, RuntimeError("second failed")]):
            with self.assertRaisesRegex(RuntimeError, "second failed"):
                state.batch_update_candidates_many(image_ids, {"role": "apply", "operation": "enable"})

    def test_catalog_input_validation_provisional_and_removed_sources(self) -> None:
        state = self.state()
        with self.assertRaises(ClientError): state.set_root("")
        with self.assertRaises(ClientError): state.projects_for_source_root("relative")
        with self.assertRaises(ClientError): state.open_project("missing")
        with self.assertRaises(ClientError): state.name_current_project("name")
        with self.assertRaises(ClientError): state.complete_project()
        with self.assertRaises(ClientError): state.project_mask_images()
        with self.assertRaises(ClientError): state.activate_browser_catalog("missing")

        catalog_id = state.activate_browser_catalog()
        self.assertEqual(state.finalize_browser_catalog(), (catalog_id, {}))
        self.assertEqual(state.finalize_browser_catalog(), (catalog_id, {}))
        state.detach_catalog()
        with self.assertRaises(ClientError): state._set_root(str(self.root), "missing")

        # A project that only has browser sources opens without a filesystem
        # root and asks the UI to restore a granted browser handle.
        browser = state.create_project("browser-only")
        opened = state.open_project(browser["id"])
        self.assertEqual(opened["images"], [])
        self.assertFalse(opened["needsSource"])
        state.name_current_project("browser-renamed")
        with self.assertRaises(ClientError): state.name_current_project("")
        duplicate = state.create_project("duplicate")
        with self.assertRaises(ClientError): state.name_current_project("browser-renamed")

        # Browser imports preserve the source identity and reject impossible
        # client metadata before they mutate a session directory.
        staged = self.root / "staged.png"; staged.write_bytes(self.png())
        with self.assertRaises(ClientError):
            state._import_images([{"name": "bad.png", "relativePath": "bad.png", "stagedPath": staged, "mtimeNs": -1}])
        with self.assertRaises(ClientError):
            state._import_images([{"name": "bad.png", "relativePath": "bad.png", "stagedPath": staged, "sizeBytes": 1}])
        images, imported = state._import_images([{"name": "ok.png", "relativePath": "ok.png", "stagedPath": staged,
                                                   "mtimeNs": 123, "sizeBytes": len(self.png()), "clientKey": "ok"}],
                                                 source_identity="directory-id", source_kind="browser-directory")
        self.assertEqual(imported[0]["clientKey"], "ok")
        self.assertEqual(images[0]["sourceKind"], "session")

        source = self.root / "source"; self.image(source, "saved.png")
        state.create_project("remove"); image_id = state.set_root(str(source))[0]["id"]
        original = state.image_for_id(image_id).path
        result = state.remove_images_from_catalog([image_id, image_id])
        self.assertEqual(result["removedImageIds"], [image_id])
        self.assertTrue(original.is_file())
        with self.assertRaises(ClientError): state.remove_images_from_catalog([])
        with self.assertRaises(ClientError): state.remove_images_from_catalog("not a list")

    def test_export_error_paths_and_empty_history_status(self) -> None:
        root = self.root / "errors"; self.image(root, "image.png")
        state = self.state(); state.create_project("errors"); image_id = state.set_root(str(root))[0]["id"]
        self.assertIsNone(Image.open(io.BytesIO(state.export_mask_png(image_id, "mosaic"))).convert("L").getbbox())
        with patch.object(state.workspace_store, "export_state", return_value={"manual": {"removed": "not json"}, "candidates": []}):
            with self.assertRaises(ClientError): state.export_mask_png(image_id, "mosaic")
        with patch.object(state.workspace_store, "export_state", return_value={"manual": {"add": "not-base64"}, "candidates": []}):
            with self.assertRaises(ClientError): state.export_mask_png(image_id, "mosaic")
        with patch.object(state.workspace_store, "export_state", return_value={"manual": {}, "candidates": [{"enabled": False}]}):
            self.assertIsNotNone(state.export_mask_png(image_id, "mosaic"))
        with patch.object(state.workspace_store, "export_state", return_value={"manual": {}, "candidates": [{"id": "bad", "enabled": True}]}):
            with self.assertRaises(ClientError): state.export_mask_png(image_id, "mosaic")
        state.workspace_store.delete_images([image_id])
        self.assertEqual(state.project_history_status(image_id), {"canUndo": False, "canRedo": False})

    def test_delete_project_cleans_only_project_state_and_leaves_sources(self) -> None:
        source = self.root / "delete-source"; original = self.image(source, "original.png")
        state = self.state(); project = state.create_project("delete active")
        image_id = state.set_root(str(source))[0]["id"]
        candidate_dir = state.cache_dir / image_id; candidate_dir.mkdir(parents=True)
        (candidate_dir / "cached.png").write_bytes(self.png())
        thumbnail_dir = state.cache_dir / "thumbnails"; thumbnail_dir.mkdir(parents=True)
        thumbnail = thumbnail_dir / f"{image_id}-small.jpg"; thumbnail.write_bytes(b"thumbnail")

        state.delete_project(project["id"])
        self.assertIsNone(state.workspace_store.project(project["id"]))
        self.assertIsNone(state.catalog_id)
        self.assertEqual(state.list_images(), [])
        self.assertTrue(original.is_file())
        self.assertFalse(candidate_dir.exists())
        self.assertFalse(thumbnail.exists())

        with self.assertRaises(ClientError): state.delete_project(project["id"])

    def test_delete_project_handles_current_read_only_noncurrent_and_thumbnail_failure(self) -> None:
        first_root = self.root / "first-project"; second_root = self.root / "second-project"
        first_source = self.image(first_root, "first.png")
        state = self.state(); first = state.create_project("delete read only")
        first_id = state.set_root(str(first_root))[0]["id"]
        state.complete_project()
        state.open_project(first["id"])
        self.assertTrue(state.project_read_only)
        state.delete_project(first["id"])
        self.assertTrue(first_source.exists())
        self.assertIsNone(state.workspace_store.project(first["id"]))

        self.image(second_root, "second.png")
        state.create_project("delete other")
        state.set_root(str(second_root))
        inactive = state.create_project("inactive delete")
        state.set_root(str(first_root))
        inactive_image_id = state.order[0]
        state.create_project("current project")
        current_id = state.catalog_id
        inactive_cache = state.cache_dir / inactive_image_id; inactive_cache.mkdir(parents=True, exist_ok=True)
        thumbnail_dir = state.cache_dir / "thumbnails"; thumbnail_dir.mkdir(exist_ok=True)
        stubborn = thumbnail_dir / f"{inactive_image_id}-stubborn.jpg"; stubborn.write_bytes(b"thumbnail")

        original_unlink = Path.unlink
        def reject_stubborn(path: Path, *args: object, **kwargs: object) -> None:
            if path == stubborn:
                raise OSError("busy")
            original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", new=reject_stubborn):
            state.delete_project(inactive["id"])
        self.assertEqual(state.catalog_id, current_id)
        self.assertIsNone(state.workspace_store.project(inactive["id"]))
        self.assertTrue(stubborn.exists())

        state.worker_thread = types.SimpleNamespace(is_alive=lambda: True)
        with self.assertRaises(ClientError): state.delete_project(current_id or "")
        self.assertIsNotNone(state.workspace_store.project(current_id or ""))
        state.worker_thread = None

    def test_project_export_keeps_raw_per_image_state_and_rejects_bad_padding_metadata(self) -> None:
        source = self.root / "export-source"
        self.image(source, "first.png"); self.image(source, "second.png")
        state = self.state(); state.create_project("raw export")
        image_ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}
        first, second = image_ids["first.png"], image_ids["second.png"]
        apply = self.candidate(state, first, "apply", pixel=(1, 1)); apply.expand_px = 3
        exclude = self.candidate(state, first, "exclude", role=CandidateRole.EXCLUDE, forced=True, pixel=(2, 2)); exclude.expand_px = 5
        self.commit_candidates(state, first, [apply, exclude])
        state.save_manual_workspace(first, {
            "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(3, 3))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(first), "hasEffectiveMask": True,
        })

        exported = list(state.workspace_store.iter_project_export_states(state.catalog_id))
        self.assertEqual([entry["image"]["id"] for entry in exported], sorted((first, second)))
        first_state = next(entry for entry in exported if entry["image"]["id"] == first)
        second_state = next(entry for entry in exported if entry["image"]["id"] == second)
        self.assertIsInstance(first_state["candidates"][0]["mask"], bytes)
        self.assertEqual([(item["role"], item["forced"], item["expandPx"]) for item in first_state["candidates"]], [
            ("apply", False, 3), ("exclude", True, 5),
        ])
        self.assertIsInstance(first_state["manual"]["add"], bytes)
        self.assertIsNone(second_state["manual"])
        self.assertEqual(second_state["candidates"], [])

        with state.workspace_store._connect() as db:
            db.execute("UPDATE candidate_metadata SET expand_px=? WHERE image_id=? AND candidate_id=?", (-1, first, "apply"))
        replacement = self.state()
        with self.assertRaisesRegex(ValueError, "expand"):
            replacement.open_project(state.catalog_id)
        self.assertEqual(replacement.candidates, {})

    def test_streamed_project_mask_export_handles_raw_matrix_and_corruption(self) -> None:
        state = self.state()
        apply = self.png(pixel=(1, 1)); exclude = self.png(pixel=(2, 2))
        manual_add = self.png(pixel=(5, 5)); manual_exclude = self.png(pixel=(6, 6)); erase = self.png(pixel=(6, 6))
        raw = {
            "image": {"id": "raw", "relativePath": "raw.png", "width": 8, "height": 8},
            "candidates": [
                {"id": "apply", "mask": apply, "enabled": True, "role": "apply", "forced": False, "expandPx": 0},
                {"id": "exclude", "mask": exclude, "enabled": True, "role": "exclude", "forced": True, "expandPx": 0},
                {"id": "disabled", "mask": self.png(pixel=(3, 3)), "enabled": False, "role": "apply", "forced": False, "expandPx": 0},
                {"id": "removed", "mask": self.png(pixel=(4, 4)), "enabled": True, "role": "apply", "forced": False, "expandPx": 0},
            ],
            "manual": {"add": manual_add, "exclusion": manual_exclude, "erase": erase, "removed": '["removed"]',
                       "manualEnabled": True, "exclusionEnabled": True, "eraseEnabled": True, "exclusionForced": True},
        }
        mosaic = Image.open(io.BytesIO(state._export_workspace_mask_raw(raw, "mosaic"))).convert("L")
        excluded = Image.open(io.BytesIO(state._export_workspace_mask_raw(raw, "exclude"))).convert("L")
        self.assertEqual((mosaic.getpixel((1, 1)), mosaic.getpixel((5, 5)), mosaic.getpixel((3, 3))), (255, 255, 0))
        self.assertEqual((excluded.getpixel((2, 2)), excluded.getpixel((6, 6))), (255, 0))
        # A manual BLOB is a valid size source even before any candidate exists.
        manual_only = {"image": {"id": "manual", "relativePath": "manual.png", "width": 1, "height": 1}, "candidates": [], "manual": {"add": manual_add, "removed": "[]"}}
        self.assertEqual(Image.open(io.BytesIO(state._export_workspace_mask_raw(manual_only, "mosaic"))).size, (8, 8))
        for bad in (b"not a png", self.png(size=(7, 8))):
            with self.subTest(bad=bad[:8]), self.assertRaisesRegex(ClientError, "保存済みマスク"):
                state._raw_workspace_mask(bad, 8, 8)
        for malformed in (
            {**raw, "manual": {**raw["manual"], "removed": "not json"}},
            {**raw, "candidates": [{"id": "missing", "mask": None, "enabled": True, "role": "apply", "forced": False}]},
            {**raw, "candidates": [], "manual": {"add": b"not a png", "removed": "[]"}},
        ):
            with self.subTest(malformed=malformed["manual"].get("removed", "candidate")), self.assertRaisesRegex(ClientError, "保存済みマスク"):
                state._export_workspace_mask_raw(malformed, "mosaic")
        with self.assertRaises(ClientError):
            list(state.iter_project_mask_exports("bad"))
        with self.assertRaises(ClientError):
            list(state.iter_project_mask_exports("mosaic"))
