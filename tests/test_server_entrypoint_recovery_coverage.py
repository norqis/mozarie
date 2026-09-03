"""Executable-entrypoint recovery contracts.

These exercise the two startup states without binding a real port: a user can
explicitly recreate incompatible data, while an unrecoverable workspace still
opens the recovery page and shuts down cleanly.
"""

from __future__ import annotations

from contextlib import nullcontext
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import mozarie.state as state_module
import server


def stopped_server() -> Mock:
    instance = Mock()
    instance.serve_forever.side_effect = KeyboardInterrupt
    instance.mozarie_update_requested = False
    return instance


class ServerEntrypointRecoveryCoverageTests(unittest.TestCase):
    def test_explicit_recreate_rebuilds_workspace_before_starting(self) -> None:
        http_server = stopped_server()
        with patch("server.MaintenanceLock", return_value=nullcontext()), \
                patch("mozarie.workspace.WorkspaceStore.recreate") as recreate, \
                patch("server.ThreadingHTTPServer", return_value=http_server), \
                patch("server._schedule_browser_open"), \
                patch.object(state_module.STATE, "shutdown"), \
                patch.object(sys, "argv", ["server.py", "--recreate-workspace", "--port", "31999"]):
            server.main()

        recreate.assert_called_once_with(server.APP_DIR / "data")
        http_server.server_close.assert_called_once_with()

    def test_missing_workspace_starts_recovery_page_without_state_cleanup(self) -> None:
        http_server = stopped_server()
        original_state, original_error = state_module.STATE, state_module.STATE_STARTUP_ERROR
        state_module.STATE, state_module.STATE_STARTUP_ERROR = None, RuntimeError("workspace locked")
        try:
            with patch("server.MaintenanceLock", return_value=nullcontext()), \
                    patch("server.ThreadingHTTPServer", return_value=http_server) as server_class, \
                    patch("server._schedule_browser_open") as schedule_browser, \
                    patch.object(sys, "argv", ["server.py"]):
                server.main()
        finally:
            state_module.STATE, state_module.STATE_STARTUP_ERROR = original_state, original_error

        server_class.assert_called_once()
        self.assertEqual(server_class.call_args.args[0], ("127.0.0.1", 31844))
        schedule_browser.assert_called_once_with("http://127.0.0.1:31844")
        http_server.server_close.assert_called_once_with()

    def test_recovery_workspace_bind_failure_never_attempts_a_missing_shutdown(self) -> None:
        original_state, original_error = state_module.STATE, state_module.STATE_STARTUP_ERROR
        state_module.STATE, state_module.STATE_STARTUP_ERROR = None, RuntimeError("workspace locked")
        try:
            with patch("server.MaintenanceLock", return_value=nullcontext()), \
                    patch("server.ThreadingHTTPServer", side_effect=OSError("bind failed")), \
                    patch.object(sys, "argv", ["server.py"]):
                with self.assertRaises(SystemExit) as exited:
                    server.main()
        finally:
            state_module.STATE, state_module.STATE_STARTUP_ERROR = original_state, original_error
        self.assertEqual(exited.exception.code, 1)

    def test_disconnect_errors_are_suppressed_but_other_errors_reach_http_server(self) -> None:
        http_server = Mock()
        for error in server.CLIENT_DISCONNECT_ERRORS:
            with self.subTest(error=error.__name__), patch("server.sys.exc_info", return_value=(error, error(), None)), \
                    patch("server.ThreadingHTTPServer.handle_error") as handle_error:
                server._handle_server_error(http_server, Mock(), ("127.0.0.1", 1))
            handle_error.assert_not_called()

        unexpected = RuntimeError("bad request")
        with patch("server.sys.exc_info", return_value=(RuntimeError, unexpected, None)), \
                patch("server.ThreadingHTTPServer.handle_error") as handle_error:
            server._handle_server_error(http_server, Mock(), ("127.0.0.1", 1))
        handle_error.assert_called_once()


if __name__ == "__main__":
    unittest.main()
