const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const jsRoot = path.join(__dirname, "..", "static", "js");
const imageDisplayPathSource = fs.readFileSync(path.join(jsRoot, "core.js"), "utf8").match(/function imageDisplayPath\(image\) \{[\s\S]*?\n\}/)?.[0];

function sourceBlob(name, size, lastModified) {
  return Object.assign(new Blob([new Uint8Array(size)]), { name, lastModified });
}

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
    insertBefore(child, before) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); const index = before ? this.children.indexOf(before) : -1; if (index >= 0) this.children.splice(index, 0, child); else this.children.push(child); child.parentNode = this; },
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.removed = true; },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    querySelector(selector) { return children[selector] || null; },
    scrollIntoView(options) { this.scrolled = options; },
    focus() { this.focused = true; },
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
  const thumbnailError = element();
  const item = element({ img: preview, ".gallery-name": name, ".gallery-meta": meta, ".gallery-review-badge": badge, ".thumbnail-error": thumbnailError });
  preview.closest = () => item;
  item.scope = scope;
  return item;
}

function overviewItem() {
  const preview = element();
  const item = element({
    img: preview,
    ".thumbnail-error": element(),
    ".overview-item-name": element(),
    ".overview-item-dimensions": element(),
    ".overview-review-badge": element(),
  });
  preview.closest = () => item;
  return item;
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
    images: [], currentId: null, viewMode: "edit", galleryFilter: new Set(), overviewFilter: new Set(), overviewFolder: "", overviewQuery: "",
    galleryNodes: new Map(), overviewNodes: new Map(), selectedImageIds: new Set(), selectionAnchorId: null, batchMode: false, viewGeneration: 0,
  };
  const frames = [];
  const document = {
    querySelector(selector) { return nodes.get(selector) || null; },
    querySelectorAll(selector) { return selector === ".gallery-local-count" ? [element(), element()] : selector === ".overview-filter" ? overviewButtons : []; },
    createElement() { return element(); },
  };
  const context = {
    codedError(code) { const error = new Error(); error.code = code; return error; }, responseError(response, payload) { const error = new Error(); error.status = response.status; error.code = payload?.error_code || "internal_error"; return error; },
    console, Map, Set, Array, Math, String, Object, document, encodeURIComponent, window: { addEventListener() {} },
    IntersectionObserver: class { constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); } observe(image) { this.observed = image; } unobserve(image) { image.unobserved = true; } },
    state, $: (selector) => nodes.get(selector), $$: () => [],
    t(key, values = {}) { return `${key}:${Object.values(values).join(",")}`; },
    imageAssetVersion(image) { return image.assetVersion || ""; },
    isHidden(image) { return Boolean(image?.hidden); }, isReviewed(image) { return Boolean(image?.reviewed); }, imageHasMask(image) { return Boolean(image?.masked); }, currentImageActionPending() { return Boolean(state.pendingImageId); }, hasDurableHistory() { return false; },
    selectCatalogImage(id) { selected.push(id); }, schedulePrefetch(image) { prefetched.push(`schedule:${image.id}`); }, prefetchNeighbors(image) { prefetched.push(`neighbors:${image.id}`); },
    openCatalogContextMenu(_event, id) { menus.push(id); }, updateActionButtons() { calls.push("actions"); }, updateSelectionActionBar() { calls.push("selection"); }, updateFilterMenuButtons() {}, syncResourceOwnership() {}, closeFilterPopovers() {},
    setViewMode(mode) { calls.push(`stub-view:${mode}`); }, closeBatchMoreMenus() { calls.push("close-menu"); }, clearBatchSelection() { state.selectedImageIds.clear(); calls.push("clear-selection"); },
    discardCatalogNodes(map, parent) { for (const node of map.values()) node.remove(); map.clear(); parent.discarded = true; }, resizeRenderCanvas() { calls.push("resize"); }, focusCanvas() { calls.push("focus-canvas"); }, focusElement(node) { node.focused = true; },
    requestAnimationFrame(callback) { frames.push(callback); }, isGestureActive() { return Boolean(context.gesture); }, currentRecord() { return state.images.find((image) => image.id === state.currentId) || null; },
    imageIndex(id = state.currentId) { return state.images.findIndex((image) => image.id === id); },
    async selectImage(id) { selected.push(`image:${id}`); }, async setHidden(image, value) { image.hidden = value; return context.hideResult; }, async queueImageMutation(_id, action) { return action(); }, async saveWorkspaceFlagNow(image, _flag, value, after) { image.reviewed = value; after?.(); return context.reviewResult; }, refreshReviewViews() {},
  };
  context.reviewResult = true; context.hideResult = true;
  vm.runInNewContext(imageDisplayPathSource, context, { filename: path.join(jsRoot, "core.js") });
  const source = fs.readFileSync(path.join(jsRoot, "gallery.js"), "utf8");
  vm.runInNewContext(source, context, { filename: path.join(jsRoot, "gallery.js") });
  vm.runInNewContext("globalThis.__galleryTest = { thumbnailObserver, thumbnailSource, loadThumbnail, retryThumbnail, observeThumbnail, forgetThumbnail, catalogWindow, focusCatalogIndex, renderGallery, imageMatchesGalleryFilter, updateGalleryCurrent, overviewFolderOptions, overviewImages, syncOverviewFolders, selectOverviewImage, renderOverview, renderCatalogViews, setViewMode, moveCurrentBy, reviewAndMoveNext, hideAndMoveNext, runNavigationAction, updateNavigationControls, thumbnailObservers, catalogWindows, catalogMoveIndex, resetCatalogWindows, scrollCatalogImage };", context, { filename: "test-gallery-exports.js" });
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

  const retryPreview = element(); const retryNotice = element(); const retryCard = element({ ".thumbnail-error": retryNotice }); retryPreview.closest = () => retryCard;
  retryPreview.dataset.src = "retry-thumb"; runtime.loadThumbnail(retryPreview); retryPreview.onerror();
  assert.equal(retryNotice.hidden, false, "a failed thumbnail is visibly marked on its own card");
  assert.equal(retryNotice.getAttribute("role"), "button", "the thumbnail retry is keyboard-accessible");
  retryNotice.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(retryNotice.hidden, true, "retry clears only the failed card marker"); assert.equal(retryPreview.src, "retry-thumb", "retry issues a fresh request for the failed thumbnail");
  retryPreview.onload(); assert.equal(retryPreview.onerror, null, "a successful thumbnail retry removes the completed request error handler");

  runtime.renderGallery();
  assert.equal(runtime.gallery.children.length, 4, "the virtualized gallery keeps one spacer and its mounted window");
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
  assert.equal(firstNode.classList.contains("reviewed"), true, "reviewed gallery entries carry the green review state");
  assert.equal(firstNode.getAttribute("aria-current"), "true"); assert.match(firstNode.getAttribute("aria-label"), /sets\/one/);
  firstNode.onclick(); firstNode.onmouseenter(); firstNode.oncontextmenu({});
  const secondaryPointer = { button: 2, preventDefault() { this.prevented = true; } }; firstNode.onpointerdown(secondaryPointer);
  assert.equal(secondaryPointer.prevented, true, "a secondary pointer press is consumed before it can move catalog focus");
  firstNode.onkeydown({ key: "Enter", preventDefault() { this.prevented = true; } });
  firstNode.onkeydown({ key: " ", preventDefault() {} }); firstNode.onkeydown({ key: "ContextMenu" }); firstNode.onkeydown({ key: "F10", shiftKey: true });
  assert.deepEqual(runtime.selected.slice(0, 3), ["one", "one", "one"]); assert.equal(runtime.menus.length, 3); assert.equal(runtime.prefetched.length, 1, "hover schedules only its image; filtered neighbors are owned by the resource cache");
  for (const [filter, expected] of [["hidden", true], ["masked", true], ["unmasked", true], ["reviewed", true], ["unreviewed", true], ["all", true]]) {
    state.galleryFilter = filter === "all" ? new Set() : new Set([filter]); assert.equal(runtime.imageMatchesGalleryFilter(filter === "hidden" ? second : filter === "masked" || filter === "reviewed" ? first : third), expected);
  }
  state.galleryFilter = new Set(["masked"]); runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["one"]);
  state.galleryFilter = new Set(["hidden"]); runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["two"]);
  state.galleryFilter = new Set(["reviewed"]); runtime.renderGallery(); assert.deepEqual([...state.galleryNodes.keys()], ["one"]);
  first.masked = false; state.galleryFilter = new Set(["masked"]); runtime.renderGallery(); assert.equal(runtime.nodes.get("#galleryFilteredEmptyState").hidden, false); first.masked = true;
  state.images = []; runtime.renderGallery(); assert.equal(runtime.nodes.get("#galleryEmptyState").hidden, false);
  state.images = [first, second, third]; state.galleryFilter = new Set(); state.viewMode = "overview"; const before = runtime.gallery.children.length; runtime.renderGallery(); assert.equal(runtime.gallery.children.length, before); runtime.renderGallery(true);
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
  state.galleryFilter = new Set(); runtime.renderGallery(true);
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
  state.images = catalogImages; state.galleryFilter = new Set(); runtime.gallery.scrollTop = 0; runtime.renderGallery(true);

  runtime.gallery.scrollTop = 999; runtime.overviewGrid.scrollTop = 555;
  runtime.renderGallery(true); runtime.renderOverview(true);
  runtime.resetCatalogWindows();
  assert.equal(runtime.gallery.scrollTop, 0, "replacing a catalog returns the gallery to its first row");
  assert.equal(runtime.overviewGrid.scrollTop, 0, "replacing a catalog returns the overview to its first row");
  assert.equal(runtime.catalogWindows.get("gallery").focusId, null, "replacing a catalog clears its virtual gallery focus");
  assert.equal(runtime.catalogWindows.get("overview").focusId, null, "replacing a catalog clears its virtual overview focus");

  assert.deepEqual([...runtime.overviewFolderOptions()], ["sets", "sets/sub"]);
  state.overviewFilter = new Set(); state.overviewFolder = "sets"; state.overviewQuery = "two"; assert.deepEqual(runtime.overviewImages().map((image) => image.id), ["two"]);
  state.overviewFolder = ""; state.overviewQuery = "";
  for (const [filter, expected] of [["hidden", ["two"]], ["reviewed", ["one"]], ["unreviewed", ["three"]], ["masked", ["one"]], ["unmasked", ["three"]]]) { state.overviewFilter = new Set([filter]); assert.deepEqual(runtime.overviewImages().map((image) => image.id), expected); }
  state.overviewFilter = new Set(); state.overviewFolder = "missing"; runtime.syncOverviewFolders(); assert.equal(state.overviewFolder, "");
  state.viewMode = "overview"; state.batchMode = false; runtime.selectOverviewImage("one"); assert.deepEqual(runtime.selected.at(-1), "one");
  state.batchMode = true; runtime.selectOverviewImage("one", {}); assert.equal(state.selectedImageIds.has("one"), true); runtime.selectOverviewImage("one", {}); assert.equal(state.selectedImageIds.has("one"), false);
  runtime.selectOverviewImage("one", {}); runtime.selectOverviewImage("three", { ctrlKey: true }); runtime.selectOverviewImage("two", { shiftKey: true }); assert.deepEqual([...state.selectedImageIds], ["two", "three"]);
  runtime.selectOverviewImage("three", { shiftKey: true, ctrlKey: true }); assert.equal(state.selectedImageIds.has("three"), true); runtime.selectOverviewImage("gone", {});
  state.currentId = "one"; state.selectedImageIds = new Set(["one"]); runtime.renderOverview(true); const overviewNode = state.overviewNodes.get("one");
  assert.equal(overviewNode.getAttribute("aria-pressed"), "true"); overviewNode.onclick({}); overviewNode.oncontextmenu({}); overviewNode.onkeydown({ key: "Enter", preventDefault() {} }); overviewNode.onkeydown({ key: "F10", shiftKey: true });
  state.overviewFilter = new Set(["hidden"]); runtime.renderOverview(true); assert.deepEqual([...state.overviewNodes.keys()], ["two"]);
  state.overviewFilter = new Set(); runtime.renderOverview(true);
  const savedGrid = runtime.nodes.get("#overviewGrid"); runtime.nodes.delete("#overviewGrid"); runtime.renderOverview(true); runtime.nodes.set("#overviewGrid", savedGrid);

  state.viewMode = "edit"; state.galleryNodes.set("one", galleryItem("gallery")); runtime.setViewMode("overview"); assert.equal(state.viewMode, "overview"); runtime.frames.shift()(); assert.equal(runtime.nodes.get("#overviewPane").focused, true);
  runtime.setViewMode("edit"); assert.equal(state.viewMode, "edit"); runtime.setViewMode("overview"); const stale = runtime.frames.pop(); state.viewMode = "edit"; stale();
  state.currentId = "one"; runtime.context.gesture = true; runtime.moveCurrentBy(1); runtime.context.gesture = false; runtime.moveCurrentBy(1); assert.deepEqual(runtime.selected.at(-1), "image:two");
  runtime.context.gesture = true; assert.equal(await runtime.reviewAndMoveNext(), null); runtime.context.gesture = false; state.currentId = "missing"; assert.equal(await runtime.reviewAndMoveNext(), null); state.currentId = "one"; runtime.context.reviewResult = false; assert.equal(await runtime.reviewAndMoveNext(), null); runtime.context.reviewResult = true; assert.equal((await runtime.reviewAndMoveNext()).id, "two"); state.currentId = "three"; assert.equal(await runtime.reviewAndMoveNext(), null);
  runtime.context.gesture = true; await runtime.hideAndMoveNext(); runtime.context.gesture = false; state.currentId = "missing"; await runtime.hideAndMoveNext(); state.currentId = "one"; runtime.context.hideResult = false; await runtime.hideAndMoveNext(); runtime.context.hideResult = true; await runtime.hideAndMoveNext(); state.currentId = "three"; await runtime.hideAndMoveNext();
  await runtime.runNavigationAction(async () => runtime.calls.push("navigate")); assert.ok(runtime.calls.includes("focus-canvas"));
  state.currentId = "one"; runtime.updateNavigationControls(); assert.match(runtime.nodes.get("#imagePosition").textContent, /1/); first.reviewed = false; runtime.updateNavigationControls(); state.currentId = null; runtime.updateNavigationControls(); assert.equal(runtime.nodes.get("#imagePosition").textContent, "- / 3", "navigation keeps the filtered-image count when no item is selected");
}

function makeSaveRuntime() {
  const nodes = new Map();
  const ids = ["#applyResult", "#applyStartButton", "#applyCopyMode", "#deleteOriginal", "#applyRemoveSaved", "#applySuffix", "#applyTargetMode", "#applyTargetCount", "#applyDivisor", "#divisor", "#applySuffixRow", "#deleteOriginalRow", "#applyOutputDirectoryRow", "#applyPreserveDirectoryStructureRow", "#chooseOutputDirectoryButton", "#applyOutputDirectoryStatus", "#applyPreserveDirectoryStructure", "#applyTemporarySourceNote", "#applyOverwriteMode", "#applyOverwriteRow", "#applyOutputFormat", "#applyKeepMetadata", "#applyFormatNote", "#settingsDefaultOutputDirectory", "#settingsChooseOutputDirectory", "#applyProgress", "#applyCurrentName", "#applyProgressText", "#applyPauseButton", "#applyCancelButton", "#applyCloseButton", "#applySettings", "#applyProgressPanel", "#applyDialog", "#singleSaveTarget", "#singleSaveOutputDirectoryStatus", "#singleSavePreserveDirectoryStructure", "#singleSaveResult", "#singleSaveSuffixRow", "#singleSaveDeleteOriginalRow", "#singleSaveOutputDirectoryRow", "#singleSavePreserveDirectoryStructureRow", "#singleSaveOverwriteMode", "#singleSaveOverwriteRow", "#singleSaveDeleteOriginal", "#singleSaveRemoveSaved", "#singleSaveChooseOutputDirectoryButton", "#singleSaveStartButton", "#singleSaveSettings", "#singleSaveCopyMode", "#singleSaveSuffix", "#singleSaveOutputFormat", "#singleSaveKeepMetadata", "#singleSaveFormatNote", "#singleSaveDialog"];
  for (const id of ids) nodes.set(id, element());
  nodes.get("#applyTargetMode").value = "masked"; nodes.get("#applyDivisor").value = "16"; nodes.get("#divisor").value = "16"; nodes.get("#applySuffix").value = "_m";
  const saveMode = element(); saveMode.value = "copy"; const singleSaveMode = element(); singleSaveMode.value = "copy";
  const errors = []; const calls = []; const requests = [];
  const state = {
    sourceAccess: new Map(), applyTargetIds: ["file"], images: [{ id: "file", sourceKind: "filesystem", relativePath: "file.png" }, { id: "session", sourceKind: "session", relativePath: "session.png" }],
    settings: { saving: { default_output_directory: "G:/out", parallelism: 1, preserve_directory_structure: true }, detection: { exclude_forced_default: true }, confirmations: { overwriteSource: false, deleteSourceAfterCopy: false } }, drafts: new Map(), maskStatus: new Map(), selectedImageIds: new Set(), candidateUpdateChains: new Map(),
    applyRunning: false, saveStarting: false, outputDirectoryPicking: false, importing: false, saving: false, currentId: null, candidates: [], prefetchQueue: [], catalogEpoch: 1, imageGeneration: 0, pageLoadedAt: 1, job: { kind: "idle", state: "idle" }, projectHistory: new Map(), workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), workspaceFlagPending: new Map(), draftSaveChains: new Map(),
  };
  let handler = async (url) => {
    if (url === "/api/images") return { images: state.images };
    if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] };
    if (url === "/api/save/commit") return { cleared: false, stale: false };
    return {};
  };
  const invoke = async (url, options) => {
    const result = await handler(url, options);
    if (url === "/api/save/reserve" && !result?.state) return { state: "rendering" };
    if (url === "/api/save/ack" && result && Object.keys(result).length === 0) return { acknowledged: true };
    return result;
  };
  const context = {
    codedError(code) { const error = new Error(); error.code = code; return error; }, responseError(response, payload) { const error = new Error(); error.status = response.status; error.code = payload?.error_code || "internal_error"; return error; },
    console, Map, Set, Array, Math, Number, Boolean, JSON, Promise, Uint8Array, Error, DOMException, Blob, TextDecoder, Intl, crypto: { randomUUID: () => `gallery-token-${requests.length}` }, window: { addEventListener() {} }, navigator: { locks: { async request(_name, _options, callback) { return callback(); } } }, localStorage: (() => { const values = new Map(); return { get length() { return values.size; }, key(index) { return [...values.keys()][index] || null; }, getItem(key) { return values.get(key) || null; }, setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } }; })(), atob(value) { return Buffer.from(value, "base64").toString("binary"); }, document: { activeElement: nodes.get("#applyStartButton"), documentElement: { lang: "en" }, querySelectorAll() { return []; }, querySelector(selector) { if (selector === 'input[name="batchSaveMode"]:checked') return saveMode; if (selector === 'input[name="singleSaveMode"]:checked') return singleSaveMode; if (selector === 'meta[name="mozarie-token"]') return { content: "token" }; return nodes.get(selector); } },
    state, $: (selector) => nodes.get(selector), t(key, values = {}) { return `${key}:${Object.values(values).join(",")}`; }, catalogRequestHeaders(headers = {}) { return { "X-Mozarie-Token": context.document.querySelector('meta[name="mozarie-token"]')?.content || "", ...headers }; }, api(url, options) { requests.push({ url, options }); return invoke(url, options); },
    fetch(url, options) { requests.push({ url, options }); return invoke(url, options); }, setTimeout(callback, delay) { if (delay === 150) callback(); return 1; }, clearTimeout() {},
    showUserError(error) { errors.push(error); }, userErrorCode(error) { return error?.code || "internal_error"; }, showModalFromInvoker(node) { node.open = true; }, setSettingsForm(settings) { state.settings = settings; },
    saveTargets() { return state.applyTargetIds; }, processableImages() { return state.images; }, isBusy() { return Boolean(context.busy); }, currentImageActionPending() { return Boolean(state.pendingImageId); }, catalogStagingEditsActive() { return false; }, isProcessableImage() { return true; }, async flushDraftSaves() { if (context.flushError) throw context.flushError; }, async flushWorkspaceDraft(imageId) { calls.push(`flush:${imageId}`); }, async waitForCandidateMutations() { calls.push("wait-candidates"); }, updateBlockSizeDisplay() { calls.push("block-size"); },
    updateActionButtons() { calls.push("actions"); }, releaseCandidateBundles(id) { calls.push(`release:${id}`); }, resetCurrentDraft() { calls.push("reset-draft"); }, pruneSourceAccess() { calls.push("prune"); },
    releaseImageCaches(id) { calls.push(`cache:${id}`); }, clearCandidateMutationState(id) { calls.push(`mutation:${id}`); }, clearReviewForRemovedImage() { calls.push("clear-review"); }, clearBatchSelection() { calls.push("clear-batch"); }, clearEditor() { calls.push("clear-editor"); }, renderCatalogViews() { calls.push("catalog"); }, updateSelectionActionBar() { calls.push("selection"); },
    async selectImage(id) { calls.push(`select:${id}`); }, async setReviewed() { calls.push("reviewed"); return true; }, updateNavigationControls() { calls.push("navigation"); }, refreshMaskStatus() { calls.push("mask-status"); }, renderCandidates() { calls.push("candidates"); }, render() { calls.push("render"); },
    isCurrentCatalogEpoch(epoch) { return state.catalogEpoch === epoch; }, isCurrentGeneration(generation) { return state.imageGeneration === generation; }, reconcileCatalogSnapshot() {}, loadReviewedPaths() {}, async resyncAfterStaleCatalog() {}, async moveReviewedPathAfterApply() { calls.push("review-path"); },
    async confirmAction() { return context.confirmed; }, async ensureSaveSources() {}, async runBrowserSave() { calls.push("run-browser"); }, closeProcessing() { calls.push("close-processing"); }, markImagesUnreviewed() { calls.push("unreview"); },
    modalInvokers: new Map(), updateProgress() { calls.push("progress"); }, setStatusKey(key) { calls.push(`status:${key}`); }, scheduleJobPoll() { calls.push("schedule"); },
  };
  context.confirmed = true;
  vm.runInNewContext(imageDisplayPathSource, context, { filename: path.join(jsRoot, "core.js") });
  const source = fs.readFileSync(path.join(jsRoot, "save.js"), "utf8");
  vm.runInNewContext(source, context, { filename: path.join(jsRoot, "save.js") });
  vm.runInNewContext("globalThis.__saveTest = { setApplyResult, showApplyError, isTerminalApply, selectedSaveMode, sourceAccessFor, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, applyRestrictionMessage, syncApplyMode, refreshApplyTargets, openApplyDialog, selectedSingleSaveMode, setSingleSaveResult, syncSingleSaveMode, openSingleSaveDialog, chooseSingleOutputDirectory, renderSingleSave, startSingleSave, draftPayload, renderOutputDirectory, commitOutputDirectory, saveDirectoryStructurePreference, setOutputDirectoryPickerBusy, pickOutputDirectory, reserveSaveRender, renderDefaultCopy, renderStreamedSave, chooseOutputDirectory, waitForBrowserSave, showBrowserSaveProgress, reconcileStoredMaskStatuses, reconcileBrowserSaveState, ensureHandlePermission, ensureSaveSources, writeSourceHandle, snapshotSourceHandle, restoreSourceHandle, runBrowserSave, commitBrowserSaveWithRetry, cancelBrowserSave, acknowledgePendingBrowserSave, isDefinitiveCommitRejection, startApplyFromDialog, finishSaveStart, controlApply, showRunningApply, finishApplyJob, isTerminalDetection, finishDetectionJob, pollJob, scheduleJobPoll };", context, { filename: "test-save-exports.js" });
  return { ...context.__saveTest, calls, context, errors, nodes, requests, saveMode, singleSaveMode, state, setHandler(fn) { handler = fn; } };
}

async function saveInteractions() {
  const runtime = makeSaveRuntime(); const { state } = runtime;
  state.currentId = "file"; state.currentImage = { width: 1, height: 1 };
  runtime.setApplyResult("ok"); assert.equal(runtime.nodes.get("#applyResult").textContent, "ok"); runtime.setApplyResult("bad", true); runtime.showApplyError("bad"); assert.equal(runtime.errors.length, 2);
  assert.equal(runtime.selectedSingleSaveMode(), "copy"); runtime.setSingleSaveResult("single", true); assert.equal(runtime.nodes.get("#singleSaveResult").textContent, "single");
  await runtime.openSingleSaveDialog(null); runtime.context.busy = true; await runtime.openSingleSaveDialog("file"); runtime.context.busy = false; runtime.context.flushError = new Error("draft"); await runtime.openSingleSaveDialog("file"); runtime.context.flushError = null; state.candidateUpdateChains.set("pending", Promise.resolve()); await runtime.openSingleSaveDialog("file"); state.candidateUpdateChains.clear(); assert.equal(state.singleSave.imageId, "file");
  state.singleSave = null; runtime.syncSingleSaveMode(); state.singleSave = { imageId: "missing" }; runtime.syncSingleSaveMode(); state.singleSave = { imageId: "file" }; runtime.singleSaveMode.value = "overwrite"; runtime.syncSingleSaveMode(); runtime.singleSaveMode.value = "copy";
  runtime.nodes.get("#singleSaveOutputFormat").value = "png"; runtime.nodes.get("#singleSaveKeepMetadata").checked = false; runtime.nodes.get("#singleSaveRemoveSaved").checked = true;
  await runtime.openSingleSaveDialog("file");
  assert.equal(runtime.nodes.get("#singleSaveOutputFormat").value, "png", "single-save format is retained while this page stays open");
  assert.equal(runtime.nodes.get("#singleSaveKeepMetadata").checked, false, "single-save metadata preference is retained while this page stays open");
  assert.equal(runtime.nodes.get("#singleSaveRemoveSaved").checked, true, "single-save list removal preference is retained while this page stays open");
  runtime.nodes.get("#singleSaveRemoveSaved").checked = false;
  await runtime.openApplyDialog();
  runtime.nodes.get("#applyDivisor").value = "23"; runtime.nodes.get("#applyOutputFormat").value = "png"; runtime.nodes.get("#applyKeepMetadata").checked = false; runtime.nodes.get("#applyRemoveSaved").checked = true; runtime.nodes.get("#applyTargetMode").value = "reviewed";
  await runtime.openApplyDialog();
  assert.equal(runtime.nodes.get("#applyTargetMode").value, "reviewed", "batch-save target is retained without an explicit caller override");
  assert.equal(runtime.nodes.get("#applyDivisor").value, "23", "batch-save divisor is retained while this page stays open");
  assert.equal(runtime.nodes.get("#applyOutputFormat").value, "png", "batch-save format is retained while this page stays open");
  assert.equal(runtime.nodes.get("#applyKeepMetadata").checked, false, "batch-save metadata preference is retained while this page stays open");
  assert.equal(runtime.nodes.get("#applyRemoveSaved").checked, true, "batch-save list removal preference is retained while this page stays open");
  await runtime.openApplyDialog({ initialMode: "all" }); assert.equal(runtime.nodes.get("#applyTargetMode").value, "all", "an explicit batch target still overrides the retained target");
  runtime.syncSingleSaveMode(); assert.equal(runtime.nodes.get("#singleSaveStartButton").disabled, false); state.saving = true; await runtime.chooseSingleOutputDirectory(); state.saving = false;
  runtime.saveMode.value = "overwrite"; runtime.nodes.get("#applyOutputFormat").value = "jpg"; runtime.syncApplyMode();
  assert.equal(runtime.selectedSaveMode(), "overwrite", "changing a PNG batch to JPG preserves the overwrite choice");
  assert.equal(runtime.nodes.get("#applyOverwriteMode").disabled, false, "changing format does not force batch overwrite off");
  runtime.singleSaveMode.value = "overwrite"; runtime.nodes.get("#singleSaveOutputFormat").value = "jpg"; runtime.syncSingleSaveMode();
  assert.equal(runtime.selectedSingleSaveMode(), "overwrite", "changing a PNG single save to JPG preserves the overwrite choice");
  assert.equal(runtime.nodes.get("#singleSaveOverwriteMode").disabled, false, "changing format does not force single overwrite off");
  runtime.saveMode.value = "copy"; runtime.singleSaveMode.value = "copy"; runtime.nodes.get("#applyOutputFormat").value = "original"; runtime.nodes.get("#singleSaveOutputFormat").value = "original";
  runtime.setHandler(async (url) => url === "/api/output-directory/pick" ? { cancelled: false, path: "G:/picked", settings: { saving: { default_output_directory: "G:/picked" } } } : {});
  await runtime.pickOutputDirectory(); assert.equal(state.settings.saving.default_output_directory, "G:/picked", "the server picker updates the absolute single-save path");
  runtime.setHandler(async (url) => url === "/api/output-directory/pick" ? { cancelled: true } : {});
  await runtime.chooseSingleOutputDirectory(); assert.equal(state.settings.saving.default_output_directory, "G:/picked", "a cancelled picker keeps the prior absolute path");
  let resolveDirectorySave;
  runtime.nodes.get("#applyOutputDirectoryStatus").value = " G:/manual ";
  runtime.setHandler((url, options) => {
    if (url !== "/api/settings?status=0") return {};
    assert.deepEqual(JSON.parse(options.body), { saving: { default_output_directory: "G:/manual" } }, "manual output directories use the narrow settings payload");
    return new Promise((resolve) => { resolveDirectorySave = resolve; });
  });
  const pendingDirectorySave = runtime.commitOutputDirectory(runtime.nodes.get("#applyOutputDirectoryStatus"));
  await Promise.resolve();
  assert.equal(state.outputDirectoryCommitPending, true);
  assert.equal(runtime.nodes.get("#applyOutputDirectoryStatus").disabled, true);
  assert.equal(runtime.nodes.get("#singleSaveOutputDirectoryStatus").disabled, true);
  assert.equal(runtime.nodes.get("#applyStartButton").disabled, true);
  assert.equal(runtime.nodes.get("#singleSaveStartButton").disabled, true);
  resolveDirectorySave({ settings: { saving: { default_output_directory: "G:/manual" } } });
  assert.equal(await pendingDirectorySave, true);
  assert.equal(state.settings.saving.default_output_directory, "G:/manual");
  assert.equal(runtime.nodes.get("#settingsDefaultOutputDirectory").value, "G:/manual");
  assert.equal(runtime.nodes.get("#applyOutputDirectoryStatus").value, "G:/manual");
  assert.equal(runtime.nodes.get("#singleSaveOutputDirectoryStatus").value, "G:/manual");
  assert.equal(runtime.nodes.get("#applyOutputDirectoryStatus").disabled, false);
  const pendingSettings = [];
  runtime.setHandler((url, options) => {
    if (url !== "/api/settings?status=0") return {};
    return new Promise((resolve) => pendingSettings.push({ payload: JSON.parse(options.body), resolve }));
  });
  runtime.nodes.get("#applyPreserveDirectoryStructure").checked = false;
  const structureBeforeDirectory = runtime.saveDirectoryStructurePreference(runtime.nodes.get("#applyPreserveDirectoryStructure"));
  await Promise.resolve(); await Promise.resolve();
  runtime.nodes.get("#applyOutputDirectoryStatus").value = "G:/directory-first";
  const directoryAfterStructure = runtime.commitOutputDirectory(runtime.nodes.get("#applyOutputDirectoryStatus"));
  await Promise.resolve();
  const firstStructure = pendingSettings.find((request) => request.payload.saving.preserve_directory_structure === false);
  const firstDirectory = pendingSettings.find((request) => request.payload.saving.default_output_directory === "G:/directory-first");
  firstDirectory.resolve({ settings: { saving: { default_output_directory: "G:/directory-first", preserve_directory_structure: true } } });
  await directoryAfterStructure;
  firstStructure.resolve({ settings: { saving: { default_output_directory: "G:/manual", preserve_directory_structure: false } } });
  await structureBeforeDirectory;
  assert.deepEqual(state.settings.saving, { default_output_directory: "G:/directory-first", parallelism: 1, preserve_directory_structure: false }, "a late structure reply cannot replace a newly committed output directory");
  pendingSettings.length = 0;
  runtime.nodes.get("#applyPreserveDirectoryStructure").checked = true;
  const structureAfterDirectory = runtime.saveDirectoryStructurePreference(runtime.nodes.get("#applyPreserveDirectoryStructure"));
  await Promise.resolve(); await Promise.resolve();
  runtime.nodes.get("#applyOutputDirectoryStatus").value = "G:/directory-last";
  const directoryBeforeStructure = runtime.commitOutputDirectory(runtime.nodes.get("#applyOutputDirectoryStatus"));
  await Promise.resolve();
  const secondStructure = pendingSettings.find((request) => request.payload.saving.preserve_directory_structure === true);
  const secondDirectory = pendingSettings.find((request) => request.payload.saving.default_output_directory === "G:/directory-last");
  secondStructure.resolve({ settings: { saving: { default_output_directory: "G:/directory-first", preserve_directory_structure: true } } });
  await structureAfterDirectory;
  secondDirectory.resolve({ settings: { saving: { default_output_directory: "G:/directory-last", preserve_directory_structure: false } } });
  await directoryBeforeStructure;
  assert.deepEqual(state.settings.saving, { default_output_directory: "G:/directory-last", parallelism: 1, preserve_directory_structure: true }, "a late directory reply cannot replace a newly committed structure preference");
  runtime.nodes.get("#singleSaveOutputDirectoryStatus").value = "G:/reject";
  runtime.setHandler(async (url) => { if (url === "/api/settings?status=0") { const error = new Error("reject"); error.code = "output_folder_unavailable"; throw error; } return {}; });
  assert.equal(await runtime.commitOutputDirectory(runtime.nodes.get("#singleSaveOutputDirectoryStatus")), false);
  assert.equal(runtime.nodes.get("#singleSaveOutputDirectoryStatus").value, "G:/reject", "a rejected directory keeps its draft");
  assert.equal(state.saveStarting, false, "a rejected directory never starts a save");
  runtime.nodes.get("#singleSaveOutputDirectoryStatus").value = "G:/manual";
  runtime.setHandler(async (url) => url === "/api/save/render" ? { ok: false, status: 409, json: async () => ({ error_code: "save_state_changed" }) } : {}); await assert.rejects(runtime.renderSingleSave({}), (error) => error.code === "save_state_changed");
  runtime.setHandler(async (url) => { if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] }; if (url === "/api/save/render") return { ok: true, headers: { get() { return "single-token"; } }, body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; if (url === "/api/save/commit") return { cleared: false, stale: false }; if (url === "/api/images") return { images: state.images }; return {}; });
  state.singleSave = { imageId: "file", generation: state.imageGeneration, divisor: 16, draft: null }; runtime.nodes.get("#singleSaveSuffix").value = "_m"; await runtime.startSingleSave({ preventDefault() {} });
  assert.ok(runtime.calls.includes("candidates"), "a single overwrite redraws candidate controls after its save lock settles");
  runtime.calls.length = 0; runtime.finishSaveStart();
  assert.ok(runtime.calls.includes("candidates"), "a failed or cancelled batch start redraws candidate controls after releasing its lock");
  assert.equal(runtime.isTerminalApply({ kind: "detect", state: "complete" }), false); state.applyRunning = true; assert.equal(runtime.isTerminalApply({ kind: "apply", state: "complete" }), true); state.applyRunning = false; state.handledApplyStartedAt = 2; assert.equal(runtime.isTerminalApply({ kind: "apply", state: "complete", startedAt: 3 }), true);
  assert.equal(runtime.selectedSaveMode(), "copy"); assert.equal(runtime.sourceAccessFor("missing"), null); assert.equal(runtime.sourceCanOverwrite(state.images[0]), true); assert.equal(runtime.sourceCanDelete(state.images[1]), false); assert.equal(runtime.applyTargetsSupport("overwrite"), true);
  state.applyTargetIds = ["session"]; runtime.saveMode.value = "overwrite"; assert.match(runtime.applyRestrictionMessage(), /overwriteUnavailable/); runtime.syncApplyMode(); assert.equal(runtime.nodes.get("#applyStartButton").disabled, true);
  runtime.saveMode.value = "copy"; runtime.nodes.get("#deleteOriginal").checked = true; assert.equal(runtime.applyRestrictionMessage(), ""); runtime.syncApplyMode(); assert.equal(runtime.nodes.get("#deleteOriginal").checked, true, "copy-and-delete remains selected until its explicit-save preflight");
  state.sourceAccess.set("session", { fileHandle: {} }); runtime.syncApplyMode();
  assert.equal(runtime.nodes.get("#deleteOriginal").disabled, false, "a browser source without a remembered parent can request reconnection during explicit save");
  state.applyTargetIds = ["file"]; runtime.nodes.get("#applyTargetMode").value = "current"; runtime.refreshApplyTargets(); assert.equal(state.applyTargetMode, "current");
  runtime.context.busy = true; await runtime.openApplyDialog(); runtime.context.busy = false; runtime.context.flushError = new Error("draft failed"); await runtime.openApplyDialog(); runtime.context.flushError = null;
  state.applyTargetIds = []; await runtime.openApplyDialog([]); state.applyTargetIds = ["file"]; await runtime.openApplyDialog({ initialMode: "masked" }); assert.equal(runtime.nodes.get("#applyDialog").open, true);
  state.drafts.set("file", { add: "add", exclusion: "x", exclusionErase: "erase", manualEnabled: false, manualExclusionEnabled: false, manualExclusionEraseEnabled: false, removedCandidateIds: ["old"] }); assert.deepEqual(JSON.parse(JSON.stringify(runtime.draftPayload(["file", "missing"]))), { file: { add: "", exclusion: "", exclusionErase: "", manualExclusionForced: true, removedCandidateIds: ["old"] } });
  runtime.renderOutputDirectory(); assert.equal(runtime.nodes.get("#settingsDefaultOutputDirectory").value, "G:/directory-last"); runtime.setOutputDirectoryPickerBusy(true); assert.equal(state.outputDirectoryPicking, true); runtime.setOutputDirectoryPickerBusy(false);

  runtime.setHandler(async (url) => url === "/api/output-directory/pick" ? { cancelled: false, path: "G:/picked-again", settings: { saving: { default_output_directory: "G:/picked-again" } } } : {});
  const picked = await runtime.pickOutputDirectory(); assert.equal(picked, "G:/picked-again"); assert.equal(state.settings.saving.default_output_directory, "G:/picked-again"); await runtime.chooseOutputDirectory();

  assert.equal(await runtime.waitForBrowserSave({ paused: false, cancelled: false, failed: false }), true); assert.equal(await runtime.waitForBrowserSave({ paused: false, cancelled: true, failed: false }), false); runtime.showBrowserSaveProgress({ paused: true, entries: [{}], completed: 0 }, { relativePath: "file.png" }); assert.equal(state.job.state, "paused");
  state.images = [{ id: "file" }, { id: "kept" }]; state.drafts = new Map([["file", { hasEffectiveMask: true }], ["gone", { hasEffectiveMask: true }]]); state.maskStatus = new Map([["file", false], ["gone", true]]); runtime.reconcileStoredMaskStatuses(); assert.deepEqual([...state.maskStatus], [["file", true]]);
  state.currentId = "gone"; runtime.reconcileBrowserSaveState(); assert.equal(state.currentId, null); state.currentId = "file"; runtime.reconcileBrowserSaveState();

  let file = sourceBlob("session.png", 2, 3); const handle = { name: "session.png", async getFile() { return file; }, async queryPermission() { return "prompt"; }, async requestPermission() { return "granted"; }, async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } };
  const access = { fileHandle: handle, name: file.name, size: file.size, lastModified: file.lastModified }; await runtime.ensureHandlePermission(access, true); file = sourceBlob("session.png", 4, 3); await assert.rejects(runtime.ensureHandlePermission(access), (error) => error?.code === "stale_asset"); file = sourceBlob("session.png", 2, 3);
  state.images = [{ id: "session", sourceKind: "session" }]; state.sourceAccess.set("session", access); await runtime.ensureSaveSources(["session"], "overwrite", false); await assert.rejects(runtime.ensureSaveSources(["missing"], "overwrite", false), (error) => error?.code === "source_action_unavailable"); await assert.rejects(runtime.ensureSaveSources(["missing"], "copy", true), (error) => error?.code === "source_action_unavailable");
  const binary = { body: { async pipeTo(stream) { await stream.write(Uint8Array.from([1])); await stream.close(); } } }; await runtime.writeSourceHandle(access, binary); assert.equal(access.size, 2); assert.ok(await runtime.snapshotSourceHandle(access) instanceof Blob, "source overwrite snapshots browser bytes before a destructive mutation");
  access.parentHandle = { async getFileHandle() { return handle; } }; await runtime.restoreSourceHandle(access, new Blob([Uint8Array.from([1])]), true);
  // Migration coverage map: the browser runtime executes the durable save details
  // that used to be exercised below through an output directory handle:
  // picker error/cancel and duplicate-submit lock: runOutputDirectoryPermissionCases and runOutputPermissionSubmissionLockCases;
  // single/batch modes, reserve/render/commit/ack, retry, name collision, partial failure, 400-item pool and cleanup:
  // the named runtime cases in tests/test_browser_save_runtime.cjs. This gallery test keeps the gallery interactions and
  // the shared picker/save entry points without retaining retired output-handle implementation tests.
}

// Keep these failure boundaries in fresh browser-shaped runtimes: a failed
// save must leave both the source and its chosen output directory coherent.
async function saveCoverageMatrix() {
  const runtime = makeSaveRuntime(); const { state } = runtime;
  state.images = [{ id: "file", sourceKind: "filesystem", relativePath: "file.png", reviewed: true }];
  runtime.setHandler(async (url, options) => {
    if (url === "/api/save/prepare") return { entries: [{ imageId: "file", candidateRevision: 1, relativePath: "file.png" }] };
    if (url === "/api/save/reserve") return { state: "rendering" };
    if (url === "/api/save/render") return { ok: true, headers: { get(name) { return name === "X-Mozarie-Save-Token" ? JSON.parse(options.body).clientSaveToken : (name === "X-Mozarie-Output-Path-B64" ? Buffer.from("G:/out/file_m.png").toString("base64") : null); } } };
    if (url === "/api/save/commit") return { cleared: false, stale: false, outputPath: "G:/out/file_m.png" };
    if (url === "/api/save/ack") return { acknowledged: true };
    if (url === "/api/images") return { images: state.images };
    return {};
  });
  await runtime.runBrowserSave(["file"], "_m", false, "copy");
  assert.deepEqual(runtime.requests.filter((request) => ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"].includes(request.url)).map((request) => request.url), ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"], "gallery saves use prepare, reserve, render, commit, and acknowledgement in order");
  assert.equal(state.images[0].reviewed, true, "a gallery copy preserves reviewed state");
  // The browser runtime test owns the detailed server reservation and recovery matrix:
  // runSuccessCase, runRecoverableCommitFailureCases, runPartialOutputCleanupCases,
  // runBrowserCopyPoolAtScaleCases, and runBrowserCopyWriteFailureCancelsRenderCase.
  // They execute against the current HTTP lifecycle above; no File System Access output-directory path remains here.
}

nodeTest("gallery and save interactions", async () => {
  await galleryInteractions();
  await saveInteractions();
  await saveCoverageMatrix();
});
