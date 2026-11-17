"""Inference releases decoded originals before model execution and job resources afterwards."""
import io
import sys
import tempfile
import threading
import tracemalloc
import unittest
import weakref
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageOps, PngImagePlugin

from tests import prepare_test_app_config
from mozarie import state as state_module
from mozarie.state import StudioState
from mozarie.detection import _save_binary_mask


class InferenceResourceLifetimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        app = self.root / 'app'
        prepare_test_app_config(app)
        self.enterContext(patch.object(state_module, 'APP_DIR', app))
        self.state = StudioState(self.root / 'cache', self.root / 'sessions')
        self.addCleanup(self.state.shutdown)
        source = self.root / 'source'
        source.mkdir()
        with Image.new('RGB', (64, 48), (17, 38, 59)) as image:
            image.save(source / 'sample.png')
        self.state.set_root(str(source))
        self.image_id = next(iter(self.state.images))
        model = self.root / 'target.onnx'
        model.write_bytes(b'external inference fixture')
        self.state.settings['models'].update({
            'provider': 'cpu', 'target_segmentation': str(model),
            'ntd11_enabled': False, 'sensitive_enabled': False,
            'hand_detection_enabled': False, 'hand_segmentation_enabled': False,
        })
        self.state.settings['detection'].update({'mode': 'standard', 'fluid_exclusion_enabled': False})
        self.decoded = []
        transpose = ImageOps.exif_transpose
        def observe_decode(*args, **kwargs):
            result = transpose(*args, **kwargs)
            self.decoded.append(weakref.ref(result))
            return result
        self.enterContext(patch.object(ImageOps, 'exif_transpose', new=observe_decode))

    def assert_inference_pixels(self, rgb):
        self.assertTrue(self.decoded)
        self.assertTrue(all(reference() is None for reference in self.decoded))
        np.testing.assert_array_equal(rgb, np.full((48, 64, 3), (17, 38, 59), dtype=np.uint8))
        self.assertTrue(rgb.flags.writeable)

    def join_job(self):
        self.state.worker_thread.join(15)
        self.assertFalse(self.state.worker_thread.is_alive())

    def test_detection_discards_decoded_original_before_inference_and_reuses_cpu_model(self):
        # A valid ancillary chunk makes retained encoded bytes observable without
        # depending on allocator RSS or the physical GPU driver.
        metadata = PngImagePlugin.PngInfo()
        metadata.add(b'aaAa', b'x' * (4 * 1024 * 1024))
        path = self.root / 'large-source' / 'sample.png'
        path.parent.mkdir()
        with Image.new('RGB', (64, 48), (17, 38, 59)) as image:
            image.save(path, pnginfo=metadata)
        self.state.set_root(str(path.parent))
        self.image_id = next(iter(self.state.images))
        original = path.read_bytes()
        owner = self
        class Target:
            def detect(self, rgb, *_args):
                owner.assert_inference_pixels(rgb)
                owner.assertLess(tracemalloc.get_traced_memory()[0], len(original) // 2)
                return []
        tracemalloc.start()
        try:
            with patch('mozarie.detection.TargetSegmenter', side_effect=lambda *a, **k: Target()) as factory:
                for _ in range(2):
                    self.state.start_detection([self.image_id])
                    self.join_job()
                    self.assertEqual(self.state.job.state, 'complete', self.state.job.error)
                self.assertEqual(factory.call_count, 1)
        finally:
            tracemalloc.stop()
        self.assertEqual(path.read_bytes(), original)

    def test_boundary_discards_decoded_original_before_sam_embedding(self):
        owner = self
        class Predictor:
            def reset_image(self):
                pass
            def set_image(self, rgb):
                owner.assert_inference_pixels(rgb)
            def predict(self, **kwargs):
                return np.ones((1, 48, 64), dtype=bool), np.array([.9]), None
        self.state.sam_predictor = Predictor()
        self.state.add_boundary_candidate(self.image_id, {
            'roi': {'left': 2, 'top': 2, 'right': 32, 'bottom': 32}, 'point': {'x': 10, 'y': 10},
        })
        self.assertTrue(self.state.list_candidates(self.image_id))

    def test_directml_complete_cancel_failure_release_models_and_allow_next_job(self):
        self.state.settings['models']['provider'] = 'gpu'
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False,
            empty_cache=lambda: self.fail('DirectML must not call CUDA empty_cache')))
        modules = {'torch': torch, 'torch_directml': SimpleNamespace(device_count=lambda: 1, device_name=lambda i: 'fixture GPU'),
                   'onnxruntime': SimpleNamespace(get_available_providers=lambda: ['DmlExecutionProvider', 'CPUExecutionProvider'])}
        references = []
        entered, resume = threading.Event(), threading.Event()
        self.addCleanup(resume.set)
        behavior = ['complete']
        owner = self
        class Target:
            def detect(self, rgb, *_args):
                owner.assert_inference_pixels(rgb)
                if behavior[0] == 'cancel':
                    entered.set()
                    if not resume.wait(10):
                        raise RuntimeError('cancel fixture was not resumed')
                elif behavior[0] == 'failed':
                    raise RuntimeError('external inference failure fixture')
                return []
        def create(*args, **kwargs):
            model = Target()
            references.append(weakref.ref(model))
            return model
        with patch.dict('os.environ', {'MOZARIE_RUNTIME': 'directml'}), patch.dict(sys.modules, modules), \
                patch('mozarie.detection.TargetSegmenter', side_effect=create):
            for outcome in ('complete', 'cancel', 'failed', 'complete'):
                behavior[0] = outcome
                self.state.start_detection([self.image_id])
                if outcome == 'cancel':
                    self.assertTrue(entered.wait(10))
                    self.state.request_cancel()
                    resume.set()
                self.join_job()
                self.assertEqual(self.state.job.state, {'cancel': 'cancelled', 'failed': 'error'}.get(outcome, outcome), self.state.job.error)
                self.assertTrue(all(reference() is None for reference in references))
                for field in ('models', 'hand_model', 'sam_predictor', 'hand_segmentation_predictor'):
                    self.assertIsNone(getattr(self.state, field))
            self.assertEqual(len(references), 4)

    def test_binary_mask_save_avoids_wide_integer_plane_and_preserves_pixels(self):
        with Image.new('L', (1, 1)) as warmup:
            warmup.save(io.BytesIO(), format='PNG')
        mask = np.zeros((1024, 1024), dtype=np.int16)
        mask[10:200, 30:300] = 7
        mask[0, 0] = -1
        original = mask.copy()
        path = self.root / 'mask.png'
        tracemalloc.start()
        try:
            _save_binary_mask(mask, path)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertLess(peak, mask.size * 4 + 256 * 1024)
        np.testing.assert_array_equal(mask, original)
        with Image.open(path) as saved:
            np.testing.assert_array_equal(np.asarray(saved), (original > 0).astype(np.uint8) * 255)
            self.assertEqual(saved.info['mozarie_expand_px'], '0')

