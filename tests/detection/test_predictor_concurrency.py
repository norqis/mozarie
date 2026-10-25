"""Parallel hand inference owns its image embedding until prediction returns."""

from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest

import numpy as np

from mozarie.state import StudioState


class PredictorConcurrencyTests(unittest.TestCase):
    def test_outline_preparation_waits_for_inflight_hand_prediction_before_reset(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        state = StudioState(root / "cache", root / "sessions")
        self.addCleanup(state.shutdown)
        state.settings["models"]["provider"] = "cpu"
        entered, release, transition = threading.Event(), threading.Event(), threading.Event()
        reset_while_predicting = threading.Event()
        errors = []

        class ObservedLock:
            def __init__(self, lock):
                self.lock = lock

            def __enter__(self):
                if threading.current_thread().name == "outline-test":
                    transition.set()
                self.lock.acquire()
                return self

            def __exit__(self, *_args):
                self.lock.release()

        def hand_predict():
            entered.set()
            if not release.wait(5):
                raise AssertionError("hand prediction was not released")

        def hand_reset():
            if not release.is_set():
                reset_while_predicting.set()
            transition.set()

        original_sam_lock = state.sam_lock
        observed_sam_lock = ObservedLock(original_sam_lock)
        state.hand_segmentation_lock = (observed_sam_lock if state.hand_segmentation_lock is original_sam_lock
                                        else ObservedLock(state.hand_segmentation_lock))
        state.sam_lock = observed_sam_lock
        state.hand_segmentation_predictor = SimpleNamespace(predict=hand_predict, reset_image=hand_reset)
        state.hand_segmentation_image_id = "current-hand"
        state.sam_predictor = SimpleNamespace(set_image=lambda _rgb: None, reset_image=lambda: None)
        state.sam_image_id = None

        def hand_worker():
            try:
                with state.hand_segmentation_lock:
                    state.hand_segmentation_predictor.predict()
            except BaseException as error:
                errors.append(error)

        def outline_worker():
            try:
                state._sam_predictor_for(SimpleNamespace(image_id="next-outline"), np.zeros((8, 8, 3), dtype=np.uint8))
            except BaseException as error:
                errors.append(error)

        hand = threading.Thread(target=hand_worker, name="hand-test")
        outline = threading.Thread(target=outline_worker, name="outline-test")
        hand.start()
        try:
            self.assertTrue(entered.wait(5))
            outline.start()
            self.assertTrue(transition.wait(5), "outline must reach the hand-embedding transition")
            self.assertFalse(reset_while_predicting.is_set())
        finally:
            release.set()
            hand.join(5)
            if outline.ident is not None:
                outline.join(5)
        self.assertFalse(hand.is_alive())
        self.assertFalse(outline.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(state.sam_image_id, "next-outline")
        self.assertIsNone(state.hand_segmentation_image_id)
