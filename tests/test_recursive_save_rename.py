import tempfile
import threading
import unittest
import base64
import io
import shutil
import sqlite3
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import BrowserSaveToken, ClientError, ImageRecord
from mozarie.domain import Candidate, CandidateRole
from mozarie.saving import SavingMixin
from mozarie.save_journal import SaveJournal
from mozarie.state import StudioState
from mozarie.workspace import WorkspaceStore


class _SavingState(SavingMixin):
    def __init__(self, record: ImageRecord, output: Path):
        self.lock = threading.RLock(); self.output_destination_lock = threading.RLock()
        self.settings = {"saving": {"default_output_directory": str(output), "parallelism": 1, "preserve_directory_structure": False}}
        self.catalog_generation = 1; self.images = {record.image_id: record}; self.reserved_output_paths = set()
        self._start_job = Mock()

    def _assert_catalog_mutable(self): pass
    def _records_for_ids_with_catalog(self, ids): return [self.images[image_id] for image_id in ids], 1


class RecursiveSaveTests(unittest.TestCase):
    def test_copy_uses_edited_basename_before_format_and_suffix(self):
        record = ImageRecord("one", Path("C:/source.png"), "nested/source.png", 1, 1, 1, 1, edited_filename="edited.png")
        self.assertEqual(
            _SavingState._copy_relative_path(record, "_done", "jpg", True).as_posix(),
            "nested/edited_done.jpg",
        )

    def test_flatten_collision_stops_before_output_probe_or_job(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); output = root / "output"; output.mkdir()
            first = root / "a.png"; first.write_bytes(b"a")
            record = ImageRecord("one", first, "nested/a.png", 1, 1, 1, 1)
            state = _SavingState(record, output)
            (output / "a_censored.png").write_bytes(b"existing")
            with patch("mozarie.saving.validate_output_directory_ready") as ready:
                with self.assertRaisesRegex(ClientError, "平坦化"):
                    state.start_apply([record.image_id], 10, {}, copy_to_default=True)
            ready.assert_not_called(); state._start_job.assert_not_called()

    def test_flatten_reservation_never_renumbers_a_raced_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); output = root / "output"; output.mkdir()
            source = root / "a.png"; source.write_bytes(b"a")
            record = ImageRecord("one", source, "nested/a.png", 1, 1, 1, 1)
            state = _SavingState(record, output)
            (output / "a_censored.png").write_bytes(b"raced")
            with self.assertRaisesRegex(ClientError, "平坦化"):
                state._reserve_output_destination(record, "_censored", output, "original", False)

    def test_flatten_selected_set_collision_after_format_and_suffix_has_no_output_probe(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); output = root / "output"; output.mkdir()
            first = root / "one.png"; second = root / "two.jpeg"; first.write_bytes(b"a"); second.write_bytes(b"b")
            first_record = ImageRecord("one", first, "first/shared.PNG", 1, 1, 1, 1)
            second_record = ImageRecord("two", second, "second/shared.jpeg", 1, 1, 1, 1)
            state = _SavingState(first_record, output); state.images[second_record.image_id] = second_record
            with patch("mozarie.saving.validate_output_directory_ready") as ready:
                with self.assertRaisesRegex(ClientError, "平坦化"):
                    state.start_apply(["one", "two"], 10, {}, copy_to_default=True, output_format="jpg", suffix="_done", keep_metadata=False)
            ready.assert_not_called(); state._start_job.assert_not_called()

    def test_flatten_publish_race_never_reassigns_the_final_name(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); source = root / "source.png"; Image.new("RGB", (8, 8), "white").save(source)
            app_dir = root / "app"; shutil.copytree(Path(__file__).resolve().parents[1] / "config", app_dir / "config")
            with patch.object(state_module, "APP_DIR", app_dir):
                state = StudioState(root / "cache", root / "sessions")
            try:
                state.settings["models"]["provider"] = "cpu"
                record = state.image_for_id(state.set_root(str(root))[0]["id"])
                output = root / "output"; state.settings["saving"].update({"default_output_directory": str(output), "preserve_directory_structure": False})
                with patch.object(state, "_publish_staged_copy", return_value=None), patch.object(state, "_reassign_output_destination") as reassign:
                    state._apply_worker([record], 10, {}, copy_to_default=True, output_directory=output, preserve_directory_structure=False)
                reassign.assert_not_called()
                self.assertEqual(state.job.state, "error")
            finally:
                state.shutdown()


class WorkspaceRenameTests(unittest.TestCase):
    def test_original_save_retargets_native_aliases_and_keeps_alias_edit(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve(); outer = root / "outer"; nested = outer / "nested"; nested.mkdir(parents=True)
            old = nested / "old.png"; new = nested / "saved.png"; old.write_bytes(b"old"); new.write_bytes(b"saved")
            store = WorkspaceStore(root / "data")
            with store._connect() as db:
                for catalog, source, folder, image, relative, edited in (
                    ("one", "outer-source", outer, "target", "nested/old.png", "saved.png"),
                    ("two", "nested-source", nested, "alias", "old.png", "alias-output.png"),
                ):
                    db.execute("INSERT INTO catalogs VALUES(?,?,?,?,?,?)", (catalog, catalog, "working", str(folder), 1, 1))
                    db.execute("INSERT INTO project_sources VALUES(?,?,?,?,?,?,?)", (source, catalog, "native-folder", folder.name, str(folder), str(folder), 1))
                    db.execute("""INSERT INTO images(catalog_id,source_id,relative_path,image_id,size_bytes,mtime_ns,width,height,edited_filename,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?)""", (catalog, source, relative, image, 1, 1, 1, 1, edited, 1))
                db.execute("INSERT INTO image_transforms VALUES(?,?,?,?,?,?)", ("alias", 1, 0, 0, 0, 3))
            changed = store.commit_save("target", mtime_ns=2, size_bytes=5, clear_workspace=False,
                                        clear_edited_filename=True, native_source_old_path=old, native_source_new_path=new,
                                        native_source_flip_horizontal=True)
            self.assertEqual(changed, {"target": "nested/saved.png", "alias": "saved.png"})
            with store._connect() as db:
                rows = {row["image_id"]: row for row in db.execute("SELECT image_id,relative_path,edited_filename,mtime_ns,size_bytes FROM images")}
            self.assertEqual(rows["target"]["relative_path"], "nested/saved.png"); self.assertIsNone(rows["target"]["edited_filename"])
            self.assertEqual(rows["alias"]["relative_path"], "saved.png"); self.assertEqual(rows["alias"]["edited_filename"], "alias-output.png")
            self.assertEqual((rows["alias"]["mtime_ns"], rows["alias"]["size_bytes"]), (2, 5))
            with store._connect() as db:
                transform = tuple(db.execute("SELECT flip_horizontal,source_flip_horizontal FROM image_transforms WHERE image_id='alias'").fetchone())
            self.assertEqual(transform, (1, 1))

    def test_nested_native_roots_retarget_one_actual_file_without_new_ids(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); outer = root / "outer"; nested = outer / "nested"; nested.mkdir(parents=True)
            old = nested / "old.png"; old.write_bytes(b"x"); new = nested / "new.png"; old.rename(new)
            store = WorkspaceStore(root / "data")
            with store._connect() as db:
                db.execute("INSERT INTO catalogs VALUES(?,?,?,?,?,?)", ("one", "one", "working", str(outer), 1, 1))
                db.execute("INSERT INTO catalogs VALUES(?,?,?,?,?,?)", ("two", "two", "working", str(nested), 1, 1))
                db.execute("INSERT INTO project_sources VALUES(?,?,?,?,?,?,?)", ("outer-source", "one", "native-folder", "outer", str(outer), str(outer), 1))
                db.execute("INSERT INTO project_sources VALUES(?,?,?,?,?,?,?)", ("nested-source", "two", "native-folder", "nested", str(nested), str(nested), 1))
                for catalog, source, image, relative in (("one", "outer-source", "image-one", "nested/old.png"), ("two", "nested-source", "image-two", "old.png")):
                    db.execute("INSERT INTO images(catalog_id,source_id,relative_path,image_id,size_bytes,mtime_ns,width,height,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", (catalog, source, relative, image, 1, 1, 1, 1, 1))
            changed = store.rename_native_source_records(old, new)
            self.assertEqual(changed, {"image-one": "nested/new.png", "image-two": "new.png"})
            with store._connect() as db:
                self.assertEqual({tuple(row) for row in db.execute("SELECT image_id,relative_path FROM images")}, {("image-one", "nested/new.png"), ("image-two", "new.png")})
            reopened = WorkspaceStore(root / "data")
            with reopened._connect() as db:
                self.assertEqual({tuple(row) for row in db.execute("SELECT image_id,relative_path FROM images")}, {("image-one", "nested/new.png"), ("image-two", "new.png")})


class RenameJournalTests(unittest.TestCase):
    def test_prepared_rename_is_recovered_after_the_file_move(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); old = root / "old.png"; new = root / "new.png"; old.write_bytes(b"x")
            journal = SaveJournal(root); journal.prepare_rename("rename", kind="native", image_id="image", old_path=old, new_path=new, identity=journal.file_identity(old))
            old.rename(new)
            recovered: list[dict[str, object]] = []
            journal.recover_renames(lambda row: recovered.append(row) or True)
            self.assertEqual([str(row["token"]) for row in recovered], ["rename"])
            with journal._connection() as db:
                self.assertIsNone(db.execute("SELECT token FROM rename_operations WHERE token='rename'").fetchone())

    def test_unlink_cleans_only_an_empty_staging_parent(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); output = root / "output"; output.mkdir(); ordinary = output / "final.png"; ordinary.write_bytes(b"x")
            self.assertTrue(SaveJournal._unlink(str(ordinary)))
            self.assertTrue(output.exists(), "ordinary output parents are never removed")
            staging = root / ".mozarie-staging"; staging.mkdir(); target = staging / "stage.png"; target.write_bytes(b"x")
            self.assertTrue(SaveJournal._unlink(str(target)))
            self.assertFalse(staging.exists(), "an emptied dedicated staging parent is removed")

    def test_unlink_missing_or_windows_owned_stage_cleans_empty_parent_only(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            missing_parent = root / ".mozarie-staging"; missing_parent.mkdir()
            self.assertTrue(SaveJournal._unlink(str(missing_parent / "missing.png")))
            self.assertFalse(missing_parent.exists())
            staging = root / ".mozarie-staging"; staging.mkdir(); target = staging / "stage.png"; target.write_bytes(b"x")
            def delete_owned(path, _identity):
                path.unlink(); return True
            with patch("mozarie.save_journal.os.name", "nt"), patch.object(SaveJournal, "file_identity", return_value="owned"), patch.object(SaveJournal, "_delete_windows_owned", side_effect=delete_owned):
                self.assertTrue(SaveJournal._unlink(str(target), identity="owned"))
            self.assertFalse(staging.exists())
            active = root / ".mozarie-staging"; active.mkdir(); target = active / "stage.png"; target.write_bytes(b"x"); (active / "other").write_bytes(b"x")
            self.assertTrue(SaveJournal._unlink(str(target)))
            self.assertTrue(active.exists(), "active staging content is retained")


class StudioStateNativeRenameTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.root = Path(self.temporary.name)
        self.app_dir = self.root / "app"; shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self.source_root = self.root / "sources"; self.source_root.mkdir()
        self.source = self.source_root / "nested" / "source.png"; self.source.parent.mkdir(); Image.new("RGB", (8, 8), "white").save(self.source)
        self.states: list[StudioState] = []

    def tearDown(self):
        for state in self.states: state.shutdown()
        self.temporary.cleanup()

    def state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(self.root / "cache", self.root / "sessions")
        self.states.append(state); return state

    @staticmethod
    def _mask() -> str:
        data = io.BytesIO(); Image.new("L", (8, 8), 255).save(data, format="PNG")
        return "data:image/png;base64," + base64.b64encode(data.getvalue()).decode("ascii")

    def _loaded_state(self) -> tuple[StudioState, str, str]:
        state = self.state(); project = state.create_project("rename regression")
        image_id = state.set_root(str(self.source_root))[0]["id"]
        candidate_path = state.cache_dir / image_id / "candidate.png"; candidate_path.parent.mkdir(parents=True, exist_ok=True); candidate_path.write_bytes(base64.b64decode(self._mask().split(",", 1)[1]))
        candidate = Candidate("candidate", "penis", .9, candidate_path, role=CandidateRole.APPLY, source="auto")
        with state.image_io_lock(image_id):
            with state.lock: state._commit_candidate_snapshot(image_id, [candidate], replace=True)
        state.save_manual_workspace(image_id, {"add": self._mask(), "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True, "manualExclusionForced": True})
        state.set_image_transform(image_id, {"flipH": True, "flipV": False})
        state.set_image_flags(image_id, {"hidden": True, "reviewed": True})
        return state, str(project["id"]), str(image_id)

    def test_edited_name_original_overwrite_without_mask_is_not_no_effect(self):
        state = self.state(); project = state.create_project("save edited name")
        image_id = state.set_root(str(self.source_root))[0]["id"]
        state.rename_catalog_image(image_id, "saved.png")
        state.reserve_browser_save(image_id, 0, "edited-save", copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        rendered = state.render_browser_save(image_id, 0, 100, None, client_save_token="edited-save", output_format="original", keep_metadata=True)
        self.assertFalse(rendered.no_effect)
        committed = state.commit_browser_save(image_id, 0, rendered.save_token, "overwrite")
        self.assertEqual(committed["sourceAction"], "overwrite")
        self.assertFalse(self.source.exists()); self.assertTrue((self.source.parent / "saved.png").exists())
        saved = state.image_for_id(image_id)
        self.assertEqual(saved.relative_path, "nested/saved.png"); self.assertIsNone(saved.edited_filename)
        reopened = self.state(); reopened.open_project(str(project["id"]))
        self.assertEqual(reopened.image_for_id(image_id).relative_path, "nested/saved.png")
        self.assertIsNone(reopened.image_for_id(image_id).edited_filename)

    def test_edited_name_original_overwrite_uses_selected_format(self):
        state = self.state(); state.create_project("save edited format")
        image_id = state.set_root(str(self.source_root))[0]["id"]
        state.rename_catalog_image(image_id, "saved.png")
        state.reserve_browser_save(image_id, 0, "edited-format", copy_to_default=False, suffix="_censored", output_format="jpg", keep_metadata=False)
        rendered = state.render_browser_save(image_id, 0, 100, None, client_save_token="edited-format", output_format="jpg", keep_metadata=False)
        self.assertFalse(rendered.no_effect)
        state.commit_browser_save(image_id, 0, rendered.save_token, "overwrite")
        self.assertFalse(self.source.exists()); self.assertTrue((self.source.parent / "saved.jpg").exists())
        saved = state.image_for_id(image_id)
        self.assertEqual(saved.relative_path, "nested/saved.jpg"); self.assertIsNone(saved.edited_filename)

    def test_edited_name_keeps_jpeg_and_png_casing_for_copy_and_original_overwrite(self):
        jpeg = self.source.parent / "original.jpeg"; Image.new("RGB", (8, 8), "white").save(jpeg, format="JPEG")
        state = self.state(); state.create_project("save edited casing")
        images = {image["relativePath"]: image["id"] for image in state.set_root(str(self.source_root))}
        jpeg_id = images["nested/original.jpeg"]
        state.rename_catalog_image(jpeg_id, "new.jpeg")
        state.reserve_browser_save(jpeg_id, 0, "jpeg-casing", copy_to_default=False, suffix="_censored", output_format="jpg", keep_metadata=False)
        rendered = state.render_browser_save(jpeg_id, 0, 100, None, client_save_token="jpeg-casing", output_format="jpg", keep_metadata=False)
        state.commit_browser_save(jpeg_id, 0, rendered.save_token, "overwrite")
        self.assertFalse(jpeg.exists())
        with Image.open(jpeg.with_name("new.jpeg")) as saved:
            self.assertEqual(saved.format, "JPEG")
        public_jpeg = next(image for image in state.catalog_snapshot()["images"] if image["id"] == jpeg_id)
        self.assertEqual((public_jpeg["relativePath"], public_jpeg["editedFilename"]), ("nested/new.jpeg", None))

        png_id = images["nested/source.png"]
        state.rename_catalog_image(png_id, "new.PNG")
        output = self.root / "output"; output.mkdir(); state.settings["saving"]["default_output_directory"] = str(output)
        state.reserve_browser_save(png_id, 0, "png-copy-casing", copy_to_default=True, suffix="_copy", output_format="original", keep_metadata=True)
        copied = state.render_browser_save(png_id, 0, 100, None, client_save_token="png-copy-casing", copy_to_default=True, output_format="original", keep_metadata=True)
        state.commit_browser_save(png_id, 0, copied.save_token, "keep")
        self.assertTrue((output / "nested" / "new_copy.PNG").is_file())
        self.assertEqual(state.image_for_id(png_id).edited_filename, "new.PNG")
        state.reserve_browser_save(png_id, 0, "png-overwrite-casing", copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        rendered = state.render_browser_save(png_id, 0, 100, None, client_save_token="png-overwrite-casing", output_format="original", keep_metadata=True)
        state.commit_browser_save(png_id, 0, rendered.save_token, "overwrite")
        self.assertFalse(self.source.exists())
        self.assertTrue(self.source.with_name("new.PNG").is_file())
        with Image.open(self.source.with_name("new.PNG")) as saved:
            self.assertEqual(saved.format, "PNG")
        self.assertEqual(state.image_for_id(png_id).relative_path, "nested/new.PNG")

    def test_edited_name_collision_keeps_original_and_edit(self):
        state = self.state(); state.create_project("save collision")
        image_id = state.set_root(str(self.source_root))[0]["id"]
        original = self.source.read_bytes(); collision = self.source.parent / "saved.png"; collision.write_bytes(b"collision")
        state.rename_catalog_image(image_id, "saved.png")
        state.reserve_browser_save(image_id, 0, "edited-collision", copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        rendered = state.render_browser_save(image_id, 0, 100, None, client_save_token="edited-collision", output_format="original", keep_metadata=True)
        with self.assertRaises(ClientError): state.commit_browser_save(image_id, 0, rendered.save_token, "overwrite")
        self.assertEqual(self.source.read_bytes(), original); self.assertEqual(collision.read_bytes(), b"collision")
        self.assertEqual(state.image_for_id(image_id).relative_path, "nested/source.png")
        self.assertEqual(state.image_for_id(image_id).edited_filename, "saved.png")

    def test_edited_name_workspace_abort_restores_original_and_edit(self):
        state = self.state(); state.create_project("save abort")
        image_id = state.set_root(str(self.source_root))[0]["id"]
        original = self.source.read_bytes()
        state.rename_catalog_image(image_id, "saved.png")
        state.reserve_browser_save(image_id, 0, "edited-abort", copy_to_default=False, suffix="_censored", output_format="original", keep_metadata=True)
        rendered = state.render_browser_save(image_id, 0, 100, None, client_save_token="edited-abort", output_format="original", keep_metadata=True)
        with state.workspace_store._connect() as db:
            db.execute("""CREATE TRIGGER abort_edited_save BEFORE UPDATE OF relative_path ON images
                BEGIN SELECT RAISE(ABORT, 'edited save abort'); END""")
        with self.assertRaises(sqlite3.DatabaseError): state.commit_browser_save(image_id, 0, rendered.save_token, "overwrite")
        self.assertEqual(self.source.read_bytes(), original); self.assertFalse((self.source.parent / "saved.png").exists())
        self.assertEqual(state.image_for_id(image_id).relative_path, "nested/source.png")
        self.assertEqual(state.image_for_id(image_id).edited_filename, "saved.png")
        self.assertIsNone(state.workspace_store.browser_save_receipt("edited-abort"))

    def test_public_rename_is_metadata_only_and_survives_reopen_with_workspace_state(self):
        state, project_id, image_id = self._loaded_state()
        result = state.rename_catalog_image(image_id, "renamed.png")
        self.assertEqual(result["images"][0]["id"], image_id); self.assertTrue(self.source.exists()); self.assertFalse((self.source.parent / "renamed.png").exists())
        self.assertEqual(result["images"][0]["relativePath"], "nested/source.png")
        self.assertEqual(result["images"][0]["editedFilename"], "renamed.png")
        with state.save_journal._connection() as db:
            self.assertIsNone(db.execute("SELECT token FROM rename_operations").fetchone(), "metadata rename never needs a filesystem journal")
        reopened = self.state(); reopened.open_project(project_id)
        record = reopened.image_for_id(image_id)
        self.assertEqual(record.relative_path, "nested/source.png"); self.assertEqual(record.edited_filename, "renamed.png"); self.assertTrue(record.hidden); self.assertTrue(record.reviewed); self.assertTrue(record.flip_horizontal)
        self.assertEqual([candidate["id"] for candidate in reopened.list_candidates(image_id)], ["candidate"])
        self.assertTrue(reopened.manual_workspace(image_id)["add"])
        self.assertTrue(reopened.project_history_status(image_id)["canUndo"])
        self.assertIn(image_id, reopened.restore_project_history(image_id, "undo")["changedImageIds"])
        self.assertEqual(reopened.image_for_id(image_id).edited_filename, "renamed.png")
        self.assertIn(image_id, reopened.restore_project_history(image_id, "redo")["changedImageIds"])
        self.assertEqual(reopened.image_for_id(image_id).edited_filename, "renamed.png")

    def test_rename_database_failure_keeps_source_and_live_metadata(self):
        state, _project_id, image_id = self._loaded_state()
        with state.workspace_store._connect() as db:
            db.execute("""CREATE TRIGGER abort_edited_filename BEFORE UPDATE OF edited_filename ON images
                BEGIN SELECT RAISE(ABORT, 'edited filename abort'); END""")
        with self.assertRaises(sqlite3.DatabaseError):
            state.rename_catalog_image(image_id, "renamed.png")
        self.assertTrue(self.source.exists()); self.assertFalse((self.source.parent / "renamed.png").exists())
        self.assertEqual(state.image_for_id(image_id).relative_path, "nested/source.png"); self.assertIsNone(state.image_for_id(image_id).edited_filename)
        with state.save_journal._connection() as db:
            self.assertIsNone(db.execute("SELECT token FROM rename_operations").fetchone(), "a restored failure clears its rename intent")

    def test_prepared_native_rename_recovery_retargets_real_workspace_rows(self):
        state, project_id, image_id = self._loaded_state(); renamed = self.source.parent / "recovered.png"
        state.save_journal.prepare_rename("prepared", kind="native", image_id=image_id, old_path=self.source, new_path=renamed, identity=state.save_journal.file_identity(self.source))
        self.source.rename(renamed); state.shutdown()
        reopened = self.state(); reopened.open_project(project_id)
        self.assertEqual(reopened.image_for_id(image_id).relative_path, "nested/recovered.png")
        with reopened.save_journal._connection() as db:
            self.assertIsNone(db.execute("SELECT token FROM rename_operations WHERE token='prepared'").fetchone())

    def test_prepared_recovery_requires_the_original_file_identity(self):
        state, _project_id, image_id = self._loaded_state(); renamed = self.source.parent / "foreign.png"
        state.save_journal.prepare_rename("foreign", kind="native", image_id=image_id, old_path=self.source, new_path=renamed, identity="not-the-source")
        self.source.rename(renamed); state.shutdown()
        reopened = self.state()
        self.assertEqual(reopened.workspace_store.image_relative_path(image_id), "nested/source.png")
        with reopened.save_journal._connection() as db:
            self.assertIsNotNone(db.execute("SELECT token FROM rename_operations WHERE token='foreign'").fetchone())

    def test_active_browser_save_blocks_native_rename_before_file_mutation(self):
        state, _project_id, image_id = self._loaded_state(); record = state.image_for_id(image_id)
        state.browser_save_tokens["active"] = BrowserSaveToken(image_id, 0, (record.mtime_ns, record.size_bytes), state.catalog_generation, 0, None, state="rendering")
        with self.assertRaisesRegex(ClientError, "保存中"): state.rename_catalog_image(image_id, "blocked.png")
        self.assertTrue(self.source.exists()); self.assertFalse((self.source.parent / "blocked.png").exists())

    def test_extension_change_is_rejected_before_source_or_journal_mutation(self):
        state, _project_id, image_id = self._loaded_state()
        with self.assertRaisesRegex(ClientError, "拡張子"): state.rename_catalog_image(image_id, "renamed.jpg")
        self.assertTrue(self.source.exists()); self.assertEqual(state.image_for_id(image_id).relative_path, "nested/source.png")
        with state.save_journal._connection() as db:
            self.assertIsNone(db.execute("SELECT token FROM rename_operations").fetchone())
