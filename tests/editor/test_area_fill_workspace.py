"""Real workspace contracts for bucket and enclosed-area editing."""
from __future__ import annotations

import base64
import io
import http.client
import json
import sqlite3
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from tests import prepare_test_app_config
import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.domain import Candidate, CandidateRole
from mozarie.state import StudioState


class AreaFillWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = self.root / 'app'
        prepare_test_app_config(self.app)
        self.states = []
        self.state = self.new_state()
        self.state.create_project('Area fill')
        self.source = self.root / 'source'; self.source.mkdir()
        with Image.new('RGB', (12, 10), 'white') as image:
            image.save(self.source / 'image.png')
        self.original = (self.source / 'image.png').read_bytes()
        self.image_id = self.state.set_root(str(self.source))[0]['id']
        self.spans = [value for row in range(3, 7) for value in (row, 3, 7)]

    def tearDown(self):
        for state in self.states:
            state.shutdown()
        self.temp.cleanup()

    def new_state(self):
        with patch.object(state_module, 'APP_DIR', self.app):
            state = StudioState(self.root / 'cache', self.root / 'session')
        self.states.append(state)
        return state

    @staticmethod
    def png(mask):
        with Image.fromarray(mask) as image, io.BytesIO() as out:
            image.save(out, format='PNG')
            return out.getvalue()

    def mask(self, points):
        mask = np.zeros((10, 12), dtype=np.uint8)
        for x, y in points:
            mask[y, x] = 255
        return mask

    def manual(self, **kwargs):
        payload = {key: '' for key in ('add', 'exclusion', 'exclusionErase')}
        payload.update(kwargs)
        self.state.save_manual_workspace(self.image_id, payload)

    def layer(self, key, state=None):
        draft = (state or self.state).manual_workspace(self.image_id) or {}
        raw = draft.get(key)
        if not raw:
            return self.mask([])
        with Image.open(io.BytesIO(base64.b64decode(raw.split(',')[1]))) as image:
            return np.asarray(image.getchannel('A') if image.mode == 'RGBA' else image).copy()

    def candidate(self, identifier, points, *, role=CandidateRole.APPLY, enabled=True, expand=0):
        path = self.state.cache_dir / self.image_id / (identifier + '.png')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.png(self.mask(points)))
        return Candidate(identifier, 'penis' if role == CandidateRole.APPLY else 'hand', .8, path,
                         role=role, enabled=enabled, expand_px=expand, color='#ff0000', forced=False)

    def candidates(self, values):
        with self.state.image_io_lock(self.image_id), self.state.lock:
            self.state._commit_candidate_snapshot(self.image_id, values, replace=True)

    def fill(self, role='apply', replace=False, **kwargs):
        payload = dict(role=role, spans=self.spans, replaceExisting=replace,
                       expectedRevision=self.state._candidate_revision(self.image_id),
                       expectedManualRevision=self.state.workspace_store.manual_revisions([self.image_id])[self.image_id])
        payload.update(kwargs)
        return self.state.fill_image_area(self.image_id, payload)

    def history_count(self):
        with self.state.workspace_store._connect() as db:
            return db.execute('SELECT COUNT(*) FROM history_entries WHERE image_id=?', (self.image_id,)).fetchone()[0]

    def test_additive_fill_preserves_other_masks_and_repeated_fill_is_noop(self):
        for role in ('apply', 'exclude'):
            with self.subTest(role=role):
                opposite = 'exclusion' if role == 'apply' else 'add'
                chosen = 'add' if role == 'apply' else 'exclusion'
                self.manual(**{opposite: 'data:image/png;base64,' + base64.b64encode(self.png(self.mask([(4, 4), (9, 8)]))).decode(),
                               'exclusionErase': 'data:image/png;base64,' + base64.b64encode(self.png(self.mask([(4, 4), (9, 8)]))).decode()})
                candidate = self.candidate('existing-' + role, [(4, 4), (9, 8)])
                self.candidates([candidate])
                before_count = self.history_count()
                response = self.fill(role)
                self.assertTrue(response['changed'])
                self.assertEqual(self.history_count(), before_count + 1)
                self.assertEqual(self.layer(chosen)[4, 4], 255)
                self.assertEqual(self.layer(opposite)[4, 4], 255)
                self.assertEqual(self.layer(opposite)[8, 9], 255)
                self.assertIs(self.state.candidates[self.image_id][0], candidate)
                self.assertEqual(self.layer('exclusionErase')[4, 4], 0 if role == 'exclude' else 255)
                self.assertEqual(self.layer('exclusionErase')[8, 9], 255)
                count = self.history_count()
                self.assertFalse(self.fill(role)['changed'])
                self.assertEqual(self.history_count(), count)
        self.assertEqual((self.source / 'image.png').read_bytes(), self.original)

    def test_replace_cuts_both_candidate_roles_and_manual_layers_one_undo_redo_restart(self):
        originals = [self.candidate('apply', [(4, 4), (9, 8)], enabled=False),
                     self.candidate('exclude', [(4, 4), (9, 8)], role=CandidateRole.EXCLUDE),
                     self.candidate('whole', [(4, 4)])]
        self.candidates(originals)
        encoded = 'data:image/png;base64,' + base64.b64encode(self.png(self.mask([(4, 4), (9, 8)]))).decode()
        self.manual(add=encoded, exclusion=encoded, exclusionErase=encoded,
                    removedCandidateIds=['apply'], manualExclusionForced=False)
        self.state.set_image_flags(self.image_id, {'reviewed': True})
        count = self.history_count()
        self.assertTrue(self.fill('exclude', True)['changed'])
        self.assertEqual(self.history_count(), count + 1)
        self.assertEqual(len(self.state.candidates[self.image_id]), 2)
        for old, new in zip(originals, self.state.candidates[self.image_id]):
            self.assertNotEqual(old.candidate_id, new.candidate_id)
            self.assertEqual((old.enabled, old.forced, old.color, old.role), (new.enabled, new.forced, new.color, new.role))
            with Image.open(new.mask_path) as image:
                self.assertEqual(image.getpixel((4, 4)), 0)
                self.assertEqual(image.getpixel((9, 8)), 255)
        after = [self.layer(key) for key in ('add', 'exclusion', 'exclusionErase')]
        self.assertEqual([int(mask[4, 4]) for mask in after], [0, 255, 0])
        self.assertEqual([int(mask[8, 9]) for mask in after], [255, 255, 255])
        new_removed = self.state.manual_workspace(self.image_id)['removedCandidateIds']
        self.assertEqual(new_removed, [self.state.candidates[self.image_id][0].candidate_id])
        self.state.restore_project_history(self.image_id, 'undo')
        self.assertEqual([c.candidate_id for c in self.state.candidates[self.image_id]], ['apply', 'exclude', 'whole'])
        self.assertEqual([int(self.layer(key)[4, 4]) for key in ('add', 'exclusion', 'exclusionErase')], [255, 255, 255])
        self.state.restore_project_history(self.image_id, 'redo')
        for key, expected in zip(('add', 'exclusion', 'exclusionErase'), after):
            np.testing.assert_array_equal(self.layer(key), expected)
        project_id = self.state.workspace_id
        restarted = self.new_state(); restarted.open_project(project_id)
        for key, expected in zip(('add', 'exclusion', 'exclusionErase'), after):
            np.testing.assert_array_equal(self.layer(key, restarted), expected)
        self.assertTrue(restarted.workspace_store.image_state(self.image_id)[1])
        self.assertFalse(restarted.manual_workspace(self.image_id)['manualExclusionForced'])
        self.assertEqual((self.source / 'image.png').read_bytes(), self.original)

    def test_expanded_candidate_is_cut_after_expansion_and_disabled_selected_layer_enables(self):
        candidate = self.candidate('expanded', [(2, 4)], expand=2)
        self.candidates([candidate])
        encoded = 'data:image/png;base64,' + base64.b64encode(self.png(self.mask([(9, 8)]))).decode()
        self.manual(add=encoded, manualEnabled=False, manualExclusionEnabled=False)
        self.fill('apply', True)
        result = self.state.candidates[self.image_id][0]
        self.assertEqual(result.expand_px, 0)
        with Image.open(result.mask_path) as image:
            self.assertEqual(image.getpixel((2, 4)), 255)
            self.assertEqual(image.getpixel((3, 4)), 0)
        draft = self.state.manual_workspace(self.image_id)
        self.assertTrue(draft['manualEnabled'])
        self.assertFalse(draft['manualExclusionEnabled'])
        self.assertEqual(self.layer('add')[8, 9], 255)

    def test_invalid_stale_and_transaction_failure_preserve_state_and_clean_files(self):
        self.candidates([self.candidate('old', [(4, 4), (9, 8)])])
        count = self.history_count(); before = self.state._candidate_revision(self.image_id)
        before_draft = self.state.manual_workspace(self.image_id)
        for kwargs in ({'expectedRevision': before - 1}, {'expectedManualRevision': 99},
                       {'spans': [0, 0, 13]}, {'spans': [True, 1, 2]}, {'replaceExisting': 1}, {'role': []}, {'spans': [1, 2]}, {'expectedRevision': True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ClientError):
                self.fill(**kwargs)
        files = set((self.state.cache_dir / self.image_id).glob('*.png'))
        # SQLite itself rejects the second write after candidate cuts are staged.
        with self.state.workspace_store._connect() as db:
            db.execute("CREATE TRIGGER reject_area_fill BEFORE INSERT ON manual_edits BEGIN SELECT RAISE(ABORT, 'disk write failed'); END")
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                self.fill(replace=True)
        finally:
            with self.state.workspace_store._connect() as db:
                db.execute("DROP TRIGGER reject_area_fill")
        self.assertEqual(set((self.state.cache_dir / self.image_id).glob('*.png')), files)
        self.assertEqual(self.state._candidate_revision(self.image_id), before)
        self.assertEqual(self.history_count(), count)
        self.assertEqual(self.state.manual_workspace(self.image_id), before_draft)
        self.assertEqual([c.candidate_id for c in self.state.candidates[self.image_id]], ['old'])
        self.assertTrue(self.fill(replace=True)['changed'])

    def test_http_area_fill_enforces_catalog_and_edit_revisions(self):
        server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), http_module.MosaicHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        origin = f"http://127.0.0.1:{server.server_port}"
        def request(payload):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request("POST", f"/api/images/{self.image_id}/area-fill", json.dumps(payload), {
                    "Content-Type": "application/json", "Origin": origin, "X-Mozarie-Token": self.state.session_token,
                })
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        payload = dict(role="apply", spans=self.spans, replaceExisting=False,
                       expectedRevision=0, expectedManualRevision=0,
                       expectedProjectId=self.state.workspace_id,
                       expectedCatalogGeneration=self.state.catalog_generation)
        try:
            with patch.object(http_module, "STATE", self.state):
                thread.start()
                status, response = request(payload)
                self.assertEqual(status, 200)
                self.assertTrue(response["changed"])
                self.assertEqual(self.layer("add")[4, 4], 255)
                count = self.history_count()
                status, response = request(payload)
                self.assertEqual(status, 400)
                self.assertEqual(response["error_code"], "manual_revision_conflict")
                status, response = request({**payload, "expectedManualRevision": 1,
                                            "expectedCatalogGeneration": self.state.catalog_generation - 1})
                self.assertEqual(status, 409)
                self.assertEqual(response["error_code"], "stale_catalog")
                self.assertEqual(self.history_count(), count)
        finally:
            server.shutdown(); server.server_close(); thread.join(5)

    def test_empty_region_noop_and_new_exclusion_uses_configured_forced_default(self):
        before = self.history_count()
        self.assertFalse(self.fill(spans=[])["changed"])
        self.assertEqual(self.history_count(), before)
        self.state.settings["detection"]["exclude_forced_default"] = False
        self.fill("exclude")
        self.assertFalse(self.state.manual_workspace(self.image_id)["manualExclusionForced"])
        self.assertFalse(self.state.manual_workspace(self.image_id)["hasEffectiveMask"])

    def test_repeated_replacement_reclaims_old_cache_and_history_restores_from_database(self):
        points = [(x, y) for y in range(10) for x in range(12)]
        original = self.candidate("whole-image", points)
        self.candidates([original])
        expected = self.mask(points)
        cache = self.state.cache_dir / self.image_id
        for column in range(8):
            spans = [value for row in range(10) for value in (row, column, column + 1)]
            self.fill(replace=True, spans=spans)
            expected[:, column] = 0
            live = self.state.candidates[self.image_id]
            self.assertEqual(set(cache.glob("*.png")), {candidate.mask_path for candidate in live})
            with Image.open(live[0].mask_path) as image:
                np.testing.assert_array_equal(np.asarray(image), expected)
        final_id = self.state.candidates[self.image_id][0].candidate_id
        for _ in range(8):
            self.state.restore_project_history(self.image_id, "undo")
        restored = self.state.candidates[self.image_id][0]
        self.assertEqual(restored.candidate_id, original.candidate_id)
        with Image.open(io.BytesIO(self.state.read_candidate_mask_png(self.image_id, restored.candidate_id))) as image:
            np.testing.assert_array_equal(np.asarray(image.getchannel("A")), self.mask(points))
        for _ in range(8):
            self.state.restore_project_history(self.image_id, "redo")
        self.assertEqual(self.state.candidates[self.image_id][0].candidate_id, final_id)
        project_id = self.state.workspace_id
        restarted = self.new_state(); restarted.open_project(project_id)
        with Image.open(io.BytesIO(restarted.read_candidate_mask_png(self.image_id, final_id))) as image:
            np.testing.assert_array_equal(np.asarray(image.getchannel("A")), expected)
        self.assertTrue(np.all(self.layer("add", restarted)[:, :8] == 255))
        self.assertTrue(np.all(self.layer("add", restarted)[:, 8:] == 0))
        self.assertEqual((self.source / "image.png").read_bytes(), self.original)
