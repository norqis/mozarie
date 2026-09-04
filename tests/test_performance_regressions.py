"""Focused regression coverage for batch-state and memory-sensitive paths."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

import mozarie.jobs as jobs_module
import mozarie.state as state_module
from mozarie.jobs import JobsMixin
from mozarie.state import StudioState
from mozarie.workspace import WorkspaceStore


class WorkspacePerformanceRegressionTests(unittest.TestCase):
    @staticmethod
    def _records() -> list[SimpleNamespace]:
        return [
            SimpleNamespace(relative_path=f"{index}.png", size_bytes=10, mtime_ns=20, width=4, height=4)
            for index in range(2)
        ]

    def _store_with_images(self, root: Path) -> tuple[WorkspaceStore, list[str]]:
        store = WorkspaceStore(root)
        catalog_id = str(store.create_project()["id"])
        rows = store.reconcile_images(catalog_id, self._records())
        return store, [str(rows[f"{index}.png"]["image_id"]) for index in range(2)]

    def test_bulk_clear_uses_one_transaction_and_commits_one_history_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store, image_ids = self._store_with_images(Path(directory))
            original_connect = store._connect
            connections = 0
            statements: list[str] = []

            def traced_connect():
                nonlocal connections
                connections += 1
                db = original_connect()
                db.set_trace_callback(statements.append)
                return db

            store._connect = traced_connect  # type: ignore[method-assign]
            store.clear_image_workspaces({image_ids[0]: 1, image_ids[1]: 1})
            self.assertEqual(connections, 1)
            self.assertEqual(sum(statement == "BEGIN IMMEDIATE" for statement in statements), 1)
            self.assertEqual(sum(statement == "COMMIT" for statement in statements), 1)
            db = sqlite3.connect(store.path)
            try:
                groups = db.execute("SELECT status FROM history_groups").fetchall()
                entries = db.execute("SELECT DISTINCT group_id FROM history_entries").fetchall()
            finally:
                db.close()
            self.assertEqual(groups, [("committed",)])
            self.assertEqual(len(entries), 1)
            self.assertIsNotNone(entries[0][0])

    def test_bulk_clear_rolls_back_every_image_and_history_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store, image_ids = self._store_with_images(Path(directory))
            original_record = store._record_history_db
            calls = 0

            def fail_second_history(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise sqlite3.OperationalError("history failed")
                return original_record(*args, **kwargs)

            with patch.object(store, "_record_history_db", side_effect=fail_second_history):
                with self.assertRaisesRegex(sqlite3.OperationalError, "history failed"):
                    store.clear_image_workspaces({image_ids[0]: 1, image_ids[1]: 1})
            db = sqlite3.connect(store.path)
            try:
                revisions = db.execute("SELECT candidate_revision FROM images ORDER BY relative_path").fetchall()
                history_count = db.execute("SELECT COUNT(*) FROM history_entries").fetchone()[0]
                group_count = db.execute("SELECT COUNT(*) FROM history_groups").fetchone()[0]
            finally:
                db.close()
            self.assertEqual(revisions, [(0,), (0,)])
            self.assertEqual(history_count, 0)
            self.assertEqual(group_count, 0)

    def test_no_effect_save_does_not_open_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store, image_ids = self._store_with_images(Path(directory))
            with patch.object(store, "_connect", side_effect=AssertionError("unexpected sqlite access")):
                store.commit_save(image_ids[0], clear_workspace=False)


class JobMemoryRegressionTests(unittest.TestCase):
    def test_cpu_job_cleanup_releases_inference_references_and_collects(self) -> None:
        state = JobsMixin()
        state.inference_lock = threading.RLock()
        state.sam_lock = threading.RLock()
        state.lock = threading.RLock()
        state.settings = {"models": {"provider": "cpu", "gpu_device": 0}}
        state.models = object()
        state.hand_model = object()
        state.sam_predictor = Mock()
        state.sam_image_id = "image"
        state.hand_segmentation_predictor = Mock()
        state.hand_segmentation_image_id = "image"
        with patch.object(jobs_module.gc, "collect") as collect:
            state._release_gpu_job_memory()
        self.assertIsNone(state.models)
        self.assertIsNone(state.hand_model)
        self.assertIsNone(state.sam_predictor)
        self.assertIsNone(state.hand_segmentation_predictor)
        collect.assert_called_once_with()


class CatalogPerformanceRegressionTests(unittest.TestCase):
    def test_bulk_remove_scans_thumbnail_directory_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_dir = root / "app"
            shutil.copytree(Path(__file__).resolve().parents[1] / "config", app_dir / "config")
            source = root / "source"
            source.mkdir()
            for name in ("one.png", "two.png"):
                Image.new("RGB", (4, 4), "white").save(source / name)
            with patch.object(state_module, "APP_DIR", app_dir):
                state = StudioState(root / "cache", root / "sessions")
            try:
                state.create_project("bulk remove")
                image_ids = [image["id"] for image in state.set_root(str(source))]
                original_id = image_ids[0]
                hyphenated_id = "image-with-hyphen"
                record = state.images.pop(original_id)
                record.image_id = hyphenated_id
                state.images[hyphenated_id] = record
                state.order[state.order.index(original_id)] = hyphenated_id
                state.candidates[hyphenated_id] = state.candidates.pop(original_id, [])
                state.candidate_revisions[hyphenated_id] = state.candidate_revisions.pop(original_id, 0)
                db = sqlite3.connect(state.workspace_store.path)
                try:
                    db.execute("UPDATE images SET image_id=? WHERE image_id=?", (hyphenated_id, original_id))
                    db.commit()
                finally:
                    db.close()
                image_ids[0] = hyphenated_id
                thumbnail_dir = state.cache_dir / "thumbnails"
                thumbnail_dir.mkdir(parents=True)
                for image_id in image_ids:
                    (thumbnail_dir / f"{image_id}-1-2-3.jpg").write_bytes(b"thumbnail")
                (thumbnail_dir / "unrelated-1-2-3.jpg").write_bytes(b"thumbnail")
                original_glob = Path.glob
                scans = 0

                def counted_glob(path: Path, pattern: str):
                    nonlocal scans
                    if path == thumbnail_dir and pattern == "*.jpg":
                        scans += 1
                    return original_glob(path, pattern)

                with patch("pathlib.Path.glob", new=counted_glob):
                    state.remove_images_from_catalog(image_ids)
                self.assertEqual(scans, 1)
                self.assertFalse(any((thumbnail_dir / f"{image_id}-1-2-3.jpg").exists() for image_id in image_ids))
                self.assertTrue((thumbnail_dir / "unrelated-1-2-3.jpg").exists())
            finally:
                state.shutdown()


if __name__ == "__main__":
    unittest.main()
