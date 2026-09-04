"use strict";

// Exercise the project dialogs through the same browser-facing functions and
// event handlers that ship in app.js.  This intentionally uses no test-only
// production hooks beyond exporting the public functions after evaluation.
const assert = require("node:assert/strict");
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
  replaceChildren(...children) { this.children = []; this.append(...children); }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const listener of this.listenerLists.get("close") || []) listener({ currentTarget: this }); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return node === this || this.children.includes(node); }
  closest() { return null; }
  querySelectorAll() { return []; }
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
  createElement() { return new Element("created"); }, addEventListener() {},
};

const calls = [];
let projects = [
  { id: "working", name: "Alpha", status: "working", imageCount: 2, sourceRoot: "C:/alpha", updatedAt: 2_000_000 },
  { id: "completed", name: "Beta", status: "completed", imageCount: 1, sourceRoot: "C:/beta", updatedAt: 1_000_000 },
  { id: "separate", name: "Gamma", status: "working", imageCount: 1, sourceRoot: "C:/alpha", updatedAt: 500_000 },
];
let openPayload = null;
const state = { project: null, projectReadOnly: false, images: [], drafts: new Map(), sourceAccess: new Map(), candidateUpdateChains: new Map(), workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), candidateBatchPending: new Set(), settings: { general: { language: "ja" } }, importing: false };
const context = {
  console, Promise, Map, Set, WeakMap, Array, Object, Number, String, Boolean, Math, JSON, Error, Intl,
  document, state, window: { addEventListener() {}, showDirectoryPicker: async () => ({ kind: "directory" }) }, URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
  setTimeout(callback) { callback(); return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); return 1; },
  $: element, t: (key, params = {}) => key === "project.imageCount" ? `${params.count}枚` : key,
  focusElement(value) { document.activeElement = value; }, loadTranslations: async () => {},
  showUserError(error) { calls.push(["error", error.code || error.message]); },
  waitForCandidateMutations: async () => calls.push(["wait"]), flushAllWorkspaceMutations: async () => calls.push(["flush"]), queueWorkspaceDraft: () => calls.push(["queueDraft"]), loadReviewedPaths: () => calls.push(["reviewed"]),
  resetCatalog(images) { state.images = images; calls.push(["reset", images.length]); }, applyProjectSnapshot(snapshot) { state.project = snapshot.project || state.project; state.projectReadOnly = snapshot.readOnly === true || state.project?.status === "completed"; calls.push(["snapshot"]); }, renderCatalogViews() { calls.push(["render"]); },
  updateActionButtons() { calls.push(["actions"]); }, rememberProjectSource: async () => "source", forgetProjectSources: async (id) => calls.push(["forget", id]), loadFolder: async () => calls.push(["loadFolder"]),
  rememberedProjectFileSources: async () => [], rememberedProjectDirectorySources: async () => [], ensureProjectSourcePermission: async () => true,
  importProjectDirectoryHandle: async (_handle, _project, sourceId) => calls.push(["directory", sourceId]), importProjectFileHandles: async (sources) => calls.push(["files", sources.length]),
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
// bindEvents also attaches the established editor controls.  They are inert in
// this project-focused fixture, but defining their collaborators keeps the
// real binding pass intact instead of testing a copied subset.
for (const name of [
  "openSettings", "selectSettingsTab", "moveSettingsTab", "saveSettings", "resetSettings", "chooseSettingsOutputDirectory", "chooseSettingsModelFile", "startModelDownload", "cancelModelDownload", "beginModelDownload", "syncProviderSelection", "markModelStatusDirty", "selectSamVariant", "startUpdate", "handleToolRailKeydown", "setToolRailTabStop", "setModelCardEnabled", "setHandSegmentationAvailable", "setPrecisionDetectionEnabled", "refreshSettingsStatus", "setFluidExclusionEnabled", "pickImageFiles", "pickImageDirectory", "importDroppedFiles", "loadFolder", "openDetectionDialog", "validateDetectionTargets", "runDetection", "saveAll", "saveCurrent", "setDisplayMode", "fitImage", "updateCompareSplitter", "render", "updateBrushCursor", "updateBrushSize", "setHidden", "clearMasks", "closeBatchMoreMenus", "clearCatalog", "renderGallery", "setViewMode", "runNavigationAction", "moveCurrentBy", "reviewAndMoveNext", "removeImageFromCatalog", "hideAndMoveNext", "runSelectionAction", "clearBatchSelection", "renderOverview", "updateSelectionActionBar", "batchCandidateOperation", "toggleCandidateDisplay", "toggleCandidateEffective", "renderShortcutBindings", "setTool", "setBoundaryModeMenuOpen", "addBoundaryCandidate", "cancelBoundary", "setMosaicPreviewEnabled", "requestMosaicPreview", "updateBlockSizeDisplay", "setDetectionConfidence", "syncDetectionTargetSwitch", "startDetectionFromDialog", "restoreSnapshot", "resizeRenderCanvas", "refreshApplyTargets", "chooseOutputDirectory", "syncApplyMode", "controlApply", "startApplyFromDialog", "chooseSingleOutputDirectory", "syncSingleSaveMode", "startSingleSave", "showProcessing", "updateProgress", "scheduleJobPoll", "cancelDetection", "setReviewed", "closeCatalogContextMenu", "copyContextMenuImagePath", "setGalleryDropOverlay", "beginBoundaryBrushStroke", "appendBoundaryBrushPoint", "beginManualStroke", "appendManualStrokePoint", "fillAt", "completeManualStroke", "cancelManualStroke", "completeBoundaryBrushStroke", "flushRender", "closeBoundaryModeMenu", "cancelFillWork", "handleWindowKeydown", "addBoundaryDraft", "setSettingsForm", "initCandidatePaddingPopover",
]) if (!(name in context)) context[name] = () => {};
context.canvas = new Element("canvas"); context.stage = new Element("stage"); context.toolRail = new Element("toolRail"); context.toolRailItems = () => []; context.modelDownloadPoll = null;

const appPath = path.join(__dirname, "..", "static", "js", "app.js");
vm.runInNewContext(fs.readFileSync(appPath, "utf8"), context, { filename: appPath });
vm.runInNewContext("globalThis.projectTest={projectTitle,projectDate,projectSource,renderProjectCurrent,openProjectNameDialog,showProjectList,showSourceMismatches,openProject,downloadProjectArtifact,resumeCurrentProject,openSameSourceDialog,openProjectDeleteDialog,deleteProject,discardProjectWorkspaceChanges,bindEvents};", context, { filename: "project-ui-exports.js" });
const test = context.projectTest;

(async () => {
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
    assert.equal(element("#projectList").children.length, projects.length, `${sort} renders every project`);
    assert.equal(element("#projectList").children.every((row) => row.children.some((child) => child.textContent === "project.delete")), true, `${sort} exposes delete for every project`);
  }
  openPayload = { project: projects[0], images: [{ id: "native" }], needsSource: false };
  await test.openProject(projects[0]); assert.equal(state.images[0].id, "native", "native projects open immediately");

  openPayload = { project: projects[0], images: [], needsSource: true };
  context.rememberedProjectDirectorySources = async () => [{ sourceId: "dir", handle: { kind: "directory" } }];
  context.rememberedProjectFileSources = async () => [{ sourceId: "files", handle: { kind: "file" } }];
  let granted = [true, false]; context.ensureProjectSourcePermission = async () => granted.shift();
  await test.openProject(projects[0]);
  assert.ok(calls.some(([kind, value]) => kind === "directory" && value === "dir"), "granted folder handles relink a project");
  assert.ok(calls.some(([kind, code]) => kind === "error" && code === "project_source_unavailable"), "a denied source permission is surfaced without losing the project");
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

  test.bindEvents();
  const fire = async (id, type = "click") => { const listener = element(id).listeners.get(type); assert.ok(listener, `${id} is interactive`); await listener({ preventDefault() {} }); await new Promise((resolve) => setImmediate(resolve)); };
  await fire("#projectButton"); await fire("#projectClose"); await fire("#projectNew"); await fire("#projectName"); await fire("#projectOpenList"); await fire("#projectListClose"); await fire("#projectSort", "change");
  state.project = projects[0]; state.projectReadOnly = false; await fire("#projectSourceSelect");
  assert.ok(calls.some(([kind]) => kind === "directory"), "the current project can select a native source folder");
  state.project = projects[1]; state.projectReadOnly = true; await fire("#projectResume"); assert.equal(state.projectReadOnly, false, "Resume work turns a completed project back into working state");
  await fire("#projectMosaicZip"); await fire("#projectExcludeZip"); await fire("#projectCloseWorkspace");
  state.currentId = "native"; await fire("#downloadCurrentMosaicMask"); await fire("#downloadCurrentExcludeMask");
  for (const url of ["/api/project/masks/mosaic", "/api/project/masks/exclude", "/api/project/mask/native/mosaic", "/api/project/mask/native/exclude"]) assert.ok(calls.some(([kind, value]) => kind === "fetch" && value === url), `${url} is exported from its matching project control`);
  state.project = projects[0]; state.projectReadOnly = false; await fire("#projectComplete"); assert.equal(state.project, null, "completion closes only the live list after confirmation");
  state.project = projects[0]; state.images = [{ id: "pending" }]; state.workspaceDraftTimers.set("pending", 1); await fire("#projectDelete");
  assert.equal(element("#projectDeleteDialog").open, true, "delete asks for explicit confirmation");
  await fire("#projectDeleteCancel"); assert.equal(element("#projectDeleteDialog").open, false, "cancel leaves the project untouched");
  const callsBeforeDelete = calls.length; await fire("#projectDelete");
  await fire("#projectDeleteConfirm"); await new Promise((resolve) => setImmediate(resolve)); assert.equal(state.project, null, "deleting the current project closes its live workspace");
  assert.ok(calls.some(([kind, url, method]) => kind === "api" && url === "/api/project/working" && method === "DELETE"), "project deletion uses one explicit DELETE request");
  assert.ok(calls.some(([kind, id]) => kind === "forget" && id === "working"), "project deletion removes browser source handles");
  assert.equal(calls.slice(callsBeforeDelete).some(([kind]) => kind === "flush"), false, "deletion discards pending work instead of flushing it only to delete it");
  state.project = projects[0]; element("#projectNameInput").value = "Renamed"; await fire("#projectNameForm", "submit"); await fire("#projectNameCancel");
  calls.length = 0;
  state.project = null; state.images = [{ id: "browser-image" }]; state.drafts = new Map([["browser-image", { add: "data:image/png;base64,draft" }]]); state.sourceAccess = new Map(); state.candidateUpdateChains = new Map([["browser-image", Promise.resolve()]]);
  context.api = async (url, options = {}) => {
    calls.push(["api", url, options.method]);
    if (url === "/api/project/name") return { project: { id: "promoted", name: "Promoted", status: "working" } };
    if (url === "/api/images") return { project: { id: "promoted", name: "Promoted", status: "working" }, images: [{ id: "browser-image" }] };
    return {};
  };
  test.openProjectNameDialog("name"); element("#projectNameInput").value = "Promoted"; await fire("#projectNameForm", "submit");
  assert.deepEqual(calls.slice(0, 4).map(([kind, url]) => kind === "api" ? `${kind}:${url}` : kind), ["wait", "flush", "api:/api/project/name", "api:/api/images"], "projectless promotion waits for candidate and workspace writes before naming the project");
  assert.equal(calls.filter(([kind]) => kind === "flush").length, 1, "projectless promotion flushes workspace mutations only before naming");
  assert.equal(calls.some(([kind]) => kind === "queueDraft"), false, "projectless promotion does not replay browser drafts after naming");

  calls.length = 0;
  state.project = null; state.candidateUpdateChains = new Map();
  context.flushAllWorkspaceMutations = async () => { throw new Error("workspace write failed"); };
  test.openProjectNameDialog("name"); await fire("#projectNameForm", "submit");
  assert.equal(calls.some(([kind, url]) => kind === "api" && url === "/api/project/name"), false, "a failed workspace flush prevents projectless promotion");
  assert.equal(state.project, null, "a failed workspace flush keeps the session projectless");
  assert.ok(calls.some(([kind, message]) => kind === "error" && message === "workspace write failed"), "a failed workspace flush is shown to the user");
  element("#sourceMismatchDialog").dataset.imageIds = JSON.stringify(["changed"]); element("#sourceMismatchClear").checked = true; await fire("#sourceMismatchForm", "submit"); await fire("#sourceMismatchCancel");
  await fire("#sameSourceOpen"); await fire("#sameSourceSeparate"); await fire("#sameSourceCancel");
  console.log("test_project_ui_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
