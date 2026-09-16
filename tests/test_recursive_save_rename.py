import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from mozarie.core import ClientError, ImageRecord
from mozarie.saving import SavingMixin
from mozarie.workspace import WorkspaceStore


class _SavingState(SavingMixin):
    def __init__(self, record: ImageRecord, output: Path):
        self.lock = threading.RLock(); self.output_destination_lock = threading.RLock()
        self.settings = {"saving": {"default_output_directory": str(output), "parallelism": 1, "preserve_directory_structure": False}}
        self.catalog_generation = 1; self.images = {record.image_id: record}; self.reserved_output_paths = set()
        self._start_job = Mock()

    def _assert_catalog_mutable(self): pass
    def _records_for_ids_with_catalog(self, _ids): return [next(iter(self.images.values()))], 1


class RecursiveSaveTests(unittest.TestCase):
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


class WorkspaceRenameTests(unittest.TestCase):
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

