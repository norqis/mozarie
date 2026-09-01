const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const jsRoot = path.join(__dirname, "..", "static", "js");

function classList() {
  const values = new Set();
  return {
    contains(value) { return values.has(value); },
    toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); },
  };
}

function element(children = {}) {
  const attributes = new Map();
  const node = {
    attributes, children: [], classList: classList(), dataset: {}, disabled: false, hidden: false,
    textContent: "", title: "", value: "", style: {}, tabIndex: -1, scrollTop: 0,
    append(child) { this.children.push(child); child.parentNode = this; },
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.removed = true; },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    querySelector(selector) { return children[selector] || null; },
    scrollIntoView(options) { this.scrolled = options; },
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); }, showModal() { this.open = true; }, close() { this.open = false; },
  };
  return node;
}

function galleryItem(scope) {
  const preview = element();
  const name = element();
  const meta = element();
  const badge = element();
  const item = element({ img: preview, ".gallery-name": name, ".gallery-meta": meta, ".gallery-review-badge": badge });
  item.scope = scope;
  return item;
}

function overviewItem() {
  const preview = element();
  return element({
    img: preview,
    ".overview-item-name": element(),
    ".overview-item-dimensions": element(),
    ".overview-review-badge": element(),
  });
}

function makeGalleryRuntime() {
  const nodes = new Map();
  const gallery = element();
  const overviewGrid = element();
  const overviewFolder = element();
  const overviewButtons = [element(), element()];
  overviewButtons[0].dataset.overviewFilter = "all";
  overviewButtons[1].dataset.overviewFilter = "masked";
  nodes.set("#gallery", gallery); nodes.set("#overviewGrid", overviewGrid); nodes.set("#overviewFolder", overviewFolder);
  nodes.set("#galleryFilter", element()); nodes.set("#galleryEmptyState", element()); nodes.set("#galleryFilteredEmptyState", element());
  nodes.set("#overviewCount", element()); nodes.set("#overviewEmptyState", element()); nodes.set("#overviewPane", element());
  nodes.set(".studio-grid", element()); nodes.set("#imagePosition", element()); nodes.set("#reviewStatus", element());
  nodes.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode() { return galleryItem("gallery"); } } } });
  nodes.set("#overviewItemTemplate", { content: { firstElementChild: { cloneNode() { return overviewItem(); } } } });
  const selected = []; const prefetched = []; const menus = []; const calls = [];
  const observers = [];
  const state = {
    images: [], currentId: null, viewMode: "edit", galleryFilter: "all", overviewFilter: "all", overviewFolder: "", overviewQuery: "",
    galleryNodes: new Map(), overviewNodes: new Map(), selectedImageIds: new Set(), selectionAnchorId: null, batchMode: false, viewGeneration: 0,
  };
  const frames = [];
  const document = {
    querySelector(selector) { return nodes.get(selector) || null; },
    querySelectorAll(selector) { return selector === ".gallery-local-count" ? [element(), element()] : selector === ".overview-filter" ? overviewButtons : []; },
    createElement() { return element(); },
  };
  const context = {
    codedError(code) { const error = new Error(); error.code = code; return error; },
    console, Map, Set, Array, Math, String, Object, document, encodeURIComponent, window: { addEventListener() {} },
    IntersectionObserver: class { constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); } observe(image) { this.observed = image; } unobserve(image) { image.unobserved = true; } },
    state, $: (selector) => nodes.get(selector), $$: () => [],
    t(key, values = {}) { return `${key}:${Object.values(values).join(",")}`; },
    imageAssetVersion(image) { return image.assetVersion || ""; },
    isHidden(image) { return Boolean(image?.hidden); }, isReviewed(image) { return Boolean(image?.reviewed); }, imageHasMask(image) { return Boolean(image?.masked); },
    selectCatalogImage(id) { selected.push(id); }, schedulePrefetch(image) { prefetched.push(`schedule:${image.id}`); }, prefetchNeighbors(image) { prefetched.push(`neighbors:${image.id}`); },
    openCatalogContextMenu(_event, id) { menus.push(id); }, updateActionButtons() { calls.push("actions"); }, updateSelectionActionBar() { calls.push("selection"); },
    setViewMode(mode) { calls.push(`stub-view:${mode}`); }, closeBatchMoreMenus() { calls.push("close-menu"); }, clearBatchSelection() { state.selectedImageIds.clear(); calls.push("clear-selection"); },
    discardCatalogNodes(map, parent) { for (const node of map.values()) node.remove(); map.clear(); parent.discarded = true; }, resizeRenderCanvas() { calls.push("resize"); }, focusCanvas() { calls.push("focus-canvas"); }, focusElement(node) { node.focused = true; },
    requestAnimationFrame(callback) { frames.push(callback); }, isGestureActive() { return Boolean(context.gesture); }, currentRecord() { return state.images.find((image) => image.id === state.currentId) || null; },
    imageIndex(id = state.currentId) { return state.images.findIndex((image) => image.id === id); },
    async selectImage(id) { selected.push(`image:${id}`); }, async setReviewed(image, value) { image.reviewed = value; return context.reviewResult; }, async setHidden(image, value) { image.hidden = value; return context.hideResult; },
  };
  context.reviewResult = true; context.hideResult = true;
  const source = fs.readFileSync(path.join(jsRoot, "gallery.js"), "utf8");
  vm.runInNewContext(source, context, { filename: path.join(jsRoot, "gallery.js") });
  vm.runInNewContext("globalThis.__galleryTest = { thumbnailObserver, thumbnailSource, loadThumbnail, observeThumbnail, forgetThumbnail, catalogWindow, focusCatalogIndex, renderGallery, imageMatchesGalleryFilter, updateGalleryCurrent, overviewFolderOptions, overviewImages, syncOverviewFolders, selectOverviewImage, renderOverview, renderCatalogViews, setViewMode, moveCurrentBy, reviewAndMoveNext, hideAndMoveNext, runNavigationAction, updateNavigationControls, thumbnailObservers, catalogWindows, catalogMoveIndex, resetCatalogWindows, scrollCatalogImage };", context, { filename: "test-gallery-exports.js" });
  return { ...context.__galleryTest, calls, context, document, frames, gallery, menus, nodes, observers, overviewGrid, prefetched, selected, state };
}

async function galleryInteractions() {
  const runtime = makeGalleryRuntime();
  const { state } = runtime;
  const first = { id: "one", relativePath: "sets/one.png", width: 100, height: 80, assetVersion: "v 1", reviewed: true, masked: true };
  const second = { id: "two", relativePath: "sets\\sub\\two.png", width: 60, height: 50, hidden: true };
  const third = { id: "three", relativePath: "three.png", width: 20, height: 10 };
  state.images = [first, second, third]; state.currentId = "one";

  assert.equal(runtime.thumbnailSource(first), "/api/thumbnail/one?v=v%201");
  assert.equal(runtime.thumbnailSource(third), "/api/thumbnail/three");
  const standalone = element(); runtime.loadThumbnail(standalone); assert.equal(standalone.src, undefined);
  standalone.dataset.src = "thumb"; runtime.loadThumbnail(standalone); assert.equal(standalone.src, "thumb"); runtime.loadThumbnail(standalone);
  runtime.observeThumbnail(standalone, first); assert.equal(standalone.loading, "lazy");
  const observer = runtime.observers.at(-1); observer.callback([{ isIntersecting: false, target: standalone }, { isIntersecting: true, target: standalone }]);
  runtime.observeThumbnail(standalone, first);
  assert.equal(standalone.src, "/api/thumbnail/one?v=v%201"); runtime.forgetThumbnail(standalone); runtime.forgetThumbnail(null);

  runtime.renderGallery();
  assert.equal(runtime.gallery.children.length, 4, "the fixed-row window keeps one spacer plus the mounted cards");
  const galleryWindow = runtime.catalogWindows.get("gallery");
  galleryWindow.frame = 1;
  runtime.gallery.listeners.get("scroll")();
  assert.equal(runtime.frames.length, 0, "a queued gallery render coalesces another scroll event");
  galleryWindow.frame = 0;
  runtime.focusCatalogIndex(galleryWindow, -1);
  runtime.scrollCatalogImage("missing", "one");
  runtime.gallery.clientHeight = 30;
  const scrollCases = [
    [0, "one"],
    [500, "three"],
    [0, "three"],
    [290, "three"],
  ];
  for (const [scrollTop, imageId] of scrollCases) {
    runtime.gallery.scrollTop = scrollTop;
    runtime.scrollCatalogImage("gallery", imageId);
  }
  const firstNode = state.galleryNodes.get("one");
  assert.equal(firstNode.getAttribute("aria-current"), "true"); assert.match(firstNode.getAttribute("aria-label"), /sets\/one/);
  firstNode.onclick(); firstNode.onmouseenter(); firstNode.oncontextmenu({});
  const secondaryPointer = { button: 2, preventDefault() { this.prevented = true; } }; firstNode.onpointerdown(secondaryPointer);
  assert.equal(secondaryPointer.prevented, true, "a secondary pointer press is consumed before it can move catalog focus");
  firstNode.onkeydown({ key: "Enter", preventDefault() { this.prevented = true; } });
  firstNode.onkeydown({ key: " ", preventDefault() {} }); firstNode.onkeydown({ key: "ContextMenu" }); firstNode.onkeydown({ key: "F10", shiftKey: true });
  assert.deepEqual(runtime.selected.slice(0, 3), ["one", "one", "one"]); assert.equal(runtime.menus.length, 3); assert.equal(runtime.prefetched.length, 2);
  for (const [filter, expected] of [["hidden", true], ["masked", true], ["unmasked", true], ["reviewed", true], ["unreviewed", true], ["all", true]]) {
    state.galleryFilter = filter; assert.equal(runtime.imageMatchesGalleryFilter(filter === "hidden" ? second : filter === "masked" || filter === "reviewed" ? first : third), expected);
  }
  state.galleryFilter = "masked"; runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["one"]);
  state.galleryFilter = "hidden"; runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["two"]);
  state.galleryFilter = "reviewed"; runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["one"]);
  first.masked = false; state.galleryFilter = "masked"; runtime.renderGallery(); assert.equal(runtime.nodes.get("#galleryFilteredEmptyState").hidden, false); first.masked = true;
  state.images = []; runtime.renderGallery(); assert.equal(runtime.nodes.get("#galleryEmptyState").hidden, false);
  state.images = [first, second, third]; state.galleryFilter = "all"; state.viewMode = "overview"; const before = runtime.gallery.children.length; runtime.renderGallery(); assert.equal(runtime.gallery.children.length, before); runtime.renderGallery(true);
  state.viewMode = "edit"; runtime.renderGallery(true);
  runtime.document.createElement = null; state.images = [first]; runtime.renderGallery(true);
  assert.deepEqual([...state.galleryNodes.keys()], ["one"], "the gallery keeps the current catalog when DOM creation is unavailable");
  runtime.document.createElement = () => element(); state.images = [first, second, third]; runtime.renderGallery(true);
  state.currentId = "two"; runtime.updateGalleryCurrent(); assert.ok(true, "current-image update tolerates an inactive virtual window");
  runtime.renderCatalogViews();

  const navigationWindow = { images: Array.from({ length: 12 }, (_, index) => ({ id: `logical-${index}` })), container: { clientWidth: 500, clientHeight: 50 }, options: { columns: 5, minWidth: 1, padding: 0, gap: 0, rowHeight: 10 } };
  assert.equal(runtime.catalogMoveIndex({ ...navigationWindow, images: [] }, 0, { key: "ArrowRight" }), -1, "empty virtual catalogs have no keyboard target");
  assert.equal(runtime.catalogMoveIndex({ ...navigationWindow, container: { clientWidth: 500, clientHeight: 0 } }, 7, { key: "PageUp" }), 2, "zero-height catalogs retain a one-row page");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 0, { key: "ArrowLeft" }), 0, "Left keeps focus at the first logical card");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 0, { key: "ArrowRight" }), 1, "Right moves to the next logical card");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "ArrowUp" }), 2, "Up moves one virtual row");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "ArrowDown" }), 11, "Down clamps to the final virtual row");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "PageUp" }), 0, "PageUp clamps at the catalog start");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 2, { key: "PageDown" }), 12 - 1, "PageDown clamps at the catalog end");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "x" }), -1, "unmapped keys leave virtual focus unchanged");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "Home" }), 5, "Home moves to the current logical row start");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "End" }), 9, "End moves to the current logical row end");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 11, { key: "Home" }), 10, "Home handles the first cell of an incomplete final row");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 10, { key: "End" }), 11, "End handles the last cell of an incomplete final row");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "Home", ctrlKey: true }), 0, "Ctrl+Home moves to the filtered grid start");
  assert.equal(runtime.catalogMoveIndex(navigationWindow, 7, { key: "End", ctrlKey: true }), 11, "Ctrl+End moves to the filtered grid end");

  const catalogImages = state.images;
  runtime.gallery.clientWidth = 360; runtime.gallery.clientHeight = 152;
  state.images = Array.from({ length: 800 }, (_, index) => ({ id: `window-${index}`, relativePath: `set/${index}.png`, width: 100, height: 100 }));
  state.galleryFilter = "all"; runtime.renderGallery(true);
  assert.ok(state.galleryNodes.size < 40, "the fixed-row gallery mounts only a small scroll window");
  runtime.gallery.scrollTop = 152 * 120; runtime.renderGallery(true);
  assert.ok(state.galleryNodes.has("window-360"), "scrolling remounts the logical row at the new position");
  runtime.gallery.scrollTop = 0; runtime.scrollCatalogImage("gallery", "window-0");
  assert.equal(runtime.gallery.scrollTop, 0, "selecting the first visible card keeps the gallery at its first row");
  runtime.scrollCatalogImage("gallery", "window-3");
  const visibleTop = runtime.gallery.scrollTop;
  runtime.scrollCatalogImage("gallery", "window-4");
  assert.equal(runtime.gallery.scrollTop, visibleTop, "selecting another visible card does not recenter the gallery");
  runtime.scrollCatalogImage("gallery", "missing");
  state.images = catalogImages; state.galleryFilter = "all"; runtime.gallery.scrollTop = 0; runtime.renderGallery(true);

  runtime.gallery.scrollTop = 999; runtime.overviewGrid.scrollTop = 555;
  runtime.renderGallery(true); runtime.renderOverview(true);
  runtime.resetCatalogWindows();
  assert.equal(runtime.gallery.scrollTop, 0, "replacing a catalog returns the gallery to its first row");
  assert.equal(runtime.overviewGrid.scrollTop, 0, "replacing a catalog returns the overview to its first row");
  assert.equal(runtime.catalogWindows.get("gallery").focusId, null, "replacing a catalog clears its virtual gallery focus");
  assert.equal(runtime.catalogWindows.get("overview").focusId, null, "replacing a catalog clears its virtual overview focus");

  assert.deepEqual([...runtime.overviewFolderOptions()], ["sets", "sets/sub"]);
  state.overviewFilter = "all"; state.overviewFolder = "sets"; state.overviewQuery = "two"; assert.deepEqual(runtime.overviewImages().map((image) => image.id), ["two"]);
  state.overviewFolder = ""; state.overviewQuery = "";
  for (const [filter, expected] of [["hidden", ["two"]], ["reviewed", ["one"]], ["unreviewed", ["three"]], ["masked", ["one"]], ["unmasked", ["three"]]]) { state.overviewFilter = filter; assert.deepEqual(runtime.overviewImages().map((image) => image.id), expected); }
  state.overviewFilter = "all"; state.overviewFolder = "missing"; runtime.syncOverviewFolders(); assert.equal(state.overviewFolder, "");
  state.viewMode = "overview"; state.batchMode = false; runtime.selectOverviewImage("one"); assert.deepEqual(runtime.selected.at(-1), "one");
  state.batchMode = true; runtime.selectOverviewImage("one", {}); assert.equal(state.selectedImageIds.has("one"), true); runtime.selectOverviewImage("one", {}); assert.equal(state.selectedImageIds.has("one"), false);
  runtime.selectOverviewImage("one", {}); runtime.selectOverviewImage("three", { ctrlKey: true }); runtime.selectOverviewImage("two", { shiftKey: true }); assert.deepEqual([...state.selectedImageIds], ["two", "three"]);
  runtime.selectOverviewImage("three", { shiftKey: true, ctrlKey: true }); assert.equal(state.selectedImageIds.has("three"), true); runtime.selectOverviewImage("gone", {});
  state.currentId = "one"; state.selectedImageIds = new Set(["one"]); runtime.renderOverview(true); const overviewNode = state.overviewNodes.get("one");
  assert.equal(overviewNode.getAttribute("aria-pressed"), "true"); overviewNode.onclick({}); overviewNode.oncontextmenu({}); overviewNode.onkeydown({ key: "Enter", preventDefault() {} }); overviewNode.onkeydown({ key: "F10", shiftKey: true });
  state.overviewFilter = "hidden"; runtime.renderOverview(true); assert.deepEqual([...state.overviewNodes.keys()], ["two"]);
  state.overviewFilter = "all"; runtime.renderOverview(true);
  const savedGrid = runtime.nodes.get("#overviewGrid"); runtime.nodes.delete("#overviewGrid"); runtime.renderOverview(true); runtime.nodes.set("#overviewGrid", savedGrid);

  state.viewMode = "edit"; state.galleryNodes.set("one", galleryItem("gallery")); runtime.setViewMode("overview"); assert.equal(state.viewMode, "overview"); runtime.frames.shift()(); assert.equal(runtime.nodes.get("#overviewPane").focused, true);
  runtime.setViewMode("edit"); assert.equal(state.viewMode, "edit"); runtime.setViewMode("overview"); const stale = runtime.frames.pop(); state.viewMode = "edit"; stale();
  state.currentId = "one"; runtime.context.gesture = true; runtime.moveCurrentBy(1); runtime.context.gesture = false; runtime.moveCurrentBy(1); assert.deepEqual(runtime.selected.at(-1), "image:three");
  runtime.context.gesture = true; assert.equal(await runtime.reviewAndMoveNext(), null); runtime.context.gesture = false; state.currentId = "missing"; assert.equal(await runtime.reviewAndMoveNext(), null); state.currentId = "one"; runtime.context.reviewResult = false; assert.equal(await runtime.reviewAndMoveNext(), null); runtime.context.reviewResult = true; assert.equal((await runtime.reviewAndMoveNext()).id, "three"); state.currentId = "three"; assert.equal(await runtime.reviewAndMoveNext(), null);
  runtime.context.gesture = true; await runtime.hideAndMoveNext(); runtime.context.gesture = false; state.currentId = "missing"; await runtime.hideAndMoveNext(); state.currentId = "one"; runtime.context.hideResult = false; await runtime.hideAndMoveNext(); runtime.context.hideResult = true; await runtime.hideAndMoveNext(); state.currentId = "three"; await runtime.hideAndMoveNext();
  await runtime.runNavigationAction(async () => runtime.calls.push("navigate")); assert.ok(runtime.calls.includes("focus-canvas"));
  state.currentId = "one"; runtime.updateNavigationControls(); assert.match(runtime.nodes.get("#imagePosition").textContent, /1/); first.reviewed = false; runtime.updateNavigationControls(); state.currentId = null; runtime.updateNavigationControls(); assert.equal(runtime.nodes.get("#imagePosition").textContent, "- / -");
}

function makeSaveRuntime() {
  const nodes = new Map();
  const ids = ["#applyResult", "#applyStartButton", "#deleteOriginal", "#removeAfterSave", "#applySuffix", "#applyTargetMode", "#applyTargetCount", "#applyDivisor", "#divisor", "#applySuffixRow", "#deleteOriginalRow", "#applyOutputDirectoryRow", "#chooseOutputDirectoryButton", "#applyOutputDirectoryStatus", "#applyTemporarySourceNote", "#applyOverwriteMode", "#applyOverwriteRow", "#settingsDefaultOutputDirectory", "#settingsChooseOutputDirectory", "#applyProgress", "#applyCurrentName", "#applyProgressText", "#applyPauseButton", "#applyCancelButton", "#applyCloseButton", "#applySettings", "#applyProgressPanel", "#applyDialog", "#singleSaveOutputDirectoryStatus", "#singleSaveResult", "#singleSaveSuffixRow", "#singleSaveDeleteOriginalRow", "#singleSaveOutputDirectoryRow", "#singleSaveOverwriteMode", "#singleSaveOverwriteRow", "#singleSaveDeleteOriginal", "#singleSaveChooseOutputDirectoryButton", "#singleSaveStartButton", "#singleSaveSettings", "#singleSaveCopyMode", "#singleSaveSuffix", "#singleSaveDialog"];
  for (const id of ids) nodes.set(id, element());
  nodes.get("#applyTargetMode").value = "masked"; nodes.get("#applyDivisor").value = "16"; nodes.get("#divisor").value = "16"; nodes.get("#applySuffix").value = "_m";
  const saveMode = element(); saveMode.value = "copy"; const singleSaveMode = element(); singleSaveMode.value = "copy";
  const errors = []; const calls = []; const requests = [];
  const state = {
    sourceAccess: new Map(), applyTargetIds: ["file"], images: [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }, { id: "session", sourceKind: "session", relativePath: "session.png" }],
    settings: { saving: { default_output_directory: "G:/out", parallelism: 1 }, detection: { exclude_forced_default: true } }, drafts: new Map(), maskStatus: new Map(), selectedImageIds: new Set(), candidateUpdateChains: new Map(),
    applyRunning: false, saveStarting: false, outputDirectoryPicking: false, outputDirectoryHandle: null, importing: false, saving: false, currentId: null, candidates: [], catalogEpoch: 1, imageGeneration: 0, pageLoadedAt: 1, job: { kind: "idle", state: "idle" },
  };
  let handler = async (url) => {
    if (url === "/api/images") return { images: state.images };
    if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] };
    if (url === "/api/save/commit") return { cleared: false, stale: false };
    return {};
  };
  const context = {
    codedError(code) { const error = new Error(); error.code = code; return error; },
    console, Map, Set, Array, Math, Number, Boolean, JSON, Promise, Uint8Array, Error, DOMException, window: { showDirectoryPicker: async () => ({ name: "picked", async queryPermission() { return "granted"; } }) }, navigator: { locks: { async request(_name, _options, callback) { return callback(); } } }, document: { activeElement: nodes.get("#applyStartButton"), querySelector(selector) { if (selector === 'input[name="batchSaveMode"]:checked') return saveMode; if (selector === 'input[name="singleSaveMode"]:checked') return singleSaveMode; if (selector === 'meta[name="mozarie-token"]') return { content: "token" }; return nodes.get(selector); } },
    state, $: (selector) => nodes.get(selector), t(key, values = {}) { return `${key}:${Object.values(values).join(",")}`; }, api(url, options) { requests.push({ url, options }); return handler(url, options); },
    fetch(url, options) { return handler(url, options); }, setTimeout(callback, delay) { if (delay === 150) callback(); return 1; }, clearTimeout() {},
    showUserError(error) { errors.push(error); }, userErrorCode(error) { return error?.code || "internal_error"; }, showModalFromInvoker(node) { node.open = true; }, setSettingsForm(settings) { state.settings = settings; }, async rememberOutputDirectoryHandle() {},
    saveTargets() { return state.applyTargetIds; }, isBusy() { return Boolean(context.busy); }, async flushDraftSaves() { if (context.flushError) throw context.flushError; }, async waitForCandidateMutations() { calls.push("wait-candidates"); }, updateBlockSizeDisplay() { calls.push("block-size"); },
    updateActionButtons() { calls.push("actions"); }, releaseCandidateBundles(id) { calls.push(`release:${id}`); }, resetCurrentDraft() { calls.push("reset-draft"); }, pruneSourceAccess() { calls.push("prune"); },
    releaseImageCaches(id) { calls.push(`cache:${id}`); }, clearCandidateMutationState(id) { calls.push(`mutation:${id}`); }, clearReviewForRemovedImage() { calls.push("clear-review"); }, clearBatchSelection() { calls.push("clear-batch"); }, clearEditor() { calls.push("clear-editor"); }, renderCatalogViews() { calls.push("catalog"); }, updateSelectionActionBar() { calls.push("selection"); },
    async selectImage(id) { calls.push(`select:${id}`); }, async setReviewed() { calls.push("reviewed"); return true; }, updateNavigationControls() { calls.push("navigation"); }, refreshMaskStatus() { calls.push("mask-status"); }, renderCandidates() { calls.push("candidates"); }, render() { calls.push("render"); },
    isCurrentCatalogEpoch(epoch) { return state.catalogEpoch === epoch; }, isCurrentGeneration(generation) { return state.imageGeneration === generation; }, async moveReviewedPathAfterApply() { calls.push("review-path"); },
    async confirmAction() { return context.confirmed; }, async ensureSaveSources() {}, async runBrowserSave() { calls.push("run-browser"); }, closeProcessing() { calls.push("close-processing"); }, markImagesUnreviewed() { calls.push("unreview"); },
    modalInvokers: new Map(), updateProgress() { calls.push("progress"); }, setStatusKey(key) { calls.push(`status:${key}`); }, scheduleJobPoll() { calls.push("schedule"); },
  };
  context.confirmed = true;
  const source = fs.readFileSync(path.join(jsRoot, "save.js"), "utf8");
  vm.runInNewContext(source, context, { filename: path.join(jsRoot, "save.js") });
  vm.runInNewContext("globalThis.__saveTest = { setApplyResult, showApplyError, isTerminalApply, selectedSaveMode, sourceAccessFor, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, applyRestrictionMessage, syncApplyMode, refreshApplyTargets, openApplyDialog, selectedSingleSaveMode, setSingleSaveResult, syncSingleSaveMode, openSingleSaveDialog, chooseSingleOutputDirectory, singleOutputName, writeSingleOutput, renderSingleSave, startSingleSave, draftPayload, renderOutputDirectory, setOutputDirectoryPickerBusy, pickOutputDirectory, ensureOutputDirectoryPermission, chooseOutputDirectory, waitForBrowserSave, showBrowserSaveProgress, reconcileStoredMaskStatuses, reconcileBrowserSaveState, ensureHandlePermission, ensureSaveSources, writeSourceHandle, removeSourceHandle, snapshotSourceHandle, restoreSourceHandle, removeCompletedImagesFromCatalog, runBrowserSave, commitBrowserSaveWithRetry, cancelBrowserSave, isDefinitiveCommitRejection, startApplyFromDialog, finishSaveStart, controlApply, showRunningApply, finishApplyJob, isTerminalDetection, finishDetectionJob, pollJob, scheduleJobPoll };", context, { filename: "test-save-exports.js" });
  return { ...context.__saveTest, calls, context, errors, nodes, requests, saveMode, singleSaveMode, state, setHandler(fn) { handler = fn; } };
}

async function saveInteractions() {
  const runtime = makeSaveRuntime(); const { state } = runtime;
  runtime.setApplyResult("ok"); assert.equal(runtime.nodes.get("#applyResult").textContent, "ok"); runtime.setApplyResult("bad", true); runtime.showApplyError("bad"); assert.equal(runtime.errors.length, 2);
  assert.equal(runtime.selectedSingleSaveMode(), "copy"); runtime.setSingleSaveResult("single", true); assert.equal(runtime.nodes.get("#singleSaveResult").textContent, "single");
  await runtime.openSingleSaveDialog(null); runtime.context.busy = true; await runtime.openSingleSaveDialog("file"); runtime.context.busy = false; runtime.context.flushError = new Error("draft"); await runtime.openSingleSaveDialog("file"); runtime.context.flushError = null; state.candidateUpdateChains.set("pending", Promise.resolve()); await runtime.openSingleSaveDialog("file"); state.candidateUpdateChains.clear(); assert.equal(state.singleSave.imageId, "file");
  state.singleSave = null; runtime.syncSingleSaveMode(); state.singleSave = { imageId: "missing" }; runtime.syncSingleSaveMode(); state.singleSave = { imageId: "file" }; runtime.singleSaveMode.value = "overwrite"; runtime.syncSingleSaveMode(); runtime.singleSaveMode.value = "copy";
  runtime.syncSingleSaveMode(); assert.equal(runtime.nodes.get("#singleSaveStartButton").disabled, true); state.outputDirectoryHandle = { name: "single-output" }; runtime.syncSingleSaveMode(); assert.equal(runtime.nodes.get("#singleSaveStartButton").disabled, false); state.saving = true; await runtime.chooseSingleOutputDirectory(); state.saving = false;
  runtime.context.window.showDirectoryPicker = async () => { const error = new Error("cancel"); error.name = "AbortError"; throw error; }; await runtime.chooseSingleOutputDirectory(); runtime.context.window.showDirectoryPicker = async () => { throw new Error("picker"); }; await runtime.chooseSingleOutputDirectory(); runtime.context.window.showDirectoryPicker = async () => ({ name: "picked", async queryPermission() { return "granted"; } });
  const supportedPicker = runtime.context.window.showDirectoryPicker; runtime.context.window.showDirectoryPicker = undefined; await assert.rejects(runtime.pickOutputDirectory(), (error) => error.code === "directory_picker_unsupported"); runtime.context.window.showDirectoryPicker = supportedPicker;
  assert.equal(runtime.singleOutputName("nested/file.png", "_m"), "file_m.png"); assert.equal(runtime.singleOutputName("file", "_m", 2), "file_m_2");
  assert.equal(runtime.singleOutputName("", "_m"), "image_m");
  const writeHandle = { async getFileHandle(name, options = {}) { if (!options.create) { const error = new Error("missing"); error.name = "NotFoundError"; throw error; } return { async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } }; }, async removeEntry() {} };
  const writeResponse = { body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } };
  await runtime.writeSingleOutput(writeHandle, "file.png", "_m", writeResponse); const savedLocks = runtime.context.navigator.locks; runtime.context.navigator.locks = null; await assert.rejects(runtime.writeSingleOutput(writeHandle, "file.png", "_m", writeResponse), (error) => error.code === "output_write_unsupported"); runtime.context.navigator.locks = savedLocks;
  runtime.setHandler(async (url) => url === "/api/save/render" ? { ok: false, status: 409, json: async () => ({ error_code: "save_state_changed" }) } : {}); await assert.rejects(runtime.renderSingleSave({}), (error) => error.code === "save_state_changed");
  runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "single-token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") return { cleared: false, stale: false }; if (url === "/api/images") return { images: state.images }; return {}; });
  state.singleSave = { imageId: "file", divisor: 16, draft: null }; state.outputDirectoryHandle = { name: "single-output", async queryPermission() { return "granted"; }, async getFileHandle(name, options = {}) { if (!options.create) { const error = new Error("missing"); error.name = "NotFoundError"; throw error; } return { async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } }; }, async removeEntry() {} }; runtime.nodes.get("#singleSaveSuffix").value = "_m"; await runtime.startSingleSave({ preventDefault() {} });
  assert.equal(runtime.isTerminalApply({ kind: "detect", state: "complete" }), false); state.applyRunning = true; assert.equal(runtime.isTerminalApply({ kind: "apply", state: "complete" }), true); state.applyRunning = false; state.handledApplyStartedAt = 2; assert.equal(runtime.isTerminalApply({ kind: "apply", state: "complete", startedAt: 3 }), true);
  assert.equal(runtime.selectedSaveMode(), "copy"); assert.equal(runtime.sourceAccessFor("missing"), null); assert.equal(runtime.sourceCanOverwrite(state.images[0]), true); assert.equal(runtime.sourceCanDelete(state.images[1]), false); assert.equal(runtime.applyTargetsSupport("overwrite"), true);
  state.applyTargetIds = ["session"]; runtime.saveMode.value = "overwrite"; assert.match(runtime.applyRestrictionMessage(), /overwriteUnavailable/); runtime.syncApplyMode(); assert.equal(runtime.nodes.get("#applyStartButton").disabled, true);
  runtime.saveMode.value = "copy"; runtime.nodes.get("#deleteOriginal").checked = true; assert.match(runtime.applyRestrictionMessage(), /deleteUnavailable/); runtime.syncApplyMode(); assert.equal(runtime.nodes.get("#deleteOriginal").checked, false);
  state.sourceAccess.set("session", { fileHandle: {} }); runtime.syncApplyMode();
  assert.match(runtime.nodes.get("#applyTemporarySourceNote").textContent, /apply\.deleteUnavailable:1/, "temporary sources without a parent handle explain that deletion is unavailable");
  state.applyTargetIds = ["file"]; runtime.nodes.get("#applyTargetMode").value = "current"; runtime.refreshApplyTargets(); assert.equal(state.applyTargetMode, "current");
  runtime.context.busy = true; await runtime.openApplyDialog(); runtime.context.busy = false; runtime.context.flushError = new Error("draft failed"); await runtime.openApplyDialog(); runtime.context.flushError = null;
  state.applyTargetIds = []; await runtime.openApplyDialog([]); state.applyTargetIds = ["file"]; await runtime.openApplyDialog({ initialMode: "masked" }); assert.equal(runtime.nodes.get("#applyDialog").open, true);
  state.drafts.set("file", { add: "add", exclusion: "x", exclusionErase: "erase", manualEnabled: false, manualExclusionEnabled: false, manualExclusionEraseEnabled: false, removedCandidateIds: ["old"] }); assert.deepEqual(JSON.parse(JSON.stringify(runtime.draftPayload(["file", "missing"]))), { file: { add: "", exclusion: "", exclusionErase: "", manualExclusionForced: true, removedCandidateIds: ["old"] } });
  runtime.renderOutputDirectory(); assert.equal(runtime.nodes.get("#settingsDefaultOutputDirectory").value, "G:/out"); runtime.setOutputDirectoryPickerBusy(true); assert.equal(state.outputDirectoryPicking, true); runtime.setOutputDirectoryPickerBusy(false);

  const picked = await runtime.pickOutputDirectory(); assert.equal(picked.name, "picked"); assert.equal(state.outputDirectoryHandle.name, "picked"); await runtime.chooseOutputDirectory();

  assert.equal(await runtime.waitForBrowserSave({ paused: false, cancelled: false, failed: false }), true); assert.equal(await runtime.waitForBrowserSave({ paused: false, cancelled: true, failed: false }), false); runtime.showBrowserSaveProgress({ paused: true, entries: [{}], completed: 0 }, { relativePath: "file.png" }); assert.equal(state.job.state, "paused");
  state.images = [{ id: "file" }, { id: "kept" }]; state.drafts = new Map([["file", { hasEffectiveMask: true }], ["gone", { hasEffectiveMask: true }]]); state.maskStatus = new Map([["file", false], ["gone", true]]); runtime.reconcileStoredMaskStatuses(); assert.deepEqual([...state.maskStatus], [["file", true]]);
  state.currentId = "gone"; runtime.reconcileBrowserSaveState(); assert.equal(state.currentId, null); state.currentId = "file"; runtime.reconcileBrowserSaveState();

  let file = { name: "session.png", size: 2, lastModified: 3, async arrayBuffer() { return Uint8Array.from([1, 2]).buffer; } }; const handle = { name: "session.png", async getFile() { return file; }, async queryPermission() { return "prompt"; }, async requestPermission() { return "granted"; }, async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } };
  const access = { fileHandle: handle, name: file.name, size: file.size, lastModified: file.lastModified }; await runtime.ensureHandlePermission(access, true); file = { ...file, size: 4 }; await assert.rejects(runtime.ensureHandlePermission(access), (error) => error?.code === "stale_asset"); file = { ...file, size: 2 };
  state.images = [{ id: "session", sourceKind: "session" }]; state.sourceAccess.set("session", access); await runtime.ensureSaveSources(["session"], "overwrite", false); await assert.rejects(runtime.ensureSaveSources(["missing"], "overwrite", false), (error) => error?.code === "source_action_unavailable"); await assert.rejects(runtime.ensureSaveSources(["missing"], "copy", true), (error) => error?.code === "source_action_unavailable");
  const binary = { body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; await runtime.writeSourceHandle(access, binary); assert.equal(access.size, 2); assert.deepEqual([...await runtime.snapshotSourceHandle(access)], [1, 2]);
  await assert.rejects(runtime.removeSourceHandle(access), (error) => error?.code === "source_action_unavailable"); let removed = false; access.parentHandle = { async removeEntry() { removed = true; }, async getFileHandle() { return handle; } }; await runtime.removeSourceHandle(access); assert.equal(removed, true); await runtime.restoreSourceHandle(access, Uint8Array.from([1]), true);

  state.images = [{ id: "a" }, { id: "b" }]; state.currentId = "a"; state.selectedImageIds = new Set(["a"]); state.sourceAccess = new Map([["a", {}]]); state.drafts = new Map([["a", {}]]); state.maskStatus = new Map([["a", true]]);
  runtime.setHandler(async (url) => url === "/api/catalog/remove" ? { images: [{ id: "b" }], removedImageIds: ["a"] } : { images: state.images }); await runtime.removeCompletedImagesFromCatalog(["a"], ["a", "b"], new Map([["a", { id: "a" }]])); assert.ok(runtime.calls.includes("select:b")); await runtime.removeCompletedImagesFromCatalog([], [], new Map());

  state.images = [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }]; state.currentId = null; state.settings.saving.parallelism = 1; runtime.setHandler(async (url) => {
    if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] };
    if (url === "/api/save/render") return { ok: true, headers: { get() { return "token"; } }, json: async () => ({}) };
    if (url === "/api/save/commit") return { cleared: false, stale: false };
    if (url === "/api/images") return { images: state.images };
    return {};
  }); await runtime.runBrowserSave(["file"], "_m", false, "overwrite");
  let commits = 0; runtime.setHandler(async (url) => { if (url === "/api/save/commit") { commits += 1; if (commits < 2) { const error = new Error("down"); error.status = 500; throw error; } return { cleared: false }; } if (url === "/api/images") return { images: state.images }; return {}; }); await runtime.commitBrowserSaveWithRetry({ imageId: "file" }); assert.equal(commits, 2); assert.equal(runtime.isDefinitiveCommitRejection({ status: 400 }), true); assert.equal(runtime.isDefinitiveCommitRejection({ status: 500 }), false); runtime.setHandler(async () => { throw new Error("cancel"); }); await runtime.cancelBrowserSave({ imageId: "file", candidateRevision: 1 }, "token");

  const event = { preventDefault() { this.called = true; } }; state.applyTargetIds = []; await runtime.startApplyFromDialog(event); state.applyTargetIds = ["file"]; runtime.saveMode.value = "copy"; runtime.nodes.get("#applySuffix").value = ""; await runtime.startApplyFromDialog(event); runtime.nodes.get("#applySuffix").value = "_m"; runtime.confirmed = false; runtime.saveMode.value = "overwrite"; await runtime.startApplyFromDialog(event); runtime.confirmed = true; runtime.saveMode.value = "copy"; runtime.nodes.get("#deleteOriginal").checked = false;
  runtime.setHandler(async (url) => url === "/api/apply" ? {} : url === "/api/images" ? { images: state.images } : {}); await runtime.startApplyFromDialog(event); runtime.finishSaveStart();
  state.browserSave = { entries: [{}], completed: 0, paused: false, cancelled: false, failed: false }; await runtime.controlApply("pause"); await runtime.controlApply("resume"); await runtime.controlApply("cancel"); state.browserSave = null; runtime.setHandler(async () => { throw new Error("job") }); await runtime.controlApply("cancel"); runtime.showRunningApply({}); assert.equal(runtime.nodes.get("#applyDialog").open, true);

  state.applyFinishing = true; await runtime.finishApplyJob({}); state.applyFinishing = false; state.images = [{ id: "file" }]; state.currentId = "file"; runtime.setHandler(async (url) => url === "/api/images" ? { images: [{ id: "file" }] } : { images: [] }); await runtime.finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["file"], completedImageIds: ["file"], startedAt: 8 }); assert.equal(state.handledApplyStartedAt, 8);
  assert.equal(runtime.isTerminalDetection({ kind: "detect", state: "complete", startedAt: null }, {}), false); assert.equal(runtime.isTerminalDetection({ kind: "detect", state: "complete", startedAt: 9 }, { kind: "detect", state: "running", startedAt: 9 }), true);
  state.detectionTargetIds = ["file"]; state.currentId = "file"; await runtime.finishDetectionJob({ kind: "detect", state: "complete", startedAt: 9, imageIds: ["file"], completedImageIds: ["file"] });
  let sourceFile = { name: "file.png", size: 2, lastModified: 1, async arrayBuffer() { return Uint8Array.from([1, 2]).buffer; } }; const sourceHandle = { name: "file.png", async queryPermission() { return "granted"; }, async getFile() { return sourceFile; }, async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } };
  const sourceAccess = { fileHandle: sourceHandle, name: "file.png", size: 2, lastModified: 1 }; state.images = [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }]; state.sourceAccess = new Map([["file", sourceAccess]]); state.singleSave = { imageId: "file", divisor: 16, draft: null }; runtime.singleSaveMode.value = "overwrite"; runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") { const error = new Error("rejected"); error.status = 400; error.saveState = "pending"; throw error; } if (url === "/api/save/cancel") return {}; return { images: state.images }; }); await runtime.startSingleSave({ preventDefault() {} });
  const restoreFail = { fileHandle: { async createWritable() { throw new Error("write"); } } }; await assert.rejects(runtime.restoreSourceHandle(restoreFail, Uint8Array.from([1]), false));
  state.images = [{ id: "session", sourceKind: "session", relativePath: "session.png" }]; state.sourceAccess = new Map(); runtime.setHandler(async (url) => url === "/api/save/prepare" ? { entries: [{ imageId: "session", candidateRevision: 1, relativePath: "session.png" }] } : url === "/api/images" ? { images: state.images } : {}); await assert.rejects(runtime.runBrowserSave(["session"], "_m", false, "overwrite"), (error) => error.code === "source_action_unavailable");
  state.images = [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }]; state.currentId = "file"; state.sourceAccess = new Map([["file", sourceAccess]]); runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") { const error = new Error("pending"); error.status = 400; error.saveState = "pending"; throw error; } if (url === "/api/save/cancel") return {}; return { images: state.images }; }); await assert.rejects(runtime.runBrowserSave(["file"], "_m", false, "overwrite"));
  runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") return { cleared: false, stale: false }; if (url === "/api/images") return { images: state.images }; return {}; }); await runtime.runBrowserSave(["file"], "_m", false, "overwrite");
  runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") return { cleared: false, stale: false }; if (url === "/api/images") throw new Error("catalog"); return {}; }); await runtime.runBrowserSave(["file"], "_m", false, "overwrite");
  state.images = [{ id: "file", relativePath: "file.png" }]; state.currentId = "file"; runtime.setHandler(async (url) => url === "/api/images" ? { images: [{ id: "file", relativePath: "file.png" }] } : {}); await runtime.finishApplyJob({ kind: "apply", state: "cancelled", completed: 0, imageIds: [], completedImageIds: [], startedAt: 10 }); await runtime.finishApplyJob({ kind: "apply", state: "error", completed: 0, imageIds: [], completedImageIds: [], startedAt: 11 });
  state.applyRunning = true; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "apply", state: "complete", completed: 1, imageIds: [], completedImageIds: [], startedAt: 12 } : { images: state.images }); await runtime.pollJob(); state.detectionTargetIds = ["file"]; state.job = { kind: "detect", state: "running", startedAt: 13 }; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "detect", state: "cancelled", completed: 0, imageIds: ["file"], completedImageIds: [], startedAt: 13 } : { images: state.images }); await runtime.pollJob(); runtime.setHandler(async (url) => url === "/api/job" ? { kind: "detect", state: "error", completed: 0, imageIds: ["file"], completedImageIds: [], startedAt: 14 } : { images: state.images }); state.job = { kind: "detect", state: "running", startedAt: 14 }; await runtime.pollJob();
  state.applyRunning = true; state.applyFinishing = false; state.job = { kind: "apply", state: "running", startedAt: 15 }; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "apply", state: "cancelled", completed: 0, imageIds: [], completedImageIds: [], startedAt: 15 } : { images: state.images }); await runtime.pollJob(); state.pageLoadedAt = 1; state.handledDetectionStartedAt = null; state.job = { kind: "detect", state: "running", startedAt: 16 }; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "detect", state: "cancelled", completed: 0, imageIds: ["file"], completedImageIds: [], startedAt: 16 } : { images: state.images }); await runtime.pollJob();
  state.applyRunning = true; state.applyFinishing = false; state.job = { kind: "apply", state: "running", startedAt: 17 }; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "apply", state: "error", completed: 0, imageIds: [], completedImageIds: [], startedAt: 17, errorCode: "internal_error" } : { images: state.images }); await runtime.pollJob(); state.handledDetectionStartedAt = null; state.processing = { kind: "detect", startedAt: 18 }; state.job = { kind: "detect", state: "running", startedAt: 18 }; const cancelledDetection = { kind: "detect", state: "cancelled", completed: 0, imageIds: ["file"], completedImageIds: [], startedAt: 18 }; assert.equal(runtime.isTerminalDetection(cancelledDetection, state.job), true); runtime.setHandler(async (url) => url === "/api/job" ? cancelledDetection : { images: state.images }); await runtime.pollJob(); state.processing = null;
  state.browserSave = {}; await runtime.pollJob(); state.browserSave = null; state.pollInFlight = null; runtime.setHandler(async (url) => url === "/api/job" ? { kind: "apply", state: "running", total: 2, completed: 1, current: "file" } : { images: state.images }); await runtime.pollJob(); runtime.setHandler(async () => { throw new Error("offline"); }); await runtime.pollJob(); await runtime.pollJob(); await runtime.pollJob(); runtime.scheduleJobPoll(true); runtime.scheduleJobPoll(false);
  const detectionRuntime = makeSaveRuntime(); detectionRuntime.state.images = [{ id: "file", relativePath: "file.png" }]; detectionRuntime.state.currentId = "file"; detectionRuntime.state.pageLoadedAt = 1; detectionRuntime.state.job = { kind: "detect", state: "running", startedAt: 99 }; detectionRuntime.setHandler(async (url) => url === "/api/job" ? { kind: "detect", state: "cancelled", completed: 0, imageIds: ["file"], completedImageIds: [], startedAt: 99 } : { images: detectionRuntime.state.images }); await detectionRuntime.pollJob(); assert.ok(detectionRuntime.calls.includes("status:status.detectCancelled"));
  detectionRuntime.state.handledDetectionStartedAt = null; detectionRuntime.state.job = { kind: "detect", state: "running", startedAt: 100 }; detectionRuntime.setHandler(async (url) => url === "/api/job" ? { kind: "detect", state: "complete", completed: 1, imageIds: ["file"], completedImageIds: ["file"], startedAt: 100 } : { images: detectionRuntime.state.images }); await detectionRuntime.pollJob(); assert.ok(detectionRuntime.calls.includes("status:status.detectDone"));

  const pipeFailure = { body: { async pipeTo() { throw new Error("write failed"); } } };
  const outputCases = [
    [{ async getFileHandle() { const error = new Error("blocked"); error.name = "SecurityError"; throw error; } }, "file.png", "_m", pipeFailure, "blocked"],
    [{ async getFileHandle(_name, options = {}) { if (!options.create) { const error = new Error("missing"); error.name = "NotFoundError"; throw error; } return { async createWritable() { const error = new Error("unsupported"); error.name = "TypeError"; throw error; } }; }, async removeEntry() {} }, "file.png", "_m", pipeFailure, "output_write_unsupported"],
  ];
  for (const [handle, name, suffix, response, expected] of outputCases) {
    await assert.rejects(runtime.writeSingleOutput(handle, name, suffix, response), (error) => error.code === expected || error.message === expected);
  }
  const cleanupFailure = { async getFileHandle(_name, options = {}) { if (!options.create) { const error = new Error("missing"); error.name = "NotFoundError"; throw error; } return { async createWritable() { return { async abort() {}, async write() {}, async close() {} }; } }; }, async removeEntry() { throw new Error("cleanup"); } };
  await assert.rejects(runtime.writeSingleOutput(cleanupFailure, "file.png", "_m", pipeFailure), (error) => error.code === "output_cleanup_failed");
  assert.equal(await runtime.ensureHandlePermission(null, true), undefined);
  const permissionDenied = { fileHandle: { async queryPermission() { return "denied"; }, async requestPermission() { return "denied"; }, async getFile() { return { size: 0, lastModified: 0 }; } } };
  await assert.rejects(runtime.ensureHandlePermission(permissionDenied, true), (error) => error.code === "source_permission_denied");
  const busyAccess = { fileHandle: { async createWritable() { const error = new Error("busy"); error.name = "NoModificationAllowedError"; throw error; } } };
  await assert.rejects(runtime.writeSourceHandle(busyAccess, { body: { async pipeTo() {} } }), (error) => error.code === "source_busy");
}

// Keep these failure boundaries in fresh browser-shaped runtimes: a failed
// save must leave both the source and its chosen output directory coherent.
async function saveCoverageMatrix() {
  const response = (token = "token") => ({ ok: true, headers: { get() { return token; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([9])); await stream.close(); } } });
  const missing = () => { const error = new Error("missing"); error.name = "NotFoundError"; throw error; };

  for (const [label, setup, expectation] of [
    ["directory permission outcomes", async (runtime) => {
      const { state } = runtime;
      await assert.rejects(runtime.ensureOutputDirectoryPermission(), (error) => error.code === "output_permission_denied");
      for (const permission of ["denied", "prompt"]) {
        const handle = { async queryPermission() { return permission; }, async requestPermission() { return "denied"; } };
        await assert.rejects(runtime.ensureOutputDirectoryPermission(handle), (error) => error.code === "output_permission_denied");
      }
      const throwing = { async queryPermission() { throw new Error("permission"); } };
      await assert.rejects(runtime.ensureOutputDirectoryPermission(throwing), (error) => error.code === "output_permission_denied");
      state.outputDirectoryHandle = { name: "ready", async queryPermission() { return "granted"; } };
    }, () => {}],
    ["output lock and stream cleanup", async (runtime) => {
      const lock = runtime.context.navigator.locks;
      runtime.context.navigator.locks = { async request() { throw new Error("lock"); } };
      await assert.rejects(runtime.writeSingleOutput({}, "file.png", "_m", response()), (error) => error.code === "output_write_unsupported");
      runtime.context.navigator.locks = lock;
      let aborted = false; let removed = false;
      const output = { async getFileHandle(_name, options) { if (!options?.create) return missing(); return { async createWritable() { return { async write() {}, async close() {}, async abort() { aborted = true; } }; } }; }, async removeEntry() { removed = true; } };
      await assert.rejects(runtime.writeSingleOutput(output, "file.png", "_m", { body: { async pipeTo() { throw new Error("pipe"); } } }), /pipe/);
      assert.equal(aborted, true); assert.equal(removed, true);
      let sequence = 0;
      const collision = { async getFileHandle(name, options) { if (!options?.create) { sequence += 1; if (sequence === 1) return { name }; return missing(); } return { async createWritable() { return { async write() {}, async close() {} }; } }; } };
      assert.equal((await runtime.writeSingleOutput(collision, "file.png", "_m", response())).name, "file_m_1.png");
    }, () => {}],
    ["source permission and write translation", async (runtime) => {
      const permission = { fileHandle: { async queryPermission() { return "granted"; }, async getFile() { return { size: 1, lastModified: 2 }; } } };
      await runtime.ensureHandlePermission(permission, false);
      const unsupported = { fileHandle: { async createWritable() { const error = new Error("unsupported"); error.name = "NotSupportedError"; throw error; } } };
      await assert.rejects(runtime.writeSourceHandle(unsupported, response()), (error) => error.code === "source_write_unsupported");
      const aborting = { fileHandle: { async createWritable() { return { async abort() {}, async write() {}, async close() {} }; } } };
      await assert.rejects(runtime.writeSourceHandle(aborting, { body: { async pipeTo() { throw new Error("pipe"); } } }), /pipe/);
      const noBuffer = { fileHandle: { async getFile() { return {}; } } };
      assert.equal(await runtime.snapshotSourceHandle(noBuffer), null);
    }, () => {}],
    ["single save exits and confirmations", async (runtime) => {
      const { state, nodes } = runtime;
      const event = { preventDefault() {} };
      state.singleSave = null; await runtime.startSingleSave(event);
      state.singleSave = { imageId: "file", divisor: 16, draft: null }; state.images = [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }];
      runtime.singleSaveMode.value = "copy"; state.outputDirectoryHandle = null; await runtime.startSingleSave(event);
      state.outputDirectoryHandle = { name: "out", async queryPermission() { return "granted"; } };
      runtime.singleSaveMode.value = "overwrite"; runtime.context.confirmed = false; await runtime.startSingleSave(event);
      runtime.context.confirmed = true; runtime.singleSaveMode.value = "copy"; nodes.get("#singleSaveDeleteOriginal").checked = true; runtime.context.confirmed = false; await runtime.startSingleSave(event);
      runtime.context.confirmed = true;
    }, () => {}],
    ["single copy keeps and deletes source", async (runtime) => {
      const { state, nodes } = runtime;
      const file = { name: "session.png", size: 1, lastModified: 1, async arrayBuffer() { return Uint8Array.from([3]).buffer; } };
      let removed = false;
      const fileHandle = { name: file.name, async queryPermission() { return "granted"; }, async getFile() { return file; } };
      const access = { fileHandle, parentHandle: { async removeEntry() { removed = true; }, async getFileHandle() { return { async createWritable() { return { async write() {}, async close() {} }; } }; } }, name: file.name, size: 1, lastModified: 1 };
      state.images = [{ id: "session", sourceKind: "session", relativePath: "session.png" }]; state.singleSave = { imageId: "session", divisor: 16, draft: null }; state.outputDirectoryHandle = { name: "out", async queryPermission() { return "granted"; }, async getFileHandle(_name, options) { if (!options?.create) return missing(); return { async createWritable() { return { async write() {}, async close() {} }; } }; }, async removeEntry() {} }; state.sourceAccess = new Map([["session", access]]);
      runtime.singleSaveMode.value = "copy"; nodes.get("#singleSaveDeleteOriginal").checked = true;
      runtime.setHandler(async (url) => url === "/api/save/prepare" ? { entries: [{ imageId: "session", candidateRevision: 1, relativePath: "session.png" }] } : url === "/api/save/render" ? response() : url === "/api/save/commit" ? { cleared: true, stale: false } : url === "/api/images" ? { images: state.images } : {});
      await runtime.startSingleSave({ preventDefault() {} }); assert.equal(removed, true);
    }, () => {}],
  ]) {
    const runtime = makeSaveRuntime();
    await setup(runtime);
    expectation(runtime);
    assert.ok(label);
  }

  const runCases = [
    { mode: "copy", deleteOriginal: false, sourceKind: "filesystem", committed: { cleared: true, stale: true, deleted: false }, removeAfterSave: true },
    { mode: "copy", deleteOriginal: true, sourceKind: "session", committed: { cleared: true, stale: false, deleted: true }, removeAfterSave: true },
    { mode: "overwrite", deleteOriginal: false, sourceKind: "filesystem", committed: { cleared: true, stale: false, deleted: false }, removeAfterSave: false },
  ];
  for (const scenario of runCases) {
    const runtime = makeSaveRuntime(); const { state } = runtime;
    const file = { name: "file.png", size: 1, lastModified: 1, async arrayBuffer() { return Uint8Array.from([2]).buffer; } };
    const access = { fileHandle: { name: file.name, async queryPermission() { return "granted"; }, async getFile() { return file; }, async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } }, name: file.name, size: 1, lastModified: 1 };
    if (scenario.deleteOriginal) access.parentHandle = { async removeEntry() {}, async getFileHandle() { return access.fileHandle; } };
    state.images = [{ id: "file", sourceKind: scenario.sourceKind, relativePath: "file.png" }]; state.currentId = "file"; state.sourceAccess = new Map([["file", access]]); state.outputDirectoryHandle = { name: "out", async getFileHandle(_name, options) { if (!options?.create) return missing(); return { async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } }; }, async removeEntry() {} };
    runtime.setHandler(async (url) => url === "/api/save/prepare" ? { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] } : url === "/api/save/render" ? response() : url === "/api/save/commit" ? scenario.committed : url === "/api/catalog/remove" ? { images: state.images, removedImageIds: [] } : url === "/api/images" ? { images: state.images } : {});
    await runtime.runBrowserSave(["file"], "_m", scenario.deleteOriginal, scenario.mode, scenario.removeAfterSave);
  }

  for (const status of [400, 503]) {
    const runtime = makeSaveRuntime(); let attempts = 0;
    runtime.setHandler(async (url) => {
      if (url === "/api/save/commit") { attempts += 1; const error = new Error("commit"); error.status = status; throw error; }
      if (url === "/api/save/status") return status === 503 ? { state: "committed" } : { state: "pending" };
      return {};
    });
    if (status === 400) await assert.rejects(runtime.commitBrowserSaveWithRetry({}), /commit/);
    else assert.equal((await runtime.commitBrowserSaveWithRetry({})).state, "committed");
    assert.ok(attempts >= 1);
  }

  for (const job of [
    { kind: "apply", state: "running", total: 0, completed: 4, current: "", startedAt: 30 },
    { kind: "apply", state: "paused", total: 3, completed: 2, current: "file", startedAt: 31 },
  ]) {
    const runtime = makeSaveRuntime(); runtime.state.job = { kind: "idle", state: "idle" };
    runtime.setHandler(async (url) => url === "/api/job" ? job : { images: runtime.state.images });
    await runtime.pollJob(); assert.equal(runtime.state.job, job);
  }

  for (const job of [
    { kind: "detect", state: "complete", startedAt: 41, imageIds: [], completedImageIds: [] },
    { kind: "detect", state: "error", startedAt: 42, imageIds: ["file"], completedImageIds: [] },
  ]) {
    const runtime = makeSaveRuntime(); runtime.state.images = [{ id: "file" }]; runtime.state.currentId = "file"; runtime.state.pageLoadedAt = 1; runtime.state.job = { kind: "detect", state: "running", startedAt: job.startedAt };
    runtime.setHandler(async (url) => url === "/api/job" ? job : { images: runtime.state.images });
    await runtime.pollJob();
  }
}

(async () => {
  await galleryInteractions();
  await saveInteractions();
  await saveCoverageMatrix();
  console.log("test_gallery_save_coverage: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
