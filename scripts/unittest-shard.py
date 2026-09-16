#!/usr/bin/env python3
"""Discover and run one deterministic unittest shard."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import unittest


def flatten(suite: unittest.TestSuite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from flatten(test)
        else:
            yield test


def selected_tests(tests, shard_index: int, shard_total: int):
    ordered = sorted(tests, key=lambda test: test.id())
    return ordered, [test for position, test in enumerate(ordered) if position % shard_total == shard_index]


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard-index", type=int, required=True)
    parser.add_argument("--shard-total", type=int, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--start-directory", default="tests")
    parser.add_argument("--top-level-directory", default=".")
    args = parser.parse_args(argv)
    if args.shard_total < 1 or not 0 <= args.shard_index < args.shard_total:
        parser.error("shard index must be within shard total")

    manifest = {
        "schema": 1,
        "shard": {"index": args.shard_index, "total": args.shard_total},
        "discovered": [],
        "selected": [],
        "testsRun": 0,
        "skipped": 0,
        "status": "error",
    }
    try:
        loader = unittest.defaultTestLoader
        discovered = list(flatten(loader.discover(args.start_directory, top_level_dir=args.top_level_directory)))
        ordered, selected = selected_tests(discovered, args.shard_index, args.shard_total)
        manifest["discovered"] = [test.id() for test in ordered]
        manifest["selected"] = [test.id() for test in selected]
        result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))
        manifest["testsRun"] = result.testsRun
        manifest["skipped"] = len(result.skipped)
        manifest["status"] = "passed" if result.wasSuccessful() else "failed"
        return 0 if result.wasSuccessful() else 1
    except BaseException:
        manifest["status"] = "error"
        raise
    finally:
        write_manifest(args.manifest, manifest)


if __name__ == "__main__":
    sys.exit(main())
