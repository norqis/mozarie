from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def subprocess_python() -> str:
    executable = Path(sys.executable)
    if not any(executable.parent.glob("python*._pth")):
        return str(executable)
    return shutil.which("python") or str(executable)


class RuntimeProfileSubprocessTests(unittest.TestCase):
    def test_setup_marker_preserves_profiles_in_paths_with_punctuation(self) -> None:
        source_root = Path(__file__).resolve().parents[1]
        setup = (source_root / "setup.bat").read_text(encoding="utf-8")
        marker_line = next(line for line in setup.splitlines() if "ConvertFrom-Json).profile" in line)
        command = re.search(r'-Command "(.+)"`', marker_line).group(1)
        with tempfile.TemporaryDirectory() as directory:
            for name in ("plain", "日本語 O'Connor [trial]"):
                app = (Path(directory) / name).resolve()
                venv = app / ".venv"
                venv.mkdir(parents=True)
                for profile in ("cuda", "directml", "cpu"):
                    with self.subTest(path=name, profile=profile):
                        marker = venv / ".mozarie-runtime.json"
                        marker.write_text(json.dumps({"schema": 1, "profile": profile}), encoding="utf-8")
                        app_dir = str(app) + os.sep
                        # Execute only the product's marker read, including CMD's
                        # path substitution for the old form of this command.
                        result = subprocess.run(
                            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command.replace("%APP_DIR%", app_dir)],
                            cwd=app, env=os.environ | {"APP_DIR": app_dir},
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=30, check=False,
                        )
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertEqual(result.stdout.strip(), profile)
                        self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["profile"], profile)

    def test_module_execution_avoids_the_app_http_module_shadow(self) -> None:
        """The batch/updater form must keep stdlib http ahead of mozarie/http.py."""
        source_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            package = app / "mozarie"
            package.mkdir(parents=True)
            shutil.copy2(source_root / "mozarie" / "runtime_profile.py", package / "runtime_profile.py")
            (package / "http.py").write_text("raise RuntimeError('app http was imported')\n", encoding="utf-8")
            site = app / "site"
            site.mkdir()
            (site / "onnxruntime.py").write_text(
                "from http import HTTPStatus\n"
                "def get_available_providers(): return ['CPUExecutionProvider']\n",
                encoding="utf-8",
            )
            metadata = site / "onnxruntime-1.0.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text("Name: onnxruntime\nVersion: 1.0\n", encoding="utf-8")
            environment = os.environ | {"PYTHONPATH": str(site)}
            command = [subprocess_python(), "-S", "-m", "mozarie.runtime_profile", "preflight", "cpu", "--venv", str(app / ".venv")]
            result = subprocess.run(command, cwd=app, env=environment, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            direct = subprocess.run(
                [subprocess_python(), "-S", str(package / "runtime_profile.py"), "preflight", "cpu", "--venv", str(app / ".venv")],
                cwd=app, env=environment, capture_output=True, text=True, encoding="utf-8",
            )
            self.assertNotEqual(direct.returncode, 0, direct.stdout + direct.stderr)
            self.assertIn("app http was imported", direct.stderr)


if __name__ == "__main__":
    unittest.main()
