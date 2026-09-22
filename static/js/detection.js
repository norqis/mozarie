function detectionParallelism() {
  const value = Number($("#detectParallelism").value);
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 2;
}
function detectionTargets(prefix = "dialogTarget") {
  return ["penis", "pussy"].filter((name) => $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked === true);
}
function setDetectionTargets(targets, prefix = "dialogTarget") {
  const selected = new Set(targets || ["penis", "pussy"]);
  for (const name of ["penis", "pussy"]) {
    const input = $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`); input.checked = selected.has(name); syncDetectionTargetSwitch(input);
  }
}

const DETECTION_IMAGE_FILTERS = ["masked", "unmasked", "reviewed", "unreviewed"];

function detectionImageFilters() {
  return DETECTION_IMAGE_FILTERS.filter((name) => $(`[data-detection-image-filter="${name}"]`).checked);
}

function setDetectionImageFilters(filters) {
  const selected = new Set(filters || []);
  for (const name of DETECTION_IMAGE_FILTERS) {
    const input = $(`[data-detection-image-filter="${name}"]`);
    input.checked = selected.has(name);
    syncDetectionTargetSwitch(input);
  }
}

function detectionDialogTargetImages() {
  const baseIds = new Set(state.detectionDialogBaseIds || []);
  const images = processableImages().filter((image) => baseIds.has(image.id));
  if (!state.detectionDialogFilterable) return images;
  const filters = new Set(detectionImageFilters());
  return images.filter((image) => imageMatchesStateFilter(image, filters));
}

function syncDetectionDialog() {
  const imageIds = detectionDialogTargetImages().map((image) => image.id);
  state.pendingDetectionTargetIds = imageIds;
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  const targetsValid = validateDetectionTargets(detectionTargets("dialogTarget"), $("#detectTargetValidation"));
  $("#detectStartButton").disabled = state.detectionDialogSubmitting || !targetsValid || (!state.detectionSettingsOnly && imageIds.length === 0);
  return imageIds;
}

function resetDetectionDialogState() {
  state.pendingDetectionTargetIds = [];
  state.detectionDialogBaseIds = [];
  state.detectionDialogFilterable = false;
  state.detectionDialogSubmitting = false;
  state.detectionSettingsOnly = false;
  $("#detectTargetValidation").hidden = true;
}

function setDetectionDialogSubmitting(submitting) {
  state.detectionDialogSubmitting = submitting;
  for (const control of $("#detectForm").querySelectorAll("input, button")) control.disabled = submitting;
  if (!submitting) {
    syncDetectionFluidColorFill();
    syncDetectionDialog();
  }
}

function persistedDetectionTargets() { return state.settings?.detection?.targets || []; }
function persistedFluidColorFill() {
  return {
    fluidColorFillEnabled: state.settings?.detection?.fluid_color_fill_enabled !== false,
    fluidColorFillTolerance: state.settings?.detection?.fluid_color_fill_tolerance ?? 26,
  };
}
function detectionCandidatePadding(selector = "#detectCandidatePadding") {
  const text = String($(selector).value).trim();
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) ? value : null;
}
function validateDetectionCandidatePadding() {
  const valid = detectionCandidatePadding() !== null && detectionCandidatePadding("#detectExcludeCandidatePadding") !== null;
  const message = $("#detectPaddingValidation");
  message.textContent = valid ? "" : t("detectDialog.candidatePaddingInvalid"); message.hidden = valid;
  $("#detectCandidatePadding").setAttribute("aria-invalid", String(!valid));
  return valid;
}
function detectionFluidColorFillTolerance() {
  const text = String($("#detectFluidColorFillTolerance").value).trim();
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) && value <= 255 ? value : null;
}
function validateDetectionFluidColorFill() {
  const active = state.settings?.detection?.fluid_exclusion_enabled !== false && $("#detectFluidColorFillEnabled").checked;
  const valid = !active || detectionFluidColorFillTolerance() !== null;
  const input = $("#detectFluidColorFillTolerance");
  const message = $("#detectFluidColorFillValidation");
  input.setAttribute("aria-invalid", String(!valid));
  message.textContent = valid ? "" : t("detectDialog.fluidColorFillToleranceInvalid");
  message.hidden = valid;
  return valid;
}
function syncDetectionFluidColorFill() {
  const enabled = state.settings?.detection?.fluid_exclusion_enabled !== false;
  const checkbox = $("#detectFluidColorFillEnabled");
  checkbox.disabled = !enabled;
  $("#detectFluidColorFillTolerance").disabled = !enabled || !checkbox.checked;
  validateDetectionFluidColorFill();
}
function syncDetectionActions() {
  const enabled = persistedDetectionTargets().length > 0 && !isBusy() && !state.importing && !catalogStagingEditsActive()
    && !state.projectReadOnly && !currentRecord()?.sourceDimensionsChanged && !currentImageActionPending();
  $("#detectAllButton").disabled = !enabled || !allImageDetectionTargets().length;
  $("#detectCurrentButton").disabled = !enabled || !isProcessableImage(currentRecord());
}

function syncDetectionTargetSwitch(input) {
  const label = input.closest(".target-chip");
  label?.classList.toggle("is-selected", input.checked);
}

function validateDetectionTargets(targetClasses, target = null) {
  const message = targetClasses.length ? "" : t("error.detectionTargetsRequired");
  if (target) { target.textContent = message; target.hidden = !message; }
  return !message;
}

function normaliseImportParallelism(value) {
  if (String(value ?? "").trim() === "") return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : 3;
}

function importParallelism() {
  return normaliseImportParallelism(state.settings?.importing?.parallelism);
}

function openDetectionDialog(imageIds, { filterable = false, settingsOnly = false } = {}) {
  const ids = new Set(processableImages().map((image) => image.id));
  imageIds = [...new Set(imageIds)].filter((imageId) => ids.has(imageId));
  if ((!settingsOnly && !imageIds.length) || isBusy() || state.importing || catalogStagingEditsActive()) return;
  state.detectionSettingsOnly = settingsOnly;
  state.detectionDialogBaseIds = [...imageIds];
  state.detectionDialogFilterable = filterable;
  state.detectionDialogSubmitting = false;
  $("#detectDialogTitle").dataset.i18n = settingsOnly ? "detection.title" : "detectDialog.title";
  $("#detectDialogTitle").textContent = t($("#detectDialogTitle").dataset.i18n);
  $("#detectStartButton").dataset.i18n = settingsOnly ? "dialog.save" : "detectDialog.start";
  $("#detectStartButton").textContent = t($("#detectStartButton").dataset.i18n);
  $("#detectTargetCount").hidden = settingsOnly;
  $("#detectParallelismRow").hidden = settingsOnly;
  $("#detectImageFilters").hidden = !filterable;
  setDetectionImageFilters(state.settings?.detection?.image_filters || ["unreviewed"]);
  setDetectionConfidence(detectionConfidence());
  $("#detectParallelism").value = String(state.settings?.detection?.parallelism || 2);
  $("#detectCandidatePadding").value = String(state.settings?.detection?.default_candidate_padding_px || 0);
  $("#detectExcludeCandidatePadding").value = String(state.settings?.detection?.default_exclude_candidate_padding_px || 0);
  $("#detectFluidColorFillEnabled").checked = state.settings?.detection?.fluid_color_fill_enabled !== false;
  $("#detectFluidColorFillTolerance").value = String(state.settings?.detection?.fluid_color_fill_tolerance ?? 26);
  $("#detectCandidatePadding").setAttribute("aria-invalid", "false"); $("#detectPaddingValidation").hidden = true;
  syncDetectionFluidColorFill();
  $("#detectParallelism").disabled = false;
  setDetectionTargets(state.settings?.detection?.targets, "dialogTarget");
  syncDetectionDialog();
  showModalFromInvoker($("#detectDialog"));
}

async function runDetection(imageIds, confidence = detectionConfidence(), parallelism = 1, targetClasses = persistedDetectionTargets(), fluidColorFill = null, prepared = false) {
  if (!prepared) {
    const ids = new Set(processableImages().map((image) => image.id));
    imageIds = [...new Set(imageIds)].filter((imageId) => ids.has(imageId));
  } else {
    imageIds = [...imageIds];
  }
  if (!imageIds.length || catalogStagingEditsActive() || (!state.detectionStarting && (isBusy() || state.importing))) return;
  if (!validateDetectionTargets(targetClasses)) return;
  const previousJob = state.job;
  const previousDetectionTargetIds = [...(state.detectionTargetIds || [])];
  const previousDetectCancelRequested = state.detectCancelRequested;
  state.detectionStarting = true;
  updateActionButtons();
  try {
    if (!prepared) {
      await flushAllImageMutations();
      await saveDraft();
      await flushAllWorkspaceMutations();
    }
    const payload = { imageIds, confidence, parallelism: Math.max(1, Math.round(parallelism)), targetClasses };
    if (fluidColorFill) Object.assign(payload, fluidColorFill);
    await api("/api/detect", { method: "POST", body: JSON.stringify(payload) });
    beginDetectionStart(imageIds);
    updateProgress(state.job); setStatusKey("status.detectStarted", {}, "running");
  } catch (error) {
    state.job = previousJob;
    state.detectionTargetIds = previousDetectionTargetIds;
    state.detectCancelRequested = previousDetectCancelRequested;
    if (state.job) updateProgress(state.job);
    showUserError(error);
  }
  finally { state.detectionStarting = false; updateActionButtons(); }
}

function beginDetectionStart(imageIds) {
  state.detectionStarting = true;
  state.detectionTargetIds = [...imageIds];
  state.detectCancelRequested = false;
  state.job = { kind: "detect", state: "running", phase: "preparing_models", total: imageIds.length, completed: 0, processed: 0, current: "", imageIds: [...imageIds], completedImageIds: [] };
  showProcessing(state.job);
  updateProgress(state.job);
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  if (catalogStagingEditsActive() || state.detectionDialogSubmitting) return;
  const settingsOnly = state.detectionSettingsOnly;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  const parallelism = detectionParallelism();
  const targetClasses = detectionTargets("dialogTarget");
  if (!validateDetectionTargets(targetClasses, $("#detectTargetValidation")) || !validateDetectionCandidatePadding() || !validateDetectionFluidColorFill()) return;
  const defaultCandidatePadding = detectionCandidatePadding();
  const defaultExcludeCandidatePadding = detectionCandidatePadding("#detectExcludeCandidatePadding");
  const fluidExclusionEnabled = state.settings?.detection?.fluid_exclusion_enabled !== false;
  const fluidColorFillEnabled = fluidExclusionEnabled
    ? $("#detectFluidColorFillEnabled").checked
    : state.settings?.detection?.fluid_color_fill_enabled !== false;
  const fluidColorFillTolerance = detectionFluidColorFillTolerance()
    ?? state.settings?.detection?.fluid_color_fill_tolerance
    ?? 26;
  setDetectionDialogSubmitting(true);
  try {
    if (!settingsOnly) {
      await flushAllImageMutations();
      await saveDraft();
      await flushAllWorkspaceMutations();
    }
    const imageIds = syncDetectionDialog();
    if (!settingsOnly && !imageIds.length) { setDetectionDialogSubmitting(false); return; }
    if (state.settings) {
      const settings = structuredClone(state.settings);
      settings.detection = {
        ...settings.detection,
        threshold: confidence,
        ...(!settingsOnly ? { parallelism } : {}),
        targets: targetClasses,
        default_candidate_padding_px: defaultCandidatePadding,
        default_exclude_candidate_padding_px: defaultExcludeCandidatePadding,
        fluid_color_fill_enabled: fluidColorFillEnabled,
        fluid_color_fill_tolerance: fluidColorFillTolerance,
        ...(state.detectionDialogFilterable ? { image_filters: detectionImageFilters() } : {}),
      };
      const saved = await api("/api/settings?status=0", { method: "POST", body: JSON.stringify(settings) });
      state.settings = saved.settings;
      setSettingsForm(saved.settings, state.settingsStatus);
    }
    setDetectionDialogSubmitting(false);
    $("#detectDialog").close();
    resetDetectionDialogState();
    if (settingsOnly) { updateActionButtons(); return; }
    state.detectionStarting = true;
    updateActionButtons();
    await runDetection(imageIds, confidence, parallelism, targetClasses, {
      fluidColorFillEnabled,
      fluidColorFillTolerance,
    }, true);
  } catch (error) {
    setDetectionDialogSubmitting(false);
    showUserError(error);
  }
}

async function cancelDetection() {
  if (!activeDetection() || state.detectCancelRequested) return;
  state.detectCancelRequested = true;
  $("#processingCancelButton").disabled = true;
  updateActionButtons();
  setStatusKey("status.detectCancelling", {}, "running");
  try {
    const job = await api("/api/job/cancel", { method: "POST", body: JSON.stringify({}) });
    state.job = job; updateProgress(job); scheduleJobPoll(true);
  }
  catch (error) { state.detectCancelRequested = false; if (state.processing) showProcessing(state.processing); updateActionButtons(); showUserError(error, $("#processingCancelButton")); }
}

async function saveCurrent() {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  if (isBusy() || state.importing || catalogStagingEditsActive() || currentImageActionPending() || !imageId) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const record = state.images.find((image) => image.id === imageId);
  if (isBusy() || state.importing || currentImageActionPending() || state.currentId !== imageId || !isCurrentGeneration(generation)
    || !state.currentImage || state.projectReadOnly || record?.sourceDimensionsChanged || !isProcessableImage(record)) return;
  await openSingleSaveDialog(imageId);
}

async function saveAll() {
  if (isBusy() || state.importing || catalogStagingEditsActive()) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (isBusy() || state.importing) return;
  saveDraft(); refreshMaskStatus();
  if (processableImages().length) await openApplyDialog();
}
