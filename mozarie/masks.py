"""Mask composition helpers used by preview and file save paths."""

from __future__ import annotations

import numpy as np
import cv2


def expand_mask(mask: np.ndarray, expand_px: int) -> np.ndarray:
    """Expand a binary candidate mask in source-image pixels."""
    if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0:
        raise ValueError("candidate expand pixels are invalid")
    binary = np.asarray(mask > 0, dtype=np.uint8) * 255
    if expand_px == 0:
        return binary
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand_px * 2 + 1, expand_px * 2 + 1))
    return cv2.dilate(binary, kernel)


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
        result = np.maximum(result, np.asarray(mask > 0, dtype=np.uint8) * 255)
    exclusions = np.zeros(shape, dtype=np.uint8)
    for mask in exclude_masks:
        if mask.shape != shape:
            raise ValueError("exclude mask dimensions do not match the source image")
        exclusions = np.maximum(exclusions, np.asarray(mask > 0, dtype=np.uint8) * 255)
    if manual_exclude is not None:
        if manual_exclude.shape != shape:
            raise ValueError("manual exclude mask dimensions do not match the source image")
        exclusions = np.maximum(exclusions, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)
    if exclusion_erase is not None:
        if exclusion_erase.shape != shape:
            raise ValueError("exclusion erase mask dimensions do not match the source image")
        exclusions[np.asarray(exclusion_erase) > 0] = 0
    result[exclusions > 0] = 0
    if manual_add is not None:
        if manual_add.shape != shape:
            raise ValueError("manual add mask dimensions do not match the source image")
        result = np.maximum(result, np.asarray(manual_add > 0, dtype=np.uint8) * 255)
    forced_exclusions = np.zeros(shape, dtype=np.uint8)
    for mask in forced_exclude_masks or []:
        if mask.shape != shape:
            raise ValueError("forced exclude mask dimensions do not match the source image")
        forced_exclusions = np.maximum(forced_exclusions, np.asarray(mask > 0, dtype=np.uint8) * 255)
    if manual_exclude is not None and manual_exclude_forced:
        forced_exclusions = np.maximum(forced_exclusions, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)
    if exclusion_erase is not None:
        forced_exclusions[np.asarray(exclusion_erase) > 0] = 0
    result[forced_exclusions > 0] = 0
    return result
