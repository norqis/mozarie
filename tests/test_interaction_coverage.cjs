"use strict";

// This is intentionally a small browser-shaped VM rather than a duplicate of
// interaction.js.  It exercises the public interaction paths while retaining
// the production file as the single source of behaviour.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id; this.hidden = false; this.value = ""; this.textContent = "";
    this.checked = false; this.returnValue = "confirm"; this.style = {};
    this.listeners = new Map(); this.attributes = new Map(); this.open = false;
    this.classList = { toggle() {} };
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) || null; }
  append(child) { child.parentElement = this; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  contains(value) { return value === this; }
  matches(value) { return value === ":popover-open" && this.open; }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
  getBoundingClientRect() { return { left: 10, right: 90, top: 20, bottom: 60, width: 80, height: 40 }; }
  close(value = "") { this.returnValue = value; this.open = false; this.listeners.get("close")?.(); }
}

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new Element(id));
  return elements.get(id);
};
const ids = [
  "boundaryModeMenu", "boundaryTool", "brushSize", "brushSizeValue", "blockSizeValue", "applyBlockSize",
  "confirmDialog", "confirmTitle", "confirmMessage", "confirmNeverShow", "bucketToleranceControl",
  "candidateStatus", "catalogContextMenu", "toggleReviewMenuItem", "copyImagePathMenuItem", "removeImageMenuItem",
  "pickerMenu", "galleryDropOverlay",
];
for (const id of ids) element(`#${id}`);

const calls = [];
let busy = false;
let editable = false;
let dialogOpen = false;
let gesture = false;
let images = [
  { id: "one", sourcePath: "C:/one.png", candidateCount: 1, enabledCandidateCount: 1 },
  { id: "two", sourcePath: "C:/two.png", candidateCount: 1, enabledCandidateCount: 1 },
];
const state = {
  importing: false, tool: "brush", images, currentId: "one", pendingImageId: null, currentImage: images[0],
  settings: { confirmations: { clearMasks: false, clearCatalog: false, removeImage: false }, shortcuts: { bindings: {}, actions: {} } },
  masksClearing: false, catalogMutation: false, imageGeneration: 0, catalogEpoch: 0, candidates: [],
  drafts: new Map(), maskStatus: new Map(), selectedImageIds: new Set(["one"]), sourceAccess: new Map(),
  reviewedPaths: new Set(), candidateImages: new Map(), batchMode: false, contextMenuImageId: null,
  contextMenuOrigin: null, importSession: null, navigationShortcutsEnabled: true, viewMode: "edit",
  historyIndex: 1, manualMaskPresent: true, manualEnabled: false, manualExclusionEnabled: false,
  manualExclusionEraseEnabled: false, maskDirty: false,
};
let apiMode = "ok";
let unique = 0;
const document = {
  activeElement: null,
  documentElement: { clientWidth: 300, clientHeight: 200 },
  querySelector(selector) {
    if (selector === 'meta[name="mozarie-token"]') return { content: "token" };
    return element(selector);
  },
};
const context = {
  responseError(response, payload) { const error = new Error(); error.status = response.status; error.code = typeof payload?.error_code === "string" ? payload.error_code : (response.status === 404 ? "api_not_found" : "internal_error"); error.params = payload?.params || {}; return error; },
  console, Promise, Set, Map, Array, Object, Math, Number, Boolean, String, Error,
  AbortController, DOMException, setTimeout, clearTimeout, encodeURIComponent, crypto: { randomUUID: () => `key-${++unique}` },
  state, document, window: { innerWidth: 300, innerHeight: 200 }, navigator: { clipboard: { writeText: async (value) => { calls.push(["copy", value]); } } },
  $: (selector) => element(selector),
  canvas: { style: {} }, addCanvas: { width: 4, height: 4 }, exclusionCanvas: { width: 4, height: 4 }, exclusionEraseCanvas: { width: 4, height: 4 },
  addCtx: { clearRect() {} }, exclusionCtx: { clearRect() {} }, exclusionEraseCtx: { clearRect() {} },
  t: (key, data = {}) => `${key}${data.value ?? data.count ?? ""}`,
  applyProjectSnapshot() {},
  isBusy: () => busy, closeBoundaryModeMenu: undefined,
  clearBoundaryInteraction: () => calls.push(["clearBoundaryInteraction"]), clearBoundaryConstruction: () => calls.push(["clearBoundaryConstruction"]),
  updateBoundaryActions: () => calls.push(["boundaryActions"]), updateBrushCursor: () => {}, render: () => calls.push(["render"]), flushRender: () => calls.push(["flushRender"]), flushMaskComposition: () => calls.push(["flushMaskComposition"]), clearCandidateBlink: () => calls.push(["clearCandidateBlink"]), focusCanvas: () => calls.push(["canvas"]), focusElement: (value) => { document.activeElement = value; },
  calculatedBlockSize: () => 7, currentRecord: () => images[0], mosaicDivisor: () => 3, normaliseDivisor: (value) => Number(value),
  showModalFromInvoker: (dialog) => queueMicrotask(() => dialog.close(dialog.returnValue)),
  api: async (url, options = {}) => {
    calls.push(["api", url, options]);
    if (apiMode === "error") throw new Error("failed");
    if (url === "/api/settings?status=0") return { settings: state.settings };
    if (url === "/api/images") return { images };
    if (url === "/api/workspace/catalog") return { catalogId: "provisional", provisional: true };
    if (url === "/api/workspace/catalog/finalize") return { catalogId: "final", imageIds: { pending: "one" }, images };
    if (url.startsWith("/api/catalog/image/")) return { images: images.filter((image) => image.id !== decodeURIComponent(url.split("/").at(-1))) };
    return {};
  },
  beginCatalogEpoch: () => ++state.catalogEpoch, isCurrentCatalogEpoch: (epoch) => epoch === state.catalogEpoch,
  updateActionButtons: () => calls.push(["actions"]), releaseCandidateBundles: () => {}, resetHistoryToCurrentManualMask: () => {}, refreshMaskStatus: () => {},
  markImagesUnreviewed: () => {}, renderCandidates: () => {}, renderCatalogViews: () => calls.push(["catalog"]), updateNavigationControls: () => {}, clearStatus: () => {},
  flushAllWorkspaceMutations: async () => {}, clearStoredCatalogState: () => {}, resetCatalog: (next) => { images = next; state.images = next; },
  reviewPath: (image) => image.id, isReviewed: (image) => state.reviewedPaths.has(image.id), isHidden: (image) => Boolean(image.hidden),
  selectImage: async (id) => { state.currentId = id; state.currentImage = state.images.find((image) => image.id === id) || null; },
  showUserError: (error) => calls.push(["error", error.code || error.message]), setStatusKey: (key) => calls.push(["status", key]),
  releaseImageCaches: () => {}, clearEditor: () => {}, clearBatchSelection: () => {}, updateSelectionActionBar: () => {}, renderOverview: () => {},
  selectedImages: () => state.images.filter((image) => state.selectedImageIds.has(image.id)), closeBatchMoreMenus: () => {},
  setHidden: async (image, value) => { image.hidden = value; }, setReviewed: async (image, value) => { if (value) state.reviewedPaths.add(image.id); },
  openDetectionDialog: () => calls.push(["detect"]), importParallelism: () => 2,
  showProcessing: () => {}, closeProcessing: () => {}, remapImportedImageIds: undefined, loadReviewedPaths: () => {},
  catalogForDirectoryHandle: async () => "directory-catalog", rememberProjectSource: async (_projectId, _handle, _imageId, sourceId) => sourceId || "remembered-source",
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ imported: [], catalogId: "final", provisional: false }) }),
  setGalleryDropOverlay: undefined, shortcutFromEvent: (event) => event.binding, isEditableTarget: () => editable, hasOpenDialog: () => dialogOpen,
  isGestureActive: () => gesture, moveCurrentBy: () => {}, setViewMode: (mode) => { state.viewMode = mode; }, reviewAndMoveNext: () => {}, restoreSnapshot: () => {},
};

const interactionPath = path.join(__dirname, "..", "static", "js", "interaction.js");
const source = fs.readFileSync(interactionPath, "utf8");
vm.runInNewContext(source, context, { filename: interactionPath });
vm.runInNewContext("globalThis.interactionTest={setTool,setBoundaryModeMenuOpen,closeBoundaryModeMenu,updateBrushSize,updateBlockSizeDisplay,rememberFillToleranceTrigger,confirmAction,confirmationRequired,resetCurrentDraft,clearMasks,clearCatalog,closeCatalogContextMenu,positionCatalogContextMenu,openCatalogContextMenu,copyContextMenuImagePath,clearReviewForRemovedImage,removeImageFromCatalog,runSelectionAction,droppedFile,directFilesFromDrop,isSupportedImageFile,newClientKey,pruneSourceAccess,rememberImportedSource,importFiles,importSingleFile,beginImportSession,remapImportedImageIds,finishImportSession,waitForImportSession,importHandleEntries,importFileHandles,importDirectoryHandle,importProjectDirectoryHandle,importProjectFileHandles,pickImageFiles,pickImageDirectory,importDroppedFiles,setGalleryDropOverlay,handleEditorKeydown,navigationShortcutAction,handleNavigationKeydown,handleWindowKeydown};", context, { filename: "test-interaction-exports.js" });

const test = context.interactionTest;
const event = (binding, type = "keydown") => ({ binding, type, currentTarget: element("#origin"), clientX: 30, clientY: 40, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
const file = (name) => ({ name, size: 1, lastModified: 1 });
const indexSource = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
const tolerancePanelCss = styleSource.match(/\.bucket-tolerance-panel\s*\{([^}]*)\}/)?.[1] || "";

(async () => {
  assert.match(indexSource, /id="bucketTool"[^>]*aria-controls="bucketToleranceControl"[^>]*aria-expanded="false"/, "the mosaic fill control owns its tolerance popover semantically");
  assert.match(indexSource, /id="excludeBucketTool"[^>]*aria-controls="bucketToleranceControl"[^>]*aria-expanded="false"/, "the exclusion fill control owns the shared tolerance popover semantically");
  assert.match(indexSource, /<output id="bucketToleranceValue" for="bucketTolerance">/, "the displayed tolerance is associated with its range input");
  assert.match(indexSource, /id="bucketToleranceControl"[^>]*popover="auto"/, "fill tolerance uses native outside-click and Escape dismissal");
  assert.match(tolerancePanelCss, /position:\s*fixed;/, "the top-layer tolerance panel is positioned against the viewport");
  assert.doesNotMatch(tolerancePanelCss, /transform:\s*translateX\(-50%\)/, "the tolerance panel does not overflow left by centering itself");
  test.setTool("bucket");
  test.rememberFillToleranceTrigger("bucket");
  assert.equal(element("#bucketTool").getAttribute("aria-expanded"), "true", "mosaic fill marks its tolerance control expanded");
  assert.equal(element("#excludeBucketTool").getAttribute("aria-expanded"), "false", "only the active fill control is expanded");
  const toleranceParent = element("#bucketToleranceControl").parentElement;
  test.setTool("exclude_bucket");
  assert.equal(element("#bucketTool").getAttribute("aria-expanded"), "false", "changing to exclusion fill collapses mosaic fill semantics");
  assert.equal(element("#excludeBucketTool").getAttribute("aria-expanded"), "true", "exclusion fill marks its tolerance control expanded");
  assert.equal(element("#bucketToleranceControl").parentElement, toleranceParent, "the shared top-layer panel does not move in the DOM when its anchor changes");
  test.setTool("boundary"); test.setTool("brush");
  assert.equal(element("#excludeBucketTool").getAttribute("aria-expanded"), "false", "leaving fill tools collapses the tolerance control");
  element("#boundaryModeMenu").hidden = false; document.activeElement = element("#boundaryModeMenu");
  assert.equal(test.closeBoundaryModeMenu({ restoreFocus: true }), true);
  test.setBoundaryModeMenuOpen(true); test.updateBrushSize(999); element("#applyDivisor").value = "4"; test.updateBlockSizeDisplay();

  element("#confirmNeverShow").checked = true;
  assert.equal(await test.confirmAction("title", "message", "candidateDelete"), true);
  assert.equal(test.confirmationRequired("candidateDelete"), false);
  state.settings.confirmations.candidateDelete = true; element("#confirmNeverShow").checked = true;
  assert.equal(await test.confirmAction("title", "message", "candidateDelete"), true);
  state.settings.confirmations.candidateDelete = true; element("#confirmNeverShow").checked = false; element("#confirmDialog").returnValue = "";
  assert.equal(await test.confirmAction("title", "message", "candidateDelete"), false);
  element("#confirmDialog").returnValue = "confirm";
  test.resetCurrentDraft(); await test.clearMasks(["one"], "a", "b");
  assert.equal(state.maskDirty, true, "resetting the current draft marks composed masks dirty before recomposition");
  assert.ok(calls.some(([name]) => name === "flushMaskComposition"), "resetting the current draft recomposes masks before its render");
  assert.ok(calls.some(([name]) => name === "clearCandidateBlink"), "clearing the current image ends candidate blinking before candidate state is reset");
  assert.ok(calls.some(([name]) => name === "flushRender"), "clearing the current image immediately redraws the candidate range");
  await test.clearCatalog();

  images = [{ id: "one", sourcePath: "C:/one.png" }, { id: "two" }]; state.images = images; state.currentId = "one"; state.currentImage = images[0]; state.selectedImageIds = new Set(["one"]);
  test.positionCatalogContextMenu(element("#catalogContextMenu"), -1, 999);
  const pointerOrigin = element("#pointer-origin"); const pointerTarget = element("#pointer-target"); document.activeElement = pointerOrigin;
  test.openCatalogContextMenu({ ...event("", "contextmenu"), currentTarget: pointerTarget }, "two");
  assert.equal(state.contextMenuOrigin, pointerOrigin, "a pointer context menu restores the previously focused catalog card");
  assert.equal(document.activeElement, pointerOrigin, "a pointer context menu does not move focus to its target or menu");
  test.closeCatalogContextMenu(); assert.equal(document.activeElement, pointerOrigin, "closing a pointer context menu preserves its prior focus");
  const keyboardTarget = element("#keyboard-target");
  test.openCatalogContextMenu({ ...event("", "keydown"), currentTarget: keyboardTarget }, "one");
  assert.equal(state.contextMenuOrigin, keyboardTarget, "a keyboard context menu restores its invoking card");
  assert.equal(document.activeElement, element("#toggleReviewMenuItem"), "a keyboard context menu moves focus into its first action");
  test.closeCatalogContextMenu(); assert.equal(document.activeElement, keyboardTarget, "closing a keyboard context menu restores its invoking card");
  test.openCatalogContextMenu(event("", "contextmenu"), "one"); await test.copyContextMenuImagePath();
  context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  state.contextMenuImageId = "one"; state.contextMenuOrigin = element("#origin"); await test.copyContextMenuImagePath();
  state.reviewedPaths.add("one"); test.clearReviewForRemovedImage(images[0]); await test.removeImageFromCatalog("one");

  images = [{ id: "one" }, { id: "two" }]; state.images = images; state.selectedImageIds = new Set(["one", "two"]);
  for (const action of ["hide", "show", "reviewed", "unreviewed", "detect", "clear", "remove"]) await test.runSelectionAction(action);
  assert.deepEqual(test.droppedFile(file("a.png")).relativePath, "a.png");
  const directory = { name: "folder", kind: "directory", async *values() { yield { name: "a.png", kind: "file" }; } };
  assert.equal((await test.directFilesFromDrop({ items: [{ kind: "file", getAsFileSystemHandle: async () => directory }, { kind: "text" }] })).handleEntries.length, 1);
  assert.equal(test.isSupportedImageFile(file("x.PNG")), true); assert.equal(test.isSupportedImageFile(file("x.gif")), false); assert.match(test.newClientKey(), /^key-/);
  state.sourceAccess.set("gone", {}); test.pruneSourceAccess();
  test.rememberImportedSource({ clientKey: "key", entry: { file: file("a.png"), fileHandle: {}, parentHandle: {} }, data: { imported: [{ clientKey: "key", imageId: "one" }, { clientKey: "other", imageId: "two" }] } });

  images = []; state.images = images; state.importSession = null; state.importing = false;
  await test.importFiles([{ file: file("a.png"), relativePath: "a.png", fileHandle: null, parentHandle: null }, file("bad.gif")]);
  const normalProcessing = context.showProcessing;
  context.showProcessing = (payload) => {
    if (payload.current !== "") return;
    state.importSession.paused = true;
    setTimeout(() => { state.importSession.cancelled = true; }, 5);
  };
  await test.importFiles([{ file: file("pause.png"), relativePath: "pause.png", fileHandle: null, parentHandle: null }]);
  context.showProcessing = normalProcessing;
  const originalFetch = context.fetch;
  context.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error_code: "input_invalid" }) });
  await assert.rejects(test.importSingleFile({ file: file("a.png"), relativePath: "a.png" }, "k"), (error) => error?.code === "input_invalid");
  context.fetch = originalFetch;
  const importSession = test.beginImportSession(); assert.ok(importSession); test.finishImportSession(importSession); assert.equal(await test.waitForImportSession({ paused: false, cancelled: false }), false);
  const handles = [{ name: "a.png", getFile: async () => file("a.png") }]; await test.importFileHandles(handles);
  // A restored browser project must upload each old source under the same
  // durable source ID; otherwise its masks/history would be duplicated.
  const sourceIds = [];
  const apiBeforeProjectRestore = context.api;
  context.fetch = async (_url, options) => {
    sourceIds.push(options.headers["X-Mozarie-Source-Id"]);
    return { ok: true, status: 200, json: async () => ({ imported: [], catalogId: "project", provisional: false }) };
  };
  context.api = async (url) => url === "/api/images" ? { images } : {};
  state.importing = false; state.importSession = null;
  await test.importProjectFileHandles([
    { sourceId: "source-a", handle: { name: "a.png", getFile: async () => file("a.png") } },
    { sourceId: "source-a", handle: { name: "b.png", getFile: async () => file("b.png") } },
    { sourceId: "source-b", handle: { name: "c.png", getFile: async () => file("c.png") } },
  ], "project");
  assert.deepEqual(sourceIds, ["source-a", "source-a", "source-b"], "reopening browser files keeps their original source groups and does not duplicate project images");
  context.fetch = originalFetch; context.api = apiBeforeProjectRestore;
  const nestedDirectory = { name: "folder", kind: "directory", async *values() { yield directory; } };
  await test.importDirectoryHandle(nestedDirectory);
  state.importing = false; state.importSession = null;
  await test.importProjectDirectoryHandle(nestedDirectory, "project", "source-directory");
  context.window.showOpenFilePicker = async () => handles; await test.pickImageFiles();
  context.window.showOpenFilePicker = async () => { const error = new Error(); error.name = "AbortError"; throw error; }; await test.pickImageFiles();
  context.window.showDirectoryPicker = async () => directory; await test.pickImageDirectory();
  await test.importDroppedFiles({ ...event(""), dataTransfer: { items: [] } });
  vm.runInNewContext("directFilesFromDrop = async () => [];", context);
  await test.importDroppedFiles({ ...event(""), dataTransfer: { items: [] } }); test.setGalleryDropOverlay(true);

  state.viewMode = "edit"; state.settings.shortcuts.bindings = { undo: "U", redo: "R", previous: "P", next: "N", previousVisible: "PV", nextVisible: "NV", first: "F", last: "L", reviewAndNext: "RN", toggleOverview: "G" };
  state.settings.shortcuts.actions = {};
  for (const binding of ["U", "R", "P", "N", "PV", "NV", "F", "L", "RN", "G"]) test.handleWindowKeydown(event(binding));
  assert.equal(test.navigationShortcutAction(event("unknown")), null);

  // Guard, cancellation, and stale-result paths are observable UI outcomes,
  // so drive them separately instead of bypassing them with test-only flags.
  busy = true;
  test.setTool("brush"); test.updateBrushSize(3); await test.clearMasks(["one"], "a", "b"); await test.clearCatalog();
  test.openCatalogContextMenu(event("", "contextmenu"), "one"); await test.removeImageFromCatalog("one"); await test.runSelectionAction("hide");
  assert.equal(test.beginImportSession(), null); await test.importFileHandles([], null); await test.importDirectoryHandle(directory, null);
  await test.pickImageFiles(); await test.pickImageDirectory(); await test.importDroppedFiles({ ...event(""), dataTransfer: { items: [] } });
  assert.equal(test.handleEditorKeydown(event("U")), false); assert.equal(test.navigationShortcutAction(event("P")), null);
  busy = false;
  state.currentImage = null; test.resetCurrentDraft();
  state.settings.confirmations.clearMasks = true; element("#confirmDialog").returnValue = ""; await test.clearMasks(["one"], "a", "b");
  state.settings.confirmations.clearCatalog = true; await test.clearCatalog(); element("#confirmDialog").returnValue = "confirm";
  const originalDocumentElement = document.documentElement; document.documentElement = null;
  test.positionCatalogContextMenu(element("#catalogContextMenu"), 1, 1); document.documentElement = originalDocumentElement;
  state.images = [{ id: "one", sourcePath: "C:/one.png", hidden: true }]; images = state.images; state.currentId = "other"; document.activeElement = null;
  test.openCatalogContextMenu({ ...event("", "keydown"), currentTarget: null, clientX: NaN, clientY: NaN }, "one");
  test.openCatalogContextMenu(event("", "contextmenu"), "missing");
  state.contextMenuImageId = "missing"; await test.copyContextMenuImagePath();
  await test.removeImageFromCatalog(); await test.removeImageFromCatalog("missing");
  state.selectedImageIds.clear(); await test.runSelectionAction("hide");
  test.rememberImportedSource({ clientKey: "none", entry: {}, data: {} });
  await test.importFiles([], {});
  await test.importFiles([{ name: "name-only.png" }]);
  const originalApi = context.api;
  context.api = async (url) => {
    if (url === "/api/workspace/catalog") return { catalogId: null, provisional: false };
    if (url === "/api/images") return { images: [] };
    return {};
  };
  state.images = []; images = state.images; state.importing = false; state.importSession = null;
  await test.importFiles([{ file: file("fallback.png"), fileHandle: null }]);
  context.api = originalApi;
  const originalQuery = document.querySelector;
  document.querySelector = () => null;
  await test.importSingleFile({ file: file("no-token.png"), relativePath: "no-token.png" }, "k");
  document.querySelector = originalQuery;
  context.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(test.importSingleFile({ file: file("error.png"), relativePath: "error.png" }, "k"), (error) => error?.code === "internal_error");
  context.fetch = originalFetch;
  test.remapImportedImageIds({}); state.currentId = "old"; state.pendingImageId = "old"; test.remapImportedImageIds({ old: "new" });
  assert.equal(await test.waitForImportSession({ paused: false, cancelled: true }), false);
  const noNameDirectory = { kind: "directory", async *values() {} };
  await test.importDirectoryHandle(noNameDirectory);
  context.window.showOpenFilePicker = async () => { throw new Error("picker failed"); }; await test.pickImageFiles();
  context.window.showDirectoryPicker = async () => { throw new Error("directory failed"); }; await test.pickImageDirectory();
  vm.runInNewContext("directFilesFromDrop = async () => { throw new Error('drop failed'); };", context);
  await test.importDroppedFiles({ ...event(""), dataTransfer: { items: [] } });
  editable = true; assert.equal(test.handleEditorKeydown(event("U")), false); editable = false; dialogOpen = true; assert.equal(test.navigationShortcutAction(event("P")), null); dialogOpen = false;
  gesture = true; assert.equal(test.navigationShortcutAction(event("P")), null); gesture = false;
  state.viewMode = "overview"; assert.equal(test.handleEditorKeydown(event("U")), false); assert.equal(test.navigationShortcutAction(event("P")), null); state.viewMode = "edit";
  state.images = []; test.handleNavigationKeydown(event("F")); test.handleNavigationKeydown(event("L"));

  element("#boundaryModeMenu").hidden = false; document.activeElement = element("#boundaryModeMenu"); test.setTool("mosaic_eraser");
  const normalBlockSize = context.calculatedBlockSize; context.calculatedBlockSize = () => 0; test.updateBlockSizeDisplay(); context.calculatedBlockSize = normalBlockSize;
  const savedSettings = state.settings; state.settings = null; assert.equal(test.confirmationRequired("old"), true); assert.equal(test.confirmationRequired("candidateDelete"), false); state.settings = savedSettings;
  state.images = [{ id: "one" }]; images = state.images; state.settings.confirmations.clearMasks = false;
  const apiForClear = context.api;
  context.api = async (url) => { if (url === "/api/masks/clear") { state.catalogEpoch += 1; return {}; } return { images }; };
  await test.clearMasks(["one"], "a", "b");
  context.api = async () => { throw new Error("clear failed"); }; await test.clearMasks(["one"], "a", "b");
  state.images = [{ id: "one" }]; images = state.images; state.settings.confirmations.clearCatalog = false;
  context.api = async (url) => { if (url === "/api/catalog/clear") { state.catalogEpoch += 1; return {}; } return {}; }; await test.clearCatalog();
  state.images = [{ id: "one" }]; images = state.images; context.api = async () => { throw new Error("catalog failed"); }; await test.clearCatalog(); context.api = apiForClear;
  state.reviewedPaths.add("one"); state.images = [{ id: "one", sourcePath: "C:/one.png", hidden: true }]; images = state.images; document.activeElement = element("#origin");
  test.openCatalogContextMenu({ ...event("", "contextmenu"), clientX: NaN, clientY: NaN }, "one");
  state.settings.confirmations.removeImage = true; element("#confirmDialog").returnValue = ""; await test.removeImageFromCatalog("one"); element("#confirmDialog").returnValue = "confirm";
  state.settings.confirmations.removeImage = false; state.images = [{ id: "one" }]; images = state.images; state.currentId = "one";
  context.api = async (url) => { if (url.startsWith("/api/catalog/image/")) { state.catalogEpoch += 1; return { images: [] }; } return {}; }; await test.removeImageFromCatalog("one");
  state.images = [{ id: "one" }]; images = state.images; context.api = async () => { throw new Error("remove failed"); }; await test.removeImageFromCatalog("one"); context.api = apiForClear;
  test.rememberImportedSource({ clientKey: "parentless", entry: { file: file("p.png"), fileHandle: {} }, data: { imported: [{ clientKey: "parentless", imageId: "p" }] } });
  await test.importFiles([{}]);
  const importOriginal = context.importSingleFile;
  vm.runInNewContext("importSingleFile = async (entry) => { state.importSession = {}; return {}; };", context);
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("stale.png"), relativePath: "stale.png" }]);
  vm.runInNewContext("importSingleFile = async (entry) => ({ catalogId: null, provisional: false });", context);
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("skip.gif"), relativePath: "skip.gif" }]);
  const apiFinalFallback = context.api;
  context.api = async (url) => {
    if (url === "/api/workspace/catalog") return { catalogId: "p", provisional: true };
    if (url === "/api/workspace/catalog/finalize") return {};
    if (url === "/api/images") return { images: [] };
    return {};
  };
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("final.png") }]);
  context.api = apiFinalFallback; vm.runInNewContext("importSingleFile = undefined;", context);
  state.currentId = "unmapped"; state.pendingImageId = "unmapped"; test.remapImportedImageIds({ old: "new" });
  const waiting = { paused: true, cancelled: false }; setTimeout(() => { waiting.cancelled = true; }, 5); assert.equal(await test.waitForImportSession(waiting), false);
  const cancelledSession = test.beginImportSession(); cancelledSession.cancelled = true; await test.importDirectoryHandle(directory, cancelledSession);
  state.settings = null; state.viewMode = "edit"; test.handleEditorKeydown(event("Ctrl+Z")); test.handleNavigationKeydown(event("unknown")); test.handleNavigationKeydown(event("G")); state.viewMode = "overview"; test.handleNavigationKeydown(event("G"));
  state.settings = savedSettings; state.settings.shortcuts.bindings = { first: "F", last: "L", undo: "U", redo: "R" }; state.settings.shortcuts.actions = {}; state.viewMode = "edit"; state.images = [{ id: "one" }];
  test.handleNavigationKeydown(event("F")); test.handleNavigationKeydown(event("L")); test.handleNavigationKeydown(event("U")); test.handleNavigationKeydown(event("R"));
  state.settings = { confirmations: null }; assert.equal(test.confirmationRequired("legacy"), true); state.settings = savedSettings;
  state.settings = { confirmations: { legacy: false } }; assert.equal(test.confirmationRequired("legacy"), false); state.settings = savedSettings;
  state.images = [{ id: "one" }]; images = state.images; state.settings.confirmations.clearMasks = false;
  context.api = async (url) => { if (url === "/api/images") { state.catalogEpoch += 1; return { images }; } return {}; }; await test.clearMasks(["one"], "a", "b"); context.api = apiForClear;
  state.images = [{ id: "one" }]; images = state.images; state.settings.confirmations.clearCatalog = true; element("#confirmDialog").returnValue = ""; await test.clearCatalog(); element("#confirmDialog").returnValue = "confirm"; state.settings.confirmations.clearCatalog = false;
  state.images = [{ id: "one" }]; images = state.images; state.currentId = "one"; context.api = async (url) => url.startsWith("/api/catalog/image/") ? { images: [] } : {}; await test.removeImageFromCatalog("one"); context.api = apiForClear;
  state.images = [{ id: "one" }, { id: "two" }]; images = state.images; state.currentId = "two"; context.api = async (url) => url.startsWith("/api/catalog/image/") ? { images: [images[0]] } : {}; await test.removeImageFromCatalog("two"); context.api = apiForClear;
  vm.runInNewContext("importSingleFile = async () => ({ catalogId: null, provisional: false });", context);
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => { state.importSession = {}; return file('mismatch.png'); }, relativePath: "mismatch.png" }]);
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("skip.gif"), relativePath: "skip.png" }]);
  let provisionalRequests = 0;
  context.api = async (url) => {
    if (url === "/api/workspace/catalog" || url === "/api/workspace/catalog/finalize") { provisionalRequests += 1; return { catalogId: "p", provisional: true }; }
    if (url === "/api/images") return { images: [] };
    return {};
  };
  state.images = []; images = state.images; state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("final.png"), relativePath: "final.png" }]);
  assert.equal(provisionalRequests, 0, `ordinary imports never create a provisional project: ${JSON.stringify(calls.slice(-4))}`);
  context.fetch = async () => { throw new Error("network"); }; context.api = async () => { throw new Error("refresh"); };
  state.importing = false; state.importSession = null; await test.importFiles([{ getFile: async () => file("failure.png"), relativePath: "failure.png" }]);
  context.fetch = originalFetch; context.api = apiForClear;
  console.log("test_interaction_coverage: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
