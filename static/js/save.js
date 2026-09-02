function setApplyResult(message, error = false) {
  if (error) { showUserError(message, $("#applyStartButton")); return; }
  const result = $("#applyResult"); result.textContent = message; result.classList.toggle("error", false);
}

function showApplyError(error, invoker = $("#applyStartButton")) {
  setApplyResult("");
  showUserError(error, invoker);
}

function isTerminalApply(job) {
  if (job.kind !== "apply" || !["complete", "cancelled", "error"].includes(job.state)) return false;
  return state.applyRunning || (job.startedAt != null && state.handledApplyStartedAt !== job.startedAt);
}

function selectedSaveMode() { return document.querySelector('input[name="batchSaveMode"]:checked').value; }
function sourceAccessFor(imageId) { return state.sourceAccess.get(imageId) || null; }
function sourceCanOverwrite(image) { return image?.sourceKind === "filesystem" || Boolean(sourceAccessFor(image?.id)?.fileHandle); }
function sourceCanDelete(image) {
  if (image?.sourceKind === "filesystem") return true;
  const access = sourceAccessFor(image?.id);
  return Boolean(access?.fileHandle && access.parentHandle);
}
function applyTargetsSupport(capability) {
  return state.applyTargetIds.every((imageId) => {
    const image = state.images.find((entry) => entry.id === imageId);
    return capability === "overwrite" ? sourceCanOverwrite(image) : sourceCanDelete(image);
  });
}
function applyRestrictionMessage() {
  const noOverwrite = state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId)));
  const noDelete = state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId)));
  if (selectedSaveMode() === "overwrite" && noOverwrite.length) return t("apply.overwriteUnavailable", { count: noOverwrite.length });
  if (selectedSaveMode() === "copy" && $("#deleteOriginal").checked && noDelete.length) return t("apply.deleteUnavailable", { count: noDelete.length });
  return "";
}

function syncApplyMode() {
  const canOverwrite = applyTargetsSupport("overwrite");
  const canDelete = applyTargetsSupport("delete");
  const copying = selectedSaveMode() === "copy";
  $("#applySuffixRow").hidden = !copying;
  $("#deleteOriginalRow").hidden = !copying;
  $("#applyOutputDirectoryRow").hidden = !copying;
  $("#applySuffix").disabled = state.applyRunning;
  $("#applyTargetMode").disabled = state.applyRunning || state.saveStarting;
  $("#chooseOutputDirectoryButton").disabled = state.outputDirectoryPicking || state.applyRunning || state.saveStarting;
  $("#applyOutputDirectoryStatus").value = state.outputDirectoryHandle?.name || t("apply.outputDirectoryUnset");
  $("#deleteOriginal").disabled = !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#removeAfterSave").disabled = state.applyRunning;
  $("#applyOverwriteMode").disabled = !canOverwrite || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", !canOverwrite);
  const restriction = applyRestrictionMessage();
  const capabilityNote = !canOverwrite
    ? t("apply.overwriteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId))).length })
    : (!canDelete ? t("apply.deleteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId))).length }) : "");
  $("#applyTemporarySourceNote").textContent = restriction || capabilityNote || t("apply.handleSource");
  $("#applyTemporarySourceNote").hidden = !restriction && !capabilityNote;
  $("#applyStartButton").disabled = Boolean(restriction) || state.applyRunning || state.saveStarting || state.applyTargetIds.length === 0 || (copying && !state.outputDirectoryHandle);
}

function refreshApplyTargets() {
  const mode = $("#applyTargetMode").value;
  state.applyTargetMode = mode; state.applyTargetIds = saveTargets(mode);
  $("#applyTargetCount").textContent = t("apply.target", { count: state.applyTargetIds.length });
  syncApplyMode();
}

async function openApplyDialog(options = {}) {
  const invoker = document.activeElement;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const initialMode = Array.isArray(options) ? "current" : (options.initialMode || "masked");
  if (isBusy() || state.importing) return;
  try { await flushDraftSaves(); }
  catch (error) { showUserError(error); return; }
  $("#applyTargetMode").value = initialMode;
  refreshApplyTargets();
  if (!state.applyTargetIds.length) return;
  state.applyRunning = false;
  $("#applyDivisor").value = $("#divisor").value;
  updateBlockSizeDisplay();
  $("#applyProgressPanel").hidden = true;
  $("#applyStartButton").hidden = false;
  $("#applyCloseButton").hidden = false;
  $("#applyPauseButton").hidden = true;
  $("#applyCancelButton").hidden = true;
  $("#applySettings").disabled = false;
  setApplyResult(""); syncApplyMode();
  showModalFromInvoker($("#applyDialog"), invoker);
}

function selectedSingleSaveMode() { return document.querySelector('input[name="singleSaveMode"]:checked').value; }
function setSingleSaveResult(message, error = false) {
  const result = $("#singleSaveResult"); result.textContent = message; result.classList.toggle("error", error);
}
function syncSingleSaveMode() {
  const save = state.singleSave;
  const image = state.images.find((entry) => entry.id === save?.imageId);
  const copying = selectedSingleSaveMode() === "copy";
  const canOverwrite = sourceCanOverwrite(image);
  const canDelete = sourceCanDelete(image);
  $("#singleSaveSuffixRow").hidden = !copying;
  $("#singleSaveDeleteOriginalRow").hidden = !copying;
  $("#singleSaveOutputDirectoryRow").hidden = !copying;
  $("#singleSaveOverwriteMode").disabled = !canOverwrite || state.saving || state.saveStarting;
  $("#singleSaveOverwriteRow").classList.toggle("muted", !canOverwrite);
  $("#singleSaveDeleteOriginal").disabled = !canDelete || state.saving || state.saveStarting;
  if (!canDelete) $("#singleSaveDeleteOriginal").checked = false;
  $("#singleSaveChooseOutputDirectoryButton").disabled = state.outputDirectoryPicking || state.saving || state.saveStarting;
  $("#singleSaveStartButton").disabled = state.saving || state.saveStarting || !image || (copying && !state.outputDirectoryHandle) || (!copying && !canOverwrite);
  $("#singleSaveSettings").disabled = state.saving || state.saveStarting;
  renderOutputDirectory();
}

async function openSingleSaveDialog(imageId = state.currentId) {
  const invoker = document.activeElement;
  if (!imageId || isBusy() || state.importing) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  try { await flushDraftSaves([imageId]); }
  catch (error) { showUserError(error, invoker); return; }
  const image = state.images.find((entry) => entry.id === imageId);
  if (!image || isBusy() || state.importing) return;
  state.singleSave = { imageId, divisor: Number($("#divisor").value), draft: draftPayload([imageId])[imageId] || null, invoker };
  $("#singleSaveCopyMode").checked = true;
  $("#singleSaveDeleteOriginal").checked = false;
  setSingleSaveResult("");
  syncSingleSaveMode();
  showModalFromInvoker($("#singleSaveDialog"), invoker);
}

async function chooseSingleOutputDirectory() {
  if (state.saving || state.saveStarting) return;
  try { await pickOutputDirectory(); setSingleSaveResult(""); }
  catch (error) { if (error?.name !== "AbortError") { setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true); showUserError(error, $("#singleSaveChooseOutputDirectoryButton")); } }
  syncSingleSaveMode();
}

function singleOutputName(relativePath, suffix, sequence = 0) {
  const name = String(relativePath).split("/").at(-1) || "image";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${stem}${suffix}${sequence ? `_${sequence}` : ""}${extension}`;
}

async function writeSingleOutput(handle, relativePath, suffix, response) {
  if (!navigator.locks || typeof navigator.locks.request !== "function") throw codedError("output_write_unsupported");
  let entered = false;
  try {
    return await navigator.locks.request("mozarie-output-write", { mode: "exclusive" }, async () => {
      entered = true;
      let fileHandle; let name; let created = false;
      for (let sequence = 0; sequence < 10000; sequence += 1) {
        name = singleOutputName(relativePath, suffix, sequence);
        try { await handle.getFileHandle(name); }
        catch (error) {
          if (error?.name !== "NotFoundError") throw error;
          fileHandle = await handle.getFileHandle(name, { create: true }); created = true; break;
        }
      }
      if (!fileHandle) { const error = new Error("output_name_exhausted"); error.code = "output_name_exhausted"; throw error; }
      let stream;
      try {
        try { stream = await fileHandle.createWritable({ keepExistingData: false, mode: "exclusive" }); }
        catch (error) {
          if (["TypeError", "NotSupportedError"].includes(error?.name)) throw codedError("output_write_unsupported");
          throw error;
        }
        await response.body.pipeTo(stream);
      } catch (error) {
        try { await stream?.abort?.(); } catch {}
        if (created) {
          try { await handle.removeEntry(name); }
          catch (cleanupError) {
            const cleanupFailure = codedError("output_cleanup_failed");
            cleanupFailure.cause = error;
            cleanupFailure.cleanupCause = cleanupError;
            throw cleanupFailure;
          }
        }
        throw error;
      }
      return { name, fileHandle };
    });
  } catch (error) {
    if (!entered) {
      const lockFailure = codedError("output_write_unsupported");
      lockFailure.cause = error;
      throw lockFailure;
    }
    throw error;
  }
}

async function renderSingleSave(payload) {
  const response = await fetch("/api/save/render", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})); const error = new Error("save_render_failed"); error.code = body.error_code || "internal_error"; error.status = response.status; throw error;
}

async function startSingleSave(event) {
  event.preventDefault();
  const save = state.singleSave;
  const image = state.images.find((entry) => entry.id === save?.imageId);
  if (!save || !image || state.saving || state.saveStarting || isBusy() || state.importing) return;
  const mode = selectedSingleSaveMode(); const copying = mode === "copy";
  const deleteOriginal = copying && $("#singleSaveDeleteOriginal").checked;
  const suffix = $("#singleSaveSuffix").value;
  if (copying && !state.outputDirectoryHandle) return syncSingleSaveMode();
  state.saveStarting = true;
  syncSingleSaveMode();
  try {
    if (copying) await ensureOutputDirectoryPermission();
    if (!copying && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
    if (deleteOriginal && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
    state.saving = true; updateActionButtons(); syncSingleSaveMode(); setSingleSaveResult("");
    let entry; let saveToken = ""; let output = null; let sourceSnapshot = null; let sourceChanged = false;
    try {
    const prepared = await api("/api/save/prepare", { method: "POST", body: JSON.stringify({ imageIds: [save.imageId], divisor: save.divisor, suffix, deleteOriginal: false }) });
    entry = prepared.entries?.[0]; if (!entry) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
    const access = sourceAccessFor(save.imageId);
    if (!copying) await ensureSaveSources([save.imageId], "overwrite", false);
    const response = await renderSingleSave({ imageId: save.imageId, candidateRevision: entry.candidateRevision, divisor: save.divisor, draft: save.draft, copyToBrowser: copying, suffix });
    saveToken = response.headers.get("X-Mozarie-Save-Token") || "";
    if (!saveToken) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
    let sourceAction = "overwrite";
    if (copying) {
      output = await writeSingleOutput(state.outputDirectoryHandle, entry.relativePath, suffix, response);
      sourceAction = deleteOriginal ? "deleted" : "keep";
      if (deleteOriginal && access?.fileHandle) { await ensureHandlePermission(access, true); sourceSnapshot = await snapshotSourceHandle(access); await removeSourceHandle(access); sourceChanged = true; }
    } else if (access?.fileHandle) {
      sourceSnapshot = await snapshotSourceHandle(access); await writeSourceHandle(access, response); sourceChanged = true;
    }
    let committed;
    try { committed = await commitBrowserSaveWithRetry({ imageId: save.imageId, candidateRevision: entry.candidateRevision, saveToken, sourceAction }); }
    catch (error) {
      if (error.saveState === "pending") await cancelBrowserSave(entry, saveToken);
      if (sourceChanged && (isDefinitiveCommitRejection(error) || error.saveState === "pending")) await restoreSourceHandle(access, sourceSnapshot, deleteOriginal);
      if (output) await state.outputDirectoryHandle.removeEntry(output.name).catch(() => {});
      throw error;
    }
    const latest = await api("/api/images"); state.images = latest.images;
    const savedImage = state.images.find((item) => item.id === save.imageId);
    if (savedImage) await setReviewed(savedImage, true);
    state.drafts.delete(save.imageId); state.maskStatus.delete(save.imageId); pruneSourceAccess();
    if (savedImage && state.currentId === save.imageId) await selectImage(save.imageId, true, { saveCurrentDraft: false });
    renderCatalogViews();
    setSingleSaveResult(copying ? `${t("apply.complete", { completed: 1 })} ${state.outputDirectoryHandle.name}/${output.name}` : t("apply.complete", { completed: 1 }));
    } catch (error) {
      if (saveToken && entry) await cancelBrowserSave(entry, saveToken);
      setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true); showUserError(error, $("#singleSaveStartButton"));
    } finally {
      state.saving = false; updateActionButtons(); syncSingleSaveMode();
    }
  } catch (error) {
    setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true);
    showUserError(error, $("#singleSaveStartButton"));
  } finally {
    state.saveStarting = false; updateActionButtons(); syncSingleSaveMode();
  }
}

function draftPayload(imageIds) {
  const drafts = {};
  for (const imageId of imageIds) {
    const draft = state.drafts.get(imageId);
    if (draft) drafts[imageId] = {
      add: draft.manualEnabled === false ? "" : draft.add,
      exclusion: draft.manualExclusionEnabled === false ? "" : draft.exclusion,
      exclusionErase: draft.manualExclusionEraseEnabled === false ? "" : draft.exclusionErase,
      manualExclusionForced: draft.manualExclusionForced ?? (state.settings?.detection?.exclude_forced_default !== false),
      removedCandidateIds: draft.removedCandidateIds || [],
    };
  }
  return drafts;
}

function renderOutputDirectory() {
  const configuredDirectory = state.settings?.saving?.default_output_directory || "";
  const directory = state.outputDirectoryHandle?.name || "";
  $("#settingsDefaultOutputDirectory").value = configuredDirectory;
  $("#applyOutputDirectoryStatus").value = directory || t("apply.outputDirectoryUnset");
  $("#singleSaveOutputDirectoryStatus").textContent = directory ? t("apply.outputDirectorySelected", { name: directory }) : t("apply.outputDirectoryUnset");
  syncApplyMode();
}

let outputDirectoryPickRequest = null;

function setOutputDirectoryPickerBusy(picking) {
  state.outputDirectoryPicking = picking;
  $("#settingsChooseOutputDirectory").disabled = picking;
  syncApplyMode();
}

async function pickOutputDirectory() {
  if (!outputDirectoryPickRequest) {
    setOutputDirectoryPickerBusy(true);
    if (typeof window.showDirectoryPicker !== "function") {
      const error = new Error("directory_picker_unsupported"); error.code = "directory_picker_unsupported";
      setOutputDirectoryPickerBusy(false);
      throw error;
    }
    outputDirectoryPickRequest = window.showDirectoryPicker({ mode: "readwrite", id: "mozarie-output" })
      .then(async (handle) => {
        await ensureOutputDirectoryPermission(handle);
        state.outputDirectoryHandle = handle;
        await rememberOutputDirectoryHandle(handle);
        renderOutputDirectory();
        return handle;
      })
      .finally(() => {
        outputDirectoryPickRequest = null;
        setOutputDirectoryPickerBusy(false);
      });
  }
  return outputDirectoryPickRequest;
}

async function ensureOutputDirectoryPermission(handle = state.outputDirectoryHandle) {
  if (!handle) throw codedError("output_permission_denied");
  try {
    const options = { mode: "readwrite" };
    let permission = await handle.queryPermission(options);
    if (permission === "prompt") permission = await handle.requestPermission(options);
    if (permission === "granted") return handle;
  } catch {}
  throw codedError("output_permission_denied");
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting) return;
  try {
    if (!await pickOutputDirectory()) return;
    setApplyResult("");
  } catch (error) { if (error?.name !== "AbortError") showApplyError(error, $("#chooseOutputDirectoryButton")); }
}

async function waitForBrowserSave(save) {
  while (save.paused && !save.cancelled && !save.failed) await new Promise((resolve) => setTimeout(resolve, 100));
  return !save.cancelled && !save.failed;
}

function showBrowserSaveProgress(save, entry) {
  state.job = { kind: "apply", state: save.paused ? "paused" : "running", total: save.entries.length, completed: save.completed, current: entry?.relativePath || "" };
  $("#applyProgress").max = Math.max(1, save.entries.length);
  $("#applyProgress").value = save.completed;
  $("#applyCurrentName").textContent = entry?.relativePath || "";
  $("#applyProgressText").textContent = t("apply.progress", { completed: save.completed, total: save.entries.length });
  $("#applyPauseButton").textContent = t(save.paused ? "apply.resume" : "apply.pause");
}

function reconcileStoredMaskStatuses() {
  const remainingImageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.maskStatus.keys()) {
    if (!remainingImageIds.has(imageId)) state.maskStatus.delete(imageId);
  }
  for (const image of state.images) {
    const draft = state.drafts.get(image.id);
    if (!draft) {
      state.maskStatus.delete(image.id);
      continue;
    }
    state.maskStatus.set(image.id, draft.hasEffectiveMask === true);
  }
}

function reconcileBrowserSaveState() {
  reconcileStoredMaskStatuses();
  if (state.currentId && !state.images.some((image) => image.id === state.currentId)) {
    const removedCurrentId = state.currentId;
    state.currentId = null;
    state.currentImage = null;
    releaseCandidateBundles(removedCurrentId);
    state.candidates = [];
    clearEditor();
  } else if (state.currentId) {
    refreshMaskStatus();
    renderCandidates();
    render();
  }
  renderCatalogViews();
}

async function ensureHandlePermission(access, requireWrite = true) {
  const handle = access?.fileHandle;
  if (!handle) return;
  const options = requireWrite ? { mode: "readwrite" } : { mode: "read" };
  let permission = await handle.queryPermission?.(options);
  if (permission !== "granted") permission = await handle.requestPermission?.(options);
  if (permission && permission !== "granted") throw codedError("source_permission_denied");
  const file = await handle.getFile();
  if (access.size != null && (file.size !== access.size || file.lastModified !== access.lastModified)) {
    throw codedError("stale_asset");
  }
}

async function ensureSaveSources(imageIds, mode, deleteOriginal) {
  for (const imageId of imageIds) {
    const image = state.images.find((entry) => entry.id === imageId);
    const access = sourceAccessFor(imageId);
    if (mode === "overwrite" && !sourceCanOverwrite(image)) throw codedError("source_action_unavailable");
    if (mode === "copy" && deleteOriginal && !sourceCanDelete(image)) throw codedError("source_action_unavailable");
    if (access?.fileHandle) await ensureHandlePermission(access, mode === "overwrite" || deleteOriginal);
  }
}

async function writeSourceHandle(access, response) {
  let stream;
  try {
    stream = await access.fileHandle.createWritable({ keepExistingData: false, mode: "exclusive" });
  } catch (error) {
    if (["NoModificationAllowedError", "InvalidStateError"].includes(error?.name)) {
      throw codedError("source_busy");
    }
    if (["TypeError", "NotSupportedError"].includes(error?.name)) throw codedError("source_write_unsupported");
    throw error;
  }
  try {
    await response.body.pipeTo(stream);
    const file = await access.fileHandle.getFile();
    access.name = file.name;
    access.size = file.size;
    access.lastModified = file.lastModified;
  }
  catch (error) { try { await stream.abort?.(); } catch { /* Preserve the original whenever possible. */ } throw error; }
}

async function removeSourceHandle(access) {
  if (access.parentHandle) {
    await access.parentHandle.removeEntry(access.fileHandle.name || access.name);
    return;
  }
  throw codedError("source_action_unavailable");
}

async function snapshotSourceHandle(access) {
  const file = await access.fileHandle.getFile();
  return typeof file.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null;
}

async function restoreSourceHandle(access, snapshot, deleted) {
  const handle = deleted
    ? await access.parentHandle.getFileHandle(access.fileHandle.name || access.name, { create: true })
    : access.fileHandle;
  let stream;
  try { stream = await handle.createWritable({ keepExistingData: false, mode: "exclusive" }); }
  catch (error) {
    if (["NoModificationAllowedError", "InvalidStateError"].includes(error?.name)) throw codedError("source_busy");
    if (["TypeError", "NotSupportedError"].includes(error?.name)) throw codedError("source_write_unsupported");
    throw error;
  }
  try { await stream.write(snapshot); await stream.close(); }
  catch (error) { try { await stream.abort?.(); } catch {} throw error; }
  access.fileHandle = handle;
  const file = await handle.getFile();
  access.name = file.name; access.size = file.size; access.lastModified = file.lastModified;
}

async function removeCompletedImagesFromCatalog(imageIds, initialOrder, recordsById) {
  if (!imageIds.length) return null;
  const currentId = state.currentId;
  const currentIndex = initialOrder.indexOf(currentId);
  const scroll = [["#gallery", $("#gallery")], ["#overviewGrid", $("#overviewGrid")]]
    .map(([selector, container]) => [selector, container ? Number(container.scrollTop) || 0 : null]);
  const data = await api("/api/catalog/remove", { method: "POST", body: JSON.stringify({ imageIds }) });
  state.images = data.images;
  const remainingIds = new Set(state.images.map((image) => image.id));
  const removedIds = new Set([
    ...(data.removedImageIds || []),
    ...imageIds.filter((imageId) => !remainingIds.has(imageId)),
  ]);
  if (!removedIds.size) return null;
  const cleanupGeneration = state.imageGeneration;
  const removesPendingImage = Boolean(state.pendingImageId && removedIds.has(state.pendingImageId));
  if (removesPendingImage) { ++state.imageGeneration; abortCatalogLoads(); }

  for (const imageId of removedIds) {
    state.selectedImageIds.delete(imageId);
    if (state.selectionAnchorId === imageId) state.selectionAnchorId = null;
    releaseImageCaches(imageId);
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    clearCandidateMutationState(imageId);
    state.prefetchQueue = state.prefetchQueue.filter((entry) => entry.record.id !== imageId);
    if (state.pendingImageId === imageId) {
      state.pendingImageId = null;
      state.pendingImageKey = null;
      state.pendingCandidateKey = null;
    }
    const image = recordsById.get(imageId);
    if (image) clearReviewForRemovedImage(image);
  }
  if (state.contextMenuImageId && removedIds.has(state.contextMenuImageId)) closeCatalogContextMenu({ restoreFocus: false });
  if (!state.images.length) { state.batchMode = false; clearBatchSelection(); }

  let selectedReplacement = false;
  if (currentId && removedIds.has(currentId)) {
    releaseCandidateBundles(currentId);
    state.currentId = null;
    state.currentImage = null;
    state.pendingImageId = null;
    state.candidates = [];
    clearEditor();
  }
  pruneSourceAccess();
  renderCatalogViews();
  for (const [selector, top] of scroll) {
    if (top === null) continue;
    const container = $(selector);
    if (!container) continue;
    const height = Number(container.scrollHeight);
    const viewport = Number(container.clientHeight);
    const maximum = height > 0 && viewport >= 0 ? Math.max(0, height - viewport) : Number(top) || 0;
    container.scrollTop = Math.max(0, Math.min(Number(top) || 0, maximum));
  }
  updateSelectionActionBar();

  if (currentId && removedIds.has(currentId)) {
    const survivors = new Set(state.images.map((image) => image.id));
    const nextId = [...initialOrder.slice(currentIndex + 1), ...initialOrder.slice(0, currentIndex).reverse()]
      .find((imageId) => survivors.has(imageId));
    if (nextId) { selectedReplacement = true; await selectImage(nextId, true, { saveCurrentDraft: false }); }
    else updateNavigationControls();
  }
  updateActionButtons();
  return cleanupGeneration + Number(removesPendingImage) + Number(selectedReplacement);
}

async function runBrowserSave(imageIds, suffix, deleteOriginal, mode = "copy", removeAfterSave = false) {
  const result = await api("/api/save/prepare", {
    method: "POST",
    body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, deleteOriginal: false }),
  });
  const save = {
    entries: result.entries, completed: 0, stale: 0, paused: false, cancelled: false, failed: false, removeAfterSave,
    removableImageIds: new Set(), reviewedImageIds: new Set(), initialOrder: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])),
    catalogEpoch: state.catalogEpoch,
  };
  state.browserSave = save;
  state.saving = true;
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  updateActionButtons();
  try {
    {
      const saveEntry = async (entry) => {
        showBrowserSaveProgress(save, entry);
        const draft = draftPayload([entry.imageId])[entry.imageId] || null;
        const sourceImage = state.images.find((image) => image.id === entry.imageId);
        const access = sourceAccessFor(entry.imageId);
        let sourceAction = "keep";
        let sourceSnapshot = null;
        let sourceChanged = false;
        if (mode === "copy") {
          const response = await renderSingleSave({ imageId: entry.imageId, candidateRevision: entry.candidateRevision,
            divisor: Number($("#applyDivisor").value), draft, copyToBrowser: true, suffix });
          const output = await writeSingleOutput(state.outputDirectoryHandle, entry.relativePath, suffix, response);
          const saveToken = response.headers.get("X-Mozarie-Save-Token") || "";
          if (!saveToken) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
          if (deleteOriginal) {
            if (access?.fileHandle) {
              await ensureHandlePermission(access, true);
              sourceSnapshot = await snapshotSourceHandle(access);
              await removeSourceHandle(access);
              sourceChanged = true;
            }
            sourceAction = "deleted";
          }
          let committed;
          try { committed = await commitBrowserSaveWithRetry({
            imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken,
          }); }
          catch (error) {
            if (error.saveState === "pending") await cancelBrowserSave(entry, saveToken);
            if (sourceChanged && (isDefinitiveCommitRejection(error) || error.saveState === "pending")) try { if (sourceSnapshot === null) throw new Error(); await restoreSourceHandle(access, sourceSnapshot, true); } catch { throw codedError("source_restore_failed"); }
            await state.outputDirectoryHandle.removeEntry(output.name).catch(() => {});
            throw error;
          }
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else if (access?.fileHandle) {
          const binary = await fetch("/api/save/render", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
            body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
          });
          if (!binary.ok) throw responseError(binary, await binary.json().catch(() => ({})));
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          await ensureHandlePermission(access, true);
          sourceSnapshot = await snapshotSourceHandle(access);
          await writeSourceHandle(access, binary);
          sourceChanged = true;
          sourceAction = "overwrite";
          let committed;
          try { committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken }); }
          catch (error) {
            if (error.saveState === "pending") await cancelBrowserSave(entry, saveToken);
            if (isDefinitiveCommitRejection(error) || error.saveState === "pending") try { if (sourceSnapshot === null) throw new Error(); await restoreSourceHandle(access, sourceSnapshot, false); } catch { throw codedError("source_restore_failed"); }
            throw error;
          }
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else if (sourceImage?.sourceKind === "filesystem") {
          const binary = await fetch("/api/save/render", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
            body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
          });
          if (!binary.ok) throw responseError(binary, await binary.json().catch(() => ({})));
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          sourceAction = "overwrite";
          const committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken });
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else {
          throw codedError("source_action_unavailable");
        }
      };
      const finishBrowserSaveEntry = (committed, entry, save, sourceAction) => {
        if (committed.cleared) {
          state.drafts.delete(entry.imageId);
          if (state.currentId === entry.imageId) {
            releaseCandidateBundles(entry.imageId);
            state.candidates = [];
            state.manualMaskPresent = false;
            state.manualEnabled = true;
            resetCurrentDraft();
          }
        }
        if (save.removeAfterSave && committed.cleared && !committed.stale) save.removableImageIds.add(entry.imageId);
        if (!committed.deleted) save.reviewedImageIds.add(entry.imageId);
        if (committed.stale) save.stale += 1;
        if (sourceAction === "overwrite" && state.currentId === entry.imageId) save.reloadCurrent = true;
        pruneSourceAccess();
        save.completed += 1;
        showBrowserSaveProgress(save, entry);
      };
      let nextEntry = 0;
      const parallelism = mode === "copy" ? 1 : Math.min(save.entries.length, Math.max(1, Math.round(Number(state.settings?.saving?.parallelism) || 1)));
      const settled = await Promise.allSettled(Array.from({ length: parallelism }, async () => {
        while (true) {
          // Cancellation is observed only before an entry starts. Once an output or source has
          // changed, commit that entry so browser files and catalog state remain consistent.
          if (!await waitForBrowserSave(save)) return;
          const entry = save.entries[nextEntry++];
          if (!entry) return;
          try { await saveEntry(entry); }
          catch (error) {
            // A stale candidate can become fully excluded after the dialog was
            // opened. It is not a failed save and must never trigger deletion.
            if (error?.code === "no_effective_mask") continue;
            save.failed = true; throw error;
          }
        }
      }));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    const cancelled = save.cancelled;
    setApplyResult(cancelled
      ? t("apply.cancelled", { completed: save.completed })
      : (save.stale ? t("apply.completeWithStale", { completed: save.completed, stale: save.stale }) : t("apply.complete", { completed: save.completed })));
  } finally {
    try {
      let catalogCurrent = false;
      try {
        // Commits may resolve out of order; apply one authoritative catalogue
        // snapshot only after every started entry has settled.
        const latest = await api("/api/images");
        catalogCurrent = isCurrentCatalogEpoch(save.catalogEpoch);
        if (catalogCurrent) state.images = latest.images;
      } catch (error) {
        showApplyError(error);
      }
      if (catalogCurrent) {
        await Promise.all([...save.reviewedImageIds].map(async (imageId) => {
          const image = state.images.find((entry) => entry.id === imageId);
          if (image) await setReviewed(image, true);
        }));
        try {
          await removeCompletedImagesFromCatalog([...save.removableImageIds], save.initialOrder, save.recordsById);
        } catch (error) {
          showApplyError(error);
        }
        reconcileBrowserSaveState();
        if (save.reloadCurrent && state.currentId && state.images.some((image) => image.id === state.currentId)) {
          await selectImage(state.currentId, true, { saveCurrentDraft: false });
        }
      }
    } finally {
      state.saving = false;
      state.applyRunning = false;
      state.applyCatalogSnapshot = null;
      state.browserSave = null;
      state.job = { kind: "idle", state: "idle" };
      $("#applyPauseButton").hidden = true;
      $("#applyCancelButton").hidden = true;
      $("#applyCloseButton").hidden = false;
      updateActionButtons();
    }
  }
}

async function commitBrowserSaveWithRetry(payload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await api("/api/save/commit", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      // A database write may have completed after the server started returning
      // an error. Retry the identical token once, then ask the server which
      // state won; 400-class validation errors remain definitive.
      const retryable = !error?.status || [408, 429, 500, 502, 503, 504].includes(error.status);
      if (!retryable || attempt) {
        if (!retryable) throw error;
        const status = await api("/api/save/status", { method: "POST", body: JSON.stringify(payload) }).catch(() => ({ state: "unknown" }));
        if (status.state === "committed") return status;
        error.saveState = status.state || "unknown";
        throw error;
      }
    }
  }
}

async function cancelBrowserSave(entry, saveToken) {
  await api("/api/save/cancel", { method: "POST", body: JSON.stringify({
    imageId: entry.imageId, candidateRevision: entry.candidateRevision, saveToken,
  }) }).catch(() => {});
}

function isDefinitiveCommitRejection(error) { return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500; }

async function startApplyFromDialog(event) {
  event.preventDefault();
  const imageIds = [...state.applyTargetIds];
  if (!imageIds.length || state.saveStarting || isBusy() || state.importing) return;
  const mode = selectedSaveMode();
  const copy = mode === "copy";
  const suffix = $("#applySuffix").value;
  state.saveStarting = true;
  syncApplyMode();
  try {
    if (copy) await ensureOutputDirectoryPermission();
    if (!copy && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
    if (copy && $("#deleteOriginal").checked && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
    state.saving = true;
    state.applyRunning = true;
    state.applyCatalogSnapshot = { order: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])) };
    updateActionButtons();
    await ensureSaveSources(imageIds, mode, copy && $("#deleteOriginal").checked);
    if (state.candidateUpdateChains.size) await waitForCandidateMutations();
    if (state.importing) return;
    await flushDraftSaves(imageIds);
    state.saveStarting = false;
    await runBrowserSave(imageIds, suffix, copy && $("#deleteOriginal").checked, mode, $("#removeAfterSave").checked);
  } catch (error) {
    showApplyError(error);
    if (!state.saveStarting) {
      state.saving = false;
      state.applyRunning = false;
      state.applyCatalogSnapshot = null;
      state.browserSave = null;
      $("#applyPauseButton").hidden = true;
      $("#applyCancelButton").hidden = true;
      $("#applyCloseButton").hidden = false;
      updateActionButtons();
    }
  } finally {
    if (state.saveStarting) finishSaveStart();
  }
}

function finishSaveStart() {
  state.saveStarting = false;
  state.saving = false;
  state.applyRunning = false;
  state.applyCatalogSnapshot = null;
  updateActionButtons();
}

async function controlApply(action) {
  if (state.browserSave) {
    if (action === "cancel") state.browserSave.cancelled = true;
    if (action === "pause") state.browserSave.paused = true;
    if (action === "resume") state.browserSave.paused = false;
    showBrowserSaveProgress(state.browserSave, state.browserSave.entries[state.browserSave.completed]);
    return;
  }
  try { await api(`/api/job/${action}`, { method: "POST", body: JSON.stringify({}) }); }
  catch (error) { showApplyError(error, $("#applyCancelButton")); }
}

function showRunningApply(job) {
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  const dialog = $("#applyDialog");
  showModalFromInvoker(dialog);
}

async function finishApplyJob(job) {
  if (state.applyFinishing) return;
  state.applyFinishing = true;
  let reconciled = false;
  let generation = ++state.imageGeneration;
  const catalogEpoch = state.catalogEpoch;
  try {
    const keepCurrent = state.currentId;
    const previousOrder = state.images.map((image) => image.id);
    const previousImagesById = new Map(state.images.map((image) => [image.id, image]));
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : [];
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const data = await api("/api/images");
    if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = data.images;
    pruneSourceAccess();
    const reloadedImagesById = new Map(state.images.map((image) => [image.id, image]));
    for (const imageId of completedImageIds) {
      const previousImage = previousImagesById.get(imageId);
      const reloadedImage = reloadedImagesById.get(imageId);
      if (previousImage && reloadedImage) void moveReviewedPathAfterApply(previousImage, reloadedImage);
    }
    state.maskStatus.clear();
    for (const imageId of completedImageIds) state.drafts.delete(imageId);
    state.applyTargetIds = requestedImageIds;
    const removableImageIds = completedImageIds;
    if (job.removeAfterSave && removableImageIds.length) {
      const expectedGeneration = await removeCompletedImagesFromCatalog(removableImageIds, previousOrder, previousImagesById);
      if (expectedGeneration !== null) generation = expectedGeneration;
      if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
    }
    const removedAfterSave = Boolean(job.removeAfterSave && removableImageIds.length);
    if (removedAfterSave) {
      // removeCompletedImagesFromCatalog already selects the next surviving image.
    } else if (reloadCurrent) {
      releaseCandidateBundles(keepCurrent);
      state.candidates = [];
    }
    const reloadedCurrent = reloadCurrent && state.images.some((image) => image.id === keepCurrent);
    if (removedAfterSave) {
      // The batch cleanup above has restored either a neighboring image or an empty editor.
    } else if (reloadedCurrent) {
      await selectImage(keepCurrent, true, { saveCurrentDraft: false });
    } else if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
      refreshMaskStatus();
      renderCandidates();
      render();
    }
    else { state.currentId = null; state.currentImage = null; clearEditor(); }
    renderCatalogViews();
    state.saving = false;
    state.applyRunning = false;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    if (job.state === "complete") setApplyResult(t("apply.complete", { completed: job.completed }));
    else if (job.state === "cancelled") setApplyResult(t("apply.cancelled", { completed: job.completed }));
    else showApplyError({ code: job.errorCode || "internal_error" });
    updateActionButtons();
    reconciled = true;
  } finally {
    if (reconciled && job.startedAt != null) state.handledApplyStartedAt = job.startedAt;
    if (reconciled) state.applyCatalogSnapshot = null;
    state.applyFinishing = false;
  }
}

function isTerminalDetection(job, previous) {
  if (job.kind !== "detect" || !["complete", "cancelled", "error"].includes(job.state) || job.startedAt == null || state.handledDetectionStartedAt === job.startedAt) return false;
  const observedRunning = previous?.kind === "detect" && previous?.startedAt === job.startedAt && ["running", "pausing", "paused"].includes(previous.state);
  const reconciliationPending = state.processing?.kind === "detect" && state.processing?.startedAt === job.startedAt;
  return observedRunning || Number(job.startedAt) >= state.pageLoadedAt || reconciliationPending;
}

async function finishDetectionJob(job) {
  const invoker = modalInvokers.get($("#processingDialog"));
  const generation = ++state.imageGeneration;
  const catalogEpoch = state.catalogEpoch;
  const keepCurrent = state.currentId;
  const requestedIds = Array.isArray(job.imageIds) && job.imageIds.length ? job.imageIds : state.detectionTargetIds;
  const targetIds = Array.isArray(job.completedImageIds) && job.completedImageIds.length
    ? job.completedImageIds
    : (job.state === "complete" ? requestedIds : []);
  const data = await api("/api/images");
  if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
  state.images = data.images;
  pruneSourceAccess();
  state.maskStatus.clear();
  // Auto-detection replaces candidate IDs and mask bitmaps. Never allow a
  // cached bundle (including the currently pinned one) to survive that
  // revision boundary.
  for (const imageId of targetIds) releaseCandidateBundles(imageId);
  markImagesUnreviewed(targetIds, false);
  state.handledDetectionStartedAt = job.startedAt;
  state.detectionTargetIds = [];
  state.detectCancelRequested = false;
  closeProcessing();
  if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
    await selectImage(keepCurrent, true, { saveCurrentDraft: false });
  }
  renderCatalogViews();
  return invoker;
}

async function pollJob() {
  if (state.browserSave) { scheduleJobPoll(); return; }
  if (state.pollInFlight) return state.pollInFlight;
  state.pollInFlight = (async () => {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; state.pollFailures = 0; updateProgress(job);
    const terminalApply = isTerminalApply(job);
    if (terminalApply) {
      await finishApplyJob(job);
      if (job.state === "complete") setStatusKey("status.applyDone");
      else if (job.state === "cancelled") setStatusKey("status.applyCancelled");
      else showUserError({ code: job.errorCode || "internal_error" });
    } else if (job.kind === "apply" && ["running", "pausing", "paused"].includes(job.state)) {
      if (!state.applyRunning) showRunningApply(job);
      $("#applyProgress").max = Math.max(1, Number(job.total) || 1);
      $("#applyProgress").value = Math.min(Number(job.total) || 1, Number(job.completed) || 0);
      $("#applyCurrentName").textContent = job.current || "";
      $("#applyProgressText").textContent = t("apply.progress", { completed: job.completed, total: job.total });
      $("#applyPauseButton").textContent = t(job.state === "paused" ? "apply.resume" : "apply.pause");
      $("#applyPauseButton").disabled = job.state === "pausing";
      if (job.state === "running") setStatusKey("status.applyProgress", { completed: job.completed, total: job.total, current: job.current }, "running");
    } else if (isTerminalDetection(job, previous)) {
    const invoker = await finishDetectionJob(job);
      if (job.state === "error") showUserError({ code: job.errorCode || "internal_error" }, invoker);
      else if (job.state === "cancelled") setStatusKey("status.detectCancelled", { completed: job.completed });
      else setStatusKey("status.detectDone");
    }
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) setStatusKey("error.connectionLost", {}, "error");
  }
  })();
  try { return await state.pollInFlight; }
  finally { state.pollInFlight = null; scheduleJobPoll(); }
}
function scheduleJobPoll(immediate = false) {
  clearTimeout(state.jobPollTimer);
  const active = ["running", "pausing", "paused"].includes(state.job?.state);
  const delay = immediate ? 0 : document.visibilityState === "hidden" ? 10000 : state.pollFailures ? Math.min(15000, 2500 * (2 ** Math.min(state.pollFailures, 3))) : active ? 600 : 2500;
  state.jobPollTimer = setTimeout(() => { void pollJob(); }, delay);
}
