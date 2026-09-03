function canvasSizeForImage(image) {
  releaseMosaicPreview();
  for (const target of [addCanvas, exclusionCanvas, exclusionEraseCanvas, effectiveExclusionCanvas, combinedCanvas, mosaicCanvas]) { target.width = image.width; target.height = image.height; }
  releaseHistoryCanvases();
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
  exclusionEraseCtx.clearRect(0, 0, image.width, image.height);
  state.maskDirty = true;
  state.draftDirty = false;
  state.draftLayerDirty.clear();
  state.historyBaseDirty = false;
  state.manualMaskPresent = false;
  state.manualEnabled = true;
  state.manualExclusionEnabled = true;
  state.manualExclusionEraseEnabled = true;
}

function ensureHistoryCanvases() {
  if (!state.currentImage) return;
  for (const target of [historyAddCanvas, historyExclusionCanvas, historyExclusionEraseCanvas]) {
    if (target.width !== state.currentImage.width || target.height !== state.currentImage.height) { target.width = state.currentImage.width; target.height = state.currentImage.height; }
  }
}
function releaseHistoryCanvases() {
  for (const target of [historyAddCanvas, historyExclusionCanvas, historyExclusionEraseCanvas]) { target.width = 1; target.height = 1; }
}
function clearEditor() {
  closeBoundaryModeMenu({ restoreFocus: true });
  cancelFillWork();
  releaseMosaicPreview();
  state.history = []; state.historyIndex = 0; state.activeStroke = null; state.hover = null; clearBoundaryInteraction();
  state.manualMaskPresent = false; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
  state.maskDirty = false;
  state.draftDirty = false;
  state.draftLayerDirty.clear();
  state.historyBaseDirty = false;
  addCanvas.width = exclusionCanvas.width = exclusionEraseCanvas.width = effectiveExclusionCanvas.width = combinedCanvas.width = mosaicCanvas.width = originalCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = exclusionEraseCanvas.height = effectiveExclusionCanvas.height = combinedCanvas.height = mosaicCanvas.height = originalCanvas.height = 1;
  releaseHistoryCanvases();
  $("#emptyState").hidden = false;
  $("#currentFileName").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons(); render(); updateBrushCursor();
}

async function selectImage(imageId, force = false, { saveCurrentDraft = true } = {}) {
  if ((isBusy() || state.importing || isGestureActive() || state.candidateBatchPending.size) && !force) return;
  if (state.currentId === imageId && !force && state.pendingImageId !== imageId) return;
  if (saveCurrentDraft) void saveDraft();
  state.hover = null; updateBrushCursor();
  const generation = ++state.imageGeneration;
  state.pendingImageId = imageId;
  const record = state.images.find((image) => image.id === imageId);
  if (!record) {
    state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
    return;
  }
  state.pendingImageKey = imageCacheKey(record);
  state.pendingCandidateKey = candidateCacheKey(imageId, Number(record.candidateRevision || 0));
  const imageCached = state.imageCache.has(imageCacheKey(record));
  const candidatesCached = state.candidateBundleCache.has(candidateCacheKey(imageId, Number(record.candidateRevision || 0)));
  if (!imageCached || !candidatesCached) { clearTimeout(state.loadingDelay); state.loadingDelay = null; }
  try {
    const [image, candidateBundle] = await Promise.all([
      cachedImage(record),
      loadCandidateBundle(imageId, generation),
    ]);
    if (!isCurrentGeneration(generation)) return;
    // A tab-local draft is newer than the compact server copy. Otherwise the
    // workspace request and all draft image decodes must finish before the
    // current editor is touched.
    const hasDraft = state.drafts.has(imageId);
    const draft = hasDraft ? state.drafts.get(imageId) : await loadWorkspaceDraft(imageId);
    const draftImages = await decodeDraftImages(draft);
    if (!isCurrentGeneration(generation)) return;
    if (!hasDraft) {
      if (draft) state.drafts.set(imageId, draft); else state.drafts.delete(imageId);
    }
    clearTimeout(state.loadingDelay); state.loadingDelay = null;
    syncCandidateRecord(imageId, candidateBundle.candidates);
    releaseStaleImageVersions(imageId, imageCacheKey(record), candidateCacheKey(imageId, candidateBundle.candidateRevision));
    closeBoundaryModeMenu();
    clearBoundaryInteraction();
    cancelFillWork();
    abortCatalogLoads();
    state.currentId = imageId;
    state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
    state.currentImage = image;
    state.candidates = candidateBundle.candidates;
    state.candidateImages = candidateBundle.candidateImages;
    state.imageCache.trim(); state.candidateBundleCache.trim();
    canvasSizeForImage(record); await restoreDraft(imageId, generation, draft, draftImages); prepareOriginalImage(); requestMosaicPreview(); fitImage();
    updateBlockSizeDisplay(); refreshMaskStatus();
    $("#emptyState").hidden = true;
    $("#currentFileName").textContent = record.relativePath;
    updateCandidateStatus();
    renderCandidates(); updateGalleryCurrent(); updateNavigationControls(); updateActionButtons(); render(); clearStatus();
    if (state.project?.id) void refreshProjectHistory(imageId);
    prefetchNeighbors(record);
  } catch (error) {
    if (isCurrentGeneration(generation)) {
      clearTimeout(state.loadingDelay); state.loadingDelay = null;
      state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
      if (error.code === "stale_asset") invalidateStaleAsset(imageId);
      showUserError(error);
    }
  }
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(codedError("image_read_failed")); image.src = source;
  });
}

function imageAssetVersion(record) { return typeof record?.assetVersion === "string" ? record.assetVersion : ""; }
function invalidateStaleAsset(imageId) {
  abortCatalogLoads();
  const bitmaps = new Set();
  for (const [key] of [...state.imageCache.items]) if (key.startsWith(`${imageId}:`)) bitmaps.add(state.imageCache.take(key));
  for (const [key] of [...state.candidateBundleCache.items]) {
    if (!key.startsWith(`${imageId}:`)) continue;
    for (const bitmap of state.candidateBundleCache.take(key)?.candidateImages?.values() || []) bitmaps.add(bitmap);
  }
  const gallery = state.galleryNodes.get(imageId)?.querySelector("img");
  const overview = state.overviewNodes.get(imageId)?.querySelector("img");
  forgetThumbnail(gallery); forgetThumbnail(overview);
  if (state.currentId === imageId) {
    bitmaps.add(state.currentImage);
    for (const bitmap of state.candidateImages.values()) bitmaps.add(bitmap);
  }
  for (const bitmap of bitmaps) closeBitmap(bitmap);
  if (state.currentId !== imageId) return;
  closeBoundaryModeMenu({ restoreFocus: true });
  state.currentId = null; state.currentImage = null; state.candidates = []; state.candidateImages = new Map();
  clearEditor(); updateGalleryCurrent();
}
function imageCacheKey(record) { return `${record.id}:${imageAssetVersion(record)}`; }
function candidateCacheKey(imageId, revision) { return `${imageId}:${revision}`; }

async function cachedImage(record) {
  const key = imageCacheKey(record);
  const epoch = state.catalogEpoch; const version = imageAssetVersion(record);
  const cached = state.imageCache.get(key);
  if (cached) return cached;
  const pending = state.imageInflight.get(key);
  if (pending) return pending;
  const controller = new AbortController(); state.catalogLoadControllers.add(controller);
  let request;
  request = fetchBitmap(imageUrl(record), controller.signal).then((image) => {
    if (controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) { image.close?.(); throw new DOMException("stale catalog", "AbortError"); }
    return state.imageCache.set(key, image, decodedImageWeight(image));
  }).finally(() => { if (state.imageInflight.get(key) === request) state.imageInflight.delete(key); });
  request.finally(() => state.catalogLoadControllers.delete(controller)).catch(() => {});
  state.imageInflight.set(key, request);
  return request;
}

function prefetchNeighbors(record) {
  const index = state.images.findIndex((item) => item.id === record.id);
  for (const neighbor of [state.images[index - 1], state.images[index + 1]]) {
    if (!neighbor) continue;
    schedulePrefetch(neighbor, 1);
  }
}

function releaseImageCaches(imageId = null) {
  const matches = (key) => !imageId || key.startsWith(`${imageId}:`);
  for (const [key] of state.imageCache.items) {
    if (!matches(key)) continue;
    state.imageCache.delete(key);
  }
  for (const [key] of state.candidateBundleCache.items) {
    if (!matches(key)) continue;
    state.candidateBundleCache.delete(key);
  }
  for (const key of state.imageInflight.keys()) if (matches(key)) state.imageInflight.delete(key);
  for (const key of state.candidateInflight.keys()) if (matches(key)) state.candidateInflight.delete(key);
}

function releaseStaleImageVersions(imageId, imageKey, candidateKey) {
  for (const [key] of state.imageCache.items) if (key.startsWith(`${imageId}:`) && key !== imageKey) state.imageCache.delete(key);
  for (const [key] of state.candidateBundleCache.items) if (key.startsWith(`${imageId}:`) && key !== candidateKey) state.candidateBundleCache.delete(key);
}

function releaseCandidateBundles(imageId) {
  for (const [key] of state.candidateBundleCache.items) if (key.startsWith(`${imageId}:`)) state.candidateBundleCache.delete(key);
  for (const key of state.candidateInflight.keys()) if (key.startsWith(`${imageId}:`)) state.candidateInflight.delete(key);
  if (state.currentId === imageId) state.candidateImages = new Map();
}

function releaseCandidateBitmap(candidateId) {
  const image = state.candidateImages.get(candidateId);
  if (image) closeBitmap(image);
  state.candidateImages.delete(candidateId);
}

function invalidateCandidateBundles(imageId) {
  for (const [key, entry] of state.candidateBundleCache.items) {
    const bundle = entry.value;
    if (!key.startsWith(`${imageId}:`)) continue;
    if (bundle.candidateImages === state.candidateImages) continue;
    state.candidateBundleCache.delete(key);
  }
}

function retainCurrentCandidateBundle(imageId, revision) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  if (state.currentId !== imageId) { record.candidateRevision = Number(revision || 0); return; }
  const oldKey = candidateCacheKey(imageId, Number(record.candidateRevision || 0));
  const reusable = state.candidateBundleCache.take(oldKey);
  record.candidateRevision = Number(revision || 0);
  if (!reusable) return;
  reusable.candidates = state.candidates;
  reusable.candidateImages = state.candidateImages;
  reusable.candidateRevision = record.candidateRevision;
  state.candidateBundleCache.set(candidateCacheKey(imageId, record.candidateRevision), reusable, [...reusable.candidateImages.values()].reduce((total, image) => total + decodedImageWeight(image), 0));
}

async function loadCandidateBundle(imageId, generation, reconciled = false) {
  const record = state.images.find((image) => image.id === imageId);
  const epoch = state.catalogEpoch;
  const version = imageAssetVersion(record);
  const knownRevision = Number(record?.candidateRevision || 0);
  const knownKey = candidateCacheKey(imageId, knownRevision);
  const pending = state.candidateInflight.get(knownKey);
  if (pending) return pending;
  let request;
  request = (async () => {
    const controller = new AbortController(); state.catalogLoadControllers.add(controller);
    let candidateImages;
    try {
      const candidateData = await api(`/api/candidates/${encodeURIComponent(imageId)}`, { signal: controller.signal });
      if (!Array.isArray(candidateData.candidates) || !candidateData.candidates.every((candidate) => typeof candidate?.id === "string" && validCandidateTokens(candidate)) || !Number.isInteger(candidateData.candidateRevision)) {
        throw codedError("response_invalid");
      }
      if (controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) throw new DOMException("stale catalog", "AbortError");
      const revision = Number(candidateData.candidateRevision);
      const cacheKey = candidateCacheKey(imageId, revision);
      if (state.pendingImageId === imageId) state.pendingCandidateKey = cacheKey;
      const cached = state.candidateBundleCache.get(cacheKey);
      if (cached) { record.candidateRevision = revision; return cached; }
      candidateImages = new Map();
      const pendingCandidates = [...candidateData.candidates];
      const workers = Array.from({ length: Math.min(4, pendingCandidates.length) }, async () => {
        while (pendingCandidates.length) {
          const candidate = pendingCandidates.shift();
          try { candidateImages.set(candidate.id, await fetchBitmap(maskUrl(imageId, candidate.id, revision), controller.signal)); }
          catch (error) { controller.abort(); throw error; }
        }
      });
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      if (controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) throw new DOMException("stale catalog", "AbortError");
      record.candidateRevision = revision;
      const bundle = { candidates: candidateData.candidates, candidateImages, candidateRevision: revision };
      const weight = [...candidateImages.values()].reduce((total, image) => total + decodedImageWeight(image), 0);
      candidateImages = null;
      return state.candidateBundleCache.set(cacheKey, bundle, weight);
    } catch (error) {
      if (candidateImages) releaseCandidateBitmapBundle({ candidateImages });
      if (error.status === 404 && !reconciled && isCurrentGeneration(generation)) {
        state.candidateInflight.delete(knownKey);
        return loadCandidateBundle(imageId, generation, true);
      }
      throw error;
    } finally { state.catalogLoadControllers.delete(controller); }
  })().finally(() => {
    if (state.candidateInflight.get(knownKey) === request) state.candidateInflight.delete(knownKey);
    state.imageCache.trim(); state.candidateBundleCache.trim();
  });
  state.candidateInflight.set(knownKey, request);
  return request;
}

async function reconcileCurrentCandidates(imageId, generation) {
  const bundle = await loadCandidateBundle(imageId, generation);
  if (state.currentId !== imageId || !isCurrentGeneration(generation)) return false;
  state.candidates = bundle.candidates;
  state.candidateImages = bundle.candidateImages;
  const record = state.images.find((image) => image.id === imageId);
  if (record) {
    const visible = bundle.candidates.filter((candidate) => !state.removedCandidateIds.has(candidate.id));
    record.candidateCount = visible.length;
    record.enabledCandidateCount = visible.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
    record.candidateRevision = bundle.candidateRevision;
  }
  invalidateCandidateBundles(imageId);
  markMaskDirty();
  refreshMaskStatus(true); updateCandidateStatus(); requestMosaicPreview(); renderCandidates(); render();
  return true;
}


function canvasHasPixels(context, target) {
  const pixels = context.getImageData(0, 0, target.width, target.height).data;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
  return false;
}

function syncCandidateRecord(imageId, candidates) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  const visible = candidates.filter((candidate) => !state.removedCandidateIds.has(candidate.id));
  record.candidateCount = visible.length;
  record.enabledCandidateCount = visible.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
}

function syncCurrentCandidateRecord() { syncCandidateRecord(state.currentId, state.candidates); }

function syncStoredMaskStatus(imageId, candidates) {
  const draft = state.drafts.get(imageId);
  if (!draft) return;
  const record = state.images.find((image) => image.id === imageId);
  if (draft.hasEffectiveMask === true || Number(draft.candidateRevision || 0) === Number(record?.candidateRevision || 0)) {
    state.maskStatus.set(imageId, draft.hasEffectiveMask === true);
  } else {
    state.maskStatus.delete(imageId);
  }
}

async function refreshCandidateRecord(imageId, syncMask = false) {
  const data = await api(`/api/candidates/${encodeURIComponent(imageId)}`);
  syncCandidateRecord(imageId, data.candidates);
  if (syncMask) syncStoredMaskStatus(imageId, data.candidates);
  return data.candidates;
}

function updateCandidateStatus() {
  const status = $("#candidateStatus");
  if (!state.currentId) { status.textContent = t("candidates.unselected"); return; }
  const visibleCount = state.candidates.filter((candidate) => !state.removedCandidateIds.has(candidate.id)).length;
  if (state.manualMaskPresent) {
    status.textContent = visibleCount
      ? t("candidates.countWithManual", { count: visibleCount })
      : t("candidates.manualOnly");
    return;
  }
  status.textContent = visibleCount ? t("candidates.count", { count: visibleCount }) : t("candidates.none");
}

function canvasToDataUrl(target) {
  return new Promise((resolve, reject) => target.toBlob((blob) => {
    if (!blob) return reject(codedError("internal_error"));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(codedError("internal_error"));
    reader.readAsDataURL(blob);
  }, "image/png"));
}

async function decodeDraftImages(draft) {
  if (!draft) return [null, null, null, null, null, null];
  return Promise.all([draft.add, draft.exclusion, draft.exclusionErase, draft.historyBase?.add, draft.historyBase?.exclusion, draft.historyBase?.exclusionErase]
    .map((source) => source ? loadImage(source) : null));
}

async function saveDraft() {
  if (!state.currentId || !state.currentImage || !state.draftDirty) return;
  const imageId = state.currentId;
  const dirtyLayers = new Set(state.draftLayerDirty);
  const historyBaseDirty = state.historyBaseDirty;
  const snapshot = {
    manualEnabled: state.manualEnabled, manualExclusionEnabled: state.manualExclusionEnabled, manualExclusionEraseEnabled: state.manualExclusionEraseEnabled,
    manualMaskPresent: state.manualMaskPresent, manualExclusionForced: state.manualExclusionForced,
    candidateRevision: Number(currentRecord()?.candidateRevision || 0), removedCandidateIds: [...state.removedCandidateIds],
    history: state.history.map((stroke) => ({ ...stroke, points: stroke.points?.map((point) => ({ ...point })), spans: stroke.spans ? [...stroke.spans] : undefined })),
    historyIndex: state.historyIndex, historyRemovedCandidateIds: [...(state.historyRemovedCandidateIds || [])], historyCandidateIds: [...(state.historyCandidateIds || [])],
    hasEffectiveMask: hasEffectiveMask(), defaultManualExclusionForced: state.settings?.detection?.exclude_forced_default !== false,
  };
  state.draftDirty = false;
  state.draftLayerDirty.clear();
  state.historyBaseDirty = false;
  flushMaskComposition();
  const layers = {
    add: [addCtx, addCanvas], exclusion: [exclusionCtx, exclusionCanvas], exclusionErase: [exclusionEraseCtx, exclusionEraseCanvas],
  };
  const encoded = {};
  const encodedHistoryBase = {};
  const snapshots = [];
  for (const layer of dirtyLayers) {
    const [context, target] = layers[layer] || [];
    if (!target) continue;
    snapshots.push(Promise.resolve(canvasHasPixels(context, target) ? canvasToDataUrl(target) : "").then((value) => { encoded[layer] = value; }));
  }
  if (historyBaseDirty) {
    for (const [layer, context, target] of [["add", historyAddCanvas.getContext("2d"), historyAddCanvas], ["exclusion", historyExclusionCanvas.getContext("2d"), historyExclusionCanvas], ["exclusionErase", historyExclusionEraseCanvas.getContext("2d"), historyExclusionEraseCanvas]]) {
      snapshots.push(Promise.resolve(canvasHasPixels(context, target) ? canvasToDataUrl(target) : "").then((value) => { encodedHistoryBase[layer] = value; }));
    }
  }
  const previousSave = state.draftSaveChains.get(imageId) || Promise.resolve();
  const save = previousSave.catch(() => {}).then(async () => {
    await Promise.all(snapshots);
    const previous = state.drafts.get(imageId) || {};
    const hasAdd = encoded.add ?? previous.add ?? "";
    const hasExclusion = encoded.exclusion ?? previous.exclusion ?? "";
    const hasExclusionErase = encoded.exclusionErase ?? previous.exclusionErase ?? "";
    if (!hasAdd && !hasExclusion && !hasExclusionErase && snapshot.history.length === 0 && snapshot.removedCandidateIds.length === 0 && snapshot.manualExclusionForced === snapshot.defaultManualExclusionForced) {
      state.drafts.delete(imageId);
      void queueWorkspaceDraft(imageId);
      return;
    }
    state.drafts.set(imageId, {
      ...previous,
      add: hasAdd,
      exclusion: hasExclusion,
      exclusionErase: hasExclusionErase,
      manualEnabled: snapshot.manualEnabled, manualExclusionEnabled: snapshot.manualExclusionEnabled, manualExclusionEraseEnabled: snapshot.manualExclusionEraseEnabled, manualMaskPresent: snapshot.manualMaskPresent,
      manualExclusionForced: snapshot.manualExclusionForced,
      candidateRevision: snapshot.candidateRevision,
      hasEffectiveMask: snapshot.hasEffectiveMask,
      removedCandidateIds: snapshot.removedCandidateIds,
      history: snapshot.history,
      historyIndex: snapshot.historyIndex,
      historyBase: {
        ...previous.historyBase,
        add: encodedHistoryBase.add ?? previous.historyBase?.add ?? "",
        exclusion: encodedHistoryBase.exclusion ?? previous.historyBase?.exclusion ?? "",
        exclusionErase: encodedHistoryBase.exclusionErase ?? previous.historyBase?.exclusionErase ?? "",
        removedCandidateIds: snapshot.historyRemovedCandidateIds,
        candidateIds: snapshot.historyCandidateIds,
      },
    });
    void queueWorkspaceDraft(imageId);
  });
  state.draftSaveChains.set(imageId, save);
  save.finally(() => { if (state.draftSaveChains.get(imageId) === save) state.draftSaveChains.delete(imageId); }).catch(() => {});
  return save;
}

async function restoreDraft(imageId, generation, draft = state.drafts.get(imageId), decodedImages = null) {
  const images = decodedImages || await decodeDraftImages(draft);
  if (state.currentId !== imageId || state.imageGeneration !== generation) return false;
  state.history = []; state.historyIndex = 0; state.activeStroke = null;
  state.manualEnabled = draft?.manualEnabled !== false;
  state.manualExclusionEnabled = draft?.manualExclusionEnabled !== false;
  state.manualExclusionEraseEnabled = draft?.manualExclusionEraseEnabled !== false;
  state.manualExclusionForced = draft?.manualExclusionForced ?? (state.settings?.detection?.exclude_forced_default !== false);
  state.manualMaskPresent = false;
  const candidateRevisionMatches = !draft || Number(draft.candidateRevision) === Number(currentRecord()?.candidateRevision || 0);
  const currentCandidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  // A new auto-detection revision replaces candidate IDs.  Keep removals for
  // IDs that still exist, rather than restoring a deleted boundary candidate.
  const retainedRemovedIds = (draft?.removedCandidateIds || []).filter((id) => currentCandidateIds.has(id));
  state.removedCandidateIds = new Set(retainedRemovedIds);
  if (!draft) { resetHistoryToCurrentManualMask(); updateCandidateStatus(); renderCandidates(); return true; }
  const [addImage, exclusionImage, exclusionEraseImage, historyAddImage, historyExclusionImage, historyExclusionEraseImage] = images;
    if (addImage) addCtx.drawImage(addImage, 0, 0);
    if (exclusionImage) exclusionCtx.drawImage(exclusionImage, 0, 0);
    if (exclusionEraseImage) exclusionEraseCtx.drawImage(exclusionEraseImage, 0, 0);
    state.manualMaskPresent = draft.manualMaskPresent ?? canvasHasPixels(addCtx, addCanvas);
    if (Array.isArray(draft.history) && draft.historyBase) {
      ensureHistoryCanvases();
      historyAddCanvas.getContext("2d").clearRect(0, 0, historyAddCanvas.width, historyAddCanvas.height);
      historyExclusionCanvas.getContext("2d").clearRect(0, 0, historyExclusionCanvas.width, historyExclusionCanvas.height);
      historyExclusionEraseCanvas.getContext("2d").clearRect(0, 0, historyExclusionEraseCanvas.width, historyExclusionEraseCanvas.height);
      if (historyAddImage) historyAddCanvas.getContext("2d").drawImage(historyAddImage, 0, 0);
      if (historyExclusionImage) historyExclusionCanvas.getContext("2d").drawImage(historyExclusionImage, 0, 0);
      if (historyExclusionEraseImage) historyExclusionEraseCanvas.getContext("2d").drawImage(historyExclusionEraseImage, 0, 0);
      const originalHistory = draft.history.map((stroke) => ({ ...stroke, points: stroke.points?.map((point) => ({ ...point })), spans: stroke.spans ? [...stroke.spans] : undefined }));
      const candidateOperation = (stroke) => ["removeCandidates", "restoreCandidates", "addCandidates"].includes(stroke.kind);
      state.history = candidateRevisionMatches ? originalHistory : originalHistory.filter((stroke) => !candidateOperation(stroke));
      state.historyRemovedCandidateIds = new Set(candidateRevisionMatches
        ? (draft.historyBase.removedCandidateIds || []).filter((id) => currentCandidateIds.has(id))
        : retainedRemovedIds);
      state.historyCandidateIds = new Set(candidateRevisionMatches ? (draft.historyBase.candidateIds || state.candidates.map((candidate) => candidate.id)) : state.candidates.map((candidate) => candidate.id));
      const oldIndex = Math.max(0, Math.min(originalHistory.length, Number(draft.historyIndex) || 0));
      state.historyIndex = candidateRevisionMatches ? Math.min(state.history.length, oldIndex) : originalHistory.slice(0, oldIndex).filter((stroke) => !candidateOperation(stroke)).length;
      rebuildManualMaskFromHistory(); updateHistoryButtons();
      state.historyBaseDirty = false;
    } else resetHistoryToCurrentManualMask();
  state.draftDirty = false; state.draftLayerDirty.clear();
  refreshMaskStatus(true); updateCandidateStatus(); requestMosaicPreview(); renderCandidates(); render();
  return true;
}

function compareSplitX(width = stage.clientWidth) { return Math.round(width * state.compareSplit); }

function comparePaneBounds(width = stage.clientWidth) {
  if (state.displayMode !== "compare") return [{ offset: 0, width }];
  const split = compareSplitX(width);
  return [{ offset: 0, width: split }, { offset: split, width: width - split }];
}

function compareSideOffset(side, width = stage.clientWidth) {
  return state.displayMode === "compare" && side === "right" ? compareSplitX(width) : 0;
}

function compareEventSide(event, rect = canvas.getBoundingClientRect()) {
  return state.displayMode === "compare" && event.clientX - rect.left >= compareSplitX(rect.width) ? "right" : "left";
}

function compareEventOffset(event, rect = canvas.getBoundingClientRect()) {
  return compareSideOffset(compareEventSide(event, rect), rect.width);
}

function updateCompareSplitter() {
  const splitter = $("#compareSplitter");
  if (!splitter) return;
  const visible = state.displayMode === "compare";
  stage.dataset.displayMode = state.displayMode;
  splitter.hidden = !visible;
  splitter.style.setProperty("--compare-split", `${state.compareSplit * 100}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(state.compareSplit * 100)));
}

function setDisplayMode(mode) {
  const displayMode = mode === "compare" ? "compare" : "single";
  if (state.displayMode === displayMode) return;
  state.displayMode = displayMode;
  const single = $("#singleViewButton"); const compare = $("#compareViewButton");
  single.classList.toggle("active", displayMode === "single"); compare.classList.toggle("active", displayMode === "compare");
  single.setAttribute("aria-pressed", String(displayMode === "single")); compare.setAttribute("aria-pressed", String(displayMode === "compare"));
  updateCompareSplitter();
  fitImage();
}

function fitImage() {
  if (!state.currentImage) return;
  const inset = { left: 20, right: 20, top: Math.max(58, toolRail.offsetHeight + 12), bottom: 62 };
  const panelWidth = Math.min(...comparePaneBounds().map((pane) => pane.width));
  const width = Math.max(1, panelWidth - inset.left - inset.right);
  const height = Math.max(1, stage.clientHeight - inset.top - inset.bottom);
  state.view.scale = Math.min(width / state.currentImage.width, height / state.currentImage.height);
  state.view.x = inset.left + (width - state.currentImage.width * state.view.scale) / 2;
  state.view.y = inset.top + (height - state.currentImage.height * state.view.scale) / 2;
  render(); updateBrushCursor();
}

function resizeRenderCanvas() {
  const width = stage.clientWidth; const height = stage.clientHeight; const dpr = window.devicePixelRatio || 1;
  if (renderedWidth === width && renderedHeight === height && canvas.width === Math.round(width * dpr)) return;
  renderedWidth = width; renderedHeight = height;
  canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
  layerCanvas.width = canvas.width; layerCanvas.height = canvas.height;
  boundaryOverlayCanvas.width = canvas.width; boundaryOverlayCanvas.height = canvas.height;
  updateCompareSplitter();
  render(); updateBrushCursor();
}

function setCssTransform(context) { const dpr = window.devicePixelRatio || 1; context.setTransform(dpr, 0, 0, dpr, 0, 0); }

function releaseMosaicPreview() {
  state.mosaicPreviewGeneration += 1;
  state.mosaicWorker?.postMessage?.({ type: "release" });
  state.mosaicWorker?.terminate?.();
  state.mosaicWorker = null;
  state.mosaicWorkerBusy = false;
  state.mosaicPending = null;
  state.mosaicInFlightSourceId = "";
  state.mosaicInFlightGeneration = 0;
  state.mosaicSourceImage = null;
  state.mosaicSourceId = "";
  state.mosaicSourcePromise = null;
  mosaicCanvas.width = mosaicCanvas.height = 1;
}

function prepareOriginalImage() {
  if (!state.currentImage) return;
  originalCanvas.width = state.currentImage.width; originalCanvas.height = state.currentImage.height;
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height); originalCtx.drawImage(state.currentImage, 0, 0);
}

function mosaicPreviewFailed() {
  if (!state.mosaicPreviewFailureReported) {
    state.mosaicPreviewFailureReported = true;
    if (typeof showUserError === "function") showUserError({ code: "mosaic_preview_failed" }, $("#mosaicPreviewButton"));
  }
  state.mosaicPreviewEnabled = false;
  const button = $("#mosaicPreviewButton"); button?.classList?.remove?.("active"); button?.setAttribute?.("aria-pressed", "false");
  releaseMosaicPreview();
  render();
}

function createMosaicWorker() {
  if (state.mosaicWorker) return state.mosaicWorker;
  try {
    const worker = state.mosaicWorker = new Worker("/js/masked-mosaic-worker.js");
    worker.onmessage = ({ data }) => {
      if (state.mosaicWorker !== worker) { data.output?.close?.(); return; }
      const activeFrame = data.sourceId === state.mosaicInFlightSourceId && data.generation === state.mosaicInFlightGeneration;
      if (data.type === "error") {
        if (activeFrame || (state.mosaicWorkerBusy && !state.mosaicInFlightGeneration)) mosaicPreviewFailed();
        return;
      }
      if (data.type !== "frame") return;
      if (!activeFrame) { data.output?.close?.(); return; }
      const hasPending = Boolean(state.mosaicPending);
      state.mosaicWorkerBusy = false;
      state.mosaicPending = false;
      state.mosaicInFlightSourceId = "";
      state.mosaicInFlightGeneration = 0;
      let paintFailed = false;
      try {
        if (state.currentImage && data.sourceId === state.mosaicSourceId && data.generation === state.mosaicPreviewGeneration) {
          mosaicCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
          mosaicCtx.drawImage(data.output, 0, 0);
          render();
        }
      } catch { paintFailed = true; } finally { data.output?.close?.(); }
      if (paintFailed) return mosaicPreviewFailed();
      if (hasPending) void rebuildMosaicPreview();
    };
    worker.onerror = () => { if (state.mosaicWorker === worker) mosaicPreviewFailed(); };
    return worker;
  } catch {
    mosaicPreviewFailed(); return null;
  }
}

async function ensureMosaicPreviewSource(worker) {
  if (state.mosaicSourceImage === state.currentImage && state.mosaicSourceId) return state.mosaicSourceId;
  if (state.mosaicSourcePromise) return state.mosaicSourcePromise;
  const image = state.currentImage;
  const sourceGeneration = ++state.mosaicPreviewGeneration;
  const sourceId = `${state.imageGeneration}:${state.currentId}:${sourceGeneration}`;
  let sourcePromise;
  sourcePromise = (async () => {
    let source = null;
    try {
      if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") throw new Error("preview APIs unavailable");
      source = await createImageBitmap(image);
      if (state.currentImage !== image || state.mosaicWorker !== worker) { source.close?.(); return ""; }
      worker.postMessage({ type: "source", sourceId, source, generation: sourceGeneration }, [source]);
      source = null;
      state.mosaicSourceImage = image; state.mosaicSourceId = sourceId;
      return sourceId;
    } catch {
      source?.close?.();
      if (state.currentImage === image && state.mosaicWorker === worker) mosaicPreviewFailed();
      return "";
    } finally { if (state.mosaicSourcePromise === sourcePromise) state.mosaicSourcePromise = null; }
  })();
  state.mosaicSourcePromise = sourcePromise;
  return sourcePromise;
}

async function rebuildMosaicPreview() {
  if (!state.mosaicPreviewEnabled || !state.currentImage) return;
  if (state.mosaicWorkerBusy) { state.mosaicPending = true; return; }
  const worker = createMosaicWorker(); if (!worker) return;
  state.mosaicWorkerBusy = true;
  const sourceId = await ensureMosaicPreviewSource(worker);
  if (!sourceId || !state.mosaicPreviewEnabled || state.mosaicWorker !== worker) { state.mosaicWorkerBusy = false; return; }
  // Requests received while the source bitmap was being prepared are already
  // represented by the mask below, so one current render is sufficient.
  state.mosaicPending = false;
  flushMaskComposition();
  const generation = ++state.mosaicPreviewGeneration;
  state.mosaicInFlightSourceId = sourceId;
  state.mosaicInFlightGeneration = generation;
  let mask = null;
  try {
    mask = await createImageBitmap(combinedCanvas);
    if (state.mosaicWorker !== worker || !state.mosaicPreviewEnabled) { mask.close?.(); state.mosaicWorkerBusy = false; state.mosaicInFlightSourceId = ""; state.mosaicInFlightGeneration = 0; return; }
    if (state.mosaicPending) {
      mask.close?.(); state.mosaicWorkerBusy = false; state.mosaicInFlightSourceId = ""; state.mosaicInFlightGeneration = 0;
      state.mosaicPending = false; void rebuildMosaicPreview();
      return;
    }
    worker.postMessage({ type: "render", sourceId, mask, width: originalCanvas.width, height: originalCanvas.height, blockSize: calculatedBlockSize(), generation }, [mask]);
    mask = null;
  } catch { mask?.close?.(); state.mosaicWorkerBusy = false; state.mosaicInFlightSourceId = ""; state.mosaicInFlightGeneration = 0; mosaicPreviewFailed(); }
}

function requestMosaicPreview() {
  if (!state.mosaicPreviewEnabled || !state.currentImage) return;
  if (state.mosaicWorkerBusy) { state.mosaicPending = true; return; }
  if (state.mosaicPreviewRequested) return;
  state.mosaicPreviewRequested = true;
  requestAnimationFrame(() => {
    state.mosaicPreviewRequested = false;
    rebuildMosaicPreview();
  });
}

function drawEffectiveExclusions(target, forcedOnly = false, omittedCandidateId = "") {
  composeEnabledExclusionMask(forcedOnly, omittedCandidateId);
  target.drawImage(effectiveExclusionCanvas, 0, 0);
}

function composeEnabledExclusionMask(forcedOnly = false, omittedCandidateId = "") {
  effectiveExclusionCtx.clearRect(0, 0, effectiveExclusionCanvas.width, effectiveExclusionCanvas.height);
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    if (candidate.id !== omittedCandidateId && candidate.enabled && candidate.role === "exclude" && (!forcedOnly || candidate.forced)) effectiveExclusionCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualExclusionEnabled && (!forcedOnly || state.manualExclusionForced)) effectiveExclusionCtx.drawImage(exclusionCanvas, 0, 0);
  if (state.manualExclusionEraseEnabled) {
    effectiveExclusionCtx.save(); effectiveExclusionCtx.globalCompositeOperation = "destination-out";
    effectiveExclusionCtx.drawImage(exclusionEraseCanvas, 0, 0); effectiveExclusionCtx.restore();
  }
  return effectiveExclusionCanvas;
}

function composeCurrentMask() {
  if (!state.currentImage) return;
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    if (candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  combinedCtx.globalCompositeOperation = "destination-out";
  drawEffectiveExclusions(combinedCtx);
  combinedCtx.globalCompositeOperation = "source-over";
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  drawEffectiveExclusions(combinedCtx, true);
  combinedCtx.globalCompositeOperation = "source-over";
  // Keep the full enabled exclusion union available for display.  The forced
  // pass above is only for final mask composition and must not leak into UI.
  composeEnabledExclusionMask();
  state.maskDirty = false;
}
function markDraftDirty(...layers) {
  state.draftDirty = true;
  layers.forEach((layer) => state.draftLayerDirty.add(layer));
}
function markMaskDirty() { state.maskDirty = true; markDraftDirty(); }
function flushMaskComposition() { if (state.maskDirty) composeCurrentMask(); }

function hasEffectiveMask() {
  flushMaskComposition();
  return canvasHasPixels(combinedCtx, combinedCanvas);
}

function maskStatusWithoutCandidate(candidateId) {
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    if (candidate.id !== candidateId && candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  combinedCtx.globalCompositeOperation = "destination-out";
  drawEffectiveExclusions(combinedCtx, false, candidateId);
  combinedCtx.globalCompositeOperation = "source-over";
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  drawEffectiveExclusions(combinedCtx, true, candidateId);
  combinedCtx.globalCompositeOperation = "source-over";
  const hasMask = canvasHasPixels(combinedCtx, combinedCanvas);
  markMaskDirty(); flushMaskComposition();
  return hasMask;
}

function refreshMaskStatus(renderGalleryAfter = false) {
  if (!state.currentId || !state.currentImage) return;
  const record = currentRecord();
  const previous = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : Boolean(record && Number(record.enabledCandidateCount || 0) > 0);
  const current = hasEffectiveMask();
  state.maskStatus.set(state.currentId, current);
  if (renderGalleryAfter && previous !== current) renderCatalogViews();
  else updateActionButtons();
  return previous !== current;
}

function paintMosaicPreview() {
  paintMosaicPreviewAt(0);
}

function paintMosaicPreviewAt(offset) {
  if (!state.currentImage) return;
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(layerCtx); layerCtx.clearRect(0, 0, width, height);
  layerCtx.save(); layerCtx.translate(offset + state.view.x, state.view.y); layerCtx.scale(state.view.scale, state.view.scale);
  layerCtx.drawImage(mosaicCanvas, 0, 0);
  layerCtx.globalCompositeOperation = "destination-in";
  layerCtx.drawImage(combinedCanvas, 0, 0);
  layerCtx.restore(); setCssTransform(ctx); ctx.drawImage(layerCanvas, 0, 0, width, height);
}

function updateBrushCursor() {
  const cursor = $("#brushCursor");
  if (!state.hover || !state.currentImage || state.panning || isBusy() || state.importing || !["brush", "mosaic_eraser", "eraser", "exclude_eraser", "boundary_brush"].includes(state.tool)) { cursor.hidden = true; state.brushCursorGeometry = ""; return; }
  const radius = Math.max(1, Number($("#brushSize").value) * state.view.scale / 2);
  const x = compareSideOffset(state.hoverDisplaySide) + state.view.x + state.hover.x * state.view.scale;
  const y = state.view.y + state.hover.y * state.view.scale;
  const diameter = Math.max(2, radius * 2);
  const geometry = `${state.tool}:${diameter}`;
  cursor.hidden = false;
  if (state.brushCursorGeometry !== geometry) {
    state.brushCursorGeometry = geometry;
    cursor.classList.toggle("eraser", ["mosaic_eraser", "eraser", "exclude_eraser"].includes(state.tool));
    cursor.classList.toggle("boundary-brush", state.tool === "boundary_brush");
    cursor.style.width = `${diameter}px`; cursor.style.height = `${diameter}px`;
  }
  cursor.style.transform = `translate3d(${x - radius}px, ${y - radius}px, 0)`;
}
function roiFromPoints(start, end) {
  const left = Math.floor(Math.min(start.x, end.x)); const top = Math.floor(Math.min(start.y, end.y));
  const right = Math.ceil(Math.max(start.x, end.x)); const bottom = Math.ceil(Math.max(start.y, end.y));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}

function boundaryDraftRoi() {
  return state.boundaryDragging && state.boundaryStart && state.boundaryPoint
    ? roiFromPoints(state.boundaryStart, state.boundaryPoint)
    : state.boundaryRoi;
}

function boundaryDraftId() { state.boundaryDraftSequence += 1; return `boundary-${state.boundaryDraftSequence}`; }
function pointForRoi(roi) { return { x: Math.round((roi.left + roi.right) / 2), y: Math.round((roi.top + roi.bottom) / 2) }; }

function polygonRoi(points) {
  if (!points.length) return null;
  return {
    left: Math.floor(Math.min(...points.map((point) => point.x))), right: Math.ceil(Math.max(...points.map((point) => point.x))),
    top: Math.floor(Math.min(...points.map((point) => point.y))), bottom: Math.ceil(Math.max(...points.map((point) => point.y))),
  };
}

function boundaryDraftBounds(draft) { return draft?.roi || polygonRoi(draft?.points || []); }

function addBoundaryDraft(draft) {
  const item = { id: boundaryDraftId(), ...draft };
  state.boundaryDrafts.push(item);
  state.boundaryActiveId = item.id;
  return item;
}

function activeBoundaryShape() {
  const rectangle = boundaryDraftRoi();
  if (rectangle) return { type: "rectangle", roi: rectangle, point: state.boundaryPromptPoint || pointForRoi(rectangle), transient: true };
  if (state.polygonPoints.length) return { type: "polygon", points: state.polygonPoints, transient: true };
  if (state.boundaryBrushStroke) return { ...state.boundaryBrushStroke, transient: true };
  return null;
}

function boundaryShapes() { return [...state.boundaryDrafts, ...[activeBoundaryShape()].filter(Boolean)]; }

function strokeRoi(points, radius) {
  if (!points.length) return null;
  const padding = Math.max(1, radius / 2);
  const image = state.currentImage;
  const clampX = (value) => Math.max(0, Math.min(image.width, value));
  const clampY = (value) => Math.max(0, Math.min(image.height, value));
  const roi = {
    left: Math.floor(clampX(Math.min(...points.map((point) => point.x)) - padding)),
    top: Math.floor(clampY(Math.min(...points.map((point) => point.y)) - padding)),
    right: Math.ceil(clampX(Math.max(...points.map((point) => point.x)) + padding)),
    bottom: Math.ceil(clampY(Math.max(...points.map((point) => point.y)) + padding)),
  };
  return roiFromPoints({ x: roi.left, y: roi.top }, { x: roi.right, y: roi.bottom });
}

function appendBoundaryBrushPoint(point) {
  const stroke = state.boundaryBrushStroke;
  if (!stroke) return;
  const previous = stroke.points.at(-1);
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) >= 0.5) stroke.points.push(point);
  stroke.roi = strokeRoi(stroke.points, stroke.radius);
}

function beginBoundaryBrushStroke(point) {
  state.boundaryBrushStroke = { type: "brush", points: [point], radius: Math.max(1, Number($("#brushSize").value)), roi: null };
  state.boundaryBrushStroke.roi = strokeRoi(state.boundaryBrushStroke.points, state.boundaryBrushStroke.radius);
}

function completeBoundaryBrushStroke() {
  const stroke = state.boundaryBrushStroke;
  state.boundaryBrushStroke = null;
  if (!stroke?.roi) return;
  addBoundaryDraft({ type: "brush", points: stroke.points.map((point) => ({ ...point })), radius: stroke.radius, roi: stroke.roi, point: pointForRoi(stroke.roi) });
}

function rectsTouch(first, second) {
  return first.left <= second.right + 1 && first.right + 1 >= second.left
    && first.top <= second.bottom + 1 && first.bottom + 1 >= second.top;
}

function joinRois(rois) {
  return {
    left: Math.min(...rois.map((roi) => roi.left)), right: Math.max(...rois.map((roi) => roi.right)),
    top: Math.min(...rois.map((roi) => roi.top)), bottom: Math.max(...rois.map((roi) => roi.bottom)),
  };
}

function boundaryRequests() {
  const requests = [];
  const brushGroups = [];
  state.boundaryDrafts.forEach((draft, index) => {
    if (draft.type !== "brush") {
      if (draft.type === "polygon" && !polygonPointsValid(draft.points || [])) return;
      requests.push({ firstIndex: index, draftIds: [draft.id], draft });
      return;
    }
    if (!draft.roi) return;
    let group = brushGroups.find((item) => rectsTouch(item.roi, draft.roi));
    if (!group) { brushGroups.push({ drafts: [draft], roi: { ...draft.roi }, firstIndex: index }); return; }
    group.drafts.push(draft); group.roi = joinRois(group.drafts.map((item) => item.roi));
    group.firstIndex = Math.min(group.firstIndex, index);
    for (let index = brushGroups.length - 1; index >= 0; index -= 1) {
      const other = brushGroups[index];
      if (other === group || !rectsTouch(group.roi, other.roi)) continue;
      group.drafts.push(...other.drafts); group.roi = joinRois(group.drafts.map((item) => item.roi)); group.firstIndex = Math.min(group.firstIndex, other.firstIndex); brushGroups.splice(index, 1);
    }
  });
  for (const group of brushGroups) requests.push({ firstIndex: group.firstIndex, draftIds: group.drafts.map((draft) => draft.id), draft: { type: "brush", roi: group.roi, point: pointForRoi(group.roi) } });
  return requests.sort((first, second) => first.firstIndex - second.firstIndex).map(({ draftIds, draft }) => ({ draftIds, draft }));
}

function boundaryPath(shape, context = ctx, offset = compareSideOffset(state.boundaryDisplaySide)) {
  const roi = boundaryDraftBounds(shape);
  if (shape.type === "polygon" && shape.points?.length) {
    shape.points.forEach((point, index) => {
      const x = offset + state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    if (shape.points.length === 4) context.closePath();
    return;
  }
  if (shape.type === "brush" && shape.points?.length) {
    const points = shape.points;
    const first = points[0];
    context.moveTo(offset + state.view.x + first.x * state.view.scale, state.view.y + first.y * state.view.scale);
    for (const point of points.slice(1)) context.lineTo(offset + state.view.x + point.x * state.view.scale, state.view.y + point.y * state.view.scale);
    if (points.length === 1) context.lineTo(offset + state.view.x + first.x * state.view.scale + 0.01, state.view.y + first.y * state.view.scale + 0.01);
    return;
  }
  if (roi) context.rect(offset + state.view.x + roi.left * state.view.scale, state.view.y + roi.top * state.view.scale, (roi.right - roi.left) * state.view.scale, (roi.bottom - roi.top) * state.view.scale);
}

function drawBoundaryScrim(shapes, offset = compareSideOffset(state.boundaryDisplaySide)) {
  if (!shapes.length || !state.currentImage) return;
  setCssTransform(boundaryOverlayCtx); boundaryOverlayCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  boundaryOverlayCtx.save();
  clipRenderPane(boundaryOverlayCtx, offset);
  boundaryOverlayCtx.beginPath(); boundaryOverlayCtx.rect(offset + state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale); boundaryOverlayCtx.clip();
  boundaryOverlayCtx.fillStyle = "rgba(8, 11, 14, 0.68)"; boundaryOverlayCtx.fillRect(offset + state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale);
  boundaryOverlayCtx.globalCompositeOperation = "destination-out";
  for (const shape of shapes) {
    boundaryOverlayCtx.beginPath();
    boundaryPath(shape, boundaryOverlayCtx, offset);
    if (shape.type === "brush") {
      boundaryOverlayCtx.lineWidth = Math.max(1, shape.radius * state.view.scale); boundaryOverlayCtx.lineCap = "round"; boundaryOverlayCtx.lineJoin = "round"; boundaryOverlayCtx.stroke();
    } else boundaryOverlayCtx.fill();
  }
  boundaryOverlayCtx.restore();
  setCssTransform(ctx); ctx.save(); clipRenderPane(ctx, offset); ctx.drawImage(boundaryOverlayCanvas, 0, 0, stage.clientWidth, stage.clientHeight); ctx.restore();
}

function drawBoundaryShape(shape, offset = compareSideOffset(state.boundaryDisplaySide)) {
  const ready = shape.type !== "polygon" || polygonPointsValid(shape.points || []);
  ctx.save(); clipRenderPane(ctx, offset); ctx.strokeStyle = ready ? "#50d589" : "#f0ba62"; ctx.lineWidth = 2;
  ctx.beginPath(); boundaryPath(shape, ctx, offset);
  if (shape.type === "brush") { ctx.lineWidth = Math.max(2, shape.radius * state.view.scale); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(); }
  else ctx.stroke();
  if (shape.type === "polygon") for (const point of shape.points) {
    const x = offset + state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = "#effff4"; ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawBoundaryRoi() {
  const shapes = boundaryShapes();
  if (!shapes.length) return;
  const offsets = comparePaneBounds().map((pane) => pane.offset);
  for (const offset of offsets) {
    drawBoundaryScrim(shapes, offset);
    shapes.forEach((shape) => drawBoundaryShape(shape, offset));
  }
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - point.y * next.x;
  }, 0) / 2);
}

function polygonSegmentsIntersect(a, b, c, d) {
  const orient = (first, second, third) => (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const abC = orient(a, b, c); const abD = orient(a, b, d); const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function polygonPointsValid(points) {
  return points.length === 4
    && polygonArea(points) >= 16
    && !polygonSegmentsIntersect(points[0], points[1], points[2], points[3])
    && !polygonSegmentsIntersect(points[1], points[2], points[3], points[0]);
}

function polygonIsValid() { return polygonPointsValid(state.polygonPoints); }

function canDetectBoundary() {
  const constructing = state.boundaryDragging || state.polygonPoints.length > 0 || Boolean(state.boundaryBrushStroke);
  return Boolean(state.currentId && state.currentImage && boundaryRequests().length)
    && !constructing && !state.pendingImageId && !state.boundaryPending && !isBusy() && !state.importing;
}

function hasBoundaryDraft() {
  return Boolean(state.boundaryDrafts.length || activeBoundaryShape());
}

function boundaryActionAnchor() {
  const active = activeBoundaryShape() || state.boundaryDrafts.find((draft) => draft.id === state.boundaryActiveId) || state.boundaryDrafts.at(-1);
  const roi = boundaryDraftBounds(active);
  if (!roi) return null;
  const offset = compareSideOffset(state.boundaryDisplaySide);
  return {
    left: offset + state.view.x + roi.left * state.view.scale, right: offset + state.view.x + roi.right * state.view.scale,
    top: state.view.y + roi.top * state.view.scale, bottom: state.view.y + roi.bottom * state.view.scale,
  };
}

function updateBoundaryActions() {
  const actions = $("#boundaryActions");
  if (!actions) return;
  const active = !state.boundaryPending && !state.pendingImageId && hasBoundaryDraft();
  const focusedAction = document.activeElement === $("#boundaryDetectButton") || document.activeElement === $("#boundaryCancelButton");
  actions.hidden = !active;
  $("#boundaryDetectButton").disabled = !canDetectBoundary();
  if (!active) {
    if (focusedAction) focusCanvas();
    return;
  }
  const anchor = boundaryActionAnchor();
  if (!anchor) return;
  const width = actions.offsetWidth || 142;
  const height = actions.offsetHeight || 38;
  const minLeft = 8; const maxLeft = Math.max(minLeft, stage.clientWidth - width - 8);
  const minTop = 8; const maxTop = Math.max(minTop, stage.clientHeight - height - 8);
  const horizontal = Math.max(minLeft, Math.min(maxLeft, anchor.left + (anchor.right - anchor.left - width) / 2));
  const below = anchor.bottom + 8;
  const vertical = Math.max(minTop, Math.min(maxTop, below + height <= stage.clientHeight - 8 ? below : anchor.top - height - 8));
  actions.style.left = `${Math.round(horizontal)}px`;
  actions.style.top = `${Math.round(vertical)}px`;
}

function drawPolygonBoundary() {
  // Polygon drawing is handled together with every selected boundary shape.
}

function clipRenderPane(target, offset = 0) {
  if (state.displayMode !== "compare") return;
  const pane = comparePaneBounds().find((item) => item.offset === offset);
  target.beginPath(); target.rect(offset, 0, pane.width, stage.clientHeight); target.clip();
}

function paintTintedLayer(color, opacity, offset, paintMask) {
  // Keep blink composition at viewport size.  Reusing a full-resolution mask
  // canvas here made each selected candidate re-tint the previous one.
  setCssTransform(layerCtx); layerCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  layerCtx.save(); clipRenderPane(layerCtx, offset); paintMask(layerCtx); layerCtx.restore();
  layerCtx.save(); layerCtx.globalCompositeOperation = "source-in"; layerCtx.fillStyle = color;
  layerCtx.fillRect(0, 0, stage.clientWidth, stage.clientHeight); layerCtx.restore();
  setCssTransform(ctx); ctx.save(); clipRenderPane(ctx, offset); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = opacity;
  ctx.drawImage(layerCanvas, 0, 0, stage.clientWidth, stage.clientHeight); ctx.restore();
}

function paintTintedMask(mask, color, opacity, offset, clipMask = null) {
  if (!mask) return;
  paintTintedLayer(color, opacity, offset, (target) => {
    target.save(); target.translate(offset + state.view.x, state.view.y); target.scale(state.view.scale, state.view.scale);
    target.drawImage(mask, 0, 0);
    if (clipMask) { target.globalCompositeOperation = "destination-in"; target.drawImage(clipMask, 0, 0); }
    target.restore();
  });
}

function paintEffectiveManualExclusionErase(offset, color, opacity) {
  // The erase overlay is only meaningful where an enabled exclusion existed
  // before the erase.  Build that union in a viewport layer so the cached
  // post-erase exclusion canvas remains untouched.
  setCssTransform(boundaryOverlayCtx); boundaryOverlayCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  boundaryOverlayCtx.save(); clipRenderPane(boundaryOverlayCtx, offset);
  boundaryOverlayCtx.translate(offset + state.view.x, state.view.y); boundaryOverlayCtx.scale(state.view.scale, state.view.scale);
  for (const candidate of state.candidates) {
    if (!state.removedCandidateIds.has(candidate.id) && candidate.enabled && candidate.role === "exclude") boundaryOverlayCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualExclusionEnabled) boundaryOverlayCtx.drawImage(exclusionCanvas, 0, 0);
  boundaryOverlayCtx.restore();
  paintTintedLayer(color, opacity, offset, (target) => {
    target.save(); target.translate(offset + state.view.x, state.view.y); target.scale(state.view.scale, state.view.scale); target.drawImage(exclusionEraseCanvas, 0, 0); target.restore();
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalCompositeOperation = "destination-in";
    target.drawImage(boundaryOverlayCanvas, 0, 0); target.restore();
  });
}

function selectedCandidateMask(id, role, enabled, mask, mode, exclusionMask) {
  if (!mask || mode !== "effective") return mask;
  if (!enabled) return null;
  return { mask, clip: role === "apply" ? combinedCanvas : exclusionMask };
}

function drawCandidateBlinkOverlay(offset = 0) {
  if (!state.blinkCandidateIds.size || !state.currentImage || !state.blinkPhase) return;
  const settings = state.settings?.display || { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78 };
  const configuredOpacity = Number(settings.overlay_opacity);
  const opacity = Number.isFinite(configuredOpacity) ? configuredOpacity : 0.78;
  const exclusionMask = effectiveExclusionCanvas;
  const paintSelected = (id, role, enabled, mask) => {
    if (!state.blinkCandidateIds.has(id)) return;
    const selected = selectedCandidateMask(id, role, enabled, mask, state.blinkModes.get(id) || "normal", exclusionMask);
    if (!selected) return;
    if (selected.mask) paintTintedMask(selected.mask, role === "apply" ? settings.apply_color : settings.exclude_color, opacity, offset, selected.clip);
    else paintTintedMask(selected, role === "apply" ? settings.apply_color : settings.exclude_color, opacity, offset);
  };
  paintSelected("manual:apply", "apply", state.manualEnabled, addCanvas);
  paintSelected("manual:exclude", "exclude", state.manualExclusionEnabled, exclusionCanvas);
  // Erasing an exclusion restores mosaic, so its review color follows APPLY.
  if (state.blinkCandidateIds.has("manual:excludeErase")) {
    const mode = state.blinkModes.get("manual:excludeErase") || "normal";
    if (mode === "effective") {
      if (state.manualExclusionEraseEnabled) paintEffectiveManualExclusionErase(offset, settings.apply_color, opacity);
    } else paintTintedMask(exclusionEraseCanvas, settings.apply_color, opacity, offset);
  }
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    if (!state.blinkCandidateIds.has(candidate.id)) continue;
    paintSelected(candidate.id, candidate.role === "exclude" ? "exclude" : "apply", candidate.enabled, state.candidateImages.get(candidate.id));
  }
}

function drawCompareRangeOverlay(offset) {
  if (state.blinkCandidateIds.size) { drawCandidateBlinkOverlay(offset); return; }
  const settings = state.settings?.display || { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78 };
  setCssTransform(layerCtx);
  const paint = (mask, color) => {
    layerCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
    layerCtx.save(); layerCtx.translate(offset + state.view.x, state.view.y); layerCtx.scale(state.view.scale, state.view.scale);
    layerCtx.drawImage(mask, 0, 0); layerCtx.globalCompositeOperation = "source-in"; layerCtx.fillStyle = color;
    layerCtx.fillRect(0, 0, originalCanvas.width, originalCanvas.height); layerCtx.restore();
  };
  ctx.save(); clipRenderPane(ctx, offset); ctx.globalAlpha = settings.overlay_opacity;
  paint(combinedCanvas, settings.apply_color); ctx.drawImage(layerCanvas, 0, 0, stage.clientWidth, stage.clientHeight);
  paint(effectiveExclusionCanvas, settings.exclude_color); ctx.drawImage(layerCanvas, 0, 0, stage.clientWidth, stage.clientHeight); ctx.restore();
}

function renderNow() {
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(ctx); ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) { updateBrushCursor(); return; }
  ctx.save(); clipRenderPane(ctx); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale); ctx.drawImage(state.currentImage, 0, 0); ctx.restore();
  if (state.displayMode === "compare") {
    const [, rightPane] = comparePaneBounds(width); const offset = rightPane.offset;
    if (state.mosaicPreviewEnabled) paintMosaicPreview();
    ctx.save(); clipRenderPane(ctx, offset); ctx.beginPath(); ctx.rect(offset + state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale); ctx.clip(); ctx.fillStyle = "#000"; ctx.fillRect(offset + state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale); ctx.restore();
    drawCompareRangeOverlay(offset);
  } else {
    if (state.mosaicPreviewEnabled) paintMosaicPreview();
    drawCandidateBlinkOverlay();
  }
  drawBoundaryRoi();
  drawPolygonBoundary();
  updateBrushCursor();
  updateBoundaryActions();
}
function render() {
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => { state.renderFrame = 0; flushMaskComposition(); renderNow(); });
}
function flushRender() {
  if (state.renderFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.renderFrame);
  state.renderFrame = 0; flushMaskComposition(); renderNow();
}
