"""Concrete failure-boundary coverage for image I/O and model downloads."""

from __future__ import annotations

import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie import image_io
from mozarie.core import ClientError, ImageRecord
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter
from mozarie.model_downloads import (
    HTTPRedirectHandler,
    ModelDownload,
    ModelDownloadError,
    ModelDownloadManager,
    _HttpsOnlyRedirects,
)


class _Response:
    def __init__(self, payload: bytes, *, status: int = 200, content_length: str | None = None, content_range: str | None = None) -> None:
        self.payload = payload
        self.status = status
        self.offset = 0
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = content_length
        if content_range is not None:
            self.headers["Content-Range"] = content_range

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self) -> str:
        return "https://models.example/model"

    def read(self, size: int) -> bytes:
        result = self.payload[self.offset:self.offset + size]
        self.offset += len(result)
        return result


class _Opener:
    def __init__(self, response: _Response | Exception) -> None:
        self.response = response

    def open(self, _request, timeout: int):
        self.timeout = timeout
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class ImageIoFailureBoundaryTests(unittest.TestCase):
    def png_bytes(self, mode: str) -> bytes:
        output = io.BytesIO()
        Image.new(mode, (2, 2), 1).save(output, format="PNG")
        return output.getvalue()

    def test_png_orientation_rejects_changed_colour_format(self) -> None:
        with self.assertRaises(ClientError):
            image_io._png_with_original_chunks(self.png_bytes("RGB"), Image.new("L", (2, 2)), normalize_orientation=True)

    def test_png_reencodes_split_idat_as_one_valid_image(self) -> None:
        source = self.png_bytes("RGB")
        chunks = image_io.parse_png_chunks(source)
        split_source = bytearray(image_io.PNG_SIGNATURE)
        for chunk_type, chunk in chunks:
            if chunk_type != b"IDAT":
                split_source.extend(chunk)
                continue
            payload = chunk[8:-4]
            midpoint = len(payload) // 2
            split_source.extend(image_io._png_chunk(b"IDAT", payload[:midpoint]))
            split_source.extend(image_io._png_chunk(b"IDAT", payload[midpoint:]))
        rendered = image_io._png_with_original_chunks(bytes(split_source), Image.new("RGB", (2, 2)))
        with Image.open(io.BytesIO(rendered)) as output:
            self.assertEqual(output.size, (2, 2))

    def test_jpeg_without_scan_and_invalid_webp_headers_are_rejected(self) -> None:
        with self.assertRaises(ClientError):
            image_io._parse_jpeg_header(b"\xff\xd8\xff\xe0\x00\x02")
        with self.assertRaises(ClientError):
            image_io._parse_webp_chunks(b"not a webp")
        with self.assertRaises(ClientError):
            image_io._parse_webp_chunks(b"RIFF" + (0).to_bytes(4, "little") + b"WEBP")
        truncated_chunk = b"RIFF" + (8).to_bytes(4, "little") + b"WEBP" + b"junk"
        with self.assertRaises(ClientError):
            image_io._parse_webp_chunks(truncated_chunk)

    def test_jpeg_orientation_writes_pillow_exif_payload(self) -> None:
        source = io.BytesIO()
        image = Image.new("RGB", (2, 2))
        image.getexif()[274] = 6
        image.save(source, format="JPEG", exif=image.getexif())
        segment = image_io._jpeg_exif_orientation_one_segment(source.getvalue())
        self.assertEqual(segment[4:10], b"Exif\x00\x00")

    def test_import_name_space_exhaustion_is_reported(self) -> None:
        with patch.object(Path, "exists", return_value=True):
            with self.assertRaises(ClientError) as raised:
                image_io.unique_session_import_destination(Path("C:/scratch/input.png"))
        self.assertEqual(raised.exception.error_code, "save_write_failed")

    def test_save_keeps_written_image_when_timestamp_restore_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            source.write_bytes(self.png_bytes("RGB"))
            stat = source.stat()
            record = ImageRecord("image", source, "source.png", 2, 2, stat.st_mtime_ns, stat.st_size)
            with patch("mozarie.image_io.render_with_mask", return_value=b"written"), \
                    patch("mozarie.image_io.os.utime", side_effect=OSError("locked")), \
                    patch("mozarie.image_io.LOGGER.warning") as warning:
                stage = image_io._stage_save_with_mask(record, np.zeros((2, 2), dtype=np.uint8), 4)
            stage.finalize()
        warning.assert_called_once()

    def test_rollback_with_no_backup_is_a_noop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            record = Mock()
            stage = image_io.SourceReplaceStage(record, Path(directory) / "not-created.backup", record)
            stage.rollback()


class ModelDownloadFailureBoundaryTests(unittest.TestCase):
    @staticmethod
    def entry(payload: bytes) -> ModelDownload:
        return ModelDownload("fixture", "fixture", "https://models.example/model", "models/model.onnx", len(payload), hashlib.sha256(payload).hexdigest())

    def manager(self, directory: str) -> ModelDownloadManager:
        return ModelDownloadManager(Path(directory))

    def test_https_redirect_allows_secure_location(self) -> None:
        handler = _HttpsOnlyRedirects()
        with patch.object(HTTPRedirectHandler, "redirect_request", return_value="request") as redirect:
            self.assertEqual(handler.redirect_request(None, None, 302, "Found", {}, "https://models.example/new"), "request")
        redirect.assert_called_once()

    def test_run_records_complete_and_unexpected_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manager = self.manager(directory)
            with patch.object(manager, "_download", return_value=Path(directory) / "model.onnx"):
                manager._run(["hand_detection"])
            self.assertEqual(manager.snapshot()["state"], "complete")
            with patch.object(manager, "_download", side_effect=RuntimeError("unexpected")):
                manager._run(["hand_detection"])
            self.assertEqual(manager.snapshot()["errorCode"], "internal_error")

    def test_too_large_partial_is_restarted_from_zero(self) -> None:
        payload = b"model"
        with tempfile.TemporaryDirectory() as directory:
            manager = self.manager(directory)
            entry = self.entry(payload)
            destination = entry.destination(Path(directory))
            destination.parent.mkdir(parents=True)
            destination.with_name(".model.onnx.part").write_bytes(payload + b"x")
            with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
                self.assertEqual(manager._download(entry).read_bytes(), payload)

    def test_bad_range_and_length_are_rejected_and_partial_is_removed(self) -> None:
        payload = b"model"
        for response in (
            _Response(payload[1:], status=206, content_range="bytes 0-3/5"),
            _Response(payload[1:], status=206, content_range="bytes 1-4/5", content_length="9"),
        ):
            with self.subTest(response=response.headers), tempfile.TemporaryDirectory() as directory:
                manager = self.manager(directory)
                entry = self.entry(payload)
                destination = entry.destination(Path(directory))
                destination.parent.mkdir(parents=True)
                partial = destination.with_name(".model.onnx.part")
                partial.write_bytes(payload[:1])
                with patch("mozarie.model_downloads.build_opener", return_value=_Opener(response)):
                    with self.assertRaises(ModelDownloadError):
                        manager._download(entry)
                self.assertFalse(partial.exists())

    def test_network_error_keeps_partial_for_resume(self) -> None:
        payload = b"model"
        with tempfile.TemporaryDirectory() as directory:
            manager = self.manager(directory)
            entry = self.entry(payload)
            destination = entry.destination(Path(directory))
            destination.parent.mkdir(parents=True)
            partial = destination.with_name(".model.onnx.part")
            partial.write_bytes(payload[:1])
            with patch("mozarie.model_downloads.build_opener", return_value=_Opener(URLError("offline"))):
                with self.assertRaises(URLError):
                    manager._download(entry)
            self.assertEqual(partial.read_bytes(), payload[:1])


class DecoderContractTests(unittest.TestCase):
    def test_hand_decoder_does_not_accept_rows_outside_its_validated_contract(self) -> None:
        # _prediction_rows always yields five columns.  Keep detect_boxes aligned
        # with that validated ONNX contract rather than retaining dead handling.
        self.assertEqual(HandDetector._prediction_rows([np.zeros((1, 5, 1), dtype=np.float32)]).shape, (1, 5))

    def test_target_decoder_rows_always_have_the_fixed_43_channel_contract(self) -> None:
        self.assertEqual(TargetSegmenter._prediction_rows(np.zeros((1, 43, 1), dtype=np.float32)).shape, (1, 43))
