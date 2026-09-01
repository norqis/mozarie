const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function canvas(width = 100, height = 80) {
  const target = { width, height, alpha: 0, toBlob(done) { done({}); } };
  target.ctx = {
    calls: [], alpha: 0,
    clearRect(...args) { this.calls.push(["clear", ...args]); this.alpha = 0; },
    drawImage(image, ...args) { this.calls.push(["image", image, ...args]); if (image?.alpha || image?.ctx?.alpha) this.alpha = 255; },
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, this.alpha]) }; },
    save() { this.calls.push(["save"]); }, restore() { this.calls.push(["restore"]); },
    setTransform(...args) { this.calls.push(["transform", ...args]); }, translate(...args) { this.calls.push(["translate", ...args]); }, scale(...args) { this.calls.push(["scale", ...args]); },
    beginPath() { this.calls.push(["begin"]); }, moveTo(...args) { this.calls.push(["move", ...args]); }, lineTo(...args) { this.calls.push(["line", ...args]); },
    rect(...args) { this.calls.push(["rect", ...args]); }, closePath() { this.calls.push(["close"]); }, arc(...args) { this.calls.push(["arc", ...args]); },
    stroke() { this.calls.push(["stroke"]); }, fill() { this.calls.push(["fill"]); }, fillRect(...args) { this.calls.push(["fillRect", ...args]); }, clip() { this.calls.push(["clip"]); },
    setLineDash(args) { this.calls.push(["dash", ...args]); },
  };
  target.getContext = () => target.ctx;
  target.getBoundingClientRect = () => ({ left: 0, width: 120 });
  return target;
}

function cache(entries = []) {
  const items = new Map(entries.map(([key, value]) => [key, { value }]));
  return { items, has: (key) => items.has(key), get: (key) => items.get(key)?.value, set(key, value) { items.set(key, { value }); return value; }, take(key) { const entry = items.get(key); items.delete(key); return entry?.value; }, delete: (key) => items.delete(key), trim() {} };
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const attributes = new Map();
    elements.set(id, {
      value: "10", hidden: false, disabled: false, style: { setProperty() {} }, offsetWidth: 142, offsetHeight: 38,
      classList: { classes: new Set(), toggle(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); }, contains(name) { return this.classes.has(name); } }, setAttribute(name, value) { attributes.set(name, String(value)); }, getAttribute(name) { return attributes.get(name) || null; },
    });
  }
  return elements.get(id);
}

const displayCanvas = canvas();
const overlayCanvas = canvas();
const layerCanvas = canvas();
const state = {
  currentId: "image", currentImage: { width: 100, height: 80, alpha: 255 }, candidates: [], candidateImages: new Map(), removedCandidateIds: new Set(),
  maskStatus: new Map(),
  images: [{ id: "image", assetVersion: "v1", candidateRevision: 1, enabledCandidateCount: 0 }], imageGeneration: 0, candidateBatchPending: new Set(),
  imageCache: cache(), candidateBundleCache: cache(), imageInflight: new Map(), candidateInflight: new Map(), catalogLoadControllers: new Set(), catalogEpoch: 1,
  drafts: new Map(), draftLayerDirty: new Set(), draftSaveChains: new Map(), history: [], historyIndex: 0, historyBaseDirty: false, historyRemovedCandidateIds: new Set(), historyCandidateIds: new Set(),
  boundaryDrafts: [], boundaryActiveId: null, boundaryDragging: false, boundaryStart: null, boundaryPoint: null, boundaryRoi: null, boundaryPromptPoint: null,
  polygonPoints: [], boundaryBrushStroke: null, boundaryDraftSequence: 0, boundaryPending: false, pendingImageId: null, importing: false,
  view: { x: 5, y: 7, scale: 2 }, displayMode: "single", compareSplit: .5, hover: null, hoverDisplaySide: "left", gestureDisplaySide: null, boundaryDisplaySide: "left", tool: "brush", blinkCandidateIds: new Set(), blinkModes: new Map(), blinkPhase: false, mosaicPreviewEnabled: false,
  manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: true,
  settings: { display: { apply_color: "#f00", exclude_color: "#0ff", overlay_opacity: 0.5 } },
};
let focused = 0;
let lastWorker;
class Worker {
  constructor() { lastWorker = this; }
  postMessage() {}
  terminate() { this.terminated = true; }
}
const context = {
  codedError(code) { const error = new Error(); error.code = code; return error; },
  state, Math, Map, Set, Array, Object, Number, Boolean, Uint8Array, Uint8ClampedArray, AbortController,
  window: { devicePixelRatio: 1 }, document: { activeElement: null }, stage: { clientWidth: 120, clientHeight: 90, dataset: {} }, toolRail: { offsetHeight: 30 }, renderedWidth: 0, renderedHeight: 0,
  requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {}, Worker,
  canvas: displayCanvas, ctx: displayCanvas.ctx, layerCanvas, layerCtx: layerCanvas.ctx, boundaryOverlayCanvas: overlayCanvas, boundaryOverlayCtx: overlayCanvas.ctx,
  combinedCanvas: canvas(), addCanvas: canvas(), exclusionCanvas: canvas(), exclusionEraseCanvas: canvas(),
  $: (id) => element(id), t: (key) => key, isBusy: () => false, isGestureActive: () => false, focusCanvas: () => { focused += 1; }, updateActionButtons() {}, renderCatalogViews() {},
  currentRecord: () => state.images[0] || { enabledCandidateCount: 0 },
  imageUrl: (record) => `/image/${record.id}`, maskUrl: (imageId, candidateId) => `/mask/${imageId}/${candidateId}`,
  decodedImageWeight: () => 1, closeBitmap(image) { image?.close?.(); }, forgetThumbnail() {}, abortCatalogLoads() {}, releaseCandidateBitmapBundle() {}, catalogRecordMatches: () => true, isCurrentGeneration: () => true,
  clearTimeout() {}, showUserError(error) { context.lastUserError = error; }, queueWorkspaceDraft() {}, closeBoundaryModeMenu() {}, cancelFillWork() {}, clearBoundaryInteraction() {}, clearEditor() {}, updateGalleryCurrent() {}, renderCandidates() {}, updateNavigationControls() {}, updateBlockSizeDisplay() {}, clearStatus() {}, prefetchNeighbors() {}, resetHistoryToCurrentManualMask() {}, rebuildManualMaskFromHistory() {}, updateHistoryButtons() {}, calculatedBlockSize: () => 4, flushMaskComposition() {}, prepareOriginalImage() {},
  setCssTransform(target) { target.setTransform(1, 0, 0, 1, 0, 0); },
};
context.combinedCtx = context.combinedCanvas.getContext("2d");
context.addCtx = context.addCanvas.getContext("2d"); context.exclusionCtx = context.exclusionCanvas.getContext("2d"); context.exclusionEraseCtx = context.exclusionEraseCanvas.getContext("2d");
context.effectiveExclusionCanvas = canvas(); context.effectiveExclusionCtx = context.effectiveExclusionCanvas.getContext("2d");
context.originalCanvas = canvas(); context.originalCtx = context.originalCanvas.getContext("2d");
context.mosaicCanvas = canvas(); context.mosaicCtx = context.mosaicCanvas.getContext("2d");
context.historyAddCanvas = canvas(); context.historyExclusionCanvas = canvas(); context.historyExclusionEraseCanvas = canvas();

const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
const source = fs.readFileSync(canvasPath, "utf8");
vm.runInNewContext(source, context, { filename: canvasPath });
vm.runInNewContext("globalThis.geometryRuntime = { selectImage, loadImage, imageAssetVersion, invalidateStaleAsset, imageCacheKey, candidateCacheKey, cachedImage, prefetchNeighbors, releaseImageCaches, releaseStaleImageVersions, releaseCandidateBundles, releaseCandidateBitmap, invalidateCandidateBundles, retainCurrentCandidateBundle, loadCandidateBundle, reconcileCurrentCandidates, syncCandidateRecord, syncCurrentCandidateRecord, canvasToDataUrl, saveDraft, restoreDraft, resizeRenderCanvas, setCssTransform, releaseMosaicPreview, prepareOriginalImage, mosaicPreviewFailed, createMosaicWorker, ensureMosaicPreviewSource, rebuildMosaicPreview, requestMosaicPreview, composeEnabledExclusionMask, drawEffectiveExclusions, composeCurrentMask, markDraftDirty, markMaskDirty, flushMaskComposition, hasEffectiveMask, maskStatusWithoutCandidate, compareSplitX, comparePaneBounds, compareSideOffset, compareEventSide, compareEventOffset, updateCompareSplitter, setDisplayMode, fitImage, updateBrushCursor, roiFromPoints, boundaryDraftRoi, boundaryDraftId, pointForRoi, polygonRoi, boundaryDraftBounds, addBoundaryDraft, activeBoundaryShape, boundaryShapes, strokeRoi, appendBoundaryBrushPoint, beginBoundaryBrushStroke, completeBoundaryBrushStroke, rectsTouch, joinRois, boundaryRequests, boundaryPath, drawBoundaryScrim, drawBoundaryShape, drawBoundaryRoi, polygonArea, polygonSegmentsIntersect, polygonPointsValid, polygonIsValid, canDetectBoundary, hasBoundaryDraft, boundaryActionAnchor, updateBoundaryActions, drawCandidateBlinkOverlay, drawCompareRangeOverlay, refreshMaskStatus, renderNow, render, flushRender };", context, { filename: "test-editor-canvas-geometry-exports.js" });
const test = context.geometryRuntime;

function rectangle(left, top, right, bottom) { return { type: "rectangle", roi: { left, top, right, bottom } }; }

test.setDisplayMode("compare");
assert.equal(state.displayMode, "compare", "compare mode is an in-memory editor display choice");
assert.equal(element("#singleViewButton").getAttribute("aria-pressed"), "false");
assert.equal(element("#compareViewButton").getAttribute("aria-pressed"), "true");
assert.equal(test.compareEventOffset({ clientX: 20 }, { left: 0, width: 120 }), 0, "the left compare pane uses the shared image origin");
assert.equal(test.compareEventOffset({ clientX: 100 }, { left: 0, width: 120 }), 60, "the right compare pane uses its own screen offset with the shared image origin");
state.compareSplit = .3;
assert.equal(test.compareSplitX(120), 36, "compare split uses the persisted viewport ratio");
assert.deepEqual(JSON.parse(JSON.stringify(test.comparePaneBounds(120))), [{ offset: 0, width: 36 }, { offset: 36, width: 84 }], "compare panes use one shared split boundary");
assert.equal(test.compareEventOffset({ clientX: 40 }, { left: 0, width: 120 }), 36, "the right pane event origin follows the chosen split");
assert.equal(test.compareEventSide({ clientX: 40 }, { left: 0, width: 120 }), "right", "the event remembers which compare pane was edited");
assert.equal(test.compareSideOffset("right", 120), 36, "a right-side editor coordinate resolves from the current split");
state.compareSplit = .7;
assert.equal(test.compareSideOffset("right", 120), 84, "the stored right side follows a moved split without retaining the old pixel offset");
state.compareSplit = .5;
state.blinkCandidateIds.clear(); state.mosaicPreviewEnabled = false; test.renderNow();
assert.ok(displayCanvas.ctx.calls.some(([name]) => name === "fillRect"), "compare mode paints the right confirmation pane background without a second render canvas");
state.mosaicPreviewEnabled = true; test.renderNow();
test.setDisplayMode("single");
assert.equal(state.displayMode, "single");
assert.equal(element("#singleViewButton").getAttribute("aria-pressed"), "true");
assert.equal(element("#compareViewButton").getAttribute("aria-pressed"), "false");
state.mosaicPreviewEnabled = true; test.renderNow();
state.view = { x: 5, y: 7, scale: 2 };

// The tools users can actually manipulate all produce image-space geometry.
assert.equal(test.roiFromPoints({ x: 1.2, y: 3.4 }, { x: 1.9, y: 4.1 }), null, "a sub-two-pixel drag does not create a detector ROI");
assert.deepEqual(JSON.parse(JSON.stringify(test.roiFromPoints({ x: 9.8, y: 6.1 }, { x: 2.2, y: 12.9 }))), { left: 2, top: 6, right: 10, bottom: 13 });
assert.equal(test.polygonRoi([]), null);
assert.deepEqual(JSON.parse(JSON.stringify(test.polygonRoi([{ x: 8.2, y: 9.1 }, { x: 2.1, y: 4.9 }]))), { left: 2, right: 9, top: 4, bottom: 10 });
assert.deepEqual(JSON.parse(JSON.stringify(test.pointForRoi({ left: 2, top: 4, right: 9, bottom: 10 }))), { x: 6, y: 7 });
assert.equal(test.boundaryDraftBounds(null), null);

state.boundaryDragging = true; state.boundaryStart = { x: 10, y: 10 }; state.boundaryPoint = { x: 30, y: 24 };
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryDraftRoi())), { left: 10, top: 10, right: 30, bottom: 24 });
state.boundaryDragging = false; state.boundaryRoi = { left: 1, top: 2, right: 8, bottom: 9 };
assert.equal(test.boundaryDraftRoi().left, 1, "stored rectangle drafts are available after a pointer release");
state.boundaryRoi = null;

const validPolygon = [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 12 }, { x: 2, y: 12 }];
assert.equal(test.polygonArea(validPolygon), 100);
assert.equal(test.polygonSegmentsIntersect(validPolygon[0], validPolygon[1], validPolygon[2], validPolygon[3]), false);
assert.equal(test.polygonPointsValid(validPolygon), true);
assert.equal(test.polygonPointsValid([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]), false, "detectors reject tiny polygons");
assert.equal(test.polygonPointsValid([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]), false, "self-crossing polygons are not sent to the detector");
state.polygonPoints = validPolygon; assert.equal(test.polygonIsValid(), true);

const first = test.addBoundaryDraft(rectangle(2, 2, 12, 12));
assert.equal(first.id, "boundary-1"); assert.equal(state.boundaryActiveId, first.id);
assert.equal(test.activeBoundaryShape().type, "polygon", "in-progress polygon takes precedence over saved shapes");
state.polygonPoints = [];
assert.equal(test.activeBoundaryShape(), null);
assert.equal(test.hasBoundaryDraft(), true);
assert.equal(test.boundaryShapes().length, 1);
state.boundaryBrushStroke = { type: "brush", points: [{ x: 1, y: 1 }], radius: 4, roi: { left: 0, top: 0, right: 4, bottom: 4 } };
assert.equal(test.activeBoundaryShape().type, "brush", "an in-progress brush has a live preview shape");
state.boundaryBrushStroke = null;

assert.equal(test.strokeRoi([], 10), null);
assert.deepEqual(JSON.parse(JSON.stringify(test.strokeRoi([{ x: -5, y: 2 }, { x: 104, y: 90 }], 10))), { left: 0, top: 0, right: 100, bottom: 80 }, "brush ROI is clamped to the image");
test.beginBoundaryBrushStroke({ x: 30, y: 30 });
test.appendBoundaryBrushPoint({ x: 30.2, y: 30.2 });
assert.equal(state.boundaryBrushStroke.points.length, 1, "near-identical brush samples are coalesced");
test.appendBoundaryBrushPoint({ x: 33, y: 32 });
assert.equal(state.boundaryBrushStroke.points.length, 2);
test.completeBoundaryBrushStroke();
assert.equal(state.boundaryBrushStroke, null); assert.equal(state.boundaryDrafts.at(-1).type, "brush");
test.appendBoundaryBrushPoint({ x: 1, y: 1 });
test.completeBoundaryBrushStroke();

assert.equal(test.rectsTouch({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 6, top: 0, right: 8, bottom: 4 }), false);
assert.equal(test.rectsTouch({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 5, top: 5, right: 8, bottom: 8 }), true);
assert.deepEqual(JSON.parse(JSON.stringify(test.joinRois([{ left: 2, top: 3, right: 4, bottom: 5 }, { left: 1, top: 4, right: 8, bottom: 9 }]))), { left: 1, right: 8, top: 3, bottom: 9 });

state.boundaryDrafts = [
  { id: "rect", ...rectangle(2, 2, 12, 12) },
  { id: "invalid", type: "polygon", points: [{ x: 1, y: 1 }] },
  { id: "brush-one", type: "brush", roi: { left: 20, top: 20, right: 30, bottom: 30 }, points: [{ x: 20, y: 20 }], radius: 6 },
  { id: "brush-two", type: "brush", roi: { left: 30, top: 25, right: 40, bottom: 35 }, points: [{ x: 40, y: 35 }], radius: 6 },
  { id: "empty-brush", type: "brush", roi: null, points: [], radius: 6 },
];
const requests = test.boundaryRequests();
assert.deepEqual(JSON.parse(JSON.stringify(requests.map((request) => request.draftIds))), [["rect"], ["brush-one", "brush-two"]], "touching brush drafts are combined into one detector request in drawing order");
state.boundaryDrafts = [
  { id: "left", type: "brush", roi: { left: 0, top: 0, right: 8, bottom: 8 }, points: [{ x: 1, y: 1 }], radius: 4 },
  { id: "right", type: "brush", roi: { left: 20, top: 0, right: 28, bottom: 8 }, points: [{ x: 25, y: 1 }], radius: 4 },
  { id: "bridge", type: "brush", roi: { left: 9, top: 0, right: 19, bottom: 8 }, points: [{ x: 14, y: 1 }], radius: 4 },
];
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryRequests()[0].draftIds)), ["left", "bridge", "right"], "a bridge stroke merges previously separate brush request groups");

const draw = displayCanvas.ctx;
test.boundaryPath({ type: "polygon", points: validPolygon }, draw);
test.boundaryPath({ type: "brush", points: [{ x: 4, y: 4 }], radius: 4 }, draw);
test.boundaryPath(rectangle(2, 2, 12, 12), draw);
assert.ok(draw.calls.some(([name]) => name === "close"));
assert.ok(draw.calls.some(([name]) => name === "rect"));
test.drawBoundaryScrim([rectangle(2, 2, 12, 12), { type: "brush", points: [{ x: 4, y: 4 }, { x: 8, y: 8 }], radius: 4 }]);
assert.ok(overlayCanvas.ctx.calls.some(([name]) => name === "clip"), "scrim restricts darkening to the image bounds");
test.drawBoundaryShape({ type: "polygon", points: validPolygon });
test.drawBoundaryShape({ type: "polygon", points: [{ x: 1, y: 1 }] });
test.drawBoundaryShape({ type: "brush", points: [{ x: 4, y: 4 }], radius: 4 });
assert.ok(draw.calls.some(([name]) => name === "arc"), "polygon handles are visible for correction");
test.drawBoundaryRoi();

state.boundaryDrafts = [{ id: "draft", ...rectangle(2, 2, 12, 12) }]; state.boundaryActiveId = "draft";
assert.equal(test.canDetectBoundary(), true);
state.boundaryPending = true; assert.equal(test.canDetectBoundary(), false); state.boundaryPending = false;
state.importing = true; assert.equal(test.canDetectBoundary(), false); state.importing = false;
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryActionAnchor())), { left: 9, right: 29, top: 11, bottom: 31 });
state.displayMode = "compare"; state.compareSplit = .3; state.boundaryDisplaySide = "right";
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryActionAnchor())), { left: 45, right: 65, top: 11, bottom: 31 }, "a right-side boundary anchor uses the live compare split");
state.compareSplit = .7;
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryActionAnchor())), { left: 93, right: 113, top: 11, bottom: 31 }, "moving the split relocates the right-side boundary anchor without stale pixels");
state.hover = { x: 3, y: 4 }; state.hoverDisplaySide = "right"; state.tool = "brush"; test.updateBrushCursor();
assert.match(element("#brushCursor").style.transform, /85px/, "a right-side brush cursor follows the moved split");
state.displayMode = "single";
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryActionAnchor())), { left: 9, right: 29, top: 11, bottom: 31 }, "single view resolves the same boundary without a compare offset");
test.updateBoundaryActions();
assert.equal(element("#boundaryActions").hidden, false);
assert.match(element("#boundaryActions").style.left, /px$/);
state.boundaryDrafts = []; state.boundaryActiveId = null; context.document.activeElement = element("#boundaryDetectButton");
test.updateBoundaryActions(); assert.equal(focused, 1, "closing the action menu returns keyboard focus to the canvas");

const cssProbe = { transforms: [], setTransform(...values) { this.transforms.push(values); } };
context.window.devicePixelRatio = 0; test.setCssTransform(cssProbe); context.window.devicePixelRatio = 1;
assert.equal(cssProbe.transforms[0][0], 1, "a missing device scale uses a normal CSS pixel transform");
state.boundaryDragging = true; state.boundaryStart = { x: 3, y: 3 }; state.boundaryPoint = { x: 12, y: 12 }; state.boundaryPromptPoint = { x: 7, y: 8 };
assert.deepEqual(JSON.parse(JSON.stringify(test.activeBoundaryShape().point)), { x: 7, y: 8 }, "a click prompt is retained when a rectangle is adjusted");
state.boundaryPromptPoint = null;
assert.deepEqual(JSON.parse(JSON.stringify(test.activeBoundaryShape().point)), { x: 8, y: 8 }, "a rectangle without a click prompt uses its ROI centre");
state.boundaryDragging = false;
const originalLookup = context.$;
context.$ = (id) => id === "#boundaryActions" ? null : originalLookup(id);
test.updateBoundaryActions();
context.$ = originalLookup;
state.boundaryDrafts = [{ id: "empty", type: "brush", roi: null, points: [], radius: 4 }]; state.boundaryActiveId = "empty";
test.updateBoundaryActions();
state.boundaryDrafts = [{ id: "edge", ...rectangle(2, 30, 12, 38) }]; state.boundaryActiveId = "edge";
element("#boundaryActions").offsetWidth = 0; element("#boundaryActions").offsetHeight = 0;
test.updateBoundaryActions();
element("#boundaryActions").offsetWidth = 142; element("#boundaryActions").offsetHeight = 38;

state.candidates = []; state.removedCandidateIds = new Set(); state.currentId = "image"; state.currentImage = { width: 100, height: 80, alpha: 255 };
context.combinedCanvas.ctx.alpha = 255; state.maskStatus.set("image", true);
assert.equal(test.refreshMaskStatus(false), false, "unchanged mask status updates controls without redrawing the catalogue");

state.hover = { x: 3, y: 4 }; state.tool = "mosaic_eraser"; test.updateBrushCursor();
assert.equal(element("#brushCursor").classList.contains("eraser"), true, "eraser cursors use a dashed ring");
state.tool = "brush"; test.updateBrushCursor();
assert.equal(element("#brushCursor").classList.contains("eraser"), false, "brush cursor restores a solid ring");
state.hover = null; test.updateBrushCursor();
assert.equal(element("#brushCursor").hidden, true, "clearing hover hides the cursor");

state.blinkCandidateIds = new Set(["manual:apply", "manual:exclude", "manual:excludeErase", "apply", "exclude"]);
state.blinkModes = new Map([["manual:apply", "effective"], ["apply", "effective"]]); state.blinkPhase = true;
state.candidates = [{ id: "apply", role: "apply", enabled: true }, { id: "exclude", role: "exclude", enabled: true }, { id: "removed", role: "apply" }, { id: "missing", role: "apply" }];
state.removedCandidateIds = new Set(["removed"]); state.candidateImages = new Map([["apply", { alpha: 255 }], ["exclude", { alpha: 255 }]]);
context.addCanvas.alpha = 255; context.exclusionCanvas.alpha = 255; context.exclusionEraseCanvas.alpha = 255;
const cachedExclusionCalls = context.effectiveExclusionCtx.calls.length;
state.displayMode = "compare";
test.drawCandidateBlinkOverlay();
assert.ok(layerCanvas.ctx.calls.some(([name]) => name === "fillRect"), "candidate blinking paints actual mask pixels through a viewport layer");
assert.equal(context.effectiveExclusionCtx.calls.length, cachedExclusionCalls, "effective exclusion cache is never rebuilt while blinking");
assert.ok(displayCanvas.ctx.calls.some(([name, left, top, width]) => name === "rect" && left === 0 && top === 0 && width === 60), "compare blink clips drawing to a single pane");
const overlayCalls = overlayCanvas.ctx.calls.length;
state.boundaryDrafts = [{ id: "pane-safe", ...rectangle(2, 2, 12, 12) }]; state.boundaryDragging = false;
test.drawBoundaryRoi();

// Exclusion erase has a separate effective display pass: it is limited to the
// already-excluded pixels and uses the apply colour because it restores mosaic.
state.displayMode = "single"; state.currentImage = { width: 100, height: 80, alpha: 255 };
state.blinkCandidateIds = new Set(["manual:excludeErase"]); state.blinkModes = new Map([["manual:excludeErase", "effective"]]);
state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
test.drawCandidateBlinkOverlay();
assert.ok(overlayCanvas.ctx.calls.some(([name]) => name === "image"), "effective exclusion erase first composes the existing exclusion mask");
state.manualExclusionEraseEnabled = false;
test.drawCandidateBlinkOverlay();
state.manualExclusionEraseEnabled = true;
assert.ok(overlayCanvas.ctx.calls.length > overlayCalls && overlayCanvas.ctx.calls.filter(([name]) => name === "clip").length >= 2, "boundary scrim is clipped independently in both compare panes");
test.renderNow();
test.render(); test.flushRender();

(async () => {
  // Cache and request helpers are exercised with their real cache ownership
  // rules.  These are the states reached while selecting, replacing, and
  // clearing editor images.
  assert.equal(test.imageAssetVersion({ assetVersion: "v2" }), "v2");
  assert.equal(test.imageAssetVersion({ assetVersion: 2 }), "");
  assert.equal(test.imageCacheKey({ id: "image", assetVersion: "v2" }), "image:v2");
  assert.equal(test.candidateCacheKey("image", 4), "image:4");
  const released = [];
  state.imageCache = cache([["image:v1", { close() { released.push("image"); } }], ["other:v1", { close() { released.push("other"); } }]]);
  state.candidateBundleCache = cache([["image:1", { candidateImages: new Map([["mask", { close() { released.push("mask"); } }]]) }], ["other:1", { candidateImages: new Map() }]]);
  state.imageInflight = new Map([["image:v1", Promise.resolve()], ["other:v1", Promise.resolve()]]);
  state.candidateInflight = new Map([["image:1", Promise.resolve()], ["other:1", Promise.resolve()]]);
  test.releaseImageCaches("image");
  assert.equal(state.imageCache.has("image:v1"), false);
  assert.equal(state.imageCache.has("other:v1"), true);
  assert.equal(state.imageInflight.has("image:v1"), false);
  assert.equal(state.candidateInflight.has("image:1"), false);
  test.releaseImageCaches();
  assert.equal(state.imageCache.items.size, 0);
  state.imageCache = cache([["image:old", { close() {} }], ["image:new", { close() {} }]]);
  state.candidateBundleCache = cache([["image:old", { candidateImages: new Map() }], ["image:new", { candidateImages: new Map() }]]);
  test.releaseStaleImageVersions("image", "image:new", "image:new");
  assert.equal(state.imageCache.has("image:old"), false);
  assert.equal(state.candidateBundleCache.has("image:old"), false);
  state.candidateInflight = new Map([["image:old", Promise.resolve()], ["other:old", Promise.resolve()]]);
  state.currentId = "image"; state.candidateImages = new Map([["shown", { alpha: 255 }]]);
  test.releaseCandidateBundles("image");
  assert.equal(state.candidateImages.size, 0);
  assert.equal(state.candidateInflight.has("image:old"), false);

  state.images = [{ id: "prefetch", assetVersion: "v1" }, { id: "selected", assetVersion: "v1" }, { id: "next", assetVersion: "v1" }];
  const prefetched = [];
  context.schedulePrefetch = (record, priority) => prefetched.push([record.id, priority]);
  test.prefetchNeighbors(state.images[1]);
  assert.deepEqual(prefetched, [["prefetch", 1], ["next", 1]]);
  state.imageCache = cache(); state.imageInflight = new Map(); state.catalogLoadControllers = new Set(); state.catalogEpoch = 1;
  context.fetchBitmap = async () => ({ width: 2, height: 2, close() { released.push("fetched"); } });
  context.imageUrl = (record) => `/images/${record.id}`;
  context.catalogRecordMatches = () => true;
  const fetched = await test.cachedImage(state.images[0]);
  assert.equal(fetched.width, 2);
  assert.equal(await test.cachedImage(state.images[0]), fetched, "decoded images are reused from the editor cache");

  // Candidate cache ownership is exercised with decoded images, rather than
  // calling cache helpers directly.
  state.images = [];
  test.syncCandidateRecord("missing", [{ id: "candidate", enabled: true, role: "apply" }]);
  assert.deepEqual(state.images, [], "a stale candidate response cannot create a catalogue record");

  let closed = 0;
  state.candidateImages = new Map([["visible", { close() { closed += 1; } }]]);
  test.releaseCandidateBitmap("visible");
  assert.equal(closed, 1); assert.equal(state.candidateImages.has("visible"), false);
  const staleMask = { close() { closed += 1; } };
  const activeMask = { close() { closed += 1; } };
  state.candidateImages = new Map([["active", activeMask]]);
  state.candidateBundleCache = cache([
    ["image:1", { candidateImages: state.candidateImages }],
    ["image:2", { candidateImages: new Map([["stale", staleMask]]) }],
  ]);
  test.invalidateCandidateBundles("image");
  assert.equal(state.candidateBundleCache.has("image:1"), true, "the currently displayed candidate bundle keeps ownership");
  assert.equal(state.candidateBundleCache.has("image:2"), false, "old candidate bundles are invalidated");
  state.images = [{ id: "image", candidateRevision: 1 }];
  state.candidates = [{ id: "active", enabled: true, role: "apply" }];
  test.retainCurrentCandidateBundle("image", 3);
  assert.equal(state.images[0].candidateRevision, 3); assert.equal(state.candidateBundleCache.has("image:3"), true, "current decoded candidate masks move to their new revision without closing");

  context.loadCandidateBundle = async () => ({ candidates: [{ id: "fresh", enabled: true, role: "apply" }], candidateImages: new Map([["fresh", { alpha: 255 }]]), candidateRevision: 4 });
  state.images = [{ id: "image", candidateRevision: 3, enabledCandidateCount: 0 }]; state.currentId = "image"; state.imageGeneration = 8;
  state.candidateBundleCache = cache(); state.draftLayerDirty = new Set(); state.maskDirty = false; state.removedCandidateIds = new Set();
  assert.equal(await test.reconcileCurrentCandidates("image", 8), true, "a current candidate response updates the editor and catalogue record together");
  assert.equal(state.images[0].candidateRevision, 4);

  state.images = [{ id: "retry", assetVersion: "v1", candidateRevision: 1 }]; state.candidateBundleCache = cache(); state.candidateInflight = new Map(); state.catalogLoadControllers = new Set();
  context.loadCandidateBundle = test.loadCandidateBundle;
  let candidateAttempts = 0;
  context.api = async () => {
    candidateAttempts += 1;
    if (candidateAttempts === 1) { const error = new Error("revision changed"); error.status = 404; throw error; }
    return { candidates: [], candidateRevision: 2 };
  };
  assert.equal((await test.loadCandidateBundle("retry", 8)).candidateRevision, 2, "a changed candidate revision retries once against the current server metadata");
  assert.equal(candidateAttempts, 2);

  // Selection guards leave state clean for absent records and real request
  // failures are surfaced to the user.
  state.images = []; state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
  await test.selectImage("absent", true, { saveCurrentDraft: false });
  assert.equal(state.pendingImageId, null);
  state.images = [{ id: "broken", assetVersion: "v1", candidateRevision: 1 }]; state.imageCache = cache(); state.candidateBundleCache = cache(); state.drafts = new Map();
  const loadError = new Error("image decode failed"); context.cachedImage = async () => { throw loadError; }; context.loadCandidateBundle = async () => ({ candidates: [], candidateImages: new Map(), candidateRevision: 1 });
  await test.selectImage("broken", true, { saveCurrentDraft: false });
  assert.equal(context.lastUserError, loadError, "image load failures reach the standard user error path");

  // A successful gallery selection changes the image, candidate bundle, and
  // editor dimensions together.  This remains distinct from the stale/error
  // paths above, so a rejected image never leaves partial UI state behind.
  const selectable = { id: "selected", assetVersion: "v3", candidateRevision: 2, relativePath: "folder/selected.png", width: 12, height: 9, enabledCandidateCount: 0 };
  state.images = [selectable]; state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.imageGeneration = 20;
  state.imageCache = cache(); state.candidateBundleCache = cache(); state.drafts = new Map(); state.mosaicPreviewEnabled = false;
  context.cachedImage = async () => ({ width: 12, height: 9, alpha: 255 });
  context.loadCandidateBundle = async () => ({ candidates: [{ id: "candidate", enabled: true, role: "apply" }], candidateImages: new Map([["candidate", { alpha: 255 }]]), candidateRevision: 3 });
  context.loadWorkspaceDraft = async () => null; context.decodeDraftImages = async () => [null, null, null, null, null, null];
  await test.selectImage("selected", true, { saveCurrentDraft: false });
  assert.equal(state.currentId, "selected");
  assert.equal(state.candidates[0].id, "candidate");
  test.syncCurrentCandidateRecord();
  assert.equal(selectable.candidateCount, 1);
  assert.equal(element("#currentFileName").textContent, "folder/selected.png");
  await test.selectImage("selected", false, { saveCurrentDraft: false });

  context.Image = class { set src(_source) { this.onerror(); } };
  await assert.rejects(test.loadImage("bad-image"), (error) => error?.code === "image_read_failed");
  context.FileReader = class { readAsDataURL() { this.error = new Error("encode failed"); this.onerror(); } };
  const encodeCanvas = canvas(); encodeCanvas.toBlob = (done) => done({});
  await assert.rejects(test.canvasToDataUrl(encodeCanvas), (error) => error?.code === "internal_error");

  state.currentId = "image"; state.currentImage = { width: 100, height: 80 }; state.draftDirty = true; state.draftLayerDirty = new Set(); state.historyBaseDirty = false;
  state.history = []; state.historyIndex = 0; state.historyRemovedCandidateIds = new Set(); state.historyCandidateIds = new Set(); state.removedCandidateIds = new Set();
  state.manualExclusionForced = false; state.settings.detection = { exclude_forced_default: false }; state.drafts = new Map([["image", { add: "" }]]); state.draftSaveChains = new Map();
  await test.saveDraft();
  assert.equal(state.drafts.has("image"), false, "an empty draft is removed instead of being persisted as an empty record");

  state.currentImage = { width: 4, height: 3 }; state.mosaicPreviewEnabled = true; state.mosaicWorker = null; state.mosaicWorkerBusy = false; state.mosaicPending = false; state.mosaicPreviewGeneration = 0;
  context.originalCanvas.width = context.combinedCanvas.width = 4; context.originalCanvas.height = context.combinedCanvas.height = 3;
  test.rebuildMosaicPreview();
  lastWorker.onerror();
  assert.equal(state.mosaicWorker, null, "a preview worker error releases the worker and canvas state");

  state.currentId = "image"; state.currentImage = { close() { closed += 1; } }; state.candidates = [{ id: "apply" }];
  state.candidateImages = new Map([["apply", { close() { closed += 1; } }]]); state.galleryNodes = new Map(); state.overviewNodes = new Map();
  state.imageCache = cache([["image:v1", { close() { closed += 1; } }]]);
  state.candidateBundleCache = cache([["image:4", { candidateImages: new Map([["mask", { close() { closed += 1; } }]]) }]]);
  test.invalidateStaleAsset("image");
  assert.equal(state.currentId, null, "a stale current asset clears the editor selection and decoded images");

  state.images = [{ id: "restore", candidateRevision: 2, enabledCandidateCount: 0 }]; state.currentId = "restore"; state.currentImage = { width: 10, height: 10 };
  state.imageGeneration = 12; state.candidates = [{ id: "new" }]; state.candidateImages = new Map(); state.removedCandidateIds = new Set();
  await test.restoreDraft("restore", 12, {
    candidateRevision: 1, history: [{ kind: "removeCandidates" }, { kind: "brush", points: [] }], historyIndex: 2,
    historyBase: { removedCandidateIds: ["old"], candidateIds: ["old"] }, removedCandidateIds: ["old"], manualMaskPresent: false,
  }, [null, null, null, null, null, null]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.history.map((stroke) => stroke.kind))), ["brush"], "a newer candidate revision removes only obsolete candidate-history operations");

  // A complete persisted edit restores all three layers and keeps the history
  // cursor usable for undo/redo.  The same helper also deliberately rejects a
  // result which finishes after the user selected a different image.
  state.images = [{ id: "restore", candidateRevision: 3, enabledCandidateCount: 0 }]; state.currentId = "restore"; state.imageGeneration = 13;
  state.currentImage = { width: 10, height: 10 }; state.candidates = [{ id: "still-here", enabled: true, role: "apply" }];
  const restoredLayers = [{ alpha: 255 }, { alpha: 255 }, { alpha: 255 }, { alpha: 255 }, { alpha: 255 }, { alpha: 255 }];
  const restored = await test.restoreDraft("restore", 13, {
    candidateRevision: 3, manualEnabled: false, manualExclusionEnabled: false, manualExclusionEraseEnabled: false, manualExclusionForced: false, manualMaskPresent: true,
    removedCandidateIds: ["still-here", "stale"], history: [{ kind: "removeCandidates", points: [{ x: 1, y: 2 }], spans: [1] }, { kind: "brush", points: [{ x: 2, y: 3 }] }], historyIndex: 1,
    historyBase: { removedCandidateIds: ["still-here", "stale"], candidateIds: ["still-here", "stale"] },
  }, restoredLayers);
  assert.equal(restored, true);
  assert.equal(state.history.length, 2);
  assert.equal(state.historyIndex, 1);
  assert.deepEqual([...state.removedCandidateIds], ["still-here"]);
  assert.equal(state.manualEnabled, false);
  state.currentId = "other";
  assert.equal(await test.restoreDraft("restore", 13, null, restoredLayers), false, "late draft decodes cannot overwrite a newly selected image");

  state.currentId = "restore"; state.currentImage = { width: 10, height: 10, alpha: 255 }; state.images = [{ id: "restore", candidateRevision: 3 }]; state.drafts = new Map(); state.draftSaveChains = new Map();
  context.FileReader = class { readAsDataURL() { this.result = "data:image/png;base64,AA=="; this.onload(); } };
  state.draftDirty = true; state.draftLayerDirty = new Set(["add", "exclusion", "exclusionErase", "unknown"]); state.historyBaseDirty = true;
  context.addCanvas.ctx.alpha = context.exclusionCanvas.ctx.alpha = context.exclusionEraseCanvas.ctx.alpha = 255;
  context.historyAddCanvas.ctx.alpha = context.historyExclusionCanvas.ctx.alpha = context.historyExclusionEraseCanvas.ctx.alpha = 255;
  state.history = [{ kind: "brush", points: [{ x: 1, y: 1 }], spans: [0] }]; state.historyIndex = 1;
  state.historyRemovedCandidateIds = new Set(["still-here"]); state.historyCandidateIds = new Set(["still-here"]);
  await test.saveDraft();
  assert.equal(state.drafts.get("restore").historyBase.add.startsWith("data:image/png"), true, "dirty history base layers are persisted with the edit");
  assert.equal(state.drafts.get("restore").add.startsWith("data:image/png"), true, "dirty manual layers are persisted with the edit");

  state.displayMode = "single"; state.currentImage = null; test.fitImage();
  state.currentImage = { width: 10, height: 10 }; context.window.devicePixelRatio = 2; displayCanvas.width = 0; displayCanvas.height = 0;
  test.resizeRenderCanvas();
  assert.deepEqual([displayCanvas.width, displayCanvas.height], [240, 180], "resizing the editor allocates the display backing store at device resolution");
  test.resizeRenderCanvas();
  context.window.devicePixelRatio = 1;
  console.log("test_editor_canvas_geometry_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
