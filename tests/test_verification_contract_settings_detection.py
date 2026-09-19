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

        manual_keys: set[str] = set()
        for item in observations:
            self.assertTrue(item["observation"].strip())
            if item["status"] == "automated":
                self.assertTrue(item["testIds"])
                for test_id in item["testIds"]:
                    self.assertIn(test_id, python_ids | node_ids)
                self.assertNotIn("manual", item)
            else:
                self.assertEqual(item["status"], "manual")
                self.assertNotIn("testIds", item)
                self.assertTrue(item["manual"]["environment"].strip())
                self.assertIn("CI", item["manual"]["reason"])
                manual_keys.add(item["key"])

        documented_manual: dict[str, str] = {}
        for line in MANUAL.read_text(encoding="utf-8").splitlines():
            columns = [column.strip() for column in line.split("|")]
            if len(columns) >= 6 and re.fullmatch(r"SD-\d+\.\d+", columns[1]):
                documented_manual[columns[1]] = columns[4]
        self.assertEqual(set(documented_manual), manual_keys)
        self.assertEqual(
            documented_manual,
            {item["key"]: item["observation"] for item in observations if item["status"] == "manual"},
        )


if __name__ == "__main__":
    unittest.main()
