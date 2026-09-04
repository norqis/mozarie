"""Concrete file and model-adapter contracts that exercise uncommon user inputs."""

from __future__ import annotations

import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

import server
import setup_gpu_check
import updater
from mozarie.core import ClientError
from mozarie.image_io import (
    _apply_mosaic_to_image,
    _assert_image_suffix_matches_format,
    _decode_mask,
    _expected_image_format,
    _parse_jpeg_header,
    _parse_webp_chunks,
    _png_chunk,
    _png_with_original_chunks,
    _valid_color,
    _validate_safe_webp_structure,
    decode_draft_masks,
    parse_png_chunks,
)
from mozarie import http as http_module
from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter, _class_names
from mozarie.inference.onnx import Letterbox
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter


def png_data(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def data_url(image: Image.Image) -> str:
    return "data:image/png;base64," + base64.b64encode(png_data(image)).decode("ascii")


class ImageIoBranchTests(unittest.TestCase):
    def test_color_and_suffix_validation_cover_valid_and_invalid_values(self) -> None:
        self.assertTrue(_valid_color("#A0b1C2"))
        for value in ("", "#123", "123456", "#12345g", "#12345678"):
            with self.subTest(value=value):
                self.assertFalse(_valid_color(value))
        self.assertEqual(_expected_image_format(".JpEg"), "JPEG")
        with self.assertRaises(ClientError):
            _expected_image_format(".gif")
        _assert_image_suffix_matches_format(".png", "PNG")
        with self.assertRaises(ClientError):
            _assert_image_suffix_matches_format(".png", "JPEG")

    def test_png_container_rejects_bad_signatures_truncation_and_missing_end(self) -> None:
        valid = png_data(Image.new("RGB", (2, 2), "white"))
        self.assertEqual(parse_png_chunks(valid)[0][0], b"IHDR")
        for raw in (b"not png", valid[:-1], valid[:8] + b"\x00\x00\x00\x04IDAT"):
            with self.subTest(length=len(raw)):
                with self.assertRaises(ClientError):
                    parse_png_chunks(raw)
        self.assertEqual(_png_chunk(b"tEXt", b"note")[:8], b"\x00\x00\x00\x04tEXt")

    def test_jpeg_header_parser_handles_valid_metadata_and_malformed_marker_forms(self) -> None:
        output = io.BytesIO()
        Image.new("RGB", (3, 2), "white").save(output, format="JPEG")
        segments, scan = _parse_jpeg_header(output.getvalue())
        self.assertTrue(segments)
        self.assertTrue(scan.startswith(b"\xff\xda"))
        for raw in (b"not jpeg", b"\xff\xd8x", b"\xff\xd8\xff", b"\xff\xd8\xff\xd8", b"\xff\xd8\xff\xe0\x00\x01"):
            with self.subTest(raw=raw):
                with self.assertRaises(ClientError):
                    _parse_jpeg_header(raw)

    def test_webp_container_validation_rejects_bad_length_animation_unknown_and_multiple_images(self) -> None:
        output = io.BytesIO()
        Image.new("RGB", (3, 2), "white").save(output, format="WEBP")
        valid = output.getvalue()
        self.assertTrue(_parse_webp_chunks(valid))
        _validate_safe_webp_structure(valid)
        def riff(*chunks: tuple[bytes, bytes]) -> bytes:
            body = b"".join(kind + len(payload).to_bytes(4, "little") + payload + (b"\0" if len(payload) % 2 else b"") for kind, payload in chunks)
            return b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WEBP" + body
        for raw in (b"RIFF\x00\x00\x00\x00WEBP", valid[:-1]):
            with self.subTest(raw=raw[:12]):
                with self.assertRaises(ClientError):
                    _parse_webp_chunks(raw)
        for raw in (
            riff((b"ANIM", b"x"), (b"VP8 ", b"x")),
            riff((b"JUNK", b"x"), (b"VP8 ", b"x")),
            riff((b"VP8 ", b"x"), (b"VP8L", b"x")),
        ):
            with self.subTest(raw=raw[12:16]):
                with self.assertRaises(ClientError):
                    _validate_safe_webp_structure(raw)

    def test_mask_decoder_accepts_alpha_and_grayscale_and_rejects_bad_input(self) -> None:
        alpha = Image.new("RGBA", (2, 2), (1, 2, 3, 80))
        gray = Image.new("L", (2, 2), 90)
        self.assertTrue(np.all(_decode_mask(data_url(alpha), 2, 2) == 80))
        self.assertTrue(np.all(_decode_mask(data_url(gray), 2, 2) == 90))
        for raw in ("", "data:image/png;base64,!!!", data_url(Image.new("RGB", (2, 2))), data_url(Image.new("L", (3, 2)))):
            with self.subTest(raw=raw[:20]):
                with self.assertRaises(ClientError):
                    _decode_mask(raw, 2, 2)
        self.assertEqual(decode_draft_masks(None, 2, 2), (None, None, None))
        with self.assertRaises(ClientError):
            decode_draft_masks([], 2, 2)
        masks = decode_draft_masks({"add": data_url(gray), "manualExclusionEnabled": False}, 2, 2)
        self.assertIsNotNone(masks[0])
        self.assertIsNone(masks[1])

    def test_mosaic_input_and_runtime_device_paths_are_checked_before_save(self) -> None:
        source = Image.new("RGB", (2, 2), "white")
        for block, mask in ((0, np.zeros((2, 2), dtype=np.uint8)), (2, np.zeros((3, 2), dtype=np.uint8))):
            with self.subTest(block=block, shape=mask.shape):
                with self.assertRaises(ClientError):
                    _apply_mosaic_to_image(source, mask, block)
        with self.assertRaises(ClientError):
            _apply_mosaic_to_image(Image.new("CMYK", (2, 2)), np.zeros((2, 2), dtype=np.uint8), 2)
        with patch("mozarie.image_io.torch_module", return_value=SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))):
            self.assertIsNone(http_module.inference_device_name())
        with patch("mozarie.image_io.torch_module", return_value=SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, get_device_name=lambda _id: "Test GPU"))):
            self.assertEqual(http_module.inference_device_name(), "Test GPU")

    def test_metadata_rewriters_reject_animation_bad_profiles_and_oversize_masks(self) -> None:
        raw = png_data(Image.new("RGB", (2, 2), "white"))
        chunks = parse_png_chunks(raw)
        animated = raw[:8] + chunks[0][1] + _png_chunk(b"acTL", b"\0" * 8) + b"".join(chunk for _kind, chunk in chunks[1:])
        with self.assertRaises(ClientError):
            _png_with_original_chunks(animated, Image.new("RGB", (2, 2), "white"))
        palette = Image.new("P", (2, 2))
        palette.save(io.BytesIO(), format="PNG")
        palette_raw = png_data(palette)
        with self.assertRaises(ClientError):
            _png_with_original_chunks(palette_raw, Image.new("RGB", (2, 2), "white"))
        with patch("mozarie.image_io.MAX_BODY_BYTES", 1):
            with self.assertRaises(ClientError):
                _decode_mask(data_url(Image.new("L", (2, 2))), 2, 2)

    def test_webp_and_jpeg_parsers_reject_complete_but_invalid_containers(self) -> None:
        def riff(chunk_type: bytes, payload: bytes) -> bytes:
            body = chunk_type + len(payload).to_bytes(4, "little") + payload + (b"\0" if len(payload) % 2 else b"")
            return b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WEBP" + body
        with self.assertRaises(ClientError):
            _parse_webp_chunks(riff(b"VP8 ", b"x")[:-1])
        with self.assertRaises(ClientError):
            _validate_safe_webp_structure(riff(b"ICCP", b"x"))
        for raw in (b"\xff\xd8\xff\xda", b"\xff\xd8\xff\xda\x00\x01", b"\xff\xd8\xff\xe0"):
            with self.subTest(raw=raw):
                with self.assertRaises(ClientError):
                    _parse_jpeg_header(raw)

    def test_container_parsers_reject_declared_payloads_that_run_past_their_real_bytes(self) -> None:
        png_overrun = b"\x89PNG\r\n\x1a\n" + (20).to_bytes(4, "big") + b"IDAT" + b"\0" * 8
        with self.assertRaises(ClientError):
            parse_png_chunks(png_overrun)
        no_end = png_data(Image.new("RGB", (2, 2)))
        chunks = parse_png_chunks(no_end)
        with self.assertRaises(ClientError):
            parse_png_chunks(no_end[:8] + b"".join(chunk for kind, chunk in chunks if kind != b"IEND"))
        malformed_webp = b"RIFF" + (12).to_bytes(4, "little") + b"WEBP" + b"VP8 " + (5).to_bytes(4, "little")
        with self.assertRaises(ClientError):
            _parse_webp_chunks(malformed_webp)


class DecoderBranchTests(unittest.TestCase):
    def test_hand_decoder_rejects_each_invalid_export_shape(self) -> None:
        invalid = (
            [np.zeros((1, 5, 1), dtype=np.float32), np.zeros((1, 5, 1), dtype=np.float32)],
            [np.zeros((1, 5, 1), dtype=np.float64)],
            [np.zeros((5, 1), dtype=np.float32)],
            [np.zeros((1, 4, 1), dtype=np.float32)],
            [np.zeros((1, 5, 0), dtype=np.float32)],
            [np.asarray([[[1.0], [1.0], [1.0], [1.0], [float("nan")]]], dtype=np.float32)],
            [np.asarray([[[1.0], [1.0], [1.0], [1.0], [1.1]]], dtype=np.float32)],
        )
        for outputs in invalid:
            with self.subTest(shape=[value.shape for value in outputs]):
                with self.assertRaises(ValueError):
                    HandDetector._prediction_rows(outputs)

    def test_target_decoder_rejects_malformed_outputs_and_respects_targets(self) -> None:
        for output in (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 42, 1), dtype=np.float32)):
            with self.subTest(shape=output.shape):
                with self.assertRaises(ValueError):
                    TargetSegmenter._prediction_rows(output)
        with self.assertRaises(ValueError):
            TargetSegmenter._outputs([np.zeros((1, 43, 1), dtype=np.float32)])
        detector = TargetSegmenter.__new__(TargetSegmenter)
        detector.input_size = 10
        prediction = np.zeros((1, 43, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 7, 0] = 0.9
        prediction[0, -32:, 0] = 1
        detector.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            self.assertEqual(detector.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5, {"penis"}), [])

    def test_generic_decoder_rejects_bad_metadata_and_output_shapes(self) -> None:
        for metadata in ({}, {"names": "'penis'"}, {"names": "[]"}, {"names": "[1]"}):
            with self.subTest(metadata=metadata):
                with self.assertRaises(ValueError):
                    _class_names(metadata)
        detector = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        detector.class_names = ("penis",)
        for output in (np.zeros((2, 37), dtype=np.float32), np.zeros((1, 36, 2), dtype=np.float32)):
            with self.subTest(shape=output.shape):
                with self.assertRaises(ValueError):
                    detector._prediction_rows(output)
        with self.assertRaises(ValueError):
            detector._outputs([np.zeros((1, 37, 1), dtype=np.float32)])

    def test_detect_filters_low_confidence_and_invalid_boxes(self) -> None:
        hand = HandDetector.__new__(HandDetector)
        hand.input_size = 10
        target = TargetSegmenter.__new__(TargetSegmenter)
        target.input_size = 10
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        hand_output = np.asarray([[[5.0], [5.0], [6.0], [6.0], [0.1]]], dtype=np.float32)
        hand.run = lambda _tensor: [hand_output]
        short_target = np.zeros((1, 43, 1), dtype=np.float32)
        short_target[0, :4, 0] = (5, 5, 0, 6)
        short_target[0, 6, 0] = 0.9
        short_target[0, -32:, 0] = 1
        target.run = lambda _tensor: [short_target, np.ones((1, 32, 4, 4), dtype=np.float32)]
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)), patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            self.assertEqual(hand.detect_boxes(np.zeros((10, 10, 3), dtype=np.uint8), 0.5), [])
            self.assertEqual(target.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5), [])

    def test_remaining_row_orientation_and_invalid_box_branches(self) -> None:
        self.assertEqual(TargetSegmenter._prediction_rows(np.zeros((1, 2, 43), dtype=np.float32)).shape, (2, 43))
        generic = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        generic.input_size = 10; generic.class_names = ("penis",)
        prediction = np.zeros((1, 37, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 0, 6)
        prediction[0, 4, 0] = .9; prediction[0, 5:, 0] = 1
        generic.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)):
            self.assertEqual(generic.detect(np.zeros((10, 10, 3), dtype=np.uint8), .5, "generic"), [])


class HttpBranchTests(unittest.TestCase):
    @staticmethod
    def handler(*, headers: dict[str, str] | None = None, body: bytes = b"") -> http_module.MosaicHandler:
        instance = http_module.MosaicHandler.__new__(http_module.MosaicHandler)
        instance.headers = headers or {}
        instance.rfile = io.BytesIO(body)
        instance.wfile = io.BytesIO()
        instance.close_connection = False
        return instance

    def test_request_parsers_reject_ambiguous_values_and_preserve_valid_values(self) -> None:
        self.assertIsNone(http_module._request_version(""))
        self.assertEqual(http_module._request_version("v=abc"), "abc")
        for query in ("v=", "v=a&v=b"):
            with self.subTest(query=query):
                with self.assertRaises(ClientError):
                    http_module._request_version(query)
        self.assertEqual(http_module._route_ids("/api/mask/a/b", "/api/mask/"), ("a", "b"))
        for path in ("/api/mask/a", "/api/mask//b", "/api/mask/a/b/c"):
            with self.subTest(path=path):
                with self.assertRaises(ClientError):
                    http_module._route_ids(path, "/api/mask/")
        self.assertEqual(http_module._read_candidate_revision(0), 0)
        for value in (True, "1", -1):
            with self.subTest(value=value):
                with self.assertRaises(ClientError):
                    http_module._read_candidate_revision(value)
        self.assertTrue(http_module._read_bool(True, "test"))
        with self.assertRaises(ClientError):
            http_module._read_bool(1, "test")

    def test_update_start_reservation_is_single_use_until_the_process_restarts(self) -> None:
        with patch.object(http_module, "_update_start_requested", False):
            self.assertTrue(http_module._reserve_update_start())
            self.assertFalse(http_module._reserve_update_start())

    def test_json_reader_accepts_object_and_rejects_all_invalid_wire_forms(self) -> None:
        valid = self.handler(headers={"Content-Length": "7"}, body=b'{"x":1}')
        self.assertEqual(valid._read_json_body(), {"x": 1})
        cases = (
            ({}, b""),
            ({"Content-Length": "bad"}, b""),
            ({"Content-Length": "0"}, b""),
            ({"Content-Length": "2"}, b"\xff\xff"),
            ({"Content-Length": "2"}, b"[]"),
        )
        for headers, body in cases:
            with self.subTest(headers=headers, body=body):
                with self.assertRaises(ClientError):
                    self.handler(headers=headers, body=body)._read_json_body()

    def test_binary_import_reader_streams_real_bytes_and_removes_short_partial_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            imports = Path(directory) / "session" / "imports"; imports.mkdir(parents=True)
            state = SimpleNamespace(_ensure_session=lambda: imports)
            payload = b"abc123"
            handler = self.handler(headers={"Content-Length": str(len(payload))}, body=payload)
            with patch.object(http_module, "STATE", state):
                staged = handler._read_binary_body_to_file()
                self.assertEqual(staged.read_bytes(), payload)
                self.assertFalse(hasattr(handler, "_upload_sha256"))
                staged.unlink()
                with self.assertRaises(ClientError):
                    self.handler(headers={"Content-Length": "7"}, body=payload)._read_binary_body_to_file()
            self.assertEqual(list(imports.glob("*.upload.tmp")), [])

    def test_client_error_and_static_response_choose_safe_user_codes(self) -> None:
        handler = self.handler()
        emitted: list[tuple[object, object]] = []
        handler._json = lambda payload, status: emitted.append((payload, status))
        handler._client_error(ClientError("bad", "bad_code", {"x": 1}), http_module.HTTPStatus.BAD_REQUEST)
        handler._client_error(http_module.StaleMaskError("stale"), http_module.HTTPStatus.NOT_FOUND, "mask_not_found")
        handler._client_error(__import__("sqlite3").DatabaseError("locked"), http_module.HTTPStatus.INTERNAL_SERVER_ERROR)
        handler._client_error(RuntimeError("secret"), http_module.HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")
        self.assertEqual([payload["error_code"] for payload, _status in emitted], ["bad_code", "mask_not_found", "workspace_database_error", "internal_error"])
        with tempfile.TemporaryDirectory() as directory:
            static = Path(directory); (static / "index.html").write_text("{{SESSION_TOKEN}}", encoding="utf-8")
            rendered: list[tuple[bytes, str]] = []
            handler._binary = lambda data, content_type, *args, **kwargs: rendered.append((data, content_type))
            state = SimpleNamespace(session_token="token")
            with patch.object(http_module, "STATIC_DIR", static), patch.object(http_module, "STATE", state):
                handler._send_static("/")
                handler._send_static("/missing.txt")
                handler._send_static("/../private.txt")
            self.assertEqual(rendered[0][0], b"token")

    def test_native_picker_reports_cancel_failure_and_decodes_a_real_utf8_path(self) -> None:
        state = SimpleNamespace(native_picker_lock=__import__("threading").Lock())
        with patch("mozarie.http.Path.is_file", return_value=False):
            with self.assertRaises(ClientError):
                http_module._run_native_picker("", {}, failed_message="failed", busy_message="busy", state=state)
        response = SimpleNamespace(returncode=0, stdout=base64.b64encode("C:/日本語/model.onnx".encode("utf-8")))
        with patch("mozarie.http.Path.is_file", return_value=True), patch("mozarie.http.subprocess.run", return_value=response):
            self.assertEqual(http_module._run_native_picker("write-output", {}, failed_message="failed", busy_message="busy", state=state), "C:/日本語/model.onnx")
        cancelled = SimpleNamespace(returncode=0, stdout=b"")
        with patch("mozarie.http.Path.is_file", return_value=True), patch("mozarie.http.subprocess.run", return_value=cancelled):
            self.assertIsNone(http_module._run_native_picker("", {}, failed_message="failed", busy_message="busy", state=state))

    def test_unknown_get_post_and_delete_walk_every_unmatched_api_route(self) -> None:
        handler = self.handler()
        handler.server = SimpleNamespace(server_port=9876)
        sent: list[str] = []
        handler._require_local_host = lambda: "127.0.0.1:9876"
        handler._send_static = lambda path: sent.append(path)
        handler.path = "/not-a-route"
        handler.do_GET()
        self.assertEqual(sent, ["/not-a-route"])
        handler._require_json_request = lambda: None
        handler._read_json_body = lambda: {}
        errors: list[object] = []
        handler._client_error = lambda error, *_args, **_kwargs: errors.append(error)
        handler.path = "/api/not-a-route"
        handler.do_POST()
        handler._require_mutation_request = lambda: None
        handler.path = "/api/not-a-route"
        handler.do_DELETE()
        self.assertEqual([getattr(error, "error_code", None) for error in errors], ["api_not_found", "api_not_found"])

    def test_post_routes_call_their_state_contracts_with_valid_user_values(self) -> None:
        handler = self.handler()
        handler.server = SimpleNamespace(server_port=9876)
        handler._require_json_request = lambda: None
        handler._json = lambda *_args, **_kwargs: None
        handler._binary = lambda *_args, **_kwargs: None
        handler._client_error = lambda error, *_args, **_kwargs: (_ for _ in ()).throw(error)
        state = Mock()
        state.request_pause.return_value = SimpleNamespace(as_dict=lambda: {})
        state.resume_job.return_value = SimpleNamespace(as_dict=lambda: {})
        state.request_cancel.return_value = SimpleNamespace(as_dict=lambda: {})
        state.model_downloads = Mock()
        state.list_images.return_value = []
        state.diagnose_gpu_runtime.return_value = []
        state.recover_gpu_oom_for_request.return_value = None
        routes = (
            ("/api/folder", {"path": "C:/images"}),
            ("/api/catalog/clear", {}),
            ("/api/workspace/image/image", {}),
            ("/api/workspace/manual/image", {}),
            ("/api/catalog/remove", {"imageIds": []}),
            ("/api/masks/clear", {"imageIds": []}),
            ("/api/candidates/batch", {"imageId": "image"}),
            ("/api/settings/status", {}),
            ("/api/settings/gpu-diagnostic", {}),
            ("/api/model-file/pick", {"modelKey": "target_segmentation"}),
            ("/api/model-download/cancel", {}),
            ("/api/boundary", {"imageId": "image"}),
            ("/api/save/prepare", {"imageIds": [], "divisor": 100, "deleteOriginal": False}),
            ("/api/save/commit", {"imageId": "image", "candidateRevision": 0, "saveToken": "token", "sourceAction": "copy"}),
            ("/api/save/status", {"imageId": "image", "candidateRevision": 0, "saveToken": "token", "sourceAction": "copy"}),
            ("/api/save/cancel", {"imageId": "image", "candidateRevision": 0, "saveToken": "token"}),
            ("/api/apply", {"imageIds": [], "divisor": 100, "copyToDefault": False}),
            ("/api/job/pause", {}),
            ("/api/job/resume", {}),
            ("/api/job/cancel", {}),
            ("/api/candidate/image/candidate", {}),
        )
        with patch.object(http_module, "STATE", state), patch("mozarie.http._local_version", return_value="v1.0.0"), patch("mozarie.http._pick_model_file", return_value=None):
            for path, payload in routes:
                with self.subTest(path=path):
                    handler.path = path
                    handler._read_json_body = lambda payload=payload: payload
                    handler.do_POST()
        state.set_root.assert_called_once_with("C:/images")
        state.start_apply.assert_called_once()

    def test_post_route_optional_user_choices_take_their_enabled_paths(self) -> None:
        handler = self.handler()
        handler.server = SimpleNamespace(server_port=9876)
        handler._require_json_request = lambda: None
        handler._json = lambda *_args, **_kwargs: None
        handler._client_error = lambda error, *_args, **_kwargs: (_ for _ in ()).throw(error)
        state = Mock()
        state.settings = {"detection": {"threshold": 0.5, "parallelism": 1}}
        state.update_settings.return_value = {}
        state.reset_settings.return_value = {}
        state.settings_status.return_value = {}
        state.recover_gpu_oom_for_request.return_value = None
        routes = (
            ("/api/detect", {"imageIds": [], "confidence": .5, "parallelism": 1, "targetClasses": ["penis"]}),
            ("/api/settings", {}),
            ("/api/settings/reset", {}),
        )
        with patch.object(http_module, "STATE", state), patch("mozarie.http._local_version", return_value="v1.0.0"):
            for path, payload in routes:
                with self.subTest(path=path):
                    handler.path = path
                    handler._read_json_body = lambda payload=payload: payload
                    handler.do_POST()
        state.start_detection.assert_called_once()

    def test_get_and_delete_routes_forward_real_route_parameters_to_state(self) -> None:
        handler = self.handler()
        handler.server = SimpleNamespace(server_port=9876)
        handler._require_local_host = lambda: "127.0.0.1:9876"
        handler._require_mutation_request = lambda: None
        handler._json = lambda *_args, **_kwargs: None
        handler._send_image = lambda *args, **kwargs: None
        handler._send_candidate_mask = lambda *args, **kwargs: None
        handler._client_error = lambda error, *_args, **_kwargs: (_ for _ in ()).throw(error)
        state = Mock()
        state.settings = {"models": {"provider": "cpu"}}
        state.settings_status.return_value = {"gpuDeviceValid": True, "models": {}, "gpus": []}
        state.job.as_dict.return_value = {}
        state.lock = __import__("threading").RLock()
        state._candidate_revision.return_value = 2
        state.recover_gpu_oom_for_request.return_value = None
        get_routes = (
            "/api/health",
            "/api/settings?status=0",
            "/api/model-download",
            "/api/update/status",
            "/api/images",
            "/api/job",
            "/api/image/image?v=asset",
            "/api/thumbnail/image",
            "/api/candidates/image",
            "/api/workspace/manual/image",
            "/api/mask/image/candidate?v=2-candidate",
        )
        delete_routes = (
            "/api/catalog/image/image",
            "/api/candidate/image/candidate",
            "/api/workspace/manual/image",
        )
        with patch.object(http_module, "STATE", state), patch("mozarie.http._local_version", return_value="v1.0.0"), patch("mozarie.http._update_status", return_value={"available": False}):
            for path in get_routes:
                with self.subTest(method="GET", path=path):
                    handler.path = path
                    handler.do_GET()
            for path in delete_routes:
                with self.subTest(method="DELETE", path=path):
                    handler.path = path
                    handler.do_DELETE()
        state.remove_image_from_catalog.assert_called_once_with("image")
        state.delete_candidate.assert_called_once_with("image", "candidate")

    def test_mutation_guards_require_local_origin_token_and_content_type(self) -> None:
        handler = self.handler(headers={"Host": "other"})
        handler.server = SimpleNamespace(server_port=9876)
        handler._reject_unread_request = lambda error: (_ for _ in ()).throw(error)
        with self.assertRaises(ClientError):
            handler._require_local_host()
        valid = {"Host": "127.0.0.1:9876", "Origin": "http://127.0.0.1:9876", "X-Mozarie-Token": "token", "Content-Type": "application/json; charset=utf-8"}
        handler.headers = valid
        state = SimpleNamespace(session_token="token")
        with patch.object(http_module, "STATE", state):
            handler._require_json_request()
            handler.headers = {**valid, "Sec-Fetch-Site": "cross-site"}
            with self.assertRaises(ClientError):
                handler._require_mutation_request()
            handler.headers = {**valid, "Content-Type": "text/plain"}
            with self.assertRaises(ClientError):
                handler._require_json_request()
            handler.headers = {**valid, "Content-Type": "application/octet-stream"}
            handler._require_binary_import_request()

    def test_picker_wrappers_validate_busy_unknown_and_unusable_selections(self) -> None:
        lock = __import__("threading").RLock()
        state = SimpleNamespace(lock=lock, active_import_count=0, job=SimpleNamespace(state="idle"), _has_active_worker=lambda: False)
        with self.assertRaises(ClientError):
            http_module._pick_model_file("unknown", state)
        busy_state = SimpleNamespace(lock=__import__("threading").RLock(), active_import_count=1, job=SimpleNamespace(state="idle"), _has_active_worker=lambda: False)
        with self.assertRaises(ClientError):
            http_module._pick_model_file("target_segmentation", busy_state)
        with tempfile.TemporaryDirectory() as directory:
            bad = str(Path(directory) / "wrong.txt")
            Path(bad).write_text("x", encoding="utf-8")
            with patch("mozarie.http._run_native_picker", return_value=bad):
                with self.assertRaises(ClientError):
                    http_module._pick_model_file("target_segmentation", state)
        native = SimpleNamespace(native_picker_lock=__import__("threading").Lock())
        native.native_picker_lock.acquire()
        try:
            with self.assertRaises(ClientError):
                http_module._run_native_picker("", {}, failed_message="failed", busy_message="busy", state=native)
        finally:
            native.native_picker_lock.release()

    def test_binary_and_stream_responses_handle_regular_and_disconnected_clients(self) -> None:
        handler = self.handler()
        headers: list[tuple[str, str]] = []
        handler.send_response = lambda _status: None
        handler.send_header = lambda key, value: headers.append((key, value))
        handler.end_headers = lambda: None
        handler.close_connection = True
        handler._binary(b"ok", "text/plain", headers={"X-Test": "yes"})
        self.assertIn(("Connection", "close"), headers)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"abc")
            handler.close_connection = False
            handler.wfile = io.BytesIO()
            with source.open("rb") as handle:
                handler._stream_file(handle, None, "text/plain", "no-store")
            self.assertEqual(handler.wfile.getvalue(), b"abc")


class RootEntrypointBranchTests(unittest.TestCase):
    def test_server_startup_and_error_handler_cover_failure_paths(self) -> None:
        self.assertIsNone(server._startup_state(SimpleNamespace(STATE_STARTUP_ERROR=RuntimeError("locked"), STATE=None)))
        http_server = Mock()
        with patch("server.ThreadingHTTPServer.handle_error") as handler, patch("server.sys.exc_info", return_value=(RuntimeError, RuntimeError("bad"), None)):
            server._handle_server_error(http_server, Mock(), ("127.0.0.1", 1))
        handler.assert_called_once()

    def test_gpu_probe_rejects_an_out_of_range_device(self) -> None:
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1))
        ort = SimpleNamespace(get_available_providers=lambda: ["CUDAExecutionProvider"])
        self.assertFalse(setup_gpu_check._gpu_is_ready(np, ort, torch, SimpleNamespace(), 2))


class UpdaterBranchTests(unittest.TestCase):
    def test_release_archive_rejects_each_untrusted_asset_field(self) -> None:
        base = {"assets": [{"name": "mozarie.zip", "state": "uploaded", "browser_download_url": "https://example.test/a.zip", "digest": "sha256:" + "0" * 64, "size": 1}], "immutable": True}
        for changed in (
            {"assets": "bad"},
            {"immutable": False},
            {"assets": [{**base["assets"][0], "digest": "bad"}]},
            {"assets": [{**base["assets"][0], "size": 0}]},
        ):
            release = {**base, **changed}
            with self.subTest(release=release):
                with self.assertRaises(updater.UpdateError):
                    updater.release_archive(release)

    def test_local_update_fails_on_version_mismatch_and_dependency_rollback_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"; app.mkdir(); (app / "VERSION").write_text("1.0.0", encoding="utf-8")
            release = {"tag_name": "v1.1.0"}
            with patch("updater.fetch_latest_release", return_value=release), patch("updater.mozarie_running_status", return_value="none"), patch("updater.release_archive", return_value=("https://example.test/a.zip", "0" * 64, 1)), patch("updater.download_archive"), patch("updater.extract_archive", return_value=app), patch("updater.read_local_version", side_effect=["1.0.0", "1.0.1"]):
                with self.assertRaises(updater.UpdateError):
                    updater._perform_update(app, input_fn=lambda _prompt: "y")
            with patch("updater.fetch_latest_release", return_value=release), patch("updater.mozarie_running_status", return_value="none"), patch("updater.release_archive", return_value=("https://example.test/a.zip", "0" * 64, 1)), patch("updater.download_archive"), patch("updater.extract_archive", return_value=app), patch("updater.read_local_version", side_effect=["1.0.0", "1.1.0"]), patch("updater.install_requirements", return_value=True), patch("updater.apply_update", side_effect=updater.UpdateError("copy failed")):
                with self.assertRaises(updater.UpdateError):
                    updater._perform_update(app, input_fn=lambda _prompt: "yes")

    def test_updater_rejects_partial_archives_and_missing_runtime_phases(self) -> None:
        class Response:
            def __init__(self, data: bytes) -> None:
                self.data = io.BytesIO(data)
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self, size: int) -> bytes: return self.data.read(size)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(updater, "MAX_ARCHIVE_BYTES", 1):
                with self.assertRaises(updater.UpdateError):
                    updater.download_archive("https://example.test/a.zip", root / "a.zip", "0" * 64, 2, lambda *_args, **_kwargs: Response(b"ab"))
            unsafe_member = zipfile.ZipInfo("wrapper/bad.txt")
            unsafe_member.filename = r"wrapper\bad.txt"
            with self.assertRaises(updater.UpdateError):
                updater._safe_member_path(unsafe_member)
            empty = root / "empty.zip"
            with zipfile.ZipFile(empty, "w"):
                pass
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(empty, root / "out")
            self.assertFalse(updater.install_requirements(root / "missing", root / "app"))
            with self.assertRaises(updater.UpdateError):
                updater.run_gpu_smoke(root / "app")
        lock = updater.MaintenanceLock(Path("."))
        lock.close()

    def test_update_request_only_launches_setup_when_the_cli_flag_matches_exactly(self) -> None:
        with patch("updater.sys.argv", ["updater.py", "--check-running"]), patch("updater.mozarie_running_status", return_value="none"):
            self.assertEqual(updater.main(), 0)
        with patch("updater.sys.argv", ["updater.py", "--unexpected"]), patch("updater.perform_update", return_value=updater.EXIT_CURRENT) as perform:
            self.assertEqual(updater.main(), updater.EXIT_CURRENT)
        perform.assert_called_once()

    def test_updater_local_archive_and_runtime_preflight_failures_preserve_the_install(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            oversized = root / "oversized.zip"
            with zipfile.ZipFile(oversized, "w") as bundle:
                bundle.writestr("wrapper/file.txt", b"ab")
            with patch.object(updater, "MAX_ARCHIVE_BYTES", 1):
                with self.assertRaises(updater.UpdateError):
                    updater.extract_archive(oversized, root / "out")
            multi_root = root / "multi.zip"
            with zipfile.ZipFile(multi_root, "w") as bundle:
                bundle.writestr("one/file.txt", b"x")
                bundle.writestr("two/file.txt", b"x")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(multi_root, root / "out2")
            cache = root / "app" / ".mozarie-cache" / "process-test"
            cache.mkdir(parents=True)
            self.assertEqual(updater.mozarie_running_status(root / "app"), "none")
            source = root / "source"; source.mkdir(); (source / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
            with self.assertRaises(updater.UpdateError):
                updater.install_requirements(source, root / "app")
            app = root / "runtime"; (app / ".venv" / "Scripts").mkdir(parents=True); (app / ".venv" / "Scripts" / "python.exe").write_bytes(b"")
            with self.assertRaises(updater.UpdateError):
                updater.run_gpu_smoke(app)
            with self.assertRaises(updater.UpdateError):
                updater.apply_update(source, root / "missing-app")

    def test_updater_reports_failed_dependency_and_gpu_smoke_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"; source.mkdir(); (source / "requirements.txt").write_text("Pillow\n", encoding="utf-8")
            app = root / "app"; python = app / ".venv" / "Scripts" / "python.exe"; python.parent.mkdir(parents=True); python.write_bytes(b"")
            with patch("updater.subprocess.run", return_value=SimpleNamespace(returncode=1)):
                with self.assertRaises(updater.UpdateError):
                    updater.install_requirements(source, app)
            (app / "setup_gpu_check.py").write_text("", encoding="utf-8")
            with patch("updater.subprocess.run", return_value=SimpleNamespace(returncode=1)):
                with self.assertRaises(updater.UpdateError):
                    updater.run_gpu_smoke(app)
            archive = root / "directory.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("wrapper/empty/", b"")
            with self.assertRaises(updater.UpdateError):
                updater.extract_archive(archive, root / "extract")
