"""Check all overwrite destinations before staging or changing any image."""

from pathlib import Path
import os
import subprocess
import unittest

from PIL import Image
from tests import test_settings_import_regressions


class SavePreflightConflictTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_settings_import_regressions.SettingsImportRegressionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_native_format_conversion_lists_every_conflict_before_any_output(self):
        source = self.fixture.source
        for name in ("first.png", "second.png", "clear.png", "first.jpg", "second.jpg"):
            with Image.new("RGB", (12, 8), "red") as image:
                image.save(source / name)
        self.fixture.state.set_root(str(source))
        ids = [image.image_id for image in self.fixture.state.images.values()
               if image.relative_path in {"first.png", "second.png", "clear.png"}]
        before = {path.name: path.read_bytes() for path in source.iterdir()}
        payload = {"imageIds": ids, "divisor": 10, "suffix": "", "copyToDefault": False,
                   "format": "jpg", "keepMetadata": False, "collectConflicts": True}
        status, result = self.fixture.request("/api/save/prepare", payload)
        self.assertEqual(status, 200)
        self.assertEqual(set(result["conflicts"]), {str(source / "first.jpg"), str(source / "second.jpg")})
        self.assertEqual(len(result["entries"]), 3)
        self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, before)
        self.assertEqual(self.fixture.state.browser_save_tokens, {})
        with self.fixture.state.save_journal._connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM saves").fetchone()[0], 0)
        payload["collectConflicts"] = False
        status, result = self.fixture.request("/api/save/prepare", payload)
        self.assertEqual(status, 400)
        self.assertEqual(result["error_code"], "output_files_exist")
        self.assertIn("first.jpg", result["params"]["files"])
        self.assertIn("second.jpg", result["params"]["files"])
        for name in ("first.jpg", "second.jpg"):
            (source / name).unlink()
        payload["collectConflicts"] = True
        self.assertEqual(self.fixture.request("/api/save/prepare", payload)[1]["conflicts"], [])

    def test_browser_single_and_batch_show_all_conflicts_before_render_and_can_retry(self):
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("save_preflight_live_browser.cjs")), self.fixture.origin],
            cwd=Path(__file__).resolve().parents[2], env={**os.environ, "PYTHONUTF8": "1"},
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=120, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)

