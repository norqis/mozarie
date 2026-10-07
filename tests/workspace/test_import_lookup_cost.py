"""Importing one image does not scan every image already in the source."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import tracemalloc
from dataclasses import replace
from unittest.mock import patch

from mozarie.workspace import WorkspaceStore
from mozarie import state as state_module
from mozarie.state import StudioState
from tests import prepare_test_app_config
from PIL import Image


class ImportLookupCostTests(unittest.TestCase):
    def make_state(self, root):
        app = root / "app"
        prepare_test_app_config(app)
        with patch.object(state_module, "APP_DIR", app):
            state = StudioState(root / "cache", root / "sessions")
        state.create_project("Import")
        return state

    def import_file(self, state, root, name, source="files"):
        staged = root / "image.upload"
        Image.new("RGB", (4, 3), "white").save(staged, format="PNG")
        return state.import_image_file_for_api(
            staged, name=name, relative_path=name, client_key=name,
            source_identity=source, source_kind="browser-directory", include_images=False, intent="add",
        )[1][0]["imageId"]

    def test_single_image_import_does_not_copy_or_sort_the_existing_catalog(self):
        costs = {}
        for count in (100, 10000):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state = self.make_state(root)
                try:
                    first = self.import_file(state, root, "00000.png")
                    template = state.images[first]
                    path_reads = 0

                    class ObservedPath(str):
                        def lower(self):
                            nonlocal path_reads
                            path_reads += 1
                            return super().lower()

                    seeded = [replace(template, image_id=f"seed-{index}", relative_path=ObservedPath(f"{index:05}.png")) for index in range(1, count)]
                    state.workspace_store.reconcile_images(state.workspace_id, seeded, template.source_id)
                    for record in seeded:
                        state.images[record.image_id] = record
                        state.order.append(record.image_id)
                        state.candidates[record.image_id] = []
                        state.candidate_revisions[record.image_id] = 0
                        state.source_mismatches[record.image_id] = False
                    tracemalloc.start()
                    try:
                        added = self.import_file(state, root, "05000a.png")
                        peak = tracemalloc.get_traced_memory()[1]
                    finally:
                        tracemalloc.stop()
                    costs[count] = (path_reads, peak)
                    self.assertEqual(len(state.order), count + 1)
                    self.assertIn(added, state.order)
                    self.assertEqual([state.images[key].relative_path for key in state.order], sorted((record.relative_path for record in state.images.values()), key=str.lower))
                finally:
                    state.shutdown()
        self.assertLessEqual(costs[10000][0], costs[100][0] + 20)
        self.assertLessEqual(costs[10000][1], costs[100][1] + 512 * 1024)

    def test_import_preserves_stable_order_for_equal_case_insensitive_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = self.make_state(root)
            try:
                first = self.import_file(state, root, "same.png", "first")
                second = self.import_file(state, root, "SAME.png", "second")
                files = []
                for index, name in enumerate(("SaMe.png", "Same.png", "a.png")):
                    staged = root / f"{index}.upload"
                    Image.new("RGB", (4, 3), "white").save(staged, format="PNG")
                    files.append({"stagedPath": staged, "name": name, "relativePath": name, "clientKey": name})
                _images, imported = state._import_images(files, source_identity="third", source_kind="browser-directory", intent="add")
                ids = {row["clientKey"]: row["imageId"] for row in imported}
                self.assertEqual(state.order, [ids["a.png"], first, second, ids["SaMe.png"], ids["Same.png"]])
            finally:
                state.shutdown()

    def test_single_image_reconciliation_cost_is_independent_of_source_size(self):
        costs = {}
        with tempfile.TemporaryDirectory() as temporary:
            for count in (100, 10000):
                store = WorkspaceStore(Path(temporary) / str(count))
                try:
                    catalog = store.create_project("Import")["id"]
                    source = store.ensure_project_source(catalog, kind="browser-files", display_name="Files", identity="browser:files")
                    records = [SimpleNamespace(relative_path=f"{index:05}.png", size_bytes=10, mtime_ns=20, width=4, height=3) for index in range(count)]
                    seeded = store.reconcile_images(catalog, records, source)
                    last = records[-1]
                    image_id = seeded[last.relative_path]["image_id"]
                    store.set_image_flags(image_id, hidden=True, reviewed=True)
                    store.set_image_transform(image_id, True, False)
                    original_connect = store._connect
                    steps = 0

                    def connect():
                        db = original_connect()

                        def tick():
                            nonlocal steps
                            steps += 100
                            return 0

                        db.set_progress_handler(tick, 100)
                        return db

                    with patch.object(store, "_connect", side_effect=connect):
                        restored = store.reconcile_images(catalog, [last], source, allow_new=False)
                    self.assertEqual(list(restored), [last.relative_path])
                    self.assertEqual(restored[last.relative_path]["image_id"], image_id)
                    self.assertTrue(restored[last.relative_path]["hidden"])
                    self.assertTrue(restored[last.relative_path]["reviewed"])
                    self.assertTrue(restored[last.relative_path]["flip_horizontal"])
                    costs[count] = steps
                finally:
                    store.shutdown()
        self.assertLessEqual(costs[10000], costs[100] + 600, "one incoming image uses indexed lookup rather than scanning the whole source")
