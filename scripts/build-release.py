"""Build the public ZIP using the layout accepted by installed updaters."""
import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import updater


def build_release(commit: str, output: Path) -> None:
    output = output.resolve()
    with tempfile.TemporaryDirectory(prefix="mozarie-package-", dir=output.parent) as directory:
        workspace = Path(directory)
        archive = workspace / "mozarie.zip"
        subprocess.run(["git", "archive", "--format=zip", "--prefix=mozarie-release/",
                        "--output", str(archive), commit], cwd=ROOT, check=True)
        updater.extract_archive(archive, workspace / "extracted")
        archive.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_release(args.commit, args.output)
