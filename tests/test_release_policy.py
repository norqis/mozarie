from __future__ import annotations

import unittest
import tempfile
import zipfile
from pathlib import Path

from scripts.verify_release import verify_archive_version, verify_release


class ReleasePolicyTests(unittest.TestCase):
    def valid(self) -> dict:
        return {
            "version": "0.5.20", "tag": "v0.5.20", "release_name": "v0.5.20",
            "pr_title": "保存処理の検証を追加", "pr_body": "保存と更新の回帰テストを追加しました。",
            "merged_sha": "abc123", "expected_sha": "abc123", "merged_branch": "codex/save",
            "remote_branches": ["main"],
        }

    def test_release_tag_name_and_version_are_identical(self) -> None:
        verify_release(**self.valid())
        for field, value in (("tag", "v0.5.19"), ("release_name", "Mozarie v0.5.20")):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "vVERSION"):
                verify_release(**{**self.valid(), field: value})

    def test_release_archive_version_matches_the_tag(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            archive = Path(raw) / "mozarie.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("mozarie/VERSION", "0.5.20\n")
            verify_archive_version("v0.5.20", archive)
            with self.assertRaisesRegex(ValueError, "does not match"):
                verify_archive_version("v0.5.19", archive)

    def test_pull_request_and_release_description_use_concise_japanese(self) -> None:
        for changed in ({"pr_title": "Save changes"}, {"pr_body": "Save changes"}, {"pr_body": "変" * 1201}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                verify_release(**{**self.valid(), **changed})

    def test_merge_commit_matches_and_merged_branch_is_removed(self) -> None:
        with self.assertRaisesRegex(ValueError, "reviewed commit"):
            verify_release(**{**self.valid(), "merged_sha": "other"})
        with self.assertRaisesRegex(ValueError, "branch still exists"):
            verify_release(**{**self.valid(), "remote_branches": ["origin/codex/save"]})


if __name__ == "__main__":
    unittest.main()
