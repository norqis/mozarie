function detectionParallelism() {
  const value = Number($("#detectParallelism").value);
  return Number.isFinite(value) ? Math.min(4, Math.max(1, Math.round(value))) : 2;
}
function detectionTargets(prefix = "detectTarget") {
  return ["penis", "pussy"].filter((name) => $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked === true);
}
function setDetectionTargets(targets, prefix = "detectTarget") {
  const selected = new Set(targets || ["penis", "pussy"]);
  for (const name of ["penis", "pussy"]) {
    const input = $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`); input.checked = selected.has(name); syncDetectionTargetSwitch(input);
  }
}

function persistedDetectionTargets() { return state.settings?.detection?.targets || []; }
function detectionCandidatePadding() {
  const text = String($("#detectCandidatePadding").value).trim();
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) && value <= 16384 ? value : null;
}
function validateDetectionCandidatePadding() {
  const valid = detectionCandidatePadding() !== null;
  const message = $("#detectPaddingValidation");
  message.textContent = valid ? "" : t("detectDialog.candidatePaddingInvalid"); message.hidden = valid;
  $("#detectCandidatePadding").setAttribute("aria-invalid", String(!valid));
  return valid;
}
function syncDetectionActions() {
  const enabled = persistedDetectionTargets().length > 0 && !isBusy() && !state.importing
    && !state.projectReadOnly && !currentRecord()?.sourceDimensionsChanged;
  $("#detectAllButton").disabled = !enabled || !state.images.length;
  $("#detectCurrentButton").disabled = !enabled || !state.currentId;
}

function syncDetectionTargetSwitch(input) {
  const label = input.closest(".target-chip");
  label?.classList.toggle("is-selected", input.checked);
}

function validateDetectionTargets(targetClasses, target = null) {
  const message = targetClasses.length ? "" : t("error.detectionTargetsRequired");
  if (target) { target.textContent = message; target.hidden = !message; }
  if (target?.id === "detectTargetValidation") $("#detectStartButton").disabled = !targetClasses.length;
  return !message;
}

function normaliseImportParallelism(value) {
  if (String(value ?? "").trim() === "") return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.round(number))) : 3;
}

function importParallelism() {
  return normaliseImportParallelism(state.settings?.importing?.parallelism);
}

function openDetectionDialog(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.pendingDetectionTargetIds = [...imageIds];
  setDetectionConfidence(detectionConfidence());
  $("#detectParallelism").value = String(detectionParallelism());
  $("#detectCandidatePadding").value = String(state.settings?.detection?.default_candidate_padding_px || 0);
  $("#detectCandidatePadding").setAttribute("aria-invalid", "false"); $("#detectPaddingValidation").hidden = true;
  $("#detectParallelism").disabled = false;
  setDetectionTargets(state.settings?.detection?.targets, "dialogTarget");
  validateDetectionTargets(detectionTargets("dialogTarget"), $("#detectTargetValidation"));
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  showModalFromInvoker($("#detectDialog"));
}

async function runDetection(imageIds, confidence = detectionConfidence(), parallelism = 1, targetClasses = persistedDetectionTargets()) {
  if (!imageIds.length || (!state.detectionStarting && (isBusy() || state.importing))) return;
  if (!validateDetectionTargets(targetClasses, $("#detectionTargetValidation"))) return;
  if (!state.detectionStarting) beginDetectionStart(imageIds);
  updateActionButtons();
  try {
    // Freeze the current manual layers before the server replaces automatic
    // candidates. The completion refresh must not save the old candidate set
    // against the new candidate revision.
    await saveDraft();
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence, parallelism: Math.min(4, Math.max(1, Math.round(parallelism))), targetClasses }) });
    state.detectionTargetIds = [...imageIds];
    state.detectCancelRequested = false;
    updateProgress(state.job); setStatusKey("status.detectStarted", {}, "running");
  } catch (error) { failDetectionStart(error); }
  finally { state.detectionStarting = false; updateActionButtons(); }
}

function beginDetectionStart(imageIds) {
  state.detectionStarting = true;
  state.detectionTargetIds = [...imageIds];
  state.detectCancelRequested = false;
  state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "", imageIds: [...imageIds], completedImageIds: [] };
  showProcessing(state.job);
  updateProgress(state.job);
}

function failDetectionStart(error) {
  state.job = { kind: "detect", state: "idle", total: 0, completed: 0, current: "" };
  state.detectionTargetIds = [];
  state.detectCancelRequested = false;
  closeProcessing();
  updateProgress(state.job);
  showUserError(error);
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  const imageIds = state.pendingDetectionTargetIds;
  if (!imageIds.length) return;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  const parallelism = detectionParallelism();
  const targetClasses = detectionTargets("dialogTarget");
  if (!validateDetectionTargets(targetClasses, $("#detectTargetValidation")) || !validateDetectionCandidatePadding()) return;
  const defaultCandidatePadding = detectionCandidatePadding();
  $("#detectDialog").close();
  state.pendingDetectionTargetIds = [];
  beginDetectionStart(imageIds);
  if (state.settings) {
    const settings = structuredClone(state.settings);
    settings.detection = { ...settings.detection, threshold: confidence, parallelism, targets: targetClasses, default_candidate_padding_px: defaultCandidatePadding };
    try {
      const saved = await api("/api/settings?status=0", { method: "POST", body: JSON.stringify(settings) });
      state.settings = saved.settings;
      setSettingsForm(saved.settings, state.settingsStatus);
    }
    catch (error) { setSettingsForm(state.settings, state.settingsStatus); failDetectionStart(error); state.detectionStarting = false; updateActionButtons(); return; }
  }
  await runDetection(imageIds, confidence, parallelism, targetClasses);
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
  if (isBusy() || state.importing || !imageId) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const record = state.images.find((image) => image.id === imageId);
  if (isBusy() || state.importing || state.currentId !== imageId || !record || !imageHasMask(record)) return;
  await openSingleSaveDialog(imageId);
}

async function saveAll() {
  if (isBusy() || state.importing) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (isBusy() || state.importing) return;
  saveDraft(); refreshMaskStatus();
  if (state.images.length) await openApplyDialog({ initialMode: "all" });
}
