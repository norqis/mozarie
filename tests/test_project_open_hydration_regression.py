"""Regression coverage for project-open candidate hydration."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config

import mozarie.state as state_module
from mozarie.state import StudioState


class ProjectOpenHydrationRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        prepare_test_app_config(self.app_dir)
        self.states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self.states:
            state.shutdown()
        self._temporary.cleanup()

    def state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / "cache", self.root / "sessions")
        self.states.append(state)
        return state

    @staticmethod
    def png() -> bytes:
        output = BytesIO()
        Image.new("L", (8, 8), 0).save(output, format="PNG")
        return output.getvalue()

    def test_large_project_open_hydrates_candidates_once(self) -> None:
        source = self.root / "large-source"
        source.mkdir()
        records = []
        for index in range(20_000):
            path = source / f"{index:05}.png"
            path.write_bytes(b"x")
            stat = path.stat()
            records.append(SimpleNamespace(relative_path=path.name, size_bytes=stat.st_size,
                                           mtime_ns=stat.st_mtime_ns, width=3840, height=2160))
        state = self.state()
        project = state.create_project("large reopen")
        source_id = state.workspace_store.ensure_project_source(
            project["id"], kind="native-folder", display_name=source.name, identity=str(source.resolve()),
        )
        stored = state.workspace_store.reconcile_images(project["id"], records, source_id)
        raw = self.png()
        db = sqlite3.connect(state.workspace_store.path)
        try:
            db.executemany("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""", [
                (str(stored[record.relative_path]["image_id"]), "detector", "hand", .8, raw, 1,
                 "#112233", "auto", "automatic", None, "apply", 0)
                for record in records
            ])
            db.commit()
        finally:
            db.close()
        with patch("mozarie.catalog.inspect_import_image", side_effect=AssertionError("unchanged file was inspected")), \
             patch("mozarie.workspace.Image.open", side_effect=AssertionError("candidate PNG was decoded")), \
             patch.object(state.workspace_store, "hydrate_candidates_bulk", wraps=state.workspace_store.hydrate_candidates_bulk) as hydrated:
            reopened = state.open_project(project["id"])
        self.assertEqual(len(reopened["images"]), len(records))
        self.assertEqual(hydrated.call_count, 1)

    def test_multi_source_project_open_hydrates_candidates_once(self) -> None:
        first = self.root / "one"
        second = self.root / "two"
        first.mkdir(); second.mkdir()
        Image.new("RGB", (8, 8), "white").save(first / "first.png")
        Image.new("RGB", (8, 8), "white").save(second / "second.png")
        state = self.state()
        project = state.create_project("two sources")
        for root, relative_path in ((first, "first.png"), (second, "second.png")):
            path = root / relative_path
            stat = path.stat()
            source_id = state.workspace_store.ensure_project_source(
                project["id"], kind="native-folder", display_name=root.name, identity=str(root.resolve()),
            )
            state.workspace_store.reconcile_images(project["id"], [
                SimpleNamespace(relative_path=relative_path, size_bytes=stat.st_size,
                                mtime_ns=stat.st_mtime_ns, width=8, height=8),
            ], source_id)
        with patch.object(state.workspace_store, "hydrate_candidates_bulk", wraps=state.workspace_store.hydrate_candidates_bulk) as hydrated:
            reopened = state.open_project(project["id"])
        self.assertEqual(len(reopened["images"]), 2)
        self.assertEqual(hydrated.call_count, 1)
