const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "static", "js");

async function testDetectionWaitsForDraft() {
  const events = [];
  const validation = { id: "detectionTargetValidation", textContent: "", hidden: true };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null };
  const context = {
    state, Math, Promise,
    $: () => validation,
    isBusy: () => false,
    saveDraft: async () => { events.push("draft"); },
    api: async () => { events.push("detect"); return { ok: true }; },
    updateActionButtons() {}, showProcessing() {}, closeProcessing() {}, updateProgress() {}, setStatusKey() {}, setStatus() {}, showUserError() {},
    t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.runDetectionForTest=runDetection;", context, { filename: "test-detection-refresh-exports.js" });
  await context.runDetectionForTest(["image"], 0.5, 1, ["penis"]);
  assert.deepEqual(events, ["draft", "detect"], "manual layers are captured before detection starts");
}

async function testDetectionShowsProcessingBeforeDelayedRequests() {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const settings = deferred(); const draft = deferred(); const detect = deferred();
  const controls = new Map();
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { id, value: id === "#detectConfidenceNumber" ? "0.5" : id === "#detectCandidatePadding" ? "0" : "1", checked: id === "#dialogTargetPenis", textContent: "", hidden: false, disabled: false, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); }, close() { this.closed = true; } });
    return controls.get(id);
  };
  const events = [];
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null, pendingDetectionTargetIds: ["one", "two"], settings: { detection: { targets: ["penis"] } }, settingsStatus: null };
  const context = {
    state, Math, Promise, structuredClone, normaliseDetectionConfidence: (value) => Number(value), $: control, isBusy: () => state.job?.state === "running",
    saveDraft: () => { events.push("draft"); return draft.promise; },
    api: (path) => { events.push(path); return path.startsWith("/api/settings") ? settings.promise : detect.promise; },
    setSettingsForm() {}, updateActionButtons() {}, showProcessing: (job) => events.push(`modal:${job.completed}/${job.total}:${job.current}`), closeProcessing: () => events.push("close"), updateProgress() {}, setStatusKey() {}, setStatus() {}, showUserError() {}, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.startDetectionForTest=startDetectionFromDialog;", context, { filename: "test-detection-dialog-exports.js" });
  const pending = context.startDetectionForTest({ preventDefault() {} });
  assert.equal(events[0], "modal:0/2:", "the modal opens synchronously before settings, draft, and detect requests");
  assert.deepEqual({ imageIds: [...state.job.imageIds], completedImageIds: [...state.job.completedImageIds], completed: state.job.completed, total: state.job.total }, { imageIds: ["one", "two"], completedImageIds: [], completed: 0, total: 2 });
  settings.resolve({ settings: state.settings }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.join("|"), "modal:0/2:|/api/settings?status=0|draft", "a delayed draft keeps the same optimistic processing state");
  draft.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.join("|"), "modal:0/2:|/api/settings?status=0|draft|/api/detect", "a delayed detect request does not recreate the modal");
  detect.resolve({ ok: true }); await pending;
  assert.equal(events.filter((event) => event.startsWith("modal:")).length, 1, "the modal is shown once while the start request is pending");
}

async function testDetectionStartFailureClosesProcessing() {
  const events = []; const validation = { id: "#detectionTargetValidation", textContent: "", hidden: true };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null };
  const context = {
    state, Math, Promise, $: () => validation, isBusy: () => false,
    saveDraft: async () => { throw new Error("draft failed"); }, api: async () => ({ ok: true }),
    updateActionButtons() {}, showProcessing() { events.push("show"); }, closeProcessing() { events.push("close"); }, updateProgress(job) { events.push(job.state); }, setStatusKey() {}, setStatus() {}, showUserError() { events.push("error"); }, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.runDetectionForTest=runDetection;", context, { filename: "test-detection-failure-exports.js" });
  await context.runDetectionForTest(["image"], .5, 1, ["penis"]);
  assert.deepEqual(events, ["show", "running", "close", "idle", "error"], "a start failure closes the optimistic modal and returns the job to idle");
  assert.deepEqual([...state.detectionTargetIds], [], "a start failure removes the optimistic target set");
  assert.equal(state.detectionStarting, false, "a start failure releases the starting state");
}

async function testDetectionSettingsFailureDoesNotStartDetect() {
  const controls = new Map(); const events = [];
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { value: id === "#detectConfidenceNumber" ? "0.5" : id === "#detectCandidatePadding" ? "9" : "1", checked: id === "#dialogTargetPenis", textContent: "", hidden: false, disabled: false, setAttribute() {}, close() {} });
    return controls.get(id);
  };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null, pendingDetectionTargetIds: ["one"], settings: { detection: { targets: ["penis"], default_candidate_padding_px: 0 } }, settingsStatus: null };
  const context = {
    state, Math, Promise, structuredClone, normaliseDetectionConfidence: Number, $: control, isBusy: () => false,
    saveDraft: async () => { events.push("draft"); }, api: async (path) => { events.push(path); throw new Error("settings failed"); },
    setSettingsForm() {}, updateActionButtons() {}, showProcessing() { events.push("modal"); }, closeProcessing() { events.push("close"); }, updateProgress() {}, setStatusKey() {}, setStatus() {}, showUserError() { events.push("error"); }, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.startDetectionForTest=startDetectionFromDialog;", context);
  await context.startDetectionForTest({ preventDefault() {} });
  assert.deepEqual(events, ["modal", "/api/settings?status=0", "close", "error"], "a settings-save failure never sends a detection request");
}

async function testCompletionInvalidatesAndReloadsCandidates() {
  const oldRecord = { id: "image", candidateRevision: 1 };
  const newRecord = { id: "image", candidateRevision: 2 };
  const events = [];
  const state = {
    images: [oldRecord], currentId: "image", imageGeneration: 0, catalogEpoch: 4,
    maskStatus: new Map(), detectionTargetIds: ["image"], drafts: new Map(),
    handledDetectionStartedAt: null, detectCancelRequested: false,
  };
  const context = {
    state, Array, Number, Promise, Map,
    modalInvokers: new Map(),
    $: () => ({}),
    api: async () => ({ images: [newRecord] }),
    isCurrentGeneration: () => true, isCurrentCatalogEpoch: () => true,
    pruneSourceAccess() {},
    releaseCandidateBundles: (id) => events.push(["release", id]),
    markImagesUnreviewed() {}, closeProcessing() {}, renderCatalogViews() {},
    selectImage: async (...args) => events.push(["select", ...args]),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "save.js"), "utf8"), context, { filename: path.join(root, "save.js") });
  vm.runInNewContext("globalThis.finishDetectionForTest=finishDetectionJob;", context, { filename: "test-finish-detection-exports.js" });
  await context.finishDetectionForTest({
    kind: "detect", state: "complete", startedAt: 10, imageIds: ["image"], completedImageIds: ["image"],
  });
  assert.equal(state.images[0], newRecord, "the reconciled catalog revision becomes authoritative");
  assert.deepEqual(events[0], ["release", "image"], "the old candidate bitmap bundle is invalidated");
  assert.equal(events[1][0], "select");
  assert.equal(events[1][1], "image");
  assert.equal(events[1][2], true);
  assert.equal(
    events[1][3].saveCurrentDraft, false,
    "the current image reloads without writing old candidates under the new revision",
  );
}

Promise.resolve()
  .then(testDetectionWaitsForDraft)
  .then(testDetectionShowsProcessingBeforeDelayedRequests)
  .then(testDetectionStartFailureClosesProcessing)
  .then(testDetectionSettingsFailureDoesNotStartDetect)
  .then(testCompletionInvalidatesAndReloadsCandidates)
  .then(() => console.log("test_detection_refresh_runtime: passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
