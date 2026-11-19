"""Region edits shared by enclosed-area bucket and freehand area tools."""
from __future__ import annotations

import base64
import io
import uuid
from dataclasses import replace
from typing import Any

import numpy as np
from PIL import Image

from .core import ClientError
from .image_io import mask_alpha_or_luma, open_image
from .masks import expand_mask


def _mask_png(mask: np.ndarray) -> bytes:
    with Image.fromarray(mask) as image, io.BytesIO() as output:
        image.save(output, format="PNG")
        return output.getvalue()


def _read_mask(raw: bytes | None, size: tuple[int, int]) -> np.ndarray:
    if not raw:
        return np.zeros((size[1], size[0]), dtype=np.uint8)
    with open_image(io.BytesIO(raw)) as image:
        return mask_alpha_or_luma(image).copy()


class AreaFillMixin:
    def fill_image_area(self, image_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        role = payload.get("role")
        overwrite = payload.get("replaceExisting")
        spans = payload.get("spans")
        expected = payload.get("expectedRevision")
        expected_manual = payload.get("expectedManualRevision")
        if (not isinstance(role, str) or role not in {"apply", "exclude"} or not isinstance(overwrite, bool)
                or not isinstance(spans, list) or len(spans) % 3
                or any(type(value) is not int for value in spans)
                or type(expected) is not int or expected < 0
                or type(expected_manual) is not int or expected_manual < 0):
            raise ClientError("塗りつぶし範囲が正しくありません。", "input_invalid")
        with self.image_io_lock(image_id):
            with self.lock:
                self._assert_request_catalog_expectation()
                self._assert_image_editable(image_id)
                record = self.images[image_id]
                revision = self._candidate_revision(image_id)
                manual_revision = self.workspace_store.manual_revisions([image_id])[image_id]
                if revision != expected:
                    raise ClientError("検出候補が変更されました。", "candidate_revision_conflict")
                if manual_revision != expected_manual:
                    raise ClientError("手描きの編集内容が変更されました。", "manual_revision_conflict")
                candidates = list(self.candidates.get(image_id, []))
            for row, left, right in zip(spans[::3], spans[1::3], spans[2::3]):
                if row < 0 or row >= record.height or left < 0 or right > record.width or left >= right:
                    raise ClientError("塗りつぶし範囲が正しくありません。", "input_invalid")
            if not spans:
                return {"ok": True, "changed": False, "candidateRevision": revision, "manualRevision": manual_revision}
            region = np.zeros((record.height, record.width), dtype=bool)
            for row, left, right in zip(spans[::3], spans[1::3], spans[2::3]):
                region[row, left:right] = True
            draft = self.workspace_store.manual(image_id, self._encode_workspace_mask) or {}
            committed = dict(draft)
            committed.setdefault("manualExclusionForced", self.settings["detection"].get("exclude_forced_default", True))
            changed = False
            layers = {}
            for key in ("add", "exclusion", "exclusionErase"):
                raw = self._decode_workspace_mask(draft.get(key))
                mask = _read_mask(raw, (record.width, record.height))
                previous = mask[region].copy()
                if overwrite or (role == "exclude" and key == "exclusionErase"):
                    mask[region] = 0
                if key == ("add" if role == "apply" else "exclusion"):
                    mask[region] = 255
                layer_changed = not np.array_equal(previous, mask[region])
                changed |= layer_changed
                layers[key] = "data:image/png;base64," + base64.b64encode(_mask_png(mask)).decode("ascii") if layer_changed else draft.get(key, "")
            chosen_flag = "manualEnabled" if role == "apply" else "manualExclusionEnabled"
            if committed.get(chosen_flag) is False:
                changed = True
            committed[chosen_flag] = True
            committed.update(layers)
            removed = set(draft.get("removedCandidateIds", []))
            staged = []
            result = []
            try:
                for candidate in candidates:
                    if not overwrite:
                        result.append(candidate)
                        continue
                    raw = (candidate.mask_path.read_bytes() if candidate.mask_path.is_file()
                           else self.workspace_store.candidate_png(image_id, candidate.candidate_id))
                    if raw is None:
                        raise FileNotFoundError(candidate.mask_path)
                    mask = _read_mask(raw, (record.width, record.height))
                    if candidate.expand_px:
                        mask = expand_mask(mask, candidate.expand_px)
                    if not np.any(mask[region]):
                        result.append(candidate)
                        continue
                    changed = True
                    mask[region] = 0
                    if not np.any(mask):
                        removed.discard(candidate.candidate_id)
                        continue
                    identifier = uuid.uuid4().hex
                    path = self.cache_dir / image_id / f"{identifier}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    staged.append(path)
                    path.write_bytes(_mask_png(mask))
                    result.append(replace(candidate, candidate_id=identifier, mask_path=path, expand_px=0))
                    if candidate.candidate_id in removed:
                        removed.remove(candidate.candidate_id)
                        removed.add(identifier)
                if not changed:
                    return {"ok": True, "changed": False, "candidateRevision": revision, "manualRevision": manual_revision}
                committed["removedCandidateIds"] = sorted(removed)
                committed["expectedManualRevision"] = expected_manual
                committed["hasEffectiveMask"] = self._effective_mask_for_draft(image_id, result, committed)
                candidate_revision = revision + int(any(a is not b for a, b in zip(candidates, result)) or len(result) != len(candidates))
                with self.lock:
                    self._assert_request_catalog_expectation()
                    self._assert_image_editable(image_id)
                    if self.images.get(image_id) is not record or self._candidate_revision(image_id) != revision:
                        raise ClientError("画像一覧が変更されました。", "stale_catalog")
                    manual_revision = self.workspace_store.save_area_fill(
                        image_id, result, candidate_revision, revision, committed, self._decode_workspace_mask)
                    self.candidates[image_id] = result
                    self.candidate_revisions[image_id] = candidate_revision
                staged.clear()
                current_paths = {candidate.mask_path for candidate in result}
                self._delete_mask_files([candidate.mask_path for candidate in candidates
                                         if candidate.mask_path not in current_paths], [])
                return {"ok": True, "changed": True, "candidateRevision": candidate_revision, "manualRevision": manual_revision}
            finally:
                for path in staged:
                    path.unlink(missing_ok=True)
