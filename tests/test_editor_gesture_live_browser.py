"""Real browser regression for manual editor gestures and durable PNG output."""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

import numpy as np
from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.domain import Candidate
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class LiveEditorGestureBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self._temporary_directory.name)
        self.app_dir = root / "app"
        (self.app_dir / "config").mkdir(parents=True)
        shutil.copy2(Path(__file__).resolve().parents[1] / "config" / "defaults.json", self.app_dir / "config" / "defaults.json")
        self.source_dir = root / "source"
        self.output_dir = root / "output"
        self.source_dir.mkdir()
        self.output_dir.mkdir()

        pixels = np.zeros((48, 64, 3), dtype=np.uint8)
        for y in range(48):
            for x in range(64):
                pixels[y, x] = ((x * 17 + y * 3) % 256, (x * 5 + y * 19) % 256, (x * 11 + y * 7) % 256)
        self.source_path = self.source_dir / "gesture.png"
        Image.fromarray(pixels).save(self.source_path)
        self.source_bytes = self.source_path.read_bytes()

        self._previous_app_dir = state_module.APP_DIR
        self._previous_http_state = http_module.STATE
        self._previous_module_state = state_module.STATE
        state_module.APP_DIR = self.app_dir
        self.state = StudioState(root / "cache", root / "sessions")
        state_module.STATE = self.state
        http_module.STATE = self.state

        image_id = self.state.set_root(str(self.source_dir))[0]["id"]
        self.state.save_current_as_project("gesture-project", str(self.state.workspace_id))
        mask_path = self.state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        mask = np.zeros((48, 64), dtype=np.uint8)
        mask[8:12, 8:12] = 255
        Image.fromarray(mask).save(mask_path)
        self.state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        with self.state.image_io_lock(image_id), self.state.lock:
            self.state._commit_candidate_snapshot(image_id, self.state.candidates[image_id], replace=True)
        self.state.update_settings({"saving": {"default_output_directory": str(self.output_dir)}})

        self.server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        http_module.STATE = self._previous_http_state
        state_module.STATE = self._previous_module_state
        self.state.shutdown()
        state_module.APP_DIR = self._previous_app_dir
        self._temporary_directory.cleanup()

    def test_real_gestures_persist_history_reopen_and_render_only_the_effective_mask(self) -> None:
        helper = Path(__file__).with_name("editor_gesture_live_browser_helper.cjs")
        result = subprocess.run(
            ["node", str(helper), self.origin],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"},
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=120,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"live editor gesture helper failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

        outputs = list(self.output_dir.glob("gesture_gesture.png"))
        self.assertEqual(outputs, [self.output_dir / "gesture_gesture.png"])
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes, "copy save must not change the source image")
        with Image.open(self.source_path) as source_image, Image.open(outputs[0]) as output_image:
            source = source_image.convert("RGB")
            output = output_image.convert("RGB")
            self.assertNotEqual(output.getpixel((9, 9)), source.getpixel((9, 9)), "the committed candidate is mosaicked")
            self.assertEqual(output.getpixel((16, 10)), source.getpixel((16, 10)), "an uncommitted padding preview never reaches output")
            self.assertEqual(output.getpixel((48, 8)), source.getpixel((48, 8)), "mosaic erasing removes the clicked brush stamp")
            self.assertEqual(output.getpixel((41, 30)), source.getpixel((41, 30)), "forced exclusion removes mosaic at its untouched point")
            self.assertNotEqual(output.getpixel((47, 30)), source.getpixel((47, 30)), "exclusion erase restores the underlying brush mosaic")
            self.assertNotEqual(output.getpixel((54, 30)), source.getpixel((54, 30)), "the real drag remains in the saved mosaic mask")

    def _check_compact_draft_reload(self, named: bool) -> None:
        shutil.copy2(self.source_path, self.source_dir / "other.png")
        if not named:
            self.state.close_project()
        self.state.set_root(str(self.source_dir))
        image_id = next(iter(self.state.images))
        payload = {"candidateRevision": 0, "hasEffectiveMask": True}
        for layer, x in (("add", 5), ("exclusion", 15), ("exclusionErase", 25)):
            with Image.new("RGBA", (64, 48), (0, 0, 0, 0)) as mask, io.BytesIO() as output:
                mask.paste((255, 255, 255, 255), (x - 1, 4, x + 2, 7))
                mask.save(output, format="PNG")
                payload[layer] = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
        self.state.save_manual_workspace(image_id, payload)
        helper = Path(__file__).with_name("editor") / "draft_recovery_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, "named" if named else "anonymous"],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, f"draft recovery browser failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_anonymous_compact_draft_keeps_layers_through_edit_undo_redo_and_reload(self) -> None:
        self._check_compact_draft_reload(named=False)

    def test_peer_manual_sync_conflicts_and_last_stroke_undo_use_real_workspace(self) -> None:
        shutil.copy2(self.source_path, self.source_dir / "other.png")
        self.state.set_root(str(self.source_dir))
        helper = Path(__file__).with_name("editor") / "manual_sync_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"manual sync browser failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def _check_manual_snapshot(self, mode: str) -> None:
        shutil.copy2(self.source_path, self.source_dir / "other.png")
        self.state.set_root(str(self.source_dir))
        helper = Path(__file__).with_name("editor") / "manual_snapshot_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, mode], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"manual snapshot {mode} failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_selecting_peer_edited_image_keeps_manual_snapshot_and_revision_together(self) -> None:
        self._check_manual_snapshot("selection")

    def test_renaming_cannot_bless_old_pixels_with_a_peer_manual_revision(self) -> None:
        self._check_manual_snapshot("rename")

    def test_return_sync_refreshes_pixels_after_metadata_already_updated_the_catalog(self) -> None:
        self._check_manual_snapshot("return")

    def test_single_copy_rejects_stale_canvas_after_catalog_metadata_refresh(self) -> None:
        self._check_manual_snapshot("single-copy")
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_batch_copy_rejects_stale_draft_after_catalog_metadata_refresh(self) -> None:
        self._check_manual_snapshot("batch-copy")
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_catalog_resync_cannot_bless_old_pixels_with_a_peer_manual_revision(self) -> None:
        self._check_manual_snapshot("resync")

    def test_importing_cannot_bless_old_pixels_with_a_peer_manual_revision(self) -> None:
        self._check_manual_snapshot("import")

    def test_removing_other_image_cannot_bless_old_pixels_with_a_peer_manual_revision(self) -> None:
        self._check_manual_snapshot("remove")

    def test_parallel_copy_delete_completes_every_real_file_and_workspace_row(self) -> None:
        shutil.copy2(self.source_path, self.source_dir / "other.png")
        self.state.set_root(str(self.source_dir))
        helper = Path(__file__).with_name("editor") / "parallel_copy_delete_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"parallel copy delete browser failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(sorted(path.name for path in self.output_dir.glob("*.png")), ["gesture_parallel.png", "other_parallel.png"])
        self.assertFalse(list(self.source_dir.glob("*.png")))
        self.assertEqual(self.state.list_images(), [])
        for path in self.output_dir.glob("*.png"):
            with Image.open(path) as image: self.assertEqual(image.size, (64, 48))

    def test_parallel_browser_copy_delete_keeps_surviving_save_tokens(self) -> None:
        self.state.close_project()
        helper = Path(__file__).with_name("editor") / "parallel_copy_delete_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, "browser"], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"browser handle copy delete failed\n{result.stdout}\n{result.stderr}")
        self.assertEqual(sorted(path.name for path in self.output_dir.glob("*.png")), ["browser1_parallel.png", "browser2_parallel.png"])
        self.assertEqual(self.state.list_images(), [])
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_browser_copy_delete_recovery_keeps_edits_made_after_the_copy(self) -> None:
        self.state.close_project()
        helper = Path(__file__).with_name("editor") / "parallel_copy_delete_live_browser_helper.cjs"
        result = subprocess.run(
            ["node", str(helper), self.origin, "recovery"], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONUTF8": "1"}, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, f"browser copy delete recovery failed\n{result.stdout}\n{result.stderr}")
        self.assertTrue((self.output_dir / "browser1_recovery.png").is_file())
        image_id = self.state.list_images()[0]["id"]
        self.assertFalse(self.state.manual_workspace(image_id)["manualEnabled"])

    def test_named_compact_draft_keeps_layers_through_edit_undo_redo_and_reload(self) -> None:
        self._check_compact_draft_reload(named=True)


if __name__ == "__main__":
    unittest.main()
