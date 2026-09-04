const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], currentId: null, currentImage: null, pendingImageId: null, galleryFilter: "all", maskStatus: new Map(),
  viewMode: "edit", displayMode: "single", compareSplit: .5, overviewFilter: "all", overviewQuery: "", overviewFolder: "", reviewedPaths: new Set(), hiddenPaths: new Set(), reviewRoot: "",
  selectedImageIds: new Set(), selectionAnchorId: null, batchMode: false,
  navigationShortcutsEnabled: true,
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", panning: false, drawing: false, gestureDisplaySide: null, hoverDisplaySide: "left", boundaryPending: false,
  boundaryRoi: null, boundaryStart: null, boundaryStartClient: null, boundaryPoint: null, boundaryPromptPoint: null, boundaryDragging: false, boundaryDisplaySide: "left",
  boundaryDrafts: [], boundaryDraftSequence: 0, boundaryActiveId: null, boundaryBrushStroke: null,
  polygonPoints: [], polygonDragIndex: -1, polygonDraftDrag: null, blinkCandidateIds: new Set(), blinkModes: new Map(), blinkPhase: false, blinkTimer: null,
  pointer: null, hover: null, brushCursorGeometry: "", history: [], historyIndex: 0, activeStroke: null, manualStrokePaintFrame: 0, removedCandidateIds: new Set(),
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, saveStarting: false, detectionStarting: false, masksClearing: false,
  catalogMutation: false, imageGeneration: 0, catalogEpoch: 0, viewGeneration: 0, historyRestoreToken: 0, translations: {},
  applyTargetIds: [], applyTargetMode: "masked", applyCatalogSnapshot: null, applyRunning: false, applyFinishing: false, handledApplyStartedAt: null, importing: false, mosaicPreviewEnabled: true, mosaicPreviewGeneration: 0, mosaicWorker: null, mosaicPreviewRequested: false, mosaicWorkerBusy: false, mosaicPending: null, mosaicPreviewRoi: null, mosaicSourceImage: null, mosaicSourceId: "", mosaicSourcePromise: null, mosaicPreviewFailureReported: false,
  outputDirectoryPicking: false, outputDirectoryHandle: null, singleSave: null,
  detectionTargetIds: [], pendingDetectionTargetIds: [], detectCancelRequested: false,
  pageLoadedAt: Date.now() / 1000, handledDetectionStartedAt: null, importSession: null,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(), candidateBatchPending: new Set(),
  manualMaskPresent: false, manualEnabled: true, manualExclusionEnabled: true, manualExclusionForced: true, manualExclusionEraseEnabled: true,
  galleryNodes: new Map(), overviewNodes: new Map(), contextMenuImageId: null, contextMenuOrigin: null, contextMenuScroll: null, browserSave: null, pollInFlight: null, pollFailures: 0,
  // Browser file handles never leave this tab. They make imported images real save targets.
  sourceAccess: new Map(),
  // Projectless directory imports retain their root only until the session is named.
  projectlessDirectorySources: new Map(),
  projectlessPromotion: null,
  processing: null, imageInflight: new Map(), candidateInflight: new Map(), loadingDelay: null, pendingImageKey: null, pendingCandidateKey: null,
  galleryCollapsed: false, inspectorCollapsed: false,
  settings: null, settingsStatus: null, jobPollTimer: null,
  imageCache: null, candidateBundleCache: null, catalogLoadControllers: new Set(),
  prefetchQueue: [], prefetchActive: 0, prefetchTimer: null,
  fillWorker: null, fillPending: false,
  project: null, projectReadOnly: false, projectHistory: new Map(), projectHistoryBusy: false,
  missingNativeSources: [],
  renderFrame: 0,
  maskDirty: false, draftDirty: false, draftLayerDirty: new Set(), draftDirtyRois: new Map(), historyBaseDirty: false, draftSaveChains: new Map(),
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const toolRail = $("#canvasToolRail");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const exclusionCanvas = document.createElement("canvas");
const exclusionEraseCanvas = document.createElement("canvas");
const effectiveExclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const mosaicCanvas = document.createElement("canvas");
const originalCanvas = document.createElement("canvas");
const historyAddCanvas = document.createElement("canvas");
const historyExclusionCanvas = document.createElement("canvas");
const historyExclusionEraseCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const boundaryOverlayCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const exclusionEraseCtx = exclusionEraseCanvas.getContext("2d");
const effectiveExclusionCtx = effectiveExclusionCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const mosaicCtx = mosaicCanvas.getContext("2d");
const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true });
const layerCtx = layerCanvas.getContext("2d");
const boundaryOverlayCtx = boundaryOverlayCanvas.getContext("2d");
let renderedWidth = 0;
let renderedHeight = 0;
let translationGeneration = 0;

function t(key, params = {}) {
  let value = state.translations[key];
  if (typeof value !== "string") return "";
  for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, replacement);
  return value;
}

const USER_ERROR_CODES = {
  gpu_unsupported: "gpu_not_available", gpu_unavailable: "gpu_runtime_unavailable",
  gpu_out_of_memory: "gpu_memory_low", memory_allocation_failed: "system_memory_low",
  no_effective_mask: "no_mosaic_area", stale_asset: "image_changed",
  model_profile_invalid: "model_file_invalid", sam_checkpoint_invalid: "model_type_mismatch",
  sam_provider_unavailable: "gpu_runtime_unavailable", hand_segmentation_invalid: "model_load_failed",
  model_picker_busy: "operation_in_progress", model_picker_failed: "model_picker_failed", model_picker_invalid: "model_file_invalid",
  model_download_invalid: "model_download_invalid", catalog_changed: "catalog_changed", job_running: "operation_in_progress",
  mask_not_found: "mask_not_found", candidate_not_found: "mask_not_found", invalid_settings: "input_invalid", invalid_request: "input_invalid",
  api_not_found: "response_invalid", connection_lost: "connection_lost", output_folder_unavailable: "output_folder_unavailable", output_permission_denied: "output_permission_denied", request_failed: "internal_error",
  image_not_found: "image_not_found", image_read_failed: "image_read_failed", image_format_unsupported: "image_format_unsupported",
  save_write_failed: "save_write_failed", save_state_changed: "save_state_changed", folder_not_found: "folder_not_found",
  source_restore_failed: "project_source_unavailable", project_source_unavailable: "project_source_unavailable", project_name_invalid: "project_name_invalid", project_name_duplicate: "project_name_duplicate", project_read_only: "project_read_only",
  project_not_found: "folder_not_found", workspace_recreate_required: "workspace_corrupt", source_mismatch: "image_changed",
  source_permission_denied: "source_permission_denied", source_action_unavailable: "source_action_unavailable",
  source_busy: "source_busy", source_write_unsupported: "source_write_unsupported", output_write_unsupported: "output_write_unsupported", output_cleanup_failed: "output_cleanup_failed",
  clipboard_write_failed: "clipboard_write_failed",
  workspace_corrupt: "workspace_corrupt", workspace_write_failed: "workspace_write_failed", workspace_database_error: "workspace_write_failed",
  output_unavailable: "output_folder_unavailable", model_not_configured: "model_not_configured",
  directory_picker_unsupported: "directory_picker_unsupported", output_name_exhausted: "output_name_exhausted",
  model_file_missing: "model_file_missing", model_file_invalid: "model_file_invalid", model_load_failed: "model_load_failed", sam_checkpoint_missing: "sam_checkpoint_missing",
  gpu_runtime_unavailable: "gpu_runtime_unavailable", operation_in_progress: "operation_in_progress", outline_not_found: "outline_not_found",
  input_invalid: "input_invalid", session_expired: "session_expired", model_download_network: "model_download_network",
  model_download_write_failed: "model_download_write_failed", model_download_integrity: "model_download_integrity",
  mosaic_preview_failed: "mosaic_preview_failed",
  internal_error: "internal_error",
};

const CANDIDATE_CLASS_TOKENS = new Set(["penis", "pussy", "testicles", "boundary", "boundary_polygon", "hand", "fluid"]);
const CANDIDATE_SOURCE_TOKENS = new Set(["auto", "target", "ntd11", "sensitive", "boundary", "hand_exclusion", "fluid_exclusion"]);
const CANDIDATE_REFINEMENT_TOKENS = new Set(["sam_high_precision"]);

function validCandidateTokens(candidate) {
  return CANDIDATE_CLASS_TOKENS.has(candidate?.labelToken)
    && CANDIDATE_SOURCE_TOKENS.has(candidate.source)
    && (candidate.refinement === null || CANDIDATE_REFINEMENT_TOKENS.has(candidate.refinement));
}

function codedError(code, params = {}) {
  const error = new Error();
  error.code = code;
  error.params = params;
  return error;
}

function userErrorCode(error) {
  const code = typeof error === "string" ? error : error?.code;
  return USER_ERROR_CODES[code] || "internal_error";
}

function showUserError(error, invoker = document.activeElement) {
  const code = userErrorCode(error);
  if (code === "connection_lost") { showConnectionFailure(); return; }
  const dialog = $("#errorDialog");
  if (!dialog) return;
  $("#errorDialogTitle").textContent = t(`errorDialog.${code}.title`);
  $("#errorDialogCause").textContent = t(`errorDialog.${code}.cause`);
  $("#errorDialogAction").textContent = t(`errorDialog.${code}.action`);
  if (dialog.open) { focusElement($("#errorDialogClose")); return; }
  showModalFromInvoker(dialog, invoker);
}

async function loadTranslations(languageOverride = null) {
  const generation = ++translationGeneration;
  const language = languageOverride === "en" || (!languageOverride && state.settings?.general?.language === "en") ? "en" : "ja";
  document.documentElement.lang = language;
  state.translations = {};
  document.querySelectorAll("[data-i18n]:not([data-i18n-dynamic]), .candidate-section h3").forEach((element) => { element.textContent = ""; });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.removeAttribute("title"); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.removeAttribute("aria-label"); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.removeAttribute("placeholder"); });
  let translations;
  try {
    const response = await fetch(`/i18n/${language}.json`);
    if (!response.ok) throw new Error("translation request failed");
    translations = await response.json();
    if (!translations || Array.isArray(translations) || typeof translations !== "object") throw new Error("invalid translation response");
  } catch {
    return false;
  }
  if (generation !== translationGeneration) return false;
  state.translations = translations;
  document.querySelectorAll("[data-i18n]:not([data-i18n-dynamic])").forEach((element) => {
    const value = state.translations[element.dataset.i18n]; if (value) element.textContent = value;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const value = state.translations[element.dataset.i18nTitle]; if (value) element.title = value;
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    const value = state.translations[element.dataset.i18nAriaLabel]; if (value) element.setAttribute("aria-label", value);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const value = state.translations[element.dataset.i18nPlaceholder]; if (value) element.placeholder = value;
  });
  const sectionHeadings = document.querySelectorAll(".candidate-section h3");
  if (sectionHeadings[0]) sectionHeadings[0].textContent = t("candidates.applyRanges");
  if (sectionHeadings[1]) sectionHeadings[1].textContent = t("candidates.excludeRanges");
  renderModelStatus();
  renderLocalizedDynamicState();
  document.querySelectorAll(".target-chip input").forEach((input) => syncDetectionTargetSwitch(input));
  updateBoundaryActions();
  renderCatalogViews(); renderCandidates(); render();
  return true;
}

function responseError(response, payload) {
  const code = typeof payload?.error_code === "string"
    ? payload.error_code
    : (response.status === 404 ? "api_not_found" : "internal_error");
  const params = payload?.params && typeof payload.params === "object" && !Array.isArray(payload.params) ? payload.params : {};
  const error = codedError(code, params);
  error.status = response.status;
  return error;
}

function api(path, options = {}) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Mozarie-Token": token, ...(options.headers || {}) },
  })
    .then(async (response) => {
      if (state.status?.connectionFailure) clearStatus();
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw responseError(response, data);
      }
      return data;
    })
    .catch((error) => {
      if (error?.code) throw error;
      const safeError = new Error();
      safeError.code = "connection_lost";
      throw safeError;
    });
}

function showConnectionFailure() {
  state.status = { message: t("error.connectionLost"), kind: "error", connectionFailure: true };
  renderStatus();
}

function setStatus(message, kind = "") {
  if (kind === "error") { state.status = { message: "", kind: "" }; renderStatus(); showUserError(message); return; }
  state.status = { message, kind };
  renderStatus();
}

function setStatusKey(key, params = {}, kind = "") {
  if (kind === "error") {
    if (key === "error.connectionLost") { showConnectionFailure(); return; }
    state.status = { message: "", kind: "" }; renderStatus(); showUserError("internal_error"); return;
  }
  state.status = { key, params, kind };
  renderStatus();
}
function clearStatus() { state.status = { message: "", kind: "" }; renderStatus(); }

function processingTitle(kind) {
  return t(kind === "detect" ? "processing.detect" : "processing.import");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const remainder = total % 60;
  if (hours) return `${t("duration.hour", { count: hours })} ${t("duration.minute", { count: minutes })}`;
  if (minutes) return `${t("duration.minute", { count: minutes })} ${t("duration.second", { count: remainder })}`;
  return t("duration.second", { count: remainder });
}

function progressText(job) {
  const count = t("status.progressCount", { completed: job.completed || 0, total: job.total || 0 });
  if (job.kind !== "detect" || job.state !== "running" || !job.completed || job.completed >= job.total) return count;
  const key = `${job.kind}:${job.startedAt || ""}`;
  const eta = state.detectionEta;
  if (!eta || eta.key !== key || Number(job.completed) > eta.completed) {
    state.detectionEta = {
      key,
      completed: Number(job.completed),
      remaining: (Number(job.activeElapsed) / Number(job.completed)) * (Number(job.total) - Number(job.completed)),
    };
  }
  return `${count} · ${t("status.eta", { duration: formatDuration(state.detectionEta.remaining) })}`;
}

function processingCurrentPath(job) {
  if (job?.kind !== "detect") return job?.current || "";
  const imageIds = job.imageIds || [];
  const completedIds = new Set(job.completedImageIds || []);
  const targetIds = new Set(imageIds);
  if (!targetIds.size) return job.current || "";
  if (![...targetIds].some((imageId) => !completedIds.has(imageId))) return "";
  const nextImage = state.images.find((image) => targetIds.has(image.id) && !completedIds.has(image.id));
  return nextImage ? (nextImage.relativePath || "") : (job.current || "");
}

function showProcessing(processing) {
  state.processing = { ...state.processing, ...processing };
  const current = state.processing;
  const modal = $("#processingDialog");
  $("#processingTitle").textContent = processingTitle(current.kind);
  $("#processingCurrent").textContent = processingCurrentPath(current);
  $("#processingProgress").max = Math.max(1, Number(current.total) || 1);
  $("#processingProgress").value = Math.min($("#processingProgress").max, Number(current.completed) || 0);
  $("#processingProgressText").textContent = progressText(current);
  const cancelling = Boolean(current.cancelRequested || state.detectCancelRequested || state.importSession?.cancelled);
  $("#processingPauseButton").textContent = t(current.state === "paused" ? "apply.resume" : "apply.pause");
  $("#processingPauseButton").disabled = current.state === "pausing" || cancelling;
  $("#processingCancelButton").disabled = cancelling;
  showModalFromInvoker(modal);
}

function closeProcessing() {
  state.processing = null;
  state.detectionEta = null;
  for (const id of ["#processingPauseButton", "#processingCancelButton"]) {
    const control = $(id); control.disabled = false; delete control.dataset.disabledByLock;
  }
  const modal = $("#processingDialog");
  if (modal.open) modal.close();
  updateActionButtons();
}

function renderStatus() {
  const status = state.status;
  const message = status ? (status.key ? t(status.key, status.params) : status.message) : "";
  const headerStatus = $("#connectionStatus");
  headerStatus.textContent = message;
  headerStatus.className = `appbar-status ${status?.kind || ""}`;
  const isError = status?.kind === "error";
  headerStatus.setAttribute("role", isError ? "alert" : "status");
  headerStatus.setAttribute("aria-live", isError ? "assertive" : "polite");
  headerStatus.hidden = !message;
}

function renderLocalizedDynamicState() {
  const record = currentRecord();
  $("#currentFileName").textContent = record && state.currentImage
    ? record.relativePath
    : t("editor.none");
  updateNavigationControls();
  updateCandidateStatus();
  syncApplyMode();
  updateProgress(state.job);
  renderStatus();
  if (typeof renderProjectTable === "function") renderProjectTable();
}

function currentRecord() { return state.images.find((image) => image.id === state.currentId) || null; }
function isCurrentGeneration(generation) { return state.imageGeneration === generation; }
function normaliseDetectionConfidence(value) { return Math.max(0.10, Math.min(1.00, Number(value) || 0.50)); }
function detectionConfidence() { return normaliseDetectionConfidence($("#confidence").value); }
function setDetectionConfidence(value) {
  const confidence = normaliseDetectionConfidence(value);
  $("#confidence").value = confidence.toFixed(2);
  $("#confidenceValue").textContent = confidence.toFixed(2);
  $("#detectConfidenceRange").value = confidence.toFixed(2);
  $("#detectConfidenceNumber").value = confidence.toFixed(2);
}
function activeDetection() { return state.job?.kind === "detect" && ["running", "pausing", "paused"].includes(state.job?.state); }
function normaliseDivisor(value) { return Math.max(1, Math.min(10000, Math.round(Number(value) || 100))); }
function mosaicDivisor() { return normaliseDivisor($("#divisor").value); }
function calculatedBlockSize(image = currentRecord(), divisor = mosaicDivisor()) {
  return image ? Math.max(4, Math.ceil(Math.max(image.width, image.height) / divisor)) : 0;
}
function isBusy() {
  return ["running", "pausing", "paused"].includes(state.job?.state)
    || state.saving || state.saveStarting || state.detectionStarting || state.masksClearing
    || state.processing?.kind === "detect"
    || state.catalogMutation || state.boundaryPending || state.fillPending;
}
function beginCatalogEpoch() { state.catalogEpoch += 1; return state.catalogEpoch; }
function isCurrentCatalogEpoch(epoch) { return state.catalogEpoch === epoch; }
function catalogRecordMatches(record, epoch, { version = imageAssetVersion(record), revision = null } = {}) {
  const current = state.images.find((image) => image.id === record?.id);
  return Boolean(record) && isCurrentCatalogEpoch(epoch) && current === record && imageAssetVersion(current) === version
    && (revision == null || Number(current.candidateRevision || 0) === Number(revision));
}
function abortCatalogLoads() {
  for (const controller of state.catalogLoadControllers) controller.abort();
  state.catalogLoadControllers.clear();
  state.imageInflight.clear(); state.candidateInflight.clear(); state.prefetchQueue = [];
  clearTimeout(state.prefetchTimer); state.prefetchTimer = null;
}
function cancelFillWork() { state.fillWorker?.terminate?.(); state.fillWorker = null; state.fillPending = false; }
function isGestureActive() { return state.drawing || state.panning || state.boundaryDragging; }
function imageHasMask(image) { return state.maskStatus.get(image.id) ?? image.hasEffectiveMask === true; }
function saveTargets(mode = "all") {
  if (mode === "current") return state.currentId ? [state.currentId] : [];
  // Saving never consumes editor state. The normal batch path starts from the
  // complete catalogue every time; narrower targets are explicit choices.
  if (mode === "masked") return state.images.filter(imageHasMask).map((image) => image.id);
  if (mode === "reviewed") return state.images.filter(isReviewed).map((image) => image.id);
  return state.images.map((image) => image.id);
}
function normaliseReviewRoot(value) { return String(value || "").trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function reviewPath(image) { return String(image?.relativePath || "").replaceAll("\\", "/").toLowerCase(); }
function isReviewed(image) { return state.reviewedPaths.has(reviewPath(image)); }
function isHidden(image) { return state.hiddenPaths.has(reviewPath(image)); }
function loadReviewedPaths() {
  state.reviewedPaths = new Set(state.images.filter((image) => image.reviewed).map(reviewPath));
  state.hiddenPaths = new Set(state.images.filter((image) => image.hidden).map(reviewPath));
}
function publishWorkspaceFlags(imageId, flags) {
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return false;
  const path = reviewPath(image);
  if (typeof flags.hidden === "boolean") {
    image.hidden = flags.hidden;
    if (flags.hidden) state.hiddenPaths.add(path); else state.hiddenPaths.delete(path);
  }
  if (typeof flags.reviewed === "boolean") {
    image.reviewed = flags.reviewed;
    if (flags.reviewed) state.reviewedPaths.add(path); else state.reviewedPaths.delete(path);
  }
  return true;
}
function saveWorkspaceFlag(image, field, desired, onSaved) {
  if (!image) return Promise.resolve(false);
  const key = `${image.id}:${field}`;
  const pending = state.workspaceFlagPending.get(key);
  if (pending?.desired === desired) return pending.promise;
  if (!pending && image[field] === desired) return Promise.resolve(true);
  let promise;
  promise = queueWorkspaceFlags(image.id, { [field]: desired }).then((flags) => {
    if (!publishWorkspaceFlags(image.id, flags)) return false;
    onSaved?.();
    return true;
  }).catch((error) => {
    showUserError(error);
    return false;
  }).finally(() => {
    if (state.workspaceFlagPending.get(key)?.promise === promise) state.workspaceFlagPending.delete(key);
  });
  state.workspaceFlagPending.set(key, { desired, promise });
  return promise;
}
function preserveCatalogScroll(renderCatalogs, positions = null) {
  const gallery = $("#gallery"); const overview = $("#overviewGrid");
  const galleryTop = positions?.gallery ?? gallery.scrollTop; const overviewTop = positions?.overview ?? overview.scrollTop;
  renderCatalogs();
  gallery.scrollTop = galleryTop; overview.scrollTop = overviewTop;
}
function setHidden(image, hidden) {
  const scroll = state.contextMenuScroll;
  return saveWorkspaceFlag(image, "hidden", hidden, () => {
    if (!state.images.some((item) => item.id === image.id)) return;
    preserveCatalogScroll(renderCatalogViews, scroll); updateSelectionActionBar(); updateNavigationControls(); updateActionButtons();
  });
}
function clearStoredCatalogState() { state.reviewedPaths.clear(); state.hiddenPaths.clear(); }
function selectedImages() { return state.images.filter((image) => state.selectedImageIds.has(image.id)); }
function clearBatchSelection() { state.selectedImageIds.clear(); state.selectionAnchorId = null; }
function updateSelectionActionBar() {
  const count = state.selectedImageIds.size;
  $("#batchModeButton").setAttribute("aria-pressed", String(state.batchMode));
  $("#overviewSelectionBar").hidden = !state.batchMode;
  $("#selectionCount").textContent = t("selection.count", { count });
  $("#selectionActionsButton").disabled = count === 0;
}
function selectCatalogImage(imageId) {
  if (!state.images.some((image) => image.id === imageId)) return;
  clearBatchSelection();
  updateSelectionActionBar();
  void selectImage(imageId);
}
function refreshReviewViews(scroll = null) {
  preserveCatalogScroll(() => { renderGallery(true); if (state.viewMode === "overview") renderOverview(); }, scroll);
  updateNavigationControls();
  updateActionButtons();
}
function setReviewed(image, reviewed) {
  const scroll = state.contextMenuScroll;
  return saveWorkspaceFlag(image, "reviewed", reviewed, () => {
    if (state.images.some((item) => item.id === image.id)) refreshReviewViews(scroll);
  });
}
async function moveReviewedPathAfterApply(previousImage, reloadedImage) {
  const previousPath = reviewPath(previousImage);
  const reloadedPath = reviewPath(reloadedImage);
  if (!previousPath || !reloadedPath || previousPath === reloadedPath) return false;

  const wasReviewed = state.reviewedPaths.has(previousPath) || state.reviewedPaths.has(reloadedPath);
  if (!await setReviewed(reloadedImage, wasReviewed)) return false;
  state.reviewedPaths.delete(previousPath);
  refreshReviewViews();
  return true;
}
function markImagesUnreviewed(imageIds, renderAfter = true) {
  let changed = false;
  for (const imageId of imageIds) {
    const image = state.images.find((item) => item.id === imageId);
    if (!image || !isReviewed(image)) continue;
    changed = true;
    void setReviewed(image, false).then((saved) => { if (saved && renderAfter) refreshReviewViews(); });
  }
  return changed;
}
function markCurrentUnreviewed(renderAfter = true) { return markImagesUnreviewed([state.currentId], renderAfter); }
function refreshCurrentReviewAndMask() {
  const reviewChanged = markCurrentUnreviewed(false);
  const maskChanged = refreshMaskStatus(true);
  if (reviewChanged && !maskChanged) refreshReviewViews();
  return reviewChanged || maskChanged;
}
function imageIndex(imageId = state.currentId) { return state.images.findIndex((image) => image.id === imageId); }
function hasOpenDialog() { return [...document.querySelectorAll("dialog")].some((dialog) => dialog.open); }
function isEditableTarget(target) {
  return Boolean(target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target?.tagName));
}
function focusElement(element) { element?.focus({ preventScroll: true }); }
function focusCanvas() { focusElement(canvas); }
function setNavigationShortcutsEnabled(enabled) {
  state.navigationShortcutsEnabled = Boolean(enabled);
  if (state.settings?.general) state.settings.general.shortcuts_enabled = state.navigationShortcutsEnabled;
  if (state.settings?.shortcuts) state.settings.shortcuts.enabled = state.navigationShortcutsEnabled;
  const settingsControl = $("#settingsShortcutsEnabled");
  if (settingsControl) settingsControl.checked = state.navigationShortcutsEnabled;
  updateNavigationControls();
  focusCanvas();
}

function updateActionButtons() {
  const running = isBusy();
  const sourceIncompatible = Boolean(currentRecord()?.sourceDimensionsChanged);
  const busyLocked = running || state.importing;
  const mutationLocked = state.projectReadOnly || sourceIncompatible;
  const mutatingCandidates = state.candidateUpdateChains.size > 0;
  // Do not let controls mutate the image that is being replaced under the
  // editor.  Gallery selection may still supersede this request; its generation
  // check owns that race.
  const switchingImages = Boolean(state.pendingImageId) || state.candidateBatchPending.size > 0;
  const current = currentRecord();
  const hasImage = Boolean(state.currentId && state.currentImage && current);
  const controls = [...document.querySelectorAll("button, input, select, textarea")];
  for (const control of controls) {
    if (control.dataset.disabledByLock === "true") {
      control.disabled = false;
      delete control.dataset.disabledByLock;
    }
  }
  $("#pickFolder").disabled = busyLocked || mutationLocked;
  const detectAllButton = $("#detectAllButton");
  detectAllButton.textContent = t("gallery.detectAll");
  detectAllButton.disabled = busyLocked || mutationLocked || state.images.length === 0;
  $("#detectCurrentButton").disabled = busyLocked || mutationLocked || !hasImage;
  $("#clearCurrentMasksButton").disabled = busyLocked || mutationLocked || !hasImage || !(current.candidateCount || state.manualMaskPresent || imageHasMask(current));
  const visibilityButton = $("#removeCurrentImageButton");
  visibilityButton.disabled = busyLocked || mutationLocked || !hasImage;
  const visibilityLabel = t(current && isHidden(current) ? "editor.show" : "editor.hide");
  visibilityButton.textContent = visibilityLabel; visibilityButton.title = visibilityLabel; visibilityButton.setAttribute("aria-label", visibilityLabel);
  for (const id of ["#clearAllMasksButton", "#clearCatalogButton", "#batchMoreButton"]) $(id).disabled = busyLocked || mutationLocked || state.images.length === 0;
  $("#batchModeButton").disabled = busyLocked || mutationLocked || state.images.length === 0;
  $("#galleryFilter").disabled = busyLocked;
  $("#saveAllButton").disabled = busyLocked || mutationLocked || mutatingCandidates || state.images.length === 0;
  const currentSaveDisabled = busyLocked || mutationLocked || mutatingCandidates || !hasImage || !imageHasMask(current);
  $("#saveButton").disabled = currentSaveDisabled;
  $("#applyStartButton").disabled = busyLocked || mutationLocked || mutatingCandidates || state.applyTargetIds.length === 0
    || Boolean(applyRestrictionMessage()) || (selectedSaveMode() === "copy" && !state.outputDirectoryHandle);
  $("#overviewButton").disabled = busyLocked || state.images.length === 0;
  $("#previousImageButton").disabled = busyLocked || switchingImages || imageIndex() <= 0;
  $("#nextImageButton").disabled = busyLocked || switchingImages || imageIndex() < 0 || imageIndex() >= state.images.length - 1;
  $("#reviewAndNextButton").disabled = busyLocked || mutationLocked || switchingImages || !hasImage;
  $("#removeAndNextButton").disabled = busyLocked || mutationLocked || switchingImages || !hasImage;
  $("#hideAndNextButton").disabled = busyLocked || mutationLocked || switchingImages || !hasImage;
  $("#downloadCurrentMosaicMask").disabled = !hasImage || !state.project;
  $("#downloadCurrentExcludeMask").disabled = !hasImage || !state.project;
  updateCandidateBatchButtons(hasImage, busyLocked || mutationLocked || switchingImages, undefined, busyLocked || switchingImages);
  updateHistoryButtons();
  if (busyLocked) {
    for (const control of controls) {
      if ((["applyPauseButton", "applyCancelButton"].includes(control.id) && state.applyRunning)
        || (["processingPauseButton", "processingCancelButton"].includes(control.id) && state.processing)
        || control.id === "errorDialogClose") continue;
      if (!control.disabled) control.dataset.disabledByLock = "true";
      control.disabled = true;
    }
  } else if (mutationLocked) {
    const availableInReadOnly = new Set([
      "projectButton", "projectClose", "projectOpenList", "projectListClose", "projectResume", "projectCloseWorkspace",
      "downloadCurrentMosaicMask", "downloadCurrentExcludeMask",
      "singleViewButton", "compareViewButton", "fitButton", "mosaicPreviewButton", "previousImageButton", "nextImageButton",
      "galleryFilter", "overviewButton", "collapseGalleryButton", "collapseInspectorButton", "settingsButton", "settingsCloseButton", "errorDialogClose",
      "closeOverviewButton", "overviewQuery", "overviewFolder", "sourceMismatchCancel", "detectCancelButton",
      "projectDeleteCancel", "projectDeleteConfirm", "copyImagePathMenuItem",
    ]);
    const availableInReadOnlyControls = new Set([
      ...document.querySelectorAll(".gallery-item, .overview-item, .overview-filter, .project-table [data-project-action], .project-sort-button, [data-candidate-display-toggle], [data-candidate-effective-toggle], [data-candidate-display-id], [data-candidate-effective-id]"),
    ]);
    const availableInReadOnlyDialogs = ["#settingsDialog", "#modelHelpDialog", "#modelDownloadDialog"].map($);
    for (const control of controls) {
      if (availableInReadOnly.has(control.id) || availableInReadOnlyControls.has(control)
        || availableInReadOnlyDialogs.some((dialog) => dialog.contains(control))) continue;
      if (!control.disabled) control.dataset.disabledByLock = "true";
      control.disabled = true;
    }
  }
  $("#gallery").classList.toggle("locked", busyLocked);
  canvas.style.pointerEvents = busyLocked || switchingImages ? "none" : "";
  canvas.setAttribute("aria-disabled", String(busyLocked || switchingImages));
  syncDetectionActions();
  if (typeof renderProjectTableControls === "function") renderProjectTableControls();
}

function updateCandidateBatchButtons(hasImage = Boolean(state.currentId && state.currentImage && currentRecord()), mutationLocked = isBusy() || state.importing || state.projectReadOnly || currentRecord()?.sourceDimensionsChanged || state.candidateBatchPending.has(state.currentId), presence, viewLocked = mutationLocked) {
  if (mutationLocked) {
    for (const button of document.querySelectorAll("[data-candidate-batch]")) button.disabled = true;
    for (const button of document.querySelectorAll("[data-candidate-padding-batch]")) button.disabled = true;
    if (viewLocked) {
      for (const button of document.querySelectorAll("[data-candidate-display-toggle], [data-candidate-effective-toggle]")) button.disabled = true;
      return;
    }
  } else for (const button of document.querySelectorAll("[data-candidate-padding-batch]")) {
    const role = button.dataset.candidatePaddingBatch;
    button.disabled = !hasImage || !state.candidates.some((candidate) => candidate.role === role);
  }
  const manualPresence = presence || {
    hasManualExclude: canvasHasPixels(exclusionCtx, exclusionCanvas),
    hasManualExclusionErase: canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas),
  };
  if (!mutationLocked) for (const button of document.querySelectorAll("[data-candidate-batch]")) {
    const [role, operation] = button.dataset.candidateBatch.split(":");
    const hasManual = role === "apply" ? state.manualMaskPresent : manualPresence.hasManualExclude || manualPresence.hasManualExclusionErase;
    const hasRoleCandidate = hasImage && (state.candidates.some((candidate) => candidate.role === role) || hasManual);
    button.disabled = !hasRoleCandidate;
    if (operation === "toggle") {
      const enabled = state.candidates.filter((candidate) => candidate.role === role).map((candidate) => candidate.enabled);
      if (role === "apply" ? state.manualMaskPresent : manualPresence.hasManualExclude) enabled.push(role === "apply" ? state.manualEnabled : state.manualExclusionEnabled);
      if (role === "exclude" && manualPresence.hasManualExclusionErase) enabled.push(state.manualExclusionEraseEnabled);
      const active = enabled.length > 0 && enabled.every(Boolean);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  for (const button of document.querySelectorAll("[data-candidate-display-toggle], [data-candidate-effective-toggle]")) {
    const role = button.dataset.candidateDisplayToggle || button.dataset.candidateEffectiveToggle;
    const hasRoleCandidate = hasImage && candidateDisplayIdsForRole(role, manualPresence).length > 0;
    button.disabled = !hasRoleCandidate;
  }
}

function clearBoundaryInteraction() {
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryStartClient = null;
  state.boundaryPoint = null;
  state.boundaryPromptPoint = null;
  state.boundaryDragging = false;
  state.boundaryDisplaySide = "left";
  state.boundaryDrafts = [];
  state.boundaryActiveId = null;
  state.boundaryBrushStroke = null;
  state.polygonPoints = [];
  state.polygonDragIndex = -1;
  state.polygonDraftDrag = null;
  updateBoundaryActions();
}

function clearBoundaryConstruction() {
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryStartClient = null;
  state.boundaryPoint = null;
  state.boundaryPromptPoint = null;
  state.boundaryDragging = false;
  state.boundaryBrushStroke = null;
  state.polygonPoints = [];
  state.polygonDragIndex = -1;
  state.polygonDraftDrag = null;
}

function setMosaicPreviewEnabled(enabled) {
  if (isBusy() || state.importing) return;
  if (enabled) state.mosaicPreviewFailureReported = false;
  state.mosaicPreviewEnabled = enabled;
  const button = $("#mosaicPreviewButton");
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  if (enabled) requestMosaicPreview(); else releaseMosaicPreview();
  render();
}

function resetCatalog(images, root) {
  closeBoundaryModeMenu({ restoreFocus: true });
  closeCatalogContextMenu();
  abortCatalogLoads();
  cancelFillWork();
  releaseImageCaches();
  state.images = images;
  state.projectHistory.clear();
  state.sourceAccess.clear();
  state.projectlessDirectorySources.clear();
  state.projectlessPromotion = null;
  state.missingNativeSources = [];
  state.reviewRoot = normaliseReviewRoot(root);
  state.overviewFolder = "";
  loadReviewedPaths();
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null; state.maskStatus.clear();
  state.candidates = []; state.candidateImages = new Map(); state.drafts.clear(); state.selectedImageIds.clear(); state.selectionAnchorId = null; state.batchMode = false; clearCandidateBlink(); state.contextMenuImageId = null; state.contextMenuOrigin = null; clearBoundaryInteraction();
  state.candidateUpdateChains.clear(); state.candidateUpdateVersions.clear(); state.candidateDeleting.clear(); state.candidateBatchPending.clear();
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
  resetCatalogWindows();
  renderCatalogViews(); updateSelectionActionBar(); clearEditor();
}

function applyProjectSnapshot(snapshot) {
  state.project = snapshot?.project || null;
  state.projectReadOnly = snapshot?.readOnly === true || state.project?.status === "completed";
  if (typeof renderProjectCurrent === "function") renderProjectCurrent();
  updateActionButtons();
}

function discardCatalogNodes(nodes, container) {
  for (const item of nodes.values()) {
    const preview = item.querySelector?.("img");
    if (preview) forgetThumbnail(preview);
    item.remove?.();
  }
  nodes.clear();
}

function updateProgress(job) {
  if (job?.kind === "detect" && job.cancelRequested) {
    state.detectCancelRequested = true;
    setStatusKey("status.detectCancelling", {}, "running");
  }
  if (job?.kind !== "apply" && ["running", "pausing", "paused"].includes(job?.state)) showProcessing(job);
  updateActionButtons();
}

async function loadFolder({ skipSameSourceWarning = false, path: suppliedPath = null } = {}) {
  if (isBusy() || state.importing) return;
  const path = suppliedPath || $("#folderPath").value.trim();
  if (!path) return setStatusKey("status.enterFolder");
  if (!skipSameSourceWarning && typeof openSameSourceDialog === "function" && await openSameSourceDialog(path)) return;
  const picker = $("#pickerMenu");
  if (picker?.matches?.(":popover-open")) picker.hidePopover();
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  setStatusKey("status.loadingImages", {}, "running");
  try {
    await flushAllWorkspaceMutations();
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    resetCatalog(data.images, path);
    setStatusKey("status.imagesLoaded", { count: state.images.length });
    const snapshot = await api("/api/images");
    applyProjectSnapshot(snapshot);
    if (typeof showSourceMismatches === "function") await showSourceMismatches();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) showUserError(error); }
}
