const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function context2d(canvas) {
  return {
    canvas, calls: [], alpha: 0, globalCompositeOperation: "source-over",
    clearRect(...args) { this.calls.push(["clear", ...args]); this.alpha = 0; },
    drawImage(image, ...args) { this.calls.push(["image", image, ...args]); if (image?.alpha !== 0 || image?.ctx?.alpha !== 0) this.alpha = 255; },
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, this.alpha]) }; },
    save() { this.calls.push(["save"]); }, restore() { this.calls.push(["restore"]); },
    setTransform(...args) { this.calls.push(["transform", ...args]); }, translate(...args) { this.calls.push(["translate", ...args]); }, scale(...args) { this.calls.push(["scale", ...args]); },
    beginPath() { this.calls.push(["begin"]); }, arc(...args) { this.calls.push(["arc", ...args]); }, stroke() { this.calls.push(["stroke"]); },
    setLineDash(args) { this.calls.push(["dash", ...args]); }, rect(...args) { this.calls.push(["rect", ...args]); }, clip() { this.calls.push(["clip"]); },
    fillRect(...args) { this.calls.push(["fill", ...args]); }, fill() { this.calls.push(["fill-path"]); }, moveTo(...args) { this.calls.push(["move", ...args]); }, lineTo(...args) { this.calls.push(["line", ...args]); }, closePath() { this.calls.push(["close"]); },
    putImageData(...args) { this.calls.push(["put", ...args]); },
  };
}

function canvas(width = 8, height = 6) {
  const target = { width, height, alpha: 0, toBlob(callback) { callback({ bytes: 1 }); } };
  target.ctx = context2d(target);
  target.getContext = () => target.ctx;
  return target;
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, { id, value: "10", textContent: "", hidden: false, disabled: false, style: {}, offsetWidth: 142, offsetHeight: 38,
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    });
  }
  return elements.get(id);
}

const addCanvas = canvas();
const exclusionCanvas = canvas();
const exclusionEraseCanvas = canvas();
const effectiveExclusionCanvas = canvas();
const combinedCanvas = canvas();
const mosaicCanvas = canvas();
const historyAddCanvas = canvas();
const historyExclusionCanvas = canvas();
const historyExclusionEraseCanvas = canvas();
const originalCanvas = canvas();
const layerCanvas = canvas();
const boundaryOverlayCanvas = canvas();
const displayCanvas = canvas();
const layerCtx = layerCanvas.ctx;
const ctx = displayCanvas.ctx;
const boundaryOverlayCtx = boundaryOverlayCanvas.ctx;
const state = {
  currentId: "image", currentImage: { width: 8, height: 6 }, currentImage: { width: 8, height: 6, alpha: 255 }, currentId: "image",
  candidates: [], candidateImages: new Map(), removedCandidateIds: new Set(), images: [{ id: "image", candidateRevision: 2, enabledCandidateCount: 0 }],
  maskStatus: new Map(), drafts: new Map(), draftLayerDirty: new Set(), draftSaveChains: new Map(), history: [], historyIndex: 0,
  historyRemovedCandidateIds: new Set(), historyCandidateIds: new Set(), view: { x: 2, y: 3, scale: 2 }, settings: { display: { apply_color: "#a", exclude_color: "#b", overlay_opacity: 0.5 }, detection: {} },
  manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: false, manualMaskPresent: false,
  maskDirty: false, draftDirty: false, historyBaseDirty: false, mosaicPreviewGeneration: 0, mosaicPreviewEnabled: true, mosaicWorker: null, mosaicWorkerBusy: false, mosaicPending: false, mosaicPreviewRequested: false, mosaicSourceImage: null, mosaicSourceId: "", mosaicSourcePromise: null, mosaicPreviewFailureReported: false,
  blinkCandidateIds: new Set(), blinkModes: new Map(), blinkPhase: true, hover: { x: 1, y: 2 }, tool: "mosaic_eraser", renderFrame: 0,
  boundaryDrafts: [], boundaryDragging: false, polygonPoints: [], boundaryBrushStroke: null, pendingImageId: null, boundaryPending: false, importing: false,
};
let workerCreated = 0;
class Worker {
  constructor(url) { this.url = url; this.posted = []; workerCreated += 1; }
  postMessage(payload) { this.posted.push(payload); }
  terminate() { this.terminated = true; }
}
class FileReader {
  readAsDataURL() { this.result = "data:image/png;base64,AA=="; this.onload(); }
}
const context = {
  state, Math, Map, Set, Promise, Object, Array, Number, String, Boolean, JSON, Uint8Array, Uint8ClampedArray,
  requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {}, Worker, FileReader,
  createImageBitmap: async (image) => ({ ...image, close() { this.closed = true; } }), OffscreenCanvas: class {},
  ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
  window: { devicePixelRatio: 2 }, document: { activeElement: null },
  stage: { clientWidth: 80, clientHeight: 60 }, toolRail: { offsetHeight: 10 }, canvas: displayCanvas,
  addCanvas, exclusionCanvas, exclusionEraseCanvas, effectiveExclusionCanvas, combinedCanvas, mosaicCanvas, historyAddCanvas, historyExclusionCanvas, historyExclusionEraseCanvas, originalCanvas, layerCanvas, boundaryOverlayCanvas,
  addCtx: addCanvas.ctx, exclusionCtx: exclusionCanvas.ctx, exclusionEraseCtx: exclusionEraseCanvas.ctx, effectiveExclusionCtx: effectiveExclusionCanvas.ctx, combinedCtx: combinedCanvas.ctx, mosaicCtx: mosaicCanvas.ctx, originalCtx: originalCanvas.ctx, layerCtx, boundaryOverlayCtx, ctx,
  $: (selector) => element(selector), t: (key, values = {}) => `${key}:${values.count ?? ""}`, isBusy: () => false,
  closeBoundaryModeMenu() {}, cancelFillWork() {}, clearBoundaryInteraction() {}, renderCandidates() {}, updateHistoryButtons() {}, updateNavigationControls() {}, updateActionButtons() {}, updateGalleryCurrent() {},
  currentRecord: () => state.images.find((image) => image.id === state.currentId), calculatedBlockSize: () => 4,
  resetHistoryToCurrentManualMask() {}, rebuildManualMaskFromHistory() {}, renderCatalogViews() {},
};

const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
const source = fs.readFileSync(canvasPath, "utf8");
vm.runInNewContext(source, context, { filename: canvasPath });
vm.runInNewContext("globalThis.canvasCompletion = { canvasSizeForImage, clearEditor, canvasHasPixels, syncCandidateRecord, syncStoredMaskStatus, refreshCandidateRecord, updateCandidateStatus, canvasToDataUrl, decodeDraftImages, releaseMosaicPreview, prepareOriginalImage, rebuildMosaicPreview, requestMosaicPreview, drawEffectiveExclusions, composeCurrentMask, markDraftDirty, markMaskDirty, flushMaskComposition, hasEffectiveMask, maskStatusWithoutCandidate, refreshMaskStatus, paintMosaicPreview, updateBrushCursor, drawCandidateBlinkOverlay, renderNow, flushRender };", context, { filename: "test-editor-canvas-completion-exports.js" });
const test = context.canvasCompletion;

(async () => {
  test.canvasSizeForImage({ width: 20, height: 12 });
  assert.equal(addCanvas.width, 20, "resizing an image resets every editable canvas");
  assert.equal(state.maskDirty, true);
  assert.equal(state.manualEnabled, true);
  originalCanvas.width = 3840; originalCanvas.height = 2160;
  test.clearEditor();
  assert.deepEqual([originalCanvas.width, originalCanvas.height], [1, 1], "clearing an image releases the full-resolution original backing store");
  state.hover = { x: 1, y: 2 };

  addCanvas.ctx.alpha = 255;
  assert.equal(test.canvasHasPixels(addCanvas.ctx, addCanvas), true);
  addCanvas.ctx.alpha = 0;
  assert.equal(test.canvasHasPixels(addCanvas.ctx, addCanvas), false);
  test.syncCandidateRecord("image", [{ id: "apply", enabled: true, role: "apply" }, { id: "exclude", enabled: true, role: "exclude" }, { id: "hidden", enabled: true, role: "apply" }]);
  assert.deepEqual({ count: state.images[0].candidateCount, enabled: state.images[0].enabledCandidateCount }, { count: 3, enabled: 2 });
  state.removedCandidateIds.add("hidden");
  test.syncCandidateRecord("image", [{ id: "apply", enabled: true, role: "apply" }, { id: "exclude", enabled: true, role: "exclude" }, { id: "hidden", enabled: true, role: "apply" }]);
  assert.deepEqual({ count: state.images[0].candidateCount, enabled: state.images[0].enabledCandidateCount }, { count: 2, enabled: 1 }, "removed candidates do not count as actionable");

  state.drafts.set("image", { hasEffectiveMask: true, candidateRevision: 1 });
  test.syncStoredMaskStatus("image", []);
  assert.equal(state.maskStatus.get("image"), true, "saved effective masks survive a candidate revision change");
  state.drafts.set("image", { hasEffectiveMask: false, candidateRevision: 1 });
  test.syncStoredMaskStatus("image", []);
  assert.equal(state.maskStatus.has("image"), false, "stale empty mask status is discarded");
  context.api = async () => ({ candidates: [{ id: "fresh", enabled: true, role: "apply" }] });
  await test.refreshCandidateRecord("image", true);
  assert.equal(state.images[0].candidateCount, 1);

  state.candidates = [{ id: "apply", enabled: true, role: "apply" }, { id: "exclude", enabled: true, role: "exclude", forced: true }, { id: "off", enabled: false, role: "apply" }];
  state.candidateImages = new Map([["apply", { alpha: 255 }], ["exclude", { alpha: 255 }], ["off", { alpha: 255 }]]);
  state.removedCandidateIds.clear();
  state.manualMaskPresent = false;
  test.updateCandidateStatus();
  assert.equal(element("#candidateStatus").textContent, "candidates.count:3");
  state.manualMaskPresent = true;
  test.updateCandidateStatus();
  assert.equal(element("#candidateStatus").textContent, "candidates.countWithManual:3");
  state.removedCandidateIds.add("apply"); state.removedCandidateIds.add("exclude"); state.removedCandidateIds.add("off");
  test.updateCandidateStatus();
  assert.equal(element("#candidateStatus").textContent, "candidates.manualOnly:");
  state.manualMaskPresent = false; test.updateCandidateStatus();
  assert.equal(element("#candidateStatus").textContent, "candidates.none:");

  const encoded = await test.canvasToDataUrl(addCanvas);
  assert.match(encoded, /^data:image\/png/);
  context.loadImage = async (url) => ({ url });
  const decoded = await test.decodeDraftImages({ add: "add", exclusion: "exclude", historyBase: { exclusionErase: "history" } });
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), [{ url: "add" }, { url: "exclude" }, null, null, null, { url: "history" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await test.decodeDraftImages(null))), [null, null, null, null, null, null]);

  state.removedCandidateIds.clear(); state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true; state.manualExclusionForced = true;
  test.composeCurrentMask();
  assert.equal(state.maskDirty, false);
  assert.ok(combinedCanvas.ctx.calls.some(([name, image]) => name === "image" && image === state.candidateImages.get("apply")), "enabled apply candidates compose into the effective mask");
  assert.ok(effectiveExclusionCanvas.ctx.calls.some(([name, image]) => name === "image" && image === state.candidateImages.get("exclude")), "exclude candidates subtract from the effective mask");
  combinedCanvas.ctx.alpha = 255;
  assert.equal(test.maskStatusWithoutCandidate("apply"), true, "manual content remains an effective mask when testing a single candidate removal");
  state.maskDirty = true; test.flushMaskComposition(); assert.equal(state.maskDirty, false);
  assert.equal(test.hasEffectiveMask(), true);
  state.maskStatus.set("image", false); combinedCanvas.ctx.alpha = 255;
  assert.equal(test.refreshMaskStatus(true), true, "status changes redraw catalog indicators");

  state.mosaicWorker = { terminate() { this.terminated = true; } }; state.mosaicWorkerBusy = true; state.mosaicPending = true;
  test.releaseMosaicPreview();
  assert.equal(state.mosaicWorker, null); assert.equal(mosaicCanvas.width, 1);
  state.currentImage = { width: 4, height: 3, alpha: 255 }; combinedCanvas.width = 4; combinedCanvas.height = 3;
  test.prepareOriginalImage();
  assert.deepEqual([originalCanvas.width, originalCanvas.height], [4, 3]);
  await test.rebuildMosaicPreview();
  assert.equal(workerCreated, 1); assert.equal(state.mosaicWorker.posted.length, 2, "preview worker receives one source bitmap and one mask buffer");
  const completedFrame = { close() { this.closed = true; } };
  state.mosaicWorker.onmessage({ data: { type: "frame", sourceId: state.mosaicSourceId, generation: state.mosaicPreviewGeneration, output: completedFrame } });
  assert.ok(mosaicCanvas.ctx.calls.some(([name]) => name === "image"));
  assert.equal(completedFrame.closed, true, "painting a completed worker frame releases its bitmap");
  state.mosaicPreviewRequested = false; test.requestMosaicPreview(); assert.equal(state.mosaicPreviewRequested, false, "preview coalescing resets after the animation frame");

  context.Worker = class { constructor() { throw new Error("worker unavailable"); } };
  test.releaseMosaicPreview();
  state.mosaicSourceImage = null; state.mosaicSourceId = ""; state.mosaicPreviewEnabled = true;
  await test.rebuildMosaicPreview();
  assert.equal(state.mosaicPreviewEnabled, false, "an unavailable worker disables the preview instead of leaving it pending");

  test.paintMosaicPreview();
  assert.ok(layerCtx.calls.some(([name]) => name === "image"), "preview is clipped through the composed mask before painting");
  test.updateBrushCursor();
  assert.equal(element("#brushCursor").classList.contains("eraser"), true, "eraser cursor is visibly dashed");
  state.tool = "boundary_brush"; test.updateBrushCursor();
  assert.equal(element("#brushCursor").classList.contains("boundary-brush"), true, "boundary brush renders a cursor ring");

  state.blinkCandidateIds = new Set(["manual:apply", "manual:exclude", "manual:excludeErase", "apply", "exclude"]);
  state.blinkModes = new Map([["manual:apply", "effective"], ["apply", "effective"]]);
  test.drawCandidateBlinkOverlay();
  assert.ok(layerCtx.calls.some(([name]) => name === "fill"), "blink overlay colors each candidate through the viewport layer");
  test.renderNow(); test.flushRender();
  console.log("test_editor_canvas_completion_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
