"""Interrupted browser writes against real HTTP, SQLite and Chromium OPFS."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config
import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.state import StudioState
from mozarie.core import ClientError


class BrowserOverwriteRecoveryTests(unittest.TestCase):
    def test_restored_metadata_requires_matching_save_and_source_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); prepare_test_app_config(root / "app")
            with patch.object(state_module, "APP_DIR", root / "app"):
                state = StudioState(root / "cache", root / "sessions")
                try:
                    source_identity = str(uuid.uuid4())
                    for name in ("one.png", "two.png"):
                        source = root / name
                        with Image.new("RGB", (3, 3), "red") as image: image.save(source)
                        state.import_image_file_for_api(source, name=name, relative_path=name, client_key=name,
                            source_identity=source_identity, intent="add", mtime_ns=1_000_000_000, size_bytes=source.stat().st_size)
                    first, second = state.list_images()
                    payload = {"workspaceId": state.workspace_id, "sourceId": first["sourceId"], "relativePath": first["relativePath"],
                               "originalMtimeMs": 1000, "originalSizeBytes": first["sizeBytes"], "sourceMtimeMs": 2000, "sourceSizeBytes": first["sizeBytes"]}
                    token = str(uuid.uuid4())
                    state.reserve_browser_save(second["id"], 0, token, copy_to_default=False, suffix="", output_format="original", keep_metadata=True)
                    original = state.workspace_store.source_image_metadata(first["sourceId"])
                    for image_id, revision in ((first["id"], 0), (second["id"], 1)):
                        with self.assertRaises(ClientError) as raised:
                            state.cancel_browser_save(image_id, revision, token, restored_source=payload)
                        self.assertEqual(raised.exception.error_code, "save_state_changed")
                    # A durable journal is also authoritative after live token eviction.
                    details = state.browser_save_tokens.pop(token)
                    with self.assertRaises(ClientError):
                        state.cancel_browser_save(first["id"], 0, token, restored_source=payload)
                    state.browser_save_tokens[token] = details
                    self.assertEqual(state.workspace_store.source_image_metadata(first["sourceId"]), original)
                    unknown = str(uuid.uuid4())
                    for key, value in (("workspaceId", "other"), ("sourceId", "other"), ("relativePath", "other.png"), ("originalMtimeMs", 9)):
                        with self.assertRaises(ClientError):
                            state.cancel_browser_save(first["id"], 0, unknown, restored_source={**payload, key: value})
                    state.set_image_flags(first["id"], {"reviewed": True})
                    for _ in range(2):
                        state.cancel_browser_save(first["id"], 0, unknown, restored_source=payload)
                    self.assertEqual(state.images[first["id"]].mtime_ns, 2_000_000_000)
                    self.assertTrue(state.images[first["id"]].reviewed)
                    self.assertEqual(state.workspace_store.source_image_metadata(first["sourceId"])[first["relativePath"]][1], 2_000_000_000)
                    self.assertEqual(state.workspace_store.source_image_metadata(first["sourceId"])[second["relativePath"]], original[second["relativePath"]])
                finally:
                    state.shutdown()

    def check_recovery(self, mode: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepare_test_app_config(root / "app")
            requests = []
            with patch.object(state_module, "APP_DIR", root / "app"):
                state = StudioState(root / "cache", root / "sessions")
                with patch.object(http_module, "STATE", state):
                    class Handler(http_module.MosaicHandler):
                        def do_POST(self):
                            nonlocal state
                            if self.path == "/fixture/restart":
                                state.shutdown()
                                state = StudioState(root / "cache", root / "sessions")
                                http_module.STATE = state
                                self._json({"ok": True})
                                return
                            requests.append(self.path)
                            super().do_POST()

                    server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    try:
                        helper = Path(__file__).with_name("browser_overwrite_recovery_helper.cjs")
                        result = subprocess.run(
                            ["node", str(helper), f"http://127.0.0.1:{server.server_port}", mode],
                            cwd=Path(__file__).resolve().parents[2], env={**os.environ, "PYTHONUTF8": "1"},
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=100,
                        )
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        # The interrupted pre-commit request never reached HTTP;
                        # only the subsequent successful UI save is committed.
                        expected = (1 if "committed" in mode else 0) if "external" in mode or "unrecorded" in mode else (2 if "committed" in mode else 1)
                        self.assertEqual(requests.count("/api/save/commit"), expected)
                    finally:
                        server.shutdown(); server.server_close(); thread.join(5)
                        state.shutdown()

    def test_single_overwrite_crash_restores_source_and_can_save_again(self):
        self.check_recovery("single")

    def test_batch_overwrite_crash_restores_source_and_can_save_again(self):
        self.check_recovery("batch")

    def test_single_renamed_overwrite_crash_removes_uncommitted_target(self):
        self.check_recovery("single-rename")

    def test_batch_renamed_overwrite_crash_removes_uncommitted_target(self):
        self.check_recovery("batch-rename")

    def test_committed_single_overwrite_survives_lost_response(self):
        self.check_recovery("single-committed")

    def test_committed_batch_rename_finishes_source_cleanup(self):
        self.check_recovery("batch-rename-committed")

    def test_backend_restart_restores_unknown_token_and_preserves_project_edits(self):
        self.check_recovery("single-restart")

    def test_overwrite_backup_failure_leaves_source_untouched(self):
        self.check_recovery("single-idb-failure")

    def test_failed_restore_keeps_backup_until_retry(self):
        self.check_recovery("single-restore-failure")

    def test_two_tabs_recover_the_same_overwrite_once(self):
        self.check_recovery("single-two-tabs")

    def test_unreadable_backup_is_retained_until_indexeddb_recovers(self):
        self.check_recovery("single-read-failure")

    def test_metadata_retry_does_not_rewrite_restored_source(self):
        self.check_recovery("single-metadata-failure")

    def test_committed_backup_delete_failure_keeps_receipt_until_retry(self):
        self.check_recovery("single-committed-delete-failure")

    def test_cancelled_overwrite_preserves_later_external_edit(self):
        self.check_recovery("single-external")

    def test_cancelled_rename_preserves_later_external_target(self):
        self.check_recovery("single-rename-external")

    def test_committed_rename_preserves_later_external_original(self):
        self.check_recovery("single-rename-committed-external")

    def test_failed_source_write_does_not_rewrite_unchanged_original(self):
        self.check_recovery("single-write-failure")

    def test_unrecorded_source_write_keeps_original_backup_without_rollback(self):
        self.check_recovery("single-unrecorded")

    def test_cancelled_rename_accepts_an_already_removed_target(self):
        self.check_recovery("single-rename-target-missing")

    def test_committed_rename_accepts_an_already_removed_original(self):
        self.check_recovery("single-rename-committed-original-missing")

    def test_cancel_network_failure_reports_incomplete_recovery_and_retries(self):
        self.check_recovery("single-cancel-failure")

    def test_ack_network_failure_reports_incomplete_recovery_and_retries(self):
        self.check_recovery("single-committed-ack-failure")
