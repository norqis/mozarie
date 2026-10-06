"""Scene metadata reaches detection without expanding unrelated PNG text."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from tests import prepare_test_app_config
import mozarie.image_io as image_io
import mozarie.state as state_module
from mozarie.state import StudioState


def png_with_text(chunks: list[tuple[bytes, bytes]]) -> bytes:
    with Image.new("RGB", (8, 8), "black") as image, io.BytesIO() as output:
        image.save(output, format="PNG")
        raw = output.getvalue()
    encoded = []
    for kind, payload in chunks:
        body = kind + payload
        encoded.append(len(payload).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xffffffff).to_bytes(4, "big"))
    return raw[:-12] + b"".join(encoded) + raw[-12:]


class ScenePngMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        app_dir = self.root / "app"
        prepare_test_app_config(app_dir)
        self.enterContext(patch.object(state_module, "APP_DIR", app_dir))
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.addCleanup(self.state.shutdown)
        model = self.root / "fixture.onnx"
        model.write_bytes(b"model boundary fixture")
        self.state.settings["models"].update({
            "provider": "cpu", "target_segmentation": str(model),
            "ntd11_enabled": False, "sensitive_enabled": False,
            "hand_detection_enabled": False, "hand_segmentation_enabled": False,
        })
        self.state.settings["detection"].update({"mode": "standard", "fluid_exclusion_enabled": True})
        requested = self.requested = []

        class Target:
            def detect(self, rgb, confidence, target_classes):
                requested.append(set(target_classes))
                return []

        self.enterContext(patch("mozarie.detection.TargetSegmenter", return_value=Target()))
        self.enterContext(patch("mozarie.detection.runtime_backend", return_value="cpu"))
        self.source = self.root / "source"
        self.source.mkdir()
        self.load_count = 0

    def _load(self, raw: bytes):
        self.load_count += 1
        self.path = self.source / str(self.load_count) / "scene.png"
        self.path.parent.mkdir()
        self.path.write_bytes(raw)
        image_id = self.state.set_root(str(self.path.parent))[0]["id"]
        return self.state.image_for_id(image_id)

    def _detect(self, image_id: str) -> None:
        self.state.start_detection([image_id], parallelism=1, target_classes={"penis"})
        self.state.worker_thread.join(10)
        self.assertFalse(self.state.worker_thread.is_alive(), "detection did not terminate")
        self.assertEqual(self.state.job.state, "complete")
        self.assertEqual(self.state.job.completed_image_ids, (image_id,))

    def test_scene_tags_from_each_png_text_format_reach_detection(self) -> None:
        for key in (b"scene_positive", b"scene_info"):
            for kind, compressed in ((b"tEXt", False), (b"zTXt", True), (b"iTXt", False), (b"iTXt", True)):
                with self.subTest(key=key, kind=kind, compressed=compressed):
                    prefix = "日本語" if kind == b"iTXt" else "café"
                    value = f"{prefix}, cum_on_breasts"
                    if key == b"scene_info":
                        value = json.dumps({"positive": value}, ensure_ascii=False)
                    text = value.encode("utf-8" if kind == b"iTXt" else "latin-1")
                    payload = key + b"\0"
                    if kind == b"zTXt":
                        payload += b"\0"
                    elif kind == b"iTXt":
                        payload += bytes((int(compressed), 0)) + b"ja\0" + "場面".encode("utf-8") + b"\0"
                    payload += zlib.compress(text) if compressed else text
                    raw = png_with_text([(kind, payload)])
                    record = self._load(raw)
                    self._detect(record.image_id)
                    self.assertEqual(self.requested[-1], {"penis", "testicles", "female_face"})
                    self.assertEqual(image_io.read_scene_png_metadata(raw), {key.decode("ascii"): value})
                    self.assertEqual(self.path.read_bytes(), raw)

    def test_fluid_disabled_ignores_scene_tags_and_does_not_expand_text(self) -> None:
        raw = png_with_text([(b"zTXt", b"scene_positive\0\0" + zlib.compress(b"cum_on_breasts"))])
        record = self._load(raw)
        self.state.settings["detection"]["fluid_exclusion_enabled"] = False
        with patch.object(image_io.zlib, "decompress", side_effect=AssertionError("text must not be expanded")):
            self._detect(record.image_id)
        self.assertEqual(self.requested, [{"penis", "testicles"}])
        self.assertEqual(self.path.read_bytes(), raw)

    def test_only_exact_scene_keys_are_expanded_and_general_image_info_and_saved_chunks_stay_unchanged(self) -> None:
        selected = zlib.compress(b"cum_on_breasts")
        unrelated = zlib.compress(b"unrelated large workflow text" * 1000)
        chunks = [
            (b"zTXt", b"workflow\0\0" + unrelated),
            (b"zTXt", b"Scene_positive\0\0" + unrelated),
            (b"zTXt", b"scene_positive_extra\0\0" + unrelated),
            (b"zTXt", b"scene_positive\0\0" + selected),
        ]
        raw = png_with_text(chunks)
        record = self._load(raw)
        with patch.object(image_io.zlib, "decompress", wraps=zlib.decompress) as decompress:
            self._detect(record.image_id)
        self.assertEqual(self.requested, [{"penis", "testicles", "female_face"}])
        self.assertEqual(decompress.call_count, 1)
        self.assertEqual(decompress.call_args.args, (selected,))
        image, source, info = image_io.canonical_image(record)
        try:
            self.assertEqual(source, raw)
            self.assertEqual(info, {})
            self.assertFalse(np.any(np.asarray(image)))
        finally:
            image.close()
        rendered, suffix, mime = image_io.render_output(record, None, 4, "png", True)
        self.assertEqual((suffix, mime), (".png", "image/png"))
        self.assertEqual(
            [chunk for kind, chunk in image_io.parse_png_chunks(rendered) if kind == b"zTXt"],
            [chunk for kind, chunk in image_io.parse_png_chunks(raw) if kind == b"zTXt"],
        )
        self.assertEqual(self.path.read_bytes(), raw)

    def test_malformed_optional_text_keeps_the_last_valid_value_and_other_keys(self) -> None:
        good = [
            (b"tEXt", b"scene_positive\0old"),
            (b"zTXt", b"scene_positive\0\0" + zlib.compress(b"cum_on_breasts")),
            (b"iTXt", b"scene_info\0\0\0\0\0" + '{"positive":"日本語"}'.encode("utf-8")),
        ]
        broken = [
            (b"tEXt", b"scene_positive"),
            (b"zTXt", b"scene_positive\0"),
            (b"zTXt", b"scene_positive\0\x01" + zlib.compress(b"wrong method")),
            (b"zTXt", b"scene_positive\0\0broken zlib stream"),
            (b"iTXt", b"scene_positive\0\0"),
            (b"iTXt", b"scene_positive\0\0\0missing delimiters"),
            (b"iTXt", b"scene_positive\0\x02\0\0\0invalid flag"),
            (b"iTXt", b"scene_positive\0\x01\x01\0\0" + zlib.compress(b"wrong method")),
            (b"iTXt", b"scene_positive\0\0\0\0\0\xff"),
            (b"iTXt", b"scene_positive\0\x01\0\0\0" + zlib.compress(b"\xff")),
            (b"iTXt", b"scene_positive\0\x01\0\0\0broken zlib stream"),
        ]
        for chunk in broken:
            with self.subTest(chunk=chunk):
                raw = png_with_text([*good, chunk])
                record = self._load(raw)
                self._detect(record.image_id)
                self.assertEqual(self.requested[-1], {"penis", "testicles", "female_face"})
                self.assertEqual(image_io.read_scene_png_metadata(raw), {
                    "scene_positive": "cum_on_breasts", "scene_info": '{"positive":"日本語"}',
                })
                self.assertEqual(self.path.read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
