"""Saving remains retryable after file and journal staging failures."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import io
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from mozarie.core import Candidate
import mozarie.saving as saving_module
import mozarie.state as state_module
from mozarie.state import StudioState


class ApplyStagingFailureTests(unittest.TestCase):
    @contextmanager
    def fixture(self, copy_to_default: bool, preserve_structure: bool, *, second_image: bool = False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            app = root / "app"
            (app / "config").mkdir(parents=True)
            shutil.copyfile(Path(__file__).resolve().parents[2] / "config" / "defaults.json", app / "config" / "defaults.json")
            source = root / "source" / "nested" / "image.png"
            source.parent.mkdir(parents=True)
            pixels = np.arange(16 * 16 * 3, dtype=np.uint8).reshape((16, 16, 3))
            Image.fromarray(pixels).save(source)
            if second_image:
                with Image.fromarray(pixels) as image:
                    image.save(source.with_name("second.png"))
            output = root / "copies"
            output.mkdir()
            with patch.object(state_module, "APP_DIR", app):
                state = StudioState(root / "cache", root / "sessions")
            try:
                image_id = state.set_root(str(source.parent.parent))[0]["id"]
                state.settings["saving"].update(default_output_directory=str(output), preserve_directory_structure=preserve_structure)
                mask_path = state.cache_dir / image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (16, 16), 255).save(mask_path)
                state._commit_candidate_snapshot(image_id, [Candidate("candidate", "penis", .9, mask_path)], replace=True)
                manual = io.BytesIO()
                Image.new("L", (16, 16), 255).save(manual, format="PNG")
                state.save_manual_workspace(image_id, {
                    "add": "data:image/png;base64," + base64.b64encode(manual.getvalue()).decode("ascii"),
                    "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
                    "candidateRevision": state._candidate_revision(image_id), "hasEffectiveMask": True,
                })
                state.set_image_flags(image_id, {"reviewed": True})
                destination = source
                if copy_to_default:
                    destination = output / ("nested" if preserve_structure else "") / "image_censored.png"
                stage_dir = destination.parent / ".mozarie-staging" if copy_to_default else state.cache_dir / "apply-render"
                yield state, image_id, source, destination, stage_dir
            finally:
                state.shutdown()

    def apply(self, state: StudioState, image_id: str, copy_to_default: bool) -> None:
        self.assertTrue(state.start_apply([image_id], 4, {}, copy_to_default=copy_to_default))
        state.worker_thread.join(30)
        self.assertFalse(state.worker_thread.is_alive(), "save worker did not finish")

    @contextmanager
    def fail_journal_statement(self, journal_path: Path, operation: str):
        connect = sqlite3.connect
        rejected = []

        def connect_with_failure(database, *args, **kwargs):
            db = connect(database, *args, **kwargs)
            if Path(database) == journal_path:
                def authorize(action, table, column, _database, _trigger):
                    matches = action == sqlite3.SQLITE_INSERT if operation == "reserve" else action == sqlite3.SQLITE_UPDATE and column == "staged"
                    if table == "saves" and matches and not rejected:
                        rejected.append(operation)
                        return sqlite3.SQLITE_DENY
                    return sqlite3.SQLITE_OK
                db.set_authorizer(authorize)
            return db

        with patch.object(sqlite3, "connect", side_effect=connect_with_failure):
            yield rejected

    def check_failure_and_retry(self, failure: str) -> None:
        modes = ((True, True), (True, False)) if failure == "output_mkdir" else ((True, True), (True, False), (False, True))
        for copy_to_default, preserve_structure in modes:
            with self.subTest(failure=failure, copy=copy_to_default, structure=preserve_structure):
                with self.fixture(copy_to_default, preserve_structure) as (state, image_id, source, destination, stage_dir):
                    original = source.read_bytes()
                    workspace = state.workspace_store.export_state(image_id)
                    history = state.project_history_status(image_id)
                    revision = state._candidate_revision(image_id)
                    if failure == "fsync":
                        failure_context = patch.object(saving_module.os, "fsync", side_effect=OSError("staging sync failed"))
                    elif failure in {"mkdir", "output_mkdir"}:
                        mkdir = Path.mkdir
                        unavailable = destination.parent if failure == "output_mkdir" else stage_dir

                        def fail_stage_mkdir(path, *args, **kwargs):
                            if path == unavailable:
                                raise PermissionError("staging directory unavailable")
                            return mkdir(path, *args, **kwargs)

                        failure_context = patch.object(Path, "mkdir", new=fail_stage_mkdir)
                    elif failure == "create":
                        open_file = os.open

                        def fail_stage_create(path, *args, **kwargs):
                            if Path(path).parent == stage_dir:
                                raise OSError("staging file unavailable")
                            return open_file(path, *args, **kwargs)

                        failure_context = patch.object(os, "open", side_effect=fail_stage_create)
                    else:
                        failure_context = self.fail_journal_statement(state.save_journal.path, failure)
                    with failure_context as fault:
                        self.apply(state, image_id, copy_to_default)
                    expected_error = "workspace_database_error" if failure in {"reserve", "update_stage"} else "output_unavailable"
                    self.assertEqual(state.job.state, "error")
                    self.assertEqual(state.job.error_code, expected_error)
                    if failure in {"reserve", "update_stage"}:
                        self.assertEqual(fault, [failure])
                    self.assertEqual(state.reserved_output_paths, set())
                    self.assertEqual(list(stage_dir.glob("*")), [])
                    self.assertEqual(source.read_bytes(), original)
                    if copy_to_default:
                        self.assertFalse(destination.exists())
                    self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                    self.assertEqual(state.project_history_status(image_id), history)
                    self.assertEqual(state._candidate_revision(image_id), revision)

                    self.apply(state, image_id, copy_to_default)
                    self.assertEqual(state.job.state, "complete", state.job.error)
                    self.assertEqual(state.job.outputs, [str(destination)])
                    self.assertNotEqual(destination.read_bytes(), original)
                    with Image.open(destination) as image:
                        self.assertEqual(image.size, (16, 16))
                    self.assertEqual(state.reserved_output_paths, set())
                    self.assertEqual(list(stage_dir.glob("*")), [])
                    self.assertEqual(state._candidate_revision(image_id), revision)
                    self.assertEqual(state.project_history_status(image_id), history)
                    self.assertEqual(state.workspace_store.export_state(image_id), workspace)

    def test_fsync_failure_releases_stage_and_allows_retry(self):
        self.check_failure_and_retry("fsync")

    def test_stage_directory_failure_releases_reservation_and_allows_retry(self):
        self.check_failure_and_retry("mkdir")

    def test_output_directory_failure_releases_reservation_and_allows_retry(self):
        self.check_failure_and_retry("output_mkdir")

    def test_stage_creation_failure_releases_reservation_and_allows_retry(self):
        self.check_failure_and_retry("create")

    def test_journal_reserve_failure_releases_stage_and_allows_retry(self):
        self.check_failure_and_retry("reserve")

    def test_journal_stage_failure_cleans_registered_stage_and_allows_retry(self):
        self.check_failure_and_retry("update_stage")

    def test_thumbnail_cleanup_failure_after_commit_keeps_batch_successful(self):
        for copy_to_default, preserve_structure in ((True, True), (True, False), (False, True)):
            for failure in ("list", "unlink"):
                with self.subTest(copy=copy_to_default, structure=preserve_structure, failure=failure), self.fixture(
                    copy_to_default, preserve_structure, second_image=True,
                ) as (state, image_id, source, destination, stage_dir):
                    image_ids = list(state.order)
                    self.assertEqual(len(image_ids), 2)
                    second_id = image_ids[1]
                    second_mask = state.cache_dir / second_id / "candidate.png"
                    second_mask.parent.mkdir(parents=True, exist_ok=True)
                    with Image.new("L", (16, 16), 255) as mask:
                        mask.save(second_mask)
                    state._commit_candidate_snapshot(second_id, [Candidate("second", "penis", .9, second_mask)], replace=True)
                    state.settings["saving"]["parallelism"] = 1
                    sources = [state.images[item].path for item in image_ids]
                    originals = [path.read_bytes() for path in sources]
                    workspaces = [state.workspace_store.export_state(item) for item in image_ids]
                    histories = [state.project_history_status(item) for item in image_ids]
                    destinations = [destination, destination.with_name("second_censored.png" if copy_to_default else "second.png")]
                    thumbnail = state.cache_dir / "thumbnails" / f"{image_id}-old.jpg"
                    thumbnail.parent.mkdir(parents=True, exist_ok=True)
                    with Image.new("RGB", (2, 2), "white") as image:
                        image.save(thumbnail)
                    operation = Path.glob if failure == "list" else Path.unlink

                    def fail_thumbnail_cleanup(path, *args, **kwargs):
                        if path == (thumbnail.parent if failure == "list" else thumbnail):
                            raise PermissionError("thumbnail cleanup unavailable")
                        return operation(path, *args, **kwargs)

                    with self.assertLogs("mozarie", level="WARNING"), patch.object(
                        Path, "glob" if failure == "list" else "unlink", new=fail_thumbnail_cleanup,
                    ):
                        self.assertTrue(state.start_apply(image_ids, 4, {}, copy_to_default=copy_to_default))
                        state.worker_thread.join(30)
                        self.assertFalse(state.worker_thread.is_alive(), "save worker did not finish")
                    self.assertEqual(state.job.state, "complete", state.job.error)
                    self.assertEqual(state.job.error_code, "")
                    self.assertEqual(state.job.completed_image_ids, tuple(image_ids))
                    self.assertEqual(state.job.outputs, [str(path) for path in destinations])
                    for index, target in enumerate(destinations):
                        self.assertNotEqual(target.read_bytes(), originals[index])
                        if copy_to_default:
                            self.assertEqual(sources[index].read_bytes(), originals[index])
                        self.assertEqual(state.workspace_store.export_state(image_ids[index]), workspaces[index])
                        self.assertEqual(state.project_history_status(image_ids[index]), histories[index])
                    self.assertEqual(state.reserved_output_paths, set())
                    self.assertEqual(list(stage_dir.glob("*")), [])
                    self.assertEqual(state.workspace_store.apply_save_receipts(), [])
                    with state.save_journal._connection() as db:
                        self.assertEqual(db.execute("SELECT COUNT(*) FROM saves").fetchone()[0], 0)

    def test_browser_commit_cleanup_failure_keeps_receipt_and_finishes_other_cleanup(self):
        cases = (("overwrite", "list"), ("overwrite", "thumbnail"), ("overwrite", "render"),
                 ("overwrite", "both"),
                 ("deleted", "list"), ("deleted", "thumbnail"))
        for action, failure in cases:
            with self.subTest(action=action, failure=failure), self.fixture(
                action == "deleted", True,
            ) as (state, image_id, source, destination, _stage_dir):
                original = source.read_bytes()
                workspace = state.workspace_store.export_state(image_id)
                history = state.project_history_status(image_id)
                generation = state.catalog_generation
                revision = state._candidate_revision(image_id)
                token = "cleanup-failure"
                state.reserve_browser_save(image_id, revision, token, copy_to_default=action == "deleted",
                                           suffix="_censored", output_format="original", keep_metadata=True)
                rendered = state.render_browser_save(image_id, revision, 4, None, copy_to_default=action == "deleted",
                                                     client_save_token=token)
                token = rendered.save_token
                details = state.browser_save_tokens[token]
                stage = details.rendered_path if action == "overwrite" else details.output_path
                self.assertIsNotNone(stage)
                expected_output = stage.read_bytes()
                self.assertNotEqual(expected_output, original)
                thumbnail = state.cache_dir / "thumbnails" / f"{image_id}-old.jpg"
                thumbnail.parent.mkdir(parents=True, exist_ok=True)
                with Image.new("RGB", (2, 2), "white") as image:
                    image.save(thumbnail)
                state.sam_image_id = image_id
                state.hand_segmentation_image_id = image_id
                operation = Path.glob if failure == "list" else Path.unlink
                failed_paths = []

                def fail_cache_cleanup(path, *args, **kwargs):
                    targets = [thumbnail, stage] if failure == "both" else [
                        thumbnail.parent if failure == "list" else stage if failure == "render" else thumbnail,
                    ]
                    if path in targets:
                        failed_paths.append(path)
                        raise PermissionError("derived save cache cleanup unavailable")
                    return operation(path, *args, **kwargs)

                with self.assertLogs("mozarie", level="WARNING"), patch.object(
                    Path, "glob" if failure == "list" else "unlink", new=fail_cache_cleanup,
                ):
                    committed = state.commit_browser_save(image_id, revision, token, action)
                self.assertTrue(failed_paths)
                if failure == "both":
                    self.assertIn(thumbnail, failed_paths)
                    self.assertIn(stage, failed_paths)
                self.assertTrue(committed["cleared"])
                self.assertEqual(committed["deleted"], action == "deleted")
                self.assertEqual(committed["sourceAction"], action)
                self.assertEqual(destination.read_bytes(), expected_output)
                self.assertIsNone(state.sam_image_id)
                self.assertIsNone(state.hand_segmentation_image_id)
                self.assertNotIn(token, state.browser_save_tokens)
                self.assertEqual(state.reserved_output_paths, set())
                receipt = state.workspace_store.browser_save_receipt(token)
                self.assertTrue(receipt["cleared"])
                self.assertEqual(receipt["sourceAction"], action)
                # finish() must still record the successful publication even
                # when subsequent recovery cannot remove the render yet.
                journal = state.save_journal.row(token)
                self.assertEqual(journal["cleared"], 1)
                self.assertEqual(journal["recovery_decision"], "commit")
                self.assertFalse(list(source.parent.glob("*.mozarie-*")))
                if failure == "render":
                    self.assertFalse(thumbnail.exists())
                elif failure != "both":
                    self.assertFalse(stage.exists())
                if action == "overwrite":
                    self.assertEqual(state.catalog_generation, generation)
                    self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                    self.assertEqual(state.project_history_status(image_id), history)
                else:
                    self.assertEqual(state.catalog_generation, generation)
                    self.assertFalse(source.exists())
                    self.assertNotIn(image_id, state.images)
                    self.assertNotIn(image_id, state.order)
                    self.assertFalse(state.workspace_store.has_image(image_id))
                saved_mtime = destination.stat().st_mtime_ns
                self.assertEqual(state.commit_browser_save(image_id, revision, token, action), committed)
                self.assertEqual(destination.read_bytes(), expected_output)
                self.assertEqual(destination.stat().st_mtime_ns, saved_mtime)
                self.assertTrue(state.acknowledge_browser_save(token)["acknowledged"])
                self.assertFalse(stage.exists())
                self.assertIsNone(state.save_journal.row(token))
                self.assertIsNone(state.workspace_store.browser_save_receipt(token))
