"""Mozarie's small executable entry point."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import types
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from mozarie.core import LOGGER, LOG_DATE_FORMAT, LOG_FORMAT
from updater import MaintenanceLock, UpdateError

CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


def _handle_server_error(server: ThreadingHTTPServer, request, client_address) -> None:  # type: ignore[no-untyped-def]
    """Avoid a terminal traceback when a browser closes a normal request."""
    exception = sys.exc_info()[1]
    if isinstance(exception, CLIENT_DISCONNECT_ERRORS):
        return
    ThreadingHTTPServer.handle_error(server, request, client_address)


def _open_browser(url: str) -> None:
    launch_update = False
    try:
        if not webbrowser.open(url):
            LOGGER.warning("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)
    except OSError:
        LOGGER.warning("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)
    except Exception:
        LOGGER.exception("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)


def _schedule_browser_open(url: str) -> threading.Timer:
    timer = threading.Timer(0.1, _open_browser, args=(url,))
    timer.daemon = True
    timer.start()
    return timer


def _startup_state(state_module):  # type: ignore[no-untyped-def]
    error = state_module.STATE_STARTUP_ERROR
    if error is not None:
        LOGGER.warning("作業データを開けません。ブラウザで作業データを作り直してください。")
        return None
    assert state_module.STATE is not None
    return state_module.STATE


def main() -> None:
    LOGGER.setLevel(logging.INFO)
    parser = argparse.ArgumentParser(description="Run Mozarie locally.")
    parser.add_argument("--port", type=int, default=None, help="Override the saved local port for this start only.")
    parser.add_argument("--recreate-workspace", action="store_true", help="Explicitly discard incompatible local project data before starting.")
    args = parser.parse_args()
    try:
        with MaintenanceLock(APP_DIR):
            if args.recreate_workspace:
                from mozarie.workspace import WorkspaceStore
                WorkspaceStore.recreate(APP_DIR / "data")
            import mozarie.state as state_module
            from mozarie.http import MosaicHandler
            state = _startup_state(state_module)
            port = args.port if args.port is not None else int(state.settings["general"]["port"]) if state is not None else 31844
            LOGGER.info("Mozarieを準備しています…")
            if state is not None:
                state.cache_dir.mkdir(parents=True, exist_ok=True)
            try:
                http_server = ThreadingHTTPServer(("127.0.0.1", port), MosaicHandler)
                http_server.handle_error = types.MethodType(_handle_server_error, http_server)
            except OSError as exc:
                if getattr(exc, "winerror", None) == 10048:
                    LOGGER.error("Mozarieを起動できません。ポート%sは使用中です。", port)
                else:
                    LOGGER.exception("Mozarieを起動できませんでした。")
                if state is not None:
                    state.shutdown()
                raise SystemExit(1) from None
            url = f"http://127.0.0.1:{port}"
            LOGGER.info("Mozarieを起動しました: %s", url)
            if state is None or state.settings["general"]["open_browser"]:
                _schedule_browser_open(url)
            try:
                http_server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                http_server.server_close()
                if state_module.STATE is not None:
                    state_module.STATE.shutdown()
                LOGGER.info("Mozarieを終了しました")
            launch_update = bool(getattr(http_server, "mozarie_update_requested", False))
    except UpdateError as exc:
        LOGGER.error("%s", str(exc))
        raise SystemExit(1) from None
    if launch_update:
        import subprocess
        subprocess.Popen([str(APP_DIR / "update.bat")], cwd=str(APP_DIR), creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))


if __name__ == "__main__":
    main()
