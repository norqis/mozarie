"""Importing one image does not scan every image already in the source."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from mozarie.workspace import WorkspaceStore


class ImportLookupCostTests(unittest.TestCase):
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
