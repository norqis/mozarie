"""End-to-end error contracts for the executable and update entry points."""

from __future__ import annotations

import hashlib
import io
import os
import runpy
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import server
import updater


ROOT = Path(__file__).resolve().parents[2]


def update_tree(path: Path) -> Path:
    """Create a complete small update tree without using the real installation."""
    path.mkdir(parents=True, exist_ok=True)
    for relative in updater.MANAGED_DIRECTORIES:
        (path / relative).mkdir(parents=True, exist_ok=True)
    for relative in updater.MANAGED_FILES:
        target = path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(relative, encoding="utf-8")
    (path / "mozarie" / "runtime_profile.py").write_text("# validator\n", encoding="utf-8")
    return path


def ready_app(path: Path, profile: str = "cuda") -> tuple[Path, Path]:
    app = update_tree(path)
    python = app / ".venv" / "Scripts" / "python.exe"
    python.parent.mkdir(parents=True, exist_ok=True)
    python.touch()
    (app / ".venv" / ".mozarie-runtime.json").write_text(
        '{"schema": 1, "profile": "' + profile + '"}', encoding="utf-8"
    )
    return app, python


class ServerEntrypointCoverageTests(unittest.TestCase):
    def test_server_import_path_browser_errors_and_busy_main(self) -> None:
        original_path = list(sys.path)
        try:
            sys.path[:] = [entry for entry in sys.path if Path(entry or ".").resolve() != ROOT]
            runpy.run_path(str(ROOT / "server.py"), run_name="server_path_probe")
        finally:
            sys.path[:] = original_path

        with patch("server.webbrowser.open", side_effect=OSError("no browser")), patch("server.LOGGER.warning") as warning:
            server._open_browser("http://127.0.0.1:1")
        warning.assert_called_once()
        with patch("server.webbrowser.open", side_effect=RuntimeError("unexpected")), patch("server.LOGGER.exception") as logged:
            server._open_browser("http://127.0.0.1:1")
        logged.assert_called_once()

        with patch.object(sys, "argv", ["server.py"]), patch("server.MaintenanceLock", side_effect=updater.UpdateError("busy")):
            with self.assertRaises(SystemExit) as exited:
                server.main()
        self.assertEqual(exited.exception.code, 1)

    def test_server_script_entrypoint_runs(self) -> None:
        with patch.object(sys, "argv", [str(ROOT / "server.py"), "--help"]):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(ROOT / "server.py"), run_name="__main__")
        self.assertEqual(exited.exception.code, 0)


class UpdaterCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        updater._language = "ja"

    def test_read_and_fetch_report_real_file_and_network_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(updater.UpdateError):
                updater.read_local_version(Path(directory))

        def unavailable(*_args, **_kwargs):
            raise OSError("offline")

        with self.assertRaises(updater.UpdateError):
            updater.fetch_latest_release(unavailable)

    def test_download_extract_and_running_handle_os_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def unavailable(*_args, **_kwargs):
                raise OSError("offline")

            with self.assertRaises(updater.UpdateError):
                updater.download_archive("https://example.test/archive.zip", root / "archive.zip", "0" * 64, 1, unavailable)

            broken = root / "broken.zip"
            broken.write_bytes(b"not a zip")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(broken, root / "out")

            cache = root / ".mozarie-cache" / "process-1"
            cache.mkdir(parents=True)
            lock = cache / ".active.lock"
            lock.touch()
            with patch.object(Path, "open", side_effect=OSError("denied")):
                self.assertEqual(updater.mozarie_running_status(root), "check_failed")

    def test_extract_rejects_a_path_that_escapes_during_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("wrapper/file.txt", "x")
            with patch.object(Path, "is_relative_to", return_value=False):
                with self.assertRaises(updater.UpdateError):
                    updater.extract_archive(archive, root / "out")

    def test_install_requirements_covers_missing_incoming_and_each_failed_command(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "mozarie").mkdir(parents=True)
            (source / "mozarie" / "requirements-cpu.txt").write_text("cpu\n", encoding="utf-8")
            app, _python = ready_app(root / "app")
            self.assertFalse(updater.install_requirements(source, app))

        for failed_index in (1, 3):
            with self.subTest(failed_index=failed_index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = update_tree(root / "source")
                app, _python = ready_app(root / "app")
                (source / "requirements.txt").write_text("new dependency\n", encoding="utf-8")
                results = [SimpleNamespace(returncode=0) for _ in range(4)]
                results[failed_index] = SimpleNamespace(returncode=1)
                with patch("updater.subprocess.run", side_effect=results):
                    with self.assertRaises(updater.UpdateError):
                        updater.install_requirements(source, app)

    def test_runtime_profile_verification_requires_both_real_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            with self.assertRaises(updater.UpdateError):
                updater._verify_installed_runtime_profile(app, app / "python.exe", app / "validator.py", "cuda")

    def test_apply_update_covers_backup_and_cleanup_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = update_tree(root / "source")
            app = root / "app"
            app.mkdir()
            with patch("updater.tempfile.mkdtemp", side_effect=OSError("no backup")):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, app)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = update_tree(root / "source")
            app = root / "app"
            (app / "mozarie").mkdir(parents=True)
            with patch("updater._copy_path", side_effect=OSError("copy failed")), patch("updater.shutil.rmtree", side_effect=OSError("cleanup failed")):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, app)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = update_tree(root / "source")
            app = root / "app"
            app.mkdir()
            with patch("updater.shutil.rmtree", side_effect=OSError("cleanup failed")):
                updater.apply_update(source, app)

    def test_apply_update_rolls_back_new_path_without_a_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = update_tree(root / "source")
            app = root / "app"
            app.mkdir()
            (app / "README.md").write_text("old", encoding="utf-8")

            original_copy = updater._copy_path

            def fail_new_mozarie(current: Path, destination: Path) -> None:
                if current == source / "mozarie":
                    raise OSError("write failed")
                original_copy(current, destination)

            with patch("updater._copy_path", side_effect=fail_new_mozarie), patch("updater.shutil.rmtree", side_effect=OSError("cleanup failed")):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, app)

    def test_perform_update_rethrows_without_dependency_change_and_skips_missing_ready_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"
            app.mkdir()
            (app / "VERSION").write_text("1.0.0", encoding="utf-8")
            release = {"tag_name": "v1.1.0"}
            with patch("updater.fetch_latest_release", return_value=release), patch("updater.mozarie_running_status", return_value="none"), patch("updater.release_archive", return_value=("https://example.test/a.zip", "0" * 64, 1)), patch("updater.download_archive"), patch("updater.extract_archive", return_value=app), patch("updater.read_local_version", side_effect=["1.0.0", "1.1.0"]), patch("updater.install_requirements", return_value=False), patch("updater.apply_update", side_effect=updater.UpdateError("copy failed")):
                with self.assertRaises(updater.UpdateError):
                    updater._perform_update(app, input_fn=lambda _prompt: "yes")

            with patch("updater.fetch_latest_release", return_value=release), patch("updater.mozarie_running_status", return_value="none"), patch("updater.release_archive", return_value=("https://example.test/a.zip", "0" * 64, 1)), patch("updater.download_archive"), patch("updater.extract_archive", return_value=app), patch("updater.read_local_version", side_effect=["1.0.0", "1.1.0"]), patch("updater.install_requirements", return_value=True), patch("updater.apply_update"), patch("updater.run_gpu_smoke"):
                self.assertEqual(updater._perform_update(app, input_fn=lambda _prompt: "yes"), updater.EXIT_UPDATED)
            self.assertFalse((app / ".venv" / ".mozarie-ready").exists())

    def test_updater_main_handles_setup_and_unexpected_exits(self) -> None:
        with patch.object(sys, "argv", ["updater.py", "--run-setup-locked"]), patch("updater.MaintenanceLock"), patch("updater.subprocess.run", return_value=SimpleNamespace(returncode=7)):
            self.assertEqual(updater.main(), 7)
        with patch.object(sys, "argv", ["updater.py", "--run-setup-locked"]), patch("updater.MaintenanceLock", side_effect=updater.UpdateError("busy")):
            self.assertEqual(updater.main(), updater.EXIT_ERROR)
        with patch.object(sys, "argv", ["updater.py"]), patch("updater.perform_update", side_effect=KeyboardInterrupt):
            self.assertEqual(updater.main(), updater.EXIT_CANCELLED)
        with patch.object(sys, "argv", ["updater.py"]), patch("updater.perform_update", side_effect=RuntimeError("bad")):
            self.assertEqual(updater.main(), updater.EXIT_ERROR)

    def test_updater_script_entrypoint_runs(self) -> None:
        with patch.object(sys, "argv", [str(ROOT / "updater.py"), "--check-running"]):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(ROOT / "updater.py"), run_name="__main__")
        self.assertIn(exited.exception.code, {updater.EXIT_CURRENT, updater.EXIT_RUNNING, updater.EXIT_RUNNING_CHECK_FAILED})


if __name__ == "__main__":
    unittest.main()
