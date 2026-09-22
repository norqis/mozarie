from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "tests" / "verification-contracts.data-integrity.json"
MANUAL_PATH = ROOT / "docs" / "manual-verification" / "data-integrity.md"


class DataIntegrityVerificationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

    def test_contract_has_one_stable_key_per_observation_and_explicit_execution_owner(self) -> None:
        observations = self.contract["observations"]
        keys = [item["key"] for item in observations]

        self.assertEqual(self.contract["version"], 1)
        self.assertEqual(self.contract["domain"], "data-integrity")
        self.assertEqual(
            self.contract["source"],
            {"path": "docs/manual-verification/data-integrity.md", "commit": "264f70d"},
        )
        self.assertEqual(self.contract["baseline"], {"rows": 267, "observations": len(observations)})
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(re.fullmatch(r"DI-\d+[a-z]?\.\d+", key) for key in keys))
        source_ids = {source_id for item in observations for source_id in item["sourceIds"]}
        self.assertEqual(len(source_ids), self.contract["baseline"]["rows"])
        self.assertTrue(all(len(item["sourceIds"]) == 1 for item in observations))
        self.assertTrue(all(re.fullmatch(r"DI-\d+[a-z]?", source_id) for source_id in source_ids))

        for item in observations:
            self.assertTrue(item["sourceIds"])
            self.assertTrue(item["observation"].strip())
            if item["status"] == "automated":
                self.assertTrue(item["testIds"])
                self.assertNotIn("manual", item)
                self.assertEqual(set(item), {"key", "sourceIds", "observation", "status", "testIds"})
            else:
                self.assertEqual(item["status"], "retired")
                self.assertNotIn("testIds", item)
                self.assertNotIn("manual", item)
                self.assertEqual(
                    set(item),
                    {"key", "sourceIds", "observation", "status", "retirementReason"},
                )

    def test_automated_test_ids_resolve_to_tests_executed_by_normal_discovery(self) -> None:
        python_ids: set[str] = set()
        node_ids: set[str] = set()
        for path in (ROOT / "tests").rglob("test_*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            module = ".".join(path.relative_to(ROOT).with_suffix("").parts)
            for class_node in (node for node in tree.body if isinstance(node, ast.ClassDef)):
                for method in class_node.body:
                    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and method.name.startswith("test_"):
                        python_ids.add(f"python:{module}.{class_node.name}.{method.name}")
        for path in (ROOT / "tests").rglob("test_*.cjs"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"(?m)^\s*(?:test|nodeTest)\(\s*([\"'])(.*?)\1", source):
                node_ids.add(f"node:{path.relative_to(ROOT).as_posix()}::{match.group(2)}")

        referenced = {
            test_id
            for item in self.contract["observations"]
            if item["status"] == "automated"
            for test_id in item["testIds"]
        }
        self.assertEqual(referenced - python_ids - node_ids, set())

    def test_no_manual_checklist_or_manual_observations_remain(self) -> None:
        self.assertFalse(MANUAL_PATH.exists())
        self.assertNotIn("manual", {item["status"] for item in self.contract["observations"]})


if __name__ == "__main__":
    unittest.main()
