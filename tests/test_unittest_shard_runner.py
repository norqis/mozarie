"""Executable contracts for deterministic backend unittest sharding."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHARD_RUNNER = ROOT / "scripts" / "unittest-shard.py"


def write_fixture(root: Path, *, failure: bool = False, skipped: bool = False) -> None:
    tests = root / "tests"
    tests.mkdir()
    (tests / "__init__.py").write_text("", encoding="utf-8")
    (tests / "test_custom.py").write_text(
        "import unittest\n"
        "class CustomCase(unittest.TestCase):\n"
        "    def test_alpha(self): self.assertTrue(True)\n"
        "    def test_new_case(self): self.assertTrue(True)\n",
        encoding="utf-8",
    )
    (tests / "test_load.py").write_text(
        "import unittest\n"
        "def load_tests(loader, tests, pattern):\n"
        "    class Generated(unittest.TestCase):\n"
        "        def test_from_load_tests(self): self.assertTrue(True)\n"
        "    return loader.loadTestsFromTestCase(Generated)\n",
        encoding="utf-8",
    )
    if skipped:
        (tests / "test_skip.py").write_text(
            "import unittest\n"
            "class SkipCase(unittest.TestCase):\n"
            "    @unittest.skip('fixture skip')\n"
            "    def test_skip(self): pass\n",
            encoding="utf-8",
        )
    if failure:
        (tests / "test_failure.py").write_text(
            "import unittest\n"
            "class FailureCase(unittest.TestCase):\n"
            "    def test_failure(self): self.fail('fixture failure')\n",
            encoding="utf-8",
        )


def run_shard(root: Path, index: int, total: int, manifest: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SHARD_RUNNER),
            "--shard-index", str(index),
            "--shard-total", str(total),
            "--manifest", str(manifest),
            "--start-directory", str(root / "tests"),
            "--top-level-directory", str(root),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


class UnittestShardRunnerTests(unittest.TestCase):
    def test_discovery_preserves_custom_module_and_load_tests_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root)
            manifest_paths = [root / f"manifest-{index}.json" for index in range(2)]
            results = [run_shard(root, index, 2, manifest) for index, manifest in enumerate(manifest_paths)]
            for result in results:
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            manifests = [json.loads(manifest.read_text(encoding="utf-8")) for manifest in manifest_paths]
            discovered = manifests[0]["discovered"]
            self.assertEqual(discovered, sorted(discovered))
            self.assertIn("tests.test_custom.CustomCase.test_new_case", discovered)
            self.assertTrue(any("Generated.test_from_load_tests" in test_id for test_id in discovered))
            self.assertEqual(manifests[0]["discovered"], manifests[1]["discovered"])
            union = [test_id for manifest in manifests for test_id in manifest["selected"]]
            self.assertEqual(sorted(union), discovered)
            self.assertEqual(len(union), len(set(union)))
            self.assertEqual(sum(manifest["testsRun"] for manifest in manifests), len(discovered))

    def test_failed_suite_writes_manifest_before_returning_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root, failure=True)
            manifest_path = root / "failure-manifest.json"
            result = run_shard(root, 0, 1, manifest_path)
            self.assertNotEqual(result.returncode, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "failed")
            self.assertEqual(manifest["testsRun"], len(manifest["selected"]))

    def test_skipped_suite_records_skip_for_ci_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root, skipped=True)
            manifest_path = root / "skip-manifest.json"
            result = run_shard(root, 0, 1, manifest_path)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["skipped"], 1)


if __name__ == "__main__":
    unittest.main()