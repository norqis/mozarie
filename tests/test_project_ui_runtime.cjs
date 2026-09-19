"use strict";

// Exercise the project dialogs through the same browser-facing functions and
// event handlers that ship in app.js.  This intentionally uses no test-only
// production hooks beyond exporting the public functions after evaluation.
const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const japanese = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", "ja.json"), "utf8"));
const english = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", "en.json"), "utf8"));

class Element {
  constructor(id = "") { this.id = id; this.value = ""; this.textContent = ""; this.hidden = false; this.disabled = false; this.open = false; this.checked = false; this.dataset = {}; this.style = {}; this.children = []; this.listeners = new Map(); this.listenerLists = new Map(); this.isConnected = true; this.offsetParent = {}; this.classList = { toggle() {} }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); const all = this.listenerLists.get(type) || []; all.push(listener); this.listenerLists.set(type, all); }
  append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; }
  replaceChildren(...children) { this.children = []; for (const child of children) this.append(...(child.isFragment ? child.children : [child])); }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const listener of this.listenerLists.get("close") || []) listener({ currentTarget: this }); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return node === this || this.children.includes(node); }
  closest() { return null; }
  querySelector(selector) {
    if (selector?.includes("[data-project-")) return this.querySelectorAll(selector)[0] || null;
    return this.submitControl || (this.submitControl = new Element("submit"));
  }
  querySelectorAll(selector) {
    const descendants = [];
    const visit = (node) => { for (const child of node.children || []) { descendants.push(child); visit(child); } };
    visit(this);
    const actions = [...String(selector || "").matchAll(/\[data-project-action="([^"]+)"\]/g)].map((match) => match[1]);
    if (actions.length) return descendants.filter((node) => actions.includes(node.dataset?.projectAction));
    if (selector === "tr[data-project-id]") return descendants.filter((node) => node.id === "tr" && node.dataset?.projectId);
    return [];
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
}

const elements = new Map();
const element = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element(selector)); return elements.get(selector); };
const dialogIds = ["#projectDialog", "#projectListDialog", "#projectNameDialog", "#sourceMismatchDialog", "#sameSourceDialog", "#projectDeleteDialog"];
for (const id of dialogIds) element(id);
const document = {
  body: new Element("body"), activeElement: null, visibilityState: "hidden",
  querySelector(selector) { return element(selector); },
  querySelectorAll(selector) { return selector === "dialog" ? dialogIds.map(element) : []; },
  createElement(tag) { return new Element(tag || "created"); }, createDocumentFragment() { const fragment = new Element("fragment"); fragment.isFragment = true; return fragment; }, addEventListener() {},
};

const calls = [];
let projects = [
  { id: "working", name: "Alpha", status: "working", imageCount: 2, sourceRoot: "C:/alpha", updatedAt: 2_000_000 },
  { id: "completed", name: "Beta", status: "completed", imageCount: 1, sourceRoot: "C:/beta", updatedAt: 1_000_000 },
  { id: "separate", name: "Gamma", status: "working", imageCount: 1, sourceRoot: "C:/alpha", updatedAt: 500_000 },
];
let openPayload = null;
const state = { project: null, projectReadOnly: false, projectOperationPending: false, catalogTransition: null, missingNativeSources: [], images: [], selectedImageIds: new Set(), candidateUpdateChains: new Map(), workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), candidateBatchPending: new Set(), settings: { general: { language: "ja" } }, importing: false };
const context = {
  console, Promise, Map, Set, WeakMap, Array, Object, Number, String, Boolean, Math, JSON, Error, Intl, AbortController,
  document, state, window: { addEventListener() {}, showDirectoryPicker: async () => ({ kind: "directory" }) }, URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
  setTimeout(callback) { callback(); return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); return 1; },
  $: element, t: (key, params = {}) => key === "project.imageCount" ? `${params.count}枚` : key,
  focusElement(value) { document.activeElement = value; }, loadTranslations: async () => {},
  isBusy: () => false, currentImageActionPending: () => false, isCurrentGeneration: () => true, isProcessableImage: (image) => Boolean(image && !image.hidden), currentRecord: () => state.images.find((image) => image.id === state.currentId) || null, beginCatalogEpoch: () => 1, isCurrentCatalogEpoch: () => true, runCatalogTransition: async (operation) => operation({ epoch: 1, signal: null }), catalogApi: (url, body, options) => context.api(url, { ...options, body: JSON.stringify(body) }), showUserError(error) { calls.push(["error", error.code || error.message]); },
  waitForCandidateMutations: async () => calls.push(["wait"]), flushAllImageMutations: async () => calls.push(["image-flush"]), flushAllWorkspaceMutations: async () => calls.push(["flush"]),
  resetCatalog(images) { state.images = images; state.currentId = null; state.selectedImageIds.clear(); calls.push(["reset", images.length]); }, applyProjectSnapshot(snapshot) { state.project = snapshot.project || state.project; state.projectReadOnly = snapshot.readOnly === true || state.project?.status === "completed"; calls.push(["snapshot"]); }, renderCatalogViews() { calls.push(["render"]); },
  updateActionButtons() { calls.push(["actions"]); }, rememberProjectSource: async () => "source", rememberProjectSourceCleanup: async () => "cleanup", forgetProjectSources: async (id) => calls.push(["forget", id]), loadFolder: async () => calls.push(["loadFolder"]),
  rememberedProjectSources: async () => ({ files: [], directories: [] }), matchingProjectDirectorySources: async () => [], ensureProjectSourcePermission: async () => true, requestProjectSourcePermission: async () => true,
  importProjectDirectoryHandle: async (_handle, _project, sourceId) => calls.push(["directory", sourceId]), importProjectFileHandles: async (sources) => { calls.push(["files", sources.length]); return []; },
  confirmAction: async () => true, fetch: async (url) => { calls.push(["fetch", url]); return { ok: true, blob: async () => new Blob(["mask"]) }; }, responseError: () => new Error("download failed"),
  api: async (url, options = {}) => {
    calls.push(["api", url, options.method]);
    if (url.startsWith("/api/projects?")) return { projects };
    if (url === "/api/project/open") return openPayload || { project: projects[0], images: [{ id: "native" }], needsSource: false };
    if (url === "/api/project/mismatches") return { images: [] };
    if (url === "/api/projects" && options.method === "POST") return { project: { id: "new", name: "New", status: "working", imageCount: 0 } };
    if (url === "/api/project/name") return { project: { ...state.project, name: "Renamed", status: "working" } };
    if (url === "/api/project/resume") return { project: { ...projects[1], status: "working" } };
    if (url === "/api/project/complete") return { project: { ...state.project, status: "completed" } };
    if (url === "/api/project/close") return { ok: true };
    if (url === "/api/project/working" && options.method === "DELETE") return { deleted: true };
    if (url === "/api/project/mismatches" && options.method === "POST") return { project: state.project, images: [{ id: "changed" }] };
    return {};
  },
};
const submitRenameImage = () => calls.push(["rename-submit"]);
context.submitRenameImage = submitRenameImage;
// bindEvents also attaches the established editor controls.  They are inert in
// this project-focused fixture, but defining their collaborators keeps the
// real binding pass intact instead of testing a copied subset.
for (const name of [
  "openSettings", "selectSettingsTab", "moveSettingsTab", "saveSettings", "resetSettings", "chooseSettingsOutputDirectory", "chooseSettingsModelFile", "startModelDownload", "cancelModelDownload", "beginModelDownload", "syncProviderSelection", "markModelStatusDirty", "selectSamVariant", "startUpdate", "handleToolRailKeydown", "setToolRailTabStop", "setModelCardEnabled", "setHandSegmentationAvailable", "setPrecisionDetectionEnabled", "refreshSettingsStatus", "setFluidExclusionEnabled", "pickImageFiles", "pickImageDirectory", "importDroppedFiles", "loadFolder", "openDetectionDialog", "validateDetectionTargets", "runDetection", "saveAll", "saveCurrent", "setDisplayMode", "fitImage", "updateCompareSplitter", "render", "updateBrushCursor", "updateBrushSize", "setHidden", "clearMasks", "closeBatchMoreMenus", "closeFilterPopovers", "syncResourceOwnership", "clearCatalog", "renderGallery", "setViewMode", "runNavigationAction", "moveCurrentBy", "reviewAndMoveNext", "removeImageFromCatalog", "hideAndMoveNext", "runSelectionAction", "clearBatchSelection", "renderOverview", "updateSelectionActionBar", "reconcileOverviewSelection", "batchCandidateOperation", "toggleCandidateDisplay", "toggleCandidateEffective", "renderShortcutBindings", "setTool", "setBoundaryModeMenuOpen", "addBoundaryCandidate", "cancelBoundary", "setMosaicPreviewEnabled", "requestMosaicPreview", "updateBlockSizeDisplay", "setDetectionConfidence", "syncDetectionTargetSwitch", "syncDetectionFluidColorFill", "validateDetectionFluidColorFill", "startDetectionFromDialog", "restoreSnapshot", "resizeRenderCanvas", "refreshApplyTargets", "chooseOutputDirectory", "syncApplyMode", "controlApply", "startApplyFromDialog", "chooseSingleOutputDirectory", "syncSingleSaveMode", "startSingleSave", "showProcessing", "updateProgress", "scheduleJobPoll", "cancelDetection", "setReviewed", "closeCatalogContextMenu", "copyContextMenuImagePath", "setGalleryDropOverlay", "beginBoundaryBrushStroke", "appendBoundaryBrushPoint", "beginManualStroke", "appendManualStrokePoint", "fillAt", "completeManualStroke", "cancelManualStroke", "completeBoundaryBrushStroke", "flushRender", "closeBoundaryModeMenu", "cancelFillWork", "handleWindowKeydown", "addBoundaryDraft", "setSettingsForm", "initCandidatePaddingPopover",
]) if (!(name in context)) context[name] = () => {};
context.canvas = new Element("canvas"); context.stage = new Element("stage"); context.toolRail = new Element("toolRail"); context.toolRailItems = () => []; context.modelDownloadPoll = null;

const appPath = path.join(__dirname, "..", "static", "js", "app.js");
const corePath = path.join(__dirname, "..", "static", "js", "core.js");
const imageDisplayPathSource = fs.readFileSync(corePath, "utf8").match(/function imageDisplayPath\(image\) \{[\s\S]*?\n\}/)?.[0];
vm.runInNewContext(imageDisplayPathSource, context, { filename: corePath });
vm.runInNewContext(fs.readFileSync(appPath, "utf8"), context, { filename: appPath });
vm.runInNewContext("globalThis.projectTest={projectTitle,projectDate,projectSource,renderProjectCurrent,renderNativeRelinkDialog,showSameSourceDialog,openProjectNameDialog,showProjectList,showSourceMismatches,openProject,downloadProjectArtifact,downloadProjectMasks,renderProjectTableControls,resumeCurrentProject,openSameSourceDialog,openProjectDeleteDialog,deleteProject,bindEvents,setPendingBrowserProjectSources:(sources)=>{ pendingBrowserProjectSources=sources; },pendingBrowserProjectSources:()=>pendingBrowserProjectSources};", context, { filename: "project-ui-exports.js" });
const test = context.projectTest;

nodeTest("project dialogs, source recovery, and project switching", async (t) => {
  await new Promise((resolve) => setImmediate(resolve));
  for (const key of ["project.open", "project.new", "project.name", "project.openList", "project.complete", "project.close", "project.resume", "project.sourceChangedClear", "project.downloadMosaic", "project.downloadExclude", "project.downloadMosaicZip", "project.downloadExcludeZip", "project.delete", "project.deleteData", "project.deleteSource", "project.deleteIrreversible"]) {
    assert.equal(typeof japanese[key], "string", `Japanese includes ${key}`); assert.equal(typeof english[key], "string", `English includes ${key}`);
  }
  for (const dialog of ["projectDialog", "projectListDialog", "projectNameDialog", "sourceMismatchDialog", "sameSourceDialog", "projectDeleteDialog"]) assert.match(indexHtml, new RegExp(`<dialog id="${dialog}"[^>]*aria-labelledby=`), `${dialog} is named for assistive technology`);
  assert.equal(document.body.textContent, "error.browserUnsupported", "the project VM starts in the browser capability guard");
  assert.equal(test.projectTitle(null), "project.unnamed"); assert.equal(test.projectSource(null), "project.noSource"); assert.equal(test.projectDate(0), "project.noDate");

  state.project = projects[0]; state.projectReadOnly = false; test.renderProjectCurrent();
  assert.equal(element("#projectComplete").disabled, false, "working projects can be completed");
  state.project = projects[1]; state.projectReadOnly = true; test.renderProjectCurrent();
  assert.equal(element("#projectResume").hidden, false, "completed projects visibly expose Resume work");
  assert.equal(element("#projectComplete").disabled, true, "completed projects are read-only");
  test.openProjectNameDialog("name"); assert.equal(element("#projectNameInput").value, "Beta");

  for (const sort of ["updated_desc", "updated_asc", "name_asc", "name_desc", "created_desc", "created_asc"]) {
    element("#projectSort").value = sort; await test.showProjectList();
    assert.equal(element("#projectListBody").children.length, projects.length, `${sort} renders every project`);
    assert.equal(element("#projectListBody").children.every((row) => row.children.at(-1).children[0].children.some((child) => child.textContent === "project.deleteShort")), true, `${sort} exposes delete for every project`);
  }
  openPayload = { project: projects[0], images: [{ id: "native" }], needsSource: false };
  await test.openProject(projects[0]); assert.equal(state.images[0].id, "native", "native projects open immediately");

  openPayload = { project: projects[2], images: [{ id: "beta-image" }], needsSource: false };
  state.currentId = "native"; state.selectedImageIds.add("native");
  await test.openProject(projects[2]);
  assert.deepEqual({ project: state.project.id, image: state.images[0].id, currentId: state.currentId, selected: [...state.selectedImageIds] }, { project: "separate", image: "beta-image", currentId: null, selected: [] }, "A to B replaces catalog selection rather than retaining project A state");
  openPayload = { project: projects[0], images: [{ id: "alpha-return" }], needsSource: false };
  await test.openProject(projects[0]);
  assert.deepEqual({ project: state.project.id, image: state.images[0].id, currentId: state.currentId, selected: [...state.selectedImageIds] }, { project: "working", image: "alpha-return", currentId: null, selected: [] }, "A to B to A restores only project A's returned catalog without B selection leakage");

  openPayload = { project: projects[0], images: [], needsSource: true };
  context.rememberedProjectSources = async () => ({ directories: [{ sourceId: "dir", handle: { kind: "directory" } }], files: [{ sourceId: "files", handle: { kind: "file" } }] });
  let granted = [true, false]; context.ensureProjectSourcePermission = async () => granted.shift();
  await test.openProject(projects[0]);
  assert.ok(calls.some(([kind, value]) => kind === "directory" && value === "dir"), "granted folder handles relink a project");
  assert.equal(element("#projectBrowserRestore").hidden, false, "a denied source permission is retained as an explicit restore action");
  granted = [true, true]; await test.openProject(projects[0]); assert.ok(calls.some(([kind, count]) => kind === "files" && count === 1), "granted file handles relink their saved source");

  context.api = async (url, options = {}) => {
    calls.push(["api", url, options.method]);
    if (url === "/api/project/mismatches" && options.method !== "POST") return { images: [{ id: "changed", relativePath: "changed.png", dimensionsChanged: true }] };
    if (url === "/api/project/mismatches") return { project: projects[0], images: [{ id: "changed" }] };
    if (url === "/api/project/source-check") return { projects: [projects[0], projects[2]] };
    if (url === "/api/projects?sort=updated_desc") return { projects };
    if (url === "/api/project/resume") return { project: { ...projects[1], status: "working" } };
    if (url === "/api/project/complete") return { project: { ...state.project, status: "completed" } };
    if (url === "/api/project/close") return { ok: true };
    if (url === "/api/project/working" && options.method === "DELETE") return { deleted: true };
    if (url === "/api/projects" && options.method === "POST") return { project: { id: "new", name: "New", status: "working", imageCount: 0 } };
    if (url === "/api/project/name") return { project: { ...state.project, name: "Renamed", status: "working" } };
    return openPayload;
  };
  await test.showSourceMismatches(); assert.match(element("#sourceMismatchList").children[0].textContent, /project.dimensionsChanged/, "size changes are clearly identified before any deletion choice");
  await test.openSameSourceDialog("C:/alpha/"); assert.equal(element("#sameSourceList").children.length, 1, "same-folder warning excludes the active project and lists the existing project");
  await test.downloadProjectArtifact("/api/project/masks/mosaic", "mosaic.zip");

  // An unsuccessful open keeps the current project and its browser source
  // recovery action visible.  The pending list belongs to the old catalog
  // until a new project-open response has actually been accepted.
  state.project = projects[0]; state.images = [{ id: "old" }]; state.currentId = "old";
  test.setPendingBrowserProjectSources([{ projectId: "working", key: "file:old", kind: "file", handle: { name: "old" } }]);
  test.renderProjectCurrent();
  assert.equal(element("#projectBrowserRestore").hidden, false, "the current project exposes its pending browser-source recovery action");
  const oldProject = state.project; const oldImages = state.images;
  context.api = async (url, options = {}) => {
    calls.push(["api", url, options.method]);
    if (url === "/api/project/open") throw new Error("open failed");
    return {};
  };
  await test.openProject(projects[2]);
  assert.equal(state.project, oldProject, "a failed project open keeps the prior project");
  assert.equal(state.images, oldImages, "a failed project open keeps the prior catalog");
  assert.equal(test.pendingBrowserProjectSources().length, 1, "a failed project open keeps pending browser-source recovery state");
  test.renderProjectCurrent();
  assert.equal(element("#projectBrowserRestore").hidden, false, "a failed project open keeps its recovery UI visible");
  const restoreButton = element("#projectBrowserRestoreList").children[0].children[0];
  assert.equal(restoreButton.disabled, false, "a retained browser source recovery action is enabled when no project operation is pending");
  restoreButton.listeners.get("click")(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(test.pendingBrowserProjectSources().length, 0, "a browser source recovery action removes only its restored pending source");
  state.missingNativeSources = [
    { id: "native-a", displayName: "A", nativePath: "C:/old-a", kind: "native-folder", exists: false },
    { id: "native-b", displayName: "B", nativePath: "C:/old-b", kind: "native-folder", exists: false },
  ];
  test.renderNativeRelinkDialog();
  const nativeSecond = element("#nativeRelinkSources").children[1].children[0];
  await nativeSecond.listeners.get("click")();
  assert.equal(element("#nativeRelinkPath").value, "C:/old-b", "a native relink list choice selects that source's retained path");
  test.showSameSourceDialog([projects[0], projects[2]], { path: "C:/alpha/" });
  const sameSourceSecond = element("#sameSourceList").children[1].children[0];
  await sameSourceSecond.listeners.get("click")();
  context.api = async (url, options = {}) => {
    calls.push(["api", url, options.method]);
    if (url === "/api/project/mismatches" && options.method !== "POST") return { images: [{ id: "changed", relativePath: "changed.png", dimensionsChanged: true }] };
    if (url === "/api/project/mismatches") return { project: projects[0], images: [{ id: "changed" }] };
    if (url === "/api/project/source-check") return { projects: [projects[0], projects[2]] };
    if (url === "/api/projects?sort=updated_desc") return { projects };
    if (url === "/api/project/resume") return { project: { ...projects[1], status: "working" } };
    if (url === "/api/project/complete") return { project: { ...state.project, status: "completed" } };
    if (url === "/api/project/close") return { ok: true };
    if (url === "/api/project/working" && options.method === "DELETE") return { deleted: true };
    if (url === "/api/projects" && options.method === "POST") return { project: { id: "new", name: "New", status: "working", imageCount: 0 } };
    if (url === "/api/project/name") return { project: { ...state.project, name: "Renamed", status: "working" } };
    return openPayload;
  };

  test.bindEvents();
  assert.equal(element("#renameImageForm").listeners.get("submit"), submitRenameImage, "project fixture keeps the bound rename submit collaborator intact");
  const fire = async (id, type = "click") => { const listener = element(id).listeners.get(type); assert.ok(listener, `${id} is interactive`); await listener({ preventDefault() {} }); await new Promise((resolve) => setImmediate(resolve)); };
  await fire("#projectButton"); await fire("#projectClose"); await fire("#projectNew"); await fire("#projectName"); await fire("#projectOpenList"); await fire("#projectListClose");
  state.project = projects[0]; state.projectReadOnly = false; await fire("#projectSourceAdd");
  assert.ok(calls.some(([kind]) => kind === "directory"), "the current project can select a native source folder");
  state.project = projects[1]; state.projectReadOnly = true; await fire("#projectResume"); assert.equal(state.projectReadOnly, false, "Resume work turns a completed project back into working state");
  await fire("#projectCloseWorkspace");
  state.images = [{ id: "native" }]; state.currentId = "native"; await fire("#downloadCurrentMosaicMask"); await fire("#downloadCurrentExcludeMask");
  for (const url of ["/api/project/masks/mosaic", "/api/project/mask/native/mosaic", "/api/project/mask/native/exclude"]) assert.ok(calls.some(([kind, value]) => kind === "fetch" && value === url), `${url} is exported from its matching project control`);
  state.project = projects[0]; state.projectReadOnly = false; await fire("#projectComplete"); assert.equal(state.project, null, "completion closes only the live list after confirmation");
  state.project = projects[0]; state.images = [{ id: "pending" }]; state.workspaceDraftTimers.set("pending", 1); test.openProjectDeleteDialog("working");
  assert.equal(element("#projectDeleteDialog").open, true, "delete asks for explicit confirmation");
  await fire("#projectDeleteCancel"); assert.equal(element("#projectDeleteDialog").open, false, "cancel leaves the project untouched");
  const callsBeforeDelete = calls.length; test.openProjectDeleteDialog("working");
  await fire("#projectDeleteConfirm"); await new Promise((resolve) => setImmediate(resolve)); assert.equal(state.project, null, "deleting the current project closes its live workspace");
  assert.ok(calls.some(([kind, url, method]) => kind === "api" && url === "/api/project/working" && method === "DELETE"), "project deletion uses one explicit DELETE request");
  assert.ok(calls.some(([kind, id]) => kind === "forget" && id === "working"), "project deletion removes browser source handles");
  assert.equal(calls.slice(callsBeforeDelete).some(([kind]) => kind === "flush"), true, "deleting the active project flushes its workspace mutation queue before the server delete");
  state.project = projects[0]; element("#projectNameInput").value = "Renamed"; await fire("#projectNameForm", "submit"); await fire("#projectNameCancel");
  element("#sourceMismatchDialog").dataset.imageIds = JSON.stringify(["changed"]); element("#sourceMismatchClear").checked = true;
  let releaseMismatchFlush;
  context.flushAllImageMutations = () => new Promise((resolve) => { releaseMismatchFlush = resolve; });
  const mismatchPostsBefore = calls.filter(([kind, url]) => kind === "api" && url === "/api/project/mismatches").length;
  const sourceMismatchSubmit = element("#sourceMismatchForm").listeners.get("submit");
  const firstMismatchSubmit = sourceMismatchSubmit({ preventDefault() {} });
  const secondMismatchSubmit = sourceMismatchSubmit({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(element("#sourceMismatchConfirm").disabled, true, "a pending mismatch submit disables its confirm action");
  assert.equal(element("#sourceMismatchCancel").disabled, true, "a pending mismatch submit disables cancellation while its catalog mutation is unsettled");
  let preventedMismatchDismiss = false;
  element("#sourceMismatchDialog").listeners.get("cancel")({ preventDefault() { preventedMismatchDismiss = true; } });
  assert.equal(preventedMismatchDismiss, true, "Escape cannot dismiss a mismatch dialog while its catalog mutation is pending");
  releaseMismatchFlush(); await firstMismatchSubmit; await secondMismatchSubmit;
  assert.equal(element("#sourceMismatchConfirm").disabled, false, "mismatch controls are restored after the request settles");
  preventedMismatchDismiss = false;
  element("#sourceMismatchDialog").listeners.get("cancel")({ preventDefault() { preventedMismatchDismiss = true; } });
  assert.equal(preventedMismatchDismiss, false, "Escape can dismiss a mismatch dialog again after its catalog mutation settles");
  assert.equal(calls.filter(([kind, url]) => kind === "api" && url === "/api/project/mismatches").length, mismatchPostsBefore + 1, "a second mismatch submit cannot start a competing catalog mutation");
  context.flushAllImageMutations = async () => calls.push(["image-flush"]);
  await fire("#sourceMismatchCancel");
  let sameSourceOpenedProjectId = "";
  const apiBeforeSameSourceOpen = context.api;
  context.api = async (url, options = {}) => {
    if (url === "/api/project/open") {
      sameSourceOpenedProjectId = JSON.parse(options.body).projectId;
      return { project: projects[2], images: [], needsSource: false };
    }
    return apiBeforeSameSourceOpen(url, options);
  };
  await fire("#sameSourceOpen");
  assert.equal(sameSourceOpenedProjectId, "separate", "a same-source list choice directs Open to its selected project");
  await fire("#sameSourceSeparate"); await fire("#sameSourceCancel");

  await t.test("project mask exports preserve project state across empty read-only failure and retry cases", async () => {
    const empty = { id: "empty", name: "Empty", status: "working", imageCount: 0, sourceRoot: "C:/empty", updatedAt: 3_000_000 };
    const readonly = { id: "readonly", name: "Read only", status: "completed", imageCount: 2, sourceRoot: "C:/readonly", updatedAt: 4_000_000 };
    projects = [empty, readonly];
    context.api = async (url) => url.startsWith("/api/projects?") ? { projects } : {};
    element("#projectOpenList").listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    const rows = element("#projectListBody").children;
    const emptyRow = rows.find((row) => row.dataset.projectId === empty.id);
    assert.equal(emptyRow.querySelector('[data-project-action="mosaic"]').disabled, true, "an empty project disables mosaic ZIP only");
    assert.equal(emptyRow.querySelector('[data-project-action="exclude"]').disabled, true, "an empty project disables exclusion ZIP only");
    assert.equal(emptyRow.querySelector('[data-project-action="open"]').disabled, false, "an empty project can still be opened");
    assert.equal(emptyRow.querySelector('[data-project-action="delete"]').disabled, false, "an empty project can still be deleted");

    const working = { id: "working-export", name: "Working", status: "working", imageCount: 1 };
    state.project = working; state.projectReadOnly = false; state.images = [{ id: "draft" }]; state.currentId = "draft";
    const exportOrder = [];
    context.flushAllImageMutations = async () => exportOrder.push("image-flush");
    context.flushAllWorkspaceMutations = async () => exportOrder.push("workspace-flush");
    context.fetch = async () => { exportOrder.push("fetch"); return { ok: true, blob: async () => new Blob(["zip"]) }; };
    await test.downloadProjectMasks(working, "mosaic");
    assert.deepEqual(exportOrder, ["image-flush", "workspace-flush", "fetch"], "the active project flushes candidate and workspace edits before ZIP export");

    state.project = working; state.projectReadOnly = false; state.images = [{ id: "kept" }]; state.currentId = "kept";
    const stateBefore = { project: state.project, images: state.images, currentId: state.currentId, readOnly: state.projectReadOnly };
    let attempts = 0;
    context.fetch = async (url) => {
      calls.push(["project-export-fetch", url]); attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { ok: true, blob: async () => new Blob(["zip"]) };
    };
    const errorsBefore = calls.filter(([kind]) => kind === "error").length;
    await test.downloadProjectMasks(readonly, "exclude");
    assert.equal(calls.filter(([kind]) => kind === "error").length, errorsBefore + 1, "an offline export reports one error");
    assert.deepEqual({ project: state.project, images: state.images, currentId: state.currentId, readOnly: state.projectReadOnly }, stateBefore, "a failed export of another read-only project preserves the current working project and editor state");
    await test.downloadProjectMasks(readonly, "exclude");
    assert.equal(attempts, 2, "the same project ZIP export can be retried after reconnecting");
    assert.equal(calls.filter(([kind, url]) => kind === "project-export-fetch" && url.includes(readonly.id)).length, 2, "both attempts target the selected read-only row rather than the current project");
    assert.deepEqual({ project: state.project, images: state.images, currentId: state.currentId, readOnly: state.projectReadOnly }, stateBefore, "a completed read-only export never switches the current working project");
  });

  await t.test("project network failures preserve list order editor state and selected project", async () => {
    projects = [
      { id: "first", name: "First", status: "working", imageCount: 1, updatedAt: 2 },
      { id: "second", name: "Second", status: "working", imageCount: 1, updatedAt: 1 },
    ];
    context.api = async (url) => url.startsWith("/api/projects?") ? { projects } : {};
    element("#projectSort").value = "updated_desc";
    await test.showProjectList();
    const priorRows = [...element("#projectListBody").children];
    const priorErrors = calls.filter(([kind]) => kind === "error").length;
    context.api = async () => { throw new Error("offline"); };
    element("#projectOpenList").listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(element("#projectListBody").children, priorRows, "a failed list refresh keeps the fetched row order");
    assert.equal(element("#projectSort").value, "updated_desc", "a failed list refresh keeps its sort direction");

    const project = projects[0];
    const image = { id: "kept", relativePath: "kept.png" };
    state.project = project; state.images = [image]; state.currentId = image.id;
    state.candidates = [{ id: "candidate" }]; state.drafts = new Map([[image.id, { add: "manual" }]]);
    state.reviewedImageIds = new Set([image.id]);
    const editorBefore = { project: state.project, images: state.images, currentId: state.currentId, candidates: state.candidates, drafts: state.drafts, reviewed: state.reviewedImageIds };
    await test.openProject(projects[1]);
    assert.deepEqual({ project: state.project, images: state.images, currentId: state.currentId, candidates: state.candidates, drafts: state.drafts, reviewed: state.reviewedImageIds }, editorBefore, "a failed project open keeps the selected project and editor state");

    element("#projectNameInput").value = "Changed";
    element("#projectNameDialog").dataset.projectId = project.id;
    element("#projectNameForm").listeners.get("submit")({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.project, project, "a failed rename keeps the prior project object and name");
    assert.equal(state.candidates, editorBefore.candidates, "a failed rename keeps candidates");
    assert.equal(state.drafts, editorBefore.drafts, "a failed rename keeps manual edits");
    assert.equal(state.reviewedImageIds, editorBefore.reviewed, "a failed rename keeps review state");

    test.openProjectDeleteDialog(project.id);
    element("#projectDeleteConfirm").listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.project, project, "a failed delete keeps the selected project");
    assert.deepEqual(element("#projectListBody").children, priorRows, "a failed delete does not report success by removing the existing rows");
    assert.ok(calls.filter(([kind]) => kind === "error").length >= priorErrors + 4, "each failed project operation reports an error");
  });
});
