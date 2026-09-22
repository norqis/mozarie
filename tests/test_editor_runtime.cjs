const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const canvasPath = path.join(root, "static", "js", "editor-canvas.js");
const masksPath = path.join(root, "static", "js", "editor-masks.js");
const interactionPath = path.join(root, "static", "js", "interaction.js");
const plain = (value) => JSON.parse(JSON.stringify(value));

function drawingContext() {
  return {
    canvas: { width: 100, height: 80 },
    calls: [],
    save() { this.calls.push("save"); }, restore() { this.calls.push("restore"); }, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() { this.calls.push("stroke"); }, clearRect() { this.calls.push("clear"); },
    drawImage() { this.calls.push("image"); }, fillRect() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
  };
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, value: "10", textContent: "", hidden: false, disabled: false, checked: false,
    classList: { toggle() {} }, setAttribute() {}, contains() { return false; },
    style: {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 10, top: 10, width: 80, height: 24 }; },
    showPopover() { this.popoverOpen = true; }, hidePopover() { this.popoverOpen = false; },
    matches(selector) { return selector === ":popover-open" && this.popoverOpen === true; },
  });
  return elements.get(id);
}

const addCtx = drawingContext();
const exclusionCtx = drawingContext();
const exclusionEraseCtx = drawingContext();
const state = {
  view: { x: 5, y: 7, scale: 2 }, currentImage: { width: 100, height: 80 }, currentId: "image",
  boundaryDrafts: [], boundaryDraftSequence: 0, polygonPoints: [], boundaryDragging: false,
  boundaryStart: null, boundaryPoint: null, boundaryRoi: null, boundaryBrushStroke: null,
  boundaryPromptPoint: null, pendingImageId: null, boundaryPending: false, importing: false,
  manualExclusionForced: false, manualEnabled: false, manualExclusionEnabled: false, manualExclusionEraseEnabled: false,
  images: [{ id: "image", sourcePath: "C:/images/sample.png" }, { id: "other" }], sourceAccess: new Map([['gone', {}]]), projectlessDirectorySources: new Map(), drafts: new Map([['gone', {}]]),
  maskStatus: new Map([['gone', true]]), selectedImageIds: new Set(['gone']), candidates: [], removedCandidateIds: new Set(),
  history: [], historyIndex: 0, historyRemovedCandidateIds: new Set(), historyCandidateIds: new Set(),
  settings: { shortcuts: { bindings: { previous: "ArrowLeft", next: "ArrowRight", toggleOverview: "G" }, actions: {} }, confirmations: {} },
  tool: "brush", viewMode: "edit", displayMode: "single", compareSplit: .5, gestureDisplaySide: null, hoverDisplaySide: "left", boundaryDisplaySide: "left", navigationShortcutsEnabled: true,
};
const userErrors = [];
const navigationActions = [];
const context = {
  state, Math, Map, Set, Promise, Object, Array, Number, String, Boolean, JSON, Uint8ClampedArray, requestAnimationFrame: () => 1,
  canvas: { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) }, stage: { clientWidth: 100, clientHeight: 80 }, addCtx, exclusionCtx, exclusionEraseCtx,
  addCanvas: addCtx.canvas, exclusionCanvas: exclusionCtx.canvas, exclusionEraseCanvas: exclusionEraseCtx.canvas,
  historyAddCanvas: drawingContext().canvas, historyExclusionCanvas: drawingContext().canvas, historyExclusionEraseCanvas: drawingContext().canvas,
  $: (selector) => element(selector), document: { activeElement: null, documentElement: { clientWidth: 320, clientHeight: 240 } },
  window: { innerWidth: 320, innerHeight: 240, addEventListener() {} }, crypto: { randomUUID: () => "key-1" },
  navigator: { clipboard: { writeText: async () => {} } },
  isBusy: () => false, catalogStagingEditsActive: () => false, currentImageActionPending: () => Boolean(state.pendingImageId), manualCanvasInputLocked: () => false, isProcessableImage: () => true, hasDurableHistory: () => false, clearBoundaryInteraction() {}, clearBoundaryConstruction() {}, closeBoundaryModeMenu: () => false,
  updateBoundaryActions() {}, render() {}, focusCanvas() {}, focusElement() {}, t: (key, values = {}) => `${key}:${values.value || ""}`,
  calculatedBlockSize: () => 4, currentRecord: () => state.images[0], mosaicDivisor: () => 2, normaliseDivisor: (value) => Number(value),
  markMaskDirty() {}, markDraftDirty() {}, flushMaskComposition() {}, requestMosaicPreview() {}, scheduleManualWorkspaceSave() {}, setStatusKey() {},
  canvasHasPixels: () => true, setReviewed() {}, updateCandidateStatus() {}, refreshCurrentReviewAndMask() {}, renderCandidates() {},
  refreshMaskStatus() {}, releaseCandidateBundles() {}, markImagesUnreviewed() {}, renderCatalogViews() {}, updateNavigationControls() {},
  updateActionButtons() {}, closeProcessing() {}, beginCatalogEpoch: () => 1, isCurrentCatalogEpoch: () => true, clearStatus() {}, flushAllWorkspaceMutations: async () => {},
  clearStoredCatalogState() {}, resetCatalog() {}, releaseImageCaches() {}, clearEditor() {}, updateSelectionActionBar() {}, renderOverview() {},
  selectedImages: () => state.images, closeBatchMoreMenus() {}, setHidden: async () => {}, setReviewed: async () => {}, openDetectionDialog() {},
  clearMasks: async () => {}, removeImageFromCatalog: async () => {}, shortcutFromEvent: (event) => event.binding,
  isEditableTarget: () => false, isTextEditableTarget: () => false, hasOpenDialog: () => false, isGestureActive: () => false,
  moveCurrentBy(distance) { navigationActions.push(distance); }, selectImage() {}, reviewAndMoveNext() {}, setViewMode(mode) { state.viewMode = mode; },
  isReviewed: () => false, isHidden: () => false,
  api: async () => ({ settings: state.settings }), showModalFromInvoker() {}, showUserError(error) { userErrors.push(error); },
};

for (const sourcePath of [canvasPath, masksPath, interactionPath]) {
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
}
vm.runInNewContext(`globalThis.editorTest = {
  roiFromPoints, boundaryDraftRoi, boundaryDraftId, pointForRoi, polygonRoi, boundaryDraftBounds, addBoundaryDraft,
  activeBoundaryShape, boundaryShapes, strokeRoi, appendBoundaryBrushPoint, beginBoundaryBrushStroke, completeBoundaryBrushStroke,
  rectsTouch, joinRois, boundaryRequests, polygonArea, polygonSegmentsIntersect, polygonPointsValid, polygonIsValid,
  canDetectBoundary, hasBoundaryDraft, boundaryActionAnchor, escapeHtml, pointFromEvent, clampPoint, boundaryDragStarted,
  polygonVertexAt, completedPolygonVertexAt, rectangleDraftAt, paintStrokeOnContexts, enableManualLayerForTool,
  droppedFile, isSupportedImageFile, newClientKey, pruneSourceAccess, rememberImportedSource, remapImportedImageIds,
  navigationShortcutAction, handleNavigationKeydown, handleWindowKeydown, setTool, updateBrushSize, updateBlockSizeDisplay,
  openCatalogContextMenu, closeCatalogContextMenu, pickImageFiles, pickImageDirectory, importDroppedFiles
};`, context);
const test = context.editorTest;

assert.deepEqual(plain(test.roiFromPoints({ x: 8.2, y: 9.9 }, { x: 2.1, y: 4.2 })), { left: 2, top: 4, right: 9, bottom: 10 });
assert.equal(test.roiFromPoints({ x: 1, y: 1 }, { x: 2, y: 2 }), null, "one-pixel rectangles are not detection regions");
assert.equal(test.boundaryDraftRoi(), null);
state.boundaryDragging = true; state.boundaryStart = { x: 1, y: 1 }; state.boundaryPoint = { x: 8, y: 6 };
assert.deepEqual(plain(test.boundaryDraftRoi()), { left: 1, top: 1, right: 8, bottom: 6 });
state.boundaryDragging = false;
assert.equal(test.boundaryDraftId(), "boundary-1");
assert.deepEqual(plain(test.pointForRoi({ left: 1, top: 3, right: 8, bottom: 10 })), { x: 5, y: 7 });
assert.equal(test.polygonRoi([]), null);
assert.deepEqual(plain(test.polygonRoi([{ x: 2.2, y: 9.1 }, { x: 8.8, y: 3.2 }])), { left: 2, right: 9, top: 3, bottom: 10 });
assert.deepEqual(plain(test.boundaryDraftBounds({ roi: { left: 1, top: 2, right: 4, bottom: 5 } })), { left: 1, top: 2, right: 4, bottom: 5 });

element("#brushSize").value = "10";
test.beginBoundaryBrushStroke({ x: 2, y: 2 });
test.appendBoundaryBrushPoint({ x: 2.1, y: 2.1 });
test.appendBoundaryBrushPoint({ x: 9, y: 6 });
test.completeBoundaryBrushStroke();
assert.equal(state.boundaryDrafts.length, 1, "a brush gesture becomes one immutable detection draft");
assert.equal(test.hasBoundaryDraft(), true);
assert.equal(test.activeBoundaryShape(), null);
assert.equal(test.boundaryShapes().length, 1);
assert.equal(test.rectsTouch({ left: 0, top: 0, right: 5, bottom: 5 }, { left: 6, top: 6, right: 8, bottom: 8 }), true);
assert.equal(test.rectsTouch({ left: 0, top: 0, right: 2, bottom: 2 }, { left: 5, top: 5, right: 8, bottom: 8 }), false);
assert.deepEqual(plain(test.joinRois([{ left: 1, top: 3, right: 6, bottom: 7 }, { left: 0, top: 4, right: 9, bottom: 8 }])), { left: 0, top: 3, right: 9, bottom: 8 });

const validPolygon = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
const crossedPolygon = [{ x: 2, y: 2 }, { x: 8, y: 8 }, { x: 8, y: 2 }, { x: 2, y: 8 }];
assert.equal(test.polygonArea(validPolygon), 36);
assert.equal(test.polygonSegmentsIntersect(validPolygon[0], validPolygon[1], validPolygon[2], validPolygon[3]), false);
assert.equal(test.polygonPointsValid(validPolygon), true);
assert.equal(test.polygonPointsValid(crossedPolygon), false);
state.polygonPoints = validPolygon; assert.equal(test.polygonIsValid(), true); state.polygonPoints = [];
state.boundaryDrafts.push({ id: "rectangle", type: "rectangle", roi: { left: 20, top: 20, right: 30, bottom: 30 } });
state.boundaryDrafts.push({ id: "invalid", type: "polygon", points: crossedPolygon });
const requests = test.boundaryRequests();
assert.equal(requests.length, 2, "touching brush marks share one detection request and invalid polygons are rejected");
assert.equal(requests[0].draft.type, "brush"); assert.equal(requests[1].draft.type, "rectangle");
assert.equal(test.canDetectBoundary(), true);
state.pendingImageId = "other"; assert.equal(test.canDetectBoundary(), false); state.pendingImageId = null;
assert.ok(test.boundaryActionAnchor().left >= 0);

assert.equal(test.escapeHtml(`<tag attr="x">&'`), "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;");
assert.deepEqual(plain(test.pointFromEvent({ clientX: 25, clientY: 27 })), { x: 10, y: 10 });
assert.deepEqual(plain(test.clampPoint({ x: -1, y: 99 })), { x: 0, y: 80 });
state.boundaryStartClient = { x: 2, y: 2 }; assert.equal(test.boundaryDragStarted({ clientX: 4, clientY: 4 }), false); assert.equal(test.boundaryDragStarted({ clientX: 6, clientY: 2 }), true);
state.polygonPoints = validPolygon; assert.equal(test.polygonVertexAt({ x: 2, y: 2 }), 0);
assert.deepEqual(plain(test.completedPolygonVertexAt({ x: 2, y: 2 })), { draft: plain(state.boundaryDrafts[2]), index: 0 });
assert.equal(test.rectangleDraftAt({ x: 25, y: 25 }).id, "rectangle");

test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 2, y: 2 }, "mosaic_eraser", 3);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 2, y: 2 }, "eraser", 3);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 2, y: 2 }, "exclude_eraser", 3);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 2, y: 2 }, "brush", 3);
assert.ok(addCtx.calls.includes("stroke") && exclusionCtx.calls.includes("stroke") && exclusionEraseCtx.calls.includes("stroke"));
test.enableManualLayerForTool("brush"); test.enableManualLayerForTool("eraser"); test.enableManualLayerForTool("exclude_eraser");
assert.deepEqual([state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [true, true, true]);

assert.deepEqual(plain(test.droppedFile({ name: "a.png" }, "nested/a.png", "file", "parent")), { file: { name: "a.png" }, relativePath: "nested/a.png", fileHandle: "file", parentHandle: "parent" });
assert.equal(test.isSupportedImageFile({ name: "sample.JPEG" }), true); assert.equal(test.isSupportedImageFile({ name: "sample.gif" }), false);
assert.equal(test.newClientKey(), "key-1");
test.pruneSourceAccess(); assert.equal(state.sourceAccess.has("gone"), false);
test.rememberImportedSource({ clientKey: "key-1", sourceId: "source-1", entry: { file: { name: "a.png", size: 2, lastModified: 1 }, fileHandle: "handle", parentHandle: "parent" }, data: { imported: [{ clientKey: "key-1", imageId: "image" }] } }, { sourceKind: "browser-files", sourceId: "source-1" });
assert.equal(state.sourceAccess.get("image").fileHandle, "handle");
state.drafts.set("old", 1); state.maskStatus.set("old", true); state.selectedImageIds.add("old"); state.currentId = "old"; state.pendingImageId = "old";
test.remapImportedImageIds({ old: "image" });
assert.equal(state.currentId, "image"); assert.equal(state.pendingImageId, "image"); assert.equal(state.drafts.get("image"), 1);

assert.equal(test.navigationShortcutAction({ binding: "ArrowLeft" }), "previous");
assert.equal(test.navigationShortcutAction({ binding: "Nope" }), null);
let prevented = false; assert.equal(test.handleNavigationKeydown({ binding: "ArrowRight", preventDefault() { prevented = true; } }), true); assert.equal(prevented, true);
test.updateBrushSize(999); assert.equal(element("#brushSize").value, 300, "brush size clamps to the displayed 300px maximum");
test.updateBrushSize(-5); assert.equal(element("#brushSize").value, 1, "brush size clamps to one pixel");
test.updateBrushSize("invalid"); assert.equal(element("#brushSize").value, 1, "invalid restored sizes use one pixel");
test.updateBlockSizeDisplay(); assert.match(element("#blockSizeValue").textContent, /4/);
test.setTool("bucket"); assert.equal(state.tool, "bucket"); assert.equal(context.canvas.style.cursor, "default", "ordinary tools retain the standard pointer");

async function interactionUserEventWorkflowTest() {
  let contextMenuPrevented = false;
  const catalogCard = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 120, height: 32 }) };
  test.openCatalogContextMenu({
    type: "contextmenu", clientX: 75, clientY: 90, currentTarget: catalogCard,
    preventDefault() { contextMenuPrevented = true; },
  }, "image");
  assert.equal(contextMenuPrevented, true, "a mouse context-menu event must suppress the browser menu");
  assert.equal(element("#catalogContextMenu").popoverOpen, true, "a mouse context-menu event must open the catalog actions");
  assert.equal(element("#copyImagePathMenuItem").hidden, false, "a source-backed image exposes copy-path action");
  test.closeCatalogContextMenu({ restoreFocus: false });
  assert.equal(element("#catalogContextMenu").popoverOpen, false, "closing the catalog actions hides the popover");

  let navigationPrevented = false;
  state.viewMode = "edit";
  navigationActions.length = 0;
  test.handleWindowKeydown({ binding: "ArrowRight", preventDefault() { navigationPrevented = true; } });
  assert.equal(navigationPrevented, true, "the next-image keyboard shortcut must consume the event");
  assert.deepEqual(navigationActions, [1], "the next-image keyboard shortcut must navigate forward");
  test.handleWindowKeydown({ binding: "G", preventDefault() {} });
  assert.equal(state.viewMode, "overview", "the overview keyboard shortcut must change the visible view");

  context.window.showOpenFilePicker = async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; };
  await test.pickImageFiles();
  assert.equal(state.importing, false, "cancelling the file picker must finish its import session");
  assert.equal(userErrors.length, 0, "cancelling the file picker is not an error shown to the user");

  context.window.showDirectoryPicker = async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; };
  await test.pickImageDirectory();
  assert.equal(state.importing, false, "cancelling the directory picker must finish its import session");

  let dropPrevented = false;
  let dropStopped = false;
  await test.importDroppedFiles({
    dataTransfer: { items: [] },
    preventDefault() { dropPrevented = true; },
    stopPropagation() { dropStopped = true; },
  });
  assert.equal(dropPrevented, true, "a file drop must prevent browser navigation");
  assert.equal(dropStopped, true, "a file drop must stop duplicate handlers");
  assert.equal(element("#galleryDropOverlay").hidden, true, "finishing a drop hides the gallery overlay");
}

interactionUserEventWorkflowTest().then(() => {
  console.log("test_editor_runtime: passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
