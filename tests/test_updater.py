from __future__ import annotations

import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import string
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import updater


def make_release(tag: str = "v1.2.0", url: str = "https://example.test/release.zip") -> dict:
    return {"tag_name": tag, "immutable": True, "assets": [{
        "name": "mozarie.zip", "state": "uploaded", "browser_download_url": url,
        "digest": "sha256:" + "0" * 64, "size": 1,
    }]}


def make_source(root: Path, version: str = "1.2.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("new server", encoding="utf-8")
    (root / "run.bat").write_text("new run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "README.md").write_text("new Japanese readme", encoding="utf-8")
    (root / "README.en.md").write_text("new English readme", encoding="utf-8")
    (root / "mozarie").mkdir()
    (root / "mozarie" / "core.py").write_text("new core", encoding="utf-8")
    (root / "mozarie" / "runtime_profile.py").write_text("new profile", encoding="utf-8")
    (root / "mozarie" / "requirements-directml.txt").write_text("directml\n", encoding="utf-8")
    (root / "mozarie" / "requirements-cpu.txt").write_text("cpu\n", encoding="utf-8")
    (root / "static").mkdir()
    (root / "static" / "app.js").write_text("new app", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "defaults.json").write_text("{}", encoding="utf-8")
    (root / "update.bat").write_text("new updater entry", encoding="utf-8")
    (root / "setup.bat").write_text("new setup", encoding="utf-8")
    (root / ".gitattributes").write_text("* text=auto\n", encoding="utf-8")
    (root / ".gitignore").write_text("output/\n", encoding="utf-8")
    (root / "LICENSE").write_text("MIT", encoding="utf-8")
    (root / "THIRD_PARTY_NOTICES.md").write_text("notices", encoding="utf-8")
    for relative in updater.MANAGED_FILES:
        path = root / relative
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"new {relative}", encoding="utf-8")
    return root


def make_install(root: Path, version: str = "1.1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version, encoding="utf-8")
    (root / "server.py").write_text("old server", encoding="utf-8")
    (root / "run.bat").write_text("old run", encoding="utf-8")
    (root / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
    (root / "README.md").write_text("old Japanese readme", encoding="utf-8")
    (root / "README.en.md").write_text("old English readme", encoding="utf-8")
    (root / "mozarie").mkdir()
    (root / "mozarie" / "core.py").write_text("old core", encoding="utf-8")
    (root / "static").mkdir()
    (root / "static" / "app.js").write_text("old app", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "defaults.json").write_text('{"old": true}', encoding="utf-8")
    (root / "config" / "local.json").write_text('{"mine": true}', encoding="utf-8")
    (root / "models").mkdir()
    (root / "models" / "model.onnx").write_bytes(b"model")
    (root / ".mozarie-cache").mkdir()
    (root / ".mozarie-cache" / "draft.bin").write_bytes(b"draft")
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("main", encoding="utf-8")
    (root / "update.bat").write_text("stable entry", encoding="utf-8")
    return root


def write_runtime_marker(app: Path, profile: str = "cuda") -> Path:
    marker = app / ".venv" / ".mozarie-runtime.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"schema": 1, "profile": profile}), encoding="utf-8")
    return marker


UPDATE_ARCHIVE_CONTENTS = {
    **{f"wrapper/{relative}": "file" for relative in updater.MANAGED_FILES},
    "wrapper/server.py": "server",
    "wrapper/run.bat": "run",
    "wrapper/VERSION": "1.2.0",
    "wrapper/mozarie/core.py": "core",
    "wrapper/mozarie/runtime_profile.py": "profile",
    "wrapper/mozarie/requirements-directml.txt": "directml",
    "wrapper/mozarie/requirements-cpu.txt": "cpu",
    "wrapper/static/app.js": "app",
}


def write_archive(archive: Path, contents: dict[str, str]) -> None:
    with zipfile.ZipFile(archive, "w") as bundle:
        for path, data in contents.items():
            bundle.writestr(path, data)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        updater._language = "ja"

    def test_version_parsing_and_display(self):
        self.assertEqual(updater.parse_version("v1.2.3"), (1, 2, 3))
        self.assertEqual(updater.display_version("1.2.3"), "v1.2.3")
        with self.assertRaises(updater.UpdateError):
            updater.parse_version("1.2")

    def test_os_errors_are_reported_without_exposing_path_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "VERSION").mkdir()
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("version_read"))) as raised:
                updater.read_local_version(root)
            self.assertNotIn(str(root), str(raised.exception))

            archive = root / "release.zip"
            write_archive(archive, UPDATE_ARCHIVE_CONTENTS)
            blocked_destination = root / "blocked"
            blocked_destination.write_text("not a folder", encoding="utf-8")
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_extract"))) as raised:
                updater.extract_archive(archive, blocked_destination)
            self.assertNotIn(str(blocked_destination), str(raised.exception))

    def test_release_asset_must_be_the_immutable_mozarie_asset(self):
        release = make_release()
        release["assets"][0]["browser_download_url"] = "https://example.test/asset.zip"
        self.assertEqual(updater.release_archive(release)[0], "https://example.test/asset.zip")
        release["assets"][0]["name"] = "other.zip"
        with self.assertRaises(updater.UpdateError):
            updater.release_archive(release)

    def test_download_rejects_a_digest_or_size_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "release.zip"
            body = b"archive"
            digest = __import__("hashlib").sha256(body).hexdigest()
            updater.download_archive("https://example.test/release.zip", destination, digest, len(body), lambda *_args, **_kwargs: Response(body))
            with self.assertRaises(updater.UpdateError):
                updater.download_archive("https://example.test/release.zip", destination, "0" * 64, len(body), lambda *_args, **_kwargs: Response(body))
            with self.assertRaises(updater.UpdateError):
                updater.download_archive("https://example.test/release.zip", destination, digest, len(body) + 1, lambda *_args, **_kwargs: Response(body))

    def test_requirements_install_uses_the_app_venv_not_the_updater_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            write_runtime_marker(app)
            (source / "requirements.txt").write_text("new-dependency\n", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                self.assertTrue(updater.install_requirements(source, app))
            self.assertEqual(
                run.call_args_list[0].args[0],
                [str(python), "-m", "mozarie.runtime_profile", "preflight", "cuda", "--venv", str(app / ".venv")],
            )
            self.assertEqual(run.call_args_list[0].kwargs["cwd"], str(source))
            self.assertEqual(run.call_args_list[1].args[0][:3], [str(python), "-m", "pip"])
            self.assertEqual(
                run.call_args_list[1].args[0][3:],
                ["install", "--disable-pip-version-check", "--progress-bar", "on", "-r", str(source / "requirements.txt")],
            )
            self.assertEqual(run.call_args_list[2].args[0], [str(python), "-m", "pip", "check"])

    def test_requirements_update_removes_ready_marker_before_pip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            write_runtime_marker(app)
            ready_marker = app / ".venv" / ".mozarie-ready"
            ready_marker.write_text("ready\n", encoding="utf-8")
            (source / "requirements.txt").write_text("new-dependency\n", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                self.assertTrue(updater.install_requirements(source, app))
            self.assertFalse(ready_marker.exists())

    def test_failed_pip_check_leaves_the_install_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = make_source(root / "source"); app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"; python.parent.mkdir(parents=True); python.touch()
            write_runtime_marker(app)
            marker = app / ".venv" / ".mozarie-ready"; marker.write_text("ready\n", encoding="utf-8")
            (source / "requirements.txt").write_text("new-dependency\n", encoding="utf-8")
            with patch("updater.subprocess.run", side_effect=[
                type("Result", (), {"returncode": 0})(),
                type("Result", (), {"returncode": 0})(),
                type("Result", (), {"returncode": 1})(),
            ]):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("requirements_failed"))):
                    updater.install_requirements(source, app)
            self.assertFalse(marker.exists())
            self.assertEqual((app / "VERSION").read_text(encoding="utf-8"), "1.1.0")

    def test_gpu_smoke_uses_the_updated_app_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            app = make_install(Path(directory) / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True); python.touch()
            (app / "setup_gpu_check.py").write_text("# smoke", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                updater.run_gpu_smoke(app)
            self.assertEqual(run.call_args.args[0], [str(python), "-X", "utf8", str(app / "setup_gpu_check.py")])
            self.assertEqual(run.call_args.kwargs["cwd"], str(app))

    def test_dependency_update_runs_gpu_smoke_before_marking_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            (app / ".venv").mkdir()
            source = make_source(root / "source")
            with patch("updater.fetch_latest_release", return_value=make_release()), \
                    patch("updater.download_archive"), \
                    patch("updater.extract_archive", return_value=source), \
                    patch("updater.install_requirements", return_value=True), \
                    patch("updater.apply_update"), \
                    patch("updater.run_gpu_smoke") as smoke:
                self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "y"), updater.EXIT_UPDATED)
            smoke.assert_called_once_with(app)
            self.assertEqual((app / ".venv" / ".mozarie-ready").read_text(encoding="utf-8"), "ready\n")

    def test_gpu_smoke_failure_does_not_mark_runtime_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            (app / ".venv").mkdir()
            source = make_source(root / "source")
            with patch("updater.fetch_latest_release", return_value=make_release()), \
                    patch("updater.download_archive"), \
                    patch("updater.extract_archive", return_value=source), \
                    patch("updater.install_requirements", return_value=True), \
                    patch("updater.apply_update"), \
                    patch("updater.run_gpu_smoke", side_effect=updater.UpdateError(updater.tr("gpu_check_failed"))):
                with self.assertRaisesRegex(updater.UpdateError, "GPU"):
                    updater.perform_update(app, input_fn=lambda _prompt: "y")
            self.assertFalse((app / ".venv" / ".mozarie-ready").exists())

    def test_maintenance_lock_rejects_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            root = Path(__file__).resolve().parents[1]
            code = "from pathlib import Path; import sys; sys.path.insert(0,r'%s'); import updater; lock=updater.MaintenanceLock(Path(r'%s')); lock.__enter__(); print('locked', flush=True); sys.stdin.readline(); lock.close()" % (str(root), str(app))
            process = subprocess.Popen([sys.executable, "-c", code], cwd=str(Path(__file__).parents[1]), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline().strip(), "locked")
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("update_in_progress"))):
                    with updater.MaintenanceLock(app):
                        pass
            finally:
                if process.poll() is None and process.stdin:
                    process.stdin.write("\n"); process.stdin.close()
                process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()

    def test_unchanged_requirements_leave_ready_marker_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            ready_marker = app / ".venv" / ".mozarie-ready"
            ready_marker.parent.mkdir()
            write_runtime_marker(app)
            ready_marker.write_text("ready\n", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                self.assertFalse(updater.install_requirements(source, app))
            run.assert_not_called()
            self.assertTrue(ready_marker.exists())

    def test_requirements_install_preserves_the_directml_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            (app / ".venv" / ".mozarie-runtime.json").write_text(
                json.dumps({"schema": 1, "profile": "directml"}), encoding="utf-8"
            )
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                updater.install_requirements(source, app)
            self.assertEqual(run.call_args_list[0].args[0][1:4], ["-m", "mozarie.runtime_profile", "preflight"])
            self.assertEqual(run.call_args_list[0].kwargs["cwd"], str(source))
            command = run.call_args_list[1].args[0]
            self.assertEqual(command[:3], [str(python), "-m", "pip"])
            self.assertEqual(Path(command[-1]), source / "mozarie" / "requirements-directml.txt")
            self.assertEqual(run.call_args_list[2].args[0], [str(python), "-m", "pip", "check"])
            self.assertEqual(run.call_args_list[3].args[0][1:4], ["-m", "mozarie.runtime_profile", "validate"])
            self.assertEqual(run.call_args_list[3].kwargs["cwd"], str(source))

    def test_requirements_install_preserves_the_cpu_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            write_runtime_marker(app, "cpu")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 0
                updater.install_requirements(source, app)
            self.assertEqual(run.call_args_list[0].args[0][1:4], ["-m", "mozarie.runtime_profile", "preflight"])
            self.assertEqual(run.call_args_list[0].kwargs["cwd"], str(source))
            self.assertEqual(Path(run.call_args_list[1].args[0][-1]), source / "mozarie" / "requirements-cpu.txt")

    def test_markerless_cpu_and_directml_venvs_fail_before_pip(self):
        for profile, distribution in (("cpu", "onnxruntime"), ("directml", "onnxruntime_directml")):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = make_source(root / "source")
                app = make_install(root / "app")
                python = app / ".venv" / "Scripts" / "python.exe"
                python.parent.mkdir(parents=True)
                python.touch()
                (app / ".venv" / "Lib" / "site-packages" / f"{distribution}-1.24.4.dist-info").mkdir(parents=True)
                with patch("updater.subprocess.run") as run:
                    with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("runtime_profile_invalid"))):
                        updater.install_requirements(source, app)
                run.assert_not_called()

    def test_invalid_runtime_markers_fail_before_pip(self):
        invalid_markers = ("not-json", json.dumps({"profile": "directml"}), json.dumps({"schema": 1, "profile": "unknown"}))
        for marker_body in invalid_markers:
            with self.subTest(marker=marker_body), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = make_source(root / "source")
                app = make_install(root / "app")
                marker = app / ".venv" / ".mozarie-runtime.json"
                marker.parent.mkdir(parents=True)
                marker.write_text(marker_body, encoding="utf-8")
                with patch("updater.subprocess.run") as run:
                    with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("runtime_profile_invalid"))):
                        updater.install_requirements(source, app)
                run.assert_not_called()

    def test_marker_and_runtime_mismatch_fails_before_pip_or_ready_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = make_source(root / "source")
            app = make_install(root / "app")
            python = app / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            write_runtime_marker(app, "directml")
            ready = app / ".venv" / ".mozarie-ready"
            ready.write_text("ready\n", encoding="utf-8")
            with patch("updater.subprocess.run") as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("runtime_profile_invalid"))):
                    updater.install_requirements(source, app)
            self.assertEqual(len(run.call_args_list), 1)
            self.assertNotIn("pip", run.call_args.args[0])
            self.assertTrue(ready.is_file())

    def test_fetch_latest_release_validates_payload(self):
        payload = json.dumps(make_release()).encode()
        self.assertEqual(updater.fetch_latest_release(lambda *_args, **_kwargs: Response(payload))["tag_name"], "v1.2.0")
        with self.assertRaises(updater.UpdateError):
            updater.fetch_latest_release(lambda *_args, **_kwargs: Response(b"{}"))

    def test_safe_extract_accepts_github_wrapper_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                for name, data in UPDATE_ARCHIVE_CONTENTS.items():
                    name = name.replace("wrapper/", "norqis-mozarie/", 1)
                    bundle.writestr(name, data)
            source = updater.extract_archive(archive, root / "out")
            self.assertEqual(source.name, "norqis-mozarie")

    def test_safe_extract_rejects_required_file_directories(self):
        for name in ("server.py", "run.bat", "VERSION"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "release.zip"
                contents = UPDATE_ARCHIVE_CONTENTS.copy()
                contents.pop(f"wrapper/{name}")
                contents[f"wrapper/{name}/child"] = "not a required file"
                write_archive(archive, contents)
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                    updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_required_directory_files(self):
        for name, content_path in (("mozarie", "mozarie/core.py"), ("static", "static/app.js")):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "release.zip"
                contents = UPDATE_ARCHIVE_CONTENTS.copy()
                for path in tuple(contents):
                    if path.startswith(f"wrapper/{name}/"):
                        contents.pop(path)
                contents[f"wrapper/{name}"] = "not a required directory"
                write_archive(archive, contents)
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                    updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_missing_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            contents = UPDATE_ARCHIVE_CONTENTS.copy()
            contents.pop("wrapper/VERSION")
            write_archive(archive, contents)
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_missing_app"))):
                updater.extract_archive(archive, root / "out")

    def test_safe_extract_rejects_invalid_paths_without_writing_outside_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "G:escaped.txt",
                "C:/absolute",
                r"C:\absolute",
                "../outside.txt",
                r"..\outside.txt",
                "root/file:stream",
                "/absolute",
                "//server/share",
            ):
                with self.subTest(name=name):
                    archive = root / "invalid.zip"
                    with zipfile.ZipFile(archive, "w") as bundle:
                        bundle.writestr(name, "bad")
                    with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                        updater.extract_archive(archive, root / "out")
                    self.assertFalse((root / "outside.txt").exists())
                    self.assertEqual(list(root.iterdir()), [archive])
                    archive.unlink()

    def test_safe_member_path_rejects_windows_reserved_names(self):
        for name in (
            "CON",
            "con.txt",
            "AUX.tar.gz",
            "nul ",
            "PRN.",
            "clock$.txt",
            "CONIN$",
            "conout$.log",
            "COM1",
            "com².txt",
            "LPT9",
            "lpt³.tar.gz",
            "COM1 .txt",
            "LPT9. ",
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                    updater._safe_member_path(zipfile.ZipInfo(f"root/{name}"))

    def test_safe_member_path_rejects_windows_forbidden_characters_and_controls(self):
        for name in ("less<than", "greater>than", 'quote"name', "pipe|name", "question?name", "star*name", "tab\tname", "control\x1fname"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                    updater._safe_member_path(zipfile.ZipInfo(f"root/{name}"))

    def test_safe_member_path_accepts_non_reserved_windows_names(self):
        for name in ("COM0", "COM10", "LPT0", "LPT10", "COM4work", ".config"):
            with self.subTest(name=name):
                self.assertEqual(updater._safe_member_path(zipfile.ZipInfo(f"root/{name}")), PurePosixPath(f"root/{name}"))

    def test_safe_extract_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            symlink = root / "symlink.zip"
            info = zipfile.ZipInfo("root/link")
            info.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(symlink, "w") as bundle:
                bundle.writestr(info, "target")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(symlink, root / "out")

    def test_safe_extract_rejects_precreated_directory_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out"
            outside = root / "outside"
            output.mkdir()
            outside.mkdir()
            try:
                (output / "root").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("directory symlinks are unavailable")

            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("root/escaped.txt", "bad")
            with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("archive_invalid_path"))):
                updater.extract_archive(archive, output)
            self.assertFalse((outside / "escaped.txt").exists())

    def test_apply_updates_code_and_preserves_user_data_and_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)):
                updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "new server")
            self.assertEqual((install / "README.md").read_text(encoding="utf-8"), "new Japanese readme")
            self.assertEqual((install / "README.en.md").read_text(encoding="utf-8"), "new English readme")
            self.assertEqual((install / "config/defaults.json").read_text(encoding="utf-8"), "{}")
            self.assertEqual((install / "config/local.json").read_text(encoding="utf-8"), '{"mine": true}')
            self.assertEqual((install / "models/model.onnx").read_bytes(), b"model")
            self.assertEqual((install / ".mozarie-cache/draft.bin").read_bytes(), b"draft")
            self.assertEqual((install / ".git/HEAD").read_text(encoding="utf-8"), "main")
            self.assertEqual((install / "update.bat").read_text(encoding="utf-8"), "new updater entry")
            self.assertEqual((install / "mozarie/runtime_profile.py").read_text(encoding="utf-8"), "new profile")
            self.assertEqual((install / "mozarie/requirements-directml.txt").read_text(encoding="utf-8"), "directml\n")
            self.assertEqual((install / "mozarie/requirements-cpu.txt").read_text(encoding="utf-8"), "cpu\n")
            self.assertFalse(backup.exists())

    def test_apply_backup_failure_leaves_install_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            original_copy = updater._copy_path

            def fail_backing_up_server(source_path: Path, destination: Path):
                if source_path == install / "server.py":
                    raise OSError("simulated backup failure")
                original_copy(source_path, destination)

            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_backing_up_server):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("update_backup_failed"))):
                    updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "old server")
            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "old app")
            self.assertFalse(backup.exists())

    def test_apply_rolls_back_only_mutated_files_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            (install / "updater.py").write_text("old updater", encoding="utf-8")
            (source / "updater.py").write_text("new updater", encoding="utf-8")
            (source / "README.md").write_text("new readme", encoding="utf-8")
            original_copy = updater._copy_path

            def fail_on_static(source_path: Path, destination: Path):
                if source_path == source / "static":
                    raise OSError("simulated failure")
                original_copy(source_path, destination)

            backup = root / "backup"
            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_on_static):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update(source, install)
            self.assertEqual((install / "server.py").read_text(encoding="utf-8"), "old server")
            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "old app")
            self.assertEqual((install / "updater.py").read_text(encoding="utf-8"), "old updater")
            self.assertEqual((install / "README.md").read_text(encoding="utf-8"), "old Japanese readme")
            self.assertEqual((install / "README.en.md").read_text(encoding="utf-8"), "old English readme")
            self.assertFalse(backup.exists())

    def test_apply_preserves_backup_when_rollback_is_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = make_install(root / "install")
            source = make_source(root / "source")
            backup = root / "backup"
            original_copy = updater._copy_path
            original_remove = updater._remove_path
            static_removals = 0

            def fail_during_update_and_restore(source_path: Path, destination: Path):
                if source_path == source / "static":
                    original_copy(source_path, destination)
                    raise OSError("simulated update failure")
                if source_path == backup / "static":
                    raise OSError("simulated restore-copy failure")
                original_copy(source_path, destination)

            def lock_static_on_rollback(path: Path):
                nonlocal static_removals
                if path == install / "static":
                    static_removals += 1
                    if static_removals == 2:
                        raise OSError("simulated locked file")
                original_remove(path)

            with patch("updater.tempfile.mkdtemp", return_value=str(backup)), \
                    patch("updater._copy_path", side_effect=fail_during_update_and_restore), \
                    patch("updater._remove_path", side_effect=lock_static_on_rollback):
                with self.assertRaisesRegex(
                    updater.UpdateError,
                    re.escape(updater.tr("update_rollback_incomplete")),
                ):
                    updater.apply_update(source, install)

            self.assertEqual((install / "mozarie/core.py").read_text(encoding="utf-8"), "old core")
            self.assertEqual((install / "static/app.js").read_text(encoding="utf-8"), "new app")
            self.assertTrue(backup.is_dir())

    def test_running_status_detects_an_active_lock_and_no_active_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            process = app / ".mozarie-cache/process-test"
            process.mkdir(parents=True)
            lock_path = process / ".active.lock"
            with lock_path.open("w+b") as handle:
                handle.write(b"1")
                handle.flush()
                handle.seek(0)
                updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_NBLCK, 1)
                try:
                    self.assertEqual(updater.mozarie_running_status(app), "active")
                finally:
                    handle.seek(0)
                    updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_UNLCK, 1)
            self.assertEqual(updater.mozarie_running_status(app), "none")

    def test_check_running_cli_returns_30_only_for_an_active_process(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            with patch.object(updater, "APP_DIR", app), patch.object(sys, "argv", ["updater.py", "--check-running"]):
                self.assertEqual(updater.main(), 0)

                process = app / ".mozarie-cache/process-test"
                process.mkdir(parents=True)
                lock_path = process / ".active.lock"
                with lock_path.open("w+b") as handle:
                    handle.write(b"1")
                    handle.flush()
                    handle.seek(0)
                    updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_NBLCK, 1)
                    try:
                        self.assertEqual(updater.main(), 30)
                    finally:
                        handle.seek(0)
                        updater.msvcrt.locking(handle.fileno(), updater.msvcrt.LK_UNLCK, 1)

            with patch.object(updater, "APP_DIR", app), patch.object(sys, "argv", ["updater.py", "--check-running"]), \
                    patch("updater.mozarie_running_status", return_value="check_failed"):
                self.assertEqual(updater.main(), updater.EXIT_RUNNING_CHECK_FAILED)

    def test_maintenance_lock_access_and_running_check_failure_are_not_reported_as_active(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            lock = updater.MaintenanceLock(app)
            with patch.object(Path, "open", side_effect=OSError("denied")):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("maintenance_lock_access"))):
                    lock.__enter__()
            app.mkdir(exist_ok=True)
            (app / "VERSION").write_text("1.0.0", encoding="utf-8")
            with patch("updater.fetch_latest_release", return_value=make_release("v1.1.0")), \
                    patch("updater.mozarie_running_status", return_value="check_failed"):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("running_check_failed"))):
                    updater._perform_update(app, input_fn=lambda _prompt: "y")

    def test_main_handles_failure_log_access_errors_after_a_public_update_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "not-a-directory"
            app_file.write_text("blocked", encoding="utf-8")
            with patch.object(updater, "APP_DIR", app_file), patch.object(updater, "perform_update", side_effect=updater.UpdateError("update failed")), \
                    patch.object(sys, "argv", ["updater.py"]):
                self.assertEqual(updater.main(), updater.EXIT_ERROR)

    def test_maintenance_lock_closes_an_acquired_handle_when_initialization_flush_fails(self):
        class FlushFailingHandle:
            def __init__(self, handle):
                self.handle = handle
                self.closed = False

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def flush(self):
                raise OSError("flush denied")

            def close(self):
                self.closed = True
                self.handle.close()

        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            lock = updater.MaintenanceLock(app)
            original_open = pathlib.io.open
            handles = []

            def open_with_failing_flush(path, *args, **kwargs):
                handle = FlushFailingHandle(original_open(path, *args, **kwargs))
                handles.append(handle)
                return handle

            with patch.object(pathlib.io, "open", side_effect=open_with_failing_flush):
                with self.assertRaisesRegex(updater.UpdateError, re.escape(updater.tr("maintenance_lock_access"))):
                    lock.__enter__()
            self.assertEqual(len(handles), 1)
            self.assertTrue(handles[0].closed)
            self.assertIsNone(lock.handle)

    def test_check_running_reports_cache_enumeration_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / ".mozarie-cache").mkdir()
            with patch.object(Path, "glob", side_effect=OSError("cache access denied")), \
                    patch.object(updater, "APP_DIR", app), patch.object(sys, "argv", ["updater.py", "--check-running"]):
                self.assertEqual(updater.main(), updater.EXIT_RUNNING_CHECK_FAILED)

    def test_read_language_prefers_valid_local_config_and_falls_back_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            config = app / "config"
            config.mkdir()
            defaults = config / "defaults.json"
            local = config / "local.json"
            defaults.write_text('{"general": {"language": "en"}}', encoding="utf-8")
            local.write_text('{"general": {"language": "ja"}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

            local.write_text('{"general": {"language": "invalid"}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "en")

            for invalid_language in ([], {}):
                with self.subTest(invalid_language=invalid_language):
                    local.write_text(
                        json.dumps({"general": {"language": invalid_language}}), encoding="utf-8"
                    )
                    self.assertEqual(updater.read_language(app), "en")

            local.write_bytes(b"\xff")
            self.assertEqual(updater.read_language(app), "en")

            local.write_text("{", encoding="utf-8")
            defaults.write_text('{"general": []}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

            local.write_text('{"general": {"language": {}}}', encoding="utf-8")
            defaults.write_text('{"general": {"language": []}}', encoding="utf-8")
            self.assertEqual(updater.read_language(app), "ja")

    def test_i18n_message_keys_and_placeholders_match(self):
        self.assertEqual(set(updater.MESSAGES["ja"]), set(updater.MESSAGES["en"]))
        formatter = string.Formatter()
        for key in updater.MESSAGES["ja"]:
            ja_fields = {field for _, field, _, _ in formatter.parse(updater.MESSAGES["ja"][key]) if field}
            en_fields = {field for _, field, _, _ in formatter.parse(updater.MESSAGES["en"][key]) if field}
            self.assertEqual(ja_fields, en_fields, key)
            self.assertNotRegex(updater.MESSAGES["en"][key], r"[ぁ-んァ-ン一-龯]", key)

    def test_current_and_cancelled_do_not_download_or_modify(self):
        with tempfile.TemporaryDirectory() as directory:
            app = make_install(Path(directory) / "install", "1.2.0")
            with patch("updater.fetch_latest_release", return_value=make_release("v1.2.0")), patch("updater.download_archive") as download:
                self.assertEqual(updater.perform_update(app), updater.EXIT_CURRENT)
                download.assert_not_called()

            (app / "VERSION").write_text("1.1.0", encoding="utf-8")
            with patch("updater.fetch_latest_release", return_value=make_release()), patch("updater.download_archive") as download:
                self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "n"), updater.EXIT_CANCELLED)
                download.assert_not_called()

    def test_update_messages_use_the_configured_language(self):
        cases = {
            "ja": {
                "current": "現在最新バージョンです",
                "cancelled": "アップデートをキャンセルしました。",
                "confirm": "アップデートしますか？",
                "updated": "アップデートしました。",
                "running": "新しいバージョンがあります。",
                "error": "エラー: details",
                "opposite": (
                    "Mozarie is already up to date",
                    "Update cancelled.",
                    "Update Mozarie?",
                    "Updated from",
                    "A new version is available.",
                    "Error: details",
                ),
            },
            "en": {
                "current": "Mozarie is already up to date",
                "cancelled": "Update cancelled.",
                "confirm": "Update Mozarie?",
                "updated": "Updated from",
                "running": "A new version is available.",
                "error": "Error: details",
                "opposite": (
                    "現在最新バージョンです",
                    "アップデートをキャンセルしました。",
                    "アップデートしますか？",
                    "アップデートしました。",
                    "新しいバージョンがあります。",
                    "エラー: details",
                ),
            },
        }
        for language, expected in cases.items():
            with self.subTest(language=language), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                app = make_install(root / "install")
                (app / "config/local.json").write_text(
                    json.dumps({"general": {"language": language}}), encoding="utf-8"
                )

                def assert_no_opposite_language(messages: list[str]):
                    combined = "\n".join(messages)
                    for phrase in expected["opposite"]:
                        self.assertNotIn(phrase, combined)

                with patch("updater.fetch_latest_release", return_value=make_release("v1.1.0")), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.perform_update(app), updater.EXIT_CURRENT)
                current_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertTrue(any(expected["current"] in message for message in current_messages))
                assert_no_opposite_language(current_messages)

                prompts: list[str] = []
                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("builtins.print") as output:
                    self.assertEqual(
                        updater.perform_update(app, input_fn=lambda prompt: prompts.append(prompt) or "n"),
                        updater.EXIT_CANCELLED,
                    )
                cancelled_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertIn(expected["cancelled"], cancelled_messages)
                self.assertTrue(any(expected["confirm"] in prompt for prompt in prompts))
                assert_no_opposite_language(cancelled_messages + prompts)

                source = make_source(root / "source")
                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("updater.download_archive"), \
                        patch("updater.extract_archive", return_value=source), \
                        patch("updater.install_requirements"), \
                        patch("updater.apply_update"), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "y"), updater.EXIT_UPDATED)
                success_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertTrue(any(expected["updated"] in message for message in success_messages))
                assert_no_opposite_language(success_messages)

                with patch("updater.fetch_latest_release", return_value=make_release()), \
                        patch("updater.mozarie_running_status", return_value="active"), \
                        self.assertRaisesRegex(updater.UpdateError, re.escape(expected["running"])) as raised:
                    updater.perform_update(app)
                assert_no_opposite_language([str(raised.exception)])

                updater._language = language
                with patch("updater.perform_update", side_effect=updater.UpdateError("details")), \
                        patch("builtins.print") as output:
                    self.assertEqual(updater.main(), updater.EXIT_ERROR)
                error_messages = [call.args[0] for call in output.call_args_list if call.args]
                self.assertIn(expected["error"], error_messages)
                assert_no_opposite_language(error_messages)

    def test_success_prints_plain_version_arrow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            (app / ".venv").mkdir()
            source = make_source(root / "source")
            with patch("updater.fetch_latest_release", return_value=make_release()), \
                    patch("updater.download_archive"), \
                    patch("updater.extract_archive", return_value=source), \
                    patch("updater.install_requirements", return_value=True), \
                    patch("updater.apply_update") as apply, \
                    patch("updater.run_gpu_smoke"), \
                    patch("builtins.print") as output:
                result = updater.perform_update(app, input_fn=lambda _prompt: "y")
            self.assertEqual(result, updater.EXIT_UPDATED)
            apply.assert_called_once_with(source, app)
            self.assertEqual((app / ".venv" / ".mozarie-ready").read_text(encoding="utf-8"), "ready\n")
            messages = [call.args[0] for call in output.call_args_list if call.args]
            self.assertIn("v1.1.0 → v1.2.0", messages)
            self.assertIn("v1.1.0 から v1.2.0 へアップデートしました。", messages)
            self.assertEqual(messages.count("Mozarieを起動し直してください。"), 1)

    def test_update_with_unchanged_requirements_does_not_create_a_ready_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = make_install(root / "install")
            (app / ".venv").mkdir()
            write_runtime_marker(app)
            source = make_source(root / "source")
            with patch("updater.fetch_latest_release", return_value=make_release()), \
                    patch("updater.download_archive"), \
                    patch("updater.extract_archive", return_value=source), \
                    patch("updater.apply_update"):
                self.assertEqual(updater.perform_update(app, input_fn=lambda _prompt: "y"), updater.EXIT_UPDATED)
            self.assertFalse((app / ".venv" / ".mozarie-ready").exists())

    def test_update_batch_delegates_status_to_updater_and_never_starts_mozarie(self):
        batch_path = Path(__file__).parents[1] / "update.bat"
        raw = batch_path.read_bytes()
        batch = raw.decode("utf-8")
        self.assertEqual(batch.count('"%PYTHON%" -X utf8 "%APP_DIR%updater.py"'), 1)
        self.assertIn(
            '"%PYTHON%" -X utf8 "%APP_DIR%updater.py"\r\n'
            'set "EXIT_CODE=%ERRORLEVEL%"\r\n'
            "goto :finish",
            batch,
        )
        self.assertIn("exit /b %EXIT_CODE%", batch)
        self.assertNotIn('"%EXIT_CODE%"==', batch)
        self.assertEqual(batch.lower().count("pause"), 1)
        self.assertRegex(batch, r"(?m)^pause\r?$")
        self.assertNotIn("pause >nul", batch)
        self.assertIn("MOZARIE_PYTHON is invalid. / MOZARIE_PYTHON が正しくありません。", batch)
        self.assertIn(
            "Python 3.11 or newer was not found. Run setup.bat, or set MOZARIE_PYTHON. / "
            "Python 3.11 以上が見つかりません。setup.batを実行するかMOZARIE_PYTHONを設定してください。",
            batch,
        )
        self.assertEqual(len(re.findall(r"(?mi)^echo (?!off$)", batch)), 2)
        self.assertNotIn("run.bat", batch.lower())
        self.assertIn("update.bat", updater.MANAGED_FILES)
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))

    def test_setup_checks_the_created_venv_python_version_before_pip(self):
        batch = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        version_check = '"%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize(\'P\') == 8 else 1)"'
        self.assertIn(version_check, batch)
        install_index = batch.index('"%PYTHON%" -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --upgrade pip')
        self.assertLess(batch.index("call :validate_python"), install_index)

    def test_setup_shows_five_steps_under_the_maintenance_lock_before_pip(self):
        batch = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        setup_check = "echo [Mozarie] [1/5] Checking Python environment..."
        create_venv = 'if not exist "%PYTHON%" call :create_venv'
        maintenance_check = 'py -%%V -X utf8 "%APP_DIR%updater.py" --run-setup-locked'
        marker_removal = 'if exist "%APP_DIR%.venv\\.mozarie-ready" del /q "%APP_DIR%.venv\\.mozarie-ready"'
        self_upgrade = '"%PYTHON%" -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --upgrade pip'
        requirements = '"%PYTHON%" -m pip install --disable-pip-version-check --progress-bar on -r "%REQUIREMENTS%"'

        for step in range(1, 6):
            self.assertIn(f"[{step}/5]", batch)
        self.assertEqual(batch.count("/5]"), 5)
        self.assertIn(setup_check, batch)
        self.assertLess(batch.index(setup_check), batch.index(create_venv))
        self.assertIn(maintenance_check, batch)
        self.assertIn(marker_removal, batch)
        self.assertIn(self_upgrade, batch)
        self.assertIn(requirements, batch)
        self.assertNotIn("--quiet", requirements)
        self.assertNotIn(">nul", requirements)
        self.assertNotIn("--no-cache-dir", requirements)
        self.assertNotIn("Checking that Mozarie is closed", batch)
        self.assertNotIn("--no-cache-dir", (Path(__file__).parents[1] / "updater.py").read_text(encoding="utf-8"))
        self.assertLess(batch.index(maintenance_check), batch.index('"%PYTHON%" -m pip install'))
        self.assertLess(batch.index(marker_removal), batch.index(requirements))
        self.assertNotIn("If Windows denied access, close other setup windows and run setup.bat again.", batch)
        self.assertIn('py -%%V -X utf8 "%APP_DIR%updater.py" --check-running', batch)
        self.assertIn("if errorlevel 31 goto :running_check_failed", batch)
        self.assertIn("if errorlevel 30 goto :mozarie_running", batch)
        self.assertIn("if errorlevel 1 goto :setup_locked_failed", batch)
        self.assertIn(":venv_failed", batch)
        self.assertIn("Could not create the Python environment.", batch)
        self.assertIn('"%PYTHON%" -X utf8 "%APP_DIR%setup_gpu_check.py"', batch)
        gpu_check = (Path(__file__).parents[1] / "setup_gpu_check.py").read_text(encoding="utf-8")
        self.assertIn("CUDA detection runtime could not start. Setup stopped", gpu_check)
        self.assertIn("DirectML detection runtime could not start. Setup stopped", gpu_check)
        self.assertNotIn("Switched the detection runtime to CPU", gpu_check)
        self.assertIn("setup_gpu_check.py", updater.MANAGED_FILES)
        self.assertNotIn("runtime_profile.py", updater.MANAGED_FILES)
        self.assertNotIn("requirements-cpu.txt", updater.MANAGED_FILES)
        self.assertNotIn("requirements-directml.txt", updater.MANAGED_FILES)

    def test_requirements_pin_the_official_cuda_runtime_and_conversion_tools_without_replacing_pypi(self):
        requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8").splitlines()
        self.assertIn("--extra-index-url https://download.pytorch.org/whl/cu130", requirements)
        self.assertIn("torch==2.13.0+cu130", requirements)
        self.assertIn("torchvision==0.28.0+cu130", requirements)
        self.assertIn("onnx>=1.12,<2", requirements)
        self.assertIn("onnxruntime-gpu==1.27.0", requirements)
        self.assertIn("ultralytics==8.4.75", requirements)
        self.assertNotIn("--index-url https://download.pytorch.org/whl/cu130", requirements)
        self.assertNotIn("onnxruntime", requirements)
        self.assertNotIn("onnxslim", requirements)
        self.assertNotIn("openvino", requirements)
        self.assertNotIn("export-base", requirements)

    def test_requirements_dry_run_contract_covers_every_supported_python_launcher(self):
        setup = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8").splitlines()
        for version in ("3.11", "3.12", "3.13", "3.14"):
            self.assertIn(f"{version}-64", setup)
        self.assertIn("onnx>=1.12,<2", requirements)
        self.assertIn("ultralytics==8.4.75", requirements)
        self.assertFalse(any(requirement.startswith(("onnxslim", "openvino", "export-base")) for requirement in requirements))

        directml = (Path(__file__).parents[1] / "mozarie" / "requirements-directml.txt").read_text(encoding="utf-8").splitlines()
        self.assertIn("onnxruntime-directml==1.24.4", directml)
        self.assertIn("torch-directml==0.2.5.dev240914", directml)
        self.assertIn("onnx>=1.12,<2", directml)
        self.assertIn("ultralytics==8.4.75", directml)
        self.assertNotIn("onnxruntime-gpu==1.27.0", directml)

        cpu = (Path(__file__).parents[1] / "mozarie" / "requirements-cpu.txt").read_text(encoding="utf-8").splitlines()
        self.assertIn("onnxruntime==1.24.4", cpu)
        self.assertIn("onnx>=1.12,<2", cpu)
        self.assertIn("ultralytics==8.4.75", cpu)

    def test_setup_and_run_select_only_supported_64_bit_launchers(self):
        expected_loop = "for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do ("
        setup = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        run = (Path(__file__).parents[1] / "run.bat").read_text(encoding="utf-8")
        self.assertIn(expected_loop, setup)
        self.assertEqual(setup.count("py -%%V -m venv"), 2)
        self.assertIn("for %%V in (3.12-64 3.11-64) do (", setup)
        self.assertIn('if /i not "%RUNTIME%"=="cuda" "%PYTHON%" -c', setup)
        self.assertIn("sys.version_info < (3, 13)", setup)
        self.assertIn('set "PYTHON=%APP_DIR%.venv\\Scripts\\python.exe"', setup)
        self.assertNotIn("python -m venv", setup)
        self.assertIn('set "RUNTIME=%MOZARIE_RUNTIME%"', setup)
        self.assertIn("VEN_10DE", setup)
        self.assertIn("VEN_1002", setup)
        self.assertIn('"%PYTHON%" -m mozarie.runtime_profile preflight', setup)
        self.assertIn('"%PYTHON%" -m mozarie.runtime_profile validate', setup)
        self.assertIn('"%PYTHON%" -m mozarie.runtime_profile show', run)
        self.assertNotIn('mozarie\\runtime_profile.py', setup)
        self.assertNotIn('mozarie\\runtime_profile.py', run)
        self.assertIn("mozarie\\requirements-directml.txt", setup)
        self.assertIn('set "PYTHON=%APP_DIR%.venv\\Scripts\\python.exe"', run)
        self.assertIn('if defined MOZARIE_PYTHON goto :python_selected', run)
        self.assertIn(':invalid_mozarie_python', run)
        self.assertIn('if not exist "%PYTHON%" if defined MOZARIE_PYTHON goto :invalid_mozarie_python', run)
        self.assertNotIn("pip install", run)

    def test_setup_runtime_selector_executes_gpu_and_cim_failure_cases_without_installing(self):
        setup = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        selector_line = next(line for line in setup.splitlines() if "Get-CimInstance Win32_VideoController" in line)
        selector = selector_line.split('-Command "', 1)[1].rsplit('"`) do', 1)[0]

        def select(devices: list[str], *, cim_failure: bool = False) -> str:
            device_rows = ",".join("[pscustomobject]@{PNPDeviceID='%s'}" % item for item in devices)
            script = f"""
function Get-CimInstance {{ [CmdletBinding()] param([string]$ClassName); if ($script:cimFailure) {{ Write-Error 'CIM unavailable'; return @() }}; return $script:devices }}
$script:devices=@({device_rows})
$script:cimFailure=${str(cim_failure).lower()}
{selector}
"""
            completed = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                check=True, capture_output=True, text=True,
            )
            return completed.stdout.strip()

        self.assertEqual(select([]), "cpu")
        self.assertEqual(select(["PCI\\VEN_8086&DEV_0001"]), "cpu")
        self.assertEqual(select([], cim_failure=True), "cpu")
        self.assertEqual(select(["PCI\\VEN_1002&DEV_0001"]), "directml")
        self.assertEqual(select(["PCI\\VEN_1002&DEV_0001", "PCI\\VEN_10DE&DEV_0001"]), "cuda")

    def test_setup_uses_module_runtime_validation_and_reports_each_failed_stage(self):
        setup = (Path(__file__).parents[1] / "setup.bat").read_text(encoding="utf-8")
        self.assertIn('"%PYTHON%" -m mozarie.runtime_profile preflight', setup)
        self.assertIn('"%PYTHON%" -m mozarie.runtime_profile validate', setup)
        self.assertNotIn('mozarie\\runtime_profile.py', setup)
        self.assertIn(':pip_upgrade_failed', setup)
        self.assertIn(':requirements_failed', setup)
        self.assertIn(':pip_check_failed', setup)
        self.assertIn(':runtime_validation_failed', setup)
        self.assertIn(':gpu_check_failed', setup)
        self.assertIn(':ready_marker_remove_failed', setup)
        self.assertIn(':ready_marker_create_failed', setup)
        self.assertIn('if not exist "%APP_DIR%.venv\\.mozarie-ready" goto :ready_marker_create_failed', setup)

    @unittest.skipUnless(os.name == "nt", "Windows batch behavior")
    def test_run_honors_explicit_mozarie_python_without_creating_a_venv(self):
        root_batch = Path(__file__).parents[1] / "run.bat"
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            shutil.copy2(root_batch, app / "run.bat")
            marker = app / "server-ran.txt"
            (app / "server.py").write_text(
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ok', encoding='utf-8')",
                encoding="utf-8",
            )
            environment = os.environ | {"MOZARIE_PYTHON": sys.executable}
            result = subprocess.run(["cmd.exe", "/d", "/c", str(app / "run.bat")], cwd=app, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(marker.read_text(encoding="utf-8"), "ok")
            self.assertFalse((app / ".venv").exists())

    def test_run_requires_ready_marker_without_bootstrapping(self):
        batch = (Path(__file__).parents[1] / "run.bat").read_text(encoding="utf-8")
        self.assertIn('set "PYTHON=%APP_DIR%.venv\\Scripts\\python.exe"', batch)
        self.assertIn('if not exist "%APP_DIR%.venv\\.mozarie-ready" goto :setup_required', batch)
        self.assertIn("Preparing Mozarie... / Mozarieを準備しています...", batch)
        self.assertLess(
            batch.index('if not exist "%APP_DIR%.venv\\.mozarie-ready" goto :setup_required'),
            batch.index("\n:start\n"),
        )
        self.assertNotIn("pip", batch.lower())
        self.assertNotIn("call setup.bat", batch.lower())
        self.assertNotIn("-m venv", batch.lower())
        self.assertNotIn("call :create_venv", batch.lower())
        self.assertIn('if not defined MOZARIE_RUNTIME goto :setup_required', batch)

    @unittest.skipUnless(os.name == "nt", "Windows batch behavior")
    def test_run_with_missing_or_invalid_marker_requires_setup(self):
        root_batch = Path(__file__).parents[1] / "run.bat"
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            shutil.copy2(root_batch, app / "run.bat")
            (app / "mozarie").mkdir()
            (app / "mozarie" / "runtime_profile.py").write_text("import sys\nsys.exit(1)\n", encoding="utf-8")
            (app / "server.py").write_text("raise RuntimeError('server must not start')\n", encoding="utf-8")
            venv = app / ".venv"
            subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
            (venv / ".mozarie-ready").write_text("ready\n", encoding="utf-8")
            for marker in (None, "{not-json"):
                marker_path = venv / ".mozarie-runtime.json"
                marker_path.unlink(missing_ok=True)
                if marker is not None:
                    marker_path.write_text(marker, encoding="utf-8")
                result = subprocess.run(
                    ["cmd.exe", "/d", "/c", str(app / "run.bat")], cwd=app, input="\n",
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assertIn("Initial setup is required", output)
                self.assertNotIn("server must not start", output)

            shutil.copy2(Path(__file__).parents[1] / "mozarie" / "runtime_profile.py", app / "mozarie" / "runtime_profile.py")
            (venv / ".mozarie-runtime.json").write_text('{"schema": 1, "profile": "cuda"}', encoding="utf-8")
            started = app / "server-ran.txt"
            (app / "server.py").write_text(
                f"from pathlib import Path; Path({str(started)!r}).write_text('ok', encoding='utf-8')",
                encoding="utf-8",
            )
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", str(app / "run.bat")], cwd=app, input="\n",
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(started.read_text(encoding="utf-8"), "ok")

    @unittest.skipUnless(os.name == "nt" and shutil.which("py"), "requires the Windows Python launcher")
    def test_setup_batch_reports_venv_and_running_states_without_marking_ready(self):
        root_batch = Path(__file__).parents[1] / "setup.bat"
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"; app.mkdir()
            (app / "setup.bat").write_text(root_batch.read_text(encoding="utf-8").replace("\n", "\r\n"), encoding="utf-8", newline="")
            (app / "updater.py").write_text("""import os, subprocess, sys
from pathlib import Path
if sys.argv[-1] == "--check-running": raise SystemExit(30 if os.environ.get("MOZARIE_TEST_MODE") == "running" else 0)
if sys.argv[-1] == "--run-setup-locked": raise SystemExit(subprocess.run(["cmd.exe", "/d", "/c", str(Path(__file__).with_name("setup.bat")), "--locked"]).returncode)
raise SystemExit(1)
""", encoding="utf-8")
            (app / ".venv").write_text("not a directory", encoding="utf-8")
            for mode, expected, absent in (
                ("venv", "Could not create the Python environment.", "64-bit Python 3.11 to 3.14 was not found"),
                ("running", "Close Mozarie, then run setup.bat again.", "Another update is already running"),
            ):
                with self.subTest(mode=mode):
                    result = subprocess.run(
                        ["cmd.exe", "/d", "/c", str(app / "setup.bat")], cwd=app,
                        env=os.environ | {"MOZARIE_TEST_MODE": mode}, capture_output=True, text=True,
                        input="\n", encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    output = result.stdout + result.stderr
                    self.assertNotEqual(result.returncode, 0, output)
                    self.assertIn(expected, output)
                    self.assertNotIn(absent, output)
                    self.assertFalse((app / ".venv" / ".mozarie-ready").exists())
                    if mode == "running": self.assertNotIn("Installing required packages", output)


if __name__ == "__main__":
    unittest.main()
