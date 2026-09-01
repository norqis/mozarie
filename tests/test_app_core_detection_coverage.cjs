"use strict";

// Browser-shaped coverage for the application startup, shared state helpers,
// and detection save paths.  These tests deliberately drive public behaviour
// through the same functions that the page uses rather than duplicating their
// decisions in test-only helpers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const jsRoot = path.join(__dirname, "..", "static", "js");

class Element {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.checked = false;
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.isConnected = true;
    this.offsetParent = {};
    this.classList = { toggle() {} };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.focused = true; }
  close() { this.open = false; }
  showModal() { this.open = true; }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
  matches(selector) { return selector === ":popover-open" && this.open; }
  contains(node) { return node === this; }
  closest() { return this; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
  getContext() { return { clearRect() {}, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; } }; }
  setPointerCapture(pointerId) { this.pointerId = pointerId; }
  hasPointerCapture(pointerId) { return this.pointerId === pointerId; }
  releasePointerCapture(pointerId) { if (this.pointerId === pointerId) this.pointerId = null; }
}

function browserFixture() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const document = {
    activeElement: null,
    body: new Element("body"),
    documentElement: new Element("html"),
    visibilityState: "hidden",
    querySelector(selector) {
      if (selector === 'meta[name="mozarie-token"]') return null;
      return element(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return new Element("created"); },
  };
  return { document, element, elements };
}

async function testApplicationStartupPaths() {
  const { document, element } = browserFixture();
  const state = { settings: null, images: [], view: { scale: 1, x: 0, y: 0 }, displayMode: "single", compareSplit: .5 };
  const apiResults = [];
  const context = {
    console, Promise, Map, Set, Array, Object, Number, String, Boolean, Math, Error,
    document,
    window: { addEventListener() {} },
    state,
    $: (selector) => element(selector),
    canvas: element("#editorCanvas"),
    stage: element("#canvasStage"),
    ResizeObserver: class { observe() {} },
    loadTranslations: async () => true,
    api: async () => {
      const next = apiResults.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    setSettingsForm(settings) { state.settings = settings; },
    showUserError(error) { state.lastError = error; },
    bindEvents: undefined,
    setNavigationShortcutsEnabled() {}, scheduleJobPoll() {}, updateBrushSize() {}, resizeRenderCanvas() {},
    updateHistoryButtons() {}, updateNavigationControls() {}, updateActionButtons() {}, resetCatalog(images) { state.images = images; },
    setStatusKey() {}, checkForUpdate() {}, updateBrushSize() {}, updateBrushCursor() {}, updateCompareSplitter() {}, render() {},
    t: (key) => key, requestAnimationFrame(callback) { callback(); },
    isBusy: () => false,
    compareEventOffset: () => 0,
    toolRail: element("#canvasToolRail"),
  };
  for (const name of [
    "saveSettings", "syncProviderSelection", "handleToolRailKeydown", "loadFolder", "saveAll", "saveCurrent",
    "startDetectionFromDialog", "startApplyFromDialog", "startSingleSave", "chooseSingleOutputDirectory", "syncSingleSaveMode", "rememberedOutputDirectoryHandle", "renderOutputDirectory", "chooseOutputDirectory", "importDroppedFiles", "cancelBoundary",
    "restoreSnapshot", "copyContextMenuImagePath", "modelDownloadPoll", "fitImage", "refreshApplyTargets",
  ]) context[name] = () => {};
  context.toolRailItems = () => [];
  context.setToolRailTabStop = () => {};
  const source = fs.readFileSync(path.join(jsRoot, "app.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.appCoverage={ initialise, bindEvents };`, context, { filename: path.join(jsRoot, "app.js") });

  // Initial load without the File System Access API uses the browser guidance.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.body.textContent, "error.browserUnsupported");

  context.window.showOpenFilePicker = async () => [];
  context.window.showDirectoryPicker = async () => ({});
  apiResults.push(new Error("settings unavailable"));
  await context.appCoverage.initialise();
  assert.equal(state.lastError.message, "settings unavailable");

  apiResults.push({ settings: { general: { shortcuts_enabled: false } }, status: {}, version: "1" }, { images: [{ id: "one" }], root: "" });
  await context.appCoverage.initialise();
  assert.equal(element("#folderPath").value, "");
  assert.equal(state.images.length, 1);
  apiResults.push({ settings: { general: {} }, status: {}, version: "1" }, new Error("image list unavailable"));
  await context.appCoverage.initialise();
  assert.equal(state.lastError.message, "image list unavailable");

  // The wheel listener is a real editor interaction and covers both zoom modes.
  state.currentImage = { id: "one" };
  const wheel = context.canvas.listeners.get("wheel");
  wheel({ shiftKey: true, deltaY: -1, preventDefault() {}, clientX: 10, clientY: 10 });
  wheel({ shiftKey: false, deltaY: 1, preventDefault() {}, clientX: 10, clientY: 10 });

  state.displayMode = "compare";
  const splitter = element("#compareSplitter");
  const pointer = (clientX, pointerId = 7) => ({ button: 0, clientX, pointerId, preventDefault() {} });
  splitter.listeners.get("pointerdown")(pointer(30));
  assert.equal(state.compareSplit, .3, "splitter pointerdown sets the compare ratio");
  splitter.listeners.get("pointermove")(pointer(70));
  assert.equal(state.compareSplit, .7, "splitter pointermove updates the captured compare ratio");
  splitter.listeners.get("pointerup")(pointer(70));
  assert.equal(splitter.hasPointerCapture(7), false, "splitter pointerup releases capture");
  splitter.listeners.get("pointerdown")(pointer(70));
  splitter.listeners.get("pointercancel")(pointer(70));
  assert.equal(splitter.hasPointerCapture(7), false, "splitter pointercancel releases capture");
  for (const event of [
    { key: "ArrowLeft", shiftKey: false, expected: .69 }, { key: "ArrowRight", shiftKey: true, expected: .74 },
    { key: "Home", shiftKey: false, expected: .2 }, { key: "End", shiftKey: false, expected: .8 },
  ]) {
    splitter.listeners.get("keydown")({ ...event, preventDefault() {} });
    assert.equal(state.compareSplit, event.expected, `splitter ${event.key} applies its accessible compare ratio`);
  }
}

async function testCoreBoundaryAndWorkspaceBehaviour() {
  const { document, element } = browserFixture();
  const state = {
    translations: {}, settings: null, status: null, images: [{ id: "one", relativePath: "one.png", hidden: false, reviewed: true }],
    currentId: null, currentImage: null, reviewedPaths: new Set(["one.png"]), hiddenPaths: new Set(),
    maskStatus: new Map(), catalogLoadControllers: new Set([{ abort() {} }]), imageInflight: new Map(), candidateInflight: new Map(),
    prefetchQueue: [], prefetchTimer: null, workspaceFlagPending: new Map(), candidateUpdateChains: new Map(), candidateBatchPending: new Set(),
    selectedImageIds: new Set(), viewMode: "edit", applyTargetIds: [], candidates: [], manualMaskPresent: false,
    saving: false, saveStarting: false, detectionStarting: false, masksClearing: false, catalogMutation: false, boundaryPending: false,
    importing: false, drawing: false, panning: false, boundaryDragging: false,
  };
  const canvas = element("#editorCanvas");
  const context = {
    console, Promise, Map, Set, Array, Object, Number, String, Boolean, Math, Error, Uint8ClampedArray,
    document, window: { addEventListener() {} }, state, canvas, stage: element("#canvasStage"), $: (selector) => element(selector),
    clearTimeout() {}, setTimeout() {}, fetch: async () => ({ ok: false, json: async () => ({}) }),
    renderModelStatus() {}, renderCatalogViews() {}, renderCandidates() {}, render() {}, renderGallery() {}, renderOverview() {},
    renderStatus() {}, updateBoundaryActions() {}, updateNavigationControls() {}, updateHistoryButtons() {}, updateSelectionActionBar() {},
    updateCandidateStatus() {}, syncApplyMode() {}, updateProgress() {}, syncDetectionActions() {}, updateCandidateBatchButtons() {},
    refreshMaskStatus: () => false, selectImage() {}, imageAssetVersion: () => 0, canvasHasPixels: () => false,
    applyRestrictionMessage: () => "", candidateDisplayIdsForRole: () => [], queueWorkspaceFlags: () => Promise.reject(new Error("write failed")),
    showModalFromInvoker() {}, showConnectionFailure() {}, releaseMosaicPreview() {}, requestMosaicPreview() {},
    closeBoundaryModeMenu() {}, closeCatalogContextMenu() {}, releaseImageCaches() {}, clearCandidateBlink() {}, clearEditor() {},
    forgetThumbnail() {},
  };
  const source = fs.readFileSync(path.join(jsRoot, "core.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.coreCoverage={ state, t, loadTranslations, api, setStatusKey, progressText, processingCurrentPath, abortCatalogLoads, saveTargets, setHidden, moveReviewedPathAfterApply, markImagesUnreviewed, clearBoundaryConstruction, updateActionButtons, updateCandidateBatchButtons, setMosaicPreviewEnabled, formatDuration };`, context, { filename: path.join(jsRoot, "core.js") });
  const test = context.coreCoverage;
  const coreState = test.state;
  Object.assign(coreState, state);
  coreState.workspaceFlagPending = new Map();
  coreState.mosaicPreviewFailureReported = true;
  test.setMosaicPreviewEnabled(true);
  assert.equal(coreState.mosaicPreviewFailureReported, false, "explicitly re-enabling mosaic preview starts a fresh failure-reporting attempt");
  test.setMosaicPreviewEnabled(false);
  assert.equal(coreState.mosaicPreviewEnabled, false, "disabling the preview does not start a new failure-reporting attempt");

  assert.equal(test.t("unknown"), "");
  await test.loadTranslations();
  context.fetch = async () => ({ ok: true, json: async () => null });
  await test.loadTranslations();
  const pendingTranslations = [];
  context.fetch = () => new Promise((resolve) => pendingTranslations.push(resolve));
  const staleTranslation = test.loadTranslations();
  const currentTranslation = test.loadTranslations();
  pendingTranslations.shift()({ ok: true, json: async () => ({ value: "old" }) });
  assert.equal(await staleTranslation, false);
  pendingTranslations.shift()({ ok: true, json: async () => ({ value: "new" }) });
  assert.equal(await currentTranslation, true);
  context.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  coreState.translations = { stale: "old locale" };
  await test.loadTranslations("en");
  assert.equal(Object.keys(coreState.translations).length, 0, "a failed locale request does not retain another locale");
  await assert.rejects(test.api("/api/failure"), (error) => error.code === "internal_error");
  test.setStatusKey("error.other", {}, "error");
  test.abortCatalogLoads();
  assert.equal(test.saveTargets("current").length, 0);
  assert.equal(await test.setHidden(coreState.images[0], true), false);
  assert.equal(await test.moveReviewedPathAfterApply({ relativePath: "one.png" }, { relativePath: "one.png" }), false);
  context.queueWorkspaceFlags = async () => ({ reviewed: true });
  coreState.reviewedPaths.add("old.png");
  const reloaded = { id: "two", relativePath: "new.png", reviewed: false };
  coreState.images.push(reloaded);
  assert.equal(await test.moveReviewedPathAfterApply({ relativePath: "old.png" }, reloaded), true);

  const reviewCalls = [];
  let reviewRefreshes = 0;
  context.setReviewed = (image, reviewed) => {
    reviewCalls.push([image.id, reviewed]);
    return Promise.resolve(image.reviewResult);
  };
  const reviewed = { id: "reviewed", relativePath: "reviewed.png", reviewResult: true };
  const failedReview = { id: "failed-review", relativePath: "failed.png", reviewResult: false };
  const unreviewed = { id: "unreviewed", relativePath: "unreviewed.png", reviewResult: true };
  coreState.images.push(reviewed, failedReview, unreviewed);
  coreState.reviewedPaths.add("reviewed.png");
  coreState.reviewedPaths.add("failed.png");
  const originalRefreshReviewViews = context.refreshReviewViews;
  context.refreshReviewViews = (...args) => { reviewRefreshes += 1; return originalRefreshReviewViews(...args); };
  assert.equal(test.markImagesUnreviewed(["missing", "unreviewed"], true), false, "missing and unreviewed images do not report a review change");
  assert.equal(test.markImagesUnreviewed(["reviewed"], false), true, "a reviewed image is marked for clearing without an immediate rerender");
  await Promise.resolve();
  assert.deepEqual(reviewCalls, [["reviewed", false]], "the reviewed image sends one clear request");
  assert.equal(reviewRefreshes, 0, "renderAfter false suppresses the completion rerender");
  assert.equal(test.markImagesUnreviewed(["reviewed", "failed-review"], true), true, "reviewed images report a pending clear with renderAfter true");
  await Promise.resolve();
  assert.deepEqual(reviewCalls, [["reviewed", false], ["reviewed", false], ["failed-review", false]], "reviewed records use the real mark helper for both successful and failed saves");
  assert.equal(reviewRefreshes, 1, "only a successful clear rerenders when renderAfter is true");
  test.clearBoundaryConstruction();
  coreState.translations = {
    "duration.hour": "duration hour", "duration.minute": "duration minute", "duration.second": "duration second",
    "status.progressCount": "status {completed}/{total}", "status.eta": "status {duration}",
  };
  assert.match(test.formatDuration(3661), /duration/);
  assert.match(test.formatDuration(61), /duration/);
  assert.match(test.formatDuration(1), /duration/);
  assert.match(test.progressText({ kind: "detect", state: "running", completed: 1, total: 3, startedAt: "job", activeElapsed: 3 }), /status/);
  coreState.images = [{ id: "one", relativePath: "one.png" }, { id: "two", relativePath: "two.png" }];
  const preparing = { kind: "detect", state: "running", phase: "preparing_models", completed: 0, total: 2, imageIds: ["one", "two"], completedImageIds: [] };
  assert.match(test.progressText(preparing), /0/, "model preparation keeps the stable progress count");
  assert.equal(test.processingCurrentPath(preparing), "one.png", "model preparation keeps the first unfinished filename visible");
  assert.equal(test.processingCurrentPath({ ...preparing, phase: "detecting", completedImageIds: ["one"] }), "two.png", "phase changes do not clear the next filename");
  test.updateActionButtons();
  // The save dialog has a separate restriction and retains its live pause
  // control while the rest of the UI is locked.
  coreState.applyTargetIds = ["one"];
  context.applyRestrictionMessage = () => "restricted";
  context.document.querySelectorAll = (selector) => selector === "button, input, select, textarea" ? [element("applyPauseButton")] : [];
  coreState.applyRunning = true; coreState.saving = true;
  test.updateActionButtons();
  coreState.applyRunning = false; coreState.saving = false;
  context.applyRestrictionMessage = () => "";
  context.document.querySelectorAll = () => [];
  coreState.currentId = "one"; coreState.currentImage = coreState.images[0]; coreState.hiddenPaths.add("one.png");
  test.updateActionButtons();
  const batchButton = new Element("batch"); batchButton.dataset.candidateBatch = "exclude:toggle";
  const displayButton = new Element("display"); displayButton.dataset.candidateDisplayToggle = "exclude";
  const effectiveButton = new Element("effective"); effectiveButton.dataset.candidateEffectiveToggle = "exclude";
  const originalQuerySelectorAll = document.querySelectorAll;
  document.querySelectorAll = (selector) => {
    if (selector === "[data-candidate-batch]") return [batchButton];
    if (selector === "[data-candidate-display-toggle], [data-candidate-effective-toggle]") return [displayButton, effectiveButton];
    return originalQuerySelectorAll(selector);
  };
  let candidateReads = 0;
  Object.defineProperty(coreState, "candidates", { configurable: true, get: () => { candidateReads += 1; return []; } });
  coreState.manualExclusionEnabled = true; coreState.manualExclusionEraseEnabled = true;
  let reads = 0;
  context.canvasHasPixels = () => { reads += 1; return true; };
  let displayReads = 0;
  context.candidateDisplayIdsForRole = (role, presence) => {
    displayReads += 1;
    return role === "exclude" && (presence.hasManualExclude || presence.hasManualExclusionErase) ? ["manual"] : [];
  };
  batchButton.setAttribute("aria-pressed", "unchanged");
  test.updateCandidateBatchButtons(true, true);
  assert.equal(batchButton.disabled, true, "a locked update disables candidate batch controls");
  assert.equal(displayButton.disabled, true, "a locked update disables candidate display controls");
  assert.equal(effectiveButton.disabled, true, "a locked update disables candidate effective-mask controls");
  assert.equal(batchButton.getAttribute("aria-pressed"), "unchanged", "a locked update preserves candidate toggle state");
  assert.equal(candidateReads, 0, "a locked update does not read candidate presence");
  assert.equal(reads, 0, "a locked update does not read manual mask presence");
  assert.equal(displayReads, 0, "a locked update does not read candidate display presence");
  const presentManualLayers = { hasManualExclude: true, hasManualExclusionErase: true };
  test.updateCandidateBatchButtons(true, false, presentManualLayers);
  const suppliedState = { batchDisabled: batchButton.disabled, batchPressed: batchButton.getAttribute("aria-pressed"), displayDisabled: displayButton.disabled, effectiveDisabled: effectiveButton.disabled };
  test.updateCandidateBatchButtons(true, false);
  assert.deepEqual({ batchDisabled: batchButton.disabled, batchPressed: batchButton.getAttribute("aria-pressed"), displayDisabled: displayButton.disabled, effectiveDisabled: effectiveButton.disabled }, suppliedState, "unlocked manual-layer readback keeps candidate controls identical");
  assert.equal(reads, 2, "an unspecified batch update reads each manual exclusion layer once");
  assert.equal(displayReads, 4, "an unlocked update retains candidate display presence checks");
  const absentManualLayers = { hasManualExclude: false, hasManualExclusionErase: false };
  test.updateCandidateBatchButtons(true, false, absentManualLayers);
  assert.equal(batchButton.disabled, true, "false manual-layer presence disables the empty exclusion batch control");
  assert.equal(displayButton.disabled, true, "false manual-layer presence disables the empty exclusion display control");
  assert.equal(effectiveButton.disabled, true, "false manual-layer presence disables the empty exclusion effective-mask control");
}

async function testDetectionImportAndSaveBehaviour() {
  const { element } = browserFixture();
  const state = { settings: { importing: { parallelism: "" } }, importing: false, candidateUpdateChains: new Map(), images: [], currentId: null };
  const calls = [];
  const context = {
    Promise, Map, Set, Array, Object, Number, String, Boolean, Math, JSON, structuredClone,
    state, $: (selector) => element(selector),
    isBusy: () => false, activeDetection: () => false, updateActionButtons() {}, updateProgress() {}, showUserError() {}, setStatusKey() {},
    saveDraft: () => calls.push("draft"), refreshMaskStatus: () => calls.push("refresh"), saveTargets: () => ["one"],
    openApplyDialog: async (options) => calls.push(options.initialMode), waitForCandidateMutations: async () => {}, imageHasMask: () => true,
    detectionConfidence: () => 0.5, normaliseDetectionConfidence: Number, setDetectionConfidence() {}, showModalFromInvoker() {},
    t: (key) => key, api: async () => ({}), setSettingsForm() {}, scheduleJobPoll() {}, showProcessing() {},
  };
  const source = fs.readFileSync(path.join(jsRoot, "detection.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.detectionCoverage={ importParallelism, saveAll };`, context, { filename: path.join(jsRoot, "detection.js") });
  assert.equal(context.detectionCoverage.importParallelism(), 3);
  state.settings.importing.parallelism = "12";
  assert.equal(context.detectionCoverage.importParallelism(), 10);
  await context.detectionCoverage.saveAll();
  assert.deepEqual(calls, ["draft", "refresh", "masked"]);
}

Promise.resolve()
  .then(testApplicationStartupPaths)
  .then(testCoreBoundaryAndWorkspaceBehaviour)
  .then(testDetectionImportAndSaveBehaviour)
  .then(() => console.log("test_app_core_detection_coverage: passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
