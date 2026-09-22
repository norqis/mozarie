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
from tests import prepare_test_app_config

import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.domain import Candidate, CandidateRole
from mozarie.state import StudioState


class ProjectCatalogCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        prepare_test_app_config(self.app_dir)
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
        second_path = second_root / "nested/b.png"
        second_stat = second_path.stat()
        second_source = state.workspace_store.ensure_project_source(
            project["id"], kind="native-folder", display_name=second_root.name, identity=str(second_root.resolve()),
        )
        state.workspace_store.reconcile_images(project["id"], [
            SimpleNamespace(relative_path="nested/b.png", size_bytes=second_stat.st_size,
                            mtime_ns=second_stat.st_mtime_ns, width=8, height=8),
        ], second_source)
        both = state.open_project(project["id"])["images"]
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
        self.assertEqual(state.source_mismatch_snapshot(), [])
        Image.new("RGB", (9, 9), "gray").save(second_path)
        state.open_project(project["id"])
        changed_ids = [entry["id"] for entry in state.source_mismatch_snapshot()]
        state.resolve_source_mismatches(changed_ids, True)
        self.assertEqual(state.source_mismatch_snapshot(), [])
        self.assertTrue(state.candidates[first_id])

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
        self.assertEqual(state.source_mismatch_snapshot(), [])
        state.resolve_source_mismatches([first_id], True)
        self.assertEqual(state.source_mismatch_snapshot(), [])

    def test_candidate_history_batch_and_failure_guards(self) -> None:
        root = self.root / "images"; self.image(root, "one.png"); self.image(root, "two.png")
        state = self.state(); state.create_project("history")
        image_ids = [item["id"] for item in state.set_root(str(root))]
        for index, image_id in enumerate(image_ids):
            self.commit_candidates(state, image_id, [self.candidate(state, image_id, f"apply-{index}")])

        state.set_image_flags(image_ids[0], {"reviewed": True})
        self.assertEqual(state.set_candidate_state(image_ids[0], "apply-0", {"expandPx": 3, "color": "#112233", "enabled": False}), 2)
        self.assertTrue(state.images[image_ids[0]].reviewed)
        self.assertTrue(next(image for image in state.list_images() if image["id"] == image_ids[0])["reviewed"])
        self.assertEqual(state.workspace_store.image_state(image_ids[0])[1], True)
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

        state.set_image_flags_bulk({"imageIds": image_ids, "reviewed": True})
        revisions = state.batch_update_candidates_many(image_ids + [image_ids[0]], {"role": "apply", "operation": "enable"})
        self.assertEqual(set(revisions), set(image_ids))
        self.assertTrue(all(image["reviewed"] for image in state.list_images() if image["id"] in image_ids))
        self.assertEqual(set(state.restore_project_history(image_ids[1], "undo")["changedImageIds"]), set(image_ids))
        self.assertGreater(state.batch_update_candidates(image_ids[0], {"role": "apply", "operation": "delete"}), 0)
        self.assertFalse((state.cache_dir / image_ids[0] / "apply-0.png").exists())
        self.assertFalse(state.delete_candidate(image_ids[0], "missing"))
        with self.assertRaises(ClientError): state.batch_update_candidates_many([], {"role": "apply", "operation": "enable"})
        with self.assertRaises(ClientError): state.batch_update_candidates(image_ids[0], {"role": "bad", "operation": "enable"})

        # A durable batch write failure leaves the live candidate snapshot unchanged.
        state.set_image_flags(image_ids[1], {"reviewed": True})
        with patch.object(state.workspace_store, "commit_candidate_states", side_effect=RuntimeError("second failed")):
            with self.assertRaisesRegex(RuntimeError, "second failed"):
                state.batch_update_candidates_many([image_ids[1]], {"role": "apply", "operation": "enable"})
        self.assertTrue(state.images[image_ids[1]].reviewed)

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
        state.worker_thread = types.SimpleNamespace(is_alive=lambda: True, join=lambda: None)
        with self.assertRaises(ClientError):
            state.clear_masks(image_ids)
        state.worker_thread = None

        state.candidates[image_ids[0]] = [self.candidate(state, image_ids[0], "role", enabled=True)]
        state.candidates[image_ids[1]] = [self.candidate(state, image_ids[1], "role-2", enabled=True)]
        self.commit_candidates(state, image_ids[0], state.candidates[image_ids[0]])
        self.commit_candidates(state, image_ids[1], state.candidates[image_ids[1]])
        state.set_candidate_state(image_ids[0], "role", {"role": "exclude", "forced": True})

    def test_projectless_candidate_change_keeps_reviewed_after_success_and_failure(self) -> None:
        root = self.root / "images"; self.image(root, "one.png")
        state = self.state(); image_id = state.set_root(str(root))[0]["id"]
        self.commit_candidates(state, image_id, [self.candidate(state, image_id, "apply")])
        state.set_image_flags(image_id, {"reviewed": True})
        with patch.object(state.workspace_store, "commit_candidate_state", side_effect=sqlite3.OperationalError("write failed")):
            with self.assertRaises(sqlite3.OperationalError):
                state.set_candidate_state(image_id, "apply", {"enabled": False})
        self.assertTrue(state.images[image_id].reviewed)
        self.assertTrue(next(image for image in state.list_images() if image["id"] == image_id)["reviewed"])
        state.set_candidate_state(image_id, "apply", {"enabled": False})
        self.assertTrue(state.images[image_id].reviewed)
        self.assertTrue(next(image for image in state.list_images() if image["id"] == image_id)["reviewed"])

    def test_review_choice_survives_edits_history_restart_and_list_removal(self) -> None:
        source = self.root / "review-choice"
        paths = [self.image(source, name) for name in ("target.png", "other.png")]
        originals = {path: path.read_bytes() for path in paths}
        state = self.state(); project = state.create_project("review choice")
        ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}
        target, other = ids["target.png"], ids["other.png"]
        self.commit_candidates(state, target, [self.candidate(state, target, "apply"), self.candidate(state, target, "exclude", role=CandidateRole.EXCLUDE)])
        self.commit_candidates(state, other, [self.candidate(state, other, "other-apply")])
        state.set_image_flags(target, {"reviewed": True})
        manual = "data:image/png;base64," + base64.b64encode(self.png(pixel=(3, 3))).decode("ascii")
        operations = [
            lambda: state.set_candidate_state(target, "apply", {"enabled": False, "expandPx": 3, "color": "#123456"}),
            lambda: state.set_candidate_state(target, "exclude", {"forced": True, "expandPx": 2}),
            lambda: state.batch_update_candidates_many([target, other], {"role": "apply", "operation": "enable"}),
            lambda: state.save_manual_workspace(target, {"add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": True}),
            lambda: state.set_image_transform(target, {"flipH": True, "flipV": True}),
            lambda: state.delete_candidate(target, "exclude"),
            lambda: state.clear_masks([target]),
        ]
        for operation in operations:
            operation()
            self.assertTrue(state.images[target].reviewed)
            self.assertTrue(state.workspace_store.image_state(target)[1])
            for direction in ("undo", "redo"):
                state.restore_project_history(target, direction)
                self.assertTrue(state.images[target].reviewed, direction)
                self.assertTrue(state.workspace_store.image_state(target)[1], direction)
            self.assertFalse(state.images[other].reviewed)
        state.rename_catalog_image(target, "renamed.png")
        restarted = self.state(); restarted.open_project(project["id"])
        self.assertTrue(restarted.images[target].reviewed)
        self.assertFalse(restarted.images[other].reviewed)
        restarted.set_image_flags(target, {"reviewed": False})
        self.assertFalse(restarted.images[target].reviewed)
        restarted.restore_project_history(target, "undo")
        self.assertTrue(restarted.images[target].reviewed, "explicit unreview remains undoable")
        restarted.restore_project_history(target, "redo")
        self.assertFalse(restarted.images[target].reviewed)
        result = restarted.remove_images_from_catalog([target, other])
        self.assertEqual(set(result["removedImageIds"]), {target, other})
        self.assertEqual({path: path.read_bytes() for path in paths}, originals)
        reopened = self.state(); reopened.open_project(project["id"])
        self.assertEqual(reopened.list_images(), [])
        self.assertFalse(reopened.workspace_store.has_image(target))
        self.assertFalse(reopened.workspace_store.history_status(other)["canUndo"])

    def test_catalog_input_validation_provisional_and_removed_sources(self) -> None:
        state = self.state()
        with self.assertRaises(ClientError): state.set_root("")
        with self.assertRaises(ClientError): state.projects_for_source_root("relative")
        with self.assertRaises(ClientError): state.open_project("missing")
        with self.assertRaises(ClientError): state.name_current_project("name")
        with self.assertRaises(ClientError): state.complete_project()
        with self.assertRaises(ClientError): state.project_mask_images()
        with self.assertRaises(ValueError): state.workspace_store.activate_projectless_catalog("missing")
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
            state._import_images([{"name": "bad.png", "relativePath": "bad.png", "stagedPath": staged, "mtimeNs": -1}], intent="add")
        with self.assertRaises(ClientError):
            state._import_images([{"name": "bad.png", "relativePath": "bad.png", "stagedPath": staged, "sizeBytes": 1}], intent="add")
        staged.write_bytes(self.png())
        images, imported = state._import_images([{"name": "ok.png", "relativePath": "ok.png", "stagedPath": staged,
                                                   "mtimeNs": 123, "sizeBytes": len(self.png()), "clientKey": "ok"}],
                                                 source_identity="directory-id", source_kind="browser-directory", intent="add")
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

    def test_removed_project_image_does_not_revive_when_source_still_exists(self) -> None:
        source = self.root / "removed-image-reopen"; original = self.image(source, "original.png")
        state = self.state(); project = state.create_project("removed image reopen")
        image_id = state.set_root(str(source))[0]["id"]
        state.remove_image_from_catalog(image_id)
        self.assertTrue(original.is_file(), "catalog deletion keeps the original source")
        state.close_project()
        reopened = state.open_project(project["id"])
        self.assertEqual(reopened["images"], [], "reopening the project must not rescan and revive its deleted image")
        self.assertTrue(original.is_file())

    def test_clear_project_images_closes_live_project_but_keeps_empty_project_and_sources(self) -> None:
        source = self.root / "clear-project-images"; original = self.image(source, "original.png")
        state = self.state(); project = state.create_project("clear project images")
        state.set_root(str(source))
        state.clear_catalog()
        self.assertIsNone(state.catalog_id, "clearing project images closes the live project")
        self.assertEqual(state.list_images(), [])
        self.assertIsNotNone(state.workspace_store.project(project["id"]), "the empty project remains listed")
        self.assertTrue(original.is_file(), "clearing project data keeps original source files")

    def test_same_named_images_from_different_paths_keep_edits_isolated(self) -> None:
        source = self.root / "same-name"
        self.image(source, "left/page.png"); self.image(source, "right/page.png")
        state = self.state(); state.create_project("same names")
        by_path = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}
        left_id, right_id = by_path["left/page.png"], by_path["right/page.png"]
        self.commit_candidates(state, left_id, [self.candidate(state, left_id, "left-only")])
        state.save_manual_workspace(left_id, {
            "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(4, 4))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(left_id), "hasEffectiveMask": True,
        })
        reopened = self.state().open_project(state.catalog_id or "")
        self.assertNotEqual(left_id, right_id)
        self.assertEqual([item["id"] for item in reopened["images"]], [left_id, right_id])
        self.assertEqual([item.candidate_id for item in self.states[-1].candidates[left_id]], ["left-only"])
        self.assertEqual(self.states[-1].candidates[right_id], [])
        self.assertIsNotNone(self.states[-1].manual_workspace(left_id))
        self.assertIsNone(self.states[-1].manual_workspace(right_id))

    def test_candidate_update_refreshes_no_mosaic_membership_without_stale_state(self) -> None:
        source = self.root / "candidate-refresh"; self.image(source, "image.png")
        state = self.state(); state.create_project("candidate refresh")
        image_id = state.set_root(str(source))[0]["id"]
        candidate = self.candidate(state, image_id, "candidate")
        self.commit_candidates(state, image_id, [candidate])
        masked = next(item for item in state.list_images() if item["id"] == image_id)
        self.assertEqual((masked["enabledCandidateCount"], masked["hasEffectiveMask"]), (1, True))
        state.set_candidate_state(image_id, "candidate", {"enabled": False})
        refreshed = next(item for item in state.list_images() if item["id"] == image_id)
        self.assertEqual((refreshed["enabledCandidateCount"], refreshed["hasEffectiveMask"]), (0, False))
        self.assertFalse(state.workspace_store.image_state(image_id)[1], "durable reviewed/mask state must not preserve the old effective mask")

    def test_effective_mosaic_pixels_are_apply_plus_manual_minus_exclusion(self) -> None:
        source = self.root / "effective-pixels"; self.image(source, "image.png")
        state = self.state(); state.create_project("effective pixels"); image_id = state.set_root(str(source))[0]["id"]
        apply = self.candidate(state, image_id, "apply", pixel=(1, 1))
        exclude = self.candidate(state, image_id, "exclude", role=CandidateRole.EXCLUDE, forced=True, pixel=(1, 1))
        self.commit_candidates(state, image_id, [apply, exclude])
        cancelled = Image.open(io.BytesIO(state.export_mask_png(image_id, "mosaic"))).convert("L")
        self.assertIsNone(cancelled.getbbox(), "forced exclusion subtracts the overlapping automatic apply pixel")
        state.save_manual_workspace(image_id, {
            "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(5, 5))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(image_id), "manualEnabled": True,
            "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        effective = Image.open(io.BytesIO(state.export_mask_png(image_id, "mosaic"))).convert("L")
        self.assertEqual(effective.getpixel((1, 1)), 0)
        self.assertEqual(effective.getpixel((5, 5)), 255, "manual include outside the exclusion remains an effective mosaic pixel")

    def test_clear_two_images_removes_only_their_project_data_and_keeps_all_source_files(self) -> None:
        source = self.root / "clear-two"
        paths = [self.image(source, f"{name}.png") for name in ("one", "two", "three")]
        state = self.state(); state.create_project("clear two")
        ids = [item["id"] for item in state.set_root(str(source))]
        for index, image_id in enumerate(ids):
            self.commit_candidates(state, image_id, [self.candidate(state, image_id, f"candidate-{index}")])
        untouched_before = state.workspace_store.export_state(ids[2])
        state.clear_masks(ids[:2])
        for image_id in ids[:2]:
            cleared = state.workspace_store.export_state(image_id)
            self.assertEqual(cleared["candidates"], []); self.assertIsNone(cleared["manual"])
            self.assertEqual(state.project_history_status(image_id), {"canUndo": True, "canRedo": False})
        self.assertEqual(state.workspace_store.export_state(ids[2]), untouched_before)
        self.assertTrue(all(path.is_file() for path in paths), "project-data clearing never removes any original source file")

    def test_every_unnamed_workspace_edit_undoes_and_redoes_one_step_without_touching_other_images(self) -> None:
        source = self.root / "unnamed-history-all"; self.image(source, "target.png"); self.image(source, "other.png")
        state = self.state(); ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}
        target, other = ids["target.png"], ids["other.png"]
        self.commit_candidates(state, target, [self.candidate(state, target, "target-candidate")])
        self.commit_candidates(state, other, [self.candidate(state, other, "other-candidate")])

        def semantic_export(image_id: str) -> dict:
            exported = state.workspace_store.export_state(image_id)
            for candidate in exported["candidates"]:
                raw = base64.b64decode(candidate["mask"].split(",", 1)[-1]); image = Image.open(io.BytesIO(raw)).convert("L")
                candidate["mask"] = (image.size, image.tobytes())
            if exported["manual"]:
                for key in ("add", "exclusion", "erase"):
                    value = exported["manual"].get(key)
                    if not value: continue
                    raw = base64.b64decode(value.split(",", 1)[-1]); image = Image.open(io.BytesIO(raw)).convert("L")
                    exported["manual"][key] = (image.size, image.tobytes())
            return exported

        def assert_round_trip(change) -> None:
            before = semantic_export(target); other_before = semantic_export(other)
            change(); after = semantic_export(target)
            self.assertNotEqual(after, before)
            state.restore_project_history(target, "undo"); self.assertEqual(semantic_export(target), before)
            self.assertEqual(semantic_export(other), other_before)
            state.restore_project_history(target, "redo"); self.assertEqual(semantic_export(target), after)
            self.assertEqual(semantic_export(other), other_before)

        assert_round_trip(lambda: state.set_candidate_state(target, "target-candidate", {"enabled": False}))
        assert_round_trip(lambda: state.set_candidate_state(target, "target-candidate", {"expandPx": 7}))
        assert_round_trip(lambda: state.set_image_transform(target, {"flipH": True, "flipV": False}))
        state.set_image_transform(target, {"flipH": False, "flipV": False})
        assert_round_trip(lambda: state.set_image_flags(target, {"reviewed": True}))
        assert_round_trip(lambda: state.set_image_flags(target, {"hidden": True}))
        state.set_image_flags(target, {"hidden": False})
        rgba = Image.new("RGBA", (8, 8), (255, 255, 255, 255))
        encoded = io.BytesIO(); rgba.save(encoded, format="PNG")
        manual = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
        state.save_manual_workspace(target, {
            "add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(target), "hasEffectiveMask": True, "dirtyLayers": ["add"],
        })
        assert_round_trip(lambda: state.delete_candidate(target, "target-candidate"))
        assert_round_trip(lambda: state.clear_masks([target]))

    def test_source_mismatch_acceptance_preserves_both_review_choices_across_restart(self) -> None:
        for reviewed in (False, True):
            for mode, size, clear in (("keep", (8, 8), False), ("resize", (12, 6), False), ("clear", (10, 7), True)):
                with self.subTest(reviewed=reviewed, mode=mode):
                    source = self.root / f"review-{reviewed}-{mode}"
                    path = self.image(source, "source.png")
                    state = self.state(); project = state.create_project(f"review {reviewed} {mode}")
                    image_id = state.set_root(str(source))[0]["id"]
                    self.commit_candidates(state, image_id, [self.candidate(state, image_id, "apply")])
                    state.set_image_flags(image_id, {"reviewed": reviewed})
                    Image.new("RGB", size, "black").save(path)
                    state.set_root(str(source))
                    self.assertEqual(state.images[image_id].reviewed, reviewed, "live source reconciliation")
                    self.assertEqual(state.workspace_store.image_state(image_id)[1], reviewed)
                    reopened = self.state(); reopened.open_project(project["id"])
                    self.assertTrue(reopened.source_mismatch_snapshot())
                    self.assertEqual(reopened.images[image_id].reviewed, reviewed, "changed source after restart")
                    reopened.resolve_source_mismatches([image_id], clear)
                    self.assertEqual(reopened.images[image_id].reviewed, reviewed, "accepted live record")
                    self.assertEqual(reopened.workspace_store.image_state(image_id)[1], reviewed, "accepted durable record")
                    accepted = self.state(); accepted.open_project(project["id"])
                    self.assertEqual(accepted.source_mismatch_snapshot(), [])
                    self.assertEqual(accepted.images[image_id].reviewed, reviewed, "accepted source after restart")
                    self.assertEqual(bool(accepted.candidates[image_id]), not clear)

    def test_source_mismatch_keep_resize_and_clear_have_exact_scoped_results(self) -> None:
        source = self.root / "mismatch-exact"; first_path = self.image(source, "first.png"); second_path = self.image(source, "second.png")
        state = self.state(); project = state.create_project("mismatch exact")
        ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}; first, second = ids["first.png"], ids["second.png"]
        for index, image_id in enumerate((first, second)):
            self.commit_candidates(state, image_id, [self.candidate(state, image_id, f"candidate-{index}")])
            state.save_manual_workspace(image_id, {
                "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(3, 3))).decode("ascii"),
                "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
                "candidateRevision": state._candidate_revision(image_id), "hasEffectiveMask": True,
            })
        before_project_update = state.workspace_store.project(project["id"])["updatedAt"]
        first_before = state.workspace_store.export_state(first)
        Image.new("RGB", (8, 8), "black").save(first_path)
        accepted_stat = first_path.stat()
        state.set_root(str(source)); state.resolve_source_mismatches([first], False)
        first_kept = state.workspace_store.export_state(first)
        self.assertEqual([item["id"] for item in first_kept["candidates"]], [item["id"] for item in first_before["candidates"]])
        self.assertIsNotNone(first_kept["manual"]); self.assertTrue(state.project_history_status(first)["canUndo"])
        self.assertGreaterEqual(state.workspace_store.project(project["id"])["updatedAt"], before_project_update)
        db = sqlite3.connect(state.workspace_store.path)
        try: accepted_size, accepted_mtime = db.execute("SELECT size_bytes,mtime_ns FROM images WHERE image_id=?", (first,)).fetchone()
        finally: db.close()
        self.assertEqual((accepted_size, accepted_mtime), (accepted_stat.st_size, accepted_stat.st_mtime_ns), "Keep accepts the exact current source timestamp and size as the new mismatch baseline")

        Image.new("RGB", (12, 6), "gray").save(first_path)
        state.set_root(str(source)); state.resolve_source_mismatches([first], False)
        resized = state.workspace_store.export_state(first)
        resized_mask = base64.b64decode(resized["candidates"][0]["mask"].split(",", 1)[-1])
        with Image.open(io.BytesIO(resized_mask)) as mask: self.assertEqual(mask.size, (12, 6))
        self.assertIsNotNone(resized["manual"]); self.assertEqual(state.project_history_status(first), {"canUndo": False, "canRedo": False})

        Image.new("RGB", (10, 7), "gray").save(second_path)
        state.set_root(str(source)); state.resolve_source_mismatches([second], True)
        cleared = state.workspace_store.export_state(second)
        self.assertEqual(cleared["candidates"], []); self.assertIsNone(cleared["manual"])
        self.assertEqual(state.project_history_status(second), {"canUndo": False, "canRedo": False})
        self.assertEqual([item["id"] for item in state.workspace_store.export_state(first)["candidates"]], ["candidate-0"], "clearing the changed target leaves the other image intact")

    def test_project_switch_close_restart_and_rename_restore_rich_state_without_cross_project_leakage(self) -> None:
        first_root = self.root / "project-a"; second_root = self.root / "project-b"
        self.image(first_root, "a.png"); self.image(second_root, "b.png")
        state = self.state(); project_a = state.create_project("Project A")
        image_a = state.set_root(str(first_root))[0]["id"]
        self.commit_candidates(state, image_a, [self.candidate(state, image_a, "a-candidate")])
        state.save_manual_workspace(image_a, {
            "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(2, 2))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(image_a), "hasEffectiveMask": True,
        })
        state.set_image_flags(image_a, {"reviewed": True, "hidden": True})
        project_b = state.create_project("Project B"); image_b = state.set_root(str(second_root))[0]["id"]
        project_ids = {item["id"] for item in state.projects()}
        self.assertEqual(project_ids, {project_a["id"], project_b["id"]}, "creating Project B adds one project without replacing Project A")
        self.assertEqual([item.candidate_id for item in state.workspace_store.hydrate_candidates(image_a, state.cache_dir, state._candidate_from_workspace)[1]], ["a-candidate"], "creating Project B leaves Project A edits durable")
        opened_a = state.open_project(project_a["id"])
        self.assertEqual({item["id"] for item in state.projects()}, project_ids, "opening an existing project never creates another project")
        self.assertEqual([item["id"] for item in opened_a["images"]], [image_a])
        restored_a = opened_a["images"][0]
        self.assertTrue(restored_a["reviewed"]); self.assertTrue(restored_a["hidden"])
        self.assertEqual([item.candidate_id for item in state.candidates[image_a]], ["a-candidate"])
        self.assertIsNotNone(state.manual_workspace(image_a)); self.assertTrue(state.project_history_status(image_a)["canUndo"])
        state.name_current_project("Renamed A")
        self.assertEqual(state.workspace_store.project(project_a["id"])["name"], "Renamed A")
        self.assertEqual([item["id"] for item in state.list_images()], [image_a])
        state.close_project()
        self.assertIsNone(state.catalog_id); self.assertEqual(state.list_images(), [])
        restarted = self.state(); reopened_a = restarted.open_project(project_a["id"])
        self.assertEqual(reopened_a["project"]["name"], "Renamed A")
        self.assertEqual([item["id"] for item in reopened_a["images"]], [image_a])
        self.assertEqual([item.candidate_id for item in restarted.candidates[image_a]], ["a-candidate"])
        self.assertIsNotNone(restarted.manual_workspace(image_a)); self.assertTrue(restarted.project_history_status(image_a)["canUndo"])
        reopened_b = restarted.open_project(project_b["id"])
        self.assertEqual([item["id"] for item in reopened_b["images"]], [image_b])
        self.assertNotIn(image_a, restarted.candidates, "Project A state never leaks into Project B")

    def test_normalized_duplicate_project_names_are_rejected_without_replacing_current_work(self) -> None:
        source = self.root / "duplicate-current"; self.image(source, "current.png")
        state = self.state(); current = state.create_project("Alpha Project")
        image_id = state.set_root(str(source))[0]["id"]
        before = state.catalog_snapshot()
        for duplicate in ("alpha project", "  Alpha Project  "):
            with self.assertRaises(ClientError) as rejected:
                state.create_project(duplicate)
            self.assertEqual(rejected.exception.error_code, "project_name_duplicate")
            self.assertEqual(state.catalog_id, current["id"])
            self.assertEqual([item["id"] for item in state.list_images()], [image_id])
            self.assertEqual(state.catalog_snapshot()["project"], before["project"])

    def test_project_completion_and_deletion_have_exact_persistent_outcomes(self) -> None:
        first_root = self.root / "delete-first"; second_root = self.root / "delete-second"
        first_source = self.image(first_root, "first.png"); second_source = self.image(second_root, "second.png")
        state = self.state(); first = state.create_project("First")
        first_id = state.set_root(str(first_root))[0]["id"]
        self.commit_candidates(state, first_id, [self.candidate(state, first_id, "first-candidate")])
        completed = state.complete_project()
        self.assertEqual(completed["status"], "completed"); self.assertIsNone(state.catalog_id); self.assertEqual(state.list_images(), [])
        self.assertEqual(state.workspace_store.project(first["id"])["status"], "completed")
        self.assertEqual([item["id"] for item in state.open_project(first["id"])["images"]], [first_id])
        self.assertTrue(state.project_read_only); self.assertEqual([item.candidate_id for item in state.candidates[first_id]], ["first-candidate"])

        state.resume_project(first["id"]); self.assertFalse(state.project_read_only)
        second = state.create_project("Second"); second_id = state.set_root(str(second_root))[0]["id"]
        state.delete_project(first["id"])
        self.assertIsNone(state.workspace_store.project(first["id"])); self.assertIsNotNone(state.workspace_store.project(second["id"])); self.assertEqual(state.catalog_id, second["id"])
        self.assertEqual([item["id"] for item in state.list_images()], [second_id]); self.assertTrue(first_source.exists()); self.assertTrue(second_source.exists())
        state.delete_project(second["id"])
        self.assertIsNone(state.workspace_store.project(second["id"])); self.assertIsNone(state.catalog_id); self.assertEqual(state.list_images(), [])
        self.assertTrue(second_source.exists())

    def test_project_open_refetches_usable_images_sources_and_only_missing_native_folders(self) -> None:
        available_root = self.root / "available-source"; missing_root = self.root / "missing-source"
        self.image(available_root, "available.png"); self.image(missing_root, "missing.png")
        state = self.state(); project = state.create_project("mixed sources")
        available_id = state.set_root(str(available_root))[0]["id"]
        missing_path = missing_root / "missing.png"; missing_stat = missing_path.stat()
        missing_source_id = state.workspace_store.ensure_project_source(
            project["id"], kind="native-folder", display_name=missing_root.name, identity=str(missing_root.resolve()),
        )
        missing_record = state.workspace_store.reconcile_images(project["id"], [SimpleNamespace(
            relative_path="missing.png", size_bytes=missing_stat.st_size, mtime_ns=missing_stat.st_mtime_ns, width=8, height=8,
        )], missing_source_id)["missing.png"]
        missing_id = str(missing_record["image_id"])
        sources_before = state.workspace_store.project_sources(project["id"])
        shutil.rmtree(missing_root)
        reopened = self.state().open_project(project["id"])
        self.assertEqual([item["id"] for item in reopened["images"]], [available_id], "usable source images remain visible")
        self.assertNotIn(missing_id, [item["id"] for item in reopened["images"]])
        self.assertTrue(reopened["needsSource"], reopened)
        sources = {item["id"]: item for item in reopened["sources"]}
        self.assertEqual(set(sources), {item["id"] for item in sources_before}, "the authoritative source list is refetched in full")
        self.assertEqual([item["displayName"] for item in sources.values() if not item["exists"]], [missing_root.name], "only the unavailable native folder is reported missing")
        self.assertEqual(reopened["project"]["id"], project["id"])

    def test_unnamed_restart_and_promotion_preserve_full_identity_state_and_history(self) -> None:
        source = self.root / "unnamed-rich"; self.image(source, "image.png")
        state = self.state(); image_id = state.set_root(str(source))[0]["id"]; workspace_id = state.workspace_id
        self.commit_candidates(state, image_id, [self.candidate(state, image_id, "candidate")])
        state.save_manual_workspace(image_id, {
            "add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(4, 4))).decode("ascii"),
            "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(image_id), "hasEffectiveMask": True,
        })
        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        state.set_image_flags(image_id, {"reviewed": True, "hidden": True})
        before_history = state.project_history_status(image_id)
        self.assertTrue(before_history["canUndo"]); self.assertEqual(state.projects(), [], "unnamed workspace is not listed as a project")
        state.shutdown(); self.states.remove(state)

        reopened = self.state(); self.assertEqual(reopened.workspace_id, workspace_id)
        images = reopened.set_root(str(source)); self.assertEqual(images[0]["id"], image_id)
        restored = images[0]
        self.assertTrue(restored["reviewed"]); self.assertTrue(restored["hidden"]); self.assertTrue(restored["flipH"]); self.assertFalse(restored["flipV"])
        self.assertEqual([item.candidate_id for item in reopened.candidates[image_id]], ["candidate"]); self.assertIsNotNone(reopened.manual_workspace(image_id))
        self.assertEqual(reopened.project_history_status(image_id), before_history); self.assertEqual(reopened.projects(), [])
        live_before = reopened.catalog_snapshot(); promoted = reopened.save_current_as_project("Promoted", str(workspace_id))
        self.assertEqual(promoted["id"], workspace_id); self.assertEqual(reopened.catalog_snapshot()["images"], live_before["images"])
        self.assertEqual(reopened.project_history_status(image_id), before_history)
        undone = reopened.restore_project_history(image_id, "undo"); self.assertTrue(undone["canRedo"])
        redone = reopened.restore_project_history(image_id, "redo"); self.assertTrue(redone["canUndo"])

    def test_unnamed_workspace_switch_publishes_atomically_and_rolls_back_failed_replacement(self) -> None:
        first_root = self.root / "unnamed-a"; second_root = self.root / "unnamed-b"; broken_root = self.root / "unnamed-broken"
        self.image(first_root, "a.png"); self.image(second_root, "b.png"); broken_root.mkdir(); (broken_root / "broken.png").write_bytes(b"broken")
        state = self.state(); first_id = state.set_root(str(first_root))[0]["id"]; first_workspace = state.workspace_id
        self.commit_candidates(state, first_id, [self.candidate(state, first_id, "a-candidate")])
        state.save_manual_workspace(first_id, {"add": "data:image/png;base64," + base64.b64encode(self.png(pixel=(2, 2))).decode("ascii"), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": state._candidate_revision(first_id), "hasEffectiveMask": True})
        before = state.catalog_snapshot(); before_history = state.project_history_status(first_id)
        with self.assertRaises(ClientError): state.set_root(str(broken_root))
        self.assertEqual(state.workspace_id, first_workspace); self.assertEqual(state.catalog_snapshot(), before); self.assertEqual(state.project_history_status(first_id), before_history)
        self.assertEqual(state.workspace_store.active_projectless_catalog(), first_workspace)

        with patch.object(state.workspace_store, "activate_projectless_catalog", side_effect=sqlite3.OperationalError("publish failed")):
            with self.assertRaises(sqlite3.OperationalError): state.set_root(str(second_root))
        self.assertEqual(state.workspace_id, first_workspace); self.assertEqual(state.catalog_snapshot(), before)
        self.assertEqual([item.candidate_id for item in state.candidates[first_id]], ["a-candidate"]); self.assertEqual(state.project_history_status(first_id), before_history)
        self.assertEqual(state.workspace_store.active_projectless_catalog(), first_workspace)
        self.assertEqual(len(state.workspace_store.projects()), 0, "failed unnamed publication leaves no user-visible or orphan named project")
        switched = state.set_root(str(second_root)); second_workspace = state.workspace_id
        self.assertNotEqual(second_workspace, first_workspace); self.assertEqual([item["relativePath"] for item in switched], ["b.png"])
        self.assertEqual(state.workspace_store.active_projectless_catalog(), second_workspace)
        self.assertIsNone(state.workspace_store.project(first_workspace or ""), "successful publication discards the previous unnamed workspace")
        restarted = self.state(); self.assertEqual(restarted.workspace_id, second_workspace)
        self.assertEqual([item["relativePath"] for item in restarted.set_root(str(second_root))], ["b.png"])

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
                {"id": "unforced", "mask": self.png(pixel=(7, 7)), "enabled": True, "role": "exclude", "forced": False, "expandPx": 0},
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
        self.assertEqual(list(state.iter_project_mask_exports("bad", "mosaic")), [])
        with self.assertRaises(ClientError):
            list(state.iter_project_mask_exports(str(state.catalog_id), "bad"))
