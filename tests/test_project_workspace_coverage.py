"""Behavioural coverage for the durable project workspace.

These cases deliberately exercise public persistence boundaries: project/source
management, reopening a project, image reconciliation, compact undo data and
corruption handling.  They are kept separate from the older workspace tests so
the project contract is readable without test-only switches in production.
"""

from __future__ import annotations

import base64
import io
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from mozarie.workspace import WorkspaceOpenError, WorkspaceStore, _chunks


class _Role:
    value = "apply"


class ProjectWorkspaceCoverageTests(unittest.TestCase):
    def record(self, path: str = "one.png", *, size: int = 10, mtime: int = 20,
               width: int = 4, height: int = 4, image_id: str | None = None):
        values = {"relative_path": path, "size_bytes": size, "mtime_ns": mtime,
                  "width": width, "height": height}
        if image_id is not None:
            values["image_id"] = image_id
        return SimpleNamespace(**values)

    @staticmethod
    def png(*, mode: str = "L", size: tuple[int, int] = (4, 4), value: int = 255,
            text: dict[str, str] | None = None) -> bytes:
        image = Image.new(mode, size, value)
        output = io.BytesIO()
        info = None
        if text:
            info = PngInfo()
            for key, content in text.items():
                info.add_text(key, content)
        image.save(output, format="PNG", pnginfo=info)
        return output.getvalue()

    def store_image(self, root: Path, *, catalog: str | None = None, record=None):
        store = WorkspaceStore(root)
        catalog = catalog or store.ensure_catalog()
        item = record or self.record()
        image_id = str(store.reconcile_images(catalog, [item])[item.relative_path]["image_id"])
        return store, catalog, image_id

    def candidate(self, root: Path, candidate_id: str = "candidate", *, enabled: bool = True,
                  expand_px: int = 0, path_exists: bool = True):
        path = root / f"{candidate_id}.png"
        if path_exists:
            path.write_bytes(self.png())
        return SimpleNamespace(candidate_id=candidate_id, label_token="hand", confidence=0.8,
                               mask_path=path, enabled=enabled, color="#123456", source="detector",
                               origin="automatic", refinement=None, role=_Role(), forced=False,
                               expand_px=expand_px)

    def test_chunks_and_mask_forms_are_validated(self):
        self.assertEqual(_chunks([]), [])
        self.assertEqual([len(chunk) for chunk in _chunks([str(n) for n in range(901)])], [900, 1])
        self.assertIsNone(WorkspaceStore._decode_png_mask(None))
        rgba = self.png(mode="RGBA", value=(1, 2, 3, 0))
        self.assertEqual(WorkspaceStore._decode_png_mask(rgba).getpixel((0, 0)), 0)
        self.assertEqual(WorkspaceStore._decode_png_mask(self.png(mode="1")).mode, "L")
        rgb = self.png(mode="RGB", value=(1, 2, 3))
        for raw in (b"bad", rgb):
            with self.subTest(raw=raw[:8]), self.assertRaisesRegex(ValueError, "mask"):
                WorkspaceStore._decode_png_mask(raw)

    def test_candidate_metadata_is_loaded_without_reading_candidate_pngs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, image_id = self.store_image(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (image_id, "a", "hand", .5, self.png(text={"mozarie_expand_px": "3"}), 1, "#fff", "s", "o", None, "apply", 0, 0))
                db.commit()
            finally:
                db.close()
            # sqlite's default tuple does not offer keys; fetch the hydrated row through store's query.
            captured = []
            store.hydrate_candidates(image_id, root, lambda row, _: captured.append(row) or row)
            self.assertEqual(captured[0]["expand_px"], 0)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE candidates SET mask_png=? WHERE image_id=?", (self.png(text={"mozarie_expand_px": "-1"}), image_id))
                db.commit()
            finally:
                db.close()
            self.assertEqual(store.hydrate_candidates(image_id, root, lambda row, _: row)[1][0]["expand_px"], 0)

    def test_catalog_source_project_listing_lifecycle_and_sorting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = WorkspaceStore(root)
            native = root / "native"; native.mkdir()
            legacy = store.catalog_for_root(native)
            self.assertTrue(store.catalog_exists(legacy))
            source = store.project_sources(legacy)[0]
            self.assertEqual(source["nativePath"], str(native.resolve()))
            self.assertEqual(store.ensure_project_source(legacy, kind="native-folder", display_name="again", identity=str(native.resolve())), source["id"])
            browser = store.ensure_project_source(legacy, kind="browser-directory", display_name="Browser", identity="handle:1")
            self.assertNotEqual(browser, source["id"])
            with self.assertRaisesRegex(ValueError, "invalid project source"):
                store.ensure_project_source(legacy, kind="bad", display_name="x", identity="x")
            with self.assertRaisesRegex(ValueError, "missing"):
                store.ensure_project_source("f" * 32, kind="browser-files", display_name="x", identity="x")
            named = store.create_project("  Zebra  ", "C:/images")
            other = store.create_project("alpha")
            self.assertEqual(named["name"], "Zebra")
            with self.assertRaisesRegex(ValueError, "already exists"):
                store.create_project("zebra")
            with self.assertRaisesRegex(ValueError, "required"):
                store.create_project(" ")
            renamed = store.name_project(other["id"], "Beta")
            self.assertEqual(renamed["name"], "Beta")
            with self.assertRaisesRegex(ValueError, "required"):
                store.name_project(other["id"], " ")
            with self.assertRaisesRegex(ValueError, "already exists"):
                store.name_project(other["id"], "zebra")
            with self.assertRaisesRegex(ValueError, "missing"):
                store.name_project("e" * 32, "x")
            self.assertEqual([item["name"] for item in store.projects("name_asc") if item["name"]], ["Beta", "Zebra"])
            self.assertEqual(store.projects("unexpected"), store.projects())
            self.assertEqual(store.set_project_status(named["id"], "completed")["status"], "completed")
            with self.assertRaisesRegex(ValueError, "status"):
                store.set_project_status(named["id"], "paused")
            with self.assertRaisesRegex(ValueError, "missing"):
                store.set_project_status("d" * 32, "working")
            store.set_project_source_root(named["id"], None)
            self.assertIsNone(store.project(named["id"])["sourceRoot"])
            self.assertEqual(store.projects_for_source_root(str(native.resolve())), [store.project(legacy)])
            self.assertEqual(store.projects_for_source_root(str(native.resolve()), legacy), [])
            store.delete_catalog(other["id"])
            self.assertIsNone(store.project(other["id"]))
            provisional = store.ensure_provisional_catalog(); store.finalize_catalog(provisional)
            self.assertTrue(store.catalog_exists(provisional))
            self.assertIsNone(store.best_catalog_for_manifest([("a.png", "x")], legacy))
            with self.assertRaisesRegex(ValueError, "catalog"):
                store.ensure_catalog("not-a-catalog")

    def test_reconcile_sources_metadata_prune_delete_and_commit_save(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, first = self.store_image(root)
            source = store.ensure_project_source(catalog, kind="browser-files", display_name="Drop", identity="drop-1")
            second_record = self.record("nested/two.png", width=5, height=6)
            second = str(store.reconcile_images(catalog, [second_record], source)[second_record.relative_path]["image_id"])
            self.assertEqual(len(store.project_images(catalog)), 2)
            self.assertEqual(store.project_image(first)["relativePath"], "one.png")
            self.assertIsNone(store.project_image("missing"))
            changed = self.record("one.png", size=11, mtime=21, width=8, height=4)
            state = store.reconcile_images(catalog, [changed])["one.png"]
            self.assertTrue(state["changed"]); self.assertTrue(state["dimensions_changed"]); self.assertFalse(state["reviewed"])
            store.accept_source_metadata([self.record("one.png", size=11, mtime=21, width=8, height=4, image_id=first)], preserve_mask_dimensions=True)
            self.assertTrue(store.reconcile_images(catalog, [changed])["one.png"]["dimensions_changed"])
            store.accept_source_metadata([self.record("one.png", size=11, mtime=21, width=8, height=4, image_id=first)])
            self.assertFalse(store.reconcile_images(catalog, [changed])["one.png"]["changed"])
            store.set_image_flags(first, hidden=True, reviewed=True)
            self.assertEqual(store.image_state(first), (True, True)); self.assertTrue(store.has_image(first))
            store.set_image_flags(first)
            store.commit_save(first, mtime_ns=30, size_bytes=31, candidate_revision=9, clear_workspace=True)
            self.assertEqual(store.reconcile_images(catalog, [self.record("one.png", size=31, mtime=30, width=8, height=4)])["one.png"]["revision"], 9)
            store.prune_catalog_images(catalog, {"one.png"})
            self.assertFalse(store.has_image(second))
            store.delete_images([]); store.delete_images([first])
            self.assertFalse(store.has_image(first))
            # The delete path is intentionally terminal and cascades project children.
            third = str(store.reconcile_images(catalog, [self.record("third.png")])["third.png"]["image_id"])
            store.commit_save(third, clear_workspace=False, delete_image=True)
            self.assertFalse(store.has_image(third))
            store.prune_catalog_images(catalog, set())
            self.assertEqual(store.project_images(catalog), [])

    def test_candidate_hydration_bulk_manual_and_export_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, first = self.store_image(root)
            second = str(store.reconcile_images(catalog, [self.record("two.png")])["two.png"]["image_id"])
            candidate = self.candidate(root, expand_px=2)
            store.commit_candidate_state(first, 1, [candidate], True, replace=True)
            self.assertEqual(store.valid_candidate_ids(first), {"candidate"})
            self.assertEqual(store.candidate_png(first, "candidate"), self.png())
            self.assertIsNone(store.candidate_png(first, "missing"))
            revision, hydrated = store.hydrate_candidates(first, root, lambda row, path: {"id": row["candidate_id"], "path": path, "expand": row["expand_px"]})
            self.assertEqual((revision, hydrated[0]["expand"]), (1, 2))
            bulk = store.hydrate_candidates_bulk([first, second, "missing"], root, lambda row, _: row["candidate_id"])
            self.assertEqual(bulk[first][1], ["candidate"]); self.assertEqual(bulk[second][1], [])
            self.assertEqual(store.hydrate_candidates_bulk([], root, lambda *_: None), {})
            payload = {"add": "add", "exclusion": "", "exclusionErase": "erase", "removedCandidateIds": ["candidate", "stale"],
                       "manualEnabled": False, "manualExclusionEnabled": False, "manualExclusionEraseEnabled": False,
                       "manualExclusionForced": False, "hasEffectiveMask": True}
            store.save_manual(first, payload, lambda value: self.png() if value else None)
            manual = store.manual(first, lambda value: base64.b64encode(value).decode() if value else "")
            self.assertEqual(manual["removedCandidateIds"], ["candidate"])
            self.assertFalse(manual["manualEnabled"])
            self.assertEqual(store.manual_mask_statuses([first]), {first: (True, 1)})
            exported = store.export_state(first)
            self.assertNotIn("_manual_raw", exported); self.assertIn("mask", exported["candidates"][0]); self.assertIn("add", exported["manual"])
            store.delete_manual([first]); self.assertIsNone(store.manual(first, lambda value: value))
            self.assertEqual(store.manual_mask_statuses([]), {})
            with self.assertRaisesRegex(ValueError, "removed"):
                store.save_manual(first, {"removedCandidateIds": "bad", "hasEffectiveMask": False}, lambda _: None)

    def test_project_export_streams_three_ordered_queries_and_one_image_payload(self):
        """Export keeps raw blobs binary and advances one ordered image at a time."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = WorkspaceStore(root); catalog = store.ensure_catalog()
            count = 400
            records = [self.record(f"4k/{index:04}.png", size=index + 1, mtime=index + 100,
                                   width=3840, height=2160) for index in range(count)]
            stored = store.reconcile_images(catalog, records)
            image_ids = [str(stored[record.relative_path]["image_id"]) for record in records]
            raw = self.png()  # deterministic small BLOB; dimensions model 4K source metadata.
            db = sqlite3.connect(store.path)
            try:
                db.executemany("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                    [(image_id, "candidate", "hand", .8, raw, 1, "#112233", "detector", "automatic", None, "apply", 0)
                     for image_id in image_ids])
                db.executemany("""INSERT INTO manual_edits(image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                    exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,has_effective_mask,history_json,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [(image_id, raw, raw, raw, 1, 1, 1, 1, "[]", 0, 1, "{}", index + 1)
                     for index, image_id in enumerate(image_ids)])
                db.commit()
            finally:
                db.close()
            traced: list[str] = []
            original_connect = store._connect
            def tracked_connect():
                connection = original_connect()
                connection.set_trace_callback(traced.append)
                return connection
            started = time.perf_counter()
            with patch.object(store, "_connect", side_effect=tracked_connect):
                iterator = store.iter_project_export_states(catalog)
                first = next(iterator)
                first_yield = time.perf_counter() - started
                yielded = 1
                for item in iterator:
                    # The caller composes and releases one image before asking
                    # for the next.  Keeping only this reference makes the
                    # bounded-BLOB contract deterministic in the fixture too.
                    self.assertEqual(len(item["candidates"]), 1)
                    self.assertEqual(item["manual"]["add"], raw)
                    yielded += 1
            selects = [sql for sql in traced if sql.lstrip().upper().startswith("SELECT")]
            self.assertLess(first_yield, 1.0, f"first ZIP source item took {first_yield:.3f}s")
            self.assertEqual(len(selects), 3)
            self.assertEqual(yielded, count)
            self.assertEqual(len(first["candidates"]), 1)
            self.assertEqual(first["manual"]["add"], raw)
            # Each yielded state owns only its current candidate/manual payload;
            # there is no all-project BLOB map or base64 copy in this iterator.
            self.assertEqual(len(first["candidates"]), 1)

    def test_incremental_manual_save_decodes_only_dirty_roi_and_restores_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, image_id = self.store_image(root)
            base = self.png(size=(8, 8), value=0)
            changed_image = Image.open(io.BytesIO(base)); changed_image.putpixel((3, 4), 255)
            output = io.BytesIO(); changed_image.save(output, format="PNG"); changed = output.getvalue()
            initial = {"add": "add", "exclusion": "exclusion", "exclusionErase": "erase", "removedCandidateIds": [],
                       "hasEffectiveMask": True}
            store.save_manual(image_id, initial, lambda _: base)
            decoded: list[str | None] = []
            incremental = {"add": "changed", "dirtyLayers": ["add"],
                           "dirtyRois": {"add": {"left": 3, "top": 4, "right": 4, "bottom": 5}},
                           "removedCandidateIds": [], "hasEffectiveMask": True}
            def decoder(value):
                decoded.append(value)
                return changed if value == "changed" else None
            store.save_manual(image_id, incremental, decoder)
            self.assertEqual(decoded, ["changed"])
            db = sqlite3.connect(store.path)
            try:
                delta = json.loads(db.execute("SELECT delta_json FROM history_entries WHERE image_id=? ORDER BY entry_id DESC LIMIT 1", (image_id,)).fetchone()[0])
            finally:
                db.close()
            self.assertEqual(set(delta["manual"]), {"add"})
            self.assertEqual(delta["manual"]["add"]["box"], [3, 4, 1, 1])
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertEqual(store.manual(image_id, lambda value: value)["add"], base)
            self.assertEqual(store.restore_history(image_id, "redo"), [image_id])
            self.assertEqual(store.manual(image_id, lambda value: value)["add"], changed)
            reopened = WorkspaceStore(root)
            restored = reopened.manual(image_id, lambda value: value)
            self.assertEqual((restored["add"], restored["exclusion"], restored["exclusionErase"]), (changed, base, base))

    def test_history_delta_validation_gc_groups_and_atomicity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, image_id = self.store_image(root)
            self.assertIsNone(WorkspaceStore._pack_blob(None)); self.assertEqual(WorkspaceStore._unpack_blob(WorkspaceStore._pack_blob(b"x")), b"x")
            for value in (5, "%%"):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._unpack_blob(value)
            one = self.png(size=(4, 4), value=0); two = self.png(size=(4, 4), value=0)
            image = Image.open(io.BytesIO(two)); image.putpixel((1, 1), 255); data = io.BytesIO(); image.save(data, format="PNG"); two = data.getvalue()
            change = WorkspaceStore._manual_xor(one, two)
            self.assertIsNotNone(change)
            self.assertEqual(WorkspaceStore._apply_manual_xor(one, change, forward=True), two)
            self.assertIsNone(WorkspaceStore._apply_manual_xor(one, {"existsBefore": False, "existsAfter": False, "box": None}, forward=True))
            for malformed in ({"existsAfter": True, "existsBefore": False, "box": [0]}, {"existsAfter": True, "existsBefore": False, "box": [9, 0, 1, 1], "size": [4, 4], "png": WorkspaceStore._pack_blob(self.png())}):
                with self.subTest(malformed=malformed), self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._apply_manual_xor(None, malformed, forward=True)
            with self.assertRaisesRegex(ValueError, "dimensions"):
                WorkspaceStore._manual_xor(self.png(size=(2, 2)), self.png(size=(3, 3)))
            before = store.history_state(image_id)
            store.set_image_flags(image_id, hidden=True)
            self.assertTrue(store.history_status(image_id)["canUndo"])
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertEqual(store.restore_history(image_id, "redo"), [image_id])
            with self.assertRaisesRegex(ValueError, "direction"):
                store.restore_history(image_id, "sideways")
            group = store.begin_history_group()
            store.clear_image_workspaces({image_id: 2}, history_group=group)
            self.assertFalse(store.history_status(image_id)["canUndo"])
            store.finish_history_group(group, failed=True)
            self.assertTrue(store.history_status(image_id)["canUndo"])
            store.finish_history_group("not-present")
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            with patch.object(store, "_record_history_db", side_effect=sqlite3.OperationalError("no history")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.set_image_flags(image_id, reviewed=True)
            self.assertEqual(store.image_state(image_id), (True, False))
            with self.assertRaisesRegex(ValueError, "image is missing"):
                store.history_state("missing")
            self.assertEqual(store.history_status("missing"), {"canUndo": False, "canRedo": False})
            self.assertTrue(before["catalog"] == catalog)

    def test_reopen_schema_corruption_is_rejected_without_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = WorkspaceStore(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TABLE history_cursors")
                db.commit()
            finally:
                db.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(WorkspaceOpenError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / "workspaces.sqlite3"; path.write_bytes(b"not sqlite")
            with self.assertRaisesRegex(WorkspaceOpenError, "cannot be opened"):
                WorkspaceStore(root)

    def test_workspace_edge_cases_and_transaction_rollbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, image_id = self.store_image(root)
            self.assertEqual(store.reconcile_images(catalog, []), {})
            self.assertEqual(store.image_state("missing"), (False, False)); self.assertFalse(store.has_image("missing"))
            store.accept_source_metadata([]); store.clear_image_workspaces({})
            with self.assertRaisesRegex(ValueError, "source is missing"):
                store.reconcile_images(catalog, [self.record("bad.png")], "no-source")
            with patch.object(store, "_history_state_db", side_effect=RuntimeError("stop")):
                with self.assertRaisesRegex(RuntimeError, "stop"):
                    store.clear_image_workspaces({image_id: 1})
            self.assertTrue(store.has_image(image_id))
            with patch.object(store, "_connect", side_effect=sqlite3.OperationalError("down")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.delete_catalog(catalog)
            # Candidate failures roll back the revision and do not keep half rows.
            missing = self.candidate(root, "missing", path_exists=False)
            store.commit_candidate_state(image_id, 1, [missing], False, replace=True)
            self.assertEqual(store.hydrate_candidates(image_id, root, lambda *_: None), (1, []))
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE manual_edits SET removed_candidate_ids='not-json' WHERE image_id=?", (image_id,))
                db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "removed"):
                store.commit_candidate_state(image_id, 2, [], False, replace=False)

    def test_history_invalid_records_are_rejected_and_redo_groups_are_collected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, image_id = self.store_image(root)
            candidate = self.candidate(root)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            store.set_image_flags(image_id, hidden=True)
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            # A new edit removes the abandoned redo entry and references.
            store.set_image_flags(image_id, reviewed=True)
            db = sqlite3.connect(store.path)
            try:
                count = db.execute("SELECT COUNT(*) FROM history_entries WHERE image_id=?", (image_id,)).fetchone()[0]
            finally:
                db.close()
            self.assertGreaterEqual(count, 1)
            with self.assertRaisesRegex(ValueError, "history"):
                WorkspaceStore._history_candidate_ids({"candidates": "bad"})
            with self.assertRaisesRegex(ValueError, "history"):
                WorkspaceStore._history_candidate_ids({"candidates": [{"id": ""}]})
            db = store._connect()
            try:
                with self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._restore_history_state(db, image_id, {"candidates": []}, {}, forward=True)
                for state in ({"candidates": [], "revision": True}, {"candidates": ["bad"], "revision": 1},
                              {"candidates": [{"id": "x", "label": "a", "color": "#", "source": "s", "origin": "o", "role": "apply"}], "revision": 1},
                              {"candidates": [], "revision": 1, "manual": "bad"},
                              {"candidates": [], "revision": 1, "flags": {"hidden": "bad"}}):
                    with self.assertRaisesRegex(ValueError, "history"):
                        WorkspaceStore._restore_history_state(db, image_id, state, {}, forward=True)
            finally:
                db.close()

    def test_mask_decode_and_candidate_row_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, image_id = self.store_image(root)
            # The fallback form is used only for old rows that predate metadata.
            db = store._connect()
            try:
                row = db.execute("SELECT mask_png FROM (SELECT ? AS mask_png)", (self.png(text={"mozarie_expand_px": "4"}),)).fetchone()
                self.assertEqual(WorkspaceStore._candidate_row(row)["expand_px"], 4)
                for raw in (1, self.png(text={"mozarie_expand_px": "abc"})):
                    bad = db.execute("SELECT ? AS mask_png", (raw,)).fetchone()
                    with self.assertRaisesRegex(ValueError, "candidate"):
                        WorkspaceStore._candidate_row(bad)
            finally:
                db.close()
            with patch("mozarie.workspace.Image.open", side_effect=OSError("bad image")):
                with self.assertRaisesRegex(ValueError, "mask"):
                    WorkspaceStore._decode_png_mask(self.png())
            with patch("mozarie.workspace.Image.open") as opening:
                fake = opening.return_value.__enter__.return_value
                fake.format = "PNG"; fake.mode = "RGB"
                with self.assertRaisesRegex(ValueError, "alpha"):
                    WorkspaceStore._decode_png_mask(self.png())
            with patch("mozarie.workspace.Image.open") as opening:
                fake = opening.return_value.__enter__.return_value
                fake.format = "GIF"
                with self.assertRaisesRegex(ValueError, "mask"):
                    WorkspaceStore._decode_png_mask(self.png())
            # A corrupt BLOB remains excluded from fast validity checks.
            db = sqlite3.connect(store.path)
            try:
                db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (image_id, "bad", "hand", .5, b"bad", 1, "#", "s", "o", None, "apply", 0, 0))
                db.commit()
            finally:
                db.close()
            self.assertEqual(store.valid_candidate_ids(image_id), set())

    def test_all_public_empty_and_failure_boundaries_roll_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, image_id = self.store_image(root)
            # Every mutation below enters its transaction before the malformed
            # record fails; no partial source/image state is retained.
            with self.assertRaises(AttributeError):
                store.accept_source_metadata([object()])
            self.assertTrue(store.has_image(image_id))
            with patch("mozarie.workspace._chunks", return_value=[[object()]]):
                with self.assertRaises(sqlite3.ProgrammingError):
                    store.delete_images([image_id])
            with self.assertRaises(sqlite3.ProgrammingError):
                store.prune_catalog_images(catalog, {object()})
            with self.assertRaises(sqlite3.ProgrammingError):
                store.commit_save(image_id, mtime_ns=1, size_bytes=object(), clear_workspace=False)
            self.assertTrue(store.has_image(image_id))
            store.delete_manual([])
            self.assertEqual(store.hydrate_candidates("missing", root, lambda *_: None), (0, []))
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE images SET candidate_revision=3 WHERE image_id=?", (image_id,))
                db.commit()
            finally:
                db.close()
            self.assertEqual(store.hydrate_candidates(image_id, root, lambda *_: None), (3, []))
            self.assertEqual(store.export_state(image_id)["manual"], None)
            # Same candidate IDs update metadata without rereading detector PNGs.
            first = self.candidate(root, expand_px=1)
            store.commit_candidate_state(image_id, 4, [first], True, replace=True)
            changed = self.candidate(root, expand_px=9, enabled=False, path_exists=False)
            store.commit_candidate_state(image_id, 5, [changed], True, replace=True)
            self.assertEqual(store.hydrate_candidates(image_id, root, lambda row, _: row["expand_px"])[1], [9])
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE candidates SET mask_png=? WHERE image_id=?", (1, image_id))
                db.commit()
            finally:
                db.close()
            self.assertEqual(store.hydrate_candidates_bulk([image_id], root, lambda *_: None)[image_id][0], 5)

    def test_history_failure_and_group_readiness_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, first = self.store_image(root)
            second = str(store.reconcile_images(store.history_state(first)["catalog"], [self.record("two.png")])["two.png"]["image_id"])
            before = store.history_state(first)
            store.record_history(first, before, before)
            with self.assertRaisesRegex(ValueError, "missing"):
                store.record_history("missing", {**before, "flags": {"hidden": True, "reviewed": False}}, before)
            group = store.begin_history_group()
            store.set_image_flags(first, hidden=True)
            store.set_image_flags(second, reviewed=True)
            # A building group cannot be restored, and cursors that diverge
            # deliberately make a completed batch unavailable.
            before_a, before_b = store.history_state(first), store.history_state(second)
            store.record_history(first, before_a, {**before_a, "flags": {"hidden": False, "reviewed": False}}, group_id=group)
            store.record_history(second, before_b, {**before_b, "flags": {"hidden": True, "reviewed": False}}, group_id=group)
            self.assertEqual(store.restore_history(first, "undo"), [])
            store.finish_history_group(group)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE history_cursors SET entry_id=NULL WHERE image_id=?", (second,)); db.commit()
            finally:
                db.close()
            self.assertFalse(store.history_status(first)["canUndo"])
            db = sqlite3.connect(store.path)
            try:
                group_entry = db.execute("SELECT entry_id FROM history_entries WHERE group_id=? AND image_id=?", (group, second)).fetchone()[0]
                db.execute("UPDATE history_cursors SET entry_id=? WHERE image_id=?", (group_entry, second)); db.commit()
            finally:
                db.close()
            self.assertEqual(set(store.restore_history(first, "undo")), {first, second})
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE history_cursors SET entry_id=NULL WHERE image_id=?", (second,)); db.commit()
            finally:
                db.close()
            self.assertFalse(store.history_status(first)["canRedo"])
            self.assertEqual(store.restore_history(first, "redo"), [])

    def test_remaining_storage_error_and_corruption_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, catalog, image_id = self.store_image(root)
            # Test the delete transaction's rollback after BEGIN succeeds.
            original_connect = store._connect
            class DeleteFailure:
                def __init__(self, connection): self.connection = connection
                def __enter__(self): self.connection.__enter__(); return self
                def __exit__(self, *args): return self.connection.__exit__(*args)
                def __getattr__(self, name): return getattr(self.connection, name)
                def execute(self, sql, *args):
                    if sql.startswith("DELETE FROM catalogs"):
                        raise sqlite3.OperationalError("delete failed")
                    return self.connection.execute(sql, *args)
            store._connect = lambda: DeleteFailure(original_connect())  # type: ignore[method-assign]
            with self.assertRaisesRegex(sqlite3.OperationalError, "delete failed"):
                store.delete_catalog(catalog)
            store._connect = original_connect  # type: ignore[method-assign]
            self.assertTrue(store.catalog_exists(catalog))
            # An invalid stored removal list is rejected before it can alter a
            # candidate revision.
            store.save_manual(image_id, {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": False}, lambda _: None)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE manual_edits SET removed_candidate_ids='[1]' WHERE image_id=?", (image_id,)); db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "removed"):
                store.commit_candidate_state(image_id, 1, [], False, replace=False)
            self.assertIsNone(WorkspaceStore._unpack_blob(None))
            identical = self.png()
            self.assertIsNone(WorkspaceStore._manual_xor(identical, identical))
            valid_change = {"existsBefore": True, "existsAfter": True, "box": [0, 0, 1, 1], "size": [4, 4], "png": WorkspaceStore._pack_blob(self.png(size=(1, 1)))}
            for raw, expected in ((self.png(size=(3, 3)), "history"),):
                with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, expected):
                    WorkspaceStore._apply_manual_xor(raw, valid_change, forward=True)
            mismatch = {**valid_change, "png": WorkspaceStore._pack_blob(self.png(size=(2, 2)))}
            with self.assertRaisesRegex(ValueError, "history"):
                WorkspaceStore._apply_manual_xor(None, mismatch, forward=True)
            # Redoing a batch and then editing creates a stale group; its rows
            # and candidate references are collected together.
            group = store.begin_history_group()
            store.clear_image_workspaces({image_id: 2}, history_group=group)
            store.finish_history_group(group)
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            store.set_image_flags(image_id, hidden=True)
            db = sqlite3.connect(store.path)
            try:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM history_groups WHERE group_id=?", (group,)).fetchone()[0], 0)
            finally:
                db.close()

    def test_restore_rejects_all_invalid_history_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store, _, image_id = self.store_image(root)
            candidate = self.candidate(root)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            db = store._connect()
            try:
                base = store._history_state_db(db, image_id)
                invalid = {"candidates": "not-list"}
                with self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._restore_history_state(db, image_id, invalid, {}, forward=True)
                needs_strings = {**base, "candidates": [{**base["candidates"][0], "label": 3}]}
                with self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._restore_history_state(db, image_id, needs_strings, {}, forward=True)
                bad_expand = {**base, "candidates": [{**base["candidates"][0], "expandPx": True}]}
                with self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._restore_history_state(db, image_id, bad_expand, {}, forward=True)
                bad_manual = {**base, "manual": {"removed": 1}}
                with self.assertRaisesRegex(ValueError, "history"):
                    WorkspaceStore._restore_history_state(db, image_id, bad_manual, {}, forward=True)
            finally:
                db.close()
            # A still-building entry cannot be restored.  Once committed,
            # malformed journal JSON is rejected and rolled back.
            store.set_image_flags(image_id, reviewed=True)
            building = store.begin_history_group(); store.clear_image_workspaces({image_id: 2}, history_group=building)
            self.assertEqual(store.restore_history(image_id, "undo"), [])
            store.finish_history_group(building)
            self.assertEqual(store.restore_history(image_id, "undo"), [image_id])
            self.assertTrue(store.history_status(image_id)["canRedo"])
            db = sqlite3.connect(store.path)
            try:
                entry = db.execute("SELECT entry_id FROM history_entries WHERE image_id=? ORDER BY entry_id DESC LIMIT 1", (image_id,)).fetchone()[0]
                db.execute("UPDATE history_entries SET delta_json='not json' WHERE entry_id=?", (entry,)); db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "history"):
                store.restore_history(image_id, "redo")
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE history_entries SET delta_json='[]' WHERE entry_id=?", (entry,)); db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "history"):
                store.restore_history(image_id, "redo")
            # Persisted browser-only history must also fail with the same stable error.
            store.save_manual(image_id, {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "hasEffectiveMask": False}, lambda _: None)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE manual_edits SET history_json='not json' WHERE image_id=?", (image_id,)); db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "history"):
                store.manual(image_id, lambda value: value)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE manual_edits SET history_json='[]' WHERE image_id=?", (image_id,)); db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "history"):
                store.manual(image_id, lambda value: value)
            self.assertEqual(store.restore_history("missing", "undo"), [])
            self.assertEqual(store.restore_history("missing", "redo"), [])


if __name__ == "__main__":
    unittest.main()
