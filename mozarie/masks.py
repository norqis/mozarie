"""Mask composition helpers used by preview and file save paths."""

from __future__ import annotations

import numpy as np
import cv2


def union_mask(target: np.ndarray, mask: np.ndarray) -> None:
    """Add non-zero mask pixels to an existing uint8 union in place."""
    np.maximum(target, np.asarray(mask > 0, dtype=np.uint8) * 255, out=target)


def expand_mask(mask: np.ndarray, expand_px: int) -> np.ndarray:
    """Expand a binary candidate mask in source-image pixels."""
    limit = int(np.ceil(np.hypot(mask.shape[0] - 1, mask.shape[1] - 1)))
    if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0 or expand_px > limit:
        raise ValueError("candidate expand pixels are invalid")
    binary = np.asarray(mask > 0, dtype=np.uint8) * 255
    if expand_px == 0:
        return binary
    if not np.any(binary):
        return binary
    # No source pixel can be farther than the image diagonal from a foreground
    # pixel. Avoid even the distance-map allocation once the result is known.
    if expand_px >= int(np.ceil(np.hypot(mask.shape[0] - 1, mask.shape[1] - 1))):
        return np.full(mask.shape, 255, dtype=np.uint8)
    # Small radii retain the exact OpenCV ellipse users already have.  A large
    # structuring-element matrix grows quadratically, though, so switch to a
    # per-pixel distance transform before allocating an enormous kernel.
    if expand_px <= 128:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand_px * 2 + 1, expand_px * 2 + 1))
        return cv2.dilate(binary, kernel)
    distance = cv2.distanceTransform(255 - binary, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    return np.where(distance <= expand_px, 255, 0).astype(np.uint8)


def compose_masks(
    shape: tuple[int, int],
    apply_masks: list[np.ndarray],
    exclude_masks: list[np.ndarray],
    manual_add: np.ndarray | None = None,
    manual_exclude: np.ndarray | None = None,
    forced_exclude_masks: list[np.ndarray] | None = None,
    manual_exclude_forced: bool = True,
    exclusion_erase: np.ndarray | None = None,
) -> np.ndarray:
    """Compose automatic masks, allowing explicit removal of exclusion pixels."""

    result = np.zeros(shape, dtype=np.uint8)
    for mask in apply_masks:
        if mask.shape != shape:
            raise ValueError("apply mask dimensions do not match the source image")
        union_mask(result, mask)
    exclusions = np.zeros(shape, dtype=np.uint8)
    for mask in exclude_masks:
        if mask.shape != shape:
            raise ValueError("exclude mask dimensions do not match the source image")
        union_mask(exclusions, mask)
    if manual_exclude is not None:
        if manual_exclude.shape != shape:
            raise ValueError("manual exclude mask dimensions do not match the source image")
        union_mask(exclusions, manual_exclude)
    if exclusion_erase is not None:
        if exclusion_erase.shape != shape:
            raise ValueError("exclusion erase mask dimensions do not match the source image")
        exclusions[np.asarray(exclusion_erase) > 0] = 0
    result[exclusions > 0] = 0
    if manual_add is not None:
        if manual_add.shape != shape:
            raise ValueError("manual add mask dimensions do not match the source image")
        union_mask(result, manual_add)
    forced_exclusions = np.zeros(shape, dtype=np.uint8)
    for mask in forced_exclude_masks or []:
        if mask.shape != shape:
            raise ValueError("forced exclude mask dimensions do not match the source image")
        union_mask(forced_exclusions, mask)
    if manual_exclude is not None and manual_exclude_forced:
        union_mask(forced_exclusions, manual_exclude)
    if exclusion_erase is not None:
        forced_exclusions[np.asarray(exclusion_erase) > 0] = 0
    result[forced_exclusions > 0] = 0
    return result
