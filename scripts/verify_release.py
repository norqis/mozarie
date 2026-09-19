from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path


JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龠々]")


def verify_release(*, version: str, tag: str, release_name: str, pr_title: str, pr_body: str,
                   merged_sha: str, expected_sha: str, merged_branch: str, remote_branches: list[str]) -> None:
    expected_tag = f"v{version}"
    if tag != expected_tag or release_name != expected_tag:
        raise ValueError("release tag and name must equal vVERSION")
    if not JAPANESE.search(pr_title) or not JAPANESE.search(pr_body):
        raise ValueError("pull request title and description must be Japanese")
    if not pr_body.strip() or len(pr_body) > 1200:
        raise ValueError("release description must be concise")
    if merged_sha != expected_sha:
        raise ValueError("merged commit does not match the reviewed commit")
    normalized = {branch.removeprefix("refs/heads/").removeprefix("origin/") for branch in remote_branches}
    if merged_branch in normalized:
        raise ValueError("merged work branch still exists")


def verify_archive_version(tag: str, archive: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        versions = [name for name in bundle.namelist() if name.rstrip("/").split("/")[-1] == "VERSION"]
        if len(versions) != 1:
            raise ValueError("release archive must contain one VERSION")
        archived = bundle.read(versions[0]).decode("utf-8").strip()
    if tag != f"v{archived}":
        raise ValueError("release archive VERSION does not match tag")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version-file", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    archive = metadata.pop("archive", None)
    verify_release(version=args.version_file.read_text(encoding="utf-8").strip(), **metadata)
    if archive:
        verify_archive_version(metadata["tag"], Path(archive))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
