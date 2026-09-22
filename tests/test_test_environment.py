from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tests as tests_package
from tests import TEST_APP_DIR, prepare_test_app_config
from mozarie import core, state


class TestEnvironmentTests(unittest.TestCase):
    def test_fixture_config_copies_defaults_without_machine_local_settings(self) -> None:
        with tempfile.TemporaryDirectory() as source_directory, tempfile.TemporaryDirectory() as target_directory:
            source_root = Path(source_directory)
            source_config = source_root / "config"
            source_config.mkdir()
            (source_config / "defaults.json").write_text('{"source": "defaults"}', encoding="utf-8")
            (source_config / "local.json").write_text('{"source": "machine"}', encoding="utf-8")
            target_app = Path(target_directory) / "app"
            target_config = target_app / "config"
            target_config.mkdir(parents=True)
            (target_config / "local.json").write_text('{"source": "stale"}', encoding="utf-8")

            with patch.object(tests_package, "_SOURCE_ROOT", source_root):
                prepare_test_app_config(target_app)

            self.assertEqual((target_config / "defaults.json").read_text(encoding="utf-8"), '{"source": "defaults"}')
            self.assertFalse((target_config / "local.json").exists())

    def test_import_time_state_uses_the_disposable_test_app_directory(self) -> None:
        source_root = Path(__file__).resolve().parents[1]
        self.assertNotEqual(TEST_APP_DIR, source_root)
        self.assertEqual(core.APP_DIR, TEST_APP_DIR)
        self.assertEqual(state.APP_DIR, TEST_APP_DIR)
        self.assertIsNotNone(state.STATE)
        assert state.STATE is not None
        self.assertEqual(state.STATE.settings_store.defaults_path, TEST_APP_DIR / "config" / "defaults.json")
        self.assertEqual(state.STATE.workspace_store.path, TEST_APP_DIR / "data" / "workspaces.sqlite3")
        self.assertTrue((TEST_APP_DIR / "output").is_dir())
        self.assertTrue(state.STATE.workspace_store.path.is_file())


if __name__ == "__main__":
    unittest.main()
