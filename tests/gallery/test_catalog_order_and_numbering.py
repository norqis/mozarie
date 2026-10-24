from types import SimpleNamespace
from pathlib import Path
import os
import sqlite3
import subprocess
import unittest
from unittest.mock import patch
import uuid

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from mozarie.core import ClientError
from mozarie.numbering import numbered_filenames
from tests import test_settings_import_regressions as import_fixture


class NumberedFilenameTests(unittest.TestCase):
    def test_all_supported_digit_boundaries(self):
        for digits in range(2, 6):
            limit = 10 ** digits
            records = [SimpleNamespace(image_id=str(i), relative_path="original.png", edited_filename=None) for i in range(limit - 1)]
            names = numbered_filenames(records, {"digits": digits, "placement": "only"})
            self.assertEqual(names["0"], f"{1:0{digits}d}.png")
            self.assertEqual(names[str(limit - 2)], f"{limit - 1}.png")
            with self.assertRaises(ClientError) as error:
                numbered_filenames(records + [records[0]], {"digits": digits, "placement": "only"})
            if digits < 5:
                self.assertEqual(error.exception.params["required"], digits + 1)
            self.assertEqual(error.exception.error_code, "numbering_limit" if digits == 5 else "numbering_overflow")

    def test_positions_use_edited_basename_and_requested_format(self):
        records = [SimpleNamespace(image_id="b", relative_path="folder/original.png", edited_filename="edited.png"),
                   SimpleNamespace(image_id="a", relative_path="other/original.webp", edited_filename=None)]
        for placement, expected in [("only", ["01.jpg", "02.jpg"]), ("prefix", ["01_edited.jpg", "02_original.jpg"]),
                                    ("suffix", ["edited_01.jpg", "original_02.jpg"])]:
            self.assertEqual(list(numbered_filenames(records, {"digits": 2, "placement": placement}, "jpg").values()), expected)
        for invalid in [{"digits": 1, "placement": "only"}, {"digits": 6, "placement": "only"},
                        {"digits": True, "placement": "only"}, {"digits": 2, "placement": "other"}]:
            with self.assertRaises(ClientError):
                numbered_filenames(records, invalid)


class CatalogOrderAndSaveTests(unittest.TestCase):
    def setUp(self):
        self.fixture = import_fixture.SettingsImportRegressionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state = self.fixture.state
        for index, color in enumerate(["red", "green", "blue"]):
            with Image.new("RGB", (8, 8), color) as image:
                metadata = PngInfo(); metadata.add_text("prompt", f"fixture {index}")
                image.save(self.fixture.source / f"{index}.png", pnginfo=metadata)
        self.state.set_root(str(self.fixture.source))
        self.fixture.output.mkdir()

    def test_reorder_persists_across_project_reopen_and_rejects_stale_membership(self):
        before = list(self.state.order)
        desired = list(reversed(before))
        generation = self.state.catalog_generation
        status, response = self.fixture.request("/api/catalog/reorder", {"imageIds": desired})
        self.assertEqual(status, 200, response)
        self.assertEqual([image["id"] for image in response["images"]], desired)
        self.assertEqual(response["catalogGeneration"], generation + 1)
        self.state.name_current_project("Ordered project")
        project_id = self.state.catalog_id
        self.state.close_project()
        self.state.open_project(project_id)
        self.assertEqual(self.state.order, desired)
        status, response = self.fixture.request("/api/catalog/reorder", {"imageIds": before, "expectedCatalogGeneration": generation})
        self.assertEqual((status, response["error_code"]), (409, "stale_catalog"))
        status, _ = self.fixture.request("/api/catalog/reorder", {"imageIds": desired[:-1]})
        self.assertEqual(status, 409)
        self.assertEqual(self.state.order, desired)
        with patch.object(self.state.workspace_store, "set_catalog_order", side_effect=sqlite3.OperationalError("test disk failure")):
            status, _ = self.fixture.request("/api/catalog/reorder", {"imageIds": before})
        self.assertEqual(status, 500)
        self.assertEqual(self.state.order, desired)
        self.assertEqual(self.state.workspace_store.catalog_order(project_id), desired)

    def test_numbered_copy_and_overwrite_keep_source_bytes_and_commit_output_names(self):
        ids = list(reversed(self.state.order))
        self.state.reorder_catalog(ids)
        originals = {image_id: self.state.images[image_id].path.read_bytes() for image_id in ids}
        for copy, placement in [(True, "only"), (True, "prefix"), (True, "suffix"), (False, "only")]:
            entries = self.state.prepare_browser_save(ids, 100, "", False, copy_to_default=copy,
                numbering={"digits": 2, "placement": placement})
            for entry in entries:
                image_id = entry["imageId"]
                token = str(uuid.uuid4())
                kwargs = dict(copy_to_default=copy, suffix="", output_format="original", keep_metadata=True,
                              output_filename=entry["outputFilename"])
                self.state.reserve_browser_save(image_id, entry["candidateRevision"], token, **kwargs)
                rendered = self.state.render_browser_save(image_id, entry["candidateRevision"], 100, None,
                    client_save_token=token, stream_image=False, **kwargs)
                self.assertEqual(rendered.no_effect, copy)
                self.state.commit_browser_save(image_id, entry["candidateRevision"], token, "keep" if copy else "overwrite")
                destination = self.fixture.output / entry["outputFilename"] if copy else self.fixture.source / entry["outputFilename"]
                self.assertEqual(destination.read_bytes(), originals[image_id])
                self.assertIsNone(self.state.images[image_id].edited_filename)
            self.assertEqual(self.state.order, ids)
        self.assertEqual([self.state.images[image_id].relative_path for image_id in ids], ["01.png", "02.png", "03.png", "04.png"])

    def test_prepare_rejects_destination_conflicts_before_a_save_token_exists(self):
        ids = list(self.state.order)
        destination = self.fixture.source / "01.png"
        destination.write_bytes(b"existing unrelated output")
        with self.assertRaises(ClientError) as error:
            self.state.prepare_browser_save(ids, 100, "", False, numbering={"digits": 2, "placement": "only"})
        self.assertEqual(error.exception.error_code, "output_name_conflict")
        self.assertEqual(destination.read_bytes(), b"existing unrelated output")
        self.assertFalse(self.state.browser_save_tokens)
        self.assertEqual(self.state.order, ids)

    def test_numbered_copy_keeps_exact_names_and_rejects_existing_and_racing_outputs(self):
        ids = list(self.state.order)
        self.assertTrue(self.state.settings["saving"]["preserve_directory_structure"])
        destination = self.fixture.output / "01.png"
        destination.write_bytes(b"existing output")
        with self.assertRaises(ClientError) as error:
            self.state.prepare_browser_save(ids, 100, "", False, copy_to_default=True,
                numbering={"digits": 2, "placement": "only"})
        self.assertEqual(error.exception.error_code, "output_name_conflict")
        self.assertFalse(self.state.browser_save_tokens)
        destination.unlink()
        image_id = ids[0]
        kwargs = dict(copy_to_default=True, suffix="", output_format="original", keep_metadata=True, output_filename="01.png")
        token = str(uuid.uuid4())
        self.state.reserve_browser_save(image_id, 0, token, **kwargs)
        with self.assertRaises(ClientError):
            self.state.reserve_browser_save(ids[1], 0, str(uuid.uuid4()), **kwargs)
        self.state.render_browser_save(image_id, 0, 100, None, client_save_token=token, **kwargs)
        destination.write_bytes(b"output created during rendering")
        with self.assertRaises(ClientError) as error:
            self.state.commit_browser_save(image_id, 0, token, "keep")
        self.assertEqual(error.exception.error_code, "output_name_conflict")
        self.assertEqual(destination.read_bytes(), b"output created during rendering")
        self.assertEqual(list(self.fixture.output.glob("*.png")), [destination])

    def test_numbered_output_extension_matches_the_selected_format(self):
        image_id = self.state.order[0]
        for output_format, invalid_name in [("original", "01.txt"), ("jpg", "01.png"), ("png", "01.jpg")]:
            kwargs = dict(copy_to_default=True, suffix="", output_format=output_format,
                          keep_metadata=output_format != "jpg")
            with self.assertRaises(ClientError):
                self.state.reserve_browser_save(image_id, 0, str(uuid.uuid4()), output_filename=invalid_name, **kwargs)
            token = str(uuid.uuid4())
            valid_name = "01.jpg" if output_format == "jpg" else "01.png"
            self.state.reserve_browser_save(image_id, 0, token, output_filename=valid_name, **kwargs)
            with self.assertRaises(ClientError):
                self.state.render_browser_save(image_id, 0, 100, None, client_save_token=token,
                    output_filename=invalid_name, **kwargs)
            self.state.cancel_browser_save(image_id, 0, token)
        self.assertFalse(list(self.fixture.output.glob("*.png")))

    def test_removed_images_preserve_remaining_order_and_new_imports_append_in_arrival_order(self):
        ids = list(reversed(self.state.order))
        self.state.reorder_catalog(ids)
        self.state.remove_images_from_catalog([ids[1]])
        remaining = [ids[0], *ids[2:]]
        self.assertEqual(self.state.order, remaining)
        self.state.name_current_project("Ordered imports")
        project_id = self.state.catalog_id
        self.state.close_project()
        self.state.open_project(project_id)
        self.assertEqual(self.state.order, remaining)
        for filename in ["z-last.png", "a-newest.png"]:
            staged = self.fixture.root / filename
            with Image.new("RGB", (8, 8), "red") as image:
                image.save(staged)
            before = set(self.state.order)
            self.state.import_image_file_for_api(staged, name=filename, relative_path=filename,
                client_key=str(uuid.uuid4()), intent="add")
            new_id = (set(self.state.order) - before).pop()
            remaining.append(new_id)
            self.assertEqual(self.state.order, remaining)

    def test_output_name_is_bound_to_reserved_token(self):
        image_id = self.state.order[0]
        token = str(uuid.uuid4())
        self.state.reserve_browser_save(image_id, 0, token, copy_to_default=True, suffix="",
            output_format="original", keep_metadata=True, output_filename="01.png")
        with self.assertRaises(ClientError):
            self.state.reserve_browser_save(image_id, 0, token, copy_to_default=True, suffix="",
                output_format="original", keep_metadata=True, output_filename="02.png")
        with self.assertRaises(ClientError):
            self.state.render_browser_save(image_id, 0, 100, None, copy_to_default=True,
                client_save_token=token, output_filename="02.png")
        self.assertFalse(list(self.fixture.output.glob("*.png")))

    def test_live_reorder_and_numbering_copy_and_overwrite_use_the_applied_order(self):
        self.state.name_current_project("Numbered browser project")
        project_id = self.state.catalog_id
        before = [(self.state.images[image_id].relative_path, self.state.images[image_id].path.read_bytes())
                  for image_id in self.state.order]
        for image_id in [self.state.order[1], self.state.order[3]]:
            self.state.set_image_flags(image_id, {"reviewed": True})
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("catalog_numbered_save_live_browser.cjs")), self.fixture.origin],
            cwd=Path(__file__).resolve().parents[2], env={**os.environ, "PYTHONUTF8": "1"},
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
        ordered = before[1:] + before[:1]
        for index, (name, data) in enumerate(ordered, 1):
            number = str(index).zfill(2)
            for output in [f"{number}.png", f"{number}_{Path(name).stem}.png", f"{Path(name).stem}_{number}.png"]:
                self.assertEqual((self.fixture.output / output).read_bytes(), data)
            self.assertEqual((self.fixture.source / f"{number}.png").read_bytes(), data)
        expected_names = []
        for index, (name, _data) in enumerate(ordered, 1):
            expected_names.extend([f"{index:02d}.png", f"{index:02d}_{Path(name).stem}.png", f"{Path(name).stem}_{index:02d}.png"])
        for index, (name, data) in enumerate([ordered[0], ordered[2]], 1):
            filename = f"{index:03d}_{Path(name).stem}.png"
            expected_names.append(filename)
            self.assertEqual((self.fixture.output / filename).read_bytes(), data)
        self.assertEqual(sorted(path.name for path in self.fixture.output.glob("*.png")), sorted(expected_names))
        order = list(self.state.order)
        self.state.close_project()
        self.state.open_project(project_id)
        self.assertEqual(self.state.order, order)

    def test_numbered_copy_respects_format_and_metadata_settings(self):
        image_id = self.state.order[0]
        original = self.state.images[image_id].path.read_bytes()
        for output_format, keep_metadata in [("original", True), ("png", False), ("jpg", False)]:
            output = self.fixture.root / f"metadata-{output_format}"
            output.mkdir()
            self.state.update_settings({"saving": {"default_output_directory": str(output)}})
            entry = self.state.prepare_browser_save([image_id], 100, "", False, copy_to_default=True,
                output_format=output_format, keep_metadata=keep_metadata, numbering={"digits": 3, "placement": "only"})[0]
            token = str(uuid.uuid4())
            kwargs = dict(copy_to_default=True, suffix="", output_format=output_format, keep_metadata=keep_metadata,
                          output_filename=entry["outputFilename"])
            self.state.reserve_browser_save(image_id, 0, token, **kwargs)
            self.state.render_browser_save(image_id, 0, 100, None, client_save_token=token, **kwargs)
            self.state.commit_browser_save(image_id, 0, token, "keep")
            destination = output / ("001.jpg" if output_format == "jpg" else "001.png")
            with Image.open(destination) as saved:
                self.assertEqual(saved.format, "JPEG" if output_format == "jpg" else "PNG")
                self.assertEqual("prompt" in saved.info, keep_metadata)
            self.assertEqual(self.state.images[image_id].path.read_bytes(), original)
