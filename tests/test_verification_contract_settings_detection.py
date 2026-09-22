from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "tests" / "verification-contracts.settings-detection.json"
MANUAL = ROOT / "docs" / "manual-verification" / "settings-detection.md"


class SettingsDetectionVerificationContractTests(unittest.TestCase):
    def test_every_observation_has_an_executable_test_or_a_specific_external_environment(self) -> None:
        contract = json.loads(CONTRACT.read_text(encoding="utf-8-sig"))
        observations = contract["observations"]
        self.assertEqual(contract["version"], 1)
        self.assertEqual(contract["domain"], "settings-detection")
        self.assertEqual(contract["baseline"], {"rows": 149, "observations": len(observations)})
        self.assertEqual(len({item["key"] for item in observations}), len(observations))
        self.assertEqual(
            {source_id for item in observations for source_id in item["sourceIds"]},
            {f"SD-{index:03d}" for index in range(1, 150)},
        )

        python_ids: set[str] = set()
        node_ids: set[str] = set()
        for path in (ROOT / "tests").glob("test_*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for class_node in (node for node in tree.body if isinstance(node, ast.ClassDef)):
                for method in class_node.body:
                    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and method.name.startswith("test_"):
                        python_ids.add(f"python:tests.{path.stem}.{class_node.name}.{method.name}")
        for path in (ROOT / "tests").glob("test_*.cjs"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"(?:nodeTest|test)\(\s*[\"']([^\"']+)[\"']", source):
                node_ids.add(f"node:tests/{path.name}::{match.group(1)}")
            if path.name == "test_settings_actions_e2e.cjs":
                for match in re.finditer(r'\["(SD-(?:07[6-9]|08[0-4]))",', source):
                    node_ids.add(f"node:tests/{path.name}::{match.group(1)} shortcut performs the visible action only while its action switch is enabled")
                for match in re.finditer(r'\["(SD-09[0-5]|SD-089)",', source):
                    node_ids.add(f"node:tests/{path.name}::{match.group(1)} confirmation setting gates the real confirmation dialog without changing its operation target")

        for item in observations:
            self.assertTrue(item["observation"].strip())
            if item["status"] == "automated":
                self.assertTrue(item["testIds"])
                for test_id in item["testIds"]:
                    if test_id.startswith("node:") and " > " in test_id:
                        relative_path, qualified_name = test_id.removeprefix("node:").split("::", 1)
                        source = (ROOT / relative_path).read_text(encoding="utf-8")
                        for title in qualified_name.split(" > "):
                            self.assertRegex(source, rf"(?:nodeTest|test)\(\s*(['\"]){re.escape(title)}\1", test_id)
                    else:
                        self.assertTrue(test_id in python_ids | node_ids, test_id)
                self.assertNotIn("manual", item)
            else:
                self.assertEqual(item["status"], "retired")
                self.assertNotIn("testIds", item)
                self.assertNotIn("manual", item)

        self.assertFalse(MANUAL.exists(), "the completed checklist is deleted")
        self.assertNotIn("manual", {item["status"] for item in observations})



if __name__ == "__main__":
    unittest.main()
