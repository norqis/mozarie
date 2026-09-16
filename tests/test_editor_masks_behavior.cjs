const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function canvasContext(name) {
  const context = {
    name, pixels: false, calls: [],
    canvas: { width: 100, height: 80 },
    save() { this.calls.push("save"); }, restore() { this.calls.push("restore"); },
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() { this.pixels = true; this.calls.push(`fill:${this.globalCompositeOperation}`); },
    stroke() { this.pixels = true; this.calls.push(`stroke:${this.globalCompositeOperation}`); },
    clearRect() { this.pixels = false; this.calls.push("clear"); },
    drawImage() { this.pixels = true; this.calls.push("draw"); },
    fillRect() { this.pixels = true; this.calls.push(`fill:${this.globalCompositeOperation}`); },
    getImageData() { return { data: new Uint8ClampedArray(100 * 80 * 4) }; }, putImageData() {},
  };
  return context;
}

function pixelLayer(context) {
  const pixels = new Set();
  let point = null; let path = [];
  const key = (x, y) => `${x},${y}`;
  const original = {
    beginPath: context.beginPath, moveTo: context.moveTo, lineTo: context.lineTo, arc: context.arc, fill: context.fill, stroke: context.stroke,
    drawImage: context.drawImage, getImageData: context.getImageData, putImageData: context.putImageData,
  };
  const draw = (x, y) => {
    if (context.globalCompositeOperation === "destination-out") pixels.delete(key(x, y));
    else pixels.add(key(x, y));
    context.pixels = pixels.size > 0;
  };
  context.beginPath = () => { point = null; path = []; };
  context.moveTo = (x, y) => { path.push({ x: Math.floor(x), y: Math.floor(y) }); };
  context.lineTo = (x, y) => { path.push({ x: Math.floor(x), y: Math.floor(y) }); };
  context.arc = (x, y) => { point = { x: Math.floor(x), y: Math.floor(y) }; };
  context.fill = () => {
    if (!point) return;
    draw(point.x, point.y);
  };
  context.stroke = () => { for (const segment of path) draw(segment.x, segment.y); };
  context.drawImage = (source) => {
    const sourcePixels = source?.__pixelLayer?.copy?.();
    if (!sourcePixels) return original.drawImage.call(context, source);
    pixels.clear(); for (const pixel of sourcePixels) pixels.add(pixel);
    context.pixels = pixels.size > 0;
  };
  context.getImageData = (left, top, width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (pixels.has(key(left + x, top + y))) data[(y * width + x) * 4 + 3] = 255;
    }
    return { data, width, height };
  };
  context.putImageData = (image, left, top) => {
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
      const target = key(left + x, top + y);
      if (image.data[(y * image.width + x) * 4 + 3]) pixels.add(target); else pixels.delete(target);
    }
    context.pixels = pixels.size > 0;
  };
  const layer = {
    set(x, y) { pixels.add(key(x, y)); context.pixels = true; },
    has(x, y) { return pixels.has(key(x, y)); },
    copy() { return new Set(pixels); },
    restore() { Object.assign(context, original); delete context.canvas.__pixelLayer; },
  };
  context.canvas.__pixelLayer = layer;
  return layer;
}

const addCtx = canvasContext("add");
const exclusionCtx = canvasContext("exclude");
const exclusionEraseCtx = canvasContext("excludeErase");
const historyAddCtx = canvasContext("historyAdd");
const historyExclusionCtx = canvasContext("historyExclude");
const historyExclusionEraseCtx = canvasContext("historyExcludeErase");
exclusionCtx.pixels = true;
exclusionEraseCtx.pixels = true;
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) {
    const classes = new Set();
    elements.set(selector, {
      value: selector === "#bucketTolerance" ? "12" : "6", textContent: "", disabled: false,
      children: [], dataset: {}, listeners: new Map(), attributes: new Map(), style: {}, isConnected: true, classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
    }, setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    focus() { this.focused = true; }, select() { this.selected = true; },
    getBoundingClientRect() { return { left: 10, right: 80, top: 10, bottom: 38, width: 70, height: 28 }; },
    showPopover() { this.popoverOpen = true; }, hidePopover() { this.popoverOpen = false; },
    matches(value) { return value === ":popover-open" && this.popoverOpen === true; }, contains(target) { return this === target || this.children.includes(target); },
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    });
  }
  return elements.get(selector);
}

const events = [];
const dirtyRois = [];
const batchPresences = [];
let blinkTick = null;
let displayButtonQueries = 0;
let effectiveButtonQueries = 0;
const displayButtons = [{
  dataset: { candidateDisplayToggle: "exclude" },
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value); },
}];
const effectiveButtons = [{
  dataset: { candidateEffectiveToggle: "exclude" },
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value); },
}];
const displayIdButtons = [{ dataset: { candidateDisplayId: "apply" }, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } }];
const effectiveIdButtons = [{ dataset: { candidateEffectiveId: "apply" }, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } }];
const state = {
  currentId: "image", currentImage: { width: 100, height: 80 }, imageGeneration: 2, catalogEpoch: 3,
  candidates: [
    { id: "apply", role: "apply", enabled: true, labelToken: "penis", source: "target", refinement: null, color: "#fff" },
    { id: "exclude", role: "exclude", enabled: true, forced: true, labelToken: "hand", source: "hand_exclusion", refinement: null, color: "#000" },
  ],
  removedCandidateIds: new Set(), candidateImages: new Map(), blinkCandidateIds: new Set(), blinkModes: new Map(), blinkRoleModes: new Map(), blinkPhase: false, blinkTimer: null,
  manualMaskPresent: true, manualExclusionPresent: true, manualExclusionErasePresent: true, manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: false,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(), candidateBatchPending: new Set(),
  maskStatus: new Map(), images: [{ id: "image", assetVersion: "a", candidateRevision: 4, candidateCount: 0, enabledCandidateCount: 0 }],
  history: [], historyIndex: 0, historyRestoreToken: 0, historyRemovedCandidateIds: new Set(), historyCandidateIds: new Set(["apply", "exclude"]), historyBaseDirty: false, hiddenImageIds: new Set(), reviewedImageIds: new Set(),
  boundaryDrafts: [{ id: "draft", type: "rectangle", roi: { left: 1, top: 2, right: 10, bottom: 12 } }], boundaryActiveId: "draft", boundaryPending: false,
  importing: false, projectReadOnly: false, projectHistoryBusy: false, project: null, projectHistory: new Map(), drafts: new Map(), pendingImageId: null, fillPending: false, tool: "brush", view: { x: 0, y: 0, scale: 1 }, settings: { editing: { fill_color_tolerance: 12 } },
};

let latestFillWorker = null;
class FillWorker {
  constructor(url) { this.url = url; latestFillWorker = this; }
  postMessage(payload, transfers) { this.payload = payload; this.transfers = transfers; }
  terminate() { this.terminated = true; }
}

const context = {
  state, Math, Number, String, Boolean, Array, Map, Set, Promise, JSON, Uint8ClampedArray, encodeURIComponent, Worker: FillWorker, innerWidth: 1200, innerHeight: 800,
  addCtx, exclusionCtx, exclusionEraseCtx, addCanvas: addCtx.canvas, exclusionCanvas: exclusionCtx.canvas, exclusionEraseCanvas: exclusionEraseCtx.canvas,
  historyAddCanvas: { ...historyAddCtx.canvas, getContext: () => historyAddCtx },
  historyExclusionCanvas: { ...historyExclusionCtx.canvas, getContext: () => historyExclusionCtx },
  historyExclusionEraseCanvas: { ...historyExclusionEraseCtx.canvas, getContext: () => historyExclusionEraseCtx },
  combinedCanvas: { toDataURL: () => "data:image/png;base64,mask" }, originalCanvas: { width: 100, height: 80 }, originalCtx: addCtx,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  $: element, document: {
    querySelectorAll(selector) {
      if (selector === "[data-candidate-display-toggle]") { displayButtonQueries += 1; return displayButtons; }
      if (selector === "[data-candidate-effective-toggle]") { effectiveButtonQueries += 1; return effectiveButtons; }
      if (selector === "[data-candidate-display-id]") return displayIdButtons;
      if (selector === "[data-candidate-effective-id]") return effectiveIdButtons;
      return [];
    },
    createElement: () => element(`node-${elements.size}`),
  },
  setInterval: (callback) => { blinkTick = callback; return 1; }, clearInterval() {}, requestAnimationFrame: (callback) => { callback(); return 1; }, cancelAnimationFrame() {},
  isBusy: () => false, isGestureActive: () => false, catalogStagingEditsActive: () => false, currentImageActionPending: () => Boolean(state.pendingImageId), candidateControlLocked: () => false, isProcessableImage: () => true, manualCanvasInputLocked: () => false, hasDurableHistory: () => false, isCurrentCatalogEpoch: (epoch) => epoch === state.catalogEpoch, isCurrentGeneration: (generation) => generation === state.imageGeneration,
  catalogRecordMatches: () => true, currentRecord: () => state.images.find((record) => record.id === state.currentId),
  imageAssetVersion: (record) => record?.assetVersion || "", imageHasMask: () => true, canvasHasPixels: (ctx) => ctx.pixels,
  CANDIDATE_CLASS_TOKENS: new Set(["penis", "hand"]), CANDIDATE_SOURCE_TOKENS: new Set(["target", "hand_exclusion"]), CANDIDATE_REFINEMENT_TOKENS: new Set(),
  t: (key, values) => values?.label ? `${key}:${values.label}` : key, confirmationRequired: () => false, confirmAction: async () => true,
  markMaskDirty: () => events.push("dirty"), markDraftDirty: (...layers) => events.push(`draft:${layers.join(",")}`), queueImageMutation: async (_imageId, action) => action(), publishWorkspaceFlags() {}, saveWorkspaceFlagNow: async () => true, refreshReviewViews() {},
  markDraftDirtyRoi: (layer, roi) => dirtyRois.push({ layer, roi: roi && { ...roi } }), mergeMosaicPreviewRoi: (_previous, roi) => roi,
  calculatedBlockSize: () => 8, composeCurrentMask: () => events.push("compose-roi"), flushMaskComposition: () => events.push("flush"), requestMosaicPreview: () => events.push("preview"), scheduleManualWorkspaceSave: () => events.push("save"), saveDraft: () => events.push("draft-save"),
  ensureHistoryCanvases: () => true, releaseHistoryCanvases() {},
  setReviewed: () => events.push("review"), updateHistoryButtons() {}, updateCandidateStatus() {}, refreshCurrentReviewAndMask() {}, refreshMaskStatus() {},
  fillUiRefreshes: [], renderCandidates: () => events.push("candidates"), render: () => events.push("render"), renderCatalogViews: () => events.push("catalog"), updateActionButtons: () => context.fillUiRefreshes.push("actions"),
  updateCandidateBatchButtons(...args) { batchPresences.push(args[2]); },
  syncCurrentCandidateRecord() {}, syncCandidateRecord() {}, retainCurrentCandidateBundle() {}, refreshCandidateRecord: async () => {}, reconcileCurrentCandidates: async () => true,
  fetchBitmap: async () => ({ close() {} }), maskUrl: (_imageId, candidateId, revision) => `${candidateId}:${revision}`, closeBitmap(bitmap) { bitmap.close(); },
  releaseCandidateBitmap() {}, releaseCandidateBundles() {}, invalidateCandidateBundles: () => events.push("invalidate"), markImagesUnreviewed: () => events.push("unreview"),
  clearBoundaryInteraction: () => events.push("boundary-clear"), updateBoundaryActions() {}, setStatusKey: () => events.push("status"), showUserError: (error) => events.push(`error:${error}`),
  canDetectBoundary: () => true, compareEventSide: () => "right", compareSideOffset: () => 100, inverseTransformImagePoint: (point) => point,
  flushWorkspaceDraft: async () => {}, applyProjectSnapshot() {}, loadReviewedPaths() {}, invalidateMaskComposition() {}, codedError: (code) => ({ code }), selectImage: async () => {},
  boundaryRequests: () => [{ draft: state.boundaryDrafts[0], draftIds: ["draft"] }], pointForRoi: (roi) => ({ x: roi.left + 1, y: roi.top + 1 }),
  api: async () => ({ candidates: [{ id: "boundary", enabled: true }], candidateRevision: 8 }),
};

const masksPath = path.join(__dirname, "..", "static", "js", "editor-masks.js");
const source = fs.readFileSync(masksPath, "utf8");
vm.runInNewContext(source, context, { filename: masksPath });
vm.runInNewContext("globalThis.masksTest = { candidateLabel, manualLayerPresence, renderCandidateRows: renderCandidates, candidatePaddingLimit, candidatePaddingValue, validateCandidatePadding, openCandidatePadding, openBatchCandidatePadding, closeCandidatePadding, commitCandidatePadding, commitBatchCandidatePadding, changeCandidatePaddingDraft, candidateDisplayMode, candidateDisplayIdsForRole, syncCandidateDisplayButtons, syncCandidateBlinkTimer, setCandidateDisplayMode, toggleCandidateDisplay, toggleCandidateEffective, candidateDisplayToggle, candidateEffectiveToggle, clearCandidateBlink, clearCandidateMutationState, candidateMutationKey, nextCandidateMutationVersion, enqueueCandidateMutation, waitForCandidateMutations, updateCandidate, deleteCandidate, deleteManualMask, deleteManualExclusion, deleteManualExclusionErase, shouldBlinkNewManual, batchCandidateOperation, escapeHtml, pointFromEvent, clampPoint, boundaryDragStarted, polygonVertexAt, completedPolygonVertexAt, rectangleDraftAt, paintStrokeOnContexts, paintStrokePath, paintFillSpans, applyFillSpans, enableManualLayerForTool, beginManualStroke, appendManualStrokePoint, paintPendingManualStroke, completeManualStroke, cancelManualStroke, replayManualStroke, historyWeight, trimHistory, rebuildManualMaskFromHistory, recordHistoryOperation, resetHistoryToCurrentManualMask, refreshProjectHistory, restoreProjectHistory, restoreSnapshot, buildCombinedMask, addBoundaryCandidate, cancelBoundary, fillAt };\nrenderCandidates = () => globalThis.fillUiRefreshes.push(\"candidates\"); render = globalThis.render;", context, { filename: "test-editor-masks-exports.js" });
const test = context.masksTest;

const candidateLabelFixtures = [
  { labelToken: "penis", source: "target", refinement: "sam_high_precision", role: "apply", origin: "provenance-one" },
  { labelToken: "pussy", source: "target", refinement: "sam_fallback", role: "apply", origin: "provenance-two" },
  { labelToken: "testicles", source: "ntd11", refinement: "sam_high_precision", role: "apply", origin: "provenance-three" },
  { labelToken: "boundary", source: "boundary", refinement: "sam_fallback", role: "apply", origin: "provenance-four" },
  { labelToken: "boundary_polygon", source: "boundary", refinement: "sam_high_precision", role: "apply", origin: "provenance-five" },
  { labelToken: "hand", source: "hand_exclusion", refinement: "sam_fallback", role: "exclude", origin: "provenance-six" },
  { labelToken: "fluid", source: "fluid_exclusion", refinement: "sam_high_precision", role: "exclude", origin: "provenance-seven" },
];
for (const candidate of candidateLabelFixtures) {
  assert.equal(test.candidateLabel(candidate), `candidateLabel.${candidate.labelToken}`, "candidate labels use only their localized class token");
}

assert.deepEqual([...test.candidateDisplayIdsForRole("apply")], ["apply", "manual:apply"]);
assert.deepEqual([...test.candidateDisplayIdsForRole("exclude")], ["exclude", "manual:exclude", "manual:excludeErase"]);
const readCounts = new Map();
context.canvasHasPixels = (ctx) => {
  readCounts.set(ctx.name, (readCounts.get(ctx.name) || 0) + 1);
  return ctx.pixels;
};
const presentManualLayers = { hasManualExclude: true, hasManualExclusionErase: true };
assert.deepEqual([...test.candidateDisplayIdsForRole("exclude", presentManualLayers)], ["exclude", "manual:exclude", "manual:excludeErase"], "supplied manual-layer presence preserves the displayed candidates");
assert.equal(readCounts.size, 0, "supplied manual-layer presence avoids canvas readback");
const absentManualLayers = { hasManualExclude: false, hasManualExclusionErase: false };
exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
assert.deepEqual([...test.candidateDisplayIdsForRole("exclude", absentManualLayers)], ["exclude"], "false manual-layer presence preserves the displayed candidates");
assert.equal(readCounts.size, 0, "false supplied manual-layer presence also avoids canvas readback");
exclusionCtx.pixels = true; exclusionEraseCtx.pixels = true;
test.setCandidateDisplayMode(["apply", "manual:apply"], "normal");
assert.equal(test.candidateDisplayMode("apply"), "normal");
test.toggleCandidateEffective("apply");
assert.equal(test.candidateDisplayMode("apply"), "effective", "effective display replaces the normal candidate display");
test.toggleCandidateEffective("apply");
assert.equal(test.candidateDisplayMode("apply"), "off");
test.clearCandidateBlink();
assert.equal(state.blinkCandidateIds.size, 0);

state.blinkCandidateIds = new Set(["exclude"]);
state.blinkModes = new Map([["exclude", "normal"]]);
test.syncCandidateBlinkTimer();
test.syncCandidateDisplayButtons(presentManualLayers);
const displayStateBeforeTick = displayButtons[0].attributes.get("aria-pressed");
const effectiveStateBeforeTick = effectiveButtons[0].attributes.get("aria-pressed");
readCounts.clear(); displayButtonQueries = 0; effectiveButtonQueries = 0;
assert.equal(state.blinkPhase, true, "starting display blinking keeps the existing visible phase");
blinkTick();
assert.equal(state.blinkPhase, false, "each blink tick keeps the existing phase transition");
assert.equal(element("#candidatePane").classList.contains("blink-phase"), false, "each blink tick updates only the existing pane phase class");
assert.equal(displayButtonQueries, 0, "a blink tick does not resynchronize the display batch controls");
assert.equal(effectiveButtonQueries, 0, "a blink tick does not resynchronize the effective batch controls");
assert.equal(readCounts.size, 0, "a blink tick does not read either full-resolution manual layer");
assert.equal(displayButtons[0].attributes.get("aria-pressed"), displayStateBeforeTick, "a blink tick leaves the exclusion display button state unchanged");
assert.equal(effectiveButtons[0].attributes.get("aria-pressed"), effectiveStateBeforeTick, "a blink tick leaves the exclusion effective button state unchanged");
test.clearCandidateBlink();

test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "brush", 4);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "eraser", 4);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "exclude_eraser", 4);
dirtyRois.length = 0;
state.manualExclusionForced = false;
test.paintStrokePath([{ x: 2, y: 2 }], "brush", 4);
assert.deepEqual(dirtyRois, [
  { layer: "add", roi: { left: 0, top: 0, right: 8, bottom: 8 } },
  { layer: "exclusion", roi: { left: 0, top: 0, right: 8, bottom: 8 } },
], "an unforced brush stroke records both touched draft layers with its ROI");
dirtyRois.length = 0;
state.manualExclusionForced = true;
test.paintStrokePath([{ x: 2, y: 2 }], "brush", 4);
assert.deepEqual(dirtyRois, [{ layer: "add", roi: { left: 0, top: 0, right: 8, bottom: 8 } }], "a forced brush stroke records only its add-layer ROI");
dirtyRois.length = 0;
state.manualExclusionForced = false;
assert.ok(addCtx.calls.some((call) => call === "stroke:source-over"));
assert.ok(exclusionEraseCtx.calls.some((call) => call === "stroke:destination-out"));
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "bucket");
const addCallsBeforeExcludeFill = [...addCtx.calls];
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "exclude_bucket");
assert.deepEqual(addCtx.calls, addCallsBeforeExcludeFill, "exclude fill leaves the manual mosaic layer byte path untouched");
const addCallsBeforeExcludeReplay = [...addCtx.calls];
test.replayManualStroke({ tool: "exclude_bucket", spans: [3, 4, 8] });
assert.deepEqual(addCtx.calls, addCallsBeforeExcludeReplay, "exclude fill history replay never writes the manual mosaic layer");
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "exclude_eraser");
assert.deepEqual(dirtyRois, [
  { layer: "add", roi: { left: 3, top: 2, right: 7, bottom: 3 } },
  { layer: "exclusion", roi: { left: 3, top: 2, right: 7, bottom: 3 } },
  { layer: "exclusion", roi: { left: 3, top: 2, right: 7, bottom: 3 } },
  { layer: "exclusionErase", roi: { left: 3, top: 2, right: 7, bottom: 3 } },
  { layer: "exclusion", roi: { left: 4, top: 3, right: 8, bottom: 4 } },
  { layer: "exclusionErase", roi: { left: 4, top: 3, right: 8, bottom: 4 } },
  { layer: "exclusionErase", roi: { left: 3, top: 2, right: 7, bottom: 3 } },
], "strokes and fills record only their touched draft layers with their exact ROIs");

const assertFillRouting = (tool, expected) => {
  for (const context of [addCtx, exclusionCtx, exclusionEraseCtx]) { context.calls = []; context.globalCompositeOperation = "source-over"; }
  test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], tool);
  for (const context of [addCtx, exclusionCtx, exclusionEraseCtx]) {
    assert.equal(context.calls.filter((call) => call === "save").length, context.calls.filter((call) => call === "restore").length, `${tool} balances the ${context.name} canvas state stack`);
    assert.deepEqual(context.calls.filter((call) => call.startsWith("fill:")), expected[context.name] || [], `${tool} writes only the intended ${context.name} layer`);
  }
};
state.manualExclusionForced = false;
assertFillRouting("bucket", { add: ["fill:source-over"], exclude: ["fill:destination-out"] });
assertFillRouting("exclude_bucket", { exclude: ["fill:source-over"], excludeErase: ["fill:destination-out"] });
assertFillRouting("eraser", { exclude: ["fill:source-over"], excludeErase: ["fill:destination-out"] });
assertFillRouting("exclude_eraser", { excludeErase: ["fill:source-over"] });

const savedImage = state.currentImage;
state.currentImage = null;
test.beginManualStroke({ x: 2, y: 2 });
test.fillAt({ x: 2, y: 2 });
test.cancelManualStroke();
test.replayManualStroke({ points: [] });
assert.equal(state.activeStroke, null, "manual paint, fill, cancel, and replay are inert without a loaded image");
state.currentImage = savedImage;

state.tool = "brush";
events.length = 0;
test.beginManualStroke({ x: 4, y: 4 });
assert.ok(events.includes("preview"), "the initial brush point schedules a live mosaic preview without waiting for pointer movement");
test.appendManualStrokePoint({ x: 8, y: 8 });
test.completeManualStroke();
assert.equal(state.history.length, 1, "a completed brush gesture is retained for undo");
assert.equal(state.manualMaskPresent, true);
state.removedCandidateIds.add("apply");
test.recordHistoryOperation({ kind: "removeCandidates", ids: ["apply"] });
assert.equal(state.historyIndex, 2);
test.rebuildManualMaskFromHistory(1);
assert.equal(state.removedCandidateIds.has("apply"), false, "undo rebuilds the candidate deletion state");
test.rebuildManualMaskFromHistory(2);
assert.equal(state.removedCandidateIds.has("apply"), true, "redo replays the candidate deletion");
assert.equal(test.buildCombinedMask(), "data:image/png;base64,mask");

test.enableManualLayerForTool("exclude_eraser");
assert.equal(state.manualExclusionEraseEnabled, true);

nodeTest("editor masks, fill, candidates, and history", async () => {
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryDrafts.length, 0, "successful boundary detection consumes the submitted draft");
  assert.equal(state.images[0].candidateRevision, 8);
  assert.equal(state.images[0].candidateCount, 1);
  assert.ok(state.history.some((entry) => entry.kind === "addCandidates" && entry.ids.includes("boundary")));

  state.boundaryDrafts = [{ id: "failed", type: "rectangle", roi: { left: 3, top: 3, right: 9, bottom: 9 } }];
  context.api = async () => { throw new Error("boundary unavailable"); };
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryDrafts.length, 1, "failed boundary detection preserves the draft for retry");
  assert.ok(events.some((event) => event.startsWith("error:")));

  // Candidate mutations are optimistic, ordered per image, and must restore the
  // visible aggregate when the server cannot accept the change.
  const resetCandidateState = () => {
    state.currentId = "image"; state.imageGeneration = 2; state.importing = false;
    state.candidates = [
      { id: "apply", role: "apply", enabled: true, confidence: 0.8, labelToken: "penis", source: "target", refinement: null, color: "#fff" },
      { id: "exclude", role: "exclude", enabled: true, forced: true, labelToken: "hand", source: "hand_exclusion", refinement: null, color: "#000" },
    ];
    state.removedCandidateIds = new Set(); state.candidateUpdateChains = new Map(); state.candidateUpdateVersions = new Map();
    state.candidateDeleting = new Set(); state.candidateBatchPending = new Set(); state.maskStatus = new Map([["image", true]]);
    state.blinkCandidateIds = new Set(); state.blinkModes = new Map(); state.blinkRoleModes = new Map(); state.blinkPhase = false; state.blinkTimer = null;
    state.manualMaskPresent = true; state.manualExclusionPresent = true; state.manualExclusionErasePresent = true; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true; state.manualExclusionForced = false;
    addCtx.pixels = true; exclusionCtx.pixels = true; exclusionEraseCtx.pixels = true;
    state.images = [{ id: "image", width: 100, height: 80, assetVersion: "a", candidateRevision: 4, candidateCount: 2, enabledCandidateCount: 1 }];
    state.history = []; state.historyIndex = 0; state.historyRemovedCandidateIds = new Set(); state.historyCandidateIds = new Set(["apply", "exclude"]);
    context.confirmationRequired = () => false; context.confirmAction = async () => true;
    context.isBusy = () => false; context.reconcileCurrentCandidates = async () => false;
  };

  // Projectless undo keeps its cursor on the old snapshot while every server
  // write is pending.  A failure after a partial write must reload the server
  // state through a forced selection, even while restoration is marked busy.
  const originalHistoryHooks = {
    api: context.api, queueImageMutation: context.queueImageMutation, saveWorkspaceFlagNow: context.saveWorkspaceFlagNow,
    saveDraft: context.saveDraft, flushWorkspaceDraft: context.flushWorkspaceDraft, selectImage: context.selectImage,
    fetchBitmap: context.fetchBitmap, reconcileCatalogSnapshot: context.reconcileCatalogSnapshot,
  };
  const historyTarget = () => ({
    manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: true,
    reviewed: true, hidden: true, removedCandidateIds: [], candidates: [{ id: "apply", enabled: false, forced: true, expandPx: 4, color: "#abc" }],
  });
  const prepareProjectlessRestore = () => {
    state.currentId = "image"; state.currentImage = { width: 100, height: 80 }; state.imageGeneration = 2; state.importing = false;
    state.historyRestoreBusy = false; state.pendingImageId = null; state.project = null; state.drafts = new Map(); state.maskStatus = new Map();
    state.images = [{ id: "image", width: 100, height: 80, assetVersion: "a", candidateRevision: 4, reviewed: false, hidden: false, flipH: true, flipV: false }];
    state.candidates = [{ id: "apply", role: "apply", enabled: true, forced: false, expandPx: 8, color: "#fff" }];
    state.candidateImages = new Map(); state.candidateUpdateVersions = new Map(); state.removedCandidateIds = new Set();
    state.historyEditorState = historyTarget(); state.historyRemovedCandidateIds = new Set(); state.historyCandidateIds = new Set(["apply"]);
    state.history = [{ kind: "transform", flipH: true, flipV: false }]; state.historyIndex = 1;
  };
  const runProjectlessRestore = async (failAt = null, holdQueue = false) => {
    prepareProjectlessRestore();
    const order = []; const serverRecord = { ...state.images[0] }; const serverCandidate = { ...state.candidates[0] };
    let releaseQueue; const queueGate = holdQueue ? new Promise((resolve) => { releaseQueue = resolve; }) : Promise.resolve();
    context.queueImageMutation = async (_imageId, action) => { order.push("queued"); await queueGate; return action(); };
    context.saveWorkspaceFlagNow = async (_record, field, value) => {
      order.push(`flag:${field}`); if (failAt === field) return false;
      serverRecord[field] = value; return true;
    };
    context.api = async (path) => {
      order.push(path);
      if (path === "/api/images") return { images: [{ ...serverRecord }] };
      if (path.endsWith("/transform")) {
        if (failAt === "transform") throw new Error("transform failed");
        serverRecord.flipH = false; return { image: { ...serverRecord } };
      }
      if (path.includes("/api/candidate/")) {
        if (failAt === "candidate") throw new Error("candidate failed");
        Object.assign(serverCandidate, { enabled: false, forced: true, expandPx: 4, color: "#abc" }); return { candidateRevision: 5 };
      }
      throw new Error(`unexpected ${path}`);
    };
    context.fetchBitmap = async () => ({ close() {} });
    context.saveDraft = async (historyIndex) => { order.push(`draft:${historyIndex}`); if (failAt === "draft") throw new Error("draft failed"); };
    context.flushWorkspaceDraft = async () => { order.push("flush"); };
    context.reconcileCatalogSnapshot = () => false;
    context.selectImage = async (imageId, force, options) => {
      order.push("select"); assert.equal(imageId, "image"); assert.equal(force, true, "history resync bypasses the busy select guard"); assert.equal(options.saveCurrentDraft, false);
      state.candidates = [{ ...serverCandidate }];
    };
    const pending = test.restoreSnapshot(0);
    assert.equal(state.historyIndex, 1, "history position remains on the prior snapshot while queued persistence waits");
    if (holdQueue) {
      assert.equal(state.historyRestoreBusy, true, "the queued restore marks itself busy until the mutation begins");
      assert.deepEqual(order, ["queued"], "no write begins before the image mutation queue releases");
      releaseQueue();
    }
    await pending;
    return { order, serverRecord, serverCandidate };
  };
  let restoreResult = await runProjectlessRestore(null, true);
  assert.equal(state.historyIndex, 0, "history position commits only after all persistence has completed");
  assert.deepEqual(restoreResult.order, ["queued", "flag:reviewed", "flag:hidden", "/api/images/image/transform", "/api/candidate/image/apply", "draft:0", "flush"], "projectless restore persists flags, transform, padding, draft, and flush in order");
  for (const failedStep of ["reviewed", "hidden", "transform", "candidate", "draft"]) {
    restoreResult = await runProjectlessRestore(failedStep);
    assert.equal(state.historyIndex, 1, `${failedStep} failure leaves the previous history position selected`);
    assert.ok(restoreResult.order.includes("/api/images"), `${failedStep} failure reloads the server snapshot`);
    assert.ok(restoreResult.order.includes("select"), `${failedStep} failure force-selects the resynchronized image`);
    assert.equal(JSON.stringify(state.images[0]), JSON.stringify(restoreResult.serverRecord), `${failedStep} failure leaves catalog state equal to the server`);
    assert.equal(JSON.stringify(state.candidates[0]), JSON.stringify(restoreResult.serverCandidate), `${failedStep} failure leaves candidate state equal to the server`);
  }
  Object.assign(context, originalHistoryHooks);

  resetCandidateState();
  readCounts.clear(); batchPresences.length = 0;
  test.renderCandidateRows();
  assert.equal(readCounts.size, 0, "candidate rows use the tracked layer-presence state without synchronous canvas readback");
  assert.deepEqual({ ...batchPresences.at(-1) }, presentManualLayers, "the batch controls receive the same manual-layer presence used for candidate display");
  const eraseRow = [...elements.values()].find((node) => node.className === "candidate-row candidate-row-manual candidate-row-manual-exclude-erase");
  const eraseToggle = eraseRow.children[1].children.find((node) => node.className === "candidate-toggle");
  state.importing = true;
  eraseToggle.listeners.get("click")();
  assert.equal(state.manualExclusionEraseEnabled, true, "the manual exclusion-erase toggle ignores input while importing");
  state.importing = false;
  eraseToggle.listeners.get("click")();
  assert.equal(state.manualExclusionEraseEnabled, false, "the manual exclusion-erase toggle persists a user click after importing finishes");

  const excludeRow = [...elements.values()].find((node) => node.className === "candidate-row candidate-row-exclude");
  const forcedToggle = excludeRow.children[1].children.find((node) => node.className === "candidate-forced");
  state.importing = true;
  forcedToggle.listeners.get("click")();
  assert.equal(state.candidates[1].forced, true, "the exclusion force toggle ignores input while importing");
  state.importing = false;
  state.maskStatus.clear();
  context.api = async () => ({ candidateRevision: 5 });
  await forcedToggle.listeners.get("click")();
  assert.equal(state.candidates[1].forced, false, "the exclusion force toggle sends the user-selected forced state");
  const candidateCalls = [];
  let retainedRevision = null;
  context.retainCurrentCandidateBundle = (_imageId, revision) => { retainedRevision = revision; };
  context.api = async (path, options) => {
    candidateCalls.push({ path, body: JSON.parse(options.body) });
    return { candidateRevision: 9 };
  };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.deepEqual(candidateCalls, [{ path: "/api/candidate/image/apply", body: { enabled: false, color: "#fff" } }], "a candidate toggle persists its requested enabled state");
  assert.equal(retainedRevision, 9, "a successful mutation retains the returned candidate revision");
  candidateCalls.length = 0;
  let oldMaskClosed = 0;
  const oldMask = { close() { oldMaskClosed += 1; } };
  const expandedMask = { close() {} };
  state.candidateImages.set("apply", oldMask);
  context.fetchBitmap = async (url) => { assert.equal(url, "apply:9", "padding refreshes the candidate mask at the returned revision"); return expandedMask; };
  state.candidates[0].expandPx = 3;
  await test.updateCandidate(state.candidates[0], false, true, undefined, 0);
  assert.deepEqual(candidateCalls, [{ path: "/api/candidate/image/apply", body: { enabled: false, color: "#fff", expandPx: 3 } }], "padding updates send only the new source-image pixel value");
  assert.equal(state.candidateImages.get("apply"), expandedMask, "padding swaps in the server-expanded candidate bitmap immediately");
  assert.equal(oldMaskClosed, 1, "padding closes the replaced candidate bitmap exactly once");

  resetCandidateState();
  const retainedBeforeStaleBitmap = retainedRevision; retainedRevision = null;
  const currentMask = { close() { throw new Error("the current bitmap must stay owned by the editor"); } };
  let staleBitmapClosed = 0;
  const staleBitmap = { close() { staleBitmapClosed += 1; } };
  state.candidateImages.set("apply", currentMask);
  state.candidates[0].expandPx = 4;
  context.api = async () => ({ candidateRevision: 10 });
  context.fetchBitmap = async () => {
    state.candidateUpdateVersions.set("image:apply", 99);
    return staleBitmap;
  };
  await test.updateCandidate(state.candidates[0], true, true, undefined, 0);
  assert.equal(staleBitmapClosed, 1, "a bitmap decoded for a superseded candidate mutation is closed");
  assert.equal(state.candidateImages.get("apply"), currentMask, "a superseded candidate mutation never replaces the currently displayed bitmap");
  assert.equal(retainedRevision, null, "a superseded bitmap fetch never publishes the returned candidate revision");
  retainedRevision = retainedBeforeStaleBitmap;

  resetCandidateState();
  test.renderCandidateRows();
  const lastRow = (className) => [...elements.values()].filter((node) => node.className === className).at(-1);
  const controlOrder = (row) => row.children[1].children.map((node) => node.className);
  assert.deepEqual(controlOrder(lastRow("candidate-row candidate-row-apply")), ["candidate-toggle", "candidate-display-toggle", "candidate-effective-toggle", "candidate-padding-button", "candidate-delete"], "apply rows use a compact two-tier control order");
  assert.deepEqual(controlOrder(lastRow("candidate-row candidate-row-exclude")), ["candidate-toggle", "candidate-display-toggle", "candidate-effective-toggle", "candidate-padding-button", "candidate-forced", "candidate-delete"], "exclusion rows use the same two-tier control order");
  assert.deepEqual(controlOrder(lastRow("candidate-row candidate-row-manual candidate-row-manual-apply")), ["candidate-toggle", "candidate-display-toggle", "candidate-effective-toggle", "candidate-delete"], "manual apply rows use the same two-tier skeleton");
  assert.deepEqual(controlOrder(lastRow("candidate-row candidate-row-manual candidate-row-manual-exclude")), ["candidate-toggle", "candidate-display-toggle", "candidate-effective-toggle", "candidate-forced", "candidate-delete"], "manual exclusion rows use the same two-tier skeleton");
  const paddingButton = lastRow("candidate-row candidate-row-apply").children[1].children.find((node) => node.className === "candidate-padding-button");
  assert.equal(paddingButton.textContent, "candidates.paddingButton", "padding is represented by one compact localized button");
  test.openCandidatePadding("apply", paddingButton);
  const paddingInput = element("#candidatePaddingInput");
  assert.equal(paddingInput.max, undefined, "candidate padding accepts the requested source-image pixel value without a hidden cap");
  const callsBeforeInvalidPadding = candidateCalls.length;
  element("#candidateList").scrollTop = 41;
  const arrowEvent = (key) => ({ key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  paddingInput.value = "invalid";
  const up = arrowEvent("ArrowUp"); context.handleCandidatePaddingKeydown(up);
  assert.deepEqual([paddingInput.value, up.prevented, up.stopped, element("#candidateList").scrollTop], ["1", true, true, 41], "ArrowUp recovers from invalid input using the persisted value without scrolling the list");
  paddingInput.value = "0"; const down = arrowEvent("ArrowDown"); context.handleCandidatePaddingKeydown(down);
  assert.deepEqual([paddingInput.value, down.prevented, down.stopped], ["0", true, true], "ArrowDown clamps at zero");
  paddingInput.value = "127"; context.handleCandidatePaddingKeydown(arrowEvent("ArrowUp")); assert.equal(paddingInput.value, "128", "ArrowUp retains a source-image pixel value beyond the former diagonal cap");
  const pageDown = arrowEvent("PageDown"); context.handleCandidatePaddingKeydown(pageDown); assert.deepEqual([pageDown.prevented, pageDown.stopped], [false, false], "unrelated numeric-field keys retain their native behavior");
  assert.equal(candidateCalls.length, callsBeforeInvalidPadding, "repeated padding keys remain draft-only");
  paddingInput.value = "128";
  assert.equal(await test.commitCandidatePadding(), false);
  assert.equal(candidateCalls.length, callsBeforeInvalidPadding, "a closed padding session cannot commit a stale edit");
  assert.equal(paddingInput.attributes.get("aria-invalid"), "false", "a valid unbounded padding value remains accessible");
  test.openCandidatePadding("apply", paddingButton);
  paddingInput.value = "3";
  context.api = async (path, options) => { candidateCalls.push({ path, body: JSON.parse(options.body) }); return { candidateRevision: 11 }; };
  assert.equal(await test.commitCandidatePadding(), false, "a candidate edit remains guarded until its prior mutation settles");
  assert.equal(candidateCalls.length, callsBeforeInvalidPadding + 1, "the candidate edit submits its requested padding once before reconciliation");

  const manualRows = [
    lastRow("candidate-row candidate-row-manual candidate-row-manual-apply"),
    lastRow("candidate-row candidate-row-manual candidate-row-manual-exclude"),
    lastRow("candidate-row candidate-row-manual candidate-row-manual-exclude-erase"),
  ];
  assert.deepEqual(manualRows.map((row) => row.children[0].children[0].textContent), ["candidates.manual", "candidates.manual", "candidates.manual"], "every manual candidate row has the same role-neutral visible label");

  resetCandidateState();
  state.manualMaskPresent = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  state.candidates = candidateLabelFixtures.map((candidate, index) => ({ id: `metadata-${index}`, enabled: true, forced: candidate.role === "exclude", confidence: .9, color: "#fff", ...candidate }));
  test.renderCandidateRows();
  const metadataRows = [...elements.values()]
    .filter((node) => node.className === "candidate-row candidate-row-apply" || node.className === "candidate-row candidate-row-exclude")
    .slice(-candidateLabelFixtures.length);
  assert.equal(metadataRows.length, candidateLabelFixtures.length, "every supported candidate token renders a candidate row");
  for (const [index, row] of metadataRows.entries()) {
    const candidate = candidateLabelFixtures[index];
    const visibleLabel = row.children[0].children[0].children[0].textContent;
    const actionNames = row.children[1].children
      .filter((node) => node.className === "candidate-toggle" || node.className === "candidate-delete")
      .map((node) => node.attributes.get("aria-label"));
    assert.equal(visibleLabel, `candidateLabel.${candidate.labelToken}`, "the candidate row displays its localized class token");
    assert.deepEqual(actionNames, [
      `candidates.toggle:candidateLabel.${candidate.labelToken}`,
      `candidates.delete:candidateLabel.${candidate.labelToken}`,
    ], "candidate action names use the same localized class token");
  }

  resetCandidateState();
  let staleRefreshes = 0;
  context.refreshCandidateRecord = async () => { staleRefreshes += 1; };
  context.api = async () => { state.currentId = "other"; return { candidateRevision: 10 }; };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(staleRefreshes, 1, "a completed mutation for an image left behind refreshes only its catalog record");

  resetCandidateState();
  let rollback = null;
  context.syncCandidateRecord = (imageId, candidates) => { rollback = { imageId, enabled: candidates[0].enabled }; };
  context.api = async () => { throw new Error("candidate unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, false);
  assert.deepEqual(rollback, { imageId: "image", enabled: true }, "a rejected mutation restores the optimistic candidate state");
  assert.equal(state.maskStatus.get("image"), false, "a rejected mutation restores the prior mask aggregate");

  resetCandidateState();
  context.confirmationRequired = (key) => key === "candidateDelete";
  await test.deleteCandidate(state.candidates[0]);
  assert.equal(state.removedCandidateIds.has("apply"), true, "a confirmed candidate removal is stored in undo history");
  await test.deleteManualMask(); await test.deleteManualExclusion(); await test.deleteManualExclusionErase();
  assert.deepEqual([state.manualMaskPresent, addCtx.pixels, exclusionCtx.pixels, exclusionEraseCtx.pixels], [false, false, false, false], "manual add and exclusion layers are cleared independently");

  resetCandidateState();
  const batchCalls = [];
  context.api = async (path, options) => {
    batchCalls.push({ path, body: JSON.parse(options.body) });
    return { candidateRevision: 11 };
  };
  await test.batchCandidateOperation("apply:toggle");
  await test.batchCandidateOperation("exclude:toggle");
  assert.deepEqual(batchCalls.map(({ path, body }) => ({ path, operation: body.operation })), [
    { path: "/api/candidates/batch", operation: "disable" },
    { path: "/api/candidates/batch", operation: "disable" },
  ], "batch toggles derive a disable operation only when every affected layer is enabled");
  assert.deepEqual([state.candidates[0].enabled, state.candidates[1].enabled, state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false, false, false], "batch toggles keep automatic and manual layers in sync");

  resetCandidateState();
  context.confirmationRequired = (key) => key === "candidateRoleDelete";
  test.resetHistoryToCurrentManualMask();
  test.setCandidateDisplayMode(["exclude"], "normal");
  await test.batchCandidateOperation("exclude:delete");
  assert.equal(state.removedCandidateIds.has("exclude"), true, "a confirmed role deletion is local and undoable");
  assert.deepEqual(
    [state.manualExclusionPresent, state.manualExclusionErasePresent, exclusionCtx.pixels, exclusionEraseCtx.pixels],
    [false, false, false, false],
    "exclude role deletion clears its detected, manual exclusion, and exclusion-erase rows together",
  );
  assert.equal(state.history.at(-1).kind, "clearCandidateRole", "one role deletion creates one undo operation");
  assert.deepEqual([...state.blinkCandidateIds], [], "role deletion clears display selections for its removed candidates");
  assert.deepEqual([...state.blinkModes], [], "role deletion clears display modes for its removed candidates");
  assert.equal(state.blinkTimer, null, "role deletion stops a now-empty display timer");
  test.rebuildManualMaskFromHistory(0);
  assert.deepEqual(
    [state.removedCandidateIds.has("exclude"), state.manualExclusionPresent, state.manualExclusionErasePresent],
    [false, true, true],
    "undo restores every exclusion row removed by the batch action",
  );
  test.rebuildManualMaskFromHistory(1);
  assert.deepEqual(
    [state.removedCandidateIds.has("exclude"), state.manualExclusionPresent, state.manualExclusionErasePresent],
    [true, false, false],
    "redo removes every exclusion row again",
  );

  resetCandidateState();
  test.resetHistoryToCurrentManualMask();
  await test.batchCandidateOperation("apply:delete");
  assert.deepEqual(
    [state.removedCandidateIds.has("apply"), state.manualMaskPresent, addCtx.pixels],
    [true, false, false],
    "apply role deletion clears both the detected candidate and manual mosaic",
  );
  resetCandidateState();
  context.api = async () => { throw new Error("batch unavailable"); };
  await test.batchCandidateOperation("apply:enable");
  assert.equal(state.candidateBatchPending.size, 0, "a failed batch mutation always clears its pending state");

  // A new manual exclusion-erase joins the range animation only when every
  // already-visible exclusion layer is in its ordinary display mode.  Check
  // before painting, because the new erase layer is not yet a member of that
  // set at stroke start.
  resetCandidateState(); state.tool = "exclude_eraser"; state.manualExclusionErasePresent = false; exclusionEraseCtx.pixels = false;
  test.toggleCandidateDisplay("exclude");
  test.beginManualStroke({ x: 5, y: 5 });
  assert.equal(test.candidateDisplayMode("manual:excludeErase"), "normal", "an exclusion erase joins when automatic and manual exclusions are normally displayed");

  resetCandidateState(); state.tool = "exclude_eraser"; state.manualExclusionErasePresent = false; exclusionEraseCtx.pixels = false;
  test.setCandidateDisplayMode(["exclude"], "normal");
  test.beginManualStroke({ x: 5, y: 5 });
  assert.equal(test.candidateDisplayMode("manual:excludeErase"), "off", "an exclusion erase does not join when an existing manual exclusion is hidden");

  resetCandidateState(); state.tool = "exclude_eraser"; state.candidates = []; state.manualExclusionErasePresent = false; exclusionEraseCtx.pixels = false;
  test.toggleCandidateDisplay("exclude");
  test.beginManualStroke({ x: 5, y: 5 });
  assert.equal(test.candidateDisplayMode("manual:excludeErase"), "normal", "an exclusion erase joins a normally displayed manual exclusion without automatic candidates");

  resetCandidateState(); state.tool = "exclude_eraser"; state.candidates = []; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  test.clearCandidateBlink();
  test.beginManualStroke({ x: 5, y: 5 });
  assert.equal(test.candidateDisplayMode("manual:excludeErase"), "off", "an exclusion erase does not start an animation when no existing exclusion layer is displayed");

  const freshManualPixels = pixelLayer(addCtx);
  resetCandidateState(); state.historyDurable = true; context.hasDurableHistory = () => state.historyDurable === true; state.tool = "brush"; state.manualMaskPresent = false; addCtx.pixels = false;
  test.toggleCandidateDisplay("apply"); test.beginManualStroke({ x: 5, y: 5 });
  assert.equal(test.candidateDisplayMode("manual:apply"), "normal", "a fresh manual mosaic inherits its role display before paint completes");
  test.cancelManualStroke();
  assert.equal(test.candidateDisplayMode("manual:apply"), "off", "cancelling a fresh manual mosaic clears its inherited display ID");
  assert.equal(state.blinkCandidateIds.has("manual:apply"), false, "a cancelled fresh manual mosaic does not leave a blink candidate");
  state.historyDurable = false; context.hasDurableHistory = () => false; freshManualPixels.restore();

  const existingManualPixels = pixelLayer(addCtx);
  resetCandidateState(); state.historyDurable = true; context.hasDurableHistory = () => state.historyDurable === true; state.tool = "brush"; existingManualPixels.set(3, 3);
  test.toggleCandidateEffective("apply"); test.beginManualStroke({ x: 5, y: 5 }); test.cancelManualStroke();
  assert.equal(test.candidateDisplayMode("manual:apply"), "effective", "cancelling on an existing manual mosaic preserves its role display mode");
  state.historyDurable = false; context.hasDurableHistory = () => false; existingManualPixels.restore();

  resetCandidateState();
  const boundaryBodies = [];
  state.boundaryDrafts = [
    { id: "polygon", type: "polygon", points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }] },
    { id: "point", type: "point", roi: { left: 2, top: 2, right: 6, bottom: 6 }, point: { x: 3, y: 3 } },
  ];
  context.boundaryRequests = () => [
    { draft: state.boundaryDrafts[0], draftIds: ["polygon"] },
    { draft: state.boundaryDrafts[1], draftIds: ["point"] },
  ];
  context.api = async (_path, options) => {
    boundaryBodies.push(JSON.parse(options.body));
    return boundaryBodies.length === 1 ? { candidates: [{ id: "polygon-result", enabled: true, role: "apply" }], candidateRevision: 12 } : { candidates: [], candidateRevision: 13 };
  };
  await test.addBoundaryCandidate();
  assert.deepEqual(boundaryBodies[0], { imageId: "image", points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }] }, "polygon boundary detection sends immutable point coordinates");
  assert.deepEqual(boundaryBodies[1], { imageId: "image", roi: { left: 2, top: 2, right: 6, bottom: 6 }, point: { x: 3, y: 3 } }, "point boundary detection sends its explicit prompt");
  assert.equal(state.boundaryDrafts.length, 1, "an invalid boundary response keeps only the failed draft for retry");

  resetCandidateState();
  state.currentImage = null; test.resetHistoryToCurrentManualMask();
  assert.equal(state.history.length, 0, "history reset is a no-op without an active image");
  state.currentImage = { width: 100, height: 80 }; test.resetHistoryToCurrentManualMask();
  test.replayManualStroke({ kind: "restoreCandidates", ids: ["apply"] });
  test.replayManualStroke({ kind: "addCandidates", ids: ["exclude"] });
  test.replayManualStroke({ kind: "clearManual", role: "excludeErase" });
  test.replayManualStroke({ tool: "brush", size: 3, points: [] });
  for (const operation of [
    { kind: "removeCandidates", ids: ["apply"] },
    { kind: "restoreCandidates", ids: ["apply"] },
    { kind: "addCandidates", ids: ["new"] },
  ]) {
    for (let index = 0; index < 5; index += 1) test.recordHistoryOperation(operation);
  }
  assert.equal(state.history.length, 15, "durable project history keeps every operation");
  assert.equal(state.historyBaseDirty, true, "the initial base remains available for durable history");
  state.importing = true; test.restoreSnapshot(0); assert.equal(state.historyIndex, 15, "history restoration is blocked while importing");
  state.importing = false; test.rebuildManualMaskFromHistory(0); state.historyIndex = 0; assert.equal(state.historyIndex, 0, "history restoration rebuilds the active image state");

  // Exercise the actual controls rendered for manual and detected masks.  The
  // controls are deliberately tested through their click listeners because the
  // UI keeps its optimistic state locally before each persistence request.
  const resetLists = () => {
    element("#candidateList").children = [];
    element("#exclusionList").children = [];
  };
  const row = (list, className) => list.children.find((item) => item.className?.includes(className));
  const control = (candidateRow, className) => candidateRow.children.flatMap((item) => item.children || []).find((item) => item.className === className);
  const click = async (button) => button.listeners.get("click")();

  resetCandidateState(); resetLists();
  context.api = async () => ({ candidateRevision: 14 });
  test.renderCandidateRows();
  const applyList = element("#candidateList");
  const excludeList = element("#exclusionList");
  await click(control(row(applyList, "candidate-row-manual-apply"), "candidate-toggle"));
  assert.equal(state.manualEnabled, false, "manual apply can be disabled from its row");
  await click(control(row(excludeList, "candidate-row-manual-exclude"), "candidate-forced"));
  assert.equal(state.manualExclusionForced, true, "manual exclusion force can be toggled from its row");
  await click(control(row(excludeList, "candidate-row-manual-exclude-erase"), "candidate-toggle"));
  assert.equal(state.manualExclusionEraseEnabled, false, "manual exclusion erase can be disabled from its row");
  await click(control(row(applyList, "candidate-row-apply"), "candidate-toggle"));
  assert.equal(state.candidates[0].enabled, false, "detected apply candidates persist their local toggle");
  await click(control(row(excludeList, "candidate-row-exclude"), "candidate-forced"));
  assert.equal(state.candidates[1].forced, false, "detected exclusion candidates persist their force toggle");

  test.toggleCandidateDisplay("apply");
  assert.equal(test.candidateDisplayMode("apply"), "normal", "showing every apply mask uses normal display mode");
  test.toggleCandidateDisplay("apply");
  assert.equal(test.candidateDisplayMode("apply"), "off", "a second show action hides every apply mask");
  state.candidateUpdateVersions.set("image:apply", 1); state.candidateDeleting.add("image:apply"); state.candidateBatchPending.add("image");
  test.clearCandidateMutationState("image");
  assert.equal(state.candidateUpdateVersions.size, 0, "clearing an image removes its mutation versions");
  let releaseQueuedMutation;
  const queuedMutation = new Promise((resolve) => { releaseQueuedMutation = resolve; });
  const queued = test.enqueueCandidateMutation("image", async () => queuedMutation);
  const waitedForMutations = test.waitForCandidateMutations();
  let waitFinished = false;
  waitedForMutations.then(() => { waitFinished = true; });
  await Promise.resolve();
  assert.equal(waitFinished, false, "waiting remains pending while a candidate mutation is in flight");
  releaseQueuedMutation();
  await queued;
  await waitedForMutations;
  assert.equal(state.candidateUpdateChains.size, 0, "waiting for mutations leaves no outstanding image chain");

  // A response that has already been reconciled must keep the server result;
  // a failed reconciliation must still restore the locally visible candidate.
  resetCandidateState(); context.api = async () => { throw new Error("offline"); };
  context.reconcileCurrentCandidates = async () => true;
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, false, "a reconciled failed mutation keeps the reconciled candidate state");
  resetCandidateState(); context.reconcileCurrentCandidates = async () => { throw new Error("reconcile unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, true, "an unreconciled failed mutation restores the prior candidate state");

  // Batch operations must refresh only the catalogue record when navigation
  // moves to another image while the request is in flight.
  resetCandidateState(); let staleBatchRefreshes = 0;
  context.refreshCandidateRecord = async () => { staleBatchRefreshes += 1; };
  context.api = async () => { state.currentId = "other"; return { candidateRevision: 15 }; };
  await test.batchCandidateOperation("apply:enable");
  assert.equal(staleBatchRefreshes, 1, "a stale batch response refreshes its original image record");

  // Boundary post-processing errors are user-visible but always release the
  // pending state.  This is distinct from an individual request failure.
  resetCandidateState();
  state.boundaryDrafts = [{ id: "catch", type: "rectangle", roi: { left: 1, top: 1, right: 5, bottom: 5 } }];
  context.boundaryRequests = () => [{ draft: state.boundaryDrafts[0], draftIds: ["catch"] }];
  context.api = async () => ({ candidates: [{ id: "catch-result", enabled: true, role: "apply" }], candidateRevision: 16 });
  context.reconcileCurrentCandidates = async () => { throw new Error("post-process unavailable"); };
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryPending, false, "boundary failure after a response clears the pending state");

  // The bucket tool runs through the worker result path, which records an
  // undoable fill and schedules the same persistence path as a brush stroke.
  resetCandidateState(); state.currentImage = { width: 100, height: 80 }; state.manualExclusionForced = false;
  context.fillUiRefreshes.length = 0;
  test.fillAt({ x: -10, y: 400 }, "bucket");
  assert.equal(latestFillWorker.url, "/js/flood-fill-worker.js", "bucket fill uses the flood-fill worker");
  assert.deepEqual([latestFillWorker.payload.x, latestFillWorker.payload.y], [0, 79], "bucket fill clamps the requested pixel to image bounds");
  assert.deepEqual(context.fillUiRefreshes, ["candidates", "actions"], "starting a fill immediately locks every candidate and action control");
  latestFillWorker.onmessage({ data: { spans: [2, 3, 7] } });
  assert.equal(state.fillPending, false, "worker completion clears the pending fill flag");
  assert.equal(state.history.at(-1).tool, "bucket", "worker completion adds an undoable bucket operation");
  assert.deepEqual(context.fillUiRefreshes.slice(-2), ["candidates", "actions"], "fill completion immediately unlocks every candidate and action control");
  state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
  const emptyFillHistoryLength = state.history.length; context.fillUiRefreshes.length = 0;
  test.fillAt({ x: 4, y: 4 }, "bucket");
  latestFillWorker.onmessage({ data: { spans: [] } });
  assert.equal(state.fillPending, false, "an empty fill result clears its pending state");
  assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false], "an empty fill result does not enable a manual layer");
  assert.equal(state.history.length, emptyFillHistoryLength, "an empty fill result does not create history");
  assert.deepEqual(context.fillUiRefreshes, ["candidates", "actions", "candidates", "actions"], "an empty fill result only refreshes controls when it starts and settles");
  context.fillUiRefreshes.length = 0;
  test.fillAt({ x: 4, y: 4 }, "bucket");
  latestFillWorker.onerror();
  assert.equal(state.fillPending, false, "worker errors clear the pending fill flag without retaining a worker");
  assert.equal(state.manualEnabled, false, "a failed bucket fill does not change its manual layer state before any worker result");
  assert.deepEqual(context.fillUiRefreshes, ["candidates", "actions", "candidates", "actions"], "fill errors refresh controls when they lock and unlock");

  state.activeStroke = { tool: "brush", points: [{ x: 1, y: 1 }] };
  test.cancelManualStroke();
  assert.equal(state.activeStroke, null, "cancelling an in-progress stroke restores the history-backed mask");

  // Project history intentionally does not rebuild local canvases.  A
  // cancelled live stroke therefore restores only its modified regions, in
  // reverse order, and returns the layer switches to their pre-stroke state.
  const addPixels = pixelLayer(addCtx); const exclusionPixels = pixelLayer(exclusionCtx); const exclusionErasePixels = pixelLayer(exclusionEraseCtx);
  addPixels.set(4, 4); exclusionPixels.set(12, 12); exclusionErasePixels.set(20, 20);
  state.historyDurable = true; context.hasDurableHistory = () => state.historyDurable === true;
  state.tool = "brush"; state.manualEnabled = false; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
  state.draftDirty = false; state.draftLayerDirty = new Set(["exclusion"]); state.draftDirtyRois = new Map([["exclusion", { left: 8, top: 8, right: 16, bottom: 16 }]]);
  test.beginManualStroke({ x: 20, y: 20 });
  test.appendManualStrokePoint({ x: 40, y: 40 });
  test.appendManualStrokePoint({ x: 60, y: 20 });
  test.appendManualStrokePoint({ x: 20, y: 20 });
  assert.equal(addPixels.has(40, 40), true, "the live durable curved stroke draws its intermediate pixel before cancellation");
  assert.equal(state.activeStroke.rollback.get(addCtx).size, 1, "returning through an already-captured rollback tile does not duplicate its snapshot");
  test.cancelManualStroke();
  assert.deepEqual([addPixels.has(4, 4), addPixels.has(20, 20), addPixels.has(40, 40), addPixels.has(60, 20), exclusionPixels.has(12, 12), exclusionErasePixels.has(20, 20)], [true, false, false, false, true, true], "durable cancellation preserves all three existing mask layers while removing the full curved live stroke");
  assert.equal(state.manualEnabled, false, "durable cancellation restores an initially disabled manual layer");
  assert.equal(state.draftDirty, false, "durable cancellation restores the draft dirty flag");
  assert.deepEqual([...state.draftLayerDirty], ["exclusion"], "durable cancellation restores the draft layer set");
  assert.deepEqual([...state.draftDirtyRois], [["exclusion", { left: 8, top: 8, right: 16, bottom: 16 }]], "durable cancellation restores the draft ROI map");
  state.historyDurable = false; context.hasDurableHistory = () => false;
  addPixels.restore(); exclusionPixels.restore(); exclusionErasePixels.restore();

  const localAddPixels = pixelLayer(addCtx); const localHistoryAddPixels = pixelLayer(historyAddCtx);
  context.historyAddCanvas.__pixelLayer = localHistoryAddPixels;
  state.history = []; state.historyIndex = 0; state.manualEnabled = true; state.manualExclusionForced = true;
  localAddPixels.set(4, 4); test.resetHistoryToCurrentManualMask();
  state.tool = "brush"; test.beginManualStroke({ x: 40, y: 40 });
  test.cancelManualStroke();
  assert.deepEqual([localAddPixels.has(4, 4), localAddPixels.has(40, 40)], [true, false], "local-history cancellation rebuilds the saved A pixel and removes the live B pixel");
  localAddPixels.restore(); localHistoryAddPixels.restore(); delete context.historyAddCanvas.__pixelLayer;

  test.cancelBoundary();
  assert.ok(events.includes("boundary-clear"), "cancelling boundary editing clears the active boundary interaction");
  state.boundaryDrafts = [];
  assert.equal(test.completedPolygonVertexAt({ x: 1, y: 1 }), null, "a point outside completed polygons has no editable vertex");

  // The empty-state rows are meaningful UI states, not just rendering fallbacks.
  resetLists(); state.candidates = []; state.manualMaskPresent = false; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  test.renderCandidateRows();
  assert.equal(element("#candidateList").children[0].textContent, "candidates.none", "an empty apply list explains that no masks are available");
  resetLists(); state.manualMaskPresent = true;
  test.renderCandidateRows();
  assert.equal(element("#exclusionList").children[0].textContent, "candidates.none", "an empty exclusion list remains explicit when only apply masks exist");

  // Geometry helpers back the same pointer paths used by the single and
  // compare canvases.  Keep their coordinate and hit-testing limits explicit.
  assert.equal(test.escapeHtml(`<mask&\"'>`), "&lt;mask&amp;&quot;&#39;&gt;");
  state.currentImage = null;
  assert.deepEqual({ ...test.clampPoint({ x: -3, y: 99 }) }, { x: -3, y: 99 }, "an unloaded editor does not invent image limits");
  state.currentImage = { width: 100, height: 80 }; state.view = { x: 4, y: 6, scale: 2 };
  assert.deepEqual({ ...test.clampPoint({ x: -3, y: 99 }) }, { x: 0, y: 80 }, "manual points clamp to the loaded image");
  assert.deepEqual({ ...test.pointFromEvent({ clientX: 124, clientY: 46 }) }, { x: 10, y: 20 }, "compare-side pointer coordinates account for the selected pane offset");
  state.boundaryStartClient = { x: 10, y: 10 };
  assert.equal(test.boundaryDragStarted({ clientX: 12, clientY: 12 }), false, "short boundary motions stay clicks");
  assert.equal(test.boundaryDragStarted({ clientX: 14, clientY: 10 }), true, "boundary drags start after the movement threshold");
  state.boundaryStartClient = null;
  assert.equal(test.boundaryDragStarted({ clientX: 20, clientY: 20 }), false, "a boundary drag needs a start point");
  state.polygonPoints = [{ x: 10, y: 10 }]; state.view.scale = 1;
  assert.equal(test.polygonVertexAt({ x: 18, y: 10 }), 0, "an in-progress polygon vertex remains editable within its screen radius");
  assert.equal(test.polygonVertexAt({ x: 30, y: 10 }), -1, "points outside the polygon handle radius are not selected");
  state.boundaryDrafts = [
    { id: "rect", type: "rectangle", roi: { left: 1, top: 2, right: 6, bottom: 7 } },
    { id: "poly", type: "polygon", points: [{ x: 20, y: 20 }] },
  ];
  assert.equal(test.rectangleDraftAt({ x: 3, y: 4 }).id, "rect", "completed rectangles are hit-tested in image coordinates");
  assert.equal(test.rectangleDraftAt({ x: 6, y: 7 }), null, "rectangle right and bottom edges stay exclusive");
  assert.equal(test.completedPolygonVertexAt({ x: 20, y: 20 }).draft.id, "poly", "completed polygon vertices are hit-tested from the topmost draft");

  // Direct per-row controls must provide both normal and effective display
  // modes, including the no-candidate state where a bulk toggle is inert.
  resetCandidateState();
  const display = test.candidateDisplayToggle("apply"); const effective = test.candidateEffectiveToggle("apply");
  display.listeners.get("click")(); assert.equal(test.candidateDisplayMode("apply"), "normal");
  display.listeners.get("click")(); assert.equal(test.candidateDisplayMode("apply"), "off");
  effective.listeners.get("click")(); assert.equal(test.candidateDisplayMode("apply"), "effective");
  effective.listeners.get("click")(); assert.equal(test.candidateDisplayMode("apply"), "off");
  test.syncCandidateDisplayButtons();
  assert.equal(displayIdButtons[0].attributes.get("aria-pressed"), "false", "per-mask normal display controls synchronize their pressed state");
  assert.equal(effectiveIdButtons[0].attributes.get("aria-pressed"), "false", "per-mask effective display controls synchronize their pressed state");
  assert.equal(test.candidateDisplayMode("absent"), "off", "unknown candidates are hidden by default");
  state.blinkCandidateIds.add("absent");
  assert.equal(test.candidateDisplayMode("absent"), "normal", "a selected candidate without an explicit mode is normally displayed");
  test.clearCandidateBlink();
  state.candidates = []; state.manualMaskPresent = false;
  test.toggleCandidateDisplay("apply"); test.toggleCandidateEffective("apply");
  assert.equal(state.blinkCandidateIds.size, 0, "empty candidate groups do not start a display timer");

  // Manual-layer enabling and stroke replay cover every editing mode.  These
  // are the operations invoked by canvas pointer gestures and history replay.
  resetCandidateState();
  state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
  test.enableManualLayerForTool("brush"); test.enableManualLayerForTool("eraser"); test.enableManualLayerForTool("exclude_eraser");
  assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [true, true, true], "each manual tool enables only its editable layer");
  state.manualExclusionForced = true;
  test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 2, y: 2 }, "mosaic_eraser", 3);
  test.paintStrokePath([{ x: 1, y: 1 }, { x: 2, y: 2 }], "mosaic_eraser", 3);
  test.paintStrokePath([{ x: 1, y: 1 }, { x: 2, y: 2 }], "exclude_eraser", 3);
  test.paintStrokePath([{ x: 1, y: 1 }, { x: 2, y: 2 }], "eraser", 3);
  test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [1, 1, 3], "bucket");
  assert.ok(addCtx.calls.includes("stroke:destination-out"), "mosaic erase uses the add-layer erase operation");
  assert.equal(test.historyWeight({ spans: new Uint8Array(16) }), 16, "history weight prefers compact fill span byte length");
  assert.equal(test.historyWeight({ points: [{}, {}] }), 32, "stroke history weight tracks its point list");

  // Busy and confirmation guards are separately observable from importing, so
  // no mask row can mutate during either blocked state.
  resetCandidateState(); state.manualExclusionForced = false; resetLists(); test.renderCandidateRows();
  context.isBusy = () => true;
  await click(control(row(element("#candidateList"), "candidate-row-manual-apply"), "candidate-toggle"));
  await click(control(row(element("#candidateList"), "candidate-row-apply"), "candidate-toggle"));
  await click(control(row(element("#exclusionList"), "candidate-row-manual-exclude"), "candidate-forced"));
  assert.deepEqual([state.manualEnabled, state.candidates[0].enabled, state.manualExclusionForced], [true, true, false], "busy editor rows reject manual and detected updates");
  context.isBusy = () => false;
  context.confirmationRequired = (key) => key === "candidateDelete" || key === "candidateRoleDelete";
  context.confirmAction = async () => false;
  await test.deleteCandidate(state.candidates[0]);
  await test.batchCandidateOperation("apply:delete");
  assert.equal(state.removedCandidateIds.size, 0, "declined confirmations preserve candidate rows");
  context.confirmationRequired = () => false; context.confirmAction = async () => true;

  resetCandidateState(); state.currentId = null;
  await test.batchCandidateOperation("apply:toggle");
  await test.deleteCandidate({ id: "apply" });
  assert.equal(state.candidateBatchPending.size, 0, "batch and delete guards reject an empty current image");
  resetCandidateState(); state.candidates = []; state.manualMaskPresent = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  context.api = async () => ({ candidateRevision: 17 });
  await test.batchCandidateOperation("apply:toggle");
  assert.equal(state.candidateBatchPending.size, 0, "an empty role resolves its bulk toggle without a stuck pending state");

  resetCandidateState(); context.canDetectBoundary = () => false;
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryPending, false, "boundary detection is inert while its model is unavailable");
  context.canDetectBoundary = () => true;

  // Mutation responses must ignore superseded versions and preserve the local
  // rollback if a stale catalogue refresh cannot be fetched.
  resetCandidateState();
  context.api = async () => { state.candidateUpdateVersions.set("image:apply", 99); return { candidateRevision: 18 }; };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, false, "a superseded candidate response cannot overwrite a newer local edit");
  resetCandidateState();
  context.api = async () => { state.currentId = "other"; return { candidateRevision: 19 }; };
  context.refreshCandidateRecord = async () => { throw new Error("catalogue unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.currentId, "other", "stale response refresh failure remains isolated to the former image");
  resetCandidateState();
  context.api = async () => { state.candidateUpdateVersions.set("image:apply", 99); throw new Error("superseded failure"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, false, "a superseded failed response does not roll back a later edit");
  resetCandidateState();
  context.api = async () => { throw new Error("offline"); };
  context.reconcileCurrentCandidates = async () => false;
  context.refreshCandidateRecord = async () => { throw new Error("catalogue unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, true, "a failed local mutation rolls back even if catalogue refresh also fails");

  // Worker lifecycle: stale results, construction failure, and worker
  // replacement must leave the editor interactive without applying old masks.
  resetCandidateState(); state.currentImage = { width: 100, height: 80 };
  element("#bucketTolerance").value = "0";
  state.images = [{ id: "image", assetVersion: "a" }];
  state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
  const staleFillHistoryLength = state.history.length; context.fillUiRefreshes.length = 0;
  test.fillAt({ x: 4, y: 4 }, "exclude_bucket");
  const staleWorker = latestFillWorker; state.currentId = "other";
  staleWorker.onmessage({ data: { spans: [1, 1, 3] } });
  assert.equal(state.fillPending, false, "a fill result from another image is discarded");
  assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false], "a stale fill result leaves every manual layer flag unchanged");
  assert.equal(state.history.length, staleFillHistoryLength, "a stale fill result does not create a history operation");
  assert.deepEqual(context.fillUiRefreshes, ["candidates", "actions", "candidates", "actions"], "a stale fill result only refreshes controls when its pending state clears");
  resetCandidateState(); state.currentImage = { width: 100, height: 80 };
  const workerClass = context.Worker; context.Worker = function BrokenWorker() { throw new Error("worker unavailable"); };
  state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
  test.fillAt({ x: 4, y: 4 }, "bucket");
  assert.equal(state.fillPending, false, "a failed worker construction does not leave fill pending");
  assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false], "worker construction failure leaves all manual-layer flags unchanged");
  assert.deepEqual(context.fillUiRefreshes.slice(-4), ["candidates", "actions", "candidates", "actions"], "worker construction failure unlocks every control after its initial lock");
  context.Worker = workerClass;
  context.fillUiRefreshes.length = 0;
  context.Worker = class PostFailureWorker { postMessage() { throw new Error("post failed"); } terminate() { this.terminated = true; } };
  test.fillAt({ x: 4, y: 4 }, "bucket");
  assert.equal(state.fillPending, false, "a failed worker post does not leave fill pending");
  assert.deepEqual(context.fillUiRefreshes, ["candidates", "actions", "candidates", "actions"], "a failed worker post unlocks every control after its initial lock");
  context.Worker = workerClass;
  context.Worker = undefined;
  state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
  test.fillAt({ x: 4, y: 4 }, "bucket");
  assert.equal(state.fillPending, false, "an environment without workers reports the fill failure without changing mask state");
  assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false], "an unavailable worker leaves manual-layer flags unchanged");
  context.Worker = workerClass;
  state.fillWorker = { terminate: () => events.push("old-fill-terminated") };
  test.fillAt({ x: 4, y: 4 }, "bucket");
  const replacedWorker = latestFillWorker; state.fillWorker = {};
  replacedWorker.onmessage({ data: { spans: [1, 1, 3] } });
  assert.equal(state.fillPending, true, "a replaced worker result cannot complete the newer fill request");
  state.fillWorker = null; state.fillPending = false;

  // Empty/current-image guards are real UI states, especially while switching
  // files.  They must not mutate masks or history.
  resetCandidateState(); state.currentId = null;
  test.renderCandidateRows();
  assert.equal(element("#candidateList").textContent, "", "no current image clears candidate rows");
  state.currentId = "image"; state.manualMaskPresent = false; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false; addCtx.pixels = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  test.deleteManualMask(); test.deleteManualExclusion(); test.deleteManualExclusionErase();
  assert.equal(state.history.length, 0, "deleting absent manual masks is inert");

  // Exercise the remaining reverse states through the same row handlers and
  // history callbacks used by the editor, rather than altering production
  // control flow for coverage.
  resetCandidateState(); resetLists(); context.api = async () => ({ candidateRevision: 20 });
  test.renderCandidateRows();
  await click(control(row(element("#exclusionList"), "candidate-row-manual-exclude"), "candidate-toggle"));
  assert.equal(state.manualExclusionEnabled, false, "manual exclusion can be disabled from its own row");
  state.maskStatus.clear();
  await click(control(row(element("#candidateList"), "candidate-row-apply"), "candidate-toggle"));
  assert.equal(state.candidates[0].enabled, false, "detected masks derive their prior aggregate when no cache entry exists");

  state.candidates = [{ id: "a", role: "apply", enabled: true }, { id: "b", role: "apply", enabled: true }]; state.manualMaskPresent = false;
  displayButtons[0].dataset.candidateDisplayToggle = "apply"; effectiveButtons[0].dataset.candidateEffectiveToggle = "apply";
  test.setCandidateDisplayMode(["a"], "normal"); test.syncCandidateDisplayButtons();
  test.setCandidateDisplayMode(["a", "b"], "normal"); test.syncCandidateDisplayButtons();
  test.setCandidateDisplayMode(["a"], "effective"); test.syncCandidateDisplayButtons();
  test.setCandidateDisplayMode(["a", "b"], "effective"); test.syncCandidateDisplayButtons();
  assert.equal(displayButtons[0].attributes.get("aria-pressed"), "false", "range controls represent no normal display after an effective selection");

  resetCandidateState();
  context.confirmationRequired = (key) => key === "candidateRoleDelete";
  context.confirmAction = async () => { state.candidateBatchPending.add("image"); return true; };
  await test.batchCandidateOperation("apply:delete");
  assert.equal(state.removedCandidateIds.size, 1, "a confirmed batch deletion remains a local, undoable history operation");
  state.candidateBatchPending.clear(); context.confirmationRequired = () => false; context.confirmAction = async () => true;

  resetCandidateState();
  state.boundaryDrafts = [{ id: "bad-response", type: "rectangle", roi: { left: 1, top: 1, right: 5, bottom: 5 } }];
  context.boundaryRequests = () => [{ draft: state.boundaryDrafts[0], draftIds: ["bad-response"] }];
  context.api = async () => ({ candidates: { id: "not-an-array" }, candidateRevision: 21 });
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryDrafts.length, 1, "a malformed boundary candidate list remains available for retry");
  state.boundaryDrafts = [{ id: "only-rectangle", type: "rectangle", roi: { left: 1, top: 1, right: 5, bottom: 5 } }];
  assert.equal(test.completedPolygonVertexAt({ x: 2, y: 2 }), null, "non-polygon completed boundaries are skipped during vertex hit testing");

  resetCandidateState(); context.ensureHistoryCanvases = () => events.push("history-canvases");
  test.resetHistoryToCurrentManualMask();
  assert.ok(events.includes("history-canvases"), "history reset prepares backing canvases when the editor supplies that hook");
  state.removedCandidateIds = new Set();
  state.history = [
    { kind: "removeCandidates", ids: ["apply"] },
    { kind: "restoreCandidates", ids: ["apply"] },
    { kind: "addCandidates", ids: ["new"] },
    ...Array.from({ length: 12 }, () => ({ tool: "brush", size: 1, points: [{ x: 1, y: 1 }] })),
  ];
  state.historyRemovedCandidateIds = new Set(); state.historyCandidateIds = new Set(["apply", "exclude"]);
  test.trimHistory();
  assert.equal(state.history.length, 15, "durable project history does not discard older operations");
  state.historyRemovedCandidateIds = null; state.historyCandidateIds = null;
  test.rebuildManualMaskFromHistory();
  assert.ok(state.removedCandidateIds.has("apply"), "rebuild treats candidates missing from a history base as removed");
  state.activeStroke = { points: [], paintedPointCount: 0 }; test.completeManualStroke();
  assert.equal(state.activeStroke, null, "an incomplete stroke cannot enter undo history");
  test.appendManualStrokePoint({ x: 1, y: 1 }); test.cancelManualStroke();
  state.activeStroke = { tool: "brush", points: [{ x: 1, y: 1 }], paintedPointCount: 1 }; state.manualStrokePaintFrame = 1;
  test.appendManualStrokePoint({ x: 2, y: 2 }); test.cancelManualStroke();
  test.replayManualStroke({ kind: "clearManual", role: "apply" });
  test.replayManualStroke({ kind: "clearManual", role: "exclude" });
  state.currentImage = null;
  assert.equal(test.buildCombinedMask(), null, "combined mask export is unavailable without an image");

  const queuedFrames = []; const frame = context.requestAnimationFrame;
  context.requestAnimationFrame = (callback) => { queuedFrames.push(callback); return queuedFrames.length; };
  state.currentImage = { width: 100, height: 80 }; state.history = []; state.historyIndex = 0;
  test.restoreSnapshot(0); test.restoreSnapshot(0);
  for (const callback of queuedFrames.splice(0)) callback();
  context.requestAnimationFrame = frame;

  resetCandidateState(); state.tool = "brush"; test.setCandidateDisplayMode(["apply"], "normal");
  test.beginManualStroke({ x: 1, y: 1 }); test.cancelManualStroke();
  resetCandidateState(); state.tool = "eraser"; test.setCandidateDisplayMode(["exclude"], "normal");
  test.beginManualStroke({ x: 1, y: 1 }); test.cancelManualStroke();

  resetCandidateState();
  state.candidates[0].expandPx = 1; state.candidates[1].expandPx = 3;
  const batchTrigger = { disabled: false, isConnected: true, focus() { this.focused = true; }, getBoundingClientRect() { return { left: 10, right: 80, top: 10, bottom: 38 }; } };
  test.openBatchCandidatePadding("apply", batchTrigger);
  assert.equal(element("#candidatePaddingInput").value, "1", "a single-role batch seeds its common padding");
  const paddingBatchCalls = [];
  context.api = async (path, options) => { paddingBatchCalls.push({ path, payload: JSON.parse(options.body) }); return { candidateRevision: 22 }; };
  element("#candidatePaddingInput").value = "0";
  await test.commitCandidatePadding();
  assert.deepEqual(paddingBatchCalls, [{ path: "/api/candidates/batch", payload: { imageId: "image", role: "apply", operation: "set_padding", expandPx: 0 } }], "batch padding is one API mutation with the shared payload");
  assert.equal(state.candidates[1].expandPx, 3, "the other role remains unchanged by apply padding");
  state.candidates = [{ id: "one", role: "apply", enabled: true, expandPx: 1 }, { id: "two", role: "apply", enabled: true, expandPx: 2 }];
  test.openBatchCandidatePadding("apply", batchTrigger);
  assert.deepEqual([element("#candidatePaddingInput").value, element("#candidatePaddingInput").placeholder], ["", "candidates.paddingMixed"], "mixed candidate padding starts blank with an explicit placeholder");
  const callsBeforeInvalidBatch = paddingBatchCalls.length;
  element("#candidatePaddingInput").value = "-1";
  assert.equal(await test.commitCandidatePadding(), false, "invalid batch padding is rejected before the API");
  assert.equal(paddingBatchCalls.length, callsBeforeInvalidBatch, "invalid batch padding creates no request");
  element("#candidatePaddingInput").value = "0"; state.projectReadOnly = true;
  assert.equal(await test.commitCandidatePadding(), false, "readonly projects cannot batch-edit padding");
  assert.equal(paddingBatchCalls.length, callsBeforeInvalidBatch, "readonly batch padding creates no request");
  state.projectReadOnly = false;
  test.closeCandidatePadding(); state.candidates = [];
  test.openBatchCandidatePadding("apply", batchTrigger);
  assert.equal(element("#candidatePaddingPopover").popoverOpen, false, "an empty role cannot open a batch padding editor");

  // Project history is durable rather than the local canvas history.  Keep
  // its guards, changed-image reload, no-op result, and error cleanup covered
  // as separate UI contracts.
  const historyApiCalls = [];
  let historyFlushes = 0; let historySelects = 0; let historySnapshots = 0;
  state.currentId = "image"; state.currentImage = { width: 100, height: 80 };
  state.images = [{ id: "image", assetVersion: "a", candidateRevision: 4 }];
  state.project = { id: "project" }; state.projectReadOnly = false; state.projectHistoryBusy = false; state.importing = false;
  context.hasDurableHistory = () => true;
  context.waitForCandidateMutations = async () => {};
  context.reconcileCatalogSnapshot = () => false;
  context.loadReviewedPaths = () => {};
  state.projectHistory = new Map([["image", { canUndo: true, canRedo: true }]]); state.drafts = new Map([["image", { local: true }]]);
  context.flushWorkspaceDraft = async (imageId) => { historyFlushes += 1; assert.equal(imageId, "image", "history flushes the selected project image first"); };
  context.applyProjectSnapshot = () => { historySnapshots += 1; };
  context.selectImage = async (imageId, force, options) => { historySelects += 1; assert.deepEqual({ imageId, force, saveCurrentDraft: options.saveCurrentDraft }, { imageId: "image", force: true, saveCurrentDraft: false }, "changed project history reloads the selected image without resaving its draft"); };
  context.api = async (url, options = {}) => {
    historyApiCalls.push({ url, method: options.method || "GET" });
    if (url === "/api/project/history/image") return { canUndo: true, canRedo: true };
    if (url === "/api/project/history/image/undo") return { changedImageIds: ["image"], current: { candidateRevision: 9 }, canUndo: false, canRedo: true };
    if (url === "/api/images") return { images: [{ id: "image", candidateRevision: 9 }] };
    throw new Error(`unexpected history request: ${url}`);
  };
  await test.restoreProjectHistory("undo");
  assert.equal(historyFlushes, 1, "project history flushes its debounced draft before undo");
  assert.equal(historySnapshots, 1, "project history refreshes catalogue state after a change");
  assert.equal(historySelects, 1, "project history reloads the changed current image");
  assert.equal(state.images[0].candidateRevision, 9, "project history retains the server candidate revision");
  assert.equal(state.drafts.has("image"), false, "project history drops the invalidated local draft");
  assert.deepEqual({ ...state.projectHistory.get("image") }, { canUndo: false, canRedo: true }, "project history records the returned undo and redo availability");

  historyApiCalls.length = 0; historySnapshots = 0; historySelects = 0;
  state.projectHistory.set("image", { canUndo: false, canRedo: true });
  context.api = async (url, options = {}) => {
    historyApiCalls.push({ url, method: options.method || "GET" });
    if (url === "/api/project/history/image") return { canUndo: true, canRedo: true };
    if (url === "/api/project/history/image/redo") return { changedImageIds: [], canUndo: true, canRedo: false };
    if (url === "/api/images") return { images: [{ id: "image", candidateRevision: 9 }] };
    throw new Error(`unexpected history request: ${url}`);
  };
  await test.restoreProjectHistory("redo");
  assert.equal(historySnapshots, 1, "a no-op history response still refreshes shared project catalogue state");
  assert.equal(historySelects, 0, "a no-op history response does not reload the current canvas");
  assert.deepEqual({ ...state.projectHistory.get("image") }, { canUndo: true, canRedo: false }, "a no-op history response still updates button availability");

  const historyErrorsBefore = events.filter((event) => event.startsWith("error:")).length;
  state.projectHistory.set("image", { canUndo: true, canRedo: false });
  context.api = async () => { throw new Error("history offline"); };
  await test.restoreProjectHistory("undo");
  assert.equal(state.projectHistoryBusy, false, "a project history error always clears its busy flag");
  assert.equal(events.filter((event) => event.startsWith("error:")).length, historyErrorsBefore + 1, "a project history error is shown to the user");

  let guardedHistoryRequests = 0;
  context.api = async () => { guardedHistoryRequests += 1; return {}; };
  state.projectReadOnly = true; await test.restoreProjectHistory("undo");
  assert.equal(guardedHistoryRequests, 0, "readonly project history never starts a status request");
  state.projectReadOnly = false; state.importing = true; await test.restoreProjectHistory("undo");
  assert.equal(guardedHistoryRequests, 0, "importing never starts a history request");
  state.importing = false; context.isBusy = () => true; await test.restoreProjectHistory("undo");
  assert.equal(guardedHistoryRequests, 0, "a busy editor never starts a history request");
  context.isBusy = () => false; state.projectHistoryBusy = true; await test.restoreProjectHistory("undo");
  assert.equal(guardedHistoryRequests, 0, "a duplicate history operation never starts another request");
  state.projectHistoryBusy = false; state.projectHistory.set("image", { canUndo: false, canRedo: false });
  await test.restoreProjectHistory("undo"); await test.restoreProjectHistory("redo");
  assert.equal(guardedHistoryRequests, 0, "an idle cached empty history does not fetch, lock, or redraw");
  state.projectHistory.delete("image"); await test.restoreProjectHistory("undo");
  assert.equal(guardedHistoryRequests, 0, "an unknown history state waits for its normal status refresh instead of treating a shortcut as a mutation");
  assert.equal(state.projectHistoryBusy, false, "rejected history requests never leave the editor busy");

  // Responses from repeated refreshes can arrive out of order.  The latest
  // request owns the visible Undo/Redo availability for that image.
  state.projectHistoryRefreshTokens = new Map(); state.projectHistory = new Map();
  const deferredHistory = [];
  context.api = () => new Promise((resolve) => deferredHistory.push(resolve));
  const olderHistory = test.refreshProjectHistory("image");
  const newerHistory = test.refreshProjectHistory("image");
  deferredHistory[1]({ canUndo: false, canRedo: true }); await newerHistory;
  deferredHistory[0]({ canUndo: true, canRedo: false }); await olderHistory;
  assert.deepEqual({ ...state.projectHistory.get("image") }, { canUndo: false, canRedo: true }, "a late history response cannot overwrite the newer undo and redo state");

  state.project = null; state.projectHistory = new Map();
});
