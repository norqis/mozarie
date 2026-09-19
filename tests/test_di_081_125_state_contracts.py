"""Focused durable-state contracts retired from data-integrity manual checks."""

from __future__ import annotations

import base64
import io
import shutil
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.state import StudioState
from mozarie.core import Candidate, ClientError


class DataIntegrityStateContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in reversed(self.states):
            state.shutdown()
        self.temporary.cleanup()

    def state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / "cache", self.root / "sessions")
        self.states.append(state)
        return state

    @staticmethod
    def mask_data_uri(size: tuple[int, int] = (8, 8), box: tuple[int, int, int, int] = (1, 1, 4, 4)) -> str:
        mask = Image.new("L", size, 0)
        for y in range(box[1], box[3]):
            for x in range(box[0], box[2]):
                mask.putpixel((x, y), 255)
        output = io.BytesIO()
        mask.save(output, format="PNG")
        return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")

    @staticmethod
    def render_bytes(rendered: object) -> bytes:
        output = getattr(rendered, "output")
        if output is not None:
            return output
        response_path = getattr(rendered, "response_path")
        assert response_path is not None
        return response_path.read_bytes()

    def test_clear_masks_is_atomic_per_target_and_undo_redo_restores_flags_and_ranges(self) -> None:
        source = self.root / "images"
        source.mkdir()
        for name in "ABCDEFGH":
            Image.new("RGB", (8, 8), "white").save(source / f"{name}.png")
        originals = {path.name: path.read_bytes() for path in source.glob("*.png")}
        state = self.state()
        project = state.create_project("clear matrix")
        ids = {item["relativePath"].removesuffix(".png"): item["id"] for item in state.set_root(str(source))}
        mask = self.mask_data_uri()
        for name in ("A", "B", "E", "F"):
            state.save_manual_workspace(ids[name], {
                "add": mask, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
                "manualEnabled": True, "manualExclusionEnabled": True,
                "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
            })
        for name in ("A", "C", "E", "G"):
            state.set_image_flags(ids[name], {"reviewed": True})
        for name in ("E", "F", "G", "H"):
            state.set_image_flags(ids[name], {"hidden": True})

        self.assertEqual(state.clear_masks([ids["A"]]), 1)
        listed = {Path(item["relativePath"]).stem: item for item in state.list_images()}
        self.assertIsNone(state.manual_workspace(ids["A"]))
        self.assertFalse(listed["A"]["reviewed"])
        self.assertIsNotNone(state.manual_workspace(ids["B"]))
        self.assertTrue(listed["C"]["reviewed"])
        self.assertTrue(listed["E"]["hidden"])

        self.assertEqual(state.restore_project_history(ids["A"], "undo")["changedImageIds"], [ids["A"]])
        self.assertIsNotNone(state.manual_workspace(ids["A"]))
        self.assertTrue(next(item for item in state.list_images() if item["id"] == ids["A"])["reviewed"])
        self.assertEqual(state.restore_project_history(ids["A"], "redo")["changedImageIds"], [ids["A"]])
        self.assertIsNone(state.manual_workspace(ids["A"]))
        self.assertFalse(next(item for item in state.list_images() if item["id"] == ids["A"])["reviewed"])

        state.clear_masks([ids[name] for name in ("A", "B", "C", "D")])
        reopened = self.state()
        reopened.open_project(project["id"])
        reopened_list = {Path(item["relativePath"]).stem: item for item in reopened.list_images()}
        for name in ("A", "B", "C", "D"):
            self.assertIsNone(reopened.manual_workspace(ids[name]))
            self.assertFalse(reopened_list[name]["reviewed"])
        for name in ("E", "F"):
            self.assertIsNotNone(reopened.manual_workspace(ids[name]))
        self.assertTrue(reopened_list["E"]["reviewed"])
        self.assertFalse(reopened_list["F"]["reviewed"])
        self.assertTrue(reopened_list["G"]["reviewed"])
        for name in ("E", "F", "G", "H"):
            self.assertTrue(reopened_list[name]["hidden"])
        self.assertEqual({path.name: path.read_bytes() for path in source.glob("*.png")}, originals)

    def test_projectless_single_and_batch_render_use_their_captured_flip_and_manual_mask(self) -> None:
        source = self.root / "unnamed"
        source.mkdir()
        image = Image.new("RGB", (8, 4), "black")
        colors = ((255, 0, 0), (0, 128, 0), (0, 0, 255), (255, 255, 0),
                  (0, 255, 255), (255, 0, 255), (255, 255, 255), (128, 128, 128))
        for x, color in enumerate(colors):
            for y in range(4):
                image.putpixel((x, y), color)
        image.save(source / "source.png")
        state = self.state()
        image_id = state.set_root(str(source))[0]["id"]
        state.save_manual_workspace(image_id, {
            "add": self.mask_data_uri((8, 4), (0, 0, 4, 4)), "exclusion": "", "exclusionErase": "",
            "removedCandidateIds": [], "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
        })
        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        self.assertEqual(state.restore_project_history(image_id, "undo")["changedImageIds"], [image_id])
        self.assertFalse(state.image_for_id(image_id).flip_horizontal)
        revision = state._candidate_revision(image_id)
        undo_token = "00000000-0000-4000-8000-000000000811"
        state.reserve_browser_save(image_id, revision, undo_token, copy_to_default=False,
                                   suffix="_censored", output_format="original", keep_metadata=True)
        undo_render = state.render_browser_save(image_id, revision, 2, None, client_save_token=undo_token)
        with Image.open(io.BytesIO(self.render_bytes(undo_render))) as saved:
            self.assertNotEqual(saved.convert("RGB").getpixel((0, 0)), image.getpixel((0, 0)))
            self.assertEqual(saved.convert("RGB").getpixel((7, 0)), image.getpixel((7, 0)))
        state.cancel_browser_save(image_id, undo_render.candidate_revision, undo_render.save_token)
        self.assertIsNone(state.catalog_id)

    def test_projectless_undo_state_single_overwrite_commits_before_reapplying_edits(self) -> None:
        source = self.root / "undo-single"; source.mkdir()
        image = Image.new("RGB", (8, 4), "black")
        for x in range(8):
            for y in range(4): image.putpixel((x, y), (20 + x * 20, y * 20, 40))
        path = source / "source.png"; image.save(path)
        state = self.state(); image_id = state.set_root(str(source))[0]["id"]
        state.save_manual_workspace(image_id, {
            "add": self.mask_data_uri((8, 4), (0, 0, 4, 4)), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        self.assertEqual(state.restore_project_history(image_id, "undo")["changedImageIds"], [image_id])
        self.assertFalse(state.image_for_id(image_id).flip_horizontal)
        revision = state._candidate_revision(image_id); token = "00000000-0000-4000-8000-000000000899"
        state.reserve_browser_save(image_id, revision, token, copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
        rendered = state.render_browser_save(image_id, revision, 2, None, client_save_token=token)
        output = self.render_bytes(rendered)
        committed = state.commit_browser_save(image_id, rendered.candidate_revision, rendered.save_token, "overwrite")
        self.assertTrue(committed["cleared"]); self.assertEqual(path.read_bytes(), output)
        with Image.open(io.BytesIO(output)) as saved:
            pixels = saved.convert("RGB")
            self.assertNotEqual(pixels.getpixel((0, 0)), image.getpixel((0, 0)), "undo-state manual mask is burned in")
            self.assertEqual(pixels.getpixel((7, 0)), image.getpixel((7, 0)), "undone horizontal flip is not reapplied")
        self.assertIsNone(state.catalog_id, "single overwrite remains unnamed and does not create a project")

        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        entry = state.prepare_browser_save([image_id], 2, "_censored", False)[0]
        single_token = "00000000-0000-4000-8000-000000000812"
        state.reserve_browser_save(image_id, entry["candidateRevision"], single_token, copy_to_default=False,
                                   suffix="_censored", output_format="original", keep_metadata=True)
        single = state.render_browser_save(image_id, entry["candidateRevision"], 2, None, client_save_token=single_token)
        single_bytes = self.render_bytes(single)
        state.cancel_browser_save(image_id, single.candidate_revision, single.save_token)
        batch_token = "00000000-0000-4000-8000-000000000813"
        state.reserve_browser_save(image_id, entry["candidateRevision"], batch_token, copy_to_default=False,
                                   suffix="_censored", output_format="original", keep_metadata=True)
        batch = state.render_browser_save(image_id, entry["candidateRevision"], 2, None, client_save_token=batch_token)
        batch_bytes = self.render_bytes(batch)
        self.assertEqual(single_bytes, batch_bytes)
        with Image.open(io.BytesIO(single_bytes)) as saved:
            pixels = saved.convert("RGB")
            self.assertEqual(pixels.getpixel((0, 0)), image.getpixel((7, 0)))
            self.assertNotEqual(pixels.getpixel((7, 0)), image.getpixel((0, 0)))
        committed = state.commit_browser_save(image_id, batch.candidate_revision, batch.save_token, "overwrite")
        self.assertTrue(committed["cleared"])
        self.assertEqual((source / "source.png").read_bytes(), batch_bytes)
        self.assertIsNone(state.catalog_id)

    def test_projectless_non_undo_single_and_batch_overwrites_commit_captured_edits(self) -> None:
        source = self.root / "unnamed-batch"
        source.mkdir()
        left = Image.new("RGB", (8, 4), "black")
        right = Image.new("RGB", (8, 4), "black")
        for x in range(8):
            for y in range(4):
                left.putpixel((x, y), (20 + x * 20, 0, 0))
                right.putpixel((x, y), (0, 20 + x * 20, 0))
        left.save(source / "A.png"); right.save(source / "B.png"); left.save(source / "C.png")
        state = self.state()
        ids = {Path(item["relativePath"]).stem: item["id"] for item in state.set_root(str(source))}
        state.save_manual_workspace(ids["A"], {
            "add": self.mask_data_uri((8, 4), (0, 0, 2, 4)), "exclusion": "", "exclusionErase": "",
            "removedCandidateIds": [], "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
        })
        state.save_manual_workspace(ids["B"], {
            "add": self.mask_data_uri((8, 4), (6, 0, 8, 4)), "exclusion": "", "exclusionErase": "",
            "removedCandidateIds": [], "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
        })
        state.set_image_transform(ids["A"], {"flipH": True, "flipV": False})
        state.set_image_transform(ids["B"], {"flipH": False, "flipV": True})
        state.save_manual_workspace(ids["C"], {
            "add": self.mask_data_uri((8, 4), (0, 0, 2, 4)), "exclusion": "", "exclusionErase": "",
            "removedCandidateIds": [], "manualEnabled": True, "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True, "manualExclusionForced": True,
        })
        state.set_image_transform(ids["C"], {"flipH": True, "flipV": False})
        single_entry = state.prepare_browser_save([ids["C"]], 2, "", False)[0]
        single_token = "00000000-0000-4000-8000-000000000099"
        state.reserve_browser_save(ids["C"], single_entry["candidateRevision"], single_token, copy_to_default=False,
                                   suffix="", output_format="original", keep_metadata=True)
        single_rendered = state.render_browser_save(ids["C"], single_entry["candidateRevision"], 2, None,
                                                    client_save_token=single_token)
        single_bytes = self.render_bytes(single_rendered)
        self.assertTrue(state.commit_browser_save(ids["C"], single_rendered.candidate_revision,
                                                  single_rendered.save_token, "overwrite")["cleared"])
        self.assertEqual((source / "C.png").read_bytes(), single_bytes,
                         "the ordinary single overwrite commits its captured flip and mask")
        entries = state.prepare_browser_save([ids["A"], ids["B"]], 2, "_censored", False)
        outputs: dict[str, bytes] = {}
        for index, entry in enumerate(entries):
            token = f"00000000-0000-4000-8000-{index + 100:012d}"
            state.reserve_browser_save(entry["imageId"], entry["candidateRevision"], token, copy_to_default=False,
                                       suffix="_censored", output_format="original", keep_metadata=True)
        rendered_entries = []
        for index, entry in enumerate(entries):
            token = f"00000000-0000-4000-8000-{index + 100:012d}"
            rendered = state.render_browser_save(entry["imageId"], entry["candidateRevision"], 2, None,
                                                 client_save_token=token)
            outputs[Path(entry["relativePath"]).stem] = self.render_bytes(rendered)
            rendered_entries.append((entry, rendered))
        with Image.open(io.BytesIO(outputs["A"])) as saved_a, Image.open(io.BytesIO(outputs["B"])) as saved_b:
            pixels_a = saved_a.convert("RGB"); pixels_b = saved_b.convert("RGB")
            self.assertEqual(pixels_a.getpixel((0, 0)), left.getpixel((7, 0)))
            self.assertNotEqual(pixels_a.getpixel((7, 0)), left.getpixel((0, 0)))
            self.assertEqual(pixels_b.getpixel((0, 0)), right.getpixel((0, 3)))
            self.assertNotEqual(pixels_b.getpixel((7, 3)), right.getpixel((7, 0)))
        for entry, rendered in rendered_entries:
            committed = state.commit_browser_save(entry["imageId"], rendered.candidate_revision, rendered.save_token, "overwrite")
            self.assertTrue(committed["cleared"], entry["relativePath"])
        self.assertEqual((source / "A.png").read_bytes(), outputs["A"])
        self.assertEqual((source / "B.png").read_bytes(), outputs["B"])
        self.assertIsNone(state.catalog_id)

    def test_export_reader_does_not_pin_live_workspace_wal_and_startup_removes_stale_export(self) -> None:
        source = self.root / "wal-export"
        source.mkdir()
        for index in range(12):
            Image.new("RGB", (8, 8), (index, index, index)).save(source / f"{index:02}.png")
        stale = self.app_dir / "data" / "mozarie-export-stale"
        stale.mkdir(parents=True)
        (stale / "project.sqlite3").write_bytes(b"partial export")
        state = self.state()
        self.assertFalse(stale.exists(), "startup removes an abandoned export snapshot before normal project access")
        project = state.create_project("wal")
        ids = [item["id"] for item in state.set_root(str(source))]
        for image_id in ids:
            state.save_manual_workspace(image_id, {
                "add": self.mask_data_uri(), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
                "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
            })
        iterator = state.iter_project_mask_exports(project["id"], "mosaic")
        next(iterator)
        live_db = state.workspace_store.path
        wal_path = Path(f"{live_db}-wal")
        sizes = []
        for round_index in range(3):
            for offset, image_id in enumerate(ids):
                state.set_image_flags(image_id, {"reviewed": bool((round_index + offset) % 2)})
            db = sqlite3.connect(live_db)
            try:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            finally:
                db.close()
            sizes.append(wal_path.stat().st_size if wal_path.exists() else 0)
        self.assertLessEqual(max(sizes), 4096, f"the independent export snapshot must not pin the live WAL: {sizes}")
        list(iterator)
        self.assertEqual(list(live_db.parent.glob("mozarie-export-*")), [])

    def test_import_sessions_keep_parallel_owner_generation_and_release_only_their_own_state(self) -> None:
        state = self.state()
        retained_path = self.root / "retained.png"; Image.new("RGB", (8, 8), "purple").save(retained_path)
        retained_id = state.set_root(str(self.root))[0]["id"]
        retained_images = [(item["id"], item["relativePath"]) for item in state.list_images()]
        first = "00000000-0000-4000-8000-000000000113"
        second = "00000000-0000-4000-8000-000000000114"
        third = "00000000-0000-4000-8000-000000000115"
        replacement = "00000000-0000-4000-8000-000000000116"
        owner = state.catalog_id
        generation = state.catalog_generation
        state.start_import_session(first, owner, generation)
        state.begin_import_transfer(first, owner, generation)
        state.begin_import_transfer(first, owner, generation)
        state.catalog_generation += 1
        state.end_import_transfer(first, succeeded=True)
        self.assertEqual(state.active_import_count, 1)
        state.begin_import_transfer(first, owner, generation)
        state.end_import_transfer(first, succeeded=False)
        state.end_import_transfer(first, succeeded=True)
        self.assertEqual(state.active_import_count, 0)
        self.assertEqual(state._import_sessions[first]["last_generation"], state.catalog_generation)
        state.catalog_generation += 1
        with self.assertRaises(ClientError) as stale:
            state.begin_import_transfer(first, owner, generation)
        self.assertEqual(stale.exception.error_code, "stale_catalog")

        state.finish_import_session(first, owner, generation, {"cancelled": True})
        self.assertNotIn(first, state._import_sessions)
        state.start_import_session(second, owner, state.catalog_generation)
        state.begin_import_transfer(second, owner, state.catalog_generation)
        pending = state.finish_import_session(second, owner, state.catalog_generation, {"cancelled": True})
        self.assertTrue(pending["pending"])
        self.assertIn(second, state._import_sessions)
        state.end_import_transfer(second, succeeded=False)
        self.assertNotIn(second, state._import_sessions)
        self.assertEqual(state.active_import_count, 0)
        state.start_import_session(replacement, owner, state.catalog_generation)
        self.assertNotIn(second, state._import_sessions)
        self.assertIn(replacement, state._import_sessions, "a failed inactive session is replaced by the next explicit start_import_session")
        self.assertEqual([(item["id"], item["relativePath"]) for item in state.list_images()], retained_images,
                         "replacing a failed or cancelled inactive session preserves its already published images")
        self.assertTrue(state.finish_import_session(replacement, owner, state.catalog_generation, {"cancelled": True})["ok"])
        self.assertNotIn(replacement, state._import_sessions)

        state.start_import_session(third, owner, state.catalog_generation)
        before_catalog = state.catalog_snapshot()
        self.assertTrue(state.finish_import_session(third, owner, state.catalog_generation)["ok"])
        self.assertTrue(state.finish_import_session(third, owner, state.catalog_generation)["ok"])
        unknown = "00000000-0000-4000-8000-000000000999"
        self.assertTrue(state.finish_import_session(unknown, owner, state.catalog_generation)["ok"])
        self.assertEqual(state.catalog_snapshot(), before_catalog)
        state.start_import_session(third, owner, state.catalog_generation)
        before_wrong_owner = state.catalog_snapshot()
        with self.assertRaises(ClientError) as wrong_owner:
            state.finish_import_session(third, "another-project", state.catalog_generation)
        self.assertEqual(wrong_owner.exception.error_code, "stale_catalog")
        self.assertIn(third, state._import_sessions)
        self.assertEqual(state.catalog_snapshot(), before_wrong_owner,
                         "an unknown owner neither releases the live session nor changes its project/list")

    def test_same_import_session_publishes_parallel_images_and_other_sessions_cannot_mutate_it(self) -> None:
        state = self.state(); session = "00000000-0000-4000-8000-000000000213"; other = "00000000-0000-4000-8000-000000000214"
        owner = state.catalog_id; generation = state.catalog_generation
        state.start_import_session(session, owner, generation)
        for _ in range(2): state.begin_import_transfer(session, owner, generation)
        staged = []
        for index in range(2):
            path = self.root / f"parallel-{index}.png"; Image.new("RGB", (8, 8), (index * 80, 20, 30)).save(path); staged.append(path)
        results = []; errors = []
        def add(index):
            try:
                added, failures = state._import_images([{"stagedPath": staged[index], "name": f"image-{index}.png", "relativePath": f"image-{index}.png", "clientKey": f"client-{index}"}],
                    transfer_active=True, import_session_id=session, import_project_id=owner, import_catalog_generation=generation, intent="add")
                results.append((added, failures, state.catalog_generation)); state.end_import_transfer(session, succeeded=True)
            except BaseException as error: errors.append(error); state.end_import_transfer(session, succeeded=False)
        threads = [threading.Thread(target=add, args=(index,)) for index in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(5)
        self.assertEqual(errors, []); self.assertEqual(len(results), 2); self.assertEqual(state.active_import_count, 0)
        self.assertEqual({item["relativePath"] for item in state.list_images()}, {"image-0.png", "image-1.png"})
        published_generations = sorted(result[2] for result in results)
        self.assertEqual(published_generations, [generation + 1, generation + 2], "each same-session publish advances the generation")
        preserved = [(item["id"], item["relativePath"]) for item in state.list_images()]
        # The same session remains authoritative across its own generation advances.
        state.begin_import_transfer(session, owner, generation)
        state.end_import_transfer(session, succeeded=False)
        self.assertEqual([(item["id"], item["relativePath"]) for item in state.list_images()], preserved)
        target = state.create_project("switch-target"); target_snapshot = state.catalog_snapshot()
        self.assertTrue(state.finish_import_session(session, owner, generation, {"cancelled": False})["ok"])
        self.assertEqual(state.catalog_id, target["id"]); self.assertEqual(state.catalog_snapshot(), target_snapshot,
                         "a matching transfer owner/session releases safely after the visible project switched")
        target_generation = state.catalog_generation
        state.start_import_session(other, target["id"], target_generation)
        with self.assertRaises(ClientError) as old_session_add:
            state.begin_import_transfer(session, owner, generation)
        self.assertEqual(old_session_add.exception.error_code, "operation_in_progress")
        with self.assertRaises(ClientError) as wrong_finish:
            state.finish_import_session(other, "wrong-project", target_generation)
        self.assertEqual(wrong_finish.exception.error_code, "stale_catalog")
        self.assertEqual(state.catalog_snapshot(), target_snapshot,
                         "old-tab and wrong-session operations cannot overwrite the destination project")
        state.finish_import_session(other, target["id"], target_generation, {"cancelled": True})

    def test_project_switch_serializes_flag_and_two_image_candidate_batches_without_cross_project_leaks(self) -> None:
        source_a = self.root / "project-a"; source_b = self.root / "project-b"
        source_a.mkdir(); source_b.mkdir()
        Image.new("RGB", (8, 8), "red").save(source_a / "A.png")
        Image.new("RGB", (8, 8), "green").save(source_a / "B.png")
        Image.new("RGB", (8, 8), "blue").save(source_b / "C.png")
        state = self.state()
        project_a = state.create_project("A")
        ids_a = {Path(item["relativePath"]).stem: item["id"] for item in state.set_root(str(source_a))}
        for name, image_id in ids_a.items():
            path = state.cache_dir / image_id / f"{name}.png"; path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (8, 8), 255).save(path)
            state._commit_candidate_snapshot(image_id, [Candidate(f"candidate-{name}", "penis", .9, path)], replace=True)
        project_b = state.create_project("B")
        id_b = state.set_root(str(source_b))[0]["id"]
        state.open_project(project_a["id"])

        batch_before = {image_id: (state.workspace_store.export_state(image_id), state.workspace_store.history_status(image_id)) for image_id in ids_a.values()}
        with patch.object(state.workspace_store, "commit_candidate_states", side_effect=sqlite3.OperationalError("batch failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "batch failed"):
                state.batch_update_candidates_many(list(ids_a.values()), {"role": "apply", "operation": "disable"})
        self.assertEqual({image_id: (state.workspace_store.export_state(image_id), state.workspace_store.history_status(image_id)) for image_id in ids_a.values()}, batch_before,
                         "a persistence failure leaves both A and B candidate states and histories unchanged")
        original_candidate_read = state.workspace_store.manual
        read_count = 0
        def fail_second_candidate_read(image_id, encoder):
            nonlocal read_count
            read_count += 1
            if read_count >= 2:
                raise sqlite3.OperationalError("candidate read failed")
            return original_candidate_read(image_id, encoder)
        with patch.object(state.workspace_store, "manual", side_effect=fail_second_candidate_read):
            with self.assertRaisesRegex(sqlite3.OperationalError, "candidate read failed"):
                state.batch_update_candidates_many(list(ids_a.values()), {"role": "apply", "operation": "disable"})
        self.assertEqual({image_id: (state.workspace_store.export_state(image_id), state.workspace_store.history_status(image_id)) for image_id in ids_a.values()}, batch_before,
                         "a candidate-read failure on B rolls back A and B candidates plus both histories")
        state.open_project(project_b["id"])
        self.assertEqual(state.workspace_store.export_state(id_b), b_before := state.workspace_store.export_state(id_b))
        state.open_project(project_a["id"])

        entered = threading.Event(); release = threading.Event(); flag_errors = []
        original_flags = state.workspace_store.set_image_flags
        def delayed_flags(*args, **kwargs):
            entered.set(); release.wait(5); return original_flags(*args, **kwargs)
        with patch.object(state.workspace_store, "set_image_flags", side_effect=delayed_flags):
            flag_thread = threading.Thread(target=lambda: self._capture_thread_error(flag_errors, state.set_image_flags, ids_a["A"], {"reviewed": True}))
            flag_thread.start(); self.assertTrue(entered.wait(5))
            switch_done = threading.Event()
            switch_thread = threading.Thread(target=lambda: (state.open_project(project_b["id"]), switch_done.set()))
            switch_thread.start()
            self.assertFalse(switch_done.wait(.1), "project switch waits while the A mutation owns the catalogue lock")
            release.set(); flag_thread.join(5); switch_thread.join(5)
        self.assertEqual(flag_errors, [])
        self.assertEqual(state.catalog_id, project_b["id"])
        self.assertFalse(next(item for item in state.list_images() if item["id"] == id_b)["reviewed"])
        state.open_project(project_a["id"])
        self.assertTrue(next(item for item in state.list_images() if item["id"] == ids_a["A"])["reviewed"])
        generation_a = state.catalog_generation

        entered.clear(); release.clear(); bulk_errors = []; bulk_result = {}; bulk_commit_generation = []
        original_bulk_flags = state.workspace_store.set_image_flags_bulk
        def delayed_bulk_flags(*args, **kwargs):
            entered.set(); release.wait(5); result = original_bulk_flags(*args, **kwargs)
            bulk_commit_generation.append(state.catalog_generation)
            return result
        def run_bulk_flags():
            try: bulk_result.update(state.set_image_flags_bulk({"imageIds": list(ids_a.values()), "reviewed": True, "hidden": True}))
            except BaseException as error: bulk_errors.append(error)
        with patch.object(state.workspace_store, "set_image_flags_bulk", side_effect=delayed_bulk_flags):
            bulk_thread = threading.Thread(target=run_bulk_flags); bulk_thread.start(); self.assertTrue(entered.wait(5))
            switch_done.clear(); switch_thread = threading.Thread(target=lambda: (state.open_project(project_b["id"]), switch_done.set()))
            switch_thread.start(); self.assertFalse(switch_done.wait(.1), "multi-image reviewed/hidden commit is atomic against switching")
            release.set(); bulk_thread.join(5); switch_thread.join(5)
        self.assertEqual(bulk_errors, []); self.assertEqual(set(bulk_result), set(ids_a.values()))
        self.assertNotIn(id_b, bulk_result, "the A response never contains destination-project B")
        self.assertEqual(bulk_commit_generation, [generation_a],
                         "the A response is committed under A's generation and never reports B's generation")
        self.assertFalse(next(item for item in state.list_images() if item["id"] == id_b)["reviewed"])
        state.open_project(project_a["id"])
        self.assertTrue(all(item["reviewed"] and item["hidden"] for item in state.list_images()))
        state.set_image_flags_bulk({"imageIds": list(ids_a.values()), "hidden": False})

        entered.clear(); release.clear(); batch_errors = []
        original_batch = state.workspace_store.commit_candidate_states
        def delayed_batch(*args, **kwargs):
            entered.set(); release.wait(5); return original_batch(*args, **kwargs)
        with patch.object(state.workspace_store, "commit_candidate_states", side_effect=delayed_batch):
            batch_thread = threading.Thread(target=lambda: self._capture_thread_error(
                batch_errors, state.batch_update_candidates_many, list(ids_a.values()), {"role": "apply", "operation": "disable"}))
            batch_thread.start(); self.assertTrue(entered.wait(5))
            switch_done.clear(); switch_thread = threading.Thread(target=lambda: (state.open_project(project_b["id"]), switch_done.set()))
            switch_thread.start(); self.assertFalse(switch_done.wait(.1), "switch cannot observe a half-published A/B batch")
            release.set(); batch_thread.join(5); switch_thread.join(5)
        self.assertEqual(batch_errors, [])
        self.assertEqual(state.catalog_id, project_b["id"])
        self.assertEqual(state.workspace_store.export_state(id_b), b_before,
                         "the destination project DB/history never receives one half of the A/B batch")
        state.open_project(project_a["id"])
        for image_id in ids_a.values():
            self.assertFalse(state.candidates[image_id][0].enabled)
            self.assertTrue(state.project_history_status(image_id)["canUndo"])

    def test_failed_target_project_open_preserves_its_own_review_flip_and_status(self) -> None:
        source_a = self.root / "open-A"; source_b = self.root / "open-B"; source_a.mkdir(); source_b.mkdir()
        Image.new("RGB", (8, 8), "red").save(source_a / "A.png")
        Image.new("RGB", (8, 8), "blue").save(source_b / "B.png")
        state = self.state(); project_a = state.create_project("A"); state.set_root(str(source_a))
        project_b = state.create_project("B"); image_b = state.set_root(str(source_b))[0]["id"]
        state.set_image_flags(image_b, {"reviewed": True, "hidden": False})
        state.set_image_transform(image_b, {"flipH": True, "flipV": True})
        state.complete_project()
        before_project = state.workspace_store.project(project_b["id"])
        before_image = state.workspace_store.export_state(image_b)
        state.open_project(project_a["id"])
        visible_before = state.catalog_snapshot()
        with patch.object(state, "_stage_workspace_candidates", side_effect=sqlite3.OperationalError("target open failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "target open failed"):
                state.open_project(project_b["id"])
        self.assertEqual(state.catalog_snapshot(), visible_before, "failed target open leaves the current project screen intact")
        self.assertEqual(state.workspace_store.project(project_b["id"]), before_project)
        self.assertEqual(state.workspace_store.export_state(image_b), before_image,
                         "the failed target's reviewed and flip state remains byte-for-byte unchanged")
        state.open_project(project_b["id"])
        reopened = state.image_for_id(image_b)
        self.assertEqual((reopened.reviewed, reopened.flip_horizontal, reopened.flip_vertical, state.project_read_only),
                         (True, True, True, True), "target review, both flips, and completed status survive the failure")

    @staticmethod
    def _capture_thread_error(errors: list[BaseException], operation, *args) -> None:
        try:
            operation(*args)
        except BaseException as error:
            errors.append(error)

    def test_project_export_uses_one_temp_sqlite_snapshot_streams_rows_and_always_cleans_it(self) -> None:
        first_source = self.root / "export-first"
        first_source.mkdir()
        Image.new("RGB", (8, 8), "white").save(first_source / "A.png")
        Image.new("RGB", (8, 8), "gray").save(first_source / "B.png")
        state = self.state()
        first_project = state.create_project("first")
        first_ids = {Path(item["relativePath"]).stem: item["id"] for item in state.set_root(str(first_source))}
        state.save_manual_workspace(first_ids["A"], {
            "add": self.mask_data_uri((8, 8), (1, 1, 2, 2)), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        state.save_manual_workspace(first_ids["B"], {
            "add": self.mask_data_uri((8, 8), (2, 2, 3, 3)), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        iterator = state.iter_project_mask_exports(first_project["id"], "mosaic")
        first_image, first_png = next(iterator)
        temp_parent = state.workspace_store.path.parent
        active_snapshots = list(temp_parent.glob("mozarie-export-*"))
        self.assertEqual(len(active_snapshots), 1)
        self.assertEqual(active_snapshots[0].parent, temp_parent)
        self.assertTrue((active_snapshots[0] / "project.sqlite3").is_file())

        second_source = self.root / "export-second"
        second_source.mkdir()
        Image.new("RGB", (8, 8), "blue").save(second_source / "C.png")
        second_project = state.create_project("second")
        second_id = state.set_root(str(second_source))[0]["id"]
        state.set_image_flags(second_id, {"reviewed": True})
        self.assertTrue(next(item for item in state.list_images() if item["id"] == second_id)["reviewed"],
                        "an edit in another project commits while the first project's export iterator remains open")

        state.open_project(first_project["id"])
        state.save_manual_workspace(first_ids["B"], {
            "add": self.mask_data_uri((8, 8), (6, 6, 7, 7)), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
        })
        remaining = list(iterator)
        exported = {Path(first_image["relativePath"]).stem: first_png,
                    **{Path(image["relativePath"]).stem: png for image, png in remaining}}
        with Image.open(io.BytesIO(exported["B"])) as old_b:
            old_b = old_b.convert("L")
            self.assertEqual((old_b.getpixel((2, 2)), old_b.getpixel((6, 6))), (255, 0),
                             "every row comes from the export-start snapshot")
        current_b = state.export_mask_png(first_ids["B"], "mosaic")
        with Image.open(io.BytesIO(current_b)) as new_b:
            new_b = new_b.convert("L")
            self.assertEqual((new_b.getpixel((2, 2)), new_b.getpixel((6, 6))), (0, 255),
                             "the project DB retains the later edit")
        self.assertEqual(list(temp_parent.glob("mozarie-export-*")), [])

        failing = state.iter_project_mask_exports(first_project["id"], "mosaic")
        with patch.object(state, "_export_workspace_mask_raw", side_effect=RuntimeError("compose failed")):
            with self.assertRaisesRegex(RuntimeError, "compose failed"):
                next(failing)
        failing.close()
        self.assertEqual(list(temp_parent.glob("mozarie-export-*")), [])
        state.open_project(second_project["id"])
        self.assertTrue(next(item for item in state.list_images() if item["id"] == second_id)["reviewed"])


if __name__ == "__main__":
    unittest.main()
