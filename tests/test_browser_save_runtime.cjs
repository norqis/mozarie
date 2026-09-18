const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");

const staticRoot = path.join(__dirname, "..", "static");
const index = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const appPaths = [...index.matchAll(/<script src="\/js\/([a-z-]+\.js)"><\/script>/g)].map((match) => path.join(staticRoot, "js", match[1]));

function element() {
  const node = {
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, contains() { return false; } },
    setAttribute() {},
    append(child) { this.children.push(child); child.parentNode = this; },
    insertBefore(child, before) {
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      child.parentNode = this;
    },
    remove() { const siblings = this.parentNode?.children; const index = siblings?.indexOf(this); if (index >= 0) siblings.splice(index, 1); },
    addEventListener() {},
    focus() {},
    matches() { return false; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  return node;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function binaryResponse(bytes, saveToken = "runtime-render-token", beforePipe = null, outputPath = "", noEffect = false) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "X-Mozarie-Save-Token" ? saveToken : (name === "X-Mozarie-No-Effect" && noEffect ? "1" : (name === "X-Mozarie-Output-Path-B64" && outputPath ? Buffer.from(outputPath).toString("base64") : null)) },
    body: { pipeTo: async (writable) => { await beforePipe?.(); await writable.write(Uint8Array.from(bytes)); await writable.close(); } },
    json: async () => ({}),
  };
}

function sourceBlob(name, size, lastModified) {
  return new File([new Uint8Array(size)], name, { type: "image/png", lastModified });
}

function createRuntime({ commit, copy = null, deleteOriginal = false, renderBinary = null, renderToken = "runtime-render-token", entries = null, initialImages = null, removeCatalog = null, saveStatus = null, saveCancel = null, reserve = null, pickOutputDirectory = null }) {
  const preparedEntries = entries || [{ imageId: "image-1", relativePath: "nested/source.png", candidateRevision: 7, deleteOriginal }];
  let catalogImages = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  getElement("#applyDivisor").value = "100";
  getElement("#applySuffix");
  getElement("#deleteOriginal");
  getElement('input[name="batchSaveMode"]:checked').value = "copy";
  const canvas = getElement("#editorCanvas");
  canvas.getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {} });
  getElement("#canvasStage").clientWidth = 600;
  getElement("#canvasStage").clientHeight = 400;
  const galleryItem = () => {
    const item = element();
    const preview = element();
    const name = element();
    const meta = element();
    const badge = element();
    item.querySelector = (selector) => ({ img: preview, ".gallery-name": name, ".gallery-meta": meta, ".gallery-review-badge": badge }[selector]);
    item.remove = () => {};
    return item;
  };
  elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });

  const requests = [];
  let imageFetches = 0;
  const lockRequests = [];
  const document = {
    querySelector(selector) {
      if (selector === 'meta[name="mozarie-token"]') return { content: "runtime-test-token" };
      return getElement(selector);
    },
    querySelectorAll() { return []; },
    createElement(tag) {
      if (tag !== "canvas") return element();
      return {
        width: 1,
        height: 1,
        getContext: () => ({
          clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
      };
    },
  };
  const browserWindow = { devicePixelRatio: 1, addEventListener() {} };
  let outputLockTail = Promise.resolve();
  const browserNavigator = { locks: { request(name, options, callback) {
    lockRequests.push([name, options]);
    const result = outputLockTail.then(callback, callback);
    outputLockTail = result.catch(() => {});
    return result;
  } } };
  const context = {
    codedError(code) { const error = new Error(); error.code = code; return error; },
    console,
    document,
    Date,
    Math,
    Promise,
    Uint8Array,
    ArrayBuffer,
    Blob,
    File,
    TextDecoder,
    Intl,
    crypto: { randomUUID: () => `runtime-client-token-${requests.length}` },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); },
    localStorage: (() => {
      const values = new Map();
      return { get length() { return values.size; }, key(index) { return [...values.keys()][index] || null; }, getItem(key) { return values.get(key) || null; }, setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } };
    })(),
    Image: class {},
    IntersectionObserver: class { observe() {} unobserve() {} },
    URL: { createObjectURL() { return "blob:runtime-test"; }, revokeObjectURL() {} },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    window: browserWindow,
    navigator: browserNavigator,
    showModalFromInvoker(dialog) { dialog?.showModal?.(); },
    fetch: async (requestPath, options = {}) => {
      if (requestPath === "/api/images") {
        imageFetches += 1;
        return jsonResponse({ images: catalogImages });
      }
      requests.push({ path: requestPath, options });
      if (requestPath === "/api/save/prepare") {
        return jsonResponse({ entries: preparedEntries });
      }
      if (requestPath === "/api/save/reserve") return jsonResponse(await (reserve || (() => ({ state: "rendering" })))({ options, requests }));
      if (requestPath === "/api/apply") return jsonResponse({ kind: "apply", state: "running" });
      if (requestPath === "/api/save/render") {
        const payload = JSON.parse(options.body || "{}");
        if (payload.copyToDefault) {
          const response = await (copy || (() => binaryResponse([4, 5, 6], renderToken, null, "G:/output/source_censored.png")))({ options, requests });
          if (!response.ok) return response;
          return response;
        }
        return renderBinary ? await renderBinary({ options, requests }) : binaryResponse([4, 5, 6], renderToken);
      }
      if (requestPath === "/api/save/commit") {
        const response = await commit({ options, requests });
        const body = await response.json();
        if (Array.isArray(body.images)) catalogImages = body.images;
        return response;
      }
      if (requestPath === "/api/save/status") return (saveStatus || (() => jsonResponse({ state: "unknown" })))({ options, requests });
      if (requestPath === "/api/save/cancel") return (saveCancel || (() => jsonResponse({ state: "cancelled" })))({ options, requests });
      if (requestPath === "/api/save/ack") return jsonResponse({ acknowledged: true });
      if (requestPath === "/api/output-directory/pick") {
        const pick = pickOutputDirectory || (() => ({ cancelled: false, path: "G:/picked", settings: { saving: { default_output_directory: "G:/picked" } } }));
        return jsonResponse(await pick({ options, requests }));
      }
      if (requestPath === "/api/catalog/remove") return (removeCatalog || (() => jsonResponse({ images: [], removedImageIds: [] })))({ options, requests });
      throw new Error(`Unexpected request: ${requestPath}`);
    },
  };

  const runtimeContext = vm.createContext(context);
  for (const appPath of appPaths) {
    if (path.basename(appPath) === "app.js") continue;
    new vm.Script(fs.readFileSync(appPath, "utf8"), { filename: appPath }).runInContext(runtimeContext);
  }
  new vm.Script(
    "globalThis.__browserSaveRuntime = { state, beginSaveSourcePreparation, ensureSaveSources, finishApplyJob, runBrowserSave, saveTargets, processableImages, isBusy, catalogStagingEditsActive, selectedSaveMode, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, pickOutputDirectory, reserveSaveRender, renderDefaultCopy, renderStreamedSave, commitBrowserSaveWithRetry, acknowledgePendingBrowserSave, translate: t };",
    { filename: "test-browser-save-exports.js" },
  ).runInContext(runtimeContext);
  const { state, beginSaveSourcePreparation, ensureSaveSources, finishApplyJob, runBrowserSave, saveTargets, processableImages, isBusy, catalogStagingEditsActive, selectedSaveMode, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, pickOutputDirectory: pickOutputDirectoryApi, reserveSaveRender, renderDefaultCopy, renderStreamedSave, commitBrowserSaveWithRetry, acknowledgePendingBrowserSave, translate } = context.__browserSaveRuntime;
  state.images = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  state.settings = { saving: { parallelism: 1, default_output_directory: "G:/output", preserve_directory_structure: true }, confirmations: { overwriteSource: false, deleteSourceAfterCopy: false } };
  getElement("#applyPreserveDirectoryStructure").checked = true;
  getElement("#singleSavePreserveDirectoryStructure").checked = true;
  getElement("#applyOutputDirectoryStatus").value = state.settings.saving.default_output_directory;
  getElement("#singleSaveOutputDirectoryStatus").value = state.settings.saving.default_output_directory;
  state.translations = {
    "apply.complete": "complete {completed}",
    "apply.completeWithStale": "stale {completed}/{stale}",
    "apply.cancelled": "cancelled {completed}",
    "apply.progress": "progress {completed}/{total}",
    "gallery.detectAll": "detect all",
    "apply.outputDirectoryUnset": "Save location: not selected",
  };
  return { element: getElement, elements, beginSaveSourcePreparation, ensureSaveSources, finishApplyJob, imageFetches: () => imageFetches, lockRequests, navigator: browserNavigator, requests, runBrowserSave, saveTargets, processableImages, isBusy, catalogStagingEditsActive, selectedSaveMode, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, pickOutputDirectory: pickOutputDirectoryApi, reserveSaveRender, renderDefaultCopy, renderStreamedSave, commitBrowserSaveWithRetry, acknowledgePendingBrowserSave, state, translate, window: browserWindow };
}

async function runOutputDirectoryPermissionCases() {
  const runtime = createRuntime({ commit: () => jsonResponse({}), pickOutputDirectory: () => ({ cancelled: false, path: "G:/absolute-output", settings: { saving: { default_output_directory: "G:/absolute-output" } } }) });
  await runtime.chooseOutputDirectory();
  assert.equal(runtime.state.settings.saving.default_output_directory, "G:/absolute-output", "the server picker stores its selected absolute output path");
  const pick = runtime.requests.find((request) => request.path === "/api/output-directory/pick");
  assert.equal(pick.options.method, "POST", "the output picker is submitted to the server");
  assert.equal(JSON.parse(pick.options.body).currentPath, "G:/output", "the picker receives the existing absolute output path");

  const cancelled = createRuntime({ commit: () => jsonResponse({}), pickOutputDirectory: () => ({ cancelled: true }) });
  await cancelled.chooseOutputDirectory();
  assert.equal(cancelled.state.settings.saving.default_output_directory, "G:/output", "a cancelled picker preserves the prior output path");
  const failed = createRuntime({ commit: () => jsonResponse({}), pickOutputDirectory: () => { throw Object.assign(new Error("picker"), { code: "output_directory_pick_failed" }); } });
  await failed.chooseOutputDirectory();
  assert.equal(failed.requests.filter((request) => request.path === "/api/output-directory/pick").length, 1, "a picker error sends one request and remains retryable");
}

function configureSingleBrowserSourcePreflight(runtime, image, access, { mode = "copy", deleteOriginal = true, format = "original" } = {}) {
  runtime.state.images = [image];
  runtime.state.currentId = image.id;
  runtime.state.currentImage = image;
  runtime.state.singleSave = { imageId: image.id, generation: runtime.state.imageGeneration, divisor: 100, draft: null };
  runtime.state.sourceAccess.set(image.id, access);
  runtime.element('input[name="singleSaveMode"]:checked').value = mode;
  runtime.element("#singleSaveDeleteOriginal").checked = deleteOriginal;
  runtime.element("#singleSaveOutputFormat").value = format;
  runtime.element("#singleSaveOutputDirectoryStatus").value = runtime.state.settings.saving.default_output_directory;
}

async function runBrowserSourcePreflightFailureCases() {
  const makeImage = () => ({ id: "image-1", sourceKind: "session", relativePath: "nested/source.png", editedFilename: "edited-name.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false });
  const makeFileHandle = () => {
    const file = sourceBlob("source.png", 3, 34);
    return { name: file.name, async getFile() { return file; }, async queryPermission() { return "granted"; }, async isSameEntry(other) { return other === this; } };
  };

  const cancelled = createRuntime({ commit: () => jsonResponse({}) });
  const cancelledFile = makeFileHandle();
  cancelled.window.showDirectoryPicker = async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); };
  configureSingleBrowserSourcePreflight(cancelled, makeImage(), { fileHandle: cancelledFile, name: "source.png", size: 3, lastModified: 34, relativePath: "nested/source.png", sourceKind: "browser-files" });
  await cancelled.startSingleSave({ preventDefault() {} });
  assert.equal(cancelled.state.saveStarting, false, "a cancelled parent picker releases the single-save lock");
  assert.equal(cancelled.state.saving, false, "a cancelled parent picker leaves no save running");
  assert.equal(cancelled.element("#singleSaveDeleteOriginal").checked, true, "a cancelled parent picker preserves the delete-after-copy choice");
  assert.equal(cancelled.state.images[0].editedFilename, "edited-name.png", "a cancelled parent picker preserves the metadata-only rename");
  assert.equal(cancelled.requests.some((request) => request.path === "/api/save/render"), false, "a cancelled parent picker writes no output");
  assert.equal(cancelled.element("#singleSaveResult").textContent, "", "a cancelled parent picker does not surface an unexpected-problem message");

  const denied = createRuntime({ commit: () => jsonResponse({}) });
  const deniedFile = makeFileHandle();
  const deniedParent = {
    async queryPermission() { return "denied"; },
    async requestPermission() { return "denied"; },
    async getFileHandle() { return deniedFile; },
  };
  configureSingleBrowserSourcePreflight(denied, makeImage(), { fileHandle: deniedFile, parentHandle: deniedParent, name: "source.png", size: 3, lastModified: 34, relativePath: "nested/source.png", sourceKind: "browser-files" });
  await denied.startSingleSave({ preventDefault() {} });
  assert.equal(denied.requests.some((request) => request.path === "/api/save/render"), false, "a denied parent permission stops before output rendering");
  assert.equal(denied.state.saveStarting, false, "a denied parent permission restores controls for retry");

  const mismatch = createRuntime({ commit: () => jsonResponse({}) });
  const original = makeFileHandle();
  const foreign = { name: "source.png", async getFile() { return sourceBlob("source.png", 3, 34); }, async isSameEntry() { return false; } };
  mismatch.window.showDirectoryPicker = async () => ({ async getFileHandle() { return foreign; } });
  configureSingleBrowserSourcePreflight(mismatch, makeImage(), { fileHandle: original, name: "source.png", size: 3, lastModified: 34, relativePath: "nested/source.png", sourceKind: "browser-files" });
  await mismatch.startSingleSave({ preventDefault() {} });
  assert.equal(mismatch.requests.some((request) => request.path === "/api/save/render"), false, "a mismatched picked source stops before output rendering");
  assert.equal(mismatch.state.sourceAccess.get("image-1").parentHandle, undefined, "a mismatched picked source is not retained as a direct parent");

  const changed = createRuntime({ commit: () => jsonResponse({}) });
  const expected = makeFileHandle();
  const changedHandle = {
    name: "source.png",
    async getFile() { return sourceBlob("source.png", 4, 35); },
    async isSameEntry(other) { return other === expected; },
  };
  changed.window.showDirectoryPicker = async () => ({ async getFileHandle() { return changedHandle; } });
  configureSingleBrowserSourcePreflight(changed, makeImage(), { fileHandle: expected, name: "source.png", size: 3, lastModified: 34, relativePath: "nested/source.png", sourceKind: "browser-files" });
  await changed.startSingleSave({ preventDefault() {} });
  assert.equal(changed.requests.some((request) => request.path === "/api/save/render"), false, "a changed canonical source stops before output rendering after parent reconnection");
  assert.equal(changed.state.sourceAccess.get("image-1").parentHandle, undefined, "a changed canonical source does not replace its expected access record");
}

async function runParentlessBrowserSourcePreparationCase() {
  const image = { id: "image-1", sourceKind: "session", relativePath: "nested/source.png", editedFilename: "edited-output.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({}) });
  const file = sourceBlob("source.png", 3, 34);
  let childRequests = 0; let parentRequests = 0; let pickerCalls = 0;
  const fileHandle = {
    name: file.name,
    async getFile() { return file; },
    async queryPermission() { return "granted"; },
    async requestPermission() { childRequests += 1; return "granted"; },
  };
  const directParent = {
    async queryPermission() { return "granted"; },
    async requestPermission() { parentRequests += 1; return "granted"; },
    async getFileHandle(name) { assert.equal(name, "source.png", "parent reconnection looks up the canonical original basename, not the edited output name"); return fileHandle; },
  };
  const pickedRoot = {
    async resolve(handle) { assert.equal(handle, fileHandle); return ["nested", "source.png"]; },
    async getDirectoryHandle(name) { assert.equal(name, "nested"); return directParent; },
  };
  fileHandle.isSameEntry = async (other) => other === fileHandle;
  runtime.window.showDirectoryPicker = async () => { pickerCalls += 1; return pickedRoot; };
  const access = { fileHandle, name: file.name, size: file.size, lastModified: file.lastModified, relativePath: image.relativePath, sourceKind: "browser-files" };
  runtime.state.sourceAccess.set(image.id, access);
  const preparation = runtime.beginSaveSourcePreparation([image.id], "copy", true, "original");
  await runtime.ensureSaveSources([image.id], "copy", true, "original", preparation);
  assert.equal(pickerCalls, 1, "one explicit save operation opens one shared source-parent picker");
  assert.equal(access.parentHandle, directParent, "a picked root resolves and retains the direct canonical parent");
  assert.equal(access.fileHandle, fileHandle, "the resolved canonical child becomes the live source handle");
  assert.deepEqual({ size: access.size, lastModified: access.lastModified }, { size: 3, lastModified: 34 }, "parent reconnection preserves the expected source fingerprint");
  assert.equal(childRequests, 0, "a writable parent grant avoids an extra child permission prompt");
  assert.equal(parentRequests, 0, "the picker-provided writable parent is verified without another prompt");
}

async function runSingleCopyKeepsEditorStateCase() {
  const image = { id: "image-1", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false };
  const images = [image];
  const runtime = createRuntime({ initialImages: images, commit: () => jsonResponse({ cleared: true, stale: false }) });
  const candidates = [{ id: "candidate-1", role: "apply", enabled: true }];
  const draft = { add: "manual-mask", exclusion: "manual-exclusion", exclusionErase: "manual-restore" };
  runtime.state.currentId = image.id; runtime.state.currentImage = image;
  runtime.state.singleSave = { imageId: image.id, generation: runtime.state.imageGeneration, divisor: 100, draft };
  runtime.state.candidates = candidates; runtime.state.drafts.set(image.id, draft); runtime.state.maskStatus.set(image.id, true);
  runtime.state.manualMaskPresent = true; runtime.state.manualEnabled = false; runtime.state.manualExclusionEnabled = true; runtime.state.manualExclusionEraseEnabled = false; runtime.state.manualExclusionForced = true;
  runtime.element('input[name="singleSaveMode"]:checked').value = "copy";
  runtime.element("#singleSaveDeleteOriginal").checked = false;
  runtime.element("#singleSaveSuffix").value = "_copy";
  runtime.element("#singleSaveOutputDirectoryStatus").value = runtime.state.settings.saving.default_output_directory;

  await runtime.startSingleSave({ preventDefault() {} });

  assert.equal(runtime.imageFetches(), 0, "copy-and-keep does not reload an unchanged catalogue");
  assert.equal(runtime.state.images, images, "copy-and-keep preserves the catalogue object");
  assert.equal(runtime.state.currentId, image.id, "copy-and-keep preserves the current image");
  assert.equal(runtime.state.currentImage, image, "copy-and-keep preserves the current image object");
  assert.equal(runtime.state.candidates, candidates, "copy-and-keep preserves candidate state");
  assert.equal(runtime.state.drafts.get(image.id), draft, "copy-and-keep preserves all manual draft layers");
  assert.equal(runtime.state.maskStatus.get(image.id), true, "copy-and-keep preserves mask status");
  assert.deepEqual([runtime.state.manualMaskPresent, runtime.state.manualEnabled, runtime.state.manualExclusionEnabled, runtime.state.manualExclusionEraseEnabled, runtime.state.manualExclusionForced], [true, false, true, false, true], "copy-and-keep preserves manual layer switches");
  assert.deepEqual([image.reviewed, image.hidden], [false, false], "copy-and-keep preserves reviewed and hidden flags");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 1, "copy-and-keep reaches the browser commit contract");
}

async function runPauseResetAfterTerminalBrowserSaveCase() {
  const complete = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false }) });
  complete.element("#applyPauseButton").disabled = true;
  await complete.runBrowserSave(["image-1"], "_censored", false, "copy");
  assert.equal(complete.element("#applyPauseButton").disabled, false, "a completed browser save leaves Pause enabled for the next save");

  const failed = createRuntime({ copy: () => jsonResponse({ error_code: "save_render_failed" }, 500), commit: () => jsonResponse({}) });
  failed.element("#applyPauseButton").disabled = true;
  await assert.rejects(failed.runBrowserSave(["image-1"], "_censored", false, "copy"));
  assert.equal(failed.element("#applyPauseButton").disabled, false, "a failed browser save clears a stale pausing disable state");

  let cancelled;
  cancelled = createRuntime({
    copy: () => { cancelled.state.browserSave.cancelled = true; return binaryResponse([4, 5, 6], "cancel-pause-token", null, "G:/output/source_censored.png"); },
    commit: () => jsonResponse({ cleared: true, stale: false }),
  });
  cancelled.element("#applyPauseButton").disabled = true;
  await cancelled.runBrowserSave(["image-1"], "_censored", false, "copy");
  assert.equal(cancelled.element("#applyPauseButton").disabled, false, "a cancelled browser save leaves Pause enabled for the next save");
}

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

async function runOutputPermissionSubmissionLockCases() {
  const event = { preventDefault() {} };
  let reserveCalls = 0;
  const runtime = createRuntime({
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    reserve: () => { reserveCalls += 1; return { state: "rendering" }; },
  });
  runtime.state.applyTargetIds = ["image-1"];
  runtime.element('input[name="batchSaveMode"]:checked').value = "copy";
  runtime.element("#applySuffix").value = "_locked";
  runtime.element("#applyOutputDirectoryStatus").value = runtime.state.settings.saving.default_output_directory;
  const firstBatch = runtime.startApplyFromDialog(event);
  const secondBatch = runtime.startApplyFromDialog(event);
  assert.equal(runtime.state.saveStarting, true, "batch locks synchronously before save preflight awaits");
  await Promise.all([firstBatch, secondBatch]);
  assert.equal(reserveCalls, 1, "a second batch submit does not duplicate server reservation");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 1, "one batch submission reaches one commit");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/ack").length, 1, "a committed batch receipt is acknowledged exactly once");
  assert.equal(runtime.state.saveStarting, false, "a completed batch releases the preflight lock");

  const retry = createRuntime({ commit: () => jsonResponse({}), reserve: (() => { let calls = 0; return () => { calls += 1; if (calls === 1) throw Object.assign(new Error("reserve failed"), { status: 500 }); return { state: "rendering" }; }; })() });
  retry.state.applyTargetIds = ["image-1"];
  retry.element("#applyOutputDirectoryStatus").value = retry.state.settings.saving.default_output_directory;
  await retry.startApplyFromDialog(event);
  assert.equal(retry.state.saveStarting, false, "a rejected reservation releases the batch lock");
  await retry.startApplyFromDialog(event);
  assert.equal(retry.requests.filter((request) => request.path === "/api/save/commit").length, 1, "a failed reservation can be retried successfully");

  const lockedImage = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false };
  let singleReserveCalls = 0;
  const single = createRuntime({ initialImages: [lockedImage], commit: () => jsonResponse({ cleared: true, stale: false, images: [lockedImage] }), reserve: () => { singleReserveCalls += 1; return { state: "rendering" }; } });
  single.state.currentId = "image-1"; single.state.currentImage = lockedImage;
  single.state.singleSave = { imageId: "image-1", generation: single.state.imageGeneration, divisor: 100, draft: null };
  single.element('input[name="singleSaveMode"]:checked').value = "copy";
  single.element("#singleSaveSuffix").value = "_locked";
  single.element("#singleSaveOutputDirectoryStatus").value = single.state.settings.saving.default_output_directory;
  const firstSingle = single.startSingleSave(event);
  const secondSingle = single.startSingleSave(event);
  assert.equal(single.state.saveStarting, true, "single save locks synchronously before server reservation awaits");
  await Promise.all([firstSingle, secondSingle]);
  assert.equal(singleReserveCalls, 1, "a second single-save submit does not duplicate server reservation");
  assert.equal(single.requests.filter((request) => request.path === "/api/save/commit").length, 1, "one single submission reaches one commit");
  assert.equal(single.state.saveStarting, false, "a completed single save releases the preflight lock");
  assert.equal(single.state.images[0].reviewed, false, "single save does not mark an unreviewed image as reviewed");
}

async function runExclusiveWritableCases() {
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  const response = binaryResponse([4, 5, 6]);
  const calls = [];
  const access = { fileHandle: {
    async createWritable(options) { calls.push(options); if (calls.length === 1) { const error = new TypeError("unsupported"); throw error; } return { async write() {}, async close() {}, async abort() {} }; },
    async getFile() { return { name: "source.png", size: 3, lastModified: 2 }; },
  }};
  await assert.rejects(runtime.writeSourceHandle(access, response), (error) => error.code === "source_write_unsupported", "an unsupported exclusive write stops with a stable error");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ keepExistingData: false, mode: "exclusive" }], "an unsupported exclusive write never falls back to a non-exclusive stream");

  const restoreCalls = [];
  const restoreAccess = { fileHandle: {
    async createWritable(options) { restoreCalls.push(options); throw new TypeError("unsupported"); },
  }};
  await assert.rejects(runtime.restoreSourceHandle(restoreAccess, new Uint8Array([1]), false), (error) => error.code === "source_write_unsupported", "restore also stops when exclusive source writes are unsupported");
  assert.deepEqual(JSON.parse(JSON.stringify(restoreCalls)), [{ keepExistingData: false, mode: "exclusive" }], "restore never retries without exclusive mode");

  const locked = { fileHandle: {
    async createWritable() { const error = new DOMException("locked", "InvalidStateError"); throw error; },
    async getFile() { return { name: "source.png", size: 1, lastModified: 1 }; },
  }};
  await assert.rejects(runtime.writeSourceHandle(locked, response), (error) => error.code === "source_busy", "an exclusive-writer conflict remains visible to the user");

  for (const name of ["NotAllowedError", "QuotaExceededError"]) {
    const denied = { fileHandle: {
      async createWritable() { throw new DOMException(name, name); },
      async getFile() { return { name: "source.png", size: 1, lastModified: 1 }; },
    }};
    await assert.rejects(runtime.writeSourceHandle(denied, response), (error) => error.name === name && error.code !== "source_busy", `${name} is not mislabeled as a writer conflict`);
  }
}

async function runPartialOutputCleanupCases() {
  const runtime = createRuntime({ copy: () => jsonResponse({ error_code: "save_render_failed" }, 500), commit: () => jsonResponse({}) });
  await assert.rejects(runtime.runBrowserSave(["image-1"], "_censored", false), "a server render failure is reported without committing an output receipt");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 0, "a failed render never reaches commit");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/cancel").length, 1, "a failed render cancels its reserved server output");
}

async function runConcurrentOutputLockCases() {
  const entries = ["one", "two"].map((imageId) => ({ imageId, relativePath: "same.png", candidateRevision: 1 }));
  const runtime = createRuntime({ entries, initialImages: entries.map((entry) => ({ ...entry, width: 1, height: 1 })), reserve: ({ options }) => ({ state: "rendering", requested: JSON.parse(options.body).clientSaveToken }), copy: ({ options }) => binaryResponse([1], JSON.parse(options.body).clientSaveToken, null, `G:/output/${JSON.parse(options.body).imageId}_censored.png`), commit: () => jsonResponse({}) });
  runtime.state.settings.saving.parallelism = 2;
  await runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false);
  const reservations = runtime.requests.filter((request) => request.path === "/api/save/reserve");
  assert.equal(reservations.length, 2, "concurrent copies receive independent server reservations");
  assert.equal(new Set(reservations.map((request) => JSON.parse(request.options.body).clientSaveToken)).size, 2, "each reservation has its own idempotency token");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/ack").length, 2, "each committed reservation is acknowledged exactly once");
}

async function runBrowserCopyPoolAndWriteOverlapCases() {
  const entries = ["one", "two", "three"].map((id) => ({ imageId: id, relativePath: `${id}.png`, candidateRevision: 7 }));
  const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const releaseRenders = deferred(); const twoRendersStarted = deferred();
  let activeRenders = 0; let maxActiveRenders = 0; let renderStarts = 0;
  const runtime = createRuntime({
    entries, initialImages: images,
    copy: async () => {
      activeRenders += 1; maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      if (++renderStarts === 2) twoRendersStarted.resolve();
      await releaseRenders.promise;
      activeRenders -= 1;
      return binaryResponse([1, 2, 3]);
    },
    commit: () => jsonResponse({ cleared: true, stale: false }),
  });
  runtime.state.settings.saving.parallelism = 2;
  const batch = runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
  await twoRendersStarted.promise;
  assert.equal(maxActiveRenders, 2, "browser copies use the configured bounded save pool");
  releaseRenders.resolve();
  await batch;
}

async function runBrowserCopyPoolAtScaleCases() {
  for (const parallelism of [1, 2, 4, 8]) {
    const entries = Array.from({ length: 400 }, (_, index) => ({
      imageId: `image-${index}`, relativePath: "nested/same.png", candidateRevision: 7,
    }));
    const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
    let activeRenders = 0; let maxActiveRenders = 0;
    const releaseRenders = deferred();
    const runtime = createRuntime({
      entries, initialImages: images,
      copy: async ({ options }) => {
        const index = Number(JSON.parse(options.body).imageId.slice("image-".length));
        activeRenders += 1; maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
        if (activeRenders === parallelism) releaseRenders.resolve();
        await releaseRenders.promise;
        activeRenders -= 1;
        return binaryResponse([index >> 8, index & 0xff], `token-${index}`, null, `G:/output/${index}.png`);
      },
      commit: () => jsonResponse({ cleared: false, stale: false, images }),
    });
    runtime.state.settings.saving.parallelism = parallelism;
    assert.equal(runtime.saveTargets().length, 400, "all 400 catalogue entries remain batch-save targets before copying");
    await runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
    assert.equal(maxActiveRenders, parallelism, `400 browser copies use exactly the configured ${parallelism}-entry render pool`);
    assert.equal(runtime.imageFetches(), 0, "a keep-source browser batch skips its final catalogue reload");
    assert.equal(runtime.saveTargets().length, 400, "repeated copy saving keeps all 400 original entries as targets");
    assert.equal(JSON.parse(runtime.requests[0].options.body).imageIds.length, 400, "the prepare request retains all 400 target IDs");
    await runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
    assert.equal(runtime.requests.filter((request) => request.path === "/api/save/reserve").length, 800, "a repeated 400-copy save reserves every output independently");
    assert.equal(runtime.saveTargets().length, 400, "a repeated 400-copy save keeps the source target set invariant");
  }
}

async function runBrowserCopyRenderFailureCancelsReservationCase() {
  const entries = Array.from({ length: 400 }, (_, index) => ({ imageId: `failure-${index}`, relativePath: "nested/same.png", candidateRevision: 1 }));
  const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const runtime = createRuntime({
    entries, initialImages: images,
    copy: async ({ options }) => {
      const index = Number(JSON.parse(options.body).imageId.slice("failure-".length));
      if (index === 399) return jsonResponse({ error_code: "save_render_failed" }, 500);
      return binaryResponse([index >> 8, index & 0xff], `render-token-${index}`, null, `G:/output/${index}.png`);
    },
    commit: () => jsonResponse({ cleared: false, stale: false }),
  });
  runtime.state.settings.saving.parallelism = 8;
  await assert.rejects(runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy"), (error) => error?.code === "save_render_failed");
  const cancellations = runtime.requests.filter((request) => request.path === "/api/save/cancel");
  assert.equal(cancellations.length, 1, "a browser copy render failure releases its reservation");
  assert.match(JSON.parse(cancellations[0].options.body).saveToken, /^runtime-client-token-/, "the cancelled token belongs to the failed render reservation");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 399, "only successful browser copies are committed");
}

async function runBrowserHandleSnapshotSerializationCase() {
  const entries = ["one", "two"].map((id) => ({ imageId: id, relativePath: `${id}.png`, candidateRevision: 7 }));
  const images = entries.map((entry) => ({ id: entry.imageId, sourceKind: "session", relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const releaseSnapshot = deferred(); const firstSnapshot = deferred();
  let activeSnapshots = 0; let maxActiveSnapshots = 0;
  const sourceHandle = (name) => ({
    async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    async getFile() {
      const file = new File([Uint8Array.from([1, 2, 3])], name, { type: "image/png", lastModified: 1 });
      file.arrayBuffer = async () => {
        activeSnapshots += 1; maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
        if (activeSnapshots === 1) firstSnapshot.resolve();
        await releaseSnapshot.promise;
        activeSnapshots -= 1;
        return Uint8Array.from([1, 2, 3]).buffer;
      };
      return file;
    },
    async createWritable() { return { async write() {}, async close() {}, async abort() {} }; },
  });
  const runtime = createRuntime({ entries, initialImages: images, commit: () => jsonResponse({ cleared: true, stale: false }) });
  runtime.state.settings.saving.parallelism = 2;
  runtime.state.sourceAccess = new Map(entries.map((entry) => [entry.imageId, { fileHandle: sourceHandle(entry.relativePath), name: entry.relativePath, size: 3, lastModified: 1 }]));
  const batch = runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "overwrite");
  await firstSnapshot.promise;
  await Promise.resolve();
  assert.equal(maxActiveSnapshots, 1, "File System Access overwrites retain only one source snapshot at a time");
  releaseSnapshot.resolve();
  await batch;
}

async function runBrowserHandleOverwritePoolAtScaleCase() {
  const entries = Array.from({ length: 100 }, (_, index) => ({ imageId: `overwrite-${index}`, relativePath: `overwrite-${index}.png`, candidateRevision: 1 }));
  const images = entries.map((entry) => ({ id: entry.imageId, sourceKind: "session", relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  let activeSnapshots = 0; let maxActiveSnapshots = 0; let snapshotStarts = 0; let writableOpens = 0; let commits = 0;
  const files = new Map(entries.map((entry, index) => [entry.imageId, [index]]));
  const originals = new Map([...files].map(([imageId, bytes]) => [imageId, [...bytes]]));
  let rejectedImageId = null;
  const sourceHandle = (imageId, name) => ({
    async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    async getFile() {
      const file = new File([Uint8Array.from(files.get(imageId))], name, { type: "image/png", lastModified: 1 });
      file.arrayBuffer = async () => {
        activeSnapshots += 1; maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots); snapshotStarts += 1;
        await Promise.resolve(); activeSnapshots -= 1;
        return Uint8Array.from(files.get(imageId)).buffer;
      };
      return file;
    },
    async createWritable() {
      writableOpens += 1;
      return { async write(bytes) { files.set(imageId, [...(bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes)]); }, async close() {}, async abort() {} };
    },
  });
  const runtime = createRuntime({
    entries, initialImages: images,
    commit: ({ options }) => {
      commits += 1;
      if (commits === 100) {
        rejectedImageId = JSON.parse(options.body).imageId;
        return jsonResponse({ error_code: "save_state_changed" }, 409);
      }
      return jsonResponse({ cleared: false, stale: false, images });
    },
  });
  runtime.state.settings.saving.parallelism = 8;
  runtime.state.sourceAccess = new Map(entries.map((entry) => [entry.imageId, {
    fileHandle: sourceHandle(entry.imageId, entry.relativePath), name: entry.relativePath, size: 1, lastModified: 1,
  }]));
  await assert.rejects(runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "overwrite"), (error) => error?.code === "save_state_changed");
  assert.equal(snapshotStarts, 100, "100 overwrite sources are snapshotted before their serialized writes");
  assert.equal(commits, 100, "every 100-entry overwrite reaches one commit attempt");
  assert.equal(maxActiveSnapshots, 1, "100 FSA overwrites retain one source snapshot at a time");
  assert.equal(writableOpens, 101, "the rejected final overwrite opens one additional writer to restore its source bytes");
  assert.ok(rejectedImageId, "the rejected source is taken from the actual final commit payload");
  for (const entry of entries) {
    if (entry.imageId === rejectedImageId) assert.deepEqual(files.get(entry.imageId), originals.get(entry.imageId), "the rejected overwrite rolls back to its original source bytes");
    else assert.deepEqual(files.get(entry.imageId), [4, 5, 6], "each committed overwrite keeps the rendered source bytes");
  }
  assert.equal(activeSnapshots, 0, "the overwrite snapshot pool drains after the rollback");
}

async function runSingleSaveKeepsReviewAndDraftCase() {
  const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({ cleared: true, stale: false, images: [image] }) });
  runtime.element('input[name="singleSaveMode"]:checked').value = "copy";
  runtime.state.currentId = image.id;
  runtime.state.singleSave = { imageId: image.id, generation: runtime.state.imageGeneration, divisor: 100, draft: { add: "manual" } };
  runtime.state.drafts.set(image.id, { add: "manual", hasEffectiveMask: true });
  runtime.state.currentImage = { sentinel: "current-image" };
  runtime.state.candidates = [{ candidateId: "candidate" }];
  runtime.state.candidateImages = new Map([["candidate", { sentinel: "candidate-image" }]]);
  runtime.state.maskStatus = new Map([[image.id, true]]);
  runtime.state.reviewedPaths = new Set([image.relativePath]); runtime.state.hiddenPaths = new Set(["hidden.png"]);
  runtime.state.selectedImageIds = new Set([image.id]); runtime.state.selectionAnchorId = image.id;
  runtime.state.galleryFilter = "masked"; runtime.state.sourceAccess = new Map([[image.id, { sentinel: "source" }]]);
  const before = {
    images: runtime.state.images, currentImage: runtime.state.currentImage, candidates: runtime.state.candidates,
    candidateImages: runtime.state.candidateImages, drafts: runtime.state.drafts, draft: runtime.state.drafts.get(image.id),
    maskStatus: runtime.state.maskStatus, reviewedPaths: runtime.state.reviewedPaths, hiddenPaths: runtime.state.hiddenPaths,
    selectedImageIds: runtime.state.selectedImageIds, sourceAccess: runtime.state.sourceAccess, currentId: runtime.state.currentId,
    galleryFilter: runtime.state.galleryFilter, selectionAnchorId: runtime.state.selectionAnchorId, imageGeneration: runtime.state.imageGeneration,
  };
  await runtime.startSingleSave({ preventDefault() {} });
  assert.equal(runtime.state.images[0].reviewed, false, "single save does not mark an unreviewed image as reviewed");
  assert.equal(runtime.state.drafts.get(image.id).add, "manual", "single save keeps the editor draft in memory");
  assert.equal(runtime.imageFetches(), 0, "a keep-source browser copy does not reload the catalogue");
  for (const [key, value] of Object.entries(before)) {
    if (key !== "draft") assert.equal(runtime.state[key], value, `a keep-source browser copy preserves ${key} by reference/value`);
  }
  assert.equal(runtime.state.drafts.get(image.id), before.draft, "a keep-source browser copy preserves the current draft object");

  const reviewed = { ...image, reviewed: true };
  const reviewedRuntime = createRuntime({ initialImages: [reviewed], commit: () => jsonResponse({ cleared: true, stale: false, images: [reviewed] }) });
  reviewedRuntime.element('input[name="singleSaveMode"]:checked').value = "copy";
  reviewedRuntime.state.currentId = reviewed.id;
  reviewedRuntime.state.currentImage = reviewed;
  reviewedRuntime.state.singleSave = { imageId: reviewed.id, generation: reviewedRuntime.state.imageGeneration, divisor: 100, draft: { add: "manual" } };
  await reviewedRuntime.startSingleSave({ preventDefault() {} });
  assert.equal(reviewedRuntime.state.images[0].reviewed, true, "single save keeps an already reviewed image reviewed");
}

function runOutputDirectoryDisplayCase() {
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  runtime.state.settings.saving.default_output_directory = "G:/configured-output";
  runtime.renderOutputDirectory();
  assert.equal(runtime.element("#applyOutputDirectoryStatus").value, "G:/configured-output", "the configured absolute path is shown for batch copies");
  assert.equal(runtime.element("#singleSaveOutputDirectoryStatus").value, "G:/configured-output", "single save shows the same server-side output path");
}

async function runSuccessCase() {
  const runtime = createRuntime({
    copy: () => binaryResponse([4, 5, 6], "runtime-render-token", null, "G:/output/source_censored.png"),
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  // Project state must not put an additional workspace flush, source-handle
  // lookup, or catalog re-render inside the per-image batch-save loop.
  runtime.state.project = { id: "project-save-runtime", status: "working" };
  await runtime.runBrowserSave(["image-1"], "_censored", false);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"]);
  const commitPayload = JSON.parse(runtime.requests.find((request) => request.path === "/api/save/commit").options.body);
  assert.equal(commitPayload.saveToken, "runtime-render-token");
  assert.equal(commitPayload.sourceAction, "keep");
  assert.equal(runtime.imageFetches(), 0, "a keep-source batch does not reload an unchanged catalogue");
  assert.equal(runtime.requests.some((request) => request.path.startsWith("/api/project/")), false, "a project batch save does not issue per-image project requests");
  assert.equal(runtime.elements.get("#applyResult").textContent, "complete 1");
}

async function runDraftBarrierBeforeDefaultApplyCase() {
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.elements.get("#applySuffix").value = "_censored";
  runtime.state.applyTargetIds = ["image-1"];
  let releaseDraft;
  runtime.state.draftSaveChains.set("image-1", new Promise((resolve) => { releaseDraft = resolve; }));
  const start = runtime.startApplyFromDialog({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(runtime.requests.some((request) => request.path === "/api/save/render"), false, "the browser save waits for the draft encoder");
  releaseDraft();
  await start;
  const render = runtime.requests.find((request) => request.path === "/api/save/render");
  assert.ok(render, "the browser save starts after the draft encoder settles");
}

async function runStaleCommitCase() {
    const runtime = createRuntime({ commit: () => jsonResponse({ cleared: false, stale: true, images: [] }) });
  await runtime.runBrowserSave(["image-1"], "_censored", false);

  assert.equal(runtime.elements.get("#applyResult").textContent, "stale 1/1");
}

async function runRemoveAfterSaveCase() {
    const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), {
        imageIds: [image.id], expectedProjectId: null, expectedCatalogGeneration: null,
      });
      return jsonResponse({ images: [], removedImageIds: [image.id] });
    },
  });
  await runtime.runBrowserSave([image.id], "_censored", false, "copy", true);
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, []);
}

async function runRemoveAfterSaveAlreadyAbsentCase() {
  const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: true, images: [] }),
    removeCatalog: () => jsonResponse({ images: [], removedImageIds: [] }),
  });
  runtime.state.currentId = image.id;
  runtime.state.drafts.set(image.id, { add: "draft", exclusion: "" });

  await runtime.runBrowserSave([image.id], "_censored", true, "copy", true);

  assert.equal(runtime.state.drafts.has(image.id), false, "already-removed source entries still clear browser drafts");
  assert.equal(runtime.state.currentId, null, "already-removed current entries leave no stale selection");
}

async function runRemoveAfterSavePartialAndStaleCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let commits = 0;
  const runtime = createRuntime({
    initialImages: [first, second],
    entries: [
      { imageId: first.id, relativePath: first.relativePath, candidateRevision: 1, deleteOriginal: false },
      { imageId: second.id, relativePath: second.relativePath, candidateRevision: 1, deleteOriginal: false },
    ],
    commit: () => {
      commits += 1;
      return commits === 1
        ? jsonResponse({ cleared: true, stale: false, images: [second] })
        : jsonResponse({ error: "second commit failed" }, 500);
    },
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), {
        imageIds: [first.id], expectedProjectId: null, expectedCatalogGeneration: null,
      });
      return jsonResponse({ images: [second], removedImageIds: [first.id] });
    },
  });
  await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", false, "copy", true), (error) => error.code === "internal_error");
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, [second]);

  const stale = createRuntime({
    initialImages: [first],
    commit: () => jsonResponse({ cleared: false, stale: true, images: [first] }),
  });
  await stale.runBrowserSave([first.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves must remain in the catalog");
}

async function runRemoveAfterSaveUiCleanupCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    initialImages: [first, second],
    entries: [{ imageId: first.id, relativePath: first.relativePath, candidateRevision: 1, deleteOriginal: false }],
    commit: () => jsonResponse({ cleared: true, stale: false, images: [first, second] }),
    removeCatalog: () => jsonResponse({ images: [second], removedImageIds: [first.id] }),
  });
  runtime.state.selectedImageIds = new Set([first.id]);
  runtime.state.selectionAnchorId = first.id;
  runtime.state.contextMenuImageId = first.id;
  runtime.state.contextMenuOrigin = runtime.element("#removeImageMenuItem");
  runtime.state.contextMenuScroll = { gallery: 999, overview: 999 };
  runtime.state.pendingImageId = first.id;
  runtime.state.pendingImageKey = "image-1:old";
  runtime.state.pendingCandidateKey = "image-1:old";
  const generationForDelayedLoad = runtime.state.imageGeneration;
  const pendingLoad = { aborted: false, abort() { this.aborted = true; } };
  runtime.state.catalogLoadControllers.add(pendingLoad);
  runtime.state.imageInflight.set(first.id, Promise.resolve());
  runtime.state.sourceAccess.set(first.id, {});
  runtime.state.drafts.set(first.id, { add: "draft" });
  runtime.state.maskStatus.set(first.id, true);
  runtime.state.candidateUpdateVersions.set("image-1:candidate", 1);
  runtime.state.prefetchQueue = [{ record: first }, { record: second }];
  runtime.element("#gallery").scrollTop = 43;
  runtime.element("#overviewGrid").scrollTop = 17;

  await runtime.runBrowserSave([first.id], "_censored", false, "copy", true);

  assert.deepEqual(runtime.state.images, [second], "the committed masked entry is removed in one terminal cleanup");
  assert.equal(runtime.state.selectedImageIds.has(first.id), false, "removed IDs leave batch selection");
  assert.equal(runtime.state.selectionAnchorId, null, "removed IDs clear the range-selection anchor");
  assert.equal(runtime.state.contextMenuImageId, null, "removed IDs close the contextual action target");
  assert.equal(runtime.state.contextMenuOrigin, null, "removed IDs discard the contextual action origin");
  assert.equal(runtime.state.contextMenuScroll, null, "removed IDs discard stale context scroll state");
  assert.equal(runtime.state.pendingImageId, null, "removed IDs clear pending image loads");
  assert.equal(runtime.state.imageGeneration, generationForDelayedLoad + 1, "removing a pending image invalidates its in-flight generation");
  assert.equal(pendingLoad.aborted, true, "removing a pending image aborts the outstanding catalog load");
  assert.equal(runtime.state.catalogLoadControllers.size, 0, "aborted pending loads are released");
  assert.equal(runtime.state.imageInflight.size, 0, "aborted pending image promises cannot publish a removed image");
  assert.notEqual(generationForDelayedLoad, runtime.state.imageGeneration, "a delayed image load keeps an obsolete generation after removal");
  assert.equal(runtime.state.pendingImageKey, null, "removed IDs clear pending image cache keys");
  assert.equal(runtime.state.pendingCandidateKey, null, "removed IDs clear pending candidate cache keys");
  assert.equal(runtime.state.sourceAccess.has(first.id), false, "removed IDs release source access");
  assert.equal(runtime.state.drafts.has(first.id), false, "removed IDs release drafts");
  assert.equal(runtime.state.maskStatus.has(first.id), false, "removed IDs release mask status");
  assert.equal(runtime.state.candidateUpdateVersions.has("image-1:candidate"), false, "removed IDs release candidate mutation state");
  assert.equal(runtime.state.prefetchQueue.length, 0, "removing a pending image cancels every stale prefetch request");
  assert.equal(runtime.element("#gallery").scrollTop, 43, "gallery scroll restores without forcing an invalid center jump");
  assert.equal(runtime.element("#overviewGrid").scrollTop, 17, "overview scroll restores without forcing an invalid center jump");
}

async function runCopyFailureCase() {
  let removed = false;
  const runtime = createRuntime({ deleteOriginal: true, copy: () => jsonResponse({ error: "disk full" }, 500), commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", {
    fileHandle: {
      name: "source.png",
      async getFile() { return { name: "source.png", size: 1, lastModified: 1 }; },
      async remove() { removed = true; },
    },
    name: "source.png",
    size: 1,
    lastModified: 1,
  });
  await assert.rejects(runtime.runBrowserSave(["image-1"], "_censored", true), (error) => error.code === "internal_error");
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/status", "/api/save/cancel"]);
  assert.equal(removed, false, "a failed durable copy does not delete the source handle");
}

async function runCommitFailureCase() {
  const runtime = createRuntime({ commit: () => jsonResponse({ error: "commit failed" }, 400) });
  await assert.rejects(runtime.runBrowserSave(["image-1"], "_censored", false), (error) => error.code === "internal_error");
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 1, "400 is not retried");
  assert.equal(runtime.imageFetches(), 0, "a failed keep-source batch does not reload an unchanged catalogue");
}

function attachDeletableSource(runtime) {
  const result = { deleted: false, restored: false };
  let file = sourceBlob("source.png", 3, 1);
  const fileHandle = {
    name: file.name,
    async getFile() { return file; },
    async createWritable() {
      return {
        async write(bytes) { result.restored = true; file = sourceBlob(file.name, bytes.byteLength, 2); },
        async close() {}, async abort() {},
      };
    },
  };
  runtime.state.sourceAccess.set("image-1", {
    fileHandle,
    parentHandle: {
      async removeEntry() { result.deleted = true; },
      async getFileHandle() { return fileHandle; },
    },
    name: file.name, size: file.size, lastModified: file.lastModified,
  });
  return result;
}

async function runRecoverableCommitFailureCases() {
  let commits = 0; let cancels = 0;
  const pending = createRuntime({
    deleteOriginal: true,
    commit: () => { commits += 1; return jsonResponse({ error_code: "workspace_database_error" }, 500); },
    saveStatus: () => jsonResponse({ state: "pending" }),
    saveCancel: () => { cancels += 1; return jsonResponse({ state: "cancelled" }); },
  });
  const pendingSource = attachDeletableSource(pending);
  await assert.rejects(pending.runBrowserSave(["image-1"], "_censored", true), (error) => error.saveState === "pending");
  const pendingCommits = pending.requests.filter((request) => request.path === "/api/save/commit");
  assert.equal(pendingCommits.length, 2, "500 is retried exactly once");
  assert.equal(pendingCommits[0].options.body, pendingCommits[1].options.body, "500 retry keeps the same save token");
  assert.equal(pending.requests.filter((request) => request.path === "/api/save/status").length, 1, "a failed retry queries the token state");
  assert.equal(cancels, 1, "a pending token is cancelled once");
  assert.deepEqual(pendingSource, { deleted: false, restored: false }, "a pending failed copy never deletes the source before its receipt commits");

  commits = 0; cancels = 0;
  const committed = createRuntime({
    deleteOriginal: true,
    commit: () => { commits += 1; return jsonResponse({ error_code: "workspace_database_error" }, 500); },
    saveStatus: () => jsonResponse({ state: "committed", cleared: true, stale: false, images: [] }),
    saveCancel: () => { cancels += 1; return jsonResponse({ state: "cancelled" }); },
  });
  const committedSource = attachDeletableSource(committed);
  await committed.runBrowserSave(["image-1"], "_censored", true);
  assert.equal(committed.requests.filter((request) => request.path === "/api/save/commit").length, 2, "a committed state is checked after the one retry");
  assert.equal(cancels, 0, "a committed token is never cancelled");
  assert.deepEqual(committedSource, { deleted: false, restored: false }, "a recovered committed receipt does not infer or repeat source deletion");

  commits = 0; cancels = 0;
  const unknown = createRuntime({
    deleteOriginal: true,
    commit: () => { commits += 1; return jsonResponse({ error_code: "workspace_database_error" }, 500); },
    saveStatus: () => jsonResponse({ state: "unknown" }),
    saveCancel: () => { cancels += 1; return jsonResponse({ state: "cancelled" }); },
  });
  const unknownSource = attachDeletableSource(unknown);
  await assert.rejects(unknown.runBrowserSave(["image-1"], "_censored", true), (error) => error.saveState === "unknown");
  assert.equal(unknown.requests.filter((request) => request.path === "/api/save/commit").length, 2, "unknown also follows exactly one retry");
  assert.equal(cancels, 0, "an unknown token is not compensated blindly");
  assert.deepEqual(unknownSource, { deleted: false, restored: false }, "unknown state leaves the source untouched for manual recovery");
}

async function runRetryableCommitCase() {
  let commits = 0;
  const runtime = createRuntime({
    commit: () => {
      commits += 1;
      return commits === 1
        ? jsonResponse({ error: "temporarily unavailable" }, 503)
        : jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });

  await runtime.runBrowserSave(["image-1"], "_censored", false);
  const requests = runtime.requests.filter((request) => request.path === "/api/save/commit");
  assert.equal(requests.length, 2, "503 is retried once");
  assert.equal(requests[0].options.body, requests[1].options.body, "retry keeps the same save token and payload");
  assert.equal(JSON.parse(requests[0].options.body).saveToken, "runtime-render-token");
}

async function runCancelCase() {
  let runtime;
    runtime = createRuntime({
    copy: () => { runtime.state.browserSave.cancelled = true; return binaryResponse([4, 5, 6], "runtime-render-token", null, "G:/output/source_censored.png"); },
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(["image-1"], "_censored", false, "copy");

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"]);
  assert.equal(runtime.elements.get("#applyResult").textContent, "cancelled 1");
}

async function runDeleteOriginalCase() {
    const runtime = createRuntime({
    deleteOriginal: true,
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(["image-1"], "_censored", true);

  const payload = JSON.parse(runtime.requests.find((request) => request.path === "/api/save/commit").options.body);
  assert.equal(payload.saveToken, "runtime-render-token");
  assert.equal(payload.sourceAction, "deleted");
}

async function runHandleOverwriteCase() {
    let written = null;
  const sourceFile = sourceBlob("source.png", 12, 34);
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return { async write(bytes) { written = [...new Uint8Array(bytes)]; }, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
  await runtime.runBrowserSave(["image-1"], "_censored", false, "overwrite");
  assert.deepEqual(written, [4, 5, 6]);
  assert.equal(JSON.parse(runtime.requests.find((request) => request.path === "/api/save/commit").options.body).sourceAction, "overwrite");
}

async function runFormattedHandleOverwriteCase() {
  const files = new Map([['source.png', sourceBlob('source.png', 12, 34)] ]);
  const handles = new Map();
  const handleFor = (name) => {
    if (!handles.has(name)) handles.set(name, {
      name,
      async getFile() { return files.get(name); },
      async createWritable() {
        const bytes = [];
        return { async write(chunk) { bytes.push(...new Uint8Array(chunk)); }, async close() { files.set(name, sourceBlob(name, bytes.length, 35)); }, async abort() {} };
      },
    });
    return handles.get(name);
  };
  const removed = [];
  const parentHandle = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, sourceBlob(name, 0, 34));
      return handleFor(name);
    },
    async removeEntry(name) { removed.push(name); files.delete(name); },
  };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: 'image-1', sourceKind: 'session', relativePath: 'source.png', width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  const access = { fileHandle: handleFor('source.png'), parentHandle, name: 'source.png', size: 12, lastModified: 34 };
  runtime.state.sourceAccess.set('image-1', access);
  runtime.element('#applyOutputFormat').value = 'jpg';
  await runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite');
  assert.deepEqual(removed, ['source.png'], 'a browser PNG overwrite removes the old source only after the JPG save commits');
  assert.equal(access.name, 'source.jpg', 'the live browser source handle follows the renamed output');
  assert.equal(files.has('source.jpg'), true, 'the renamed browser source remains available after commit');
  assert.equal((await parentHandle.getFileHandle('source.jpg')).name, 'source.jpg', 'a project-directory rescan can reopen the renamed browser source');
}

function formattedSourceFixture({ sourceName = 'source.png', failWrite = false, failOldRemove = false } = {}) {
  const files = new Map([[sourceName, sourceBlob(sourceName, 12, 34)]]);
  const handles = new Map(); const removed = [];
  const handleFor = (name) => {
    if (!handles.has(name)) handles.set(name, {
      name,
      async getFile() { return files.get(name); },
      async createWritable() {
        const bytes = [];
        return {
          async write(chunk) { if (failWrite && name !== sourceName) throw new Error('target write failed'); bytes.push(...new Uint8Array(chunk)); },
          async close() { files.set(name, sourceBlob(name, bytes.length, 35)); },
          async abort() {},
        };
      },
    });
    return handles.get(name);
  };
  const parentHandle = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, sourceBlob(name, 0, 34));
      return handleFor(name);
    },
    async removeEntry(name) {
      removed.push(name);
      if (failOldRemove && name === sourceName) throw new Error('old source removal failed');
      files.delete(name);
    },
  };
  return { files, handleFor, parentHandle, removed };
}

function configureFormattedOverwrite(runtime, fixture, sourceName, format) {
  const image = { id: 'image-1', sourceKind: 'session', relativePath: `nested/${sourceName}`, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const access = { fileHandle: fixture.handleFor(sourceName), parentHandle: fixture.parentHandle, name: sourceName, relativePath: `nested/${sourceName}`, size: 12, lastModified: 34 };
  runtime.state.images = [image];
  runtime.state.sourceAccess.set(image.id, access);
  runtime.element('#applyOutputFormat').value = format;
  return { image, access };
}

async function runFormattedHandleWriteFailureCase() {
  const fixture = formattedSourceFixture({ failWrite: true });
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  configureFormattedOverwrite(runtime, fixture, 'source.png', 'jpg');
  await assert.rejects(runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite'));
  assert.equal(fixture.files.has('source.png'), true, 'a target write failure keeps the original browser source');
  assert.equal(fixture.files.has('source.jpg'), false, 'a target write failure removes the partial renamed file');
  assert.equal(runtime.requests.some((request) => request.path === '/api/save/commit'), false, 'a target write failure never commits the rename');
}

async function runFormattedHandleCommitRejectionCase() {
  const fixture = formattedSourceFixture();
  const runtime = createRuntime({ commit: () => jsonResponse({ error: 'commit rejected' }, 400) });
  configureFormattedOverwrite(runtime, fixture, 'source.png', 'jpg');
  await assert.rejects(runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite'), (error) => error.code === 'internal_error');
  assert.equal(fixture.files.has('source.png'), true, 'a rejected commit preserves the original browser source');
  assert.equal(fixture.files.has('source.jpg'), false, 'a rejected commit removes the uncommitted renamed file');
}

async function runFormattedHandleOldRemoveFailureCase() {
  const fixture = formattedSourceFixture({ sourceName: 'source.jpg', failOldRemove: true });
  const catalogImage = { id: 'image-1', sourceKind: 'session', relativePath: 'nested/source.jpg', editedFilename: 'pending-edit.jpg', width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let commits = 0;
  const runtime = createRuntime({
    initialImages: [catalogImage],
    commit: () => {
      commits += 1;
      catalogImage.relativePath = 'nested/source.png'; catalogImage.editedFilename = null;
      return jsonResponse({ error_code: 'workspace_database_error' }, 500);
    },
    saveStatus: () => jsonResponse({ state: 'committed', cleared: true, stale: false, sourceAction: 'overwrite' }),
  });
  const configured = configureFormattedOverwrite(runtime, fixture, 'source.jpg', 'png');
  const { access } = configured;
  await assert.rejects(runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite'));
  assert.equal(commits, 2, 'a lost real-shaped commit response retries once before its status receipt confirms the saved rename');
  assert.equal(runtime.requests.filter((request) => request.path === '/api/save/status').length, 1, 'a status receipt without image fields is reconciled after cleanup failure');
  assert.equal(fixture.files.has('source.jpg'), true, 'a failed old-source removal leaves the old file available for manual cleanup');
  assert.equal(fixture.files.has('source.png'), true, 'the committed renamed browser source remains available');
  const live = runtime.state.sourceAccess.get('image-1');
  assert.equal(live.name, 'source.png', 'the live access record follows the committed renamed source after old-file cleanup fails');
  assert.equal(live.relativePath, 'nested/source.png', 'the live relative path follows the committed renamed source after old-file cleanup fails');
  assert.equal(access.name, 'source.png', 'the original live access object is updated before old-file cleanup reports its failure');
  assert.equal(runtime.state.images[0].relativePath, 'nested/source.png', 'a failed old-source cleanup still reconciles the committed canonical catalogue name');
  assert.equal(runtime.state.images[0].editedFilename, null, 'a failed old-source cleanup does not retain the cleared pending rename in the catalogue');
}

async function runSingleFormattedHandleOverwriteCase() {
  const fixture = formattedSourceFixture({ sourceName: 'single.jpg', failOldRemove: true });
  const image = { id: 'image-1', sourceKind: 'session', relativePath: 'nested/single.jpg', editedFilename: 'pending-edit.jpg', width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({ cleared: true, stale: false, relativePath: 'nested/pending-edit.png', editedFilename: null }) });
  const access = { fileHandle: fixture.handleFor('single.jpg'), parentHandle: fixture.parentHandle, name: 'single.jpg', relativePath: 'nested/single.jpg', size: 12, lastModified: 34 };
  runtime.state.sourceAccess.set(image.id, access);
  runtime.state.currentId = image.id; runtime.state.currentImage = image;
  runtime.state.singleSave = { imageId: image.id, generation: runtime.state.imageGeneration, divisor: 100, draft: null };
  runtime.element('input[name="singleSaveMode"]:checked').value = 'overwrite';
  runtime.element('#singleSaveOutputFormat').value = 'png';
  await runtime.startSingleSave({ preventDefault() {} });
  assert.deepEqual(fixture.removed, ['single.jpg'], 'single overwrite attempts old-source cleanup only after committing its PNG replacement');
  assert.equal(access.name, 'pending-edit.png', 'single overwrite updates its live browser access to the edited PNG replacement before cleanup reports failure');
  assert.equal(fixture.files.has('pending-edit.png'), true, 'single overwrite retains the committed edited PNG replacement after cleanup failure');
  assert.equal(runtime.state.images[0].relativePath, 'nested/pending-edit.png', 'a real-shaped commit response publishes the canonical saved basename before cleanup failure');
  assert.equal(runtime.state.images[0].editedFilename, null, 'an explicit real-shaped editedFilename null clears the pending display rename before cleanup failure');
}

async function runEditedHandleOverwriteCase() {
  const fixture = formattedSourceFixture({ sourceName: "source.png" });
  const image = { id: "image-1", sourceKind: "session", relativePath: "nested/source.png", editedFilename: "edited-name.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({ initialImages: [image], commit: () => { image.relativePath = "nested/edited-name.png"; image.editedFilename = null; return jsonResponse({ cleared: true, stale: false, relativePath: image.relativePath, editedFilename: null }); } });
  const access = { fileHandle: fixture.handleFor("source.png"), parentHandle: fixture.parentHandle, name: "source.png", relativePath: "nested/source.png", size: 12, lastModified: 34 };
  runtime.state.sourceAccess.set(image.id, access);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.deepEqual(fixture.removed, ["source.png"], "an edited original save retires the canonical source only after committing its replacement");
  assert.equal(fixture.files.has("edited-name.png"), true, "an edited original save writes the edited basename even when the output format is unchanged");
  assert.equal(access.name, "edited-name.png", "the live browser source handle follows the edited basename");
  assert.equal(access.relativePath, "nested/edited-name.png", "the live access keeps the canonical directory with the edited basename");
}

async function runJpegFormattedHandlePreservationCase() {
  const sourceFile = sourceBlob('source.jpeg', 12, 34); let writes = 0;
  const sourceHandle = {
    name: sourceFile.name,
    async getFile() { return sourceFile; },
    async createWritable() { return { async write() { writes += 1; }, async close() {}, async abort() {} }; },
  };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: 'image-1', sourceKind: 'session', relativePath: 'nested/source.jpeg', width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  const access = { fileHandle: sourceHandle, name: sourceFile.name, relativePath: 'nested/source.jpeg', size: sourceFile.size, lastModified: sourceFile.lastModified };
  runtime.state.sourceAccess.set('image-1', access);
  runtime.element('#applyOutputFormat').value = 'jpg';
  await runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite');
  assert.equal(writes, 1, 'JPEG to JPG overwrites the existing browser handle without a rename');
  assert.equal(access.name, 'source.jpeg', 'JPEG to JPG preserves the original .jpeg source name');
  assert.equal(access.relativePath, 'nested/source.jpeg', 'JPEG to JPG preserves the original project relative path');
}

async function runFormattedHandleCollisionCase() {
  const source = sourceBlob('source.png', 12, 34); const destination = sourceBlob('source.jpg', 9, 30);
  const sourceHandle = { name: 'source.png', async getFile() { return source; } };
  const parentHandle = { async getFileHandle(name) { if (name === 'source.jpg') return { name, async getFile() { return destination; } }; throw new DOMException('missing', 'NotFoundError'); }, async removeEntry() { throw new Error('must not remove on collision'); } };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: 'image-1', sourceKind: 'session', relativePath: 'source.png', width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set('image-1', { fileHandle: sourceHandle, parentHandle, name: 'source.png', size: 12, lastModified: 34 });
  runtime.element('#applyOutputFormat').value = 'jpg';
  await assert.rejects(runtime.runBrowserSave(['image-1'], '_censored', false, 'overwrite'), (error) => error?.code === 'save_write_failed');
  assert.equal(runtime.requests.some((request) => request.path === '/api/save/commit'), false, 'a pre-existing renamed target leaves the original source and does not commit');
}

async function runHandleOverwriteChangedDuringRenderCase() {
  let writes = 0;
  let sourceFile = sourceBlob("source.png", 12, 34);
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      writes += 1;
      return { async write() {}, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({
    renderBinary: () => binaryResponse([4, 5, 6], "runtime-render-token", () => {
      sourceFile = sourceBlob("source.png", 13, 35);
    }),
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  runtime.state.images = [{ id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });

  await runtime.runBrowserSave(["image-1"], "_censored", false, "overwrite");
  assert.equal(writes, 1, "streaming starts only after the user-granted source check");
}

async function runRepeatedHandleOverwriteCase() {
  const image = { id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let sourceFile = sourceBlob("source.png", 12, 34);
  let writes = 0;
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return {
        async write() {},
        async close() { writes += 1; sourceFile = sourceBlob("source.png", 3, 34 + writes); },
        async abort() {},
      };
    },
  };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({ cleared: false, stale: false, images: [image] }) });
  const access = { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified };
  runtime.state.sourceAccess.set(image.id, access);

  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, { name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.equal(writes, 2);
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, { name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
}

async function runHandleDeleteAfterCopyCase() {
    let removed = false;
  const sourceHandle = { name: "source.png", async getFile() { return sourceBlob("source.png", 1, 1); } };
  const parentHandle = { async removeEntry(name) { assert.equal(name, "source.png"); removed = true; }, async getFileHandle() { return sourceHandle; } };
  const runtime = createRuntime({ deleteOriginal: true, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, parentHandle, name: sourceHandle.name, size: 1, lastModified: 1 });
  await runtime.runBrowserSave(["image-1"], "_censored", true);
  assert.equal(removed, false, "the source handle stays intact when the separate server delete receipt cannot be recovered");
  assert.equal(JSON.parse(runtime.requests.find((request) => request.path === "/api/save/commit").options.body).sourceAction, "keep");
}

async function runQueuedHandleChangeCases() {
  const first = { id: "image-1", sourceKind: "session", relativePath: "first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", sourceKind: "session", relativePath: "second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  for (const mode of ["overwrite", "copy"]) {
    let secondFile = sourceBlob("second.png", 12, 34);
    let secondAction = false;
    const firstHandle = {
      async getFile() { return sourceBlob("first.png", 12, 34); },
      async createWritable() { return { async write() {}, async close() {}, async abort() {} }; },
      async remove() {},
    };
    const secondHandle = {
      async getFile() { return secondFile; },
      async createWritable() { secondAction = true; return { async write() {}, async close() {}, async abort() {} }; },
      async remove() { secondAction = true; },
    };
    const parentFor = (handle) => ({
      async removeEntry() { if (handle === secondHandle) secondAction = true; },
      async getFileHandle() { return handle; },
    });
    const runtime = createRuntime({
      initialImages: [first, second],
      entries: [
        { imageId: first.id, relativePath: first.relativePath, candidateRevision: 1, deleteOriginal: mode === "copy" },
        { imageId: second.id, relativePath: second.relativePath, candidateRevision: 1, deleteOriginal: mode === "copy" },
      ],
      deleteOriginal: mode === "copy",
      commit: ({ requests }) => {
        if (requests.filter((request) => request.path === "/api/save/commit").length === 1) {
          secondFile = { ...secondFile, size: 13, lastModified: 35 };
        }
        return jsonResponse({ cleared: true, stale: false, images: [] });
      },
    });
    runtime.state.sourceAccess.set(first.id, { fileHandle: firstHandle, parentHandle: parentFor(firstHandle), name: "first.png", size: 12, lastModified: 34 });
    runtime.state.sourceAccess.set(second.id, { fileHandle: secondHandle, parentHandle: parentFor(secondHandle), name: secondFile.name, size: secondFile.size, lastModified: secondFile.lastModified });
    await runtime.ensureSaveSources([first.id, second.id], mode, mode === "copy");
    await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", mode === "copy", mode), (error) => error?.code === "stale_asset");
    assert.equal(secondAction, false, `${mode} does not modify a queued source that changed after preflight`);
  }
}

async function runCatalogEpochGuardCase() {
  const original = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const local = { id: "local-change", relativePath: "local.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let runtime;
  let removals = 0;
  runtime = createRuntime({
    initialImages: [original],
    commit: () => {
      runtime.state.catalogEpoch += 1;
      runtime.state.images = [local];
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
    removeCatalog: () => { removals += 1; return jsonResponse({ images: [] }); },
  });
  await runtime.runBrowserSave([original.id], "_censored", false, "copy", true);
  assert.deepEqual(runtime.state.images, [local], "a newer catalog epoch rejects the final save snapshot");
  assert.equal(removals, 0, "a superseded save does not remove entries from the newer catalog");
  assert.equal(runtime.imageFetches(), 0, "a keep-source copy has no catalogue snapshot to supersede");
}

async function runPartialCommitFailureReconcileCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  const exclusionOnly = { id: "image-3", relativePath: "nested/exclusion-only.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let commitCount = 0;
  const runtime = createRuntime({
    deleteOriginal: true,
    entries: [
      { imageId: first.id, relativePath: first.relativePath, candidateRevision: 7, deleteOriginal: true },
      { imageId: second.id, relativePath: second.relativePath, candidateRevision: 8, deleteOriginal: true },
    ],
    initialImages: [first, second, exclusionOnly],
    commit: () => {
      commitCount += 1;
      if (commitCount === 1) return jsonResponse({ cleared: true, stale: false, images: [second, exclusionOnly] });
      return jsonResponse({ error: "second commit failed" }, 500);
    },
  });
  runtime.state.currentId = first.id;
  runtime.state.currentImage = { width: first.width, height: first.height };
  runtime.state.candidates = [{ id: "first-candidate", enabled: true }];
  runtime.state.candidateImages = new Map([["first-candidate", {}]]);
  runtime.state.drafts = new Map([
    [first.id, { add: "data:image/png;base64,test", exclusion: "", hasEffectiveMask: true }],
    [second.id, { add: "data:image/png;base64,test", exclusion: "", manualEnabled: true, hasEffectiveMask: true }],
    [exclusionOnly.id, { add: "", exclusion: "data:image/png;base64,test", hasEffectiveMask: false }],
  ]);
  runtime.state.galleryFilter = "masked";
  runtime.state.maskStatus.set(first.id, true);
  runtime.state.maskStatus.set(second.id, false);
  runtime.state.maskStatus.set(exclusionOnly.id, true);

  await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", true), (error) => error.code === "internal_error");

  assert.deepEqual(Array.from(runtime.state.images, (image) => image.id), [second.id, exclusionOnly.id]);
  assert.equal(runtime.state.drafts.has(first.id), false);
  assert.equal(runtime.state.currentId, null);
  assert.equal(runtime.state.currentImage, null);
  assert.equal(runtime.state.candidates.length, 0);
  assert.equal(runtime.state.candidateImages.size, 0);
  assert.equal(runtime.state.maskStatus.get(second.id), true, "an add-only draft remains a save target after partial failure");
  assert.equal(runtime.state.maskStatus.get(exclusionOnly.id), false, "an exclusion-only draft is not a save target");
  assert.deepEqual(Array.from(runtime.saveTargets()), [second.id]);
  assert.equal(runtime.state.galleryNodes.has(first.id), false);
  assert.equal(runtime.state.galleryNodes.has(second.id), true, "the masked gallery renders the remaining add-only draft");
  assert.equal(runtime.state.galleryNodes.has(exclusionOnly.id), false, "the masked gallery excludes an exclusion-only draft");
}

async function runRemoveAfterSaveCases() {
  const saved = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const retained = { id: "image-2", relativePath: "nested/retained.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let removalPayload = null;
  const enabled = createRuntime({
    initialImages: [saved, retained],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved, retained] }),
    removeCatalog: ({ options }) => {
      removalPayload = JSON.parse(options.body);
      return jsonResponse({ images: [retained], removedImageIds: [saved.id] });
    },
  });
  await enabled.runBrowserSave([saved.id], "_censored", false, "copy", true);
  assert.deepEqual(removalPayload, {
    imageIds: [saved.id], expectedProjectId: null, expectedCatalogGeneration: null,
  }, "only completed and committed images are removed after save");
  assert.deepEqual(enabled.state.images.map((image) => image.id), [retained.id]);

  const disabled = createRuntime({
    initialImages: [saved],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved] }),
  });
  await disabled.runBrowserSave([saved.id], "_censored", false, "copy", false);
  assert.equal(disabled.requests.some((request) => request.path === "/api/catalog/remove"), false, "unchecked removal leaves the catalog unchanged");

  const stale = createRuntime({
    initialImages: [saved],
    commit: () => jsonResponse({ cleared: false, stale: true, deleted: false, images: [saved] }),
  });
  await stale.runBrowserSave([saved.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves remain in the catalog");
}

async function runNoEffectRemovalEligibilityCases() {
  const image = { id: "image-1", relativePath: "source.png", sourceKind: "filesystem", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  const copy = createRuntime({
    initialImages: [image],
    copy: () => binaryResponse([4, 5, 6], "copy-no-effect", null, "", true),
    commit: () => jsonResponse({ cleared: true, stale: false }),
    removeCatalog: () => jsonResponse({ images: [], removedImageIds: [image.id] }),
  });
  await copy.runBrowserSave([image.id], "_censored", false, "copy", true);
  assert.equal(copy.requests.some((request) => request.path === "/api/catalog/remove"), true, "a committed copy remains eligible when the render reports no effect");

  const overwrite = createRuntime({
    initialImages: [image],
    renderBinary: () => binaryResponse([4, 5, 6], "overwrite-no-effect", null, "", true),
    commit: () => jsonResponse({ cleared: true, stale: false }),
  });
  await overwrite.runBrowserSave([image.id], "_censored", false, "overwrite", true);
  assert.equal(overwrite.requests.some((request) => request.path === "/api/catalog/remove"), false, "a no-effect overwrite remains in the catalog");
}

async function runCancelledBatchRemovalAfterSettledWorkersCase() {
  const images = ["first", "second", "third"].map((id) => ({ id, relativePath: `${id}.png`, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const entries = images.map((image) => ({ imageId: image.id, relativePath: image.relativePath, candidateRevision: 1 }));
  const secondRenderStarted = deferred(); const firstCommitted = deferred(); const releaseSecondRender = deferred();
  let commits = 0; let thirdStarted = false;
  const runtime = createRuntime({
    initialImages: images, entries,
    copy: async ({ options }) => {
      const imageId = JSON.parse(options.body).imageId;
      if (imageId === "second") { secondRenderStarted.resolve(); await releaseSecondRender.promise; }
      if (imageId === "third") thirdStarted = true;
      return binaryResponse([4, 5, 6], `${imageId}-token`);
    },
    commit: () => {
      commits += 1;
      if (commits === 1) { runtime.state.browserSave.cancelled = true; firstCommitted.resolve(); }
      return jsonResponse({ cleared: true, stale: false });
    },
    removeCatalog: ({ options }) => {
      assert.equal(commits, 2, "catalog removal waits for every started worker to commit");
      assert.deepEqual(JSON.parse(options.body), {
        imageIds: ["first", "second"], expectedProjectId: null, expectedCatalogGeneration: null,
      });
      return jsonResponse({ images: [images[2]], removedImageIds: ["first", "second"] });
    },
  });
  runtime.state.settings.saving.parallelism = 2;
  const saving = runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy", true);
  await Promise.all([secondRenderStarted.promise, firstCommitted.promise]);
  assert.equal(runtime.state.browserSave.cancelled, true, "the first committed entry records cancellation before the held worker settles");
  assert.equal(runtime.state.saving, true, "the batch remains active until the held worker settles");
  assert.equal(commits, 1, "only the first worker has committed before the held render is released");
  assert.equal(runtime.requests.some((request) => request.path === "/api/catalog/remove"), false, "catalog removal does not run before the held worker settles");
  assert.equal(thirdStarted, false, "cancellation prevents the unstarted third entry");
  releaseSecondRender.resolve();
  await saving;
  assert.equal(runtime.requests.filter((request) => request.path === "/api/catalog/remove").length, 1, "cancelled work submits one terminal removal");
  assert.equal(thirdStarted, false, "the third entry remains in the catalog after cancellation");
}

async function runNoEffectiveMaskBatchCases() {
  const first = { id: "image-1", relativePath: "first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "second.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  const none = createRuntime({
    initialImages: [second],
    renderBinary: () => jsonResponse({ error_code: "no_effective_mask" }, 400),
    commit: () => { throw new Error("an empty mask is never committed"); },
  });
  await none.runBrowserSave([second.id], "_censored", false, "copy", true);
  assert.equal(none.requests.some((request) => request.path === "/api/save/commit"), false, "an all-empty batch does not save or delete its source");
  assert.equal(none.requests.some((request) => request.path === "/api/catalog/remove"), false, "an all-empty batch remains in the catalog");

  const noneUnmasked = createRuntime({
    initialImages: [second],
    renderBinary: () => jsonResponse({ error_code: "no_effective_mask" }, 400),
    commit: () => { throw new Error("an empty mask is never committed"); },
  });
  await noneUnmasked.runBrowserSave([second.id], "_censored", false, "copy", true, false);
  assert.equal(noneUnmasked.requests.some((request) => request.path === "/api/catalog/remove"), false, "an all-empty batch remains even when remove-only-masked is off");

  let renders = 0;
  const mixed = createRuntime({
    initialImages: [first, second],
    entries: [{ imageId: first.id, candidateRevision: 1 }, { imageId: second.id, candidateRevision: 1 }],
    renderBinary: () => {
      renders += 1;
      return renders === 1 ? binaryResponse([4, 5, 6]) : jsonResponse({ error_code: "no_effective_mask" }, 400);
    },
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), {
        imageIds: [first.id], expectedProjectId: null, expectedCatalogGeneration: null,
      });
      return jsonResponse({ images: [second], removedImageIds: [first.id] });
    },
  });
  await mixed.runBrowserSave([first.id, second.id], "_censored", false, "copy", true);
  assert.equal(mixed.requests.filter((request) => request.path === "/api/save/commit").length, 1, "only the effective image is committed");
  assert.equal(mixed.requests.filter((request) => request.path === "/api/catalog/remove").length, 1, "remove-only-masked removes only the saved image");

  const keepAll = createRuntime({
    initialImages: [first, second],
    entries: [{ imageId: first.id, candidateRevision: 1 }, { imageId: second.id, candidateRevision: 1 }],
    copy: () => (++renders % 2 ? jsonResponse({ output: "G:/output/first.png" }) : jsonResponse({ error_code: "no_effective_mask" }, 400)),
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), {
        imageIds: [first.id], expectedProjectId: null, expectedCatalogGeneration: null,
      });
      return jsonResponse({ images: [second], removedImageIds: [first.id] });
    },
  });
  await keepAll.runBrowserSave([first.id, second.id], "_censored", false, "copy", true, false);
  assert.equal(keepAll.requests.filter((request) => request.path === "/api/catalog/remove").length, 1, "remove-after-save removes only the saved image when remove-only-masked is off");
}

async function runSaveKeepsCatalogueAndEditorStateCase() {
  const first = { id: "image-1", relativePath: "first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: true, hidden: false };
  const second = { id: "image-2", relativePath: "second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: true, hidden: true };
  const runtime = createRuntime({
    initialImages: [first, second],
    entries: [
      { imageId: first.id, relativePath: first.relativePath, candidateRevision: 7 },
      { imageId: second.id, relativePath: second.relativePath, candidateRevision: 7 },
    ],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false }),
  });
  runtime.state.currentId = first.id;
  runtime.state.currentImage = { width: 32, height: 32 };
  runtime.state.candidates = [{ id: "candidate", enabled: true }];
  runtime.state.candidateImages = new Map([["candidate", {}]]);
  runtime.state.drafts = new Map([[first.id, { add: "manual", exclusion: "exclude", hasEffectiveMask: true }], [second.id, { add: "manual-2", hasEffectiveMask: true }]]);
  runtime.state.maskStatus = new Map([[first.id, true], [second.id, true]]);
  runtime.state.reviewedImageIds = new Set([first.id, second.id]);
  runtime.state.hiddenImageIds = new Set([second.id]);

  assert.deepEqual(Array.from(runtime.saveTargets()), [first.id], "the normal batch target excludes hidden images");
  await runtime.runBrowserSave([first.id], "_censored", false, "copy");
  await runtime.runBrowserSave([first.id], "_censored", false, "copy");

  assert.deepEqual(runtime.state.images, [first, second], "two consecutive saves keep every catalogue image");
  assert.equal(runtime.state.drafts.get(first.id).add, "manual", "saving retains manual masks");
  assert.equal(runtime.state.drafts.get(first.id).exclusion, "exclude", "saving retains exclusions");
  assert.equal(runtime.state.candidates.length, 1, "saving retains current candidates");
  assert.deepEqual(Array.from(runtime.state.reviewedImageIds), [first.id, second.id], "saving does not change reviewed state");
  assert.deepEqual(Array.from(runtime.state.hiddenImageIds), [second.id], "saving does not change hidden state");
  assert.equal(runtime.requests.some((request) => request.path === "/api/catalog/remove"), false, "saving never removes list entries");
}

nodeTest("browser save runtime contracts", async () => {
  await runOutputDirectoryPermissionCases();
  await runBrowserSourcePreflightFailureCases();
  await runParentlessBrowserSourcePreparationCase();
  await runSingleCopyKeepsEditorStateCase();
  await runPauseResetAfterTerminalBrowserSaveCase();
  await runOutputPermissionSubmissionLockCases();
  await runSuccessCase();
  await runDraftBarrierBeforeDefaultApplyCase();
  await runStaleCommitCase();
  await runCopyFailureCase();
  await runCommitFailureCase();
  await runRecoverableCommitFailureCases();
  await runRetryableCommitCase();
  await runCancelCase();
  await runDeleteOriginalCase();
  await runHandleOverwriteCase();
  await runFormattedHandleOverwriteCase();
  await runFormattedHandleCollisionCase();
  await runFormattedHandleWriteFailureCase();
  await runFormattedHandleCommitRejectionCase();
  await runFormattedHandleOldRemoveFailureCase();
  await runSingleFormattedHandleOverwriteCase();
  await runEditedHandleOverwriteCase();
  await runJpegFormattedHandlePreservationCase();
  await runHandleOverwriteChangedDuringRenderCase();
  await runRepeatedHandleOverwriteCase();
  await runHandleDeleteAfterCopyCase();
  await runQueuedHandleChangeCases();
  await runCatalogEpochGuardCase();
  await runRemoveAfterSaveCase();
  await runRemoveAfterSaveAlreadyAbsentCase();
  await runRemoveAfterSavePartialAndStaleCase();
  await runRemoveAfterSaveUiCleanupCase();
  await runRemoveAfterSaveCases();
  await runNoEffectRemovalEligibilityCases();
  await runCancelledBatchRemovalAfterSettledWorkersCase();
  await runSaveKeepsCatalogueAndEditorStateCase();
  await runExclusiveWritableCases();
  await runPartialOutputCleanupCases();
  await runConcurrentOutputLockCases();
  await runBrowserCopyPoolAndWriteOverlapCases();
  await runBrowserCopyPoolAtScaleCases();
  await runBrowserCopyRenderFailureCancelsReservationCase();
  await runBrowserHandleSnapshotSerializationCase();
  await runBrowserHandleOverwritePoolAtScaleCase();
  await runSingleSaveKeepsReviewAndDraftCase();
  runOutputDirectoryDisplayCase();
});
