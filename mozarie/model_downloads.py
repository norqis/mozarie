"""Pinned, on-demand downloads for the model files Mozarie can install."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .core import LOGGER


class ModelDownloadError(RuntimeError):
    pass


class ModelDownloadCancelled(ModelDownloadError):
    pass


class ModelDownloadInProgress(ModelDownloadError):
    pass


class _HttpsOnlyRedirects(HTTPRedirectHandler):
    """Follow the providers' HTTPS redirects, never downgrade a download."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not newurl.lower().startswith("https://"):
            raise ModelDownloadError("モデル配布先が安全な HTTPS 接続へ移動しませんでした。")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


@dataclass(frozen=True)
class ModelDownload:
    key: str
    setting_key: str
    url: str
    relative_destination: str
    size: int
    sha256: str

    def destination(self, app_dir: Path) -> Path:
        return (app_dir / self.relative_destination).resolve()


# These entries are intentionally fixed rather than resolved from a provider API.
# A download is accepted only when it matches the recorded size and SHA-256.
MODEL_DOWNLOADS: dict[str, ModelDownload] = {
    "hand_detection": ModelDownload(
        "hand_detection", "hand_detection",
        "https://huggingface.co/deepghs/anime_hand_detection/resolve/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s/model.onnx",
        "models/ultralytics/anime-hand-v1.0-s.onnx", 44583229,
        "408750ad39645fcdc0c5e774aa45a73941b2e785fc5611fb7d3d9790a41899c0",
    ),
    "hand_segmentation": ModelDownload(
        "hand_segmentation", "hand_segmentation",
        "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors",
        "models/handsegnet/handsegnet_vit_b_best.safetensors", 374979240,
        "64b35e5ee09aac8737e2554f15e73503f94ce9bf443dde4864255e14b7ca9c14",
    ),
    "sam_vit_b": ModelDownload(
        "sam_vit_b", "sam_vit_b",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth",
        "models/sam_vit_b_01ec64.pth", 375042383,
        "ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912",
    ),
    "sam_vit_l": ModelDownload(
        "sam_vit_l", "sam_vit_l",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_l_0b3195.pth",
        "models/sam_vit_l_0b3195.pth", 1249524607,
        "3adcc4315b642a4d2101128f611684e8734c41232a17c648ed1693702a49a622",
    ),
    "sam_vit_h": ModelDownload(
        "sam_vit_h", "sam_vit_h",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth",
        "models/sam_vit_h_4b8939.pth", 2564550879,
        "a7bf3b02f3ebf1267aba913ff637d9a2d5c33d3173bb679e46d9f338c26f262e",
    ),
}


def _sam_key(sam_type: str) -> str:
    key = f"sam_{sam_type}"
    if key not in MODEL_DOWNLOADS:
        raise ModelDownloadError("輪郭抽出モデルの種類が正しくありません。")
    return key


class ModelDownloadManager:
    def __init__(self, app_dir: Path) -> None:
        self.app_dir = app_dir
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._response: Any | None = None
        self._job: dict[str, Any] = {"state": "idle", "paths": {}, "errorCode": ""}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {**self._job, "paths": dict(self._job.get("paths", {}))}

    def start(self, key: str, sam_type: str) -> dict[str, Any]:
        if key == "all":
            keys = [_sam_key(sam_type), "hand_detection", "hand_segmentation"]
        elif key in MODEL_DOWNLOADS:
            keys = [key]
        else:
            raise ModelDownloadError("ダウンロードするモデルの種類が正しくありません。")
        with self._lock:
            if self._job.get("state") in {"running", "cancelling"}:
                raise ModelDownloadInProgress()
            self._cancel = threading.Event()
            self._response = None
            previous_job = self._job
            self._job = {
                "state": "running", "key": key, "total": len(keys), "completed": 0,
                "current": keys[0], "received": 0, "expected": MODEL_DOWNLOADS[keys[0]].size, "phase": "checking",
                "paths": {}, "errorCode": "",
            }
            self._thread = threading.Thread(target=self._run, args=(keys,), daemon=True, name="mozarie-model-download")
            try:
                self._thread.start()
            except RuntimeError:
                self._thread = None
                self._job = previous_job
                raise
            LOGGER.info("モデルダウンロードを開始: 対象=%d件", len(keys))
            return self.snapshot()

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._job.get("state") == "running":
                self._cancel_active_transfer_unchecked()
                self._job["state"] = "cancelling"
                LOGGER.info("モデルダウンロードのキャンセルを受け付け")
            return self.snapshot()

    def shutdown(self) -> bool:
        """Cancel an active transfer, close its response, and wait for its worker."""
        with self._lock:
            thread = self._thread
            if self._job.get("state") in {"running", "cancelling"}:
                self._cancel_active_transfer_unchecked()
                self._job["state"] = "cancelling"
        if thread is not None and thread.is_alive():
            thread.join()
        return True

    def _cancel_active_transfer_unchecked(self) -> None:
        self._cancel.set()
        if self._response is not None:
            self._response.close()

    def _set(self, **changes: Any) -> None:
        with self._lock:
            self._job.update(changes)

    def _run(self, keys: list[str]) -> None:
        paths: dict[str, str] = {}
        result: dict[str, Any] = {}
        try:
            for index, key in enumerate(keys):
                if self._cancel.is_set():
                    raise ModelDownloadCancelled()
                entry = MODEL_DOWNLOADS[key]
                self._set(current=key, completed=index, received=0, expected=entry.size, phase="checking")
                destination = self._download(entry)
                paths[entry.setting_key] = str(destination)
                self._set(paths=dict(paths), completed=index + 1, received=entry.size)
            result = {"state": "complete", "current": "", "paths": paths}
        except ModelDownloadCancelled:
            result = {"state": "cancelled", "current": "", "paths": paths}
        except (HTTPError, URLError):
            result = {"state": "failed", "current": "", "paths": paths, "errorCode": "model_download_network"}
        except OSError:
            result = {"state": "failed", "current": "", "paths": paths, "errorCode": "model_download_write_failed"}
        except ModelDownloadError:
            result = {"state": "failed", "current": "", "paths": paths, "errorCode": "model_download_integrity"}
        except Exception:
            result = {"state": "failed", "current": "", "paths": paths, "errorCode": "internal_error"}
        finally:
            with self._lock:
                self._job.update(result)
                self._thread = None
            state = str(result.get("state", "failed"))
            if state == "complete":
                LOGGER.info("モデルダウンロードが完了: 完了=%d件", len(paths))
            elif state == "cancelled":
                LOGGER.info("モデルダウンロードをキャンセル: 完了=%d件", len(paths))
            else:
                LOGGER.error("モデルダウンロードに失敗: error_code=%s 完了=%d件", result.get("errorCode", "internal_error"), len(paths))

    def _download(self, entry: ModelDownload) -> Path:
        destination = entry.destination(self.app_dir)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.part")
        received = temporary.stat().st_size if temporary.exists() else 0
        if received > entry.size:
            temporary.unlink()
            received = 0
        # A retained partial file has already consumed its bytes on disk.  Only
        # require enough free space for the remainder, otherwise a resumable
        # multi-GB download can be rejected despite having exactly enough room.
        if shutil.disk_usage(destination.parent).free < entry.size - received:
            raise OSError("not enough disk space")
        digest = hashlib.sha256()
        if received:
            with temporary.open("rb") as existing:
                while chunk := existing.read(1024 * 1024):
                    if self._cancel.is_set():
                        raise ModelDownloadCancelled()
                    digest.update(chunk)
                    self._set(phase="checking", received=existing.tell(), expected=entry.size)
        if received == entry.size:
            if hmac.compare_digest(digest.hexdigest(), entry.sha256):
                os.replace(temporary, destination)
                return destination
            temporary.unlink()
            received = 0
            digest = hashlib.sha256()
        try:
            opener = build_opener(_HttpsOnlyRedirects())
            headers = {"User-Agent": "Mozarie model downloader"}
            if received:
                headers["Range"] = f"bytes={received}-"
            request = Request(entry.url, headers=headers)
            with opener.open(request, timeout=30) as response:
                try:
                    with self._lock:
                        self._response = response
                        if self._cancel.is_set():
                            response.close()
                            raise ModelDownloadCancelled()
                    if not response.geturl().lower().startswith("https://"):
                        raise ModelDownloadError("モデル配布先が安全な HTTPS 接続ではありません。")
                    status = getattr(response, "status", None) or getattr(response, "getcode", lambda: None)()
                    if received and status == 206:
                        content_range = response.headers.get("Content-Range", "")
                        if not re.fullmatch(rf"bytes {received}-\d+/{entry.size}", content_range):
                            raise ModelDownloadError("ダウンロードを再開できませんでした。")
                    elif received:
                        # A server that ignores Range has returned the entire model.
                        received = 0
                        digest = hashlib.sha256()
                    content_length = response.headers.get("Content-Length")
                    expected_length = entry.size - received
                    if content_length and int(content_length) != expected_length:
                        raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
                    mode = "ab" if received else "wb"
                    self._set(phase="downloading", received=received, expected=entry.size)
                    with temporary.open(mode) as handle:
                        while chunk := response.read(1024 * 1024):
                            if self._cancel.is_set():
                                raise ModelDownloadCancelled()
                            received += len(chunk)
                            if received > entry.size:
                                raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
                            digest.update(chunk)
                            handle.write(chunk)
                            self._set(received=received, expected=entry.size)
                finally:
                    with self._lock:
                        if self._response is response:
                            self._response = None
            if received != entry.size:
                raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
            self._set(phase="verifying", received=received, expected=entry.size)
            if not hmac.compare_digest(digest.hexdigest(), entry.sha256):
                raise ModelDownloadError("ダウンロードしたモデルを確認できませんでした。")
            os.replace(temporary, destination)
            return destination
        except ModelDownloadCancelled:
            # Keep a partial file when the user cancels: it can be resumed.
            raise
        except (HTTPError, URLError, OSError):
            # Keep a partial file after an interrupted transfer as well.
            if self._cancel.is_set():
                raise ModelDownloadCancelled()
            raise
        except ModelDownloadError:
            # A malformed, oversized, or hash-mismatched response cannot be
            # trusted as the prefix of a later download.
            temporary.unlink(missing_ok=True)
            raise
