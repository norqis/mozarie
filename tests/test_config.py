import json
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.config import SettingsError, SettingsStore, validate_output_directory_ready, validate_settings


DEFAULTS_PATH = Path(__file__).resolve().parents[1] / "config" / "defaults.json"


def default_settings() -> dict:
    return json.loads(DEFAULTS_PATH.read_text(encoding="utf-8"))


class SettingsTests(unittest.TestCase):
    def test_missing_builtin_output_directory_is_created_for_load_save_and_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            config.mkdir()
            defaults = default_settings()
            defaults["saving"].pop("default_output_directory")
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root)
            output = root / "output"

            loaded = store.load()
            self.assertEqual(loaded["saving"]["default_output_directory"], str(output.resolve()))
            self.assertTrue(output.is_dir())
            self.assertEqual(validate_output_directory_ready(output), output.resolve())

            store.save({"general": {"language": "en"}})
            self.assertTrue((config / "local.json").is_file())
            output.rmdir()
            self.assertFalse(output.exists())
            self.assertEqual(store.load()["saving"]["default_output_directory"], str(output.resolve()))
            self.assertTrue(output.is_dir())
            reset = store.reset()
            self.assertEqual(reset["saving"]["default_output_directory"], str(output.resolve()))
            self.assertTrue(output.is_dir())
            self.assertFalse((config / "local.json").exists())

    def test_blank_legacy_output_directory_falls_back_to_the_builtin_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            config.mkdir()
            defaults = default_settings()
            defaults["saving"]["default_output_directory"] = str(root / "configured-output")
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            (config / "local.json").write_text(json.dumps({"saving": {"default_output_directory": "   "}}), encoding="utf-8")

            settings = SettingsStore(root).load()
            output = root / "output"
            self.assertEqual(settings["saving"]["default_output_directory"], str(output.resolve()))
            self.assertTrue(output.is_dir())
            self.assertEqual(validate_output_directory_ready(output), output.resolve())

    def test_missing_custom_output_directory_is_not_created_by_load(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            config.mkdir()
            defaults = default_settings()
            custom_output = root / "custom-output"
            defaults["saving"]["default_output_directory"] = str(custom_output)
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")

            settings = SettingsStore(root).load()
            self.assertEqual(settings["saving"]["default_output_directory"], str(custom_output))
            self.assertFalse(custom_output.exists())
            with self.assertRaises(SettingsError):
                validate_output_directory_ready(custom_output)

    def test_output_directory_ready_requires_an_existing_writable_directory_without_creating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "保存先"
            with self.assertRaises(SettingsError):
                validate_output_directory_ready(target)
            self.assertFalse(target.exists())
            target.mkdir()
            self.assertEqual(validate_output_directory_ready(target), target.resolve())
            self.assertEqual(list(target.iterdir()), [])
            with self.assertRaises(SettingsError):
                validate_output_directory_ready(str(target) + "\x00bad")

    def test_output_directory_probe_writes_and_removes_its_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            self.assertEqual(validate_output_directory_ready(target), target.resolve())
            self.assertEqual(list(target.iterdir()), [])

    def test_output_directory_probe_propagates_a_create_failure_without_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch("mozarie.config.tempfile.NamedTemporaryFile", side_effect=OSError("read-only")):
                with self.assertRaisesRegex(OSError, "read-only"):
                    validate_output_directory_ready(Path(directory))

    def test_valid_settings_are_persisted_only_to_local_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            defaults = default_settings()
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root)
            saved = store.save({"general": {"language": "en"}, "display": {"tool_position": "bottom"}, "importing": {"parallelism": 10}, "detection": {"mode": "high_precision", "parallelism": 4}})
            self.assertEqual(saved["general"]["language"], "en")
            self.assertEqual(saved["display"]["tool_position"], "bottom")
            self.assertEqual(saved["detection"]["mode"], "high_precision")
            self.assertTrue(saved["detection"]["fluid_exclusion_enabled"])
            self.assertEqual(saved["importing"]["parallelism"], 10)
            self.assertTrue((root / "config" / "local.json").is_file())
            self.assertEqual(json.loads((root / "config" / "defaults.json").read_text(encoding="utf-8")), defaults)

    def test_legacy_local_settings_gain_fill_tolerance_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root / "config"; config.mkdir()
            defaults = default_settings()
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            (config / "local.json").write_text(json.dumps({"general": {"language": "en"}}), encoding="utf-8")

            loaded = SettingsStore(root).load()

            self.assertEqual(loaded["editing"]["fill_color_tolerance"], 20)

    def test_reset_removes_only_machine_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "config").mkdir()
            defaults = default_settings()
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root); store.save({"general": {"language": "en"}})
            self.assertTrue((root / "config" / "local.json").is_file())
            reset = store.reset()
            self.assertEqual(reset["general"], defaults["general"])
            self.assertEqual(reset["saving"]["default_output_directory"], str((root / "output").resolve()))
            self.assertFalse((root / "config" / "local.json").exists())

    def test_sam_checkpoint_variants_are_persisted_as_a_map(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root / "config"; config.mkdir()
            defaults = default_settings()
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            checkpoint = r"C:\models\sam_vit_l_0b3195.pth"
            (config / "local.json").write_text(json.dumps({"models": {"sam_checkpoints": {"vit_l": checkpoint}, "sam_model_type": "vit_l"}}), encoding="utf-8")
            store = SettingsStore(root)

            loaded = store.load()
            self.assertEqual(loaded["models"]["sam_model_type"], "vit_l")
            self.assertEqual(loaded["models"]["sam_checkpoints"]["vit_l"], checkpoint)

            loaded["models"]["sam_checkpoints"]["vit_h"] = r"D:\models\sam_vit_h_4b8939.pth"
            loaded["models"]["sam_model_type"] = "vit_h"
            saved = store.save(loaded)
            persisted = json.loads((config / "local.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["models"]["sam_checkpoints"]["vit_h"], r"D:\models\sam_vit_h_4b8939.pth")
            self.assertEqual(saved["models"]["sam_checkpoints"]["vit_h"], r"D:\models\sam_vit_h_4b8939.pth")

    def test_invalid_provider_and_threshold_are_rejected(self):
        valid = default_settings()
        invalid_provider = json.loads(json.dumps(valid)); invalid_provider["models"]["provider"] = "metal"
        invalid_threshold = json.loads(json.dumps(valid)); invalid_threshold["detection"]["threshold"] = 1.1
        invalid_tool_position = json.loads(json.dumps(valid)); invalid_tool_position["display"]["tool_position"] = "center"
        invalid_fluid_exclusion = json.loads(json.dumps(valid)); invalid_fluid_exclusion["detection"]["fluid_exclusion_enabled"] = "yes"
        invalid_import_parallelism = json.loads(json.dumps(valid)); invalid_import_parallelism["importing"]["parallelism"] = 11
        with self.assertRaises(SettingsError): validate_settings(invalid_provider)
        with self.assertRaises(SettingsError): validate_settings(invalid_threshold)
        with self.assertRaises(SettingsError): validate_settings(invalid_tool_position)
        with self.assertRaises(SettingsError): validate_settings(invalid_fluid_exclusion)
        with self.assertRaises(SettingsError): validate_settings(invalid_import_parallelism)

    def test_invalid_hex_color_is_rejected(self):
        invalid = default_settings()
        invalid["display"]["apply_color"] = "#GGGGGG"
        with self.assertRaises(SettingsError):
            validate_settings(invalid)

    def test_hand_segmentation_settings_have_safe_defaults(self):
        settings = validate_settings(default_settings())
        self.assertEqual(settings["models"]["hand_segmentation"], "")
        self.assertFalse(settings["models"]["hand_segmentation_enabled"])
        self.assertTrue(settings["detection"]["exclude_forced_default"])
        self.assertTrue(Path(settings["saving"]["default_output_directory"]).is_absolute())

    def test_hand_segmentation_requires_hand_detection(self):
        defaults = default_settings()
        invalid = json.loads(json.dumps(defaults))
        invalid["models"]["hand_segmentation_enabled"] = True
        with self.assertRaises(SettingsError):
            validate_settings(invalid)

    def test_output_directory_must_be_an_absolute_path(self):
        legacy = default_settings()
        legacy["saving"] = {"parallelism": 2, "default_output_directory": "relative-output"}
        with self.assertRaises(SettingsError):
            validate_settings(legacy)
        legacy["saving"]["default_output_directory"] = "C:\\output\x00bad"
        with self.assertRaises(SettingsError):
            validate_settings(legacy)

    def test_legacy_shortcuts_gain_per_action_defaults(self):
        legacy = default_settings()
        settings = validate_settings(legacy)
        self.assertTrue(settings["shortcuts"]["actions"]["previousVisible"])
        self.assertEqual(settings["shortcuts"]["bindings"]["nextVisible"], "ArrowDown")
        self.assertTrue(settings["confirmations"]["candidateDelete"])

    def test_failed_atomic_replace_keeps_the_previous_local_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root / "config"; config.mkdir()
            defaults = default_settings()
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            local = config / "local.json"; local.write_text('{"keep": true}', encoding="utf-8")
            store = SettingsStore(root)
            with mock.patch("mozarie.config.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    store.save({"general": {"language": "en"}})
            self.assertEqual(local.read_text(encoding="utf-8"), '{"keep": true}')
            self.assertEqual(list(config.glob(".local.json.*.tmp")), [])
