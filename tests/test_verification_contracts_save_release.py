from __future__ import annotations

import importlib
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "tests" / "verification-contracts.save-release.json"
MANUAL_PATH = ROOT / "docs" / "manual-verification" / "save-release.md"


class SaveReleaseVerificationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

    def test_contract_is_atomic_complete_and_points_to_executed_tests(self) -> None:
        self.assertEqual(self.contract["version"], 1)
        self.assertEqual(self.contract["domain"], "save-release")
        self.assertEqual(self.contract["source"], {
            "path": "docs/manual-verification/save-release.md",
            "commit": "264f70d",
        })
        observations = self.contract["observations"]
        self.assertEqual(self.contract["baseline"], {"rows": 93, "observations": len(observations)})

        keys = [item["key"] for item in observations]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(
            {source_id for item in observations for source_id in item["sourceIds"]},
            {"SV-034a", *(f"SV-{number:03d}" for number in range(1, 97) if number not in {8, 24, 49, 90})},
        )

        for item in observations:
            self.assertRegex(item["key"], r"^SV-\d{3}[a-z]?\.\d+$")
            self.assertTrue(item["observation"].strip())
            self.assertEqual(item["sourceIds"], [item["key"].split(".", 1)[0]])
            if item["status"] == "automated":
                self.assertNotIn("manual", item)
                self.assertTrue(item["testIds"])
                for test_id in item["testIds"]:
                    self._assert_test_id_is_discovered(test_id)
            elif item["status"] == "manual":
                self.assertEqual(item["status"], "manual")
                self.assertNotIn("testIds", item)
                self.assertTrue(item["manual"]["environment"].strip())
                self.assertRegex(item["manual"]["reason"], r"(?:Windowsダイアログ|OS.*権限|実UNC|実ドライブ|ファイルシステム固有|実GPU|公開|実ブラウザー|実起動|機械判定)")
                self.assertIn("CI", item["manual"]["reason"])
            else:
                self.assertEqual(item["status"], "retired")
                self.assertNotIn("testIds", item)
                self.assertNotIn("manual", item)
                self.assertIn("検証対象外", item["retired"]["reason"])

    def test_manual_document_contains_exactly_the_external_observations(self) -> None:
        documented = {}
        for match in re.finditer(r"^\| (SV-\d{3}[a-z]?\.\d+) \| [^|]+ \| [^|]+ \| (.+) \|$", MANUAL_PATH.read_text(encoding="utf-8"), re.MULTILINE):
            documented[match.group(1)] = match.group(2)
        expected = {item["key"]: item["observation"] for item in self.contract["observations"] if item["status"] == "manual"}
        self.assertEqual(documented, expected)
        self.assertEqual(len(documented), sum(item["status"] == "manual" for item in self.contract["observations"]))

    def _assert_test_id_is_discovered(self, test_id: str) -> None:
        kind, target = test_id.split(":", 1)
        if kind == "python":
            module_name, class_name, method_name = target.rsplit(".", 2)
            case = getattr(importlib.import_module(module_name), class_name)
            self.assertTrue(issubclass(case, unittest.TestCase), test_id)
            self.assertTrue(method_name.startswith("test_"), test_id)
            self.assertTrue(callable(getattr(case, method_name)), test_id)
            return
        self.assertEqual(kind, "node", test_id)
        relative_path, title = target.split("::", 1)
        self.assertRegex(relative_path, r"^tests/test_.+\.cjs$")
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        titles = title.split(" > ")
        self.assertRegex(source, rf"(?:nodeTest|test)\(\s*(['\"]){re.escape(titles[0])}\1", test_id)
        for nested in titles[1:]:
            self.assertRegex(source, rf"\.test\(\s*(['\"]){re.escape(nested)}\1", test_id)


if __name__ == "__main__":
    unittest.main()
