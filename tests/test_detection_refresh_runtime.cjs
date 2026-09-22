const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");

const root = path.join(__dirname, "..", "static", "js");

async function testDetectionWaitsForDraft() {
  const events = [];
  const validation = { id: "detectionTargetValidation", textContent: "", hidden: true };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null };
  const context = {
    state, Math, Promise,
    $: () => validation,
    isBusy: () => false, catalogStagingEditsActive: () => false, flushAllImageMutations: async () => {}, flushAllWorkspaceMutations: async () => {}, processableImages: (images = [{ id: "image" }]) => images,
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

async function testDetectionFinalizesPendingStateBeforeShowingProcessing() {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const settings = deferred(); const draft = deferred(); const detect = deferred();
  const controls = new Map();
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { id, value: id === "#detectConfidenceNumber" ? "0.5" : id === "#detectCandidatePadding" ? "0" : "1", checked: id === "#dialogTargetPenis" || id.includes('="unreviewed"'), textContent: "", hidden: false, disabled: false, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); }, close() { this.closed = true; }, querySelectorAll() { return []; } });
    return controls.get(id);
  };
  const events = [];
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null, images: [{ id: "one", reviewed: false }, { id: "two", reviewed: false }], pendingDetectionTargetIds: ["one", "two"], detectionDialogBaseIds: ["one", "two"], detectionDialogFilterable: true, detectionDialogSubmitting: false, settings: { detection: { targets: ["penis"], image_filters: ["unreviewed"] } }, settingsStatus: null };
  const context = {
    state, Math, Promise, Set, structuredClone, normaliseDetectionConfidence: (value) => Number(value), normaliseCandidatePadding: Number, normaliseFluidColorFillTolerance: Number, catalogStagingEditsActive: () => false, flushAllImageMutations: async () => {}, flushAllWorkspaceMutations: async () => {}, processableImages: (images = state.images) => images, imageMatchesStateFilter: (image, filters) => !filters.size || (filters.has("reviewed") && image.reviewed) || (filters.has("unreviewed") && !image.reviewed), $: control, isBusy: () => state.job?.state === "running",
    saveDraft: () => { events.push("draft"); return draft.promise; },
    api: (path) => { events.push(path); return path.startsWith("/api/settings") ? settings.promise : detect.promise; },
    setSettingsForm() {}, updateActionButtons() {}, showProcessing: (job) => events.push(`modal:${job.completed}/${job.total}:${job.current}`), closeProcessing: () => events.push("close"), updateProgress() {}, setStatusKey() {}, setStatus() {}, showUserError() {}, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.startDetectionForTest=startDetectionFromDialog;", context, { filename: "test-detection-dialog-exports.js" });
  const pending = context.startDetectionForTest({ preventDefault() {} });
  for (let index = 0; index < 12 && !events.includes("draft"); index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.join("|"), "draft", "pending edits are finalized before settings or processing starts");
  assert.equal(state.job, null, "the processing state is not published for a stale target list");
  state.images[1].reviewed = true;
  draft.resolve();
  for (let index = 0; index < 12 && !events.includes("/api/settings?status=0"); index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.join("|"), "draft|/api/settings?status=0", "settings are saved only after pending edits settle");
  settings.resolve({ settings: state.settings });
  for (let index = 0; index < 12 && !events.includes("/api/detect"); index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.join("|"), "draft|/api/settings?status=0|/api/detect", "the finalized target request is sent before publishing processing state");
  assert.equal(state.job, null, "the processing state remains unpublished while the start response is pending");
  detect.resolve({ ok: true }); await pending;
  assert.deepEqual({ imageIds: [...state.job.imageIds], completedImageIds: [...state.job.completedImageIds], completed: state.job.completed, total: state.job.total }, { imageIds: ["one"], completedImageIds: [], completed: 0, total: 1 });
  assert.equal(events.filter((event) => event.startsWith("modal:")).length, 1, "the modal is shown once after the start request succeeds");
}

async function testDetectionStartFailureClosesProcessing() {
  const events = []; const validation = { id: "#detectionTargetValidation", textContent: "", hidden: true };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null };
  const context = {
    state, Math, Promise, $: () => validation, isBusy: () => false, catalogStagingEditsActive: () => false, flushAllImageMutations: async () => {}, flushAllWorkspaceMutations: async () => {}, processableImages: (images = [{ id: "image" }]) => images,
    saveDraft: async () => { throw new Error("draft failed"); }, api: async () => ({ ok: true }),
    updateActionButtons() {}, showProcessing() { events.push("show"); }, closeProcessing() { events.push("close"); }, updateProgress(job) { events.push(job.state); }, setStatusKey() {}, setStatus() {}, showUserError() { events.push("error"); }, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.runDetectionForTest=runDetection;", context, { filename: "test-detection-failure-exports.js" });
  await context.runDetectionForTest(["image"], .5, 1, ["penis"]);
  assert.deepEqual(events, ["error"], "a start failure reports the error without publishing or closing an optimistic modal");
  assert.deepEqual([...state.detectionTargetIds], [], "a start failure retains the prior target set");
  assert.equal(state.detectionStarting, false, "a start failure releases the starting state");
}

async function testDetectionSettingsFailureDoesNotStartDetect() {
  const controls = new Map(); const events = [];
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { value: id === "#detectConfidenceNumber" ? "0.5" : id === "#detectCandidatePadding" ? "9" : "1", checked: id === "#dialogTargetPenis", textContent: "", hidden: false, disabled: false, setAttribute() {}, close() { this.closed = true; }, querySelectorAll() { return []; } });
    return controls.get(id);
  };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null, images: [{ id: "one" }], pendingDetectionTargetIds: ["one"], detectionDialogBaseIds: ["one"], detectionDialogFilterable: false, detectionDialogSubmitting: false, settings: { detection: { targets: ["penis"], default_candidate_padding_px: 0 } }, settingsStatus: null };
  const context = {
    state, Math, Promise, Set, structuredClone, normaliseDetectionConfidence: Number, normaliseCandidatePadding: Number, normaliseFluidColorFillTolerance: Number, catalogStagingEditsActive: () => false, flushAllImageMutations: async () => {}, flushAllWorkspaceMutations: async () => {}, processableImages: (images = state.images) => images, imageMatchesStateFilter: () => true, $: control, isBusy: () => false,
    saveDraft: async () => { events.push("draft"); }, api: async (path) => { events.push(path); throw new Error("settings failed"); },
    setSettingsForm() {}, updateActionButtons() {}, showProcessing() { events.push("modal"); }, closeProcessing() { events.push("close"); }, updateProgress() {}, setStatusKey() {}, setStatus() {}, showUserError() { events.push("error"); }, t: (key) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "detection.js"), "utf8"), context, { filename: path.join(root, "detection.js") });
  vm.runInNewContext("globalThis.startDetectionForTest=startDetectionFromDialog;", context);
  await context.startDetectionForTest({ preventDefault() {} });
  assert.equal(events.join("|"), "draft|/api/settings?status=0|error", "a settings-save failure keeps the detection modal open and never starts processing");
  assert.equal(control("#detectDialog").closed, undefined, "the failed settings save keeps the dialog available for retry");
  assert.equal(state.detectionDialogSubmitting, false, "the failed settings save restores dialog controls");
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
    state, Array, Number, Promise, Map, window: { addEventListener() {} }, localStorage: { length: 0, key() { return null; }, getItem() { return null; }, setItem() {}, removeItem() {} },
    modalInvokers: new Map(),
    $: () => ({}),
    api: async () => ({ images: [newRecord] }),
    isCurrentGeneration: () => true, isCurrentCatalogEpoch: () => true,
    pruneSourceAccess() {}, loadReviewedPaths() {}, reconcileCatalogSnapshot(data) { state.images = data.images; return true; },
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

nodeTest("detection refresh runtime contracts", async () => {
  await testDetectionWaitsForDraft();
  await testDetectionFinalizesPendingStateBeforeShowingProcessing();
  await testDetectionStartFailureClosesProcessing();
  await testDetectionSettingsFailureDoesNotStartDetect();
  await testCompletionInvalidatesAndReloadsCandidates();
});
