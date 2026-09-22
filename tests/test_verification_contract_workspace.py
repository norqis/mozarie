from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "tests" / "verification-contracts.workspace.json"
MANUAL = ROOT / "docs" / "manual-verification" / "workspace.md"

class WorkspaceVerificationContractTests(unittest.TestCase):
    def test_contract_schema_matches_only_external_manual_rows(self) -> None:
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

        automated = [item for item in observations if item["status"] == "automated"]
        retired = [item for item in observations if item["status"] == "retired"]
        self.assertEqual(len(automated) + len(retired), len(observations))
        statuses = {item["status"] for item in observations}
        self.assertIn("automated", statuses)
        self.assertTrue(statuses <= {"automated", "retired"})
        for item in automated:
            self.assertTrue(item.get("testIds"), item["key"])
            self.assertNotIn("manual", item, item["key"])
            self.assertTrue(all(re.fullmatch(r"(?:node:tests/.+\.cjs::.+|python:tests\..+\.test_.+)", test_id) for test_id in item["testIds"]), item["key"])
        for item in retired:
            self.assertEqual(set(item), {"key", "sourceIds", "observation", "status", "retirementReason"}, item["key"])

        self.assertFalse(MANUAL.exists(), "the completed checklist is deleted")

if __name__ == "__main__":
    unittest.main()
