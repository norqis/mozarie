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
    def fixture(self, copy_to_default: bool, preserve_structure: bool):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"
            (app / "config").mkdir(parents=True)
            shutil.copyfile(Path(__file__).resolve().parents[2] / "config" / "defaults.json", app / "config" / "defaults.json")
            source = root / "source" / "nested" / "image.png"
            source.parent.mkdir(parents=True)
            pixels = np.arange(16 * 16 * 3, dtype=np.uint8).reshape((16, 16, 3))
            Image.fromarray(pixels).save(source)
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

    def test_cleanup_failure_after_commit_keeps_output_and_releases_reservation(self):
        for preserve_structure in (True, False):
            with self.subTest(structure=preserve_structure):
                with self.fixture(True, preserve_structure) as (state, image_id, source, destination, stage_dir):
                    original = source.read_bytes()
                    workspace = state.workspace_store.export_state(image_id)
                    thumbnail = state.cache_dir / "thumbnails" / f"{image_id}-old.jpg"
                    thumbnail.parent.mkdir(parents=True, exist_ok=True)
                    Image.new("RGB", (2, 2), "white").save(thumbnail)
                    unlink = Path.unlink

                    def fail_thumbnail_cleanup(path, *args, **kwargs):
                        if path == thumbnail:
                            raise PermissionError("thumbnail cleanup unavailable")
                        return unlink(path, *args, **kwargs)

                    with patch.object(Path, "unlink", new=fail_thumbnail_cleanup):
                        self.apply(state, image_id, True)
                    self.assertEqual(state.job.state, "error")
                    self.assertEqual(state.job.error_code, "output_unavailable")
                    self.assertEqual(state.job.outputs, [str(destination)])
                    self.assertNotEqual(destination.read_bytes(), original)
                    self.assertEqual(source.read_bytes(), original)
                    self.assertEqual(state.workspace_store.export_state(image_id), workspace)
                    self.assertEqual(state.reserved_output_paths, set())
                    self.assertEqual(list(stage_dir.glob("*")), [])
