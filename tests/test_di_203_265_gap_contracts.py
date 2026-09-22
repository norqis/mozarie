"""Direct regression contracts for the remaining DI-203..265 observations.

These tests intentionally use real SQLite workspaces and real files.  They
assert the complete user-visible state at the failure/publication boundary;
they are not coverage-only probes of private branches.
"""

from __future__ import annotations

import base64
import ctypes
import io
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config

import mozarie.state as state_module
from mozarie.core import ClientError, Job
from mozarie.domain import Candidate, CandidateRole
from mozarie.state import StudioState


class RemainingDataIntegrityContracts(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        prepare_test_app_config(self.app_dir)
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
    def png(size: tuple[int, int] = (8, 8), *, mode: str = "L", pixel: tuple[int, int] = (1, 1)) -> bytes:
        color = 0 if mode in {"1", "L"} else (0, 0, 0, 0) if mode == "RGBA" else "black"
        image = Image.new(mode, size, color)
        image.putpixel(pixel, 255 if mode in {"1", "L"} else (255, 255, 255, 255))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def project_with_image(self, *, name: str = "source.png") -> tuple[StudioState, str, str, Path]:
        source = self.root / f"source-{len(self.states)}"
        source.mkdir()
        path = source / name
        Image.new("RGB", (8, 8), "white").save(path)
        state = self.state()
        project = state.create_project("contract")
        image_id = state.set_root(str(source))[0]["id"]
        return state, project["id"], image_id, path

    def add_candidate(
        self,
        state: StudioState,
        image_id: str,
        candidate_id: str,
        *,
        role: CandidateRole = CandidateRole.APPLY,
        pixel: tuple[int, int] = (1, 1),
    ) -> Candidate:
        path = state.cache_dir / image_id / f"{candidate_id}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.png(pixel=pixel))
        candidate = Candidate(
            candidate_id,
            "penis" if role == CandidateRole.APPLY else "hand",
            .9,
            path,
            role=role,
            source="auto",
        )
        current = [*state.candidates.get(image_id, []), candidate]
        with state.image_io_lock(image_id), state.lock:
            state._commit_candidate_snapshot(image_id, current, replace=True)
        return candidate

    def complete_state(self, state: StudioState, image_id: str) -> dict[str, object]:
        with state.workspace_store._connect() as db:
            history = db.execute(
                "SELECT entry_id,group_id,before_json,after_json,delta_json FROM history_entries WHERE image_id=? ORDER BY entry_id",
                (image_id,),
            ).fetchall()
        return {
            "catalog": state.catalog_snapshot(include_sources=True),
            "candidates": state.candidate_snapshot(image_id),
            "manual": state.manual_workspace(image_id),
            "transform": state.workspace_store.image_transform(image_id),
            "history": [tuple(row) for row in history],
            "mismatch": state.source_mismatch_snapshot(),
        }

    def durable_state(self, state: StudioState, image_id: str) -> dict[str, object]:
        record = state.images[image_id]
        return {
            "record": (record.image_id, record.relative_path, record.hidden, record.reviewed, record.flip_horizontal, record.flip_vertical),
            "workspace": state.workspace_store.export_state(image_id),
            "revision": state._candidate_revision(image_id),
        }

    def test_project_export_snapshot_ignores_later_hidden_change_and_next_export_excludes_it(self) -> None:
        """DI-205.2: one ZIP is a SQLite snapshot; the next sees new flags."""
        state, project_id, first_id, _path = self.project_with_image(name="a.png")
        second_path = _path.parent / "b.png"
        Image.new("RGB", (8, 8), "white").save(second_path)
        state.set_root(str(_path.parent))
        ids = {item["relativePath"]: item["id"] for item in state.list_images()}
        first_id, second_id = ids["a.png"], ids["b.png"]
        self.add_candidate(state, first_id, "first")
        self.add_candidate(state, second_id, "second")

        current_export = state.iter_project_mask_exports(project_id, "mosaic")
        first = next(current_export)
        state.set_image_flags(first_id, {"hidden": True})
        current_ids = {first[0]["id"], *(item[0]["id"] for item in current_export)}
        next_ids = {item[0]["id"] for item in state.iter_project_mask_exports(project_id, "mosaic")}

        self.assertEqual(current_ids, {first_id, second_id})
        self.assertEqual(next_ids, {second_id})

    def test_hidden_image_work_isolated_while_other_images_change_then_reshows_and_deletes_completely(self) -> None:
        """DI-203.2 across five real project images and SQLite cascades."""
        source = self.root / "hidden-isolation"
        source.mkdir()
        for name in ("a.png", "b.png", "c.png", "d.png", "e.png"):
            Image.new("RGB", (8, 8), "white").save(source / name)
        state = self.state()
        state.create_project("hidden isolation")
        ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source))}
        e_id = ids["e.png"]
        self.add_candidate(state, e_id, "e-candidate")
        raw = "data:image/png;base64," + base64.b64encode(self.png(pixel=(5, 5))).decode("ascii")
        state.save_manual_workspace(e_id, {
            "add": raw,
            "exclusion": "",
            "exclusionErase": "",
            "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(e_id),
            "hasEffectiveMask": True,
        })
        state.set_image_transform(e_id, {"flipH": True, "flipV": False})
        state.set_image_flags(e_id, {"hidden": True, "reviewed": True})
        e_before = self.durable_state(state, e_id)

        for name in ("a.png", "b.png", "c.png", "d.png"):
            state.set_image_flags(ids[name], {"reviewed": True})
            self.assertEqual(state.images[e_id].hidden, True)
        state.set_image_flags(e_id, {"hidden": False})
        e_after_show = self.durable_state(state, e_id)
        self.assertEqual(e_after_show["workspace"]["candidates"], e_before["workspace"]["candidates"])
        self.assertEqual(e_after_show["workspace"]["manual"], e_before["workspace"]["manual"])
        self.assertEqual(e_after_show["record"][3:], e_before["record"][3:])
        self.assertEqual([state.images[ids[name]].reviewed for name in ("a.png", "b.png", "c.png", "d.png")], [True] * 4)

        token = "00000000-0000-4000-8000-000000203200"
        state.prepare_source_delete({"imageIds": [e_id], "deleteToken": token})
        state.claim_source_delete(token)
        result = state.delete_images_with_sources({"imageIds": [e_id], "deleteToken": token})
        self.assertEqual(result["removedImageIds"], [e_id])
        self.assertFalse((source / "e.png").exists())
        self.assertNotIn(e_id, state.images)
        self.assertFalse(state.workspace_store.has_image(e_id))
        with state.workspace_store._connect() as db:
            for table in ("candidates", "manual_edits", "history_entries", "image_transforms"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (e_id,)).fetchone()[0], 0)

    def test_active_render_and_token_block_hide_but_unhide_and_completion_preserve_snapshot(self) -> None:
        """DI-208.1/.2: hide gates follow the stable rendered snapshot."""
        source_dir = self.root / "render-hide"
        source_dir.mkdir()
        Image.new("RGB", (8, 8), "blue").save(source_dir / "rendered.png")
        Image.new("RGB", (8, 8), "red").save(source_dir / "hidden.png")
        state = self.state()
        state.create_project("render hide")
        ids = {item["relativePath"]: item["id"] for item in state.set_root(str(source_dir))}
        image_id, hidden_id = ids["rendered.png"], ids["hidden.png"]
        candidate = self.add_candidate(state, image_id, "save")
        before = self.complete_state(state, image_id)
        state.set_image_flags(hidden_id, {"hidden": True})
        client_token = "00000000-0000-4000-8000-000000000208"
        state.reserve_browser_save(
            image_id,
            state._candidate_revision(image_id),
            client_token,
            copy_to_default=False,
            suffix="_censored",
            output_format="original",
            keep_metadata=True,
        )
        with self.assertRaises(ClientError) as rendering:
            state.set_image_flags(image_id, {"hidden": True})
        self.assertEqual(rendering.exception.error_code, "operation_in_progress")
        self.assertEqual(state.set_image_flags(hidden_id, {"hidden": False})["hidden"], False)
        rendered = state.render_browser_save(
            image_id,
            state._candidate_revision(image_id),
            100,
            None,
            client_save_token=client_token,
        )
        with self.assertRaises(ClientError) as raised:
            state.set_image_flags(image_id, {"hidden": True})
        self.assertEqual(raised.exception.error_code, "operation_in_progress")
        self.assertEqual(state.set_image_flags(image_id, {"hidden": False}), {"hidden": False, "reviewed": False})
        self.assertEqual(rendered.record.image_id, image_id)
        self.assertEqual(rendered.candidate_revision, before["candidates"]["candidateRevision"])
        self.assertTrue(candidate.mask_path.exists())
        with Image.open(rendered.response_path) as output:
            colors = set(output.convert("RGB").getdata())
        self.assertNotIn((255, 0, 0), colors, "the hidden red image is never mixed into the rendered blue image")

        committed = state.commit_browser_save(
            image_id,
            rendered.candidate_revision,
            rendered.save_token,
            "overwrite",
        )
        self.assertEqual(committed["sourceAction"], "overwrite")
        self.assertEqual(state.set_image_flags(image_id, {"hidden": True})["hidden"], True)

        state.set_image_flags(image_id, {"hidden": False})
        expiring = "00000000-0000-4000-8000-000000000209"
        state.reserve_browser_save(image_id, state._candidate_revision(image_id), expiring, copy_to_default=False,
                                   suffix="_censored", output_format="original", keep_metadata=True)
        state.cancel_browser_save(image_id, state._candidate_revision(image_id), expiring)
        self.assertNotIn(expiring, state.browser_save_tokens)
        self.assertEqual(state.set_image_flags(image_id, {"hidden": True})["hidden"], True)

    def test_job_snapshot_never_waits_for_writer_and_is_an_immutable_consistent_copy(self) -> None:
        """DI-215.1: polling returns the last single publication without waiting."""
        state = self.state()
        state.job = Job(kind="detect", state="running", total=3, completed=1, current="a.png", image_ids=("a", "b", "c"), completed_image_ids=("a",))
        with state.lock:
            expected = state._publish_job_snapshot_unchecked()
        acquired = threading.Event()
        release = threading.Event()

        def writer() -> None:
            with state.lock:
                acquired.set()
                release.wait(5)

        thread = threading.Thread(target=writer)
        thread.start()
        self.assertTrue(acquired.wait(5))
        started = time.perf_counter()
        actual = state.job_snapshot()
        elapsed = time.perf_counter() - started
        release.set()
        thread.join(5)
        self.assertLess(elapsed, .2)
        self.assertEqual(actual, expected)
        actual["imageIds"].clear()
        actual["completedImageIds"].clear()
        self.assertEqual(state.job_snapshot()["imageIds"], ["a", "b", "c"])
        self.assertEqual(state.job_snapshot()["completedImageIds"], ["a"])

    def test_bulk_hydration_preserves_candidates_flags_transform_and_source_mismatch_together(self) -> None:
        """DI-248.2: reopening publishes one complete bulk-hydrated project."""
        state, project_id, image_id, path = self.project_with_image()
        self.add_candidate(state, image_id, "kept")
        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        state.set_image_flags(image_id, {"hidden": True, "reviewed": True})
        Image.new("RGB", (10, 8), "black").save(path)
        with patch.object(
            state.workspace_store,
            "hydrate_candidates_bulk",
            wraps=state.workspace_store.hydrate_candidates_bulk,
        ) as hydrated:
            reopened = state.open_project(project_id)
        self.assertEqual(hydrated.call_count, 1)
        listed = reopened["images"][0]
        self.assertEqual((listed["hidden"], listed["reviewed"], listed["flipH"], listed["flipV"]), (True, True, True, False))
        self.assertEqual([item["id"] for item in state.candidate_snapshot(image_id)["candidates"]], ["kept"])
        self.assertEqual(state.source_mismatch_snapshot(), [{"id": image_id, "relativePath": "source.png", "dimensionsChanged": True}])

    def test_catalog_clear_removes_only_every_image_in_the_active_catalog_and_never_accepts_paths(self) -> None:
        """DI-243.1: the unit of deletion is the complete active catalog."""
        first = self.root / "catalog-a"; second = self.root / "catalog-b"
        first.mkdir(); second.mkdir()
        for name in ("one.png", "two.png"): Image.new("RGB", (8, 8), "white").save(first / name)
        Image.new("RGB", (8, 8), "black").save(second / "kept.png")
        state = self.state()
        project_a = state.create_project("A")["id"]
        a_ids = {item["id"] for item in state.set_root(str(first))}
        project_b = state.create_project("B")["id"]
        b_id = state.set_root(str(second))[0]["id"]
        state.open_project(project_a)
        self.assertEqual({item["id"] for item in state.list_images()}, a_ids)
        state.clear_catalog()
        self.assertEqual(state.list_images(), [])
        self.assertTrue(all(path.exists() for path in (first / "one.png", first / "two.png", second / "kept.png")))
        reopened = state.open_project(project_b)
        self.assertEqual([item["id"] for item in reopened["images"]], [b_id])

    def test_detection_cleanup_failure_preserves_catalog_candidate_manual_review_and_history(self) -> None:
        """DI-211.1/DI-250.2: unpublished detection cannot alter any work."""
        state, _project_id, image_id, source = self.project_with_image()
        old = self.add_candidate(state, image_id, "old")
        raw = "data:image/png;base64," + base64.b64encode(self.png(pixel=(2, 2))).decode("ascii")
        state.save_manual_workspace(image_id, {
            "add": raw,
            "exclusion": "",
            "exclusionErase": "",
            "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(image_id),
            "hasEffectiveMask": True,
        })
        state.set_image_flags(image_id, {"reviewed": True})
        before = self.complete_state(state, image_id)
        source_before = source.read_bytes()
        staged = state.cache_dir / image_id / ".pending-new.png"
        staged.write_bytes(self.png(pixel=(3, 3)))
        created = Candidate("new", "penis", .8, staged)
        options = {"mode": "sam", "fluid_exclusion_enabled": False, "fluid_color_fill": (False, 26), "default_padding": 0, "default_exclude_padding": 0}
        with patch.object(state, "_ensure_models", return_value=object()), \
             patch.object(state, "_detect_image", return_value=[created]), \
             patch.object(state, "_assert_record_stat_matches", side_effect=RuntimeError("changed")):
            state._detect_worker([state.images[image_id]], .5, parallelism=1, detection_options=options)
        self.assertEqual(self.complete_state(state, image_id), before)
        self.assertEqual(source.read_bytes(), source_before)
        self.assertFalse(staged.exists())
        self.assertTrue(old.mask_path.exists())

    def test_staged_manual_png_uses_the_same_shape_channel_and_decode_contract_as_data_urls(self) -> None:
        """DI-234.2: streamed layers and data URLs share one mask validator."""
        state, project_id, image_id, _source = self.project_with_image()
        payload = {
            "emptyLayers": [],
            "manualEnabled": True,
            "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True,
            "removedCandidateIds": [],
            "candidateRevision": 0,
            "hasEffectiveMask": True,
        }

        def streamed(raw: bytes, suffix: int) -> str:
            session = f"00000000-0000-4000-8000-{suffix:012d}"
            state.begin_manual_upload(image_id, session, ["add"])
            layer = state.manual_upload_layer_path(image_id, session, "add")
            layer.write_bytes(raw)
            state.finish_manual_upload_layer(image_id, session, "add", len(raw))
            state.commit_manual_upload(image_id, session, {**payload, "sessionId": session})
            return state.manual_workspace(image_id)["add"]

        for index, mode in enumerate(("L", "RGBA"), 23420):
            raw = self.png(mode=mode)
            staged = streamed(raw, index)
            state.save_manual_workspace(image_id, {**payload, "add": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"), "exclusion": "", "exclusionErase": ""})
            self.assertEqual(state.manual_workspace(image_id)["add"], staged)

        invalid = [
            b"not-png",
            self.png(size=(7, 8)),
            self.png(mode="RGB"),
        ]
        before = self.complete_state(state, image_id)
        for index, raw in enumerate(invalid, 23430):
            session = f"00000000-0000-4000-8000-{index:012d}"
            state.begin_manual_upload(image_id, session, ["add"])
            layer = state.manual_upload_layer_path(image_id, session, "add")
            layer.write_bytes(raw)
            state.finish_manual_upload_layer(image_id, session, "add", len(raw))
            with self.assertRaises(ClientError) as raised:
                state.commit_manual_upload(image_id, session, {**payload, "sessionId": session})
            self.assertEqual(raised.exception.error_code, "input_invalid")
            self.assertEqual(self.complete_state(state, image_id), before)

    def test_invalid_manual_transfer_values_leave_image_project_catalog_epoch_and_other_session_unchanged(self) -> None:
        """DI-214.2: malformed values fail before any shared state mutation."""
        state, project_id, image_id, _source = self.project_with_image()
        other = "00000000-0000-4000-8000-000000214200"
        state.begin_manual_upload(image_id, other, ["add"])
        before = {
            "work": self.complete_state(state, image_id),
            "project": state.catalog_id,
            "workspace": state.workspace_id,
            "generation": state.catalog_generation,
            "sessions": {key: (value["image_id"], set(value["layers"]), set(value["uploaded"])) for key, value in state._manual_uploads.items()},
        }
        attempts = [
            lambda: state.begin_manual_upload(image_id, "not-a-uuid", ["add"]),
            lambda: state.begin_manual_upload(image_id, "00000000-0000-4000-8000-000000214201", ["unknown"]),
            lambda: state.commit_manual_upload(image_id, other, {"emptyLayers": ["exclusion"]}),
            lambda: state.manual_upload_layer_path(image_id, other, "unknown"),
        ]
        for attempt in attempts:
            with self.assertRaises(ClientError) as raised:
                attempt()
            self.assertEqual(raised.exception.error_code, "input_invalid")
            after = {
                "work": self.complete_state(state, image_id),
                "project": state.catalog_id,
                "workspace": state.workspace_id,
                "generation": state.catalog_generation,
                "sessions": {key: (value["image_id"], set(value["layers"]), set(value["uploaded"])) for key, value in state._manual_uploads.items()},
            }
            self.assertEqual(after, before)
        self.assertEqual(state.catalog_id, project_id)

    def test_manual_transfer_disconnect_cleanup_retry_and_logs_preserve_committed_work(self) -> None:
        """DI-235.2/.7 and DI-238.1/.2 across real staging directories."""
        state, _project_id, image_id, _source = self.project_with_image()
        abandoned = "00000000-0000-4000-8000-000000235200"
        replacement = "00000000-0000-4000-8000-000000235201"
        state.begin_manual_upload(image_id, abandoned, ["add"])
        state.manual_upload_layer_path(image_id, abandoned, "add")
        state.abort_manual_upload_layer(image_id, abandoned, "add")
        with self.assertLogs("mozarie", level="INFO") as captured:
            state.begin_manual_upload(image_id, replacement, ["add"])
        self.assertTrue(any("手描きマスク転送を開始" in line for line in captured.output))
        self.assertNotIn(abandoned, state._manual_uploads)
        self.assertIn(replacement, state._manual_uploads)
        self.assertTrue(any("放棄" in line for line in captured.output))

        raw = self.png(pixel=(4, 4))
        layer = state.manual_upload_layer_path(image_id, replacement, "add")
        layer.write_bytes(raw)
        with self.assertLogs("mozarie", level="INFO") as layer_logs:
            state.finish_manual_upload_layer(image_id, replacement, "add", len(raw))
        self.assertTrue(any(f"bytes={len(raw)}" in line for line in layer_logs.output))
        payload = {
            "sessionId": replacement,
            "emptyLayers": [],
            "manualEnabled": True,
            "manualExclusionEnabled": True,
            "manualExclusionEraseEnabled": True,
            "removedCandidateIds": [],
            "candidateRevision": 0,
            "hasEffectiveMask": True,
        }
        original_rmtree = shutil.rmtree
        failed_once = False

        def fail_committed_cleanup(path: object, *args: object, **kwargs: object) -> None:
            nonlocal failed_once
            if Path(path).name == replacement and not failed_once:
                failed_once = True
                raise PermissionError("locked staging")
            original_rmtree(path, *args, **kwargs)

        with patch.object(shutil, "rmtree", side_effect=fail_committed_cleanup), \
             self.assertLogs("mozarie", level="INFO") as warnings_log:
            state.commit_manual_upload(image_id, replacement, payload)
        committed = self.complete_state(state, image_id)
        self.assertTrue(any("確定済み一時データ削除を保留" in line for line in warnings_log.output))
        self.assertTrue(any("手描きマスク転送を完了" in line for line in warnings_log.output))
        self.assertEqual(len(state._pending_manual_upload_cleanup), 1)
        retry = "00000000-0000-4000-8000-000000235202"
        state.begin_manual_upload(image_id, retry, ["add"])
        self.assertEqual(state._pending_manual_upload_cleanup, [])
        self.assertEqual(self.complete_state(state, image_id), committed)

        retry_layer = state.manual_upload_layer_path(image_id, retry, "add")
        retry_layer.write_bytes(raw)
        state.finish_manual_upload_layer(image_id, retry, "add", len(raw))
        failed = ClientError("injected manual failure", "stale_catalog")
        with patch.object(state, "save_manual_workspace", side_effect=failed), \
             self.assertLogs("mozarie", level="INFO") as failed_log:
            with self.assertRaises(ClientError):
                state.commit_manual_upload(image_id, retry, {**payload, "sessionId": retry})
        self.assertTrue(any("放棄: 確定失敗" in line for line in failed_log.output))
        self.assertEqual(self.complete_state(state, image_id), committed)

    def test_missing_manual_staging_directory_does_not_replace_the_original_commit_failure(self) -> None:
        """DI-235.5: cleanup idempotency preserves the operation's stale_catalog result."""
        state, _project_id, image_id, _source = self.project_with_image()
        session = "00000000-0000-4000-8000-000000235500"
        raw = self.png(pixel=(4, 4))
        state.begin_manual_upload(image_id, session, ["add"])
        layer = state.manual_upload_layer_path(image_id, session, "add")
        layer.write_bytes(raw)
        state.finish_manual_upload_layer(image_id, session, "add", len(raw))
        payload = {
            "sessionId": session, "emptyLayers": [], "manualEnabled": True,
            "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
            "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": True,
        }
        original = ClientError("catalog changed", "stale_catalog")
        with patch.object(state, "save_manual_workspace", side_effect=original), \
             patch.object(shutil, "rmtree", side_effect=FileNotFoundError):
            with self.assertRaises(ClientError) as raised:
                state.commit_manual_upload(image_id, session, payload)
        self.assertIs(raised.exception, original)
        self.assertNotIn(session, state._manual_uploads)

    def test_fixed_browser_import_session_logs_start_bytes_counts_completion_and_abandonment(self) -> None:
        """DI-236.3: the fixed import route has a complete CMD audit trail."""
        state = self.state()
        first = "00000000-0000-4000-8000-000000236300"
        second = "00000000-0000-4000-8000-000000236301"
        third = "00000000-0000-4000-8000-000000236302"
        owner = state.catalog_id
        generation = state.catalog_generation
        with self.assertLogs("mozarie", level="INFO") as captured:
            state.start_import_session(first, owner, generation)
            state.begin_import_transfer(first, owner, generation)
            state.record_import_transfer_bytes(first, 123)
            state.end_import_transfer(first, succeeded=True)
            state.begin_import_transfer(first, owner, generation)
            state.end_import_transfer(first, succeeded=False)
            state.finish_import_session(first, owner, generation, {"completed": 1, "failed": True, "cancelled": False})
            state.start_import_session(second, owner, generation)
            state.record_import_transfer_bytes(second, 45)
            state.start_import_session(third, owner, generation)
        lines = "\n".join(captured.output)
        self.assertIn("ブラウザー画像読込を開始", lines)
        self.assertIn("bytes=123", lines)
        self.assertIn("送信成功=1件", lines)
        self.assertIn("送信失敗=1件", lines)
        self.assertIn("完了=1件", lines)
        self.assertIn("ブラウザー画像読込を放棄", lines)
        self.assertIn("bytes=45", lines)

    def test_source_delete_revalidates_mtime_and_size_and_replay_is_exactly_once(self) -> None:
        """DI-219.1/.2 and DI-221.1 on real files and the real SQLite receipt."""
        source = self.root / "delete-sources"
        source.mkdir()
        for name, color in (("valid.png", "white"), ("size.png", "red"), ("mtime.png", "blue")):
            Image.new("RGB", (8, 8), color).save(source / name)
        state = self.state()
        state.create_project("delete revalidation")
        listed = state.set_root(str(source))
        ids = {item["relativePath"]: item["id"] for item in listed}
        for name in ("size.png", "mtime.png"):
            self.add_candidate(state, ids[name], f"candidate-{name}")
            state.set_image_flags(ids[name], {"reviewed": True})
        failed_before = {name: self.durable_state(state, ids[name]) for name in ("size.png", "mtime.png")}
        token = "00000000-0000-4000-8000-000000221100"
        requested = [ids[name] for name in ("valid.png", "size.png", "mtime.png")]
        with self.assertLogs("mozarie", level="INFO") as prepare_log:
            prepared = state.prepare_source_delete({"imageIds": requested, "deleteToken": token})
        self.assertEqual(set(prepared["preparedImageIds"]), set(requested))
        self.assertTrue(any("確認完了" in line for line in prepare_log.output))

        size_path = source / "size.png"
        size_path.write_bytes(size_path.read_bytes() + b"changed-size")
        mtime_path = source / "mtime.png"
        stat = mtime_path.stat()
        os.utime(mtime_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        state.claim_source_delete(token)
        with self.assertLogs("mozarie", level="INFO") as commit_log:
            first = state.delete_images_with_sources({"imageIds": requested, "deleteToken": token})
        second = state.delete_images_with_sources({"imageIds": requested, "deleteToken": token})

        self.assertEqual(second, first)
        self.assertEqual(first["removedImageIds"], [ids["valid.png"]])
        self.assertEqual(len(first["failed"]), 2, "each failed image keeps only its first reason")
        self.assertTrue(any("完了" in line and "source_changed" in line for line in commit_log.output))
        self.assertEqual(
            {(failure["imageId"], failure["reason"]) for failure in first["failed"]},
            {(ids["size.png"], "source_changed"), (ids["mtime.png"], "source_changed")},
        )
        self.assertFalse((source / "valid.png").exists())
        self.assertTrue(size_path.exists())
        self.assertTrue(mtime_path.exists())
        self.assertEqual(
            [item["id"] for item in state.list_images()],
            [ids["mtime.png"], ids["size.png"]],
        )
        for name in ("size.png", "mtime.png"):
            self.assertEqual(self.durable_state(state, ids[name]), failed_before[name])
        with state.workspace_store._connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM images WHERE image_id=?", (ids["valid.png"],)).fetchone()[0], 0)

    def test_source_delete_prepare_persists_authority_targets_and_fingerprint_across_restart(self) -> None:
        """DI-226.2: the complete prepared authority and public status survive restart."""
        state, project_id, image_id, source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000226200"
        record = state.images[image_id]
        expected_generation = state.catalog_generation
        expected_fingerprint = (record.mtime_ns, record.size_bytes)

        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
        operation_before = state.workspace_store.source_delete_operation(token)
        self.assertIsNotNone(operation_before)
        self.assertEqual(operation_before["catalogId"], project_id)
        self.assertEqual(operation_before["workspaceId"], project_id)
        self.assertEqual(operation_before["catalogGeneration"], expected_generation)
        self.assertEqual(operation_before["requestedImageIds"], [image_id])
        self.assertEqual(len(operation_before["items"]), 1)
        item = operation_before["items"][0]
        self.assertEqual(item["imageId"], image_id)
        self.assertEqual(item["sourcePath"], str(source))
        self.assertEqual((item["mtimeNs"], item["sizeBytes"]), expected_fingerprint)
        self.assertIsInstance(item["fileIdentity"], str)
        self.assertTrue(item["fileIdentity"], "prepare stores the real source file identity")
        status_before = state.source_delete_status(token)

        state.shutdown(); self.states.remove(state)
        reopened = self.state()
        operation_after = reopened.workspace_store.source_delete_operation(token)
        self.assertEqual(operation_after, operation_before, "restart preserves every prepared authority, target, and fingerprint field")
        self.assertEqual(reopened.source_delete_status(token), status_before, "status returns the identical prepared result after restart")

    def test_already_missing_browser_source_commits_once_and_cascades_all_work(self) -> None:
        """DI-221.2/224.2: lost-response replay converges the whole working list."""
        state, _project_id, image_id, source = self.project_with_image()
        self.add_candidate(state, image_id, "browser-candidate")
        raw = "data:image/png;base64," + base64.b64encode(self.png(pixel=(4, 4))).decode("ascii")
        state.save_manual_workspace(image_id, {
            "add": raw, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "candidateRevision": state._candidate_revision(image_id), "hasEffectiveMask": True,
        })
        state.set_image_flags(image_id, {"reviewed": True})
        state.images[image_id].source_kind = "session"
        with state.workspace_store._connect() as db:
            history_before = db.execute("SELECT COUNT(*) FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0]
        self.assertGreater(history_before, 0)
        token = "00000000-0000-4000-8000-000000224200"
        prepared = state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
        self.assertEqual(prepared["preparedImageIds"], [image_id])
        state.claim_source_delete(token)
        source.unlink()
        first = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token, "browserDeletedImageIds": [image_id]})
        replay = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token, "browserDeletedImageIds": [image_id]})
        self.assertEqual(replay, first)
        self.assertEqual(first["removedImageIds"], [image_id])
        self.assertEqual(state.list_images(), [])
        self.assertNotIn(image_id, state.candidates)
        with state.workspace_store._connect() as db:
            for table in ("images", "candidates", "manual_edits", "history_entries", "image_transforms"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE image_id=?", (image_id,)).fetchone()[0], 0)

    def test_new_source_delete_prepare_replaces_older_prepared_receipt_and_terminal_ack_removes_it(self) -> None:
        """DI-232.3: one image has one current prepared receipt."""
        state, _project_id, image_id, _source = self.project_with_image()
        old = "00000000-0000-4000-8000-000000232300"
        new = "00000000-0000-4000-8000-000000232301"
        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": old})
        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": new})
        self.assertIsNone(state.workspace_store.source_delete_operation(old))
        self.assertEqual(state.source_delete_status(new)["state"], "prepared")
        state.cancel_source_delete(new)
        self.assertEqual(state.source_delete_status(new)["state"], "cancelled")
        self.assertEqual(state.acknowledge_source_delete(new), {"acknowledged": True, "deleteToken": new})
        self.assertIsNone(state.workspace_store.source_delete_operation(new))

    def test_source_delete_returns_only_the_first_reason_for_one_image(self) -> None:
        """DI-230.3: prepare and commit failures deduplicate by image, first wins."""
        state, _project_id, image_id, source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000230300"
        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
        state.workspace_store.update_source_delete_operation(
            token, "prepared",
            {"prepareFailures": [{"imageId": image_id, "reason": "first_reason"}]},
            expected_states={"prepared"},
        )
        state.claim_source_delete(token)
        source.write_bytes(source.read_bytes() + b"changed")
        result = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token})
        self.assertEqual(result["failed"], [{"imageId": image_id, "reason": "first_reason", "relativePath": "source.png"}])

    def test_source_delete_prepare_failure_is_written_to_cmd_log(self) -> None:
        """DI-230.2: server-reached prepare rejection is visible in CMD diagnostics."""
        state, _project_id, image_id, _source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000230200"
        with self.assertLogs("mozarie", level="INFO") as captured:
            result = state.prepare_source_delete({"imageIds": [image_id, "missing-image"], "deleteToken": token})
        self.assertEqual(result["preparedImageIds"], [image_id])
        self.assertEqual(result["failed"], [{"imageId": "missing-image", "reason": "image_not_found"}])
        self.assertTrue(any("失敗=1" in line and "missing-image:image_not_found" in line for line in captured.output))

    def test_source_delete_cleanup_failure_reports_cleanup_pending_and_cmd_warning(self) -> None:
        """DI-225.3: a committed workspace delete exposes deferred source cleanup."""
        state, _project_id, image_id, _source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000225300"
        with patch("mozarie.catalog.SaveJournal.delete_windows_verified", return_value=False), \
             self.assertLogs("mozarie", level="INFO") as captured:
            state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
            state.claim_source_delete(token)
            result = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token})
        self.assertEqual(result["state"], "cleanup_pending")
        self.assertEqual(result["cleanupPendingCount"], 1)
        self.assertEqual(state.source_delete_status(token)["state"], "cleanup_pending")
        self.assertTrue(any("元画像削除の後処理を保留" in line for line in captured.output))
        self.assertTrue(any("元画像を完全削除: 確認完了" in line for line in captured.output))
        self.assertTrue(any("元画像を完全削除: 開始" in line for line in captured.output))
        self.assertTrue(any("元画像を完全削除: 完了" in line for line in captured.output))

    def test_source_delete_cleanup_distinguishes_missing_quarantine_from_temporary_oserror_and_retries(self) -> None:
        """DI-233.2/.3: only actual absence completes; transient I/O stays retryable."""
        state, project_id, image_id, _source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000233200"
        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
        state.claim_source_delete(token)
        with patch("mozarie.catalog.SaveJournal.delete_windows_verified", return_value=False):
            result = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token})
        quarantine = Path(result["quarantinePaths"][0])
        self.assertTrue(quarantine.exists())
        real_stat = Path.stat

        def inaccessible(path: Path, *args: object, **kwargs: object):
            if path == quarantine:
                raise PermissionError("temporarily shared")
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", inaccessible), self.assertLogs("mozarie", level="WARNING") as logged:
            state.retry_source_delete_cleanups()
        pending = state.source_delete_status(token)
        self.assertEqual(pending["state"], "cleanup_pending")
        self.assertEqual(pending["cleanupPendingCount"], 1)
        self.assertEqual(pending["recoveryConflicts"][0]["reason"], "quarantine_unavailable:PermissionError")
        self.assertTrue(any("後処理を保留" in line for line in logged.output))
        state.shutdown(); self.states.remove(state)
        reopened = self.state()
        self.assertEqual(
            reopened.source_delete_status(token)["state"],
            "committed",
            "startup reconstructs the durable cleanup receipt and retries it",
        )
        self.assertFalse(quarantine.exists())

    def test_missing_source_delete_quarantine_is_the_only_absence_treated_as_completed(self) -> None:
        """DI-233.2: a verified cleanup receipt completes when its quarantine is truly gone."""
        state, _project_id, image_id, _source = self.project_with_image()
        token = "00000000-0000-4000-8000-000000233201"
        state.prepare_source_delete({"imageIds": [image_id], "deleteToken": token})
        state.claim_source_delete(token)
        with patch("mozarie.catalog.SaveJournal.delete_windows_verified", return_value=False):
            result = state.delete_images_with_sources({"imageIds": [image_id], "deleteToken": token})
        quarantine = Path(result["quarantinePaths"][0])
        quarantine.unlink()
        state.retry_source_delete_cleanups()
        settled = state.source_delete_status(token)
        self.assertEqual(settled["state"], "committed")
        self.assertEqual(settled["quarantinePaths"], [])

    def test_browser_save_tokens_survive_time_and_status_ack_cleans_only_the_terminal_token(self) -> None:
        """DI-237.2/239.2: same-image replacement and restart-safe receipt recovery."""
        state, project_id, image_id, _source = self.project_with_image()
        self.add_candidate(state, image_id, "save")
        revision = state._candidate_revision(image_id)
        first = "00000000-0000-4000-8000-000000237200"
        second = "00000000-0000-4000-8000-000000239200"
        pending = "00000000-0000-4000-8000-000000239201"

        state.reserve_browser_save(image_id, revision, first, copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        state.render_browser_save(image_id, revision, 100, None, client_save_token=first)
        state.browser_save_tokens[first] = replace(state.browser_save_tokens[first], issued_at=time.monotonic() - 10_000_000)
        state.cleanup_expired_browser_save_tokens()
        self.assertEqual(state.browser_save_status(image_id, revision, first, "overwrite")["state"], "pending")
        first_path = state.browser_save_tokens[first].rendered_path
        self.assertIsNotNone(first_path); self.assertTrue(first_path.exists())
        state.cancel_browser_save(image_id, revision, first)
        self.assertFalse(first_path.exists(), "a replacement same-image save recovers the abandoned private render")

        state.reserve_browser_save(image_id, revision, second, copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        state.render_browser_save(image_id, revision, 100, None, client_save_token=second)
        committed = state.commit_browser_save(image_id, revision, second, "overwrite")
        new_revision = state._candidate_revision(image_id)
        state.reserve_browser_save(image_id, new_revision, pending, copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        pending_render = state.render_browser_save(image_id, new_revision, 100, None, client_save_token=pending)
        if pending_render.response_path_is_temporary and pending_render.response_path is not None:
            pending_render.response_path.unlink(missing_ok=True)

        state.shutdown(); self.states.remove(state)
        reopened = self.state(); reopened.open_project(project_id)
        self.assertEqual(reopened.browser_save_status(image_id, revision, second, "overwrite")["state"], "committed")
        self.assertEqual(reopened.commit_browser_save(image_id, revision, second, "overwrite"), committed, "a lost commit response replays the durable terminal receipt")
        self.assertEqual(
            reopened.browser_save_status(image_id, new_revision, pending, "keep"),
            {"state": "unknown"},
            "an uncommitted in-memory render is not reconstructed as a durable receipt",
        )
        self.assertEqual(reopened.browser_save_status(image_id, new_revision, "missing", "keep"), {"state": "unknown"})
        reopened.acknowledge_browser_save(second)
        self.assertEqual(reopened.browser_save_status(image_id, revision, second, "overwrite"), {"state": "unknown"})
        self.assertEqual(reopened.browser_save_status(image_id, new_revision, pending, "keep"), {"state": "unknown"})

    @unittest.skipUnless(os.name == "nt", "real Windows delete-sharing contract")
    def test_windows_locked_candidate_delete_commits_once_then_reopens_without_resurrection(self) -> None:
        """DI-256.1/.2: a real no-delete-share handle cannot roll back state."""
        state, project_id, image_id, source = self.project_with_image()
        kept = self.add_candidate(state, image_id, "kept", pixel=(1, 1))
        locked = self.add_candidate(state, image_id, "locked", pixel=(2, 2))
        revision_before = state._candidate_revision(image_id)
        with state.workspace_store._connect() as db:
            history_before = db.execute("SELECT COUNT(*) FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0]
        source_before = source.read_bytes()

        create_file = ctypes.windll.kernel32.CreateFileW
        create_file.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        create_file.restype = ctypes.c_void_p
        handle = create_file(str(locked.mask_path), 0x80000000, 0x00000001 | 0x00000002, None, 3, 0x80, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            self.assertTrue(state.delete_candidate(image_id, "locked"))
            self.assertEqual(state._candidate_revision(image_id), revision_before + 1)
            with state.workspace_store._connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0], history_before + 1)
            self.assertEqual([item["id"] for item in state.candidate_snapshot(image_id)["candidates"]], ["kept"])
            self.assertTrue(locked.mask_path.exists(), "Windows really denied the disposable cache unlink")
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)

        state._delete_mask_files([locked.mask_path], [])
        self.assertFalse(locked.mask_path.exists())
        reopened = self.state()
        reopened.open_project(project_id)
        self.assertEqual([item["id"] for item in reopened.candidate_snapshot(image_id)["candidates"]], ["kept"])
        self.assertEqual(reopened._candidate_revision(image_id), revision_before + 1)
        self.assertEqual(source.read_bytes(), source_before)


if __name__ == "__main__":
    unittest.main()
