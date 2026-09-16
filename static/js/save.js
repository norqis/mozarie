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
function selectedApplyOutputFormat() { return $("#applyOutputFormat").value; }
function selectedSingleOutputFormat() { return $("#singleSaveOutputFormat").value; }
function preserveDirectoryStructure() { return state.settings?.saving?.preserve_directory_structure !== false; }
function mergeSavingSettings(response, fields) {
  const saving = response?.settings?.saving;
  if (!saving || !state.settings?.saving) return;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(saving, field)) state.settings.saving[field] = saving[field];
  }
}
function renderDirectoryStructurePreference() {
  const preserve = preserveDirectoryStructure();
  $("#applyPreserveDirectoryStructure").checked = preserve;
  $("#singleSavePreserveDirectoryStructure").checked = preserve;
}
let directoryStructurePreferenceMutation = Promise.resolve();
let directoryStructurePreferenceVersion = 0;
async function saveDirectoryStructurePreference(input) {
  const preserve = Boolean(input.checked); const previous = preserveDirectoryStructure(); const version = ++directoryStructurePreferenceVersion;
  $("#applyPreserveDirectoryStructure").checked = preserve;
  $("#singleSavePreserveDirectoryStructure").checked = preserve;
  if (previous === preserve) return true;
  state.settings.saving.preserve_directory_structure = preserve;
  const save = directoryStructurePreferenceMutation.catch(() => {}).then(() => api("/api/settings?status=0", {
    method: "POST", body: JSON.stringify({ saving: { preserve_directory_structure: preserve } }),
  }));
  directoryStructurePreferenceMutation = save;
  try {
    const response = await save;
    if (version === directoryStructurePreferenceVersion) {
      mergeSavingSettings(response, ["preserve_directory_structure"]); renderDirectoryStructurePreference();
    }
    return true;
  }
  catch (error) {
    if (version === directoryStructurePreferenceVersion) {
      state.settings.saving.preserve_directory_structure = previous;
      renderDirectoryStructurePreference(); showUserError(error, input);
    }
    return false;
  }
}
async function ensureDirectoryStructurePreference(input) {
  return input.checked === preserveDirectoryStructure() ? directoryStructurePreferenceMutation.then(() => true, () => false) : saveDirectoryStructurePreference(input);
}
function syncApplyOutputOptions() {
  const format = selectedApplyOutputFormat();
  const metadata = $("#applyKeepMetadata"); const note = $("#applyFormatNote");
  metadata.disabled = format === "jpg" || state.applyRunning || state.saveStarting;
  if (format === "jpg") metadata.checked = false;
  note.textContent = format === "jpg" ? t("apply.jpgMetadataDisabled") : "";
  note.classList.toggle("save-option-warning", format === "jpg");
  note.hidden = !note.textContent;
  $("#applyOverwriteMode").disabled = !applyTargetsSupport("overwrite", format) || state.applyRunning || state.saveStarting;
  $("#applyOverwriteRow").classList.toggle("muted", $("#applyOverwriteMode").disabled);
}
function syncSingleOutputOptions() {
  const save = state.singleSave; const format = selectedSingleOutputFormat();
  const metadata = $("#singleSaveKeepMetadata"); const note = $("#singleSaveFormatNote");
  metadata.disabled = format === "jpg" || state.saving || state.saveStarting;
  if (format === "jpg") metadata.checked = false;
  note.textContent = format === "jpg" ? t("apply.jpgMetadataDisabled") : "";
  note.classList.toggle("save-option-warning", format === "jpg");
  note.hidden = !note.textContent;
  $("#singleSaveOverwriteMode").disabled = !sourceCanOverwrite(state.images.find((image) => image.id === save?.imageId), format) || state.saving || state.saveStarting;
  $("#singleSaveOverwriteRow").classList.toggle("muted", $("#singleSaveOverwriteMode").disabled);
}
function sourceAccessFor(imageId) { return state.sourceAccess.get(imageId) || null; }
function sourceCanOverwrite(image, format = "original") {
  const access = sourceAccessFor(image?.id);
  if (image?.sourceKind === "filesystem") return true;
  return Boolean(access?.fileHandle) && (!renamedSourceFileName(image, access, format) || Boolean(access?.parentHandle));
}
function sourceCanDelete(image) {
  if (image?.sourceKind === "filesystem") return true;
  const access = sourceAccessFor(image?.id);
  return Boolean(access?.fileHandle && access.parentHandle);
}
function applyTargetsSupport(capability, format = "original") {
  return state.applyTargetIds.every((imageId) => {
    const image = state.images.find((entry) => entry.id === imageId);
    return capability === "overwrite" ? sourceCanOverwrite(image, format) : sourceCanDelete(image);
  });
}
function applyRestrictionMessage() {
  const noOverwrite = state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId), selectedApplyOutputFormat()));
  const noDelete = state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId)));
  if (selectedSaveMode() === "overwrite" && noOverwrite.length) return t("apply.overwriteUnavailable", { count: noOverwrite.length });
  if (selectedSaveMode() === "copy" && $("#deleteOriginal").checked && noDelete.length) return t("apply.deleteUnavailable", { count: noDelete.length });
  return "";
}

function syncApplyMode() {
  const canOverwrite = applyTargetsSupport("overwrite", selectedApplyOutputFormat());
  const canDelete = applyTargetsSupport("delete");
  const copying = selectedSaveMode() === "copy";
  $("#applySuffixRow").hidden = !copying;
  $("#deleteOriginalRow").hidden = !copying;
  $("#applyOutputDirectoryRow").hidden = !copying;
  $("#applyPreserveDirectoryStructureRow").hidden = !copying;
  const outputDirectoryPending = state.outputDirectoryPicking || state.outputDirectoryCommitPending;
  $("#applySuffix").disabled = state.applyRunning || state.outputDirectoryPicking;
  $("#applyTargetMode").disabled = state.applyRunning || state.saveStarting || state.outputDirectoryPicking;
  $("#chooseOutputDirectoryButton").disabled = outputDirectoryPending || state.applyRunning || state.saveStarting;
  $("#applyOutputDirectoryStatus").disabled = outputDirectoryPending || state.applyRunning || state.saveStarting;
  $("#applyRemoveSaved").disabled = state.outputDirectoryPicking || state.applyRunning || state.saveStarting;
  $("#applyPreserveDirectoryStructure").disabled = state.outputDirectoryPicking || state.applyRunning || state.saveStarting;
  $("#deleteOriginal").disabled = !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#applyOverwriteMode").disabled = !canOverwrite || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", !canOverwrite);
  const restriction = applyRestrictionMessage();
  const capabilityNote = !canOverwrite
    ? t("apply.overwriteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId), selectedApplyOutputFormat())).length })
    : (!canDelete ? t("apply.deleteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId))).length }) : "");
  $("#applyTemporarySourceNote").textContent = restriction || capabilityNote || t("apply.handleSource");
  $("#applyTemporarySourceNote").hidden = !restriction && !capabilityNote;
  $("#applyStartButton").disabled = Boolean(restriction) || outputDirectoryPending || state.applyRunning || state.saveStarting || state.applyTargetIds.length === 0 || (copying && !state.settings?.saving?.default_output_directory);
  syncApplyOutputOptions();
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
  const initialMode = Array.isArray(options) ? "current" : options.initialMode;
  if (isBusy() || state.importing) return;
  try { await flushDraftSaves(); }
  catch (error) { showUserError(error); return; }
  if (!state.applyDialogInitialized || initialMode) $("#applyTargetMode").value = initialMode || "masked";
  refreshApplyTargets();
  state.applyRunning = false;
  if (!state.applyDialogInitialized) {
    $("#applyDivisor").value = $("#divisor").value;
    $("#applyCopyMode").checked = true;
    $("#deleteOriginal").checked = false;
    $("#applyOutputFormat").value = "original";
    $("#applyKeepMetadata").checked = true;
    $("#applyRemoveSaved").checked = false;
    renderDirectoryStructurePreference();
  }
  updateBlockSizeDisplay();
  $("#applyProgressPanel").hidden = true;
  $("#applyStartButton").hidden = false;
  $("#applyCloseButton").hidden = false;
  $("#applyPauseButton").hidden = true;
  $("#applyCancelButton").hidden = true;
  $("#applySettings").disabled = false;
  setApplyResult(""); renderOutputDirectory(); renderDirectoryStructurePreference(); syncApplyMode();
  showModalFromInvoker($("#applyDialog"), invoker);
  state.applyDialogInitialized = true;
}

function selectedSingleSaveMode() { return document.querySelector('input[name="singleSaveMode"]:checked').value; }
function setSingleSaveResult(message, error = false) {
  const result = $("#singleSaveResult"); result.textContent = message; result.classList.toggle("error", error);
}
function syncSingleSaveMode() {
  const save = state.singleSave;
  const image = state.images.find((entry) => entry.id === save?.imageId);
  const copying = selectedSingleSaveMode() === "copy";
  const canOverwrite = sourceCanOverwrite(image, selectedSingleOutputFormat());
  const canDelete = sourceCanDelete(image);
  $("#singleSaveSuffixRow").hidden = !copying;
  $("#singleSaveDeleteOriginalRow").hidden = !copying;
  $("#singleSaveOutputDirectoryRow").hidden = !copying;
  $("#singleSavePreserveDirectoryStructureRow").hidden = !copying;
  $("#singleSaveOverwriteMode").disabled = !canOverwrite || state.saving || state.saveStarting;
  $("#singleSaveOverwriteRow").classList.toggle("muted", !canOverwrite);
  $("#singleSaveDeleteOriginal").disabled = !canDelete || state.saving || state.saveStarting;
  if (!canDelete) $("#singleSaveDeleteOriginal").checked = false;
  const outputDirectoryPending = state.outputDirectoryPicking || state.outputDirectoryCommitPending;
  $("#singleSaveChooseOutputDirectoryButton").disabled = outputDirectoryPending || state.saving || state.saveStarting;
  $("#singleSaveOutputDirectoryStatus").disabled = outputDirectoryPending || state.saving || state.saveStarting;
  $("#singleSaveRemoveSaved").disabled = state.outputDirectoryPicking || state.saving || state.saveStarting;
  $("#singleSavePreserveDirectoryStructure").disabled = state.outputDirectoryPicking || state.saving || state.saveStarting;
  $("#singleSaveStartButton").disabled = outputDirectoryPending || state.saving || state.saveStarting || !isProcessableImage(image) || (copying && !state.settings?.saving?.default_output_directory) || (!copying && !canOverwrite);
  $("#singleSaveSettings").disabled = state.outputDirectoryPicking || state.saving || state.saveStarting;
  syncSingleOutputOptions();
}

async function openSingleSaveDialog(imageId = state.currentId) {
  const invoker = document.activeElement;
  const generation = state.imageGeneration;
  if (!imageId || isBusy() || state.importing || currentImageActionPending()) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  try { await flushDraftSaves([imageId]); }
  catch (error) { showUserError(error, invoker); return; }
  const image = state.images.find((entry) => entry.id === imageId);
  if (!isProcessableImage(image) || isBusy() || state.importing || currentImageActionPending() || state.currentId !== imageId || !isCurrentGeneration(generation)
    || !state.currentImage || state.projectReadOnly || image.sourceDimensionsChanged) return;
  state.singleSave = { imageId, generation, divisor: Number($("#divisor").value), draft: draftPayload([imageId])[imageId] || null, invoker };
  $("#singleSaveTarget").textContent = t("apply.singleTarget", { name: image.relativePath });
  if (!state.singleSaveDialogInitialized) {
    $("#singleSaveCopyMode").checked = true;
    $("#singleSaveDeleteOriginal").checked = false;
    $("#singleSaveOutputFormat").value = "original";
    $("#singleSaveKeepMetadata").checked = true;
    $("#singleSaveRemoveSaved").checked = false;
    renderDirectoryStructurePreference();
  }
  setSingleSaveResult("");
  renderOutputDirectory(); renderDirectoryStructurePreference();
  syncSingleSaveMode();
  showModalFromInvoker($("#singleSaveDialog"), invoker);
  state.singleSaveDialogInitialized = true;
}

async function chooseSingleOutputDirectory() {
  if (state.saving || state.saveStarting || state.outputDirectoryCommitPending) return;
  try { await pickOutputDirectory(); setSingleSaveResult(""); }
  catch (error) { if (error?.name !== "AbortError") { setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true); showUserError(error, $("#singleSaveChooseOutputDirectoryButton")); } }
  syncSingleSaveMode();
}

async function renderSingleSave(payload) {
  const response = await fetch("/api/save/render", {
    method: "POST", headers: catalogRequestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (response.ok) return response;
  const error = responseError(response, await response.json().catch(() => ({})));
  await resyncAfterStaleCatalog(error);
  throw error;
}

function newClientSaveToken() {
  return crypto.randomUUID();
}

const pendingSaveStorageKey = "mozarie.pending-save-token.";
const legacyPendingSaveStorageKey = "mozarie.pending-save-tokens";

function pendingSaveTokens() {
  const pending = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(pendingSaveStorageKey)) continue;
    try { pending[key.slice(pendingSaveStorageKey.length)] = JSON.parse(localStorage.getItem(key)); } catch {}
  }
  try { Object.assign(pending, JSON.parse(localStorage.getItem(legacyPendingSaveStorageKey) || "{}")); } catch {}
  return pending;
}

function rememberPendingSave(entry, token, sourceAction = "keep") {
  localStorage.setItem(`${pendingSaveStorageKey}${token}`, JSON.stringify({
    imageId: entry.imageId, candidateRevision: entry.candidateRevision, sourceAction,
    displayName: entry.relativePath || entry.name || "",
  }));
}

function updatePendingSaveAction(token, sourceAction) {
  const entry = pendingSaveTokens()[token];
  if (entry) localStorage.setItem(`${pendingSaveStorageKey}${token}`, JSON.stringify({ ...entry, sourceAction }));
}

function forgetPendingSave(token) {
  localStorage.removeItem(`${pendingSaveStorageKey}${token}`);
  try {
    const legacy = JSON.parse(localStorage.getItem(legacyPendingSaveStorageKey) || "{}");
    if (legacy && typeof legacy === "object") { delete legacy[token]; localStorage.setItem(legacyPendingSaveStorageKey, JSON.stringify(legacy)); }
  } catch {}
}

async function acknowledgePendingBrowserSave(token) {
  try { const result = await api("/api/save/ack", { method: "POST", body: JSON.stringify({ saveToken: token }), resyncOnStale: false }); if (result?.acknowledged === true) { forgetPendingSave(token); return true; } return false; }
  catch { return false; }
}

async function reserveSaveRender(entry, payload, clientSaveToken) {
  rememberPendingSave(entry, clientSaveToken, payload.sourceAction || (payload.copyToDefault ? "keep" : "overwrite"));
  const reserved = await api("/api/save/reserve", { method: "POST", body: JSON.stringify({
    imageId: entry.imageId, candidateRevision: entry.candidateRevision, clientSaveToken,
    copyToDefault: payload.copyToDefault === true, suffix: payload.suffix, format: payload.format,
    keepMetadata: payload.keepMetadata,
  }) });
  if (reserved.state !== "rendering" && reserved.state !== "pending") throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
  return reserved;
}

async function reconcilePendingBrowserSaves() {
  const pending = pendingSaveTokens();
  const deferred = [];
  await Promise.all(Object.entries(pending).map(async ([saveToken, entry]) => {
    const status = await api("/api/save/status", { method: "POST", body: JSON.stringify({ ...entry, saveToken, sourceAction: entry.sourceAction || "keep" }) }).catch(() => null);
    if (!status) return;
    if (["unknown", "cancelled"].includes(status.state)) { forgetPendingSave(saveToken); return; }
    if (status.state === "committed") {
      if (status.sourceDeletePending) deferred.push(entry.displayName || status.outputPath || entry.imageId || saveToken);
      await acknowledgePendingBrowserSave(saveToken); return;
    }
    if (["rendering", "pending", "cleanup_pending"].includes(status.state)) await cancelBrowserSave(entry, saveToken);
  }));
  if (deferred.length) setStatus(t("sourceDelete.batchNotAvailable", {
    complete: t("apply.complete", { completed: deferred.length }),
    names: new Intl.ListFormat(document.documentElement.lang === "en" ? "en" : "ja", { style: "long", type: "conjunction" }).format(deferred),
  }), "warning");
}

function outputPathFromResponse(response) {
  const encoded = response.headers.get("X-Mozarie-Output-Path-B64") || "";
  if (!encoded) return "";
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (value) => value.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function renderDefaultCopy(entry, payload) {
  const clientSaveToken = newClientSaveToken();
  try {
    const reserved = await reserveSaveRender(entry, payload, clientSaveToken);
    if (reserved.state === "pending") return { saveToken: clientSaveToken, outputPath: reserved.outputPath || "", noEffect: false };
    const response = await renderSingleSave({ ...payload, clientSaveToken });
    return {
      saveToken: response.headers.get("X-Mozarie-Save-Token") || clientSaveToken,
      outputPath: outputPathFromResponse(response),
      noEffect: response.headers.get("X-Mozarie-No-Effect") === "1",
    };
  } catch (error) {
    const status = await api("/api/save/status", { method: "POST", body: JSON.stringify({
      imageId: entry.imageId, candidateRevision: entry.candidateRevision, saveToken: clientSaveToken, sourceAction: "keep",
    }) }).catch(() => ({ state: "unknown" }));
    if (status.state === "pending") return { saveToken: clientSaveToken, outputPath: status.outputPath || "", noEffect: status.noEffect === true };
    if (status.state === "rendering") {
      const response = await renderSingleSave({ ...payload, clientSaveToken });
      return { saveToken: clientSaveToken, outputPath: outputPathFromResponse(response), noEffect: response.headers.get("X-Mozarie-No-Effect") === "1" };
    }
    await cancelBrowserSave(entry, clientSaveToken);
    throw error;
  }
}

async function renderStreamedSave(entry, payload) {
  const clientSaveToken = newClientSaveToken();
  try {
    const reserved = await reserveSaveRender(entry, payload, clientSaveToken);
    if (reserved.state === "pending") return await renderSingleSave({ ...payload, clientSaveToken });
    return await renderSingleSave({ ...payload, clientSaveToken });
  } catch (error) {
    const status = await api("/api/save/status", { method: "POST", body: JSON.stringify({
      imageId: entry.imageId, candidateRevision: entry.candidateRevision, saveToken: clientSaveToken, sourceAction: "overwrite",
    }) }).catch(() => ({ state: "unknown" }));
    if (status.state === "pending") await cancelBrowserSave(entry, clientSaveToken);
    if (status.state === "rendering") return await renderSingleSave({ ...payload, clientSaveToken });
    await cancelBrowserSave(entry, clientSaveToken);
    error.saveState = status.state || "unknown";
    throw error;
  }
}

async function startSingleSave(event) {
  event.preventDefault();
  const save = state.singleSave;
  const image = state.images.find((entry) => entry.id === save?.imageId);
  if (!save || !isProcessableImage(image) || state.saving || state.saveStarting || isBusy() || state.importing || catalogStagingEditsActive() || currentImageActionPending()
    || state.currentId !== save.imageId || !isCurrentGeneration(save.generation) || !state.currentImage || state.projectReadOnly || image.sourceDimensionsChanged) return;
  const mode = selectedSingleSaveMode(); const copying = mode === "copy";
  const outputDirectory = $("#singleSaveOutputDirectoryStatus");
  if (copying && outputDirectory.value.trim() !== (state.settings?.saving?.default_output_directory || "") && !await commitOutputDirectory(outputDirectory)) return;
  if (state.saving || state.saveStarting || isBusy()) return;
  const deleteOriginal = copying && $("#singleSaveDeleteOriginal").checked;
  const removeSaved = $("#singleSaveRemoveSaved").checked;
  const removalSelection = removeSaved ? deletionSelectionSnapshot(new Set([save.imageId]), galleryFilteredImages()) : null;
  const catalogEpoch = state.catalogEpoch;
  const suffix = $("#singleSaveSuffix").value;
  const format = selectedSingleOutputFormat(); const keepMetadata = $("#singleSaveKeepMetadata").checked;
  if (copying && !state.settings?.saving?.default_output_directory) return syncSingleSaveMode();
  state.saveStarting = true;
  syncSingleSaveMode();
  try {
    if (copying) await ensureSaveSources([save.imageId], "copy", deleteOriginal);
    if (copying && !await ensureDirectoryStructurePreference($("#singleSavePreserveDirectoryStructure"))) return;
    if (!copying && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
    if (deleteOriginal && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
    state.saving = true; updateActionButtons(); syncSingleSaveMode(); setSingleSaveResult("");
    let entry; let saveToken = ""; let output = null; let sourceSnapshot = null; let sourceRename = null; let cleanupIntent = null; let browserSourceDelete = null;
    const cleanupProjectId = state.project?.id || null;
    try {
    const prepared = await api("/api/save/prepare", { method: "POST", body: JSON.stringify({ imageIds: [save.imageId], divisor: save.divisor, suffix, deleteOriginal: false, copyToDefault: copying, format, keepMetadata }) });
    entry = prepared.entries?.[0]; if (!entry) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
    await flushWorkspaceDraft(save.imageId);
    const access = sourceAccessFor(save.imageId);
    if (!copying) await ensureSaveSources([save.imageId], "overwrite", false);
    const rendered = copying
      ? await renderDefaultCopy(entry, { imageId: save.imageId, candidateRevision: entry.candidateRevision, divisor: save.divisor, draft: save.draft, copyToDefault: true, suffix, format, keepMetadata })
      : { response: await renderStreamedSave(entry, { imageId: save.imageId, candidateRevision: entry.candidateRevision, divisor: save.divisor, draft: save.draft, suffix, format, keepMetadata }) };
    const response = rendered.response;
    saveToken = rendered.saveToken || response?.headers.get("X-Mozarie-Save-Token") || "";
    if (!saveToken) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
    const noEffect = rendered.noEffect ?? (response?.headers.get("X-Mozarie-No-Effect") === "1");
    let sourceAction = noEffect ? "keep" : "overwrite";
    let committed; let commitStarted = false;
    try {
      if (copying) {
        output = rendered.outputPath || "";
        // Browser handles use the durable source-delete operation after the
        // copy receipt is committed.  The save journal therefore remains a
        // copy-only transaction and never tries to restore JS-local bytes.
        sourceAction = deleteOriginal && !access?.fileHandle ? "deleted" : "keep";
        if (access?.fileHandle) {
          await ensureHandlePermission(access, deleteOriginal);
        }
      } else if (access?.fileHandle) {
        if (noEffect) await ensureHandlePermission(access, false);
        else {
          await ensureHandlePermission(access, true);
          if (renamedSourceFileName(image, access, format)) sourceRename = await writeFormattedSourceHandle(access, image, format, response);
          else {
            sourceSnapshot = await snapshotSourceHandle(access);
            if (!(sourceSnapshot instanceof Blob)) throw codedError("source_restore_failed");
            await writeSourceHandle(access, response);
          }
          await ensureHandlePermission(access, false);
        }
      }
      if (sourceAction === "deleted" && cleanupProjectId) cleanupIntent = await rememberProjectImageSourceCleanup(cleanupProjectId, save.imageId);
      if (sourceAction === "deleted") updatePendingSaveAction(saveToken, "deleted");
      commitStarted = true;
      committed = await commitBrowserSaveWithRetry({ imageId: save.imageId, candidateRevision: entry.candidateRevision, saveToken, sourceAction, ...(sourceAction === "overwrite" && access?.fileHandle ? sourceCommitMetadata(sourceRename?.replacement || access) : {}) });
      await finishFormattedSourceRename(access, sourceRename);
      if (committed.sourceDeletePending) browserSourceDelete = { deleted: false, retryable: false };
      if (copying && committed.outputPath) output = committed.outputPath;
      if (copying && deleteOriginal && access?.fileHandle) browserSourceDelete = await deleteCopiedBrowserSource(image, saveToken);
    }
    catch (error) {
      const reconcile = !commitStarted || isDefinitiveCommitRejection(error) || error.saveState === "pending";
      if (reconcile) {
        await cancelBrowserSave(entry, saveToken);
        if (sourceRename) await discardFormattedSourceRename(access, sourceRename);
        else if (sourceSnapshot !== null) await restoreSourceHandle(access, sourceSnapshot, deleteOriginal);
      }
      throw error;
    } finally {
      sourceSnapshot = null; sourceRename = null;
    }
    // A copy that retains its source does not change the catalogue. Avoid the
    // expensive image reload (and forced editor reload) in that common path.
    // Overwrites and source deletion do need authoritative reconciliation.
    if ((sourceAction === "overwrite") || deleteOriginal) {
      const capturedProjectId = state.project?.id || null;
      const capturedCatalogGeneration = state.serverCatalogGeneration;
      const latest = await api("/api/images").catch((error) => {
        if (copying && deleteOriginal && browserSourceDelete) {
          console.warn("コピー保存後の一覧更新は保留です: %s", error?.code || error);
          return null;
        }
        throw error;
      });
      if (latest) {
      reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration); state.images = latest.images;
      loadReviewedPaths();
      const savedImage = state.images.find((item) => item.id === save.imageId);
      if (deleteOriginal && cleanupProjectId && !state.images.some((item) => item.id === save.imageId)
        && await forgetProjectImageSources(cleanupProjectId, [save.imageId]) && cleanupIntent) {
        await clearProjectSourceCleanup({ intentIds: [cleanupIntent] });
      }
      pruneSourceAccess();
      if (deleteOriginal) reconcileBrowserSaveState();
      else if (savedImage && state.currentId === save.imageId) await selectImage(save.imageId, true, { saveCurrentDraft: false });
      renderCatalogViews();
      }
    }
    let listRemovalFailed = false;
    if (removeSaved && !committed.stale && (copying || !noEffect)) {
      try { await removeSavedCatalogEntries([save.imageId], catalogEpoch, removalSelection); }
      catch (error) { console.warn("保存後の一覧削除に失敗しました: %s", error?.code || error); listRemovalFailed = true; }
    }
    state.singleSave = null;
    if (browserSourceDelete && !browserSourceDelete.deleted) {
      if (browserSourceDelete.retryable === false) setSingleSaveResult(t("sourceDelete.notAvailable", { complete: t("apply.complete", { completed: 1 }), output }), true);
      else
      setSingleSaveResult(t("sourceDelete.singlePending", { complete: t("apply.complete", { completed: 1 }), output }), true);
    } else setSingleSaveResult(`${copying ? `${t("apply.complete", { completed: 1 })} ${output}` : t("apply.complete", { completed: 1 })}${listRemovalFailed ? ` ${t("apply.removeSavedFailed")}` : ""}`, listRemovalFailed);
    } catch (error) {
      if (saveToken && entry) await cancelBrowserSave(entry, saveToken);
      if (cleanupIntent && isDefinitiveCommitRejection(error)) await clearProjectSourceCleanup({ intentIds: [cleanupIntent] });
      setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true); showUserError(error, $("#singleSaveStartButton"));
    } finally {
      state.saving = false; renderCandidates(); updateActionButtons(); syncSingleSaveMode();
    }
  } catch (error) {
    setSingleSaveResult(t(`errorCode.${userErrorCode(error)}`), true);
    showUserError(error, $("#singleSaveStartButton"));
  } finally {
    state.saveStarting = false; renderCandidates(); updateActionButtons(); syncSingleSaveMode();
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
  $("#settingsDefaultOutputDirectory").value = configuredDirectory;
  $("#applyOutputDirectoryStatus").value = configuredDirectory;
  $("#singleSaveOutputDirectoryStatus").value = configuredDirectory;
  $("#applyOutputDirectoryStatus").placeholder = t("apply.outputDirectoryUnset");
  $("#singleSaveOutputDirectoryStatus").placeholder = t("apply.outputDirectoryUnset");
}

async function commitOutputDirectory(input) {
  if (state.outputDirectoryPicking || state.outputDirectoryCommitPending || state.applyRunning || state.saveStarting || state.saving) return false;
  const directory = input.value.trim();
  if (directory === (state.settings?.saving?.default_output_directory || "")) return true;
  state.outputDirectoryCommitPending = true;
  syncApplyMode(); if (state.singleSave) syncSingleSaveMode(); updateActionButtons();
  try {
    const data = await api("/api/settings?status=0", { method: "POST", body: JSON.stringify({ saving: { default_output_directory: directory } }) });
    mergeSavingSettings(data, ["default_output_directory"]);
    renderOutputDirectory();
    return true;
  } catch (error) {
    input.value = directory;
    // The dialog keeps its invoker only while it is enabled, so release this
    // narrow request lock before presenting a retryable settings error.
    state.outputDirectoryCommitPending = false;
    syncApplyMode(); if (state.singleSave) syncSingleSaveMode(); updateActionButtons();
    showUserError(error, input);
    return false;
  } finally {
    state.outputDirectoryCommitPending = false;
    syncApplyMode(); if (state.singleSave) syncSingleSaveMode(); updateActionButtons();
  }
}

let outputDirectoryPickRequest = null;
let outputPickerDisabledControls = null;

function setOutputDirectoryPickerBusy(picking) {
  state.outputDirectoryPicking = picking;
  if (picking) {
    outputPickerDisabledControls = new Map([...document.querySelectorAll("#settingsForm button, #settingsForm input, #settingsForm select")].map((control) => [control, control.disabled]));
    for (const control of outputPickerDisabledControls.keys()) control.disabled = true;
  } else if (outputPickerDisabledControls) {
    for (const [control, disabled] of outputPickerDisabledControls) control.disabled = disabled;
    outputPickerDisabledControls = null;
  }
  syncApplyMode();
  if (state.singleSave) syncSingleSaveMode();
  updateActionButtons();
}

async function pickOutputDirectory() {
  if (!outputDirectoryPickRequest) {
    setOutputDirectoryPickerBusy(true);
    outputDirectoryPickRequest = api("/api/output-directory/pick", {
      method: "POST", body: JSON.stringify({ currentPath: state.settings?.saving?.default_output_directory || "" }),
    }).then((data) => {
        if (data.cancelled) return null;
        mergeSavingSettings(data, ["default_output_directory"]);
        // The picker persists only the output directory.  Re-rendering the
        // whole settings form here would discard edits the user has not saved.
        renderOutputDirectory();
        return data.path;
      })
      .finally(() => {
        outputDirectoryPickRequest = null;
        setOutputDirectoryPickerBusy(false);
      });
  }
  return outputDirectoryPickRequest;
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting || state.outputDirectoryCommitPending) return;
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
  $("#applyPauseButton").disabled = false;
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

function discardRemovedBrowserSaveState() {
  const remainingImageIds = new Set(state.images.map((image) => image.id));
  const removedImageIds = new Set();
  const collectRemoved = (ids) => {
    for (const imageId of ids) if (!remainingImageIds.has(imageId)) removedImageIds.add(imageId);
  };
  collectRemoved(state.drafts.keys());
  collectRemoved(state.projectHistory.keys());
  collectRemoved(state.maskStatus.keys());
  collectRemoved(state.sourceAccess.keys());
  collectRemoved(state.draftSaveChains.keys());
  collectRemoved(state.workspaceDraftChains.keys());
  collectRemoved(state.workspaceDraftTimers.keys());
  collectRemoved(state.workspaceDraftPending?.keys() || []);
  collectRemoved(state.workspaceMutationErrors.keys());
  collectRemoved(state.selectedImageIds);
  collectRemoved(state.applyCatalogSnapshot?.order || []);
  if (state.singleSave?.imageId && !remainingImageIds.has(state.singleSave.imageId)) removedImageIds.add(state.singleSave.imageId);
  for (const [imageId, timer] of state.workspaceDraftTimers) {
    if (!remainingImageIds.has(imageId)) { clearTimeout(timer); state.workspaceDraftTimers.delete(imageId); }
  }
  for (const [imageId, pending] of state.workspaceDraftPending || []) {
    if (!remainingImageIds.has(imageId)) { pending.resolve(); state.workspaceDraftPending.delete(imageId); }
  }
  for (const imageId of removedImageIds) {
    state.drafts.delete(imageId);
    state.projectHistory.delete(imageId);
    state.maskStatus.delete(imageId);
    state.draftSaveChains.delete(imageId);
    state.workspaceDraftChains.delete(imageId);
    state.workspaceDraftPending?.delete(imageId);
    state.workspaceMutationErrors.delete(imageId);
    clearCandidateMutationState(imageId);
    releaseImageCaches(imageId);
    releaseCandidateBundles(imageId);
  }
  for (const [imageId] of state.sourceAccess) if (!remainingImageIds.has(imageId)) state.sourceAccess.delete(imageId);
  for (const [imageId] of state.draftSaveChains) if (!remainingImageIds.has(imageId)) state.draftSaveChains.delete(imageId);
  for (const [imageId] of state.workspaceDraftChains) if (!remainingImageIds.has(imageId)) state.workspaceDraftChains.delete(imageId);
  for (const [imageId] of state.workspaceMutationErrors) if (!remainingImageIds.has(imageId)) state.workspaceMutationErrors.delete(imageId);
  for (const key of state.workspaceFlagPending.keys()) if (!remainingImageIds.has(key.split(":", 1)[0])) state.workspaceFlagPending.delete(key);
  state.selectedImageIds = new Set([...state.selectedImageIds].filter((imageId) => remainingImageIds.has(imageId)));
  pruneSourceAccess();
}

function reconcileBrowserSaveState() {
  discardRemovedBrowserSaveState();
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

async function removeSavedCatalogEntries(imageIds, catalogEpoch, selection) {
  if (!imageIds.length || !isCurrentCatalogEpoch(catalogEpoch)) return false;
  const expectedProjectId = state.project?.id || null;
  const data = await catalogApi("/api/catalog/remove", { imageIds }, { method: "POST" });
  if (!isCurrentCatalogEpoch(catalogEpoch)) return false;
  state.images = data.images || state.images;
  loadReviewedPaths();
  const removedImageIds = Array.isArray(data.removedImageIds) ? data.removedImageIds : [];
  if (expectedProjectId && removedImageIds.length) await forgetProjectImageSources(expectedProjectId, removedImageIds);
  const removed = new Set(removedImageIds);
  if (removed.has(state.pendingImageId)) {
    state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
    abortCatalogLoads(); state.prefetchQueue = []; state.hoverPrefetchId = null;
  }
  if (removed.has(state.selectionAnchorId)) state.selectionAnchorId = null;
  if (removed.has(state.contextMenuImageId)) {
    state.contextMenuImageId = null; state.contextMenuOrigin = null; state.contextMenuScroll = null;
  }
  reconcileBrowserSaveState();
  if (selection && removedImageIds.length) await restoreDeletionSelection(selection, new Set(removedImageIds));
  return true;
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

function renamedSourceFileName(image, access, format) {
  if (format === "original") return "";
  const name = access?.fileHandle?.name || access?.name || String(image?.relativePath || "").split("/").at(-1);
  const extension = name.split(".").at(-1).toLowerCase();
  const targetExtension = format === "jpg" ? "jpg" : "png";
  if (!name || extension === targetExtension || (format === "jpg" && extension === "jpeg")) return "";
  return `${name.slice(0, -(extension.length + 1))}.${targetExtension}`;
}

async function writeFormattedSourceHandle(access, image, format, response) {
  const targetName = renamedSourceFileName(image, access, format);
  if (!targetName) { await writeSourceHandle(access, response); return null; }
  if (!access.parentHandle) throw codedError("source_action_unavailable");
  try {
    await access.parentHandle.getFileHandle(targetName);
    throw codedError("save_write_failed");
  } catch (error) {
    if (typeof error?.code === "string" || error?.name !== "NotFoundError") throw error;
  }
  const targetHandle = await access.parentHandle.getFileHandle(targetName, { create: true });
  const relativePath = access.relativePath ? `${access.relativePath.split("/").slice(0, -1).concat(targetName).filter(Boolean).join("/")}` : targetName;
  const replacement = { ...access, fileHandle: targetHandle, name: targetName, relativePath };
  try { await writeSourceHandle(replacement, response); }
  catch (error) { try { await access.parentHandle.removeEntry(targetName); } catch {} throw error; }
  return { previousName: access.fileHandle.name || access.name, replacement };
}

async function finishFormattedSourceRename(access, rename) {
  if (!rename) return;
  Object.assign(access, rename.replacement);
  await access.parentHandle.removeEntry(rename.previousName);
}

async function discardFormattedSourceRename(access, rename) {
  if (!rename) return;
  try { await access.parentHandle.removeEntry(rename.replacement.fileHandle.name || rename.replacement.name); } catch {}
}

function sourceCommitMetadata(access) {
  return { sourceMtimeMs: Math.max(0, Number(access.lastModified || 0)), sourceSizeBytes: Math.max(0, Number(access.size || 0)) };
}

async function snapshotSourceHandle(access) {
  const file = await access.fileHandle.getFile();
  if (!(file instanceof Blob) || typeof file.arrayBuffer !== "function") return null;
  // File.slice() may retain a lazy link to the source. Read the bytes before
  // any overwrite or deletion; access retains the exact source name.
  return new Blob([await file.arrayBuffer()], { type: file.type });
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

async function deleteCopiedBrowserSource(image, saveToken) {
  // The output has already been committed when this starts.  Keep deletion's
  // File System Access handle and server claim in IndexedDB so a lost response
  // or closed tab can finish this exact operation once.  The entry below also
  // carries a durable source snapshot until the deletion receipt is final.
  const browserEntry = browserDeleteEntry(image);
  if (!browserEntry) return { deleted: false, error: codedError("source_action_unavailable") };
  // The browser deletion happens before the server can atomically commit its
  // catalogue change. Persist reversible bytes first; without them a 4xx
  // commit rejection could leave an output copy with an unrecoverable source.
  let sourceSnapshot;
  try { sourceSnapshot = await snapshotSourceHandle(browserEntry); }
  catch (error) { return { deleted: false, error: codedError("source_restore_failed") }; }
  if (!(sourceSnapshot instanceof Blob)) return { deleted: false, error: codedError("source_restore_failed") };
  browserEntry.sourceSnapshot = sourceSnapshot;
  const deleteToken = crypto.randomUUID();
  // Persist the handle before prepare: a server receipt must never outlive
  // the browser capability needed to complete its claimed deletion.
  let pending = { deleteToken, saveToken, retryOnResume: true, imageIds: [image.id], browserDeletedImageIds: [], browserEntries: [browserEntry], state: "preparing" };
  try {
    await rememberPendingSourceDelete(pending);
    const prepared = await catalogApi("/api/catalog/delete-source/prepare", { imageIds: [image.id], deleteToken }, { method: "POST" });
    if (!(prepared.preparedImageIds || []).includes(image.id)) throw codedError("save_state_changed");
    pending = { ...pending, state: "prepared" };
    await rememberPendingSourceDelete(pending);
    await claimSourceDelete(deleteToken);
    browserEntry.state = "deleting"; pending.state = "deleting";
    await rememberPendingSourceDelete(pending);
    await browserDeleteHandle(browserEntry, image);
    browserEntry.state = "deleted"; pending.browserDeletedImageIds = [image.id]; pending.state = "deleted";
    await rememberPendingSourceDelete(pending);
    const committed = await commitSourceDeleteWithRetry({ imageIds: [image.id], deleteToken, browserDeletedImageIds: [image.id] });
    const status = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken }), resyncOnStale: false });
    if (status.state === "committed") {
      await acknowledgeSourceDelete(deleteToken);
      return { deleted: true, committed };
    }
    return { deleted: false, error: codedError("source_delete_cleanup_pending") };
  } catch (error) {
    if (browserEntry.state === "deleted" && isDefinitiveCommitRejection(error)) {
      if (!await restoreCopiedBrowserSourcesAfterRejectedDelete(pending)) {
        // The durable IDB snapshot and handles remain available for an
        // explicit recovery action.  Do not report source deletion as done.
        return { deleted: false, error: codedError("source_restore_failed") };
      }
    }
    // Do not cancel or remove the durable record. resumePendingSourceDeletes
    // reconciles the claimed/deleted state after reconnect or restart.
    console.warn("コピー後のブラウザー元画像削除は保留です: %s", error?.code || error?.code || error);
    return { deleted: false, error };
  }
}

async function restoreCopiedBrowserSourcesAfterRejectedDelete(pending) {
  const entries = (pending.browserEntries || []).filter((entry) => entry.state === "deleted");
  if (!entries.length || entries.some((entry) => !(entry.sourceSnapshot instanceof Blob))) return false;
  try {
    for (const entry of entries) {
      await restoreSourceHandle(entry, entry.sourceSnapshot, true);
      entry.state = "ready";
    }
    pending.browserDeletedImageIds = []; pending.state = "restored"; pending.retryOnResume = false;
    await rememberPendingSourceDelete(pending);
    await releaseSourceDeleteClaim(pending.deleteToken);
    await api("/api/catalog/delete-source/cancel", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
    await acknowledgeSourceDelete(pending.deleteToken);
    return true;
  } catch {
    return false;
  }
}

async function runBrowserSave(imageIds, suffix, deleteOriginal, mode = "copy", removeSaved = false, prepared = null) {
  const inputs = {
    imageIds: [...imageIds],
    divisor: Number($("#applyDivisor").value),
    suffix,
    format: selectedApplyOutputFormat(),
    keepMetadata: $("#applyKeepMetadata").checked,
    deleteOriginal,
    mode,
    removeSaved,
    projectId: state.project?.id || null,
    parallelism: Math.max(1, Math.round(Number(state.settings?.saving?.parallelism) || 2)),
    drafts: new Map(Object.entries(draftPayload(imageIds))),
    sources: new Map(imageIds.map((imageId) => [imageId, {
      image: state.images.find((image) => image.id === imageId),
      access: sourceAccessFor(imageId) ? { ...sourceAccessFor(imageId) } : null,
    }])),
  };
  const result = prepared || await api("/api/save/prepare", {
    method: "POST",
    body: JSON.stringify({ imageIds: inputs.imageIds, divisor: inputs.divisor, suffix: inputs.suffix, deleteOriginal: false, copyToDefault: mode === "copy", format: inputs.format, keepMetadata: inputs.keepMetadata }),
  });
  const save = {
    entries: result.entries, completed: 0, stale: 0, paused: false, cancelled: false, failed: false,
    sourceDeleteFailures: [], catalogEpoch: state.catalogEpoch, cleanupIntents: new Map(), savedImageIds: new Set(),
    removalSelection: removeSaved ? deletionSelectionSnapshot(new Set(imageIds), galleryFilteredImages()) : null,
  };
  state.browserSave = save;
  $("#applyPauseButton").disabled = false;
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
      const serializeBrowserHandleMutation = (work) => {
        const previous = save.browserHandleMutationChain || Promise.resolve();
        const next = previous.catch(() => {}).then(work);
        save.browserHandleMutationChain = next;
        return next;
      };
      const saveEntry = async (entry) => {
        showBrowserSaveProgress(save, entry);
        const draft = inputs.drafts.get(entry.imageId) || null;
        const source = inputs.sources.get(entry.imageId) || {};
        const sourceImage = source.image;
        const access = source.access;
        let sourceAction = "keep";
        if (inputs.mode === "copy") {
          let rendered;
          try {
            rendered = await renderDefaultCopy(entry, { imageId: entry.imageId, candidateRevision: entry.candidateRevision,
              divisor: inputs.divisor, draft, copyToDefault: true, suffix: inputs.suffix, format: inputs.format, keepMetadata: inputs.keepMetadata });
          } finally { inputs.drafts.delete(entry.imageId); }
          const saveToken = rendered.saveToken;
          if (!saveToken) throw Object.assign(new Error("save_state_changed"), { code: "save_state_changed" });
          const commitCopy = async () => {
            const browserCopyDelete = inputs.deleteOriginal && Boolean(access?.fileHandle);
            const sourceAction = inputs.deleteOriginal && !browserCopyDelete ? "deleted" : "keep";
            let commitStarted = false;
            let cleanupIntent = null;
            try {
              if (access?.fileHandle) {
                await ensureHandlePermission(access, inputs.deleteOriginal);
              }
              if (sourceAction === "deleted" && inputs.projectId) {
                cleanupIntent = await rememberProjectImageSourceCleanup(inputs.projectId, entry.imageId);
                if (cleanupIntent) save.cleanupIntents.set(entry.imageId, cleanupIntent);
              }
              if (sourceAction === "deleted") updatePendingSaveAction(saveToken, "deleted");
              commitStarted = true;
              const committed = await commitBrowserSaveWithRetry({
                imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal: inputs.deleteOriginal, sourceAction, saveToken,
              });
              if (committed.sourceDeletePending) { save.sourceDeleteFailures.push(sourceImage?.name || entry.imageId); save.sourceDeleteNotAvailable = true; }
              if (!browserCopyDelete) return { committed, sourceAction };
              const sourceDelete = await deleteCopiedBrowserSource(sourceImage, saveToken);
              if (!sourceDelete.deleted) save.sourceDeleteFailures.push(sourceImage?.name || entry.imageId);
              return { committed, sourceAction: sourceDelete.deleted ? "deleted" : "keep" };
            }
            catch (error) {
              const reconcile = !commitStarted || isDefinitiveCommitRejection(error) || error.saveState === "pending";
              if (reconcile) {
                await cancelBrowserSave(entry, saveToken);
              }
              if (cleanupIntent && isDefinitiveCommitRejection(error)) {
                await clearProjectSourceCleanup({ intentIds: [cleanupIntent] });
                save.cleanupIntents.delete(entry.imageId);
              }
              throw error;
            }
          };
          sourceAction = inputs.deleteOriginal && !access?.fileHandle ? "deleted" : "keep";
          const copyResult = inputs.deleteOriginal && access?.fileHandle
            ? await serializeBrowserHandleMutation(commitCopy)
            : await commitCopy();
          return finishBrowserSaveEntry(copyResult.committed, entry, save, copyResult.sourceAction);
        } else if (access?.fileHandle) {
          let binary;
          try {
            binary = await renderStreamedSave(entry, {
              imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: inputs.divisor, draft,
              format: inputs.format, keepMetadata: inputs.keepMetadata,
            });
          } finally { inputs.drafts.delete(entry.imageId); }
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          const noEffect = binary.headers?.get("X-Mozarie-No-Effect") === "1";
          return serializeBrowserHandleMutation(async () => {
            let sourceSnapshot = null; let sourceRename = null;
            let commitStarted = false;
            try {
              if (!noEffect) {
                await ensureHandlePermission(access, true);
                if (renamedSourceFileName(sourceImage, access, inputs.format)) sourceRename = await writeFormattedSourceHandle(access, sourceImage, inputs.format, binary);
                else {
                  sourceSnapshot = await snapshotSourceHandle(access);
                  if (!(sourceSnapshot instanceof Blob)) throw codedError("source_restore_failed");
                  await writeSourceHandle(access, binary);
                }
                sourceAction = "overwrite";
              } else {
                await ensureHandlePermission(access, false);
                sourceAction = "keep";
              }
              commitStarted = true;
              const committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal: inputs.deleteOriginal, sourceAction, saveToken, ...sourceCommitMetadata(sourceRename?.replacement || access) });
              // The server has committed the new relative path. Keep the live
              // directory handle aligned even if retiring the old name fails.
              const liveAccess = sourceAccessFor(entry.imageId);
              if (sourceRename && liveAccess) Object.assign(liveAccess, sourceRename.replacement);
              await finishFormattedSourceRename(access, sourceRename);
              if (liveAccess) Object.assign(liveAccess, access);
              return finishBrowserSaveEntry(committed, entry, save, sourceAction, noEffect);
            } catch (error) {
              const reconcile = !commitStarted || isDefinitiveCommitRejection(error) || error.saveState === "pending";
              if (reconcile) await cancelBrowserSave(entry, saveToken);
              if (sourceRename && reconcile) await discardFormattedSourceRename(access, sourceRename);
              else if (sourceSnapshot !== null && reconcile) try { await restoreSourceHandle(access, sourceSnapshot, false); } catch { throw codedError("source_restore_failed"); }
              throw error;
            } finally { sourceSnapshot = null; sourceRename = null; }
          });
        } else if (sourceImage?.sourceKind === "filesystem") {
          let binary;
          try {
            binary = await renderStreamedSave(entry, {
              imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: inputs.divisor, draft,
              format: inputs.format, keepMetadata: inputs.keepMetadata,
            });
          } finally { inputs.drafts.delete(entry.imageId); }
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          const noEffect = binary.headers?.get("X-Mozarie-No-Effect") === "1";
          sourceAction = noEffect ? "keep" : "overwrite";
          const committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal: inputs.deleteOriginal, sourceAction, saveToken });
          return finishBrowserSaveEntry(committed, entry, save, sourceAction, noEffect);
        } else {
          throw codedError("source_action_unavailable");
        }
      };
      const finishBrowserSaveEntry = (committed, entry, save, sourceAction, noEffect = false) => {
        // Saving is output-only: no candidate, manual, review, hidden, or
        // list state may be reset as a side effect.
        if (committed.stale) save.stale += 1;
        if (sourceAction === "overwrite" && state.currentId === entry.imageId) save.reloadCurrent = true;
        if (sourceAction !== "keep") save.needsCatalogReconcile = true;
        if (inputs.removeSaved && !committed.stale && (inputs.mode === "copy" || !noEffect)) save.savedImageIds.add(entry.imageId);
        save.completed += 1;
        showBrowserSaveProgress(save, entry);
      };
      let nextEntry = 0;
      const parallelism = Math.min(save.entries.length, inputs.parallelism);
      const settled = await Promise.allSettled(Array.from({ length: parallelism }, async () => {
        while (true) {
          // Cancellation is observed only before an entry starts. Once an output or source has
          // changed, commit that entry so browser files and catalog state remain consistent.
          if (!await waitForBrowserSave(save)) return;
          const entry = save.entries[nextEntry++];
          if (!entry) return;
          try { await saveEntry(entry); }
          catch (error) {
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
      : (save.sourceDeleteFailures.length
        ? t(save.sourceDeleteNotAvailable ? "sourceDelete.batchNotAvailable" : "sourceDelete.batchPending", { complete: t("apply.complete", { completed: save.completed }), names: save.sourceDeleteFailures.join("、") })
        : (save.stale ? t("apply.completeWithStale", { completed: save.completed, stale: save.stale }) : t("apply.complete", { completed: save.completed }))));
  } finally {
    inputs.drafts.clear();
    inputs.sources.clear();
    try {
      let catalogCurrent = false;
      if (save.needsCatalogReconcile) {
        try {
          // Commits may resolve out of order; apply one authoritative catalogue
          // snapshot only after every started entry has settled.
          const capturedProjectId = state.project?.id || null;
          const capturedCatalogGeneration = state.serverCatalogGeneration;
          const latest = await api("/api/images");
          reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration);
          catalogCurrent = isCurrentCatalogEpoch(save.catalogEpoch);
          if (catalogCurrent) {
            state.images = latest.images; loadReviewedPaths();
            if (inputs.projectId) {
              const previousImageIds = state.applyCatalogSnapshot?.order || [];
              const removed = previousImageIds.filter((imageId) => !state.images.some((item) => item.id === imageId));
              if (removed.length && await forgetProjectImageSources(inputs.projectId, removed)) {
                await clearProjectSourceCleanup({ intentIds: removed.map((imageId) => save.cleanupIntents.get(imageId)).filter(Boolean) });
                removed.forEach((imageId) => save.cleanupIntents.delete(imageId));
              }
            }
          }
        } catch (error) {
          showApplyError(error);
        }
        if (catalogCurrent) {
          pruneSourceAccess();
          reconcileBrowserSaveState();
          if (save.reloadCurrent && state.currentId && state.images.some((image) => image.id === state.currentId)) {
            await selectImage(state.currentId, true, { saveCurrentDraft: false });
          }
        }
      }
      if (inputs.removeSaved && save.savedImageIds.size) {
        try {
          await removeSavedCatalogEntries([...save.savedImageIds], save.catalogEpoch, save.removalSelection);
        } catch (error) {
          console.warn("保存後の一覧削除に失敗しました: %s", error?.code || error);
          setApplyResult(`${$("#applyResult").textContent} ${t("apply.removeSavedFailed")}`, true);
        }
      }
    } finally {
      state.saving = false;
      state.applyRunning = false;
      state.applyCatalogSnapshot = null;
      state.browserSave = null;
      state.job = { kind: "idle", state: "idle" };
      $("#applyPauseButton").hidden = true;
      $("#applyPauseButton").disabled = false;
      $("#applyCancelButton").hidden = true;
      $("#applyCloseButton").hidden = false;
      renderCandidates(); updateActionButtons();
    }
  }
}

async function commitBrowserSaveWithRetry(payload) {
  updatePendingSaveAction(payload.saveToken, payload.sourceAction || "keep");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const committed = await api("/api/save/commit", { method: "POST", body: JSON.stringify(payload) });
      if (committed?.sourceAction) updatePendingSaveAction(payload.saveToken, committed.sourceAction);
      await acknowledgePendingBrowserSave(payload.saveToken);
      return committed;
    } catch (error) {
      // A database write may have completed after the server started returning
      // an error. Retry the identical token once, then ask the server which
      // state won; 400-class validation errors remain definitive.
      const retryable = !error?.status || [408, 429, 500, 502, 503, 504].includes(error.status);
      if (!retryable || attempt) {
        if (!retryable) throw error;
        const status = await api("/api/save/status", { method: "POST", body: JSON.stringify(payload) }).catch(() => ({ state: "unknown" }));
        if (status.state === "committed") {
          await acknowledgePendingBrowserSave(payload.saveToken); return status;
        }
        error.saveState = status.state || "unknown";
        throw error;
      }
    }
  }
}

async function cancelBrowserSave(entry, saveToken) {
  const result = await api("/api/save/cancel", { method: "POST", body: JSON.stringify({
    imageId: entry.imageId, candidateRevision: entry.candidateRevision, saveToken,
  }) }).catch(() => null);
  if (result?.state === "committed") await acknowledgePendingBrowserSave(saveToken);
  else if (result && ["cancelled", "unknown"].includes(result.state)) forgetPendingSave(saveToken);
}

window.addEventListener("online", () => { void reconcilePendingBrowserSaves(); });
void reconcilePendingBrowserSaves();

function isDefinitiveCommitRejection(error) { return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500; }

async function startApplyFromDialog(event) {
  event.preventDefault();
  if (state.saveStarting || state.saving || isBusy() || state.importing || catalogStagingEditsActive()) return;
  const mode = selectedSaveMode();
  const copy = mode === "copy";
  const removeSaved = $("#applyRemoveSaved").checked;
  const outputDirectory = $("#applyOutputDirectoryStatus");
  if (copy && outputDirectory.value.trim() !== (state.settings?.saving?.default_output_directory || "") && !await commitOutputDirectory(outputDirectory)) return;
  if (state.saveStarting || state.saving || isBusy()) return;
  const processableIds = new Set(processableImages().map((image) => image.id));
  const imageIds = state.applyTargetIds.filter((imageId) => processableIds.has(imageId));
  if (imageIds.length !== state.applyTargetIds.length) {
    state.applyTargetIds = imageIds;
    $("#applyTargetCount").textContent = t("apply.target", { count: imageIds.length });
    syncApplyMode();
  }
  if (!imageIds.length || state.saveStarting || isBusy() || state.importing || catalogStagingEditsActive()) return;
  const suffix = $("#applySuffix").value;
  if (copy && !state.settings?.saving?.default_output_directory) { syncApplyMode(); return; }
  state.saveStarting = true;
  syncApplyMode();
  try {
    if (!copy && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
    if (copy && $("#deleteOriginal").checked && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
    state.saving = true;
    state.applyRunning = true;
    state.applyCatalogSnapshot = { order: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])) };
    updateActionButtons();
    await ensureSaveSources(imageIds, mode, copy && $("#deleteOriginal").checked);
    if (copy && !await ensureDirectoryStructurePreference($("#applyPreserveDirectoryStructure"))) return;
    if (state.candidateUpdateChains.size) await waitForCandidateMutations();
    if (state.importing) return;
    const prepared = await api("/api/save/prepare", { method: "POST", body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, deleteOriginal: false, copyToDefault: copy, format: selectedApplyOutputFormat(), keepMetadata: $("#applyKeepMetadata").checked }) });
    await Promise.all(imageIds.map((imageId) => flushWorkspaceDraft(imageId)));
    state.saveStarting = false;
    await runBrowserSave(imageIds, suffix, copy && $("#deleteOriginal").checked, mode, removeSaved, prepared);
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
      renderCandidates(); updateActionButtons();
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
  renderCandidates(); updateActionButtons();
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
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : [];
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const capturedProjectId = state.project?.id || null;
    const capturedCatalogGeneration = state.serverCatalogGeneration;
    const data = await api("/api/images");
    reconcileCatalogSnapshot(data, capturedProjectId, capturedCatalogGeneration);
    if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = data.images;
    for (const imageId of completedImageIds) state.maskStatus.delete(imageId);
    loadReviewedPaths();
    pruneSourceAccess();
    state.applyTargetIds = requestedImageIds;
    const reloadedCurrent = reloadCurrent && state.images.some((image) => image.id === keepCurrent);
    if (reloadedCurrent) {
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
    $("#applyPauseButton").disabled = false;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    if (job.state === "complete") setApplyResult(t("apply.complete", { completed: job.completed }));
    else if (job.state === "cancelled") setApplyResult(t("apply.cancelled", { completed: job.completed }));
    else showApplyError({ code: job.errorCode || "internal_error" });
    renderCandidates(); updateActionButtons();
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
  const capturedProjectId = state.project?.id || null;
  const capturedCatalogGeneration = state.serverCatalogGeneration;
  const data = await api("/api/images");
  reconcileCatalogSnapshot(data, capturedProjectId, capturedCatalogGeneration);
  if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
  state.images = data.images;
  loadReviewedPaths();
  pruneSourceAccess();
  // Auto-detection replaces candidate IDs and mask bitmaps. Never allow a
  // cached bundle (including the currently pinned one) to survive that
  // revision boundary.
  for (const imageId of targetIds) {
    state.maskStatus.delete(imageId);
    releaseCandidateBundles(imageId);
  }
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
