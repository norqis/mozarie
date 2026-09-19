from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "tests" / "verification-contracts.workspace.json"
MANUAL = ROOT / "docs" / "manual-verification" / "workspace.md"


def _python_test_ids() -> set[str]:
    ids: set[str] = set()
    for path in (ROOT / "tests").glob("test_*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for item in tree.body:
            if not isinstance(item, ast.ClassDef):
                continue
            for member in item.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)) and member.name.startswith("test_"):
                    ids.add(f"python:tests.{path.stem}.{item.name}.{member.name}")
    return ids


def _node_test_ids() -> set[str]:
    ids: set[str] = set()
    pattern = re.compile(r'(?:nodeTest|test)\(\s*["\']([^"\']+)["\']')
    for path in (ROOT / "tests").glob("test_*.cjs"):
        for name in pattern.findall(path.read_text(encoding="utf-8")):
            ids.add(f"node:tests/{path.name}::{name}")
    return ids


class WorkspaceVerificationContractTests(unittest.TestCase):
    def test_contract_references_executed_tests_and_only_external_manual_rows(self) -> None:
        contract = json.loads(CONTRACT.read_text(encoding="utf-8-sig"))
        self.assertEqual(contract["version"], 1)
        self.assertEqual(contract["domain"], "workspace")
        self.assertEqual(
            contract["source"],
            {"path": "docs/manual-verification/workspace.md", "commit": "264f70d"},
        )
        observations = contract["observations"]
        self.assertEqual(contract["baseline"], {"rows": 138, "observations": len(observations)})
        keys = [item["key"] for item in observations]
        self.assertEqual(len(keys), len(set(keys)), "workspace observation keys must stay unique")
        self.assertTrue(all(re.fullmatch(r"WS-\d{3}\.\d+", key) for key in keys))

        discovered = _python_test_ids() | _node_test_ids()
        automated = [item for item in observations if item["status"] == "automated"]
        manual = [item for item in observations if item["status"] == "manual"]
        self.assertEqual(len(automated), 215)
        self.assertEqual(len(manual), 17)
        for item in automated:
            self.assertTrue(item.get("testIds"), item["key"])
            self.assertNotIn("manual", item, item["key"])
            self.assertEqual(
                sorted(set(item["testIds"]) - discovered),
                [],
                f'{item["key"]} must reference an executable fully-qualified test ID',
            )
        for item in manual:
            details = item.get("manual", {})
            self.assertTrue(details.get("environment", "").strip(), item["key"])
            self.assertTrue(details.get("reason", "").strip(), item["key"])
            self.assertNotIn("testIds", item, item["key"])

        retained_ids = set(re.findall(r"^\| (WS-\d{3}) \|", MANUAL.read_text(encoding="utf-8"), re.MULTILINE))
        expected_manual_ids = {source_id for item in manual for source_id in item["sourceIds"]}
        self.assertEqual(retained_ids, expected_manual_ids)

    def test_missing_executable_reference_is_rejected_by_the_contract_rule(self) -> None:
        discovered = _python_test_ids() | _node_test_ids()
        mutated_reference = "python:tests.missing.MissingTests.test_missing"
        self.assertNotIn(
            mutated_reference,
            discovered,
            "mutation guard: an invented test ID must not satisfy the executable-test contract",
        )


if __name__ == "__main__":
    unittest.main()
