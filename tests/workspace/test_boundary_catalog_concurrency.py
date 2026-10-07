"""Catalogue changes and interactive model preparation cannot lock each other."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from tests import prepare_test_app_config
from mozarie import state as state_module
from mozarie.state import StudioState


class BoundaryCatalogConcurrencyTests(unittest.TestCase):
    def test_clear_replace_and_delete_project_finish_during_boundary_preparation(self):
        for operation in ("clear", "replace", "delete_project"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                app = root / "app"
                prepare_test_app_config(app)
                with patch.object(state_module, "APP_DIR", app):
                    state = StudioState(root / "cache", root / "sessions")
                preparation = threading.Event()
                invalidation = threading.Event()
                requesting_state = threading.Event()
                errors = []
                workers = []
                original_sam_lock = state.sam_lock

                class StopBeforeModelLoad(Exception):
                    pass

                class ObservedSamLock:
                    def __enter__(self):
                        if not original_sam_lock.acquire(timeout=3):
                            raise AssertionError("catalogue holds state lock while waiting for boundary SAM")
                        return self

                    def __exit__(self, *_args):
                        original_sam_lock.release()

                original_preparation = state._set_detection_model_preparation
                original_invalidate = state._invalidate_sam_cache

                def prepare(*args, **kwargs):
                    preparation.set()
                    if not invalidation.wait(5):
                        raise AssertionError("catalogue never reached cache invalidation")
                    requesting_state.set()
                    original_preparation(*args, **kwargs)
                    raise StopBeforeModelLoad()

                def invalidate():
                    invalidation.set()
                    if not requesting_state.wait(5):
                        raise AssertionError("boundary never requested its preparation state")
                    original_invalidate()

                def boundary():
                    try:
                        state.add_boundary_candidate(image_id, {"roi": {"left": 0, "top": 0, "right": 16, "bottom": 16}, "point": {"x": 8, "y": 8}})
                    except StopBeforeModelLoad:
                        pass
                    except BaseException as exc:
                        errors.append(exc)

                def change_catalog():
                    try:
                        if operation == "clear":
                            state.clear_catalog()
                        elif operation == "replace":
                            state.set_root(str(replacement))
                        else:
                            state.delete_project(project_id)
                    except BaseException as exc:
                        errors.append(exc)

                try:
                    source = root / "source"
                    replacement = root / "replacement"
                    for folder in (source, replacement):
                        folder.mkdir()
                        with Image.new("RGB", (16, 16)) as image:
                            image.save(folder / "one.png")
                    project_id = state.create_project("Concurrent boundary")["id"] if operation == "delete_project" else None
                    state.set_root(str(source))
                    image_id = state.order[0]
                    checkpoint = root / "sam.pth"
                    checkpoint.write_bytes(b"")
                    state.settings["models"]["provider"] = "cpu"
                    state.settings["models"]["sam_model_type"] = "vit_b"
                    state.settings["models"]["sam_checkpoints"]["vit_b"] = str(checkpoint)
                    state.sam_lock = ObservedSamLock()
                    with patch.object(state, "_set_detection_model_preparation", side_effect=prepare), patch.object(state, "_invalidate_sam_cache", side_effect=invalidate):
                        workers = [threading.Thread(target=boundary), threading.Thread(target=change_catalog)]
                        workers[0].start()
                        self.assertTrue(preparation.wait(5))
                        workers[1].start()
                        for worker in workers:
                            worker.join(10)
                        self.assertFalse(any(worker.is_alive() for worker in workers))
                        self.assertEqual(errors, [])
                    self.assertIsNone(state.sam_image_id)
                    if operation == "replace":
                        self.assertEqual(state.images[state.order[0]].path.parent, replacement)
                    else:
                        self.assertEqual(state.order, [])
                    self.assertTrue((source / "one.png").exists())
                finally:
                    invalidation.set()
                    requesting_state.set()
                    for worker in workers:
                        if worker.ident is not None:
                            worker.join(10)
                    state.sam_lock = original_sam_lock
                    state.shutdown()
                    state.workspace_store.shutdown()
