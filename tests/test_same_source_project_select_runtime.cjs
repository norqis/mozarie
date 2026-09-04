"use strict";

// A browser-picked folder can be shared by separate projects.  The warning
// must still let the user explicitly add that very handle to the active one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const japanese = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", "ja.json"), "utf8"));
const english = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", "en.json"), "utf8"));

class Element {
  constructor() { this.textContent = ""; this.hidden = false; this.disabled = false; this.open = false; this.dataset = {}; this.children = []; this.listeners = new Map(); this.isConnected = true; this.style = { setProperty() {} }; this.classList = { toggle() {} }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setAttribute() {}
  getBoundingClientRect() { return { width: 1200 }; }
}

const elements = new Map();
const $ = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
const chosenHandle = { kind: "directory", name: "shared" };
const calls = [];
const currentProject = { id: "current", name: "Current", status: "working" };
const otherProject = { id: "other", name: "Other", status: "working" };
const state = { project: currentProject, candidateUpdateChains: new Map(), workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), candidateBatchPending: new Set(), images: [], settings: { general: { language: "ja" } } };
const document = {
  activeElement: null,
  body: new Element(),
  documentElement: { style: { setProperty() {} } },
  querySelector: $, querySelectorAll: () => [],
  createElement: () => new Element(), addEventListener() {},
};
const context = {
  Array, Boolean, Error, Intl, JSON, Map, Math, Number, Object, Promise, Set, String, WeakMap, console,
  document, state, $,
  window: { addEventListener() {}, showDirectoryPicker: async () => chosenHandle },
  setTimeout, clearTimeout, requestAnimationFrame(callback) { callback(); return 1; },
  t: (key) => key,
  loadTranslations: async () => {},
  api: async (url) => {
    calls.push(["api", url]);
    if (url === "/api/projects?sort=updated_desc") return { projects: [currentProject, otherProject] };
    if (url === "/api/project/source-check") return { projects: [currentProject, otherProject] };
    if (url === "/api/project/mismatches") return { images: [] };
    throw new Error(`unexpected API: ${url}`);
  },
  matchingProjectDirectorySources: async (handle) => {
    assert.equal(handle, chosenHandle, "the selected native handle is checked");
    return [{ projectId: otherProject.id, sourceId: "other-source" }];
  },
  importProjectDirectoryHandle: async (handle, projectId, sourceId) => calls.push(["import", handle, projectId, sourceId]),
  showUserError(error) { throw error; },
  showModalFromInvoker(dialog) { dialog.showModal(); },
  focusElement() {},
  initCandidatePaddingPopover() {},
};
for (const name of [
  "openSettings", "selectSettingsTab", "moveSettingsTab", "saveSettings", "resetSettings", "chooseSettingsOutputDirectory", "chooseSettingsModelFile", "startModelDownload", "cancelModelDownload", "beginModelDownload", "syncProviderSelection", "markModelStatusDirty", "selectSamVariant", "startUpdate", "handleToolRailKeydown", "setToolRailTabStop", "setModelCardEnabled", "setHandSegmentationAvailable", "setPrecisionDetectionEnabled", "refreshSettingsStatus", "setFluidExclusionEnabled", "pickImageFiles", "pickImageDirectory", "importDroppedFiles", "loadFolder", "openDetectionDialog", "validateDetectionTargets", "runDetection", "saveAll", "saveCurrent", "setDisplayMode", "fitImage", "updateCompareSplitter", "render", "updateBrushCursor", "updateBrushSize", "setHidden", "clearMasks", "closeBatchMoreMenus", "clearCatalog", "renderGallery", "setViewMode", "runNavigationAction", "moveCurrentBy", "reviewAndMoveNext", "removeImageFromCatalog", "hideAndMoveNext", "runSelectionAction", "clearBatchSelection", "renderOverview", "updateSelectionActionBar", "batchCandidateOperation", "toggleCandidateDisplay", "toggleCandidateEffective", "renderShortcutBindings", "setTool", "setBoundaryModeMenuOpen", "addBoundaryCandidate", "cancelBoundary", "setMosaicPreviewEnabled", "requestMosaicPreview", "updateBlockSizeDisplay", "setDetectionConfidence", "syncDetectionTargetSwitch", "startDetectionFromDialog", "restoreSnapshot", "resizeRenderCanvas", "refreshApplyTargets", "chooseOutputDirectory", "syncApplyMode", "controlApply", "startApplyFromDialog", "chooseSingleOutputDirectory", "syncSingleSaveMode", "startSingleSave", "showProcessing", "updateProgress", "scheduleJobPoll", "cancelDetection", "setReviewed", "closeCatalogContextMenu", "copyContextMenuImagePath", "setGalleryDropOverlay", "beginBoundaryBrushStroke", "appendBoundaryBrushPoint", "beginManualStroke", "appendManualStrokePoint", "fillAt", "completeManualStroke", "cancelManualStroke", "completeBoundaryBrushStroke", "flushRender", "closeBoundaryModeMenu", "cancelFillWork", "handleWindowKeydown", "addBoundaryDraft", "setSettingsForm", "rememberedOutputDirectoryHandle", "renderOutputDirectory", "setNavigationShortcutsEnabled", "restoreCompareSplit", "updateHistoryButtons", "updateNavigationControls", "updateActionButtons", "resetCatalog", "applyProjectSnapshot", "setStatusKey", "checkForUpdate", "loadReviewedPaths", "queueWorkspaceDraft", "rememberProjectSource", "rememberedProjectFileSources", "rememberedProjectDirectorySources", "ensureProjectSourcePermission", "importProjectFileHandles", "waitForCandidateMutations", "flushAllWorkspaceMutations", "confirmAction", "forgetProjectSources", "responseError",
]) if (!(name in context)) context[name] = () => {};
context.canvas = new Element();
context.stage = new Element();
context.toolRail = new Element();
context.toolRailItems = () => [];

const appPath = path.join(__dirname, "..", "static", "js", "app.js");
vm.runInNewContext(fs.readFileSync(appPath, "utf8"), context, { filename: appPath });
vm.runInNewContext("globalThis.sameSourceTest = { bindEvents, openSameSourceDialog };", context);

const settle = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  await settle();
  assert.equal(japanese["project.sameSourceAddCurrent"], "このプロジェクトへ追加", "Japanese labels the current-project choice");
  assert.equal(english["project.sameSourceAddCurrent"], "Add to this project", "English labels the current-project choice");
  context.sameSourceTest.bindEvents();
  $("#projectSourceSelect").listeners.get("click")();
  await settle(); await settle();

  assert.equal($("#sameSourceDialog").open, true, "reusing a folder registered to another project requires confirmation");
  assert.equal($("#sameSourceSeparate").hidden, false, "the active-project choice is visible");
  assert.equal($("#sameSourceSeparate").textContent, "project.sameSourceAddCurrent", "the confirmation is labelled for the active project");
  $("#sameSourceSeparate").listeners.get("click")();
  await settle(); await settle();

  assert.deepEqual(calls.find(([kind]) => kind === "import"), ["import", chosenHandle, currentProject.id, null], "confirmation imports the originally selected handle into the current project");
  assert.equal(calls.some(([kind, url]) => kind === "api" && url === "/api/projects"), false, "confirmation does not create another project");

  await context.sameSourceTest.openSameSourceDialog("C:/shared");
  assert.equal($("#sameSourceSeparate").textContent, "project.sameSourceSeparate", "the path-based warning keeps its separate-project action");
  console.log("test_same_source_project_select_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
