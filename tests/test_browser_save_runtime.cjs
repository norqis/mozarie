const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
    classList: { toggle() {}, add() {} },
    setAttribute() {},
    append(child) { this.children.push(child); child.parentNode = this; },
    remove() { const siblings = this.parentNode?.children; const index = siblings?.indexOf(this); if (index >= 0) siblings.splice(index, 1); },
    addEventListener() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  return node;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function binaryResponse(bytes, saveToken = "runtime-render-token", beforePipe = null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "X-Mozarie-Save-Token" ? saveToken : null },
    body: { pipeTo: async (writable) => { await beforePipe?.(); await writable.write(Uint8Array.from(bytes)); await writable.close(); } },
    json: async () => ({}),
  };
}

function createRuntime({ commit, copy = null, deleteOriginal = false, renderBinary = null, renderToken = "runtime-render-token", entries = null, initialImages = null, saveStatus = null, saveCancel = null }) {
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
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Image: class {},
    IntersectionObserver: class { observe() {} unobserve() {} },
    URL: { createObjectURL() { return "blob:runtime-test"; }, revokeObjectURL() {} },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
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
      if (requestPath === "/api/apply") return jsonResponse({ kind: "apply", state: "running" });
      if (requestPath === "/api/save/render") {
        const payload = JSON.parse(options.body || "{}");
        if (payload.copyToDefault) {
          const response = await (copy || (() => jsonResponse({ output: "G:/output/source_censored.png" })))({ options, requests });
          if (!response.ok) return response;
          return jsonResponse({ ...await response.json(), candidateRevision: payload.candidateRevision, saveToken: renderToken });
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
      throw new Error(`Unexpected request: ${requestPath}`);
    },
  };

  const runtimeContext = vm.createContext(context);
  for (const appPath of appPaths) {
    if (path.basename(appPath) === "app.js") continue;
    new vm.Script(fs.readFileSync(appPath, "utf8"), { filename: appPath }).runInContext(runtimeContext);
  }
  new vm.Script(
    "globalThis.__browserSaveRuntime = { state, ensureOutputDirectoryPermission, ensureSaveSources, finishApplyJob, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSingleOutput, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, translate: t };",
    { filename: "test-browser-save-exports.js" },
  ).runInContext(runtimeContext);
  const { state, ensureOutputDirectoryPermission, ensureSaveSources, finishApplyJob, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSingleOutput, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, translate } = context.__browserSaveRuntime;
  state.images = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  state.settings = { saving: { parallelism: 1, default_output_directory: "G:/output" } };
  const outputFiles = new Map();
  state.outputDirectoryHandle = {
    name: "output",
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
    async getFileHandle(name, options = {}) {
      if (!options.create && !outputFiles.has(name)) throw new DOMException("missing", "NotFoundError");
      if (!outputFiles.has(name)) outputFiles.set(name, []);
      return { async createWritable() { return { async write(bytes) { outputFiles.set(name, [...bytes]); }, async close() {}, async abort() {} }; } };
    },
    async removeEntry(name) { outputFiles.delete(name); },
  };
  state.translations = {
    "apply.complete": "complete {completed}",
    "apply.completeWithStale": "stale {completed}/{stale}",
    "apply.cancelled": "cancelled {completed}",
    "apply.progress": "progress {completed}/{total}",
    "gallery.detectAll": "detect all",
    "errorCode.output_permission_denied": "output permission denied",
    "errorDialog.output_permission_denied.title": "Output permission denied",
    "errorDialog.output_permission_denied.cause": "Write access was denied.",
    "errorDialog.output_permission_denied.action": "Allow output access and try again.",
    "apply.outputDirectoryUnset": "Save location: not selected",
    "errorCode.output_write_unsupported": "Output writes are unsupported",
  };
  return { element: getElement, elements, ensureOutputDirectoryPermission, ensureSaveSources, finishApplyJob, imageFetches: () => imageFetches, lockRequests, navigator: browserNavigator, outputFiles, requests, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog, startSingleSave, writeSingleOutput, writeSourceHandle, restoreSourceHandle, renderOutputDirectory, state, translate, window: browserWindow };
}

async function runOutputDirectoryPermissionCases() {
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  const calls = [];
  runtime.state.outputDirectoryHandle = {
    async queryPermission(options) { calls.push(["query", options.mode]); return "prompt"; },
    async requestPermission(options) { calls.push(["request", options.mode]); return "granted"; },
  };
  await runtime.ensureOutputDirectoryPermission();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["query", "readwrite"], ["request", "readwrite"]], "a restored output directory requests read/write access from the save click");

  for (const result of ["denied", "prompt"]) {
    runtime.state.outputDirectoryHandle = {
      async queryPermission() { return result; },
      async requestPermission() { return result; },
    };
    await assert.rejects(runtime.ensureOutputDirectoryPermission(), (error) => error?.code === "output_permission_denied", `${result} output permission stops saving with the dedicated code`);
  }
  runtime.state.outputDirectoryHandle = { async queryPermission() { throw new DOMException("denied", "SecurityError"); }, async requestPermission() { throw new Error("unreachable"); } };
  await assert.rejects(runtime.ensureOutputDirectoryPermission(), (error) => error?.code === "output_permission_denied", "a browser permission exception uses the dedicated code");
}

async function runSingleCopyKeepsEditorStateCase() {
  const image = { id: "image-1", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: true };
  const images = [image];
  const runtime = createRuntime({ initialImages: images, commit: () => jsonResponse({ cleared: true, stale: false }) });
  const candidates = [{ id: "candidate-1", role: "apply", enabled: true }];
  const draft = { add: "manual-mask", exclusion: "manual-exclusion", exclusionErase: "manual-restore" };
  runtime.state.currentId = image.id; runtime.state.currentImage = image;
  runtime.state.singleSave = { imageId: image.id, divisor: 100, draft };
  runtime.state.candidates = candidates; runtime.state.drafts.set(image.id, draft); runtime.state.maskStatus.set(image.id, true);
  runtime.state.manualMaskPresent = true; runtime.state.manualEnabled = false; runtime.state.manualExclusionEnabled = true; runtime.state.manualExclusionEraseEnabled = false; runtime.state.manualExclusionForced = true;
  runtime.element('input[name="singleSaveMode"]:checked').value = "copy";
  runtime.element("#singleSaveDeleteOriginal").checked = false;
  runtime.element("#singleSaveSuffix").value = "_copy";

  await runtime.startSingleSave({ preventDefault() {} });

  assert.equal(runtime.imageFetches(), 0, "copy-and-keep does not reload an unchanged catalogue");
  assert.equal(runtime.state.images, images, "copy-and-keep preserves the catalogue object");
  assert.equal(runtime.state.currentId, image.id, "copy-and-keep preserves the current image");
  assert.equal(runtime.state.currentImage, image, "copy-and-keep preserves the current image object");
  assert.equal(runtime.state.candidates, candidates, "copy-and-keep preserves candidate state");
  assert.equal(runtime.state.drafts.get(image.id), draft, "copy-and-keep preserves all manual draft layers");
  assert.equal(runtime.state.maskStatus.get(image.id), true, "copy-and-keep preserves mask status");
  assert.deepEqual([runtime.state.manualMaskPresent, runtime.state.manualEnabled, runtime.state.manualExclusionEnabled, runtime.state.manualExclusionEraseEnabled, runtime.state.manualExclusionForced], [true, false, true, false, true], "copy-and-keep preserves manual layer switches");
  assert.deepEqual([image.reviewed, image.hidden], [false, true], "copy-and-keep preserves reviewed and hidden flags");
}

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

async function runOutputPermissionSubmissionLockCases() {
  const event = { preventDefault() {} };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.applyTargetIds = ["image-1"];
  runtime.element('input[name="batchSaveMode"]:checked').value = "copy";
  runtime.element("#applySuffix").value = "_locked";
  const batchPermission = deferred();
  let batchQueries = 0;
  runtime.state.outputDirectoryHandle.queryPermission = async () => { batchQueries += 1; return batchPermission.promise; };
  const firstBatch = runtime.startApplyFromDialog(event);
  const secondBatch = runtime.startApplyFromDialog(event);
  assert.equal(runtime.state.saveStarting, true, "batch locks synchronously before the output permission await");
  assert.equal(batchQueries, 1, "a second batch submit does not duplicate the permission request");
  batchPermission.resolve("granted");
  await Promise.all([firstBatch, secondBatch]);
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 1, "a pending batch permission starts one save loop and one commit");
  assert.equal(runtime.state.saveStarting, false, "a completed batch releases the preflight lock");

  const retryPermission = deferred();
  runtime.state.applyTargetIds = ["image-1"];
  runtime.state.outputDirectoryHandle.queryPermission = async () => retryPermission.promise;
  const deniedBatch = runtime.startApplyFromDialog(event);
  retryPermission.resolve("denied");
  await deniedBatch;
  assert.equal(runtime.state.saveStarting, false, "a rejected batch permission releases the lock");
  const commitsBeforeRetry = runtime.requests.filter((request) => request.path === "/api/save/commit").length;
  runtime.state.outputDirectoryHandle.queryPermission = async () => "granted";
  await runtime.startApplyFromDialog(event);
  assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, commitsBeforeRetry + 1, "a rejected batch permission can be retried");

  const lockedImage = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false };
  const single = createRuntime({ initialImages: [lockedImage], commit: () => jsonResponse({ cleared: true, stale: false, images: [lockedImage] }) });
  single.state.singleSave = { imageId: "image-1", divisor: 100, draft: null };
  single.element('input[name="singleSaveMode"]:checked').value = "copy";
  single.element("#singleSaveSuffix").value = "_locked";
  single.element("#singleSaveDeleteOriginal").checked = true;
  let sourceDeletes = 0;
  const sourceFile = { name: "source.png", size: 3, lastModified: 2, async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };
  const sourceHandle = {
    name: sourceFile.name,
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
    async getFile() { return sourceFile; },
  };
  single.state.sourceAccess.set("image-1", {
    fileHandle: sourceHandle,
    parentHandle: { async removeEntry(name) { assert.equal(name, sourceFile.name); sourceDeletes += 1; } },
    name: sourceFile.name,
    size: sourceFile.size,
    lastModified: sourceFile.lastModified,
  });
  const singlePermission = deferred();
  let singleQueries = 0;
  single.state.outputDirectoryHandle.queryPermission = async () => { singleQueries += 1; return singlePermission.promise; };
  const firstSingle = single.startSingleSave(event);
  const secondSingle = single.startSingleSave(event);
  assert.equal(single.state.saveStarting, true, "single save locks synchronously before the output permission await");
  assert.equal(singleQueries, 1, "a second single-save submit does not duplicate the permission request");
  singlePermission.resolve("granted");
  await Promise.all([firstSingle, secondSingle]);
  assert.equal(single.requests.filter((request) => request.path === "/api/save/commit").length, 1, "a pending single-save permission starts one save loop and one commit");
  assert.equal(sourceDeletes, 1, "a pending single-save permission deletes the source once after its one commit path");
  assert.equal(single.state.saveStarting, false, "a completed single save releases the preflight lock");
  assert.equal(single.state.images[0].reviewed, false, "single save does not mark an unreviewed image as reviewed");

  const singleCommits = single.requests.filter((request) => request.path === "/api/save/commit").length;
  single.state.outputDirectoryHandle.queryPermission = async () => "denied";
  await single.startSingleSave(event);
  assert.equal(single.elements.get("#singleSaveResult").textContent, "output permission denied", "a denied single-save permission uses the localized stable error");
  assert.equal(single.elements.get("#errorDialog").open, true, "a denied single-save permission is visible through the error dialog");
  assert.equal(single.requests.filter((request) => request.path === "/api/save/commit").length, singleCommits, "a denied single-save permission starts no save");
  assert.equal(single.state.saveStarting, false, "a denied single-save permission releases the lock");
  single.state.outputDirectoryHandle.queryPermission = async () => "granted";
  single.state.images[0].reviewed = true;
  await single.startSingleSave(event);
  assert.equal(single.requests.filter((request) => request.path === "/api/save/commit").length, singleCommits + 1, "a denied single-save permission can be retried successfully");
  assert.equal(single.state.images[0].reviewed, true, "single save preserves an already reviewed image");
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
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  const removed = [];
  const output = {
    async getFileHandle(name, options = {}) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() { throw new DOMException("locked", "InvalidStateError"); } };
    },
    async removeEntry(name) { removed.push(name); },
  };
  await assert.rejects(runtime.writeSingleOutput(output, "nested/source.png", "_censored", binaryResponse([1])), /locked/, "a newly created output is not left behind when opening its stream fails");
  assert.deepEqual(removed, ["source_censored.png"], "a failed stream open removes exactly the new output file");

  let aborted = false;
  const pipedOutput = {
    async getFileHandle(name, options = {}) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() { return { async abort() { aborted = true; } }; } };
    },
    async removeEntry(name) { removed.push(name); },
  };
  const brokenResponse = { body: { async pipeTo() { throw new Error("write failed"); } } };
  await assert.rejects(runtime.writeSingleOutput(pipedOutput, "nested/next.png", "", brokenResponse), /write failed/, "a pipe failure is returned to the caller");
  assert.equal(aborted, true, "a failed pipe aborts its open stream");
  assert.deepEqual(removed, ["source_censored.png", "next.png"], "a failed pipe removes the newly created output file");

  const cleanupFailureOutput = {
    async getFileHandle(name, options = {}) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() { throw new Error("write failed"); } };
    },
    async removeEntry() { throw new DOMException("locked", "InvalidStateError"); },
  };
  await assert.rejects(runtime.writeSingleOutput(cleanupFailureOutput, "nested/locked.png", "", binaryResponse([1])), (error) => error.code === "output_cleanup_failed" && error.cause?.message === "write failed", "a cleanup failure is visible with a stable error while retaining the original write failure");

  const unsupportedOutput = {
    async getFileHandle(name, options = {}) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() { throw new TypeError("exclusive mode unsupported"); } };
    },
    async removeEntry() {},
  };
  await assert.rejects(runtime.writeSingleOutput(unsupportedOutput, "nested/unsupported.png", "", binaryResponse([1])), (error) => error.code === "output_write_unsupported", "an unsupported exclusive output stream fails closed with a stable error");
}

async function runConcurrentOutputLockCases() {
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  const files = new Map();
  const removed = [];
  const directory = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, []);
      }
      return { async createWritable(options) {
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { keepExistingData: false, mode: "exclusive" }, "browser outputs always request an exclusive stream");
        return { async write(bytes) { files.set(name, [...bytes]); }, async close() {}, async abort() {} };
      } };
    },
    async removeEntry(name) { removed.push(name); files.delete(name); },
  };

  const [first, second] = await Promise.all([
    runtime.writeSingleOutput(directory, "same.png", "", binaryResponse([1, 2])),
    runtime.writeSingleOutput(directory, "same.png", "", binaryResponse([3, 4])),
  ]);
  assert.deepEqual([first.name, second.name], ["same.png", "same_1.png"], "simultaneous saves reserve different sequence names under one origin lock");
  assert.deepEqual([...files], [["same.png", [1, 2]], ["same_1.png", [3, 4]]], "simultaneous saves retain each file's own bytes");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.lockRequests)), [
    ["mozarie-output-name", { mode: "exclusive" }],
    ["mozarie-output-name", { mode: "exclusive" }],
  ], "only output-name reservation uses the short exclusive Web Lock");

  const failedResponse = { body: { async pipeTo(stream) { await stream.write(Uint8Array.from([9])); throw new Error("write failed"); } } };
  const settled = await Promise.allSettled([
    runtime.writeSingleOutput(directory, "kept.png", "", binaryResponse([5, 6])),
    runtime.writeSingleOutput(directory, "kept.png", "", failedResponse),
  ]);
  assert.equal(settled[0].status, "fulfilled", "one concurrent output can finish when the other write fails");
  assert.equal(settled[1].status, "rejected", "the failed concurrent output reports its write error");
  assert.deepEqual(files.get("kept.png"), [5, 6], "failure cleanup never removes the successful output");
  assert.deepEqual(removed, ["kept_1.png"], "failure cleanup removes only the entry reserved by the failed callback");

  runtime.navigator.locks.request = async () => { throw new DOMException("denied", "NotAllowedError"); };
  await assert.rejects(runtime.writeSingleOutput(directory, "locked.png", "", binaryResponse([7])), (error) => {
    assert.equal(error.code, "output_write_unsupported", "a lock request failure uses the stable output error");
    assert.equal(runtime.translate(`errorCode.${error.code}`), "Output writes are unsupported", "the lock failure resolves to localized user copy");
    return true;
  });
  runtime.navigator.locks = null;
  await assert.rejects(runtime.writeSingleOutput(directory, "missing-lock.png", "", binaryResponse([8])), (error) => error.code === "output_write_unsupported", "missing Web Locks support fails closed without creating an output");
}

async function runBrowserCopyPoolAndWriteOverlapCases() {
  const entries = ["one", "two", "three"].map((id) => ({ imageId: id, relativePath: `${id}.png`, candidateRevision: 7 }));
  const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const releaseRenders = deferred(); const twoRendersStarted = deferred();
  let activeRenders = 0; let maxActiveRenders = 0; let renderStarts = 0;
  const runtime = createRuntime({
    entries, initialImages: images,
    renderBinary: async () => {
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

  const releaseWrites = deferred(); const twoWritesOpened = deferred();
  let openedWrites = 0;
  const files = new Map();
  const directory = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, []);
      }
      return { async createWritable() {
        if (++openedWrites === 2) twoWritesOpened.resolve();
        return { async write(bytes) { files.set(name, [...bytes]); }, async close() {}, async abort() {} };
      } };
    },
    async removeEntry(name) { files.delete(name); },
  };
  const slowResponse = (value) => ({ body: { async pipeTo(stream) { await releaseWrites.promise; await stream.write(Uint8Array.from([value])); await stream.close(); } } });
  const first = runtime.writeSingleOutput(directory, "same.png", "", slowResponse(1));
  const second = runtime.writeSingleOutput(directory, "same.png", "", slowResponse(2));
  const overlapped = await Promise.race([twoWritesOpened.promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]);
  releaseWrites.resolve();
  await Promise.all([first, second]);
  assert.equal(overlapped, true, "copy writes begin together after only their distinct names are reserved");
  assert.deepEqual([...files.values()], [[1], [2]], "parallel copy writes retain their separate reserved outputs");
}

async function runBrowserCopyMemoryBudgetCase() {
  const entries = ["one", "two", "three"].map((id) => ({ imageId: id, relativePath: `${id}.png`, candidateRevision: 1 }));
  const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 3840, height: 2160, candidateCount: 1, enabledCandidateCount: 1 }));
  const releaseRenders = deferred(); const twoRendersStarted = deferred();
  let activeRenders = 0; let maxActiveRenders = 0;
  const runtime = createRuntime({
    entries, initialImages: images,
    renderBinary: async () => {
      activeRenders += 1; maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      if (activeRenders === 2) twoRendersStarted.resolve();
      await releaseRenders.promise;
      activeRenders -= 1;
      return binaryResponse([1]);
    },
    commit: () => jsonResponse({ cleared: false, stale: false }),
  });
  runtime.state.settings.saving.parallelism = 8;
  const batch = runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
  await twoRendersStarted.promise;
  assert.equal(maxActiveRenders, 2, "a 4K browser batch limits an 8-worker setting to two active renders");
  releaseRenders.resolve();
  await batch;
  assert.equal(maxActiveRenders, 2, "4K browser saves never exceed the 512 MiB render budget");
}

async function runBrowserCopyPoolAtScaleCases() {
  for (const parallelism of [1, 2, 4, 8]) {
    const entries = Array.from({ length: 400 }, (_, index) => ({
      imageId: `image-${index}`, relativePath: "nested/same.png", candidateRevision: 7,
    }));
    const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
    let activeReservations = 0; let maxActiveReservations = 0;
    let activeRenders = 0; let maxActiveRenders = 0;
    let activeWrites = 0; let maxActiveWrites = 0;
    const releaseRenders = deferred(); const releaseWrites = deferred();
    const runtime = createRuntime({
      entries, initialImages: images,
      renderBinary: async ({ options }) => {
        const index = Number(JSON.parse(options.body).imageId.slice("image-".length));
        activeRenders += 1; maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
        if (activeRenders === parallelism) releaseRenders.resolve();
        await releaseRenders.promise;
        activeRenders -= 1;
        return {
          ok: true, status: 200,
          headers: { get: (name) => name === "X-Mozarie-Save-Token" ? `token-${index}` : null },
          body: { pipeTo: async (stream) => {
            activeWrites += 1; maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            if (activeWrites === parallelism) releaseWrites.resolve();
            await releaseWrites.promise;
            await stream.write(Uint8Array.from([index >> 8, index & 0xff])); await stream.close();
            activeWrites -= 1;
          } },
        };
      },
      commit: () => jsonResponse({ cleared: false, stale: false, images }),
    });
    runtime.state.outputDirectoryHandle = {
      name: "output",
      async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
      async getFileHandle(name, options = {}) {
        activeReservations += 1; maxActiveReservations = Math.max(maxActiveReservations, activeReservations);
        await Promise.resolve();
        activeReservations -= 1;
        if (!options.create && !runtime.outputFiles.has(name)) throw new DOMException("missing", "NotFoundError");
        if (options.create) runtime.outputFiles.set(name, []);
        return { async createWritable() { return {
          async write(bytes) { runtime.outputFiles.set(name, [...bytes]); }, async close() {}, async abort() {},
        }; } };
      },
      async removeEntry(name) { runtime.outputFiles.delete(name); },
    };
    runtime.state.settings.saving.parallelism = parallelism;
    assert.equal(runtime.saveTargets().length, 400, "all 400 catalogue entries remain batch-save targets before copying");
    await runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
    assert.equal(maxActiveReservations, 1, "same-name reservations remain serialized while output streams run independently");
    assert.equal(maxActiveRenders, parallelism, `400 browser copies use exactly the configured ${parallelism}-entry render pool`);
    assert.equal(maxActiveWrites, parallelism, `400 browser copies use exactly the configured ${parallelism}-entry write pool`);
    assert.equal(runtime.outputFiles.size, 400, "every parallel copy keeps its own reserved output");
    assert.equal(new Set(runtime.outputFiles.keys()).size, 400, "400 parallel copies reserve unique output names");
    assert.equal(new Set([...runtime.outputFiles.values()].map((bytes) => bytes.join(","))).size, 400, "400 parallel copies retain their own response bytes");
    assert.equal(runtime.imageFetches(), 0, "a keep-source browser batch skips its final catalogue reload");
    assert.equal(runtime.saveTargets().length, 400, "repeated copy saving keeps all 400 original entries as targets");
    assert.equal(JSON.parse(runtime.requests[0].options.body).imageIds.length, 400, "the prepare request retains all 400 target IDs");
    await runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy");
    assert.equal(runtime.outputFiles.size, 800, "a repeated 400-copy save reserves another distinct set of outputs");
    assert.equal(runtime.saveTargets().length, 400, "a repeated 400-copy save keeps the source target set invariant");
  }
}

async function runBrowserCopyWriteFailureCancelsRenderCase() {
  const entries = Array.from({ length: 400 }, (_, index) => ({ imageId: `failure-${index}`, relativePath: "nested/same.png", candidateRevision: 1 }));
  const images = entries.map((entry) => ({ id: entry.imageId, relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  let activeRenders = 0; let activeWrites = 0;
  const runtime = createRuntime({
    entries, initialImages: images,
    renderBinary: async ({ options }) => {
      const index = Number(JSON.parse(options.body).imageId.slice("failure-".length));
      activeRenders += 1; await Promise.resolve(); activeRenders -= 1;
      return {
        ok: true, status: 200,
        headers: { get: (name) => name === "X-Mozarie-Save-Token" ? `render-token-${index}` : null },
        body: { async pipeTo(stream) {
          activeWrites += 1;
          try {
            if (index === 399) throw new Error("write failed");
            await stream.write(Uint8Array.from([index >> 8, index & 0xff])); await stream.close();
          } finally { activeWrites -= 1; }
        } },
      };
    },
    commit: () => jsonResponse({ cleared: false, stale: false }),
  });
  runtime.state.settings.saving.parallelism = 8;
  await assert.rejects(runtime.runBrowserSave(entries.map((entry) => entry.imageId), "_censored", false, "copy"), /write failed/);
  const cancellations = runtime.requests.filter((request) => request.path === "/api/save/cancel");
  assert.equal(cancellations.length, 1, "a browser copy write failure releases its issued render token");
  assert.equal(JSON.parse(cancellations[0].options.body).saveToken, "render-token-399", "the cancelled token matches the failed output render");
  assert.equal(runtime.outputFiles.size, 399, "only the failed reservation is removed from a 400-copy batch");
  assert.ok([...runtime.outputFiles.values()].every((bytes) => bytes.length > 0), "failure cleanup leaves no empty reservation file behind");
  assert.equal(new Set([...runtime.outputFiles.values()].map((bytes) => bytes.join(","))).size, 399, "successful 400-copy peers retain their own output bytes");
  assert.equal(activeRenders, 0, "render workers drain after the failed reservation is cancelled");
  assert.equal(activeWrites, 0, "write workers drain after the failed reservation is cleaned up");
}

async function runBrowserHandleSnapshotSerializationCase() {
  const entries = ["one", "two"].map((id) => ({ imageId: id, relativePath: `${id}.png`, candidateRevision: 7 }));
  const images = entries.map((entry) => ({ id: entry.imageId, sourceKind: "session", relativePath: entry.relativePath, width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }));
  const releaseSnapshot = deferred(); const firstSnapshot = deferred();
  let activeSnapshots = 0; let maxActiveSnapshots = 0;
  const sourceHandle = (name) => ({
    async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    async getFile() { return {
      name, size: 3, lastModified: 1,
      async arrayBuffer() {
        activeSnapshots += 1; maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
        if (activeSnapshots === 1) firstSnapshot.resolve();
        await releaseSnapshot.promise;
        activeSnapshots -= 1;
        return Uint8Array.from([1, 2, 3]).buffer;
      },
    }; },
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
    async getFile() { return {
      name, size: files.get(imageId).length, lastModified: 1,
      async arrayBuffer() {
        activeSnapshots += 1; maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots); snapshotStarts += 1;
        await Promise.resolve(); activeSnapshots -= 1;
        return Uint8Array.from(files.get(imageId)).buffer;
      },
    }; },
    async createWritable() {
      writableOpens += 1;
      return { async write(bytes) { files.set(imageId, [...bytes]); }, async close() {}, async abort() {} };
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
  runtime.state.singleSave = { imageId: image.id, divisor: 100, draft: { add: "manual" } };
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
  reviewedRuntime.state.singleSave = { imageId: reviewed.id, divisor: 100, draft: { add: "manual" } };
  await reviewedRuntime.startSingleSave({ preventDefault() {} });
  assert.equal(reviewedRuntime.state.images[0].reviewed, true, "single save keeps an already reviewed image reviewed");
}

function runOutputDirectoryDisplayCase() {
  const runtime = createRuntime({ commit: () => jsonResponse({}) });
  runtime.state.outputDirectoryHandle = null;
  runtime.renderOutputDirectory();
  assert.equal(runtime.element("#applyOutputDirectoryStatus").value, "Save location: not selected", "a configured path is not presented as an available browser save destination");
  assert.equal(runtime.element("#singleSaveOutputDirectoryStatus").textContent, "Save location: not selected", "single save describes an absent directory handle as unselected");
}

async function runSuccessCase() {
    let copyCompletedWhenCommitted = false;
  const runtime = createRuntime({
    renderBinary: () => binaryResponse([4, 5, 6], "runtime-render-token", () => { copyCompletedWhenCommitted = true; }),
    commit: () => {
      assert.equal(copyCompletedWhenCommitted, true, "commit runs after the copied output is saved");
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });
  // Project state must not put an additional workspace flush, source-handle
  // lookup, or catalog re-render inside the per-image batch-save loop.
  runtime.state.project = { id: "project-save-runtime", status: "working" };
  await runtime.runBrowserSave(["image-1"], "_censored", false);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
  const commitPayload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(commitPayload.saveToken, "runtime-render-token");
  assert.equal(commitPayload.deleteOriginal, false);
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

async function runCopyFailureCase() {
  let removed = false;
  const runtime = createRuntime({ deleteOriginal: true, renderBinary: () => jsonResponse({ error: "disk full" }, 500), commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
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
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render"]);
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
  let file = {
    name: "source.png", size: 3, lastModified: 1,
    async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; },
  };
  const fileHandle = {
    name: file.name,
    async getFile() { return file; },
    async createWritable() {
      return {
        async write(bytes) { result.restored = true; file = { ...file, size: bytes.byteLength, lastModified: 2, async arrayBuffer() { return bytes.buffer; } }; },
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
  assert.deepEqual(pendingSource, { deleted: true, restored: true }, "a pending failed copy restores its source after cancellation");

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
  assert.deepEqual(committedSource, { deleted: true, restored: false }, "a committed save keeps its deliberate source deletion");

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
  assert.deepEqual(unknownSource, { deleted: true, restored: false }, "unknown state leaves the source untouched for manual recovery");
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
    renderBinary: () => binaryResponse([4, 5, 6], "runtime-render-token", () => { runtime.state.browserSave.cancelled = true; }),
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(["image-1"], "_censored", false, "copy");

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
  assert.equal(runtime.elements.get("#applyResult").textContent, "cancelled 1");
}

async function runDeleteOriginalCase() {
    const runtime = createRuntime({
    deleteOriginal: true,
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(["image-1"], "_censored", true);

  const payload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(payload.deleteOriginal, true);
  assert.equal(payload.saveToken, "runtime-render-token");
  assert.equal(payload.sourceAction, "deleted");
}

async function runHandleOverwriteCase() {
    let written = null;
  const sourceFile = { name: "source.png", size: 12, lastModified: 34 };
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
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "overwrite");
}

async function runHandleOverwriteChangedDuringRenderCase() {
  let writes = 0;
  let sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      writes += 1;
      return { async write() {}, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({
    renderBinary: () => binaryResponse([4, 5, 6], "runtime-render-token", () => {
      sourceFile = { ...sourceFile, size: 13, lastModified: 35 };
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
  let sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  let writes = 0;
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return {
        async write() {},
        async close() { writes += 1; sourceFile = { name: "source.png", size: 3, lastModified: 34 + writes }; },
        async abort() {},
      };
    },
  };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({ cleared: false, stale: false, images: [image] }) });
  const access = { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified };
  runtime.state.sourceAccess.set(image.id, access);

  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.equal(writes, 2);
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
}

async function runHandleDeleteAfterCopyCase() {
    let removed = false;
  const sourceHandle = { name: "source.png", async getFile() { return { name: "source.png", size: 1, lastModified: 1, async arrayBuffer() { return Uint8Array.from([1]).buffer; } }; } };
  const parentHandle = { async removeEntry(name) { assert.equal(name, "source.png"); removed = true; }, async getFileHandle() { return sourceHandle; } };
  const runtime = createRuntime({ deleteOriginal: true, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, parentHandle, name: sourceHandle.name, size: 1, lastModified: 1 });
  await runtime.runBrowserSave(["image-1"], "_censored", true);
  assert.equal(removed, true, "the source handle is removed only after the copy has been written");
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "deleted");
}

async function runQueuedHandleChangeCases() {
  const first = { id: "image-1", sourceKind: "session", relativePath: "first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", sourceKind: "session", relativePath: "second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  for (const mode of ["overwrite", "copy"]) {
    let secondFile = { name: "second.png", size: 12, lastModified: 34 };
    let secondAction = false;
    const firstHandle = {
      async getFile() { return { name: "first.png", size: 12, lastModified: 34 }; },
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
  runtime = createRuntime({
    initialImages: [original],
    commit: () => {
      runtime.state.catalogEpoch += 1;
      runtime.state.images = [local];
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });
  await runtime.runBrowserSave([original.id], "_censored", false, "copy");
  assert.deepEqual(runtime.state.images, [local], "a newer catalog epoch rejects the final save snapshot");
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
  runtime.state.reviewedPaths = new Set([first.relativePath, second.relativePath]);
  runtime.state.hiddenPaths = new Set([second.relativePath]);

  assert.deepEqual(Array.from(runtime.saveTargets()), [first.id, second.id], "the normal batch target is every image in the list");
  await runtime.runBrowserSave([first.id, second.id], "_censored", false, "copy");
  await runtime.runBrowserSave([first.id, second.id], "_censored", false, "copy");

  assert.deepEqual(runtime.state.images, [first, second], "two consecutive saves keep every catalogue image");
  assert.equal(runtime.state.drafts.get(first.id).add, "manual", "saving retains manual masks");
  assert.equal(runtime.state.drafts.get(first.id).exclusion, "exclude", "saving retains exclusions");
  assert.equal(runtime.state.candidates.length, 1, "saving retains current candidates");
  assert.deepEqual(Array.from(runtime.state.reviewedPaths), [first.relativePath, second.relativePath], "saving does not change reviewed state");
  assert.deepEqual(Array.from(runtime.state.hiddenPaths), [second.relativePath], "saving does not change hidden state");
  assert.equal(runtime.requests.some((request) => request.path === "/api/catalog/remove"), false, "saving never removes list entries");
}

(async () => {
  await runOutputDirectoryPermissionCases();
  await runSingleCopyKeepsEditorStateCase();
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
  await runHandleOverwriteChangedDuringRenderCase();
  await runRepeatedHandleOverwriteCase();
  await runHandleDeleteAfterCopyCase();
  await runQueuedHandleChangeCases();
  await runCatalogEpochGuardCase();
  await runSaveKeepsCatalogueAndEditorStateCase();
  await runExclusiveWritableCases();
  await runPartialOutputCleanupCases();
  await runConcurrentOutputLockCases();
  await runBrowserCopyPoolAndWriteOverlapCases();
  await runBrowserCopyMemoryBudgetCase();
  await runBrowserCopyPoolAtScaleCases();
  await runBrowserCopyWriteFailureCancelsRenderCase();
  await runBrowserHandleSnapshotSerializationCase();
  await runBrowserHandleOverwritePoolAtScaleCase();
  await runSingleSaveKeepsReviewAndDraftCase();
  runOutputDirectoryDisplayCase();
  console.log("test_browser_save_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
