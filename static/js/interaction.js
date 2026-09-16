function setTool(tool) {
  if (isBusy() || state.importing || (catalogStagingEditsActive() && ["boundary", "polygon", "boundary_brush"].includes(tool))) return;
  const previousTool = state.tool;
  const toggleTolerance = fillToleranceToggleRequest === tool;
  fillToleranceToggleRequest = null;
  const focusedInBoundaryMenu = closeBoundaryModeMenu();
  const boundaryTools = new Set(["boundary", "polygon", "boundary_brush"]);
  if (!boundaryTools.has(tool)) clearBoundaryInteraction();
  else if (state.tool !== tool) clearBoundaryConstruction();
  state.tool = tool;
  for (const [id, name] of [["#brushTool", "brush"], ["#bucketTool", "bucket"], ["#mosaicEraserTool", "mosaic_eraser"], ["#eraserTool", "eraser"], ["#excludeBucketTool", "exclude_bucket"], ["#excludeEraserTool", "exclude_eraser"], ["#rectangleTool", "boundary"], ["#polygonTool", "polygon"], ["#boundaryBrushTool", "boundary_brush"]]) {
    const active = tool === name; $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("#boundaryTool").classList.toggle("active", boundaryTools.has(tool));
  $("#boundaryTool").setAttribute("aria-pressed", String(boundaryTools.has(tool)));
  const toleranceAnchor = tool === "bucket" ? $("#bucketToolAnchor") : (tool === "exclude_bucket" ? $("#excludeBucketToolAnchor") : null);
  if (toleranceAnchor && previousTool === tool && (toggleTolerance || (fillToleranceSession?.anchor === toleranceAnchor && $("#bucketToleranceControl").matches?.(":popover-open")))) closeFillToleranceControl({ focus: true });
  else if (toleranceAnchor) openFillToleranceControl(toleranceAnchor);
  else closeFillToleranceControl();
  const toleranceOpen = $("#bucketToleranceControl").matches?.(":popover-open") === true;
  $("#bucketTool").setAttribute("aria-expanded", String(toleranceOpen && tool === "bucket"));
  $("#excludeBucketTool").setAttribute("aria-expanded", String(toleranceOpen && tool === "exclude_bucket"));
  canvas.style.cursor = "default";
  updateBoundaryActions(); render(); updateBrushCursor();
  if (focusedInBoundaryMenu) focusCanvas();
}

let fillToleranceSession = null;
let fillToleranceToggleRequest = null;

function rememberFillToleranceTrigger(tool) {
  const anchor = tool === "bucket" ? $("#bucketToolAnchor") : $("#excludeBucketToolAnchor");
  fillToleranceToggleRequest = state.tool === tool && fillToleranceSession?.anchor === anchor && $("#bucketToleranceControl").matches?.(":popover-open") ? tool : null;
}

function positionFillToleranceControl(anchor) {
  const panel = $("#bucketToleranceControl");
  const anchorRect = anchor.getBoundingClientRect(); const panelRect = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - panelRect.width - 8, anchorRect.left));
  const below = anchorRect.bottom + 5;
  const top = below + panelRect.height <= window.innerHeight - 8 ? below : Math.max(8, anchorRect.top - panelRect.height - 5);
  panel.style.left = `${left}px`; panel.style.top = `${top}px`;
}

function openFillToleranceControl(anchor) {
  const panel = $("#bucketToleranceControl");
  if (panel.matches?.(":popover-open") && fillToleranceSession?.anchor === anchor) return;
  if (fillToleranceSession) closeFillToleranceControl();
  fillToleranceSession = { anchor };
  panel.showPopover(); positionFillToleranceControl(anchor);
}

function closeFillToleranceControl({ focus = false } = {}) {
  const session = fillToleranceSession;
  if (!session) return;
  fillToleranceSession = null;
  const panel = $("#bucketToleranceControl");
  if (panel.matches?.(":popover-open")) panel.hidePopover();
  $("#bucketTool").setAttribute("aria-expanded", "false");
  $("#excludeBucketTool").setAttribute("aria-expanded", "false");
  if (focus && session.anchor?.isConnected) session.anchor.querySelector("button")?.focus();
}

function setBoundaryModeMenuOpen(open) {
  const menu = $("#boundaryModeMenu");
  menu.hidden = !open;
  $("#boundaryTool").setAttribute("aria-expanded", String(open));
}

function closeBoundaryModeMenu({ restoreFocus = false } = {}) {
  const menu = $("#boundaryModeMenu");
  const focusedInMenu = menu.contains?.(document.activeElement);
  setBoundaryModeMenuOpen(false);
  if (focusedInMenu && restoreFocus) focusElement($("#boundaryTool"));
  return Boolean(focusedInMenu);
}
function updateBrushSize(value) {
  if (isBusy() || state.importing) return;
  const input = $("#brushSize"); input.value = Math.max(1, Math.round(value));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render(); updateBrushCursor();
}
function updateBlockSizeDisplay() {
  const currentBlockSize = calculatedBlockSize(currentRecord(), mosaicDivisor());
  const applyBlockSize = calculatedBlockSize(currentRecord(), normaliseDivisor($("#applyDivisor").value));
  $("#blockSizeValue").textContent = currentBlockSize ? t("editor.calculatedPixels", { value: currentBlockSize }) : "";
  $("#applyBlockSize").textContent = applyBlockSize ? t("editor.calculatedPixels", { value: applyBlockSize }) : "";
}

function confirmAction(title, message, key = null, onConfirm = null) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  const accept = () => { try { onConfirm?.(); } catch { /* The caller turns a failed preflight into a normal per-image failure. */ } };
  if (key && (newConfirmation.has(key) ? state.settings?.confirmations?.[key] !== true : state.settings?.confirmations?.[key] === false)) {
    accept(); return Promise.resolve(true);
  }
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  return new Promise((resolve) => {
    const finish = () => {
      $("#confirmAccept").removeEventListener("click", accept);
      const accepted = dialog.returnValue === "confirm";
      if (accepted && key && $("#confirmNeverShow").checked && state.settings) {
        state.settings.confirmations = { ...state.settings.confirmations, [key]: false };
        void api("/api/settings?status=0", { method: "POST", body: JSON.stringify(state.settings) }).then((data) => {
          state.settings = data.settings;
        }).catch(() => {});
      }
      $("#confirmNeverShow").checked = false; resolve(accepted);
    };
    $("#confirmAccept").addEventListener("click", accept, { once: true });
    dialog.addEventListener("close", finish, { once: true });
    showModalFromInvoker(dialog);
  });
}
function confirmationRequired(key) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  return newConfirmation.has(key) ? state.settings?.confirmations?.[key] === true : state.settings?.confirmations?.[key] !== false;
}

function resetCurrentDraft() {
  if (!state.currentImage) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  state.manualMaskPresent = false; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
  state.maskDirty = true; flushMaskComposition();
  resetHistoryToCurrentManualMask(); refreshMaskStatus(true); render();
}

async function clearMasks(imageIds, titleKey, messageKey, expectedImageId = null, expectedGeneration = null) {
  const ids = new Set(processableImages().map((image) => image.id));
  imageIds = [...new Set(imageIds)].filter((imageId) => ids.has(imageId));
  if (!imageIds.length || isBusy() || state.importing || catalogStagingEditsActive() || currentImageActionPending()) return;
  if (!await confirmAction(t(titleKey, { count: imageIds.length }), t(messageKey, { count: imageIds.length }), "clearMasks")) return;
  if (expectedImageId && (state.currentId !== expectedImageId || !isCurrentGeneration(expectedGeneration) || currentImageActionPending())) return;
  state.masksClearing = true;
  let catalogEpoch = null;
  updateActionButtons();
  try {
    await flushAllImageMutations();
    await Promise.all([...new Set(imageIds)].map(flushWorkspaceDraft));
    if (expectedImageId && (state.currentId !== expectedImageId || !isCurrentGeneration(expectedGeneration) || currentImageActionPending())) return;
    catalogEpoch = beginCatalogEpoch();
    await api("/api/masks/clear", { method: "POST", body: JSON.stringify({ imageIds }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    const capturedProjectId = state.project?.id || null; const capturedCatalogGeneration = state.serverCatalogGeneration;
    const refreshed = await api("/api/images");
    const replaced = reconcileCatalogSnapshot(refreshed, capturedProjectId, capturedCatalogGeneration);
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    if (!replaced) await refreshWorkspaceImages(refreshed, imageIds, { clearWorkspace: true });
    clearStatus();
  } catch (error) { if (catalogEpoch === null || isCurrentCatalogEpoch(catalogEpoch)) showUserError(error); }
  finally { state.masksClearing = false; renderCandidates(); updateActionButtons(); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing || catalogStagingEditsActive()) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"), "clearCatalog")) return;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    await catalogApi("/api/catalog/clear", {}, { method: "POST" });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    clearStoredCatalogState();
    resetCatalog([], "");
    state.project = null;
    state.projectReadOnly = false;
    state.missingNativeSources = [];
    renderProjectCurrent();
    clearStatus();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) showUserError(error); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

function closeCatalogContextMenu({ restoreFocus = true } = {}) {
  const menu = $("#catalogContextMenu");
  if (menu.matches?.(":popover-open")) menu.hidePopover();
  state.contextMenuImageId = null;
  state.contextMenuScroll = null;
  const origin = state.contextMenuOrigin;
  state.contextMenuOrigin = null;
  if (restoreFocus) focusElement(origin);
}

function positionCatalogContextMenu(menu, clientX, clientY) {
  const padding = 8;
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement?.clientHeight || window.innerHeight;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(padding, clientX), Math.max(padding, viewportWidth - width - padding))}px`;
  menu.style.top = `${Math.min(Math.max(padding, clientY), Math.max(padding, viewportHeight - height - padding))}px`;
}

function openCatalogContextMenu(event, imageId) {
  if (isBusy() || state.importing) return;
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  event.preventDefault();
  state.contextMenuImageId = imageId;
  const keyboardEvent = event.type === "keydown";
  state.contextMenuOrigin = event.currentTarget || document.activeElement;
  state.contextMenuScroll = { gallery: $("#gallery").scrollTop, overview: $("#overviewGrid").scrollTop };
  $("#toggleReviewMenuItem").textContent = t(isReviewed(image) ? "context.unreview" : "context.review");
  const rename = $("#renameImageMenuItem"); const renameAvailable = canRenameCatalogImage(image);
  rename.disabled = !renameAvailable;
  rename.textContent = t("context.rename");
  rename.title = renameAvailable ? "" : t("context.renameUnavailableHelp");
  $("#copyImagePathMenuItem").hidden = !image.sourcePath;
  $("#removeImageMenuItem").textContent = t(isHidden(image) ? "editor.show" : "editor.hide");
  const menu = $("#catalogContextMenu");
  const cardRect = state.contextMenuOrigin?.getBoundingClientRect?.();
  const clientX = !keyboardEvent && Number.isFinite(event.clientX) ? event.clientX : (cardRect ? cardRect.left + Math.min(24, cardRect.width / 2) : 8);
  const clientY = !keyboardEvent && Number.isFinite(event.clientY) ? event.clientY : (cardRect ? cardRect.top + Math.min(24, cardRect.height / 2) : 8);
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.showPopover?.();
  positionCatalogContextMenu(menu, clientX, clientY);
  if (keyboardEvent) focusElement($("#toggleReviewMenuItem"));
}

function canRenameCatalogImage(image) {
  if (!image || isBusy() || state.importing || state.projectReadOnly || state.renamePending || currentImageActionPending() || catalogStagingEditsActive()) return false;
  if (image.sourceKind === "filesystem") return true;
  const access = sourceAccessFor(image.id);
  return Boolean(access?.fileHandle && access?.parentHandle && typeof access.fileHandle.move === "function");
}

function openRenameImageDialog(imageId = state.contextMenuImageId || state.currentId) {
  const image = state.images.find((entry) => entry.id === imageId); const invoker = state.contextMenuOrigin || document.activeElement;
  closeCatalogContextMenu({ restoreFocus: false });
  if (!canRenameCatalogImage(image)) { showUserError({ code: "source_action_unavailable" }, invoker); return; }
  state.renameImage = { imageId: image.id, invoker };
  const input = $("#renameImageFilename"); input.value = String(image.relativePath || "").split(/[\\/]/).pop() || "";
  $("#renameImageResult").textContent = ""; $("#renameImageResult").classList.remove("error");
  showModalFromInvoker($("#renameImageDialog"), invoker); requestAnimationFrame(() => { input.focus(); input.select(); });
}

async function submitRenameImage(event) {
  event.preventDefault(); const rename = state.renameImage; const image = state.images.find((entry) => entry.id === rename?.imageId);
  const input = $("#renameImageFilename"); const filename = input.value.trim(); const access = sourceAccessFor(image?.id); let previousName = "";
  if (!rename || state.renamePending || !canRenameCatalogImage(image)) return;
  const originalName = String(image.relativePath || "").split(/[\\/]/).pop() || "";
  if (originalName.slice(originalName.lastIndexOf(".")).toLocaleLowerCase() !== filename.slice(filename.lastIndexOf(".")).toLocaleLowerCase()) {
    const error = { code: "rename_extension_unsupported" };
    $("#renameImageResult").textContent = t(`errorCode.${error.code}`); $("#renameImageResult").classList.add("error"); showUserError(error, input); return;
  }
  state.renamePending = true;
  $("#renameImageFilename").disabled = true; $("#renameImageCancel").disabled = true; $("#renameImageConfirm").disabled = true;
  updateActionButtons();
  let durable = false;
  try {
    if (image.sourceKind !== "filesystem") {
      await ensureHandlePermission(access, true); previousName = access.fileHandle.name || access.name;
      await access.fileHandle.move(access.parentHandle, filename); const file = await access.fileHandle.getFile();
      access.name = file.name; access.size = file.size; access.lastModified = file.lastModified;
    }
    await flushWorkspaceDraft(image.id);
    const result = await catalogApi("/api/catalog/rename", { imageId: image.id, filename, browserRenamed: image.sourceKind !== "filesystem" }, { method: "POST" });
    durable = true;
    state.images = result.images || state.images; state.serverCatalogGeneration = result.catalogGeneration ?? state.serverCatalogGeneration;
    try { renderCatalogViews(); } catch (error) { console.warn("名前変更後の画面更新に失敗しました", error); }
    try { $("#renameImageDialog").close(); } catch (error) { console.warn("名前変更後のダイアログ終了に失敗しました", error); }
  } catch (error) {
    let rollbackKnown = false;
    if (!durable && previousName) {
      const authoritative = await api("/api/images", { resyncOnStale: false }).catch(() => null);
      const current = authoritative?.images?.find((entry) => entry.id === image.id);
      durable = Boolean(current && String(current.relativePath || "").split(/[\\/]/).pop() === filename);
      rollbackKnown = Boolean(current && String(current.relativePath || "").split(/[\\/]/).pop() === previousName);
      if (durable) {
        state.images = authoritative.images; state.serverCatalogGeneration = authoritative.catalogGeneration ?? state.serverCatalogGeneration;
        try { renderCatalogViews(); } catch (renderError) { console.warn("名前変更後の画面更新に失敗しました", renderError); }
        try { $("#renameImageDialog").close(); } catch (closeError) { console.warn("名前変更後のダイアログ終了に失敗しました", closeError); }
        return;
      }
    }
    if (!durable && rollbackKnown && previousName && access?.fileHandle?.move) try {
      await access.fileHandle.move(access.parentHandle, previousName); const file = await access.fileHandle.getFile();
      access.name = file.name; access.size = file.size; access.lastModified = file.lastModified;
    } catch {}
    $("#renameImageResult").textContent = t(`errorCode.${userErrorCode(error)}`); $("#renameImageResult").classList.add("error"); showUserError(error, input);
  } finally {
    state.renamePending = false;
    $("#renameImageFilename").disabled = false; $("#renameImageCancel").disabled = false; $("#renameImageConfirm").disabled = false;
    updateActionButtons();
  }
}

async function copyContextMenuImagePath() {
  const image = state.images.find((item) => item.id === state.contextMenuImageId);
  const origin = state.contextMenuOrigin;
  closeCatalogContextMenu();
  if (!image?.sourcePath) return;
  try {
    await navigator.clipboard.writeText(image.sourcePath);
    setStatusKey("status.pathCopied");
  } catch {
    showUserError({ code: "clipboard_write_failed" }, origin);
  }
}

function clearReviewForRemovedImage(image) {
  state.reviewedImageIds.delete(image.id);
  state.hiddenImageIds.delete(image.id);
}
function deletionSelectionSnapshot(imageIds, visibleImages) {
  const pendingImageId = state.pendingImageId;
  const currentImageId = state.currentId;
  return {
    currentImageId,
    pendingImageId,
    visibleImages,
    anchorImageId: imageIds.has(pendingImageId) ? pendingImageId : currentImageId,
    removesSelection: imageIds.has(currentImageId) || imageIds.has(pendingImageId),
  };
}
function invalidatePendingImage() {
  if (!state.pendingImageId) return;
  ++state.imageGeneration;
  state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
  updateActionButtons();
}
async function restoreDeletionSelection(snapshot, imageIds) {
  const availableIds = new Set(state.images.map((image) => image.id));
  const removedIds = new Set([...imageIds].filter((imageId) => !availableIds.has(imageId)));
  // A batch can partially fail.  Only change the editor selection when the
  // image that was actually current (or loading) was removed; deleting a
  // different selected image must leave its canvas in place.
  const removesSelection = removedIds.has(snapshot.currentImageId) || removedIds.has(snapshot.pendingImageId);
  const target = removesSelection
    ? nextVisibleImage(snapshot.visibleImages, snapshot.anchorImageId, { excludedImageIds: removedIds, fallback: true })
    : null;
  const imageId = [target?.id, snapshot.pendingImageId, snapshot.currentImageId].find((id) => availableIds.has(id));
  if (!imageId) clearCurrentImageSelection();
  else if (!(state.currentId === imageId && state.currentImage)) await selectImage(imageId, true, { saveCurrentDraft: false });
}
function browserDeleteEntry(image) {
  const access = sourceAccessFor(image.id);
  return access?.fileHandle && access?.parentHandle ? {
    imageId: image.id, name: access.fileHandle.name || access.name, fileHandle: access.fileHandle, parentHandle: access.parentHandle,
    sizeBytes: image.sizeBytes, mtimeNs: image.mtimeNs, state: "ready",
  } : null;
}
function beginBrowserDeletePermissionRequests(images) {
  const parents = new Map(); const entries = new Map();
  for (const image of images) {
    if (image.sourceKind !== "filesystem") {
      const entry = browserDeleteEntry(image); entries.set(image.id, entry);
      if (entry) parents.set(entry.parentHandle, null);
    }
  }
  // This runs inside the confirm button's click handler. Do not move the
  // request behind the dialog close event or any await: Chromium drops
  // transient activation there.
  for (const parentHandle of parents.keys()) {
    try { parents.set(parentHandle, Promise.resolve(parentHandle.requestPermission?.({ mode: "readwrite" }))); }
    catch (error) { parents.set(parentHandle, Promise.reject(error)); }
  }
  return async () => {
    const settled = new Map(await Promise.all([...parents.entries()].map(async ([parentHandle, request]) => [parentHandle, await Promise.resolve(request).then(
      (permission) => !permission || permission === "granted", () => false,
    )])));
    return images.filter((image) => image.sourceKind !== "filesystem").flatMap((image) => {
      const entry = entries.get(image.id);
      return entry && settled.get(entry.parentHandle) ? [] : [{ imageId: image.id, reason: entry ? "source_permission_denied" : "source_action_unavailable" }];
    });
  };
}
async function browserDeleteHandle(entry, image, requestPermission = false) {
  const options = { mode: "readwrite" };
  let permission = await entry.parentHandle.queryPermission?.(options);
  if (permission && permission !== "granted" && requestPermission && entry.parentHandle.requestPermission) {
    // Recovered IDB handles survive a restart but their write grant may not.
    // When resume runs from a user action the browser can ask again; otherwise
    // retain the durable operation for that explicit retry.
    permission = await entry.parentHandle.requestPermission(options);
  }
  if (permission && permission !== "granted") throw codedError("source_permission_denied");
  const resolved = await entry.parentHandle.getFileHandle(entry.name);
  if (resolved.isSameEntry && !await resolved.isSameEntry(entry.fileHandle)) throw codedError("stale_asset");
  const file = await resolved.getFile();
  if (file.size !== image.sizeBytes || file.lastModified * 1_000_000 !== image.mtimeNs) throw codedError("stale_asset");
  await entry.parentHandle.removeEntry(entry.name);
}
async function preflightBrowserSourceDelete(images, permissionFailures = []) {
  const ready = []; const failed = [];
  const blocked = new Map(permissionFailures.map((failure) => [failure.imageId, failure]));
  for (const image of images) {
    if (image.sourceKind === "filesystem") { ready.push(image); continue; }
    try {
      if (blocked.has(image.id)) throw codedError(blocked.get(image.id).reason);
      if (!sourceCanDelete(image)) throw codedError("source_action_unavailable");
      const entry = browserDeleteEntry(image); if (!entry) throw codedError("source_action_unavailable");
      const directoryPermission = await entry.parentHandle.queryPermission?.({ mode: "readwrite" });
      if (directoryPermission && directoryPermission !== "granted") throw codedError("source_permission_denied");
      const resolved = await entry.parentHandle.getFileHandle(entry.name);
      if (resolved.isSameEntry && !await resolved.isSameEntry(entry.fileHandle)) throw codedError("stale_asset");
      const file = await resolved.getFile();
      if (file.size !== image.sizeBytes || file.lastModified * 1_000_000 !== image.mtimeNs) throw codedError("stale_asset");
      ready.push(image);
    } catch (error) { failed.push({ imageId: image.id, reason: error?.code || "source_delete_failed" }); }
  }
  return { ready, failed };
}

async function deleteBrowserSources(images, entries, onChanged = null, requestPermission = false) {
  const deleted = []; const failed = [];
  for (const image of images) {
    if (image.sourceKind === "filesystem") continue;
    try {
      const entry = entries.find((candidate) => candidate.imageId === image.id);
      if (!entry) throw codedError("source_action_unavailable");
      entry.state = "deleting"; await onChanged?.();
      await browserDeleteHandle(entry, image, requestPermission); entry.state = "deleted"; deleted.push(image.id);
      await onChanged?.();
    }
    catch (error) { failed.push({ imageId: image.id, reason: error?.code || "source_delete_failed" }); }
  }
  return { deleted, failed };
}

async function commitSourceDeleteWithRetry(payload) {
  try { return await catalogApi("/api/catalog/delete-source", payload, { method: "POST" }); }
  catch (error) {
    if (error?.code !== "connection_lost") throw error;
    // The source may already be gone while only the response was lost.  The
    // server keeps this token's receipt, so repeating it is safe.
    return catalogApi("/api/catalog/delete-source", payload, { method: "POST" });
  }
}
async function claimSourceDelete(deleteToken) {
  return catalogApi("/api/catalog/delete-source/claim", { deleteToken }, { method: "POST" });
}
async function releaseSourceDeleteClaim(deleteToken) {
  return catalogApi("/api/catalog/delete-source/release", { deleteToken }, { method: "POST" });
}

async function acknowledgeSourceDelete(deleteToken) {
  await api("/api/catalog/delete-source/ack", { method: "POST", body: JSON.stringify({ deleteToken }), resyncOnStale: false });
  await forgetPendingSourceDelete(deleteToken);
}

async function recoverPendingBrowserDeletes(pending) {
  const entries = Array.isArray(pending.browserEntries) ? pending.browserEntries : [];
  if (!entries.length) return { deleted: pending.browserDeletedImageIds || [], unresolved: false };
  let unresolved = false;
  for (const entry of entries.filter((candidate) => candidate.state === "deleting" || candidate.state === "unknown")) {
    try {
      await entry.parentHandle.getFileHandle(entry.name);
      entry.state = "ready";
    } catch (error) {
      if (error?.name === "NotFoundError") entry.state = "deleted";
      else { entry.state = "unknown"; unresolved = true; }
    }
  }
  pending.browserDeletedImageIds = entries.filter((entry) => entry.state === "deleted").map((entry) => entry.imageId);
  await rememberPendingSourceDelete(pending);
  return { deleted: pending.browserDeletedImageIds, unresolved };
}

async function resumePendingSourceDeletes(requestPermission = false) {
  const pendingDeletes = await pendingSourceDeletes();
  if (!pendingDeletes.length) return;
  for (const pending of pendingDeletes) {
    try {
      let status;
      try {
        status = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      } catch (error) {
        if (error?.code !== "source_delete_not_prepared" || pending.state !== "preparing") throw error;
        // The initial prepare request may never have reached the server. The
        // local durable intent includes the handle, so prepare it now instead
        // of throwing the user's copy+delete request away.
        const images = pending.imageIds.map((imageId) => state.images.find((image) => image.id === imageId)).filter(Boolean);
        const prepared = await catalogApi("/api/catalog/delete-source/prepare", { imageIds: images.map((image) => image.id), deleteToken: pending.deleteToken }, { method: "POST" });
        if (!pending.browserEntries?.length) pending.browserEntries = images.filter((image) => (prepared.preparedImageIds || []).includes(image.id)).map(browserDeleteEntry).filter(Boolean);
        pending.imageIds = prepared.preparedImageIds || pending.imageIds;
        pending.state = "prepared";
        await rememberPendingSourceDelete(pending);
        status = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      }
      const recovery = ["prepared", "claimed"].includes(status.state) ? await recoverPendingBrowserDeletes(pending) : { deleted: pending.browserDeletedImageIds || [], unresolved: false };
      if (["prepared", "claimed"].includes(status.state) && recovery.unresolved) continue;
      // A copy's output has already committed before it requests source
      // deletion.  Its durable intent explicitly retries the browser phase;
      // do not silently cancel that request and strand the user's deletion.
      if (pending.retryOnResume && ["prepared", "claimed"].includes(status.state) && !recovery.deleted.length) {
        if (status.state === "prepared") status = await claimSourceDelete(pending.deleteToken);
        const retryImages = pending.imageIds.map((imageId) => state.images.find((image) => image.id === imageId)).filter(Boolean);
        const browser = await deleteBrowserSources(retryImages, pending.browserEntries || [], async () => {
          pending.browserDeletedImageIds = pending.browserEntries.filter((entry) => entry.state === "deleted").map((entry) => entry.imageId);
          await rememberPendingSourceDelete(pending);
        }, requestPermission);
        recovery.deleted = browser.deleted;
        pending.browserDeletedImageIds = browser.deleted;
        await rememberPendingSourceDelete(pending);
        if (!recovery.deleted.length) {
          setStatus(t("sourceDelete.copyPending"), "warning");
          const known = new Map((state.pendingSourceDeleteEntries || []).map((entry) => [entry.imageId, entry]));
          for (const entry of pending.browserEntries || []) known.set(entry.imageId, entry);
          state.pendingSourceDeleteEntries = [...known.values()];
          $("#sourceDeleteResume").hidden = false;
          continue;
        }
      }
      if (status.state === "claimed" && !recovery.deleted.length) {
        await releaseSourceDeleteClaim(pending.deleteToken);
        status = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      }
      if (["prepared", "claimed"].includes(status.state) && recovery.deleted.length) {
        await commitSourceDeleteWithRetry({ imageIds: pending.imageIds, deleteToken: pending.deleteToken,
          browserDeletedImageIds: recovery.deleted });
      } else if (status.state === "prepared" && Object.values(status.preparedSourceKinds || {}).includes("filesystem")) {
        // Native files were never removed by the browser. Keep the durable
        // confirmation visible for an explicit retry instead of silently
        // cancelling it after a restart.
        setStatus(t("sourceDelete.confirmPending"), "warning");
        continue;
      } else if (status.state === "prepared") {
        await api("/api/catalog/delete-source/cancel", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      }
      const settled = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      if (["committed", "cancelled"].includes(settled.state)) await acknowledgeSourceDelete(pending.deleteToken);
    } catch (error) {
      if (pending.retryOnResume && isDefinitiveCommitRejection(error)
        && await restoreCopiedBrowserSourcesAfterRejectedDelete(pending)) continue;
      if (error?.code === "source_delete_not_prepared" && pending.state !== "preparing") await forgetPendingSourceDelete(pending.deleteToken);
      // Keep prepared and cleanup-pending operations until a terminal receipt is acknowledged.
    }
  }
  await resyncCatalog().catch(() => null);
}

async function resumePendingSourceDeletesFromUser() {
  $("#sourceDeleteResume").hidden = true;
  // Start the permission prompts synchronously inside the click turn. The
  // durable IDB handles were cached while showing this explicit control.
  const requests = (state.pendingSourceDeleteEntries || []).map((entry) => {
    try { return Promise.resolve(entry.parentHandle.requestPermission?.({ mode: "readwrite" })); } catch { return Promise.resolve("denied"); }
  });
  await Promise.all(requests);
  await resumePendingSourceDeletes(true);
}

window.addEventListener("online", () => { void resumePendingSourceDeletes(false).catch(() => {}); });

async function permanentlyDeleteImages(images, visibleImages) {
  if (!images.length || isBusy() || state.importing) return;
  const ids = images.map((image) => image.id);
  const title = ids.length === 1 ? t("confirm.removeImage.title") : t("confirm.removeImages.title");
  const message = ids.length === 1 ? t("confirm.removeImage.message") : t("confirm.removeImages.message", { count: ids.length });
  let resolveBrowserPermissions = null;
  if (!await confirmAction(title, message, "removeImage", () => { resolveBrowserPermissions = beginBrowserDeletePermissionRequests(images); })) return;
  const imageIds = new Set(ids);
  const selection = deletionSelectionSnapshot(imageIds, visibleImages);
  const token = crypto.randomUUID();
  state.catalogMutation = true; invalidatePendingImage(); updateActionButtons();
  try {
    // Claim the token locally before prepare. A close or lost prepare response
    // can now be reconciled on the next launch instead of leaving a server
    // receipt without an owner.
    await rememberPendingSourceDelete({ deleteToken: token, imageIds: ids, browserDeletedImageIds: [], browserEntries: [], state: "preparing" });
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    const permissionFailures = resolveBrowserPermissions ? await resolveBrowserPermissions() : [];
    const local = await preflightBrowserSourceDelete(images, permissionFailures);
    if (!local.ready.length) {
      await forgetPendingSourceDelete(token);
      const details = local.failed.map((failure) => `${failure.imageId}: ${failure.reason}`).join("、");
      console.warn("元画像を完全削除: 開始 対象=%d 成功=0 失敗=%d 詳細=%s", images.length, local.failed.length, details);
      setStatus(`元画像を0件削除しました。失敗${local.failed.length}件: ${details}`, "warning");
      showUserError(codedError(local.failed[0]?.reason || "source_action_unavailable"));
      return;
    }
    const prepared = await catalogApi("/api/catalog/delete-source/prepare", { imageIds: local.ready.map((image) => image.id), deleteToken: token }, { method: "POST" });
    const preparedIds = new Set(prepared.preparedImageIds || []);
    const preparedImages = local.ready.filter((image) => preparedIds.has(image.id));
    const pending = { deleteToken: token, imageIds: preparedImages.map((image) => image.id), browserDeletedImageIds: [],
      browserEntries: preparedImages.filter((image) => image.sourceKind !== "filesystem").map(browserDeleteEntry).filter(Boolean) };
    await rememberPendingSourceDelete(pending);
    await claimSourceDelete(token);
    const browser = await deleteBrowserSources(preparedImages, pending.browserEntries, async () => {
      pending.browserDeletedImageIds = pending.browserEntries.filter((entry) => entry.state === "deleted").map((entry) => entry.imageId);
      await rememberPendingSourceDelete(pending);
    });
    pending.browserDeletedImageIds = browser.deleted;
    await rememberPendingSourceDelete(pending);
    const browserDeleted = new Set(browser.deleted);
    const commitImages = preparedImages.filter((image) => image.sourceKind === "filesystem" || browserDeleted.has(image.id));
    let data = { images: state.images, removedImageIds: [], failed: [] };
    if (commitImages.length) data = await commitSourceDeleteWithRetry({
      imageIds: commitImages.map((image) => image.id), deleteToken: token, browserDeletedImageIds: browser.deleted,
    });
    else {
      await releaseSourceDeleteClaim(token);
      data = await api("/api/catalog/delete-source/cancel", { method: "POST", body: JSON.stringify({ deleteToken: token }), resyncOnStale: false });
      data = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: token }), resyncOnStale: false });
      await acknowledgeSourceDelete(token);
    }
    const removed = new Set(data.removedImageIds || []);
    for (const image of images.filter((item) => removed.has(item.id))) {
      releaseImageCaches(image.id); state.sourceAccess.delete(image.id); state.drafts.delete(image.id); state.maskStatus.delete(image.id); clearReviewForRemovedImage(image);
      state.selectedImageIds.delete(image.id);
    }
    state.images = data.images || state.images;
    if (state.project?.id && removed.size) await forgetProjectImageSources(state.project.id, [...removed]);
    loadReviewedPaths(); pruneSourceAccess();
    if (!state.images.length) { state.batchMode = false; clearBatchSelection(); }
    if (removed.has(selection.currentImageId) || removed.has(selection.pendingImageId)) clearCurrentImageSelection();
    renderCatalogViews(); updateSelectionActionBar();
    await restoreDeletionSelection(selection, imageIds);
    const failed = [...new Map([...local.failed, ...(prepared.failed || []), ...browser.failed, ...(data.failed || [])]
      .map((failure) => [`${failure.imageId || failure.relativePath || ""}:${failure.reason || ""}`, failure])).values()];
    const failureDetails = failed.map((failure) => `${failure.relativePath || failure.imageId}: ${failure.reason}`).join("、");
    const cleanupNotice = data.cleanupPendingCount ? ` 元画像ファイルの後処理${data.cleanupPendingCount}件を再試行します。` : "";
    if (failed.length) console.warn("元画像を完全削除: 対象=%d 成功=%d 失敗=%d 詳細=%s", images.length, removed.size, failed.length, failureDetails);
    setStatus(`元画像を${removed.size}件削除しました。${failed.length ? `失敗${failed.length}件: ${failureDetails}` : ""}${cleanupNotice}`, failed.length ? "warning" : "success");
    if (failed.length) showUserError(codedError(failed[0].reason));
    if (data.state === "committed") await acknowledgeSourceDelete(token);
  } catch (error) {
    await restoreDeletionSelection(selection, imageIds);
    showUserError(error);
  } finally { state.catalogMutation = false; updateActionButtons(); }
}

async function removeImageFromCatalog(imageId = state.contextMenuImageId) {
  if (!canRemoveCurrentImage() || imageId !== state.currentId) return;
  const image = state.images.find((item) => item.id === imageId);
  if (image) await permanentlyDeleteImages([image], galleryFilteredImages());
}

async function runSelectionAction(action) {
  const images = selectedImages(); if (!images.length || isBusy() || state.importing) return;
  if (catalogStagingEditsActive() && !["hide", "show", "reviewed", "unreviewed"].includes(action)) return;
  closeBatchMoreMenus();
  const ids = images.map((image) => image.id);
  if (["hide", "show", "reviewed", "unreviewed"].includes(action)) {
    const flags = action === "hide" ? { hidden: true } : action === "show" ? { hidden: false }
      : { reviewed: action === "reviewed" };
    const epoch = state.catalogEpoch; state.catalogMutation = true; updateActionButtons();
    try {
      await flushAllImageMutations();
      await flushAllWorkspaceMutations();
      const data = await api("/api/workspace/images", { method: "POST", body: JSON.stringify({ imageIds: ids, ...flags }) });
      if (!isCurrentCatalogEpoch(epoch)) return;
      for (const image of images) publishWorkspaceFlags(image.id, data.flags?.[image.id] || flags);
      preserveCatalogScroll(renderCatalogViews); updateSelectionActionBar(); updateNavigationControls();
    } catch (error) { if (isCurrentCatalogEpoch(epoch)) showUserError(error); }
    finally { state.catalogMutation = false; updateActionButtons(); }
    return;
  }
  if (action === "detect") return openDetectionDialog(images.filter(isProcessableImage).map((image) => image.id));
  if (action === "clear") return clearMasks(images.filter(isProcessableImage).map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message");
  if (action === "remove") {
    await permanentlyDeleteImages(images, overviewImages());
  }
}

function droppedFile(file, relativePath = file.name, fileHandle = null, parentHandle = null) {
  return { file, relativePath, fileHandle, parentHandle };
}

async function directFilesFromDrop(dataTransfer) {
  const handles = await Promise.all([...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFileSystemHandle()));
  const entries = [];
  async function collectHandle(handle, parent = "", parentHandle = null) {
    const relativePath = parent ? `${parent}/${handle.name}` : handle.name;
    if (handle.kind === "file") entries.push({ handle, relativePath, parentHandle });
    else for await (const entry of handle.values()) await collectHandle(entry, relativePath, handle);
  }
  for (const handle of handles) if (handle) await collectHandle(handle);
  return { handleEntries: entries };
}

function isSupportedImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function newClientKey() {
  return crypto.randomUUID();
}

function importFailure(entry, error) {
  const relativePath = String(entry?.relativePath || entry?.file?.name || entry?.fileHandle?.name || "");
  const unavailable = ["NotFoundError", "NotReadableError", "SecurityError"].includes(error?.name);
  return { relativePath, reason: unavailable ? "file_unavailable" : (error?.code || "image_read_failed") };
}

function isFileLocalImportFailure(error) {
  return ["image_read_failed", "image_format_unsupported"].includes(error?.code)
    || ["NotFoundError", "NotReadableError", "SecurityError"].includes(error?.name);
}

function showImportFailures(failures, loaded, invoker = document.activeElement) {
  if (!Array.isArray(failures) || !failures.length) return;
  const normalized = failures
    .filter((failure) => failure && typeof failure.relativePath === "string" && failure.relativePath)
    .map((failure) => ({ relativePath: failure.relativePath, reason: typeof failure.reason === "string" ? failure.reason : "image_read_failed" }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (!normalized.length) return;
  $("#importFailuresTitle").textContent = t("importFailures.title");
  $("#importFailuresSummary").textContent = t("importFailures.summary", { loaded, failed: normalized.length });
  const list = $("#importFailuresList"); list.textContent = "";
  for (const failure of normalized) {
    const item = document.createElement("li");
    const reason = t(`importFailures.reason.${failure.reason}`) || t("importFailures.reason.image_read_failed");
    item.textContent = `${failure.relativePath}: ${reason}`;
    list.append(item);
  }
  showModalFromInvoker($("#importFailuresDialog"), invoker);
}

function pruneSourceAccess() {
  const imageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.sourceAccess.keys()) if (!imageIds.has(imageId)) state.sourceAccess.delete(imageId);
  for (const [sourceId, source] of state.projectlessDirectorySources) {
    source.imageIds = new Set([...source.imageIds].filter((imageId) => imageIds.has(imageId)));
    if (!source.imageIds.size) state.projectlessDirectorySources.delete(sourceId);
  }
}

async function rememberImportedSource(result, session) {
  for (const imported of result.data.imported || []) {
    if (imported.clientKey !== result.clientKey || !result.entry.fileHandle || !imported.imageId) continue;
    state.sourceAccess.set(imported.imageId, {
      fileHandle: result.entry.fileHandle, parentHandle: result.entry.parentHandle || null,
      name: result.entry.file.name, size: result.entry.file.size, lastModified: result.entry.file.lastModified,
      sourceId: result.sourceId, clientKey: result.clientKey, relativePath: result.entry.relativePath, sourceKind: session.sourceKind,
    });
    if (session.sourceKind === "browser-directory") {
      const source = state.projectlessDirectorySources.get(result.sourceId);
      if (source) source.imageIds.add(imported.imageId);
      continue;
    }
    if (state.project?.id) await rememberProjectSource(state.project.id, result.entry.fileHandle, imported.imageId, result.sourceId, result.clientKey, result.entry.relativePath);
  }
}

async function importFiles(files) {
  const session = arguments.length > 1 ? arguments[1] : beginImportSession();
  if (!session || state.importSession !== session) return false;
  if (session.sourceKind === "browser-files") session.sourceId ||= crypto.randomUUID();
  const supportedFiles = [...files]
    .map((entry) => entry.file || entry.getFile ? entry : { file: entry, relativePath: entry.name, fileHandle: null, parentHandle: null })
    .filter((entry) => isSupportedImageFile(entry.file || { name: entry.name || entry.relativePath }));
  if (!supportedFiles.length) { finishImportSession(session); return true; }
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    await startImportServerSession(session);
    session.total = supportedFiles.length; session.completed = 0; session.successes = 0; session.failures = []; session.paused = false; session.cancelled = false;
    showProcessing({ kind: "import", state: "running", total: session.total, completed: 0, current: "" });
    session.requestedParallelism = importParallelism();
    const workerCount = Math.min(supportedFiles.length, session.requestedParallelism);
    session.parallelism = workerCount;
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
        if (session.cancelled) return;
        const index = nextIndex; nextIndex += 1;
        if (index >= supportedFiles.length) return;
        const descriptor = supportedFiles[index]; const clientKey = descriptor.clientKey || newClientKey();
        let file;
        try { file = descriptor.file || await descriptor.getFile(); }
        catch (error) {
          if (session.catalogId && descriptor.fileHandle && error?.name === "NotFoundError") {
            session.missingFileHandles = true;
            session.completed += 1;
            showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: descriptor.relativePath || descriptor.fileHandle.name });
            continue;
          }
          if (isFileLocalImportFailure(error)) {
            session.failures.push(importFailure(descriptor, error));
            session.completed += 1;
            showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: descriptor.relativePath || descriptor.fileHandle?.name || "" });
            continue;
          }
          throw error;
        }
        if (session.cancelled || state.importSession !== session) return;
        if (!isSupportedImageFile(file)) continue;
        const entry = { ...descriptor, file, relativePath: descriptor.relativePath || file.name };
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
        const stagedSource = Boolean(session.catalogId && session.sourceKind === "browser-files" && entry.fileHandle);
        if (stagedSource) await rememberProjectSource(session.catalogId, entry.fileHandle, null, session.sourceId, clientKey, entry.relativePath);
        let data;
        try { data = await importSingleFile(entry, clientKey, session.catalogId, session.sourceId, session.sourceKind, session.importIntent, session); }
        catch (error) {
          if (stagedSource && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
            await forgetPendingProjectSource(session.catalogId, session.sourceId, clientKey);
          }
          if (isFileLocalImportFailure(error)) {
            session.failures.push(importFailure(entry, error));
            session.completed += 1;
            showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
            continue;
          }
          throw error;
        }
        if (!session.catalogId && data.catalogId) session.catalogId = data.catalogId;
        const result = { entry, clientKey, data, sourceId: session.sourceId };
        // Keep source access for each committed upload, including a later
        // cancellation or an unrelated upload failure.
        await rememberImportedSource(result, session);
        session.completed += 1;
        session.successes += 1;
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
      }
    };
    const workers = Array.from({ length: workerCount }, worker);
    try {
      await Promise.all(workers);
    } catch (error) {
      // Do not schedule more files after an upload failure.  Wait for the
      // in-flight requests so the server can discard their temporary files.
      session.cancelled = true;
      await Promise.allSettled(workers);
      throw error;
    }
    if (!isCurrentCatalogEpoch(session.epoch) || state.importSession !== session) return false;
    if (session.cancelled) { setStatusKey("status.importCancelled", { completed: session.completed }); return false; }
    const capturedProjectId = state.project?.id || null;
    const capturedCatalogGeneration = state.serverCatalogGeneration;
    const latest = await api("/api/images");
    reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration);
    state.images = latest.images;
    loadReviewedPaths();
    if (session.missingFileHandles) showUserError({ code: "project_source_unavailable" });
    pruneSourceAccess(); renderCatalogViews(); setStatusKey("gallery.imported", { count: session.successes });
    showImportFailures(session.failures, session.successes);
    session.failed = session.failures.length > 0;
    return !session.missingFileHandles;
  } catch (error) {
    session.failed = true;
    try {
      const capturedProjectId = state.project?.id || null;
      const capturedCatalogGeneration = state.serverCatalogGeneration;
      const latest = await api("/api/images");
      reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration);
      if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) { state.images = latest.images; loadReviewedPaths(); renderCatalogViews(); }
    } catch { /* Keep the import failure visible. */ }
    if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) showUserError(error);
    return false;
  } finally {
    await finishImportServerSession(session);
    finishImportSession(session);
  }
}

async function importSingleFile(entry, clientKey, catalogId = null, sourceId = null, sourceKind = null, importIntent = "add", session = null) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  const response = await fetch("/api/import/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mozarie-Token": token,
      "X-Mozarie-Name": encodeURIComponent(entry.file.name),
      "X-Mozarie-Relative-Path": encodeURIComponent(entry.relativePath),
      "X-Mozarie-Client-Key": encodeURIComponent(clientKey),
      "X-Mozarie-File-Mtime": String(Math.max(0, Number(entry.file.lastModified || 0))),
      "X-Mozarie-File-Size": String(Math.max(0, Number(entry.file.size || 0))),
      ...(sourceId ? { "X-Mozarie-Source-Id": encodeURIComponent(sourceId) } : {}),
      ...(sourceKind ? { "X-Mozarie-Source-Kind": sourceKind } : {}),
      "X-Mozarie-Import-Intent": importIntent,
      "X-Mozarie-Import-Session": session?.id || "",
      ...(catalogId ? { "X-Mozarie-Catalog-Id": encodeURIComponent(catalogId) } : {}),
      "X-Mozarie-Expected-Project-Id": encodeURIComponent(session?.expectedProjectId ?? state.project?.id ?? ""),
      ...(Number.isSafeInteger(session?.expectedCatalogGeneration) ? { "X-Mozarie-Expected-Catalog-Generation": String(session.expectedCatalogGeneration) } : {}),
    },
    body: entry.file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = responseError(response, data);
    await resyncAfterStaleCatalog(error);
    throw error;
  }
  applyCatalogGeneration(data);
  return data;
}

function beginImportSession({ allowDuringCatalogTransition = false } = {}) {
  if (isBusy() || state.importing || (state.catalogTransition && !allowDuringCatalogTransition)) {
    setStatusKey("status.importUnavailable");
    return null;
  }
  const session = { id: newClientKey(), epoch: state.catalogTransition?.epoch || beginCatalogEpoch(), expectedProjectId: state.project?.id || "", expectedCatalogGeneration: state.serverCatalogGeneration, paused: false, cancelled: false, failed: false, completed: 0, total: 0, catalogId: null, sourceId: null, sourceKind: "browser-files", importIntent: "add", serverStarted: false };
  state.importing = true; state.importSession = session;
  updateActionButtons();
  return session;
}

async function finishImportServerSession(session) {
  if (!session?.serverStarted || !Number.isSafeInteger(session.expectedCatalogGeneration)) return;
  try {
    await api("/api/import/finish", { method: "POST", body: JSON.stringify({
      sessionId: session.id,
      expectedProjectId: session.expectedProjectId,
      expectedCatalogGeneration: session.expectedCatalogGeneration,
      completed: session.completed,
      failed: Boolean(session.failed),
      cancelled: Boolean(session.cancelled),
    }) });
  } catch { /* A later explicit start replaces an inactive unfinished batch. */ }
}

async function startImportServerSession(session) {
  if (!session?.id || !Number.isSafeInteger(session.expectedCatalogGeneration)) return;
  await api("/api/import/start", { method: "POST", body: JSON.stringify({
    sessionId: session.id,
    expectedProjectId: session.expectedProjectId,
    expectedCatalogGeneration: session.expectedCatalogGeneration,
  }) });
  session.serverStarted = true;
}

function remapImportedImageIds(imageIds) {
  const map = new Map(Object.entries(imageIds).filter(([from, to]) => from && to && from !== to));
  if (!map.size) return;
  const remapMap = (source) => new Map([...source].map(([id, value]) => [map.get(id) || id, value]));
  state.sourceAccess = remapMap(state.sourceAccess);
  state.drafts = remapMap(state.drafts);
  state.maskStatus = remapMap(state.maskStatus);
  for (const [sourceId, source] of state.projectlessDirectorySources) {
    source.imageIds = new Set([...source.imageIds].map((id) => map.get(id) || id));
    if (!source.imageIds.size) state.projectlessDirectorySources.delete(sourceId);
  }
  state.selectedImageIds = new Set([...state.selectedImageIds].map((id) => map.get(id) || id));
  if (state.currentId) state.currentId = map.get(state.currentId) || state.currentId;
  if (state.pendingImageId) state.pendingImageId = map.get(state.pendingImageId) || state.pendingImageId;
}

function finishImportSession(session) {
  if (state.importSession !== session) return;
  state.importSession = null; state.importing = false;
  closeProcessing();
  updateActionButtons();
}

async function waitForImportSession(session) {
  while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
  return !session.cancelled && state.importSession === session;
}

async function importHandleEntries(entries, session) {
  return importFiles(entries.map((entry) => ({
    ...entry, name: entry.handle.name, getFile: () => entry.handle.getFile(), fileHandle: entry.handle,
  })), session);
}

async function importFileHandles(handles, session = beginImportSession()) {
  if (!session) return false;
  session.sourceId ||= crypto.randomUUID();
  session.sourceKind = "browser-files";
  return importHandleEntries(handles.map((item) => {
    const handle = item?.handle || item;
    return { handle, clientKey: item?.clientKey || null, relativePath: item?.relativePath || handle.name, parentHandle: null };
  }), session);
}

async function importDirectoryHandle(directoryHandle, session = beginImportSession()) {
  if (!session) return;
  await flushAllImageMutations();
  await flushAllWorkspaceMutations();
  session.catalogId = await catalogForDirectoryHandle(directoryHandle);
  session.sourceId = await rememberProjectSource(session.catalogId, directoryHandle, null, state.pendingDirectorySourceId || session.sourceId);
  session.sourceKind = "browser-directory";
  state.pendingDirectorySourceId = null;
  const projectlessSource = !session.catalogId
    ? { handle: directoryHandle, imageIds: new Set() }
    : null;
  if (projectlessSource) state.projectlessDirectorySources.set(session.sourceId, projectlessSource);
  const entries = [];
  try {
    showProcessing({ kind: "import", state: "running", total: 1, completed: 0, current: directoryHandle.name || "" });
    async function collect(handle, relativePath = "", parentHandle = null) {
      if (!await waitForImportSession(session)) return;
      const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
      if (handle.kind === "file") entries.push({ handle, relativePath: path, parentHandle });
      else for await (const child of handle.values()) await collect(child, path, handle);
    }
    for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
    if (!await waitForImportSession(session)) return finishImportSession(session);
    await importHandleEntries(entries, session);
  }
  finally {
    if (projectlessSource && !projectlessSource.imageIds.size) state.projectlessDirectorySources.delete(session.sourceId);
  }
}

async function importProjectDirectoryHandle(directoryHandle, projectId, sourceId = null, importIntent = "add") {
  const session = beginImportSession({ allowDuringCatalogTransition: true }); if (!session) return;
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    session.catalogId = projectId;
    session.sourceId = await rememberProjectSource(projectId, directoryHandle, null, sourceId);
    session.sourceKind = "browser-directory";
    session.importIntent = importIntent;
    const entries = [];
    showProcessing({ kind: "import", state: "running", total: 1, completed: 0, current: directoryHandle.name || "" });
    async function collect(handle, relativePath = "", parentHandle = null) {
      if (!await waitForImportSession(session)) return;
      const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
      if (handle.kind === "file") entries.push({ handle, relativePath: path, parentHandle });
      else for await (const child of handle.values()) await collect(child, path, handle);
    }
    for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
    if (await waitForImportSession(session) && !await importHandleEntries(entries, session)) throw codedError("project_source_unavailable");
  } finally { finishImportSession(session); }
}

async function importProjectFileHandles(sources, projectId) {
  // File handles are stored one row per image.  Restore them in their original
  // source groups so their durable image IDs, masks, and history are reused.
  const groups = new Map();
  for (const source of sources) {
    const handle = source?.handle || source;
    if (!handle) continue;
    const sourceId = source?.sourceId || crypto.randomUUID();
    const handles = groups.get(sourceId) || [];
    handles.push({ handle, clientKey: source?.clientKey || null, relativePath: source?.relativePath || handle.name }); groups.set(sourceId, handles);
  }
  const failures = [];
  for (const [sourceId, handles] of groups) {
    const session = beginImportSession({ allowDuringCatalogTransition: true }); if (!session) return failures;
    try {
      await flushAllWorkspaceMutations();
      session.catalogId = projectId;
      session.sourceId = sourceId;
      session.sourceKind = "browser-files";
      session.importIntent = "restore";
      if (!await importFileHandles(handles, session)) failures.push(...handles);
    } catch (error) { failures.push(...handles); }
    finally { finishImportSession(session); }
  }
  return failures;
}

async function pickImageFiles() {
  $("#pickerMenu").hidePopover();
  const session = beginImportSession(); if (!session) return;
  try { await importFileHandles(await window.showOpenFilePicker({ multiple: true, types: [{ description: "Images", accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] } }] }), session); }
  catch (error) { if (error?.name !== "AbortError") showUserError(error); finishImportSession(session); }
}

async function pickImageDirectory() {
  $("#pickerMenu").hidePopover();
  const session = beginImportSession(); if (!session) return;
  try { await importDirectoryHandle(await window.showDirectoryPicker({ mode: "read", id: "mozarie-source" }), session); }
  catch (error) {
    if (error?.name === "AbortError") setStatusKey("status.folderPickerCancelled");
    else { setStatusKey("status.folderPickerFailed"); showUserError(error); }
  } finally { finishImportSession(session); }
}

async function importDroppedFiles(event) {
  event.preventDefault();
  event.stopPropagation();
  setGalleryDropOverlay(false);
  const session = beginImportSession();
  if (!session) return;
  try {
    const dropped = await directFilesFromDrop(event.dataTransfer);
    if (dropped?.handleEntries) await importHandleEntries(dropped.handleEntries, session);
    else await importFiles(dropped, session);
  } catch (error) { showUserError(error); }
  finally { finishImportSession(session); setGalleryDropOverlay(false); }
}

function setGalleryDropOverlay(visible) {
  $("#galleryDropOverlay").hidden = !visible;
}

function handleEditorKeydown(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || isTextEditableTarget(document.activeElement) || hasOpenDialog()) return false;
  if (state.viewMode !== "edit") return false;
  const binding = shortcutFromEvent(event);
  const shortcuts = state.settings?.shortcuts?.bindings || { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const enabled = state.settings?.shortcuts?.actions || {};
  const direction = binding === shortcuts.redo ? "redo" : "undo";
  const historyBinding = (binding === shortcuts.undo && enabled.undo !== false) || (binding === shortcuts.redo && enabled.redo !== false);
  if (!currentImageActionPending() && !state.projectReadOnly && currentRecord() && !currentRecord()?.sourceDimensionsChanged && historyBinding) {
    event.preventDefault();
    if (hasDurableHistory()) {
      if (canRestoreProjectHistory(direction)) void restoreProjectHistory(direction);
    } else if (direction === "undo" ? state.historyIndex > 0 : state.historyIndex < state.history.length) {
      void restoreSnapshot(direction === "redo" ? state.historyIndex + 1 : state.historyIndex - 1);
    }
    return true;
  }
  return false;
}

function navigationShortcutAction(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || hasOpenDialog()) return null;
  const binding = shortcutFromEvent(event);
  const bindings = state.settings?.shortcuts?.bindings || { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", reviewAndNext: "Enter", removeImage: "Delete", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", renameImage: "F2" };
  const actionForBinding = Object.entries(bindings).find(([, value]) => value === binding)?.[0];
  if (!actionForBinding || state.settings?.shortcuts?.actions?.[actionForBinding] === false) return null;
  const currentGalleryItem = document.activeElement?.matches("button.gallery-item.current") && document.activeElement.dataset.id === state.currentId;
  const focusedCatalogItem = document.activeElement?.matches("button.gallery-item, button.overview-item");
  if (isEditableTarget(document.activeElement) && !(actionForBinding === "removeImage" && currentGalleryItem) && !(actionForBinding === "renameImage" && focusedCatalogItem)) return null;
  if (actionForBinding === "toggleOverview") return "toggleOverview";
  if (actionForBinding === "renameImage") {
    const focusedId = document.activeElement?.matches("button.gallery-item, button.overview-item") ? document.activeElement.dataset.id : state.currentId;
    return canRenameCatalogImage(state.images.find((image) => image.id === focusedId)) ? { action: "renameImage", imageId: focusedId } : null;
  }
  if (state.viewMode !== "edit") return null;
  if (actionForBinding === "removeImage" && event.repeat) return "removeImageRepeat";
  if (actionForBinding === "removeImage" && !canRemoveCurrentImage()) return null;
  if ((currentImageActionPending() || state.projectReadOnly || currentRecord()?.sourceDimensionsChanged
    || (!currentRecord() && ["undo", "redo"].includes(actionForBinding)))
    && ["reviewAndNext", "undo", "redo"].includes(actionForBinding)) return null;
  return actionForBinding;
}

function handleNavigationKeydown(event) {
  const result = navigationShortcutAction(event);
  if (!result) return false;
  const action = typeof result === "string" ? result : result.action;
  event.preventDefault();
  if (action === "toggleOverview") setViewMode(state.viewMode === "overview" ? "edit" : "overview");
  else if (action === "renameImage") openRenameImageDialog(result.imageId);
  else if (action === "previous") moveCurrentBy(-1);
  else if (action === "next") moveCurrentBy(1);
  else if (action === "previousVisible") moveCurrentBy(-1);
  else if (action === "nextVisible") moveCurrentBy(1);
  else if (action === "first" && galleryFilteredImages()[0]) void selectImage(galleryFilteredImages()[0].id);
  else if (action === "last" && galleryFilteredImages().at(-1)) void selectImage(galleryFilteredImages().at(-1).id);
  else if (action === "reviewAndNext") void reviewAndMoveNext();
  else if (action === "removeImage") void removeImageFromCatalog(state.currentId);
  else if (action === "undo") { if (hasDurableHistory()) { if (canRestoreProjectHistory("undo")) void restoreProjectHistory("undo"); } else if (state.historyIndex > 0) void restoreSnapshot(state.historyIndex - 1); }
  else if (action === "redo") { if (hasDurableHistory()) { if (canRestoreProjectHistory("redo")) void restoreProjectHistory("redo"); } else if (state.historyIndex < state.history.length) void restoreSnapshot(state.historyIndex + 1); }
  return true;
}

function handleWindowKeydown(event) {
  if (handleEditorKeydown(event)) return;
  handleNavigationKeydown(event);
}
