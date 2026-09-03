const assert = require("node:assert/strict");
const { controls: uiControlManifest, dynamicControls: uiDynamicControlManifest } = require("./ui-control-manifest.cjs");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64");
const browserCoverage = process.env.MOZARIE_JS_COVERAGE === "1" ? [] : null;

async function newCoveredPage(browser, options) {
  const page = await browser.newPage(options);
  if (browserCoverage) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    browserCoverage.push({ page, entries: null });
  }
  return page;
}

async function stopCoveredPage(page, close = false) {
  const covered = browserCoverage?.find((item) => item.page === page);
  if (covered && !covered.entries) covered.entries = await page.coverage.stopJSCoverage();
  if (close) await page.close();
}

async function writeBrowserCoverage() {
  if (!browserCoverage || !process.env.MOZARIE_BROWSER_COVERAGE_FILE) return;
  await Promise.all(browserCoverage.map(({ page }) => stopCoveredPage(page)));
  await fs.writeFile(process.env.MOZARIE_BROWSER_COVERAGE_FILE, JSON.stringify(browserCoverage.flatMap(({ entries }) => entries || [])));
}

// Kept outside the browser fixture so the negative case is a real unit test:
// a no-op/failed catalog-clear handler cannot satisfy the same predicate that
// the ledger uses after a confirmed clear.
function assertCatalogClearResult(before, after) {
  assert.ok(before.api.some((request) => request.url.includes("/api/catalog/clear")), "catalog clear must send its API request");
  assert.deepEqual(after.imageIds, [], "catalog clear must remove every catalog image");
}
assert.throws(
  () => assertCatalogClearResult({ api: [{ url: "/api/catalog/clear" }] }, { imageIds: ["sample"] }),
  /remove every catalog image/,
  "mutation guard: a no-op catalog-clear handler must fail the ledger predicate",
);

async function dialogPointerPoints(page, selector) {
  return page.locator(selector).evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return {
      inside: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      outside: { x: Math.max(2, rect.left - 12), y: rect.top + Math.min(20, rect.height / 2) },
    };
  });
}

async function pointerGesture(page, start, end = start) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
}

function startFixtureServer() {
  const detectRequests = [];
  const applyRequests = [];
  const settingsRequests = [];
  const settingsActions = [];
  const settingsStatusRequests = [];
  const updateRequests = [];
  const modelPickerRequests = [];
  const modelDownloadRequests = [];
  let modelDownloadJobs = 0;
  let modelDownloadPolls = 0;
  let modelDownloadJob = { state: "idle", paths: {} };
  let failModelDownloadStatus = false;
  let cancelRequests = 0;
  let holdDetection = false;
  let cancelShouldFail = false;
  const pendingFullSettings = [];
  const pendingUpdateStatus = [];
  let deferFullSettings = false;
  let deferUpdateStatus = false;
  let failNextSettingsSave = false;
  let updateAvailable = false;
  let currentJob = { kind: "idle", state: "idle" };
  let nextSaveToken = 1;
  const saveTokens = new Map();
  const saveRequests = [];
  let holdSaveRender = false;
  const pendingSaveRenders = [];
  const catalogRemoveRequests = [];
  const folderRequests = [];
  const initialCatalog = [
    { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", sourcePath: "G:\\画像 フォルダー\\sample image.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "sample-two", relativePath: "sample-two.png", sourceKind: "session", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  let catalog = structuredClone(initialCatalog);
  let settings = {
    general: { language: "ja", open_browser: false, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "", ntd11: "", ntd11_enabled: false, sensitive: "", sensitive_enabled: false, hand_detection: "", hand_detection_enabled: false, sam_checkpoints: { vit_b: "", vit_l: "", vit_h: "" }, sam_model_type: "vit_b", provider: "gpu", gpu_device: 0 },
    display: { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78, mosaic_preview: true, tool_position: "left" },
    importing: { parallelism: 3 }, editing: { fill_color_tolerance: 20 }, saving: { parallelism: 2 },
    detection: { mode: "standard", fluid_exclusion_enabled: true, exclude_forced_default: true, threshold: 0.5, parallelism: 2, targets: ["penis", "pussy"] },
    shortcuts: {
      enabled: true,
      bindings: { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", reviewAndNext: "Enter", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" },
      actions: {},
    }, confirmations: {},
  };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    if (requestPath === "/api/settings/reset" && request.method === "POST") {
      settingsActions.push({ path: requestPath, method: request.method });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ settings, version: "v1.0.0" }));
      return;
    }
    if (requestPath === "/api/settings") {
      settingsRequests.push(requestUrl.search);
      if (request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        const submitted = JSON.parse(body);
        // The product accepts a focused settings patch for the output-folder
        // picker as well as a complete settings form submission.
        const submittedSettings = {
          ...settings,
          ...submitted,
          general: { ...settings.general, ...(submitted.general || {}) },
          models: { ...settings.models, ...(submitted.models || {}) },
          display: { ...settings.display, ...(submitted.display || {}) },
          importing: { ...settings.importing, ...(submitted.importing || {}) },
          editing: { ...settings.editing, ...(submitted.editing || {}) },
          saving: { ...settings.saving, ...(submitted.saving || {}) },
          detection: { ...settings.detection, ...(submitted.detection || {}) },
          shortcuts: { ...settings.shortcuts, ...(submitted.shortcuts || {}) },
          confirmations: { ...settings.confirmations, ...(submitted.confirmations || {}) },
        };
        if (failNextSettingsSave) {
          failNextSettingsSave = false;
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error_code: "internal_error" }));
          return;
        }
        if (submittedSettings.models.target_segmentation === "no-gpu.onnx" && submittedSettings.models.provider === "gpu") {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error_code: "gpu_unsupported" }));
          return;
        }
        settings = submittedSettings;
        settingsActions.push({ path: requestPath, method: request.method });
      }
      const reply = () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ settings, version: "v1.0.0", status: { models: {}, gpus: [] } })); };
      if (!requestUrl.search && deferFullSettings) { await new Promise((resolve) => { pendingFullSettings.push(() => { reply(); resolve(); }); }); return; }
      reply();
      return;
    }
    if (requestPath === "/api/settings/status" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const submittedSettings = JSON.parse(body);
      settingsStatusRequests.push(submittedSettings);
      const reply = () => {
        const targetPath = submittedSettings.models.target_segmentation;
        const gpus = targetPath === "no-gpu.onnx" ? [] : targetPath === "gpu-options.onnx"
          ? [{ id: 3, name: "RTX Test", totalMemory: 16 * 1024 ** 3, supported: true }, { id: 4, name: "Legacy Test", totalMemory: 3 * 1024 ** 3, supported: false }]
          : targetPath === "unknown-vram.onnx"
            ? [{ id: 5, name: "Unknown VRAM", supported: true }]
            : [{ id: settingsStatusRequests.length, name: targetPath || "default", totalMemory: 16 * 1024 ** 3 }];
        const paths = submittedSettings.models.sam_checkpoints || {};
        const samVariants = Object.fromEntries(["vit_b", "vit_l", "vit_h"].map((key) => [key, {
          path: paths[key] || "", configured: Boolean(paths[key]), exists: Boolean(paths[key]), valid: Boolean(paths[key]), managed: String(paths[key] || "").includes("Mozarie\\models"), reasonCode: paths[key] ? null : "not_configured",
        }]));
        // Match the real settings-status contract: CUDA devices inherit their
        // backend label from the enclosing runtime status rather than each GPU.
        const status = { models: {}, gpus, runtimeBackend: "cuda" };
        if (targetPath !== "legacy-sam-status.onnx") status.samVariants = samVariants;
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status }));
      };
      if (deferFullSettings) { await new Promise((resolve) => { pendingFullSettings.push(() => { reply(); resolve(); }); }); return; }
      reply();
      return;
    }
    if (requestPath === "/api/images") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        images: catalog,
        root: "G:/fixture",
      }));
      return;
    }
    // Folder imports preflight existing project sources before posting the
    // selected path.  This fixture has no persisted projects, so it must
    // explicitly answer the read route rather than turning a normal import
    // into a spurious project-list error.
    if (requestPath === "/api/projects" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ projects: [] }));
      return;
    }
    if (requestPath === "/api/project/mismatches" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ images: [] }));
      return;
    }
    if (requestPath === "/api/folder" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      folderRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ images: catalog, root: folderRequests.at(-1).path }));
      return;
    }
    // Folder selection now begins explicit unnamed project work.  Keep this
    // browser fixture aligned with the real project contract so the picker
    // flow does not surface a spurious error dialog.
    if (requestPath === "/api/projects" && request.method === "POST") {
      for await (const _chunk of request) { /* consume project payload */ }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ project: { id: "fixture-project", name: null, status: "working", imageCount: catalog.length } }));
      return;
    }
    if (requestPath === "/api/output-directory/pick" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ path: "G:\\fixture-output" }));
      return;
    }
    if (requestPath === "/api/catalog/remove" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const { imageIds = [] } = JSON.parse(body);
      catalogRemoveRequests.push(imageIds);
      const removedImageIds = catalog.filter((image) => imageIds.includes(image.id)).map((image) => image.id);
      catalog = catalog.filter((image) => !imageIds.includes(image.id));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ images: catalog, removedImageIds }));
      return;
    }
    if (requestPath.startsWith("/api/catalog/image/") && request.method === "DELETE") {
      const imageId = decodeURIComponent(requestPath.slice("/api/catalog/image/".length));
      const removedImageIds = catalog.some((image) => image.id === imageId) ? [imageId] : [];
      const images = catalog.filter((image) => image.id !== imageId);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ images, removedImageIds }));
      return;
    }
    if (requestPath === "/api/save/prepare" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); saveRequests.push({ path: requestPath, payload });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ entries: payload.imageIds.map((imageId) => ({ imageId, candidateRevision: 0, relativePath: catalog.find((image) => image.id === imageId)?.relativePath || imageId })) }));
      return;
    }
    if (requestPath === "/api/save/render" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); const saveToken = `save-${nextSaveToken++}`;
      saveTokens.set(saveToken, { state: "pending", imageId: payload.imageId }); saveRequests.push({ path: requestPath, payload });
      if (holdSaveRender) await new Promise((resolve) => { pendingSaveRenders.push(resolve); });
      if (payload.copyToDefault) {
        response.writeHead(200, { "Content-Type": "application/json", "X-Mozarie-Save-Token": saveToken });
        response.end(JSON.stringify({ saveToken }));
      } else {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": onePixelPng.length, "X-Mozarie-Save-Token": saveToken });
        response.end(onePixelPng);
      }
      return;
    }
    if (requestPath === "/api/save/commit" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); const token = saveTokens.get(payload.saveToken);
      if (!token || token.imageId !== payload.imageId) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error_code: "invalid_save_token" })); return; }
      token.state = "committed"; saveRequests.push({ path: requestPath, payload });
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ cleared: true, stale: false }));
      return;
    }
    if (requestPath === "/api/save/status" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); const token = saveTokens.get(payload.saveToken);
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ state: token?.state || "unknown", cleared: token?.state === "committed", stale: false }));
      return;
    }
    if (requestPath === "/api/save/cancel" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); const token = saveTokens.get(payload.saveToken); if (token) token.state = "cancelled";
      saveRequests.push({ path: requestPath, payload });
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/catalog/clear" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/masks/clear" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/workspace/catalog" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ catalogId: "fixture-catalog", provisional: true, workspace: true }));
      return;
    }
    if (requestPath === "/api/workspace/catalog/finalize" && request.method === "POST") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ catalogId: "fixture-catalog", imageIds: {}, images: [], workspace: true }));
      return;
    }
    if (requestPath.startsWith("/api/project/history/")) {
      for await (const _chunk of request) { /* consume an optional undo request */ }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ canUndo: false, canRedo: false, changedImageIds: [] }));
      return;
    }
    if (requestPath.startsWith("/api/workspace/image/") && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const flags = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(flags));
      return;
    }
    if (requestPath === "/api/job") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(currentJob));
      return;
    }
    if (requestPath === "/api/update/status") {
      updateRequests.push(requestUrl.search);
      const reply = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ current: "v1.0.0", latest: updateAvailable ? "v1.0.1" : "v1.0.0", available: updateAvailable }));
      };
      if (deferUpdateStatus) {
        await new Promise((resolve) => { pendingUpdateStatus.push(() => { reply(); resolve(); }); });
        return;
      }
      reply();
      return;
    }
    if (requestPath === "/api/model-file/pick" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      modelPickerRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(modelPickerRequests.length === 1 ? { path: "C:\\models\\sam_vit_l_0b3195.pth" } : { cancelled: true }));
      return;
    }
    if (requestPath === "/api/model-download" && request.method === "GET") {
      modelDownloadPolls += 1;
      if (failModelDownloadStatus) {
        response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "fixture status unavailable" }));
        return;
      }
      if (modelDownloadJob.state === "running") {
        const samPath = `C:\\Mozarie\\models\\sam_${modelDownloadJob.samType === "vit_l" ? "vit_l_0b3195" : modelDownloadJob.samType === "vit_h" ? "vit_h_4b8939" : "vit_b_01ec64"}.pth`;
        const paths = modelDownloadJob.key === "all"
          ? { [`sam_${modelDownloadJob.samType}`]: samPath, hand_detection: "C:\\Mozarie\\models\\ultralytics\\anime-hand-v1.0-s.onnx", hand_segmentation: "C:\\Mozarie\\models\\handsegnet\\handsegnet_vit_b_best.safetensors" }
          : { [modelDownloadJob.key]: modelDownloadJob.key.startsWith("sam_") ? samPath : "C:\\Mozarie\\models\\ultralytics\\anime-hand-v1.0-s.onnx" };
        modelDownloadJob = { ...modelDownloadJob, state: "complete", current: "", completed: modelDownloadJob.total, received: modelDownloadJob.expected, paths };
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/model-download/start" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); modelDownloadRequests.push(payload);
      if (payload.modelKey === "hand_detection") {
        modelDownloadJob = { state: "failed", paths: {}, error: "fixture download failed" };
      } else if (modelDownloadJob.state !== "running") {
        modelDownloadJobs += 1;
        modelDownloadJob = { state: "running", key: payload.modelKey, samType: payload.samType, total: payload.modelKey === "all" ? 3 : 1, completed: 0, current: payload.modelKey === "all" ? `sam_${payload.samType}` : payload.modelKey, received: 1, expected: 10, paths: {} };
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/model-download/cancel" && request.method === "POST") {
      modelDownloadJob = { ...modelDownloadJob, state: "cancelled", current: "" };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/job/cancel" && request.method === "POST") {
      cancelRequests += 1;
      if (cancelShouldFail) { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "cancel failed" })); return; }
      // The detection worker keeps its in-flight image until it has observed
      // the request. Saving remains terminal in this fixture so its dedicated
      // save-control test can close the completed dialog normally.
      currentJob = currentJob.kind === "detect"
        ? { ...currentJob, state: "running", cancelRequested: true }
        : { ...currentJob, state: "cancelled", current: "" };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(currentJob));
      return;
    }
    if ((requestPath === "/api/job/pause" || requestPath === "/api/job/resume") && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      currentJob = { ...currentJob, state: requestPath.endsWith("pause") ? "paused" : "running" };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(currentJob));
      return;
    }
    if (requestPath === "/api/detect" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      detectRequests.push(JSON.parse(body));
      const imageIds = detectRequests.at(-1).imageIds;
      currentJob = holdDetection
        ? { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "sample.png", startedAt: Date.now() / 1000, imageIds, completedImageIds: [] }
        : { kind: "detect", state: "complete", total: imageIds.length, completed: imageIds.length, current: "", startedAt: Date.now() / 1000, imageIds, completedImageIds: imageIds };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/apply" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const apply = JSON.parse(body);
      applyRequests.push(apply);
      currentJob = {
        kind: "apply", state: "running", total: apply.imageIds.length, completed: 0, current: "sample.png",
        startedAt: Date.now() / 1000, imageIds: apply.imageIds, completedImageIds: [],
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/boundary" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const boundary = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ candidates: [{ id: `boundary-${Date.now()}`, role: "apply", enabled: true, forced: false, labelToken: "boundary", source: "boundary", refinement: null, confidence: 1, color: "#ff3d4d" }], candidateRevision: 1, boundary }));
      return;
    }
    if (requestPath.startsWith("/api/workspace/manual/")) {
      for await (const _chunk of request) { /* consume POST body */ }
      response.writeHead(200, { "Content-Type": "application/json" });
      // Deliberately lacks history: selected in-session drafts must win over
      // this compact server record when returning to an image.
      response.end(JSON.stringify({ draft: { add: "", exclusion: "", exclusionErase: "", candidateRevision: 0 } }));
      return;
    }
    if (requestPath.startsWith("/api/candidates/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ candidates: [], candidateRevision: 0 }));
      return;
    }
    if (requestPath.startsWith("/api/image/")) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": onePixelPng.length });
      response.end(onePixelPng);
      return;
    }
    if (requestPath.startsWith("/api/thumbnail/")) {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }

    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(staticRoot, relativePath);
    if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, detectRequests, applyRequests, saveRequests, catalogRemoveRequests, folderRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs: () => modelDownloadJobs, modelDownloadPolls: () => modelDownloadPolls, cancelRequests: () => cancelRequests, holdDetection: (value) => { holdDetection = value; }, holdSaveRender: (value) => { holdSaveRender = value; }, releaseSaveRenders: () => { holdSaveRender = false; pendingSaveRenders.splice(0).forEach((resume) => resume()); }, failCancel: (value) => { cancelShouldFail = value; }, failNextSettingsSave: () => { failNextSettingsSave = true; }, failModelDownloadStatus: (value) => { failModelDownloadStatus = value; }, resetModelDownload: () => { modelDownloadJob = { state: "idle", paths: {} }; }, resetScenario: () => { catalog = structuredClone(initialCatalog); saveTokens.clear(); saveRequests.length = 0; catalogRemoveRequests.length = 0; folderRequests.length = 0; currentJob = { kind: "idle", state: "idle" }; }, setCatalog: (images) => { catalog = structuredClone(images); }, resetJob: () => { currentJob = { kind: "idle", state: "idle" }; }, finishCancel: () => { currentJob = { ...currentJob, state: "cancelled", current: "" }; }, finishApply: () => { currentJob = { ...currentJob, state: "complete", completed: currentJob.total, current: "", completedImageIds: currentJob.imageIds }; }, setUpdateAvailable: (value) => { updateAvailable = value; }, deferFullSettings: () => { deferFullSettings = true; }, releaseNextFullSettings: () => { pendingFullSettings.shift()?.(); }, releaseFullSettings: () => { deferFullSettings = false; pendingFullSettings.splice(0).forEach((reply) => reply()); }, deferUpdateStatus: () => { deferUpdateStatus = true; }, releaseUpdateStatus: () => { deferUpdateStatus = false; pendingUpdateStatus.splice(0).forEach((reply) => reply()); } });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// This fixture deliberately owns a single candidate image.  Keeping it apart
// from the control ledger means the candidate row, its decoded mask, and its
// blink interval are created by the same public image-selection flow a user
// takes, rather than by replacing page state in a shared browser page.
function startCandidateScenarioServer(expanded = false) {
  const imageId = "candidate-scenario";
  const candidateId = "candidate-blink-apply";
  const imagePath = path.join(staticRoot, "logo.png");
  const settings = {
    general: { language: "ja", open_browser: false, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "", ntd11: "", ntd11_enabled: false, sensitive: "", sensitive_enabled: false, hand_detection: "", hand_detection_enabled: false, sam_checkpoints: { vit_b: "", vit_l: "", vit_h: "" }, sam_model_type: "vit_b", provider: "cpu", gpu_device: 0 },
    display: { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78, mosaic_preview: true },
    importing: { parallelism: 1 }, editing: { fill_color_tolerance: 20 }, saving: { parallelism: 1 },
    detection: { mode: "standard", fluid_exclusion_enabled: true, exclude_forced_default: true, threshold: 0.5, parallelism: 1, targets: ["penis"] },
    shortcuts: { enabled: true, bindings: {}, actions: {} }, confirmations: expanded ? { candidateDelete: true } : {},
  };
  const image = { id: imageId, relativePath: "candidate.png", sourceKind: "fixture", width: 409, height: 401, candidateCount: expanded ? 2 : 1, enabledCandidateCount: 1, candidateRevision: 7 };
  let candidateRevision = 7;
  const candidates = [
    { id: candidateId, role: "apply", enabled: true, forced: false, labelToken: "penis", source: "target", refinement: null, confidence: 0.91, color: "#ff3d4d" },
    ...(expanded ? [{ id: "candidate-blink-exclude", role: "exclude", enabled: true, forced: true, labelToken: "hand", source: "hand_exclusion", refinement: null, confidence: 0.88, color: "#28d3ff" }] : []),
  ];
  const candidateUpdates = [];
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    const json = (body) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (requestPath === "/api/settings") { json({ settings, version: "v1.0.0", status: { models: {}, gpus: [] } }); return; }
    if (requestPath === "/api/images") { json({ images: [image], root: "G:/candidate-fixture" }); return; }
    if (requestPath === "/api/job") { json({ kind: "idle", state: "idle" }); return; }
    if (requestPath === "/api/update/status") { json({ current: "v1.0.0", latest: "v1.0.0", available: false }); return; }
    if (requestPath === `/api/workspace/manual/${imageId}`) { json({ draft: { add: "", exclusion: "", exclusionErase: "", candidateRevision: 7 } }); return; }
    if (requestPath === `/api/workspace/image/${imageId}` && request.method === "POST") {
      for await (const _chunk of request) { /* consume workspace flags */ }
      json({}); return;
    }
    if (requestPath === `/api/candidates/${imageId}`) { json({ candidates, candidateRevision }); return; }
    if (requestPath.startsWith(`/api/candidate/${imageId}/`) && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const candidate = candidates.find((item) => item.id === decodeURIComponent(requestPath.slice(`/api/candidate/${imageId}/`.length)));
      const update = JSON.parse(body);
      if (!candidate) { response.writeHead(404).end(); return; }
      candidate.enabled = Boolean(update.enabled);
      if (candidate.role === "exclude") candidate.forced = Boolean(update.forced);
      candidateUpdates.push({ id: candidate.id, update });
      candidateRevision += 1; image.candidateRevision = candidateRevision;
      image.enabledCandidateCount = candidates.filter((item) => item.role === "apply" && item.enabled).length;
      json({ candidateRevision }); return;
    }
    if (requestPath === "/api/candidates/batch" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const update = JSON.parse(body);
      candidates.filter((candidate) => candidate.role === update.role).forEach((candidate) => { candidate.enabled = update.operation === "enable"; });
      candidateUpdates.push({ batch: update });
      candidateRevision += 1; image.candidateRevision = candidateRevision;
      image.enabledCandidateCount = candidates.filter((item) => item.role === "apply" && item.enabled).length;
      json({ candidateRevision }); return;
    }
    if (requestPath.startsWith(`/api/mask/${imageId}/`) || requestPath === `/api/image/${imageId}` || requestPath === `/api/thumbnail/${imageId}`) {
      const body = await fs.readFile(imagePath);
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length }); response.end(body); return;
    }
    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(staticRoot, relativePath);
    if (!filePath.startsWith(`${staticRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" }); response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, imageId, candidateId, candidateUpdates });
    });
  });
}

async function runCandidateBlinkScenario(browser, expanded = false) {
  const scenario = await startCandidateScenarioServer(expanded);
  const page = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
  try {
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 200) window.__candidateBlinkTick = callback;
        return setInterval(callback, delay, ...args);
      };
    });
    await page.goto(scenario.url, { waitUntil: "networkidle" });
    await page.locator(`.gallery-item[data-id="${scenario.imageId}"]`).click();
    const row = page.locator(`[data-candidate-blink-id="${scenario.candidateId}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute("data-candidate-blink-role"), "apply", "the candidate fixture renders its concrete apply row");
    for (const [locale, label, toggle] of [["ja", "penis", "penisを使用"], ["en", "Penis", "Enable Penis"]]) {
      await page.evaluate((language) => loadTranslations(language), locale);
      assert.equal(await row.locator(".candidate-class").textContent(), label, `the candidate label is localized in ${locale}`);
      assert.equal(await row.locator(".candidate-toggle").getAttribute("aria-label"), toggle, `the candidate toggle names the same localized candidate in ${locale}`);
      assert.ok((await row.locator(".candidate-delete").getAttribute("aria-label")).includes(label), `the candidate delete control names the same localized candidate in ${locale}`);
    }
    await page.evaluate(() => loadTranslations("ja"));

    const candidateLabelPresentation = await page.evaluate(async () => {
      const candidates = state.candidates;
      const manual = {
        maskPresent: state.manualMaskPresent, enabled: state.manualEnabled,
        exclusionEnabled: state.manualExclusionEnabled, exclusionEraseEnabled: state.manualExclusionEraseEnabled,
        exclusionForced: state.manualExclusionForced,
      };
      const layers = [addCtx, exclusionCtx, exclusionEraseCtx].map((context) => context.getImageData(0, 0, context.canvas.width, context.canvas.height));
      const metadataCandidates = [
        { id: "metadata-penis", labelToken: "penis", source: "target", refinement: "sam_high_precision", role: "apply", origin: "basic-model-penis" },
        { id: "metadata-pussy", labelToken: "pussy", source: "auto", refinement: "sam_fallback", role: "apply", origin: "automatic-pussy" },
        { id: "metadata-testicles", labelToken: "testicles", source: "ntd11", refinement: "sam_high_precision", role: "apply", origin: "ntd11-testicles" },
        { id: "metadata-boundary", labelToken: "boundary", source: "boundary", refinement: "sam_fallback", role: "apply", origin: "boundary-origin" },
        { id: "metadata-polygon", labelToken: "boundary_polygon", source: "boundary", refinement: "sam_high_precision", role: "apply", origin: "polygon-origin" },
        { id: "metadata-hand", labelToken: "hand", source: "hand_exclusion", refinement: "sam_fallback", role: "exclude", origin: "hand-exclusion-origin" },
        { id: "metadata-fluid", labelToken: "fluid", source: "fluid_exclusion", refinement: "sam_high_precision", role: "exclude", origin: "fluid-exclusion-origin" },
      ].map((candidate) => ({ ...candidate, enabled: true, forced: candidate.role === "exclude", confidence: .9, color: "#fff" }));
      const snapshot = () => ({
        automatic: metadataCandidates.map((candidate) => {
          const row = document.querySelector(`[data-candidate-blink-id="${candidate.id}"]`);
          return {
            label: row?.querySelector(".candidate-class")?.textContent,
            role: row?.dataset.candidateBlinkRole,
            names: [row?.querySelector(".candidate-toggle")?.getAttribute("aria-label"), row?.querySelector(".candidate-delete")?.getAttribute("aria-label")],
            text: row?.textContent,
          };
        }),
        manual: [".candidate-row-manual-apply", ".candidate-row-manual-exclude", ".candidate-row-manual-exclude-erase"].map((selector) => {
          const row = document.querySelector(selector);
          return {
            label: row?.querySelector(".candidate-label")?.textContent,
            role: row?.dataset.candidateBlinkRole,
            names: [row?.querySelector(".candidate-toggle")?.getAttribute("aria-label"), row?.querySelector(".candidate-delete")?.getAttribute("aria-label")],
          };
        }),
        sections: [...document.querySelectorAll(".candidate-section h3")].map((heading) => heading.textContent),
      });
      state.candidates = metadataCandidates;
      state.manualMaskPresent = true; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true; state.manualExclusionForced = true;
      addCtx.fillRect(0, 0, 1, 1); exclusionCtx.fillRect(0, 0, 1, 1); exclusionEraseCtx.fillRect(0, 0, 1, 1);
      renderCandidates();
      const ja = snapshot();
      await loadTranslations("en");
      const en = snapshot();
      await loadTranslations("ja");
      state.candidates = candidates;
      state.manualMaskPresent = manual.maskPresent; state.manualEnabled = manual.enabled;
      state.manualExclusionEnabled = manual.exclusionEnabled; state.manualExclusionEraseEnabled = manual.exclusionEraseEnabled; state.manualExclusionForced = manual.exclusionForced;
      [addCtx, exclusionCtx, exclusionEraseCtx].forEach((context, index) => context.putImageData(layers[index], 0, 0));
      renderCandidates();
      return { ja, en };
    });
    assert.deepEqual(candidateLabelPresentation.ja.automatic.map((row) => row.label), ["penis", "pussy", "testicles", "境界", "4点境界", "手", "白い液"], "real Chromium candidate rows show only their localized class labels");
    assert.deepEqual(candidateLabelPresentation.en.automatic.map((row) => row.label), ["Penis", "Vulva", "Testicles", "Boundary", "Four-point boundary", "Hand", "Fluid"], "real Chromium candidate labels localize every supported token");
    for (const locale of ["ja", "en"]) {
      for (const row of candidateLabelPresentation[locale].automatic) {
        assert.ok(row.names.every((name) => name.includes(row.label)), `candidate actions retain their localized visible label in ${locale}`);
      }
      const presentedText = candidateLabelPresentation[locale].automatic.flatMap((row) => [row.text, ...row.names]).join("\n");
      for (const metadata of ["target", "ntd11", "hand_exclusion", "fluid_exclusion", "sam_fallback", "sam_high_precision", "basic-model-penis", "automatic-pussy", "ntd11-testicles", "polygon-origin", "hand-exclusion-origin", "fluid-exclusion-origin", "apply", "exclude"]) {
        assert.equal(presentedText.includes(metadata), false, `candidate row text and action names do not leak ${metadata} in ${locale}`);
      }
    }
    assert.deepEqual(candidateLabelPresentation.ja.automatic.map((row) => row.role), ["apply", "apply", "apply", "apply", "apply", "exclude", "exclude"], "candidate row roles still choose the apply and exclusion sections");
    assert.deepEqual(candidateLabelPresentation.ja.manual.map((row) => row.label), ["手書き", "手書き", "手書き"], "all manual rows have the same role-neutral Japanese label");
    assert.deepEqual(candidateLabelPresentation.en.manual.map((row) => row.label), ["Manual", "Manual", "Manual"], "all manual rows have the same role-neutral English label");
    assert.deepEqual(candidateLabelPresentation.ja.manual.map((row) => row.role), ["apply", "exclude", "exclude"], "manual rows preserve their apply and exclusion roles");
    assert.deepEqual(candidateLabelPresentation.ja.manual.map((row) => row.names), [
      ["手書きモザイクを使用", "手書きを削除"],
      ["手描き除外を使用", "手描き除外を削除"],
      ["手描き除外削除を使用", "手描き除外削除を削除"],
    ], "manual actions retain role-specific Japanese names");
    assert.deepEqual(candidateLabelPresentation.en.sections, ["Mosaic ranges", "Exclusion ranges"], "section headings retain the apply and exclusion distinction in English");

    const sectionDisplay = page.locator('[data-candidate-display-toggle="apply"]');
    await sectionDisplay.click();
    await page.waitForFunction((id) => {
      const candidateRow = document.querySelector(`[data-candidate-blink-id="${id}"]`);
      return candidateRow?.classList.contains("blink-selected")
        && document.querySelector("#candidatePane")?.classList.contains("blink-active")
        && candidateRow.querySelector(".candidate-display-toggle")?.getAttribute("aria-pressed") === "true";
    }, scenario.candidateId);
    const blinkTickReads = await page.evaluate(() => {
      const originalHasPixels = canvasHasPixels;
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      let hasPixelsCalls = 0;
      let getImageDataCalls = 0;
      canvasHasPixels = (...args) => { hasPixelsCalls += 1; return originalHasPixels(...args); };
      CanvasRenderingContext2D.prototype.getImageData = function(...args) {
        getImageDataCalls += 1;
        return originalGetImageData.apply(this, args);
      };
      try { window.__candidateBlinkTick(); } finally {
        canvasHasPixels = originalHasPixels;
        CanvasRenderingContext2D.prototype.getImageData = originalGetImageData;
      }
      return { hasPixelsCalls, getImageDataCalls };
    });
    assert.deepEqual(blinkTickReads, { hasPixelsCalls: 0, getImageDataCalls: 0 }, "a real Chromium blink tick avoids full-resolution mask readback");
    await page.evaluate(() => window.__candidateBlinkTick());
    assert.equal(await row.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(238, 78, 78, 0.3)", "the apply section visibly highlights its selected candidate");

    await page.evaluate(() => {
      state.manualMaskPresent = true;
      addCtx.fillRect(0, 0, 2, 2); exclusionCtx.fillRect(2, 0, 2, 2); exclusionEraseCtx.fillRect(3, 0, 2, 2);
      renderCandidates();
      document.querySelector(".candidate-row-apply .candidate-class").textContent = "Long English candidate label that must stay inside the row";
    });
    for (const width of [1024, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await page.evaluate(() => [...document.querySelectorAll(".candidate-row")].map((node) => ({ className: node.className, children: node.children.length, grid: getComputedStyle(node).gridTemplateColumns, overflow: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight, hit: [...node.querySelectorAll("button")].every((button) => { const rect = button.getBoundingClientRect(); const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return button === target || button.contains(target); }) })));
      const apply = rows.find((item) => item.className.includes("candidate-row-manual-apply"));
      const exclude = rows.find((item) => item.className.includes("candidate-row-manual-exclude") && !item.className.includes("erase"));
      const erase = rows.find((item) => item.className.includes("candidate-row-manual-exclude-erase"));
      const detectedApply = rows.find((item) => item.className.includes("candidate-row-apply") && !item.className.includes("manual"));
      assert.deepEqual([apply?.children, exclude?.children, erase?.children], [2, 2, 2], `real Chromium candidate rows keep one heading and one action row at ${width}px`);
      assert.equal([detectedApply, apply, exclude, erase].every((item) => !item.overflow && item.hit), true, `real Chromium candidate rows wrap actions without overflow or lost hits at ${width}px (${JSON.stringify({ detectedApply, apply, exclude, erase })})`);
    }

    await page.locator("#brushTool").click();
    const canvas = await page.locator("#editorCanvas").boundingBox();
    assert.ok(canvas, "the candidate scenario has a real editor canvas");
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 1, canvas.y + canvas.height / 2 + 1);
    await page.mouse.up();
    const manualRow = page.locator('[data-candidate-blink-id="manual:apply"]');
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-candidate-blink-id="manual:apply"]');
      return row?.classList.contains("blink-selected")
        && row.querySelector(".candidate-display-toggle")?.getAttribute("aria-pressed") === "true";
    });
    assert.equal(await manualRow.getAttribute("data-candidate-blink-role"), "apply", "a real brush stroke adds the manual apply row to the enabled section blink");
    await manualRow.locator(".candidate-display-toggle").click();
    await page.waitForFunction(() => !document.querySelector('[data-candidate-blink-id="manual:apply"]')?.classList.contains("blink-selected"));

    const effective = row.locator(".candidate-effective-toggle");
    await effective.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => {
      const candidateRow = document.querySelector(`[data-candidate-blink-id="${id}"]`);
      return candidateRow?.querySelector(".candidate-display-toggle")?.getAttribute("aria-pressed") === "false"
        && candidateRow.querySelector(".candidate-effective-toggle")?.getAttribute("aria-pressed") === "true"
        && candidateRow.classList.contains("blink-selected");
    }, scenario.candidateId);
    assert.equal(await row.locator(".candidate-effective-toggle").getAttribute("aria-pressed"), "true", "keyboard activation switches the concrete candidate to effective display");

    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => {
      const candidateRow = document.querySelector(`[data-candidate-blink-id="${id}"]`);
      return candidateRow?.querySelector(".candidate-effective-toggle")?.getAttribute("aria-pressed") === "false"
        && !candidateRow.classList.contains("blink-selected")
        && !document.querySelector("#candidatePane")?.classList.contains("blink-active");
    }, scenario.candidateId);

    if (expanded) {
    const excludeRow = page.locator('[data-candidate-blink-id="candidate-blink-exclude"]');
    const padding = row.locator(".candidate-padding-button");
    assert.equal(await row.locator('input[type="number"]').count(), 0, "candidate rows do not reserve permanent width for a padding input");
    assert.equal(await padding.textContent(), "枠 0px", "the compact padding button includes its current value");
    await padding.click();
    const paddingPopover = page.locator("#candidatePaddingPopover");
    const paddingInput = page.locator("#candidatePaddingInput");
    assert.equal(await paddingPopover.evaluate((node) => node.matches(":popover-open")), true, "one shared padding popover opens from the candidate row");
    assert.equal(await paddingInput.evaluate((node) => document.activeElement === node), true, "opening focuses the numeric value for immediate replacement");
    const beforeInvalid = scenario.candidateUpdates.length;
    await page.locator("#candidatePaddingDecrease").click(); assert.equal(await paddingInput.inputValue(), "0", "decrease clamps at zero without persistence");
    await page.locator("#candidatePaddingIncrease").click(); assert.equal(await paddingInput.inputValue(), "1", "increase changes only the draft value");
    await page.locator("#candidatePaddingDecrease").click(); assert.equal(await paddingInput.inputValue(), "0", "decrease returns the draft value to zero");
    assert.equal(scenario.candidateUpdates.length, beforeInvalid, "step buttons do not persist before confirmation");
    const scrollBeforeArrows = await page.evaluate(() => {
      const list = document.querySelector("#candidateList"); list.style.height = "40px"; list.style.flex = "0 0 40px"; list.scrollTop = 20;
      return { list: list.scrollTop, page: scrollY };
    });
    for (let index = 0; index < 12; index += 1) await page.keyboard.press("ArrowUp");
    assert.equal(await paddingInput.inputValue(), "12", "repeated ArrowUp changes only the draft by one step per key");
    assert.deepEqual(await page.evaluate(() => ({ list: document.querySelector("#candidateList").scrollTop, page: scrollY })), scrollBeforeArrows, "padding arrow keys do not scroll the candidate list or page");
    assert.equal(scenario.candidateUpdates.length, beforeInvalid, "repeated arrow keys never commit the draft");
    await paddingInput.fill(""); await page.keyboard.press("ArrowUp"); assert.equal(await paddingInput.inputValue(), "1", "ArrowUp recovers an invalid empty value from the persisted value");
    await page.locator("#candidatePaddingReset").click();
    for (const invalid of ["0.1", "-1", "410"]) {
      await paddingInput.fill(invalid); await page.locator("#candidatePaddingConfirm").click();
      assert.equal(await paddingInput.getAttribute("aria-invalid"), "true", `padding ${invalid} is exposed as invalid`);
      assert.equal(await paddingPopover.evaluate((node) => node.matches(":popover-open")), true, "invalid padding keeps the editor open");
      assert.equal(scenario.candidateUpdates.length, beforeInvalid, "invalid padding never reaches the candidate API");
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate((id) => document.activeElement?.dataset.candidatePaddingId === id, scenario.candidateId), true, "Escape cancels and restores focus to the invoking row");
    await page.keyboard.press("Space"); assert.equal(await paddingPopover.evaluate((node) => node.matches(":popover-open")), true, "Space opens padding from the focused row button");
    await page.keyboard.press("Escape"); await page.keyboard.press("Enter"); assert.equal(await paddingPopover.evaluate((node) => node.matches(":popover-open")), true, "Enter opens padding from the focused row button");
    await paddingInput.fill("1"); await page.keyboard.press("Enter");
    await page.waitForFunction((count) => window.fetch && state.candidates.find((item) => item.id === "candidate-blink-apply")?.expandPx === 1, beforeInvalid);
    assert.equal(scenario.candidateUpdates.length, beforeInvalid + 1, "Enter commits padding exactly once");
    assert.equal(scenario.candidateUpdates.at(-1).update.expandPx, 1, "one-pixel padding is persisted in source-image pixels");
    await row.locator(".candidate-padding-button").click(); await paddingInput.fill("409");
    await page.locator("#candidatePane .inspector-heading").click();
    await page.waitForFunction(() => state.candidates.find((item) => item.id === "candidate-blink-apply")?.expandPx === 409);
    assert.equal(scenario.candidateUpdates.length, beforeInvalid + 2, "valid outside-click commits the maximum exactly once");
    await row.locator(".candidate-padding-button").click(); await page.locator("#candidatePaddingReset").click(); await page.locator("#candidatePaddingConfirm").click();
    await page.waitForFunction(() => state.candidates.find((item) => item.id === "candidate-blink-apply")?.expandPx === 0);
    assert.equal(scenario.candidateUpdates.length, beforeInvalid + 3, "reset and confirm commit zero exactly once");
    await page.evaluate(() => { state.projectReadOnly = true; renderCandidates(); });
    assert.equal(await row.locator(".candidate-padding-button").isDisabled(), true, "padding is disabled for a read-only completed project");
    await page.evaluate(() => { state.projectReadOnly = false; state.candidateBatchPending.add(state.currentId); renderCandidates(); });
    assert.equal(await row.locator(".candidate-padding-button").isDisabled(), true, "padding is disabled during a candidate batch mutation");
    await page.evaluate(() => { state.candidateBatchPending.clear(); state.importing = true; renderCandidates(); });
    assert.equal(await row.locator(".candidate-padding-button").isDisabled(), true, "padding is disabled during import");
    await page.evaluate(() => { state.importing = false; state.saving = true; renderCandidates(); });
    assert.equal(await row.locator(".candidate-padding-button").isDisabled(), true, "padding is disabled while the editor is busy");
    await page.evaluate(() => { state.saving = false; renderCandidates(); });
    await excludeRow.locator(".candidate-display-toggle").click();
    await page.waitForFunction(() => state.blinkModes.get("candidate-blink-exclude") === "normal");
    await excludeRow.locator(".candidate-effective-toggle").click();
    await page.waitForFunction(() => state.blinkModes.get("candidate-blink-exclude") === "effective");
    await row.locator(".candidate-toggle").click();
    await page.waitForFunction((id) => state.candidates.find((candidate) => candidate.id === id)?.enabled === false, scenario.candidateId);
    assert.deepEqual(scenario.candidateUpdates.at(-1), { id: scenario.candidateId, update: { enabled: false, color: "#ff3d4d" } }, "the automatic mosaic row toggle persists its explicit API state");
    await excludeRow.locator(".candidate-toggle").click();
    await page.waitForFunction(() => state.candidates.find((candidate) => candidate.id === "candidate-blink-exclude")?.enabled === false);
    assert.deepEqual(scenario.candidateUpdates.at(-1), { id: "candidate-blink-exclude", update: { enabled: false, color: "#28d3ff", forced: true } }, "the automatic exclusion row toggle persists its explicit API state");
    await excludeRow.locator(".candidate-forced").click();
    await page.waitForFunction(() => state.candidates.find((candidate) => candidate.id === "candidate-blink-exclude")?.forced === false);
    assert.deepEqual(scenario.candidateUpdates.at(-1), { id: "candidate-blink-exclude", update: { enabled: false, color: "#28d3ff", forced: false } }, "the automatic exclusion force control persists its explicit API state");

    await page.evaluate(() => {
      state.manualMaskPresent = true; state.manualEnabled = true;
      state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true; state.manualExclusionForced = true;
      addCtx.fillRect(0, 0, 3, 3); exclusionCtx.fillRect(4, 0, 3, 3); exclusionEraseCtx.fillRect(5, 0, 1, 3);
      markMaskDirty(); renderCandidates(); render();
    });
    const manualApply = page.locator('[data-candidate-blink-id="manual:apply"]');
    const manualExclude = page.locator('[data-candidate-blink-id="manual:exclude"]');
    const manualErase = page.locator('[data-candidate-blink-id="manual:excludeErase"]');
    for (const manualRowControl of [manualApply, manualExclude, manualErase]) {
      await manualRowControl.locator(".candidate-display-toggle").click();
      await manualRowControl.locator(".candidate-effective-toggle").click();
    }
    await manualApply.locator(".candidate-toggle").click();
    await page.waitForFunction(() => state.manualEnabled === false);
    await manualExclude.locator(".candidate-toggle").click();
    await page.waitForFunction(() => state.manualExclusionEnabled === false);
    await manualExclude.locator(".candidate-forced").click();
    await page.waitForFunction(() => state.manualExclusionForced === false);
    await manualErase.locator(".candidate-toggle").click();
    await page.waitForFunction(() => state.manualExclusionEraseEnabled === false);
    await manualApply.locator(".candidate-delete").click();
    await page.waitForFunction(() => !state.manualMaskPresent && !canvasHasPixels(addCtx, addCanvas));
    await manualExclude.locator(".candidate-delete").click();
    await page.waitForFunction(() => !canvasHasPixels(exclusionCtx, exclusionCanvas));
    await manualErase.locator(".candidate-delete").click();
    await page.waitForFunction(() => !canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas));

    await row.locator(".candidate-delete").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction((id) => state.removedCandidateIds.has(id) && !document.querySelector(`[data-candidate-blink-id="${id}"]`), scenario.candidateId);
    await excludeRow.locator(".candidate-delete").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.removedCandidateIds.has("candidate-blink-exclude") && !document.querySelector('[data-candidate-blink-id="candidate-blink-exclude"]'));
    assert.equal(await page.evaluate(() => { state.maskDirty = true; composeCurrentMask(); return canvasHasPixels(combinedCtx, combinedCanvas); }), false, "deleting every automatic and manual mosaic source clears the composed mask in Chromium");
    }

    const blinkPixels = await page.evaluate(async (applyId) => {
      const source = document.createElement("canvas"); source.width = 100; source.height = 80;
      source.getContext("2d").fillStyle = "#000000"; source.getContext("2d").fillRect(0, 0, 100, 80);
      const mask = (left, top, width, height) => { const item = document.createElement("canvas"); item.width = 100; item.height = 80; item.getContext("2d").fillRect(left, top, width, height); return createImageBitmap(item); };
      const record = currentRecord(); record.width = 100; record.height = 80;
      state.currentImage = await createImageBitmap(source); canvasSizeForImage(record); prepareOriginalImage();
      state.candidates = [
        { id: applyId, role: "apply", enabled: true, forced: false, labelToken: "penis" },
        { id: "candidate-blink-exclude", role: "exclude", enabled: true, forced: false, labelToken: "hand" },
      ];
      state.candidateImages = new Map([[applyId, await mask(30, 25, 30, 30)], ["candidate-blink-exclude", await mask(52, 25, 20, 30)]]);
      state.removedCandidateIds.clear(); addCtx.clearRect(0, 0, 100, 80); exclusionCtx.clearRect(0, 0, 100, 80); exclusionEraseCtx.clearRect(0, 0, 100, 80);
      state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true; state.manualMaskPresent = false;
      state.compareSplit = .5; state.displayMode = "compare"; state.mosaicPreviewEnabled = false; fitImage(); state.maskDirty = true; composeCurrentMask();
      const sample = (logicalX, logicalY, offset = 0) => {
        const x = Math.round((offset + state.view.x + logicalX * state.view.scale) * (window.devicePixelRatio || 1));
        const y = Math.round((state.view.y + logicalY * state.view.scale) * (window.devicePixelRatio || 1));
        return [...ctx.getImageData(x, y, 1, 1).data];
      };
      const right = stage.clientWidth * state.compareSplit;
      state.blinkCandidateIds = new Set([applyId, "candidate-blink-exclude"]); state.blinkModes = new Map([[applyId, "normal"], ["candidate-blink-exclude", "normal"]]); state.blinkPhase = true; flushRender();
      const colors = { left: sample(43, 40), apply: sample(43, 40, right), exclude: sample(65, 40, right) };
      const outside = [...ctx.getImageData(Math.round((right + state.view.x - 1) * (window.devicePixelRatio || 1)), Math.round((state.view.y + 1) * (window.devicePixelRatio || 1)), 1, 1).data];
      exclusionEraseCtx.fillRect(55, 35, 5, 10); exclusionEraseCtx.fillRect(80, 35, 5, 10); state.maskDirty = true; composeCurrentMask();
      const cacheBefore = [...effectiveExclusionCtx.getImageData(0, 0, 100, 80).data];
      state.blinkCandidateIds = new Set(["manual:excludeErase"]); state.blinkModes = new Map([["manual:excludeErase", "effective"]]); state.blinkPhase = true; flushRender();
      const erase = { intersect: sample(56, 40, right), outside: sample(82, 40, right), cacheSame: cacheBefore.every((value, index) => value === effectiveExclusionCtx.getImageData(0, 0, 100, 80).data[index]) };
      clearCandidateBlink(); state.displayMode = "single"; flushRender();
      return { colors, erase, outside };
    }, scenario.candidateId);
    assert.deepEqual(blinkPixels.colors.apply, [199, 47, 60, 255], "Chromium applies the configured red RGBA overlay to the right apply range");
    assert.deepEqual(blinkPixels.colors.exclude, [31, 164, 199, 255], "Chromium applies the configured blue RGBA overlay to the right exclusion range");
    assert.deepEqual(blinkPixels.colors.left, [0, 0, 0, 255], "compare blink never crosses the centre into the left image pane");
    assert.deepEqual(blinkPixels.outside, [0, 0, 0, 0], "the right compare pane stays transparent outside the fitted image rectangle");
    assert.equal(blinkPixels.erase.cacheSame, true, "manual erase blink leaves the cached post-erase exclusion mask untouched");
    assert.deepEqual(blinkPixels.erase.intersect, [199, 47, 60, 255], "manual erase blinks red only where it intersects a pre-erase exclusion");
    assert.deepEqual(blinkPixels.erase.outside, [0, 0, 0, 255], "manual erase does not color pixels outside the pre-erase exclusion union");

    if (expanded) {
    await page.evaluate(() => {
      window.__nativeWorker = window.Worker;
      window.Worker = class { constructor() { throw new Error("fixture mosaic worker failure"); } };
      state.mosaicPreviewEnabled = false;
      state.mosaicPreviewFailureReported = false;
      const button = document.querySelector("#mosaicPreviewButton");
      button.classList.remove("active"); button.setAttribute("aria-pressed", "false");
    });
    await page.locator("#mosaicPreviewButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#errorDialogTitle").textContent(), await page.evaluate(() => t("errorDialog.mosaic_preview_failed.title")), "the first failed preview attempt reports its error");
    await page.locator("#errorDialogClose").click();
    await page.locator("#mosaicPreviewButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#errorDialogTitle").textContent(), await page.evaluate(() => t("errorDialog.mosaic_preview_failed.title")), "explicitly re-enabling after a failure reports the next failed attempt once");
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.evaluate(() => state.mosaicPreviewEnabled), false, "a failed preview attempt stays off instead of retrying in the background");
    await page.evaluate(() => { window.Worker = window.__nativeWorker; });
    }
  } finally {
    await stopCoveredPage(page, true);
    scenario.server.closeAllConnections();
    await closeServer(scenario.server);
  }
}

async function runExhaustiveCandidateScenarios(browser) {
  await runCandidateBlinkScenario(browser, true);
}

function overlaps(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

async function assertVisibleButtons(page, label) {
  const viewport = page.viewportSize();
  const buttons = await page.evaluate(() => [...document.querySelectorAll("button")].map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const virtualViewport = element.closest(".catalog-window")?.getBoundingClientRect();
    return {
      visible: !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
        && (!virtualViewport || (rect.top >= virtualViewport.top && rect.bottom <= virtualViewport.bottom)),
      id: element.id || element.textContent.trim(), text: element.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
    };
  }).filter((button) => button.visible));
  for (const button of buttons) {
    assert.ok(button.x >= -1 && button.y >= -1, `${button.id} must not start outside ${label}`);
    assert.ok(button.x + button.width <= viewport.width + 1, `${button.id} must not extend outside ${label}`);
    assert.ok(button.y + button.height <= viewport.height + 1, `${button.id} must not extend below ${label}`);
  }
  for (let index = 0; index < buttons.length; index += 1) for (let other = index + 1; other < buttons.length; other += 1) {
    assert.equal(overlaps(buttons[index], buttons[other]), false, `${buttons[index].id} and ${buttons[other].id} overlap at ${label}`);
  }
}

async function assertDesktopLayout(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `horizontal overflow at ${width}x${height}`);
  if (width === 1024) assert.equal(await page.locator("#candidatePane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 270, "the 1024px inspector keeps its usable 270px width");
  await assertVisibleButtons(page, `${width}x${height} edit`);
  const appbar = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const hit = (selector) => { const rect = box(selector); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id === selector.slice(1); };
    const logo = box(".brand-logo"); const appbar = box(".appbar");
    return { appbar, settings: box("#settingsButton"), status: box("#connectionStatus"), statusHidden: document.querySelector("#connectionStatus").hidden, logo, noBrandText: !document.querySelector(".brand"), logoLoaded: document.querySelector(".brand-logo").complete && document.querySelector(".brand-logo").naturalWidth > 0, logoHit: document.elementFromPoint(logo.x + logo.width / 2, logo.y + logo.height / 2) === document.querySelector(".brand-logo"), hits: ["#pickFolder", "#settingsButton", "#detectAllButton", "#saveAllButton", "#batchMoreButton"].every(hit) };
  });
  assert.ok(appbar.appbar.right - appbar.settings.right <= 12, `settings stays at the header right edge at ${width}x${height}`);
  if (!appbar.statusHidden) assert.ok(appbar.status.top >= appbar.appbar.top && appbar.status.bottom <= appbar.appbar.bottom, `status stays in the header at ${width}x${height}`);
  assert.equal(appbar.hits, true, `key appbar and gallery buttons own their hit targets at ${width}x${height}`);
  assert.equal(appbar.logoLoaded && appbar.logoHit, true, `brand logo loads and owns its hit target at ${width}x${height}`);
  assert.equal(Math.round(appbar.logo.width), 28, `brand logo uses the intended 28px size at ${width}x${height}`);
  assert.equal(appbar.noBrandText && appbar.logo.top >= appbar.appbar.top && appbar.logo.bottom <= appbar.appbar.bottom, true, `header uses only the logo at ${width}x${height}`);
  const unreviewedBadgeColor = await page.locator(".gallery-item:not(.reviewed) .gallery-review-badge").first().evaluate((badge) => getComputedStyle(badge).color);
  assert.equal(unreviewedBadgeColor, "rgb(216, 255, 243)", `unreviewed gallery status keeps the requested green at ${width}x${height}`);
  await page.locator("#mosaicHelpButton").focus();
  assert.equal(await page.locator("#mosaicHelpButton").evaluate((button) => document.activeElement === button), true, `mosaic help accepts keyboard focus at ${width}x${height}`);
  if (width >= 1280) {
    const heading = await page.evaluate(() => {
      const pane = document.querySelector("#galleryPane").getBoundingClientRect();
      const action = document.querySelector("#collapseGalleryButton").getBoundingClientRect();
      return { rightGap: pane.right - action.right };
    });
    assert.ok(heading.rightGap <= 12, `gallery heading actions align with the gallery right edge at ${width}x${height}`);
  }
  assert.equal(await page.locator(".gallery-batch-bar").count(), 0, "the gallery has no inactive batch-edit row");
  await page.locator("#overviewButton").click();
  await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
  await assertVisibleButtons(page, `${width}x${height} overview`);
  const overview = await page.evaluate(() => {
    const toolbar = document.querySelector(".overview-toolbar");
    const bar = document.querySelector("#overviewSelectionBar");
    const button = document.querySelector("#batchModeButton");
    const toolbarRect = toolbar.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      headingTail: button.parentElement.lastElementChild === button,
      followsToolbar: toolbar.nextElementSibling === bar,
      hiddenBarLeavesNoGap: bar.hidden && Math.abs(document.querySelector(".overview-grid-viewport").getBoundingClientRect().top - toolbarRect.bottom) <= 1,
      buttonHit: document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2) === button,
      toolbarBottom: toolbarRect.bottom, barTop: barRect.top,
    };
  });
  assert.equal(overview.headingTail, true, `batch edit ends the overview heading at ${width}x${height}`);
  assert.equal(overview.followsToolbar, true, `selection actions follow the overview toolbar at ${width}x${height}`);
  assert.equal(overview.hiddenBarLeavesNoGap, true, `hidden selection actions leave no overview gap at ${width}x${height}`);
  assert.equal(overview.buttonHit, true, `batch edit owns its physical click target at ${width}x${height}`);
  await page.locator("#batchModeButton").click();
  await assertVisibleButtons(page, `${width}x${height} overview batch`);
  const batchDimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, visible: !document.querySelector("#overviewSelectionBar").hidden }));
  assert.equal(batchDimensions.visible, true, `selection actions become visible in overview batch mode at ${width}x${height}`);
  assert.equal(batchDimensions.scrollWidth, batchDimensions.clientWidth, `batch actions do not create horizontal overflow at ${width}x${height}`);
  await page.locator("#selectionClearButton").click();
  await page.locator("#closeOverviewButton").click();
  await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
}

async function assertCompactNavigationLayout(page, language) {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate((locale) => loadTranslations(locale), language);
  const layout = await page.evaluate(() => {
    const nav = document.querySelector(".canvas-navigation-bar");
    const bounds = nav.getBoundingClientRect();
    const children = [...nav.children].map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    });
    return {
      filename: document.querySelector("#currentFileName").textContent,
      firstChild: nav.firstElementChild?.id,
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      children,
    };
  });
  const filename = layout.children.find((child) => child.id === "currentFileName");
  assert.equal(layout.filename, "sample.png", `current filename stays visible at 1024x768 (${language})`);
  assert.equal(layout.firstChild, "currentFileName", `current filename remains the first footer item at 1024x768 (${language})`);
  assert.ok(filename.width >= 48, `current filename keeps a usable width at 1024x768 (${language})`);
  assert.equal(layout.children.every((child) => child.left >= layout.bounds.left && child.right <= layout.bounds.right && child.top >= layout.bounds.top && child.bottom <= layout.bounds.bottom), true, `all footer items stay inside navigation at 1024x768 (${language})`);
  assert.equal(layout.children.slice(1).every((child) => filename.left <= child.left), true, `current filename is visually leftmost at 1024x768 (${language})`);
}

async function assertConnectionStatusLayout(page, width, height, language) {
  await page.setViewportSize({ width, height });
  await page.evaluate(async (selected) => {
    // This layout assertion supplies an artificial connection loss. A pending
    // successful background poll is a real recovery signal and would clear it
    // concurrently, so keep recovery testing separate from the viewport check.
    clearTimeout(state.jobPollTimer); state.jobPollTimer = null;
    await loadTranslations(selected);
    setStatusKey("error.connectionLost", {}, "error");
  }, language);
  const layout = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const appbar = box(".appbar");
    const connection = box("#connectionStatus");
    const settings = box("#settingsButton");
    const dimensions = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    return {
      inAppbar: connection.top >= appbar.top && connection.bottom <= appbar.bottom,
      gap: settings.left - connection.right,
      settingsHit: document.elementFromPoint(settings.x + settings.width / 2, settings.y + settings.height / 2) === document.querySelector("#settingsButton"),
      connectionHidden: document.querySelector("#connectionStatus").hidden,
      connectionText: document.querySelector("#connectionStatus").textContent,
      connectionColor: getComputedStyle(document.querySelector("#connectionStatus")).color,
      errorDialogOpen: document.querySelector("#errorDialog").open,
      parentIsAppbar: document.querySelector("#connectionStatus").parentElement === document.querySelector(".appbar"),
      rightAligned: getComputedStyle(document.querySelector("#connectionStatus")).textAlign === "right",
      ...dimensions,
    };
  });
  assert.equal(layout.connectionHidden, false, `connection loss is visible in the header at ${width}x${height} (${language})`);
  assert.equal(layout.connectionText, language === "en" ? "Cannot connect to Mozarie." : "Mozarieに接続できません", `connection loss uses the selected-language text at ${width}x${height} (${language})`);
  assert.equal(layout.connectionColor, "rgb(255, 157, 146)", `connection loss is red at ${width}x${height} (${language})`);
  assert.equal(layout.errorDialogOpen, false, `connection loss does not open a dialog at ${width}x${height} (${language})`);
  assert.equal(layout.parentIsAppbar && layout.settingsHit && layout.rightAligned && layout.inAppbar && layout.gap >= 10, true, `connection loss stays left of the clickable settings button at ${width}x${height} (${language})`);
  assert.equal(layout.scrollWidth, layout.clientWidth, `connection status does not create horizontal overflow at ${width}x${height} (${language})`);

  await page.evaluate(() => setStatus("Test notification"));
  const general = await page.evaluate(() => {
    const appbar = document.querySelector(".appbar").getBoundingClientRect();
    const status = document.querySelector("#connectionStatus").getBoundingClientRect();
    return { connectionHidden: document.querySelector("#connectionStatus").hidden, inAppbar: status.top >= appbar.top && status.bottom <= appbar.bottom };
  });
  assert.equal(general.connectionHidden, false, `ordinary status uses the header at ${width}x${height} (${language})`);
  assert.equal(general.inAppbar, true, `ordinary status remains inside the header at ${width}x${height} (${language})`);

  await page.evaluate(() => setStatus("Test error", "error"));
  assert.equal(await page.evaluate(() => document.querySelector("#errorDialog").open && document.querySelector("#connectionStatus").hidden), true, `every global error uses the error dialog at ${width}x${height} (${language})`);
  await page.evaluate(() => document.querySelector("#errorDialog").close());

  await page.evaluate(() => clearStatus());
  assert.equal(await page.evaluate(() => document.querySelector("#connectionStatus").hidden), true, `clearing status hides the header status at ${width}x${height} (${language})`);
}

const USER_FACING_INTERNAL_MODEL_DETAIL = /(?:models\\|(?:sam_vit_[blh]_[0-9a-f]+|anime-hand-v[\w.-]*|handsegnet_vit_[\w.-]+|nsfw-anime-xl-[\w.-]+)\.(?:pth|onnx|safetensors)|(?:dba2c5b|77ff734|modelVersionId))/i;

async function assertNoUserFacingInternalModelDetails(locator, message) {
  assert.doesNotMatch(await locator.evaluate((element) => element.innerHTML), USER_FACING_INTERNAL_MODEL_DETAIL, message);
}

async function assertNoVisibleUserFacingInternalModelDetails(locator, message) {
  assert.doesNotMatch(await locator.textContent(), USER_FACING_INTERNAL_MODEL_DETAIL, message);
}

async function assertExternalPreparationLink(page, href, message) {
  const link = page.locator("#modelDownloadItems a");
  assert.equal(await link.getAttribute("href"), href, `${message} uses the direct source URL`);
  assert.equal(await link.getAttribute("target"), "_blank", `${message} opens in a new tab`);
  assert.equal(await link.getAttribute("rel"), "noreferrer", `${message} omits the referrer`);
  assert.equal(await link.getAttribute("download"), null, `${message} has no download attribute`);
  assert.doesNotMatch(await link.getAttribute("href"), /\/api\/model-download\/start/, `${message} does not use the download API`);
}

async function assertSettingsDialogLayout(page, width, height, language, modelDownloadRequests) {
  await page.setViewportSize({ width, height });
  await page.locator("#settingsButton").click();
  await page.locator("#settingsTabGeneral").click();
  await page.locator("#settingsLanguage").selectOption(language);
  await page.waitForFunction((selected) => document.documentElement.lang === selected, language);
  const layout = await page.locator("#settingsDialog").evaluate((dialog) => {
    const footer = dialog.querySelector(".dialog-actions");
    const box = (element) => element.getBoundingClientRect();
    const hit = (element) => { const rect = box(element); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element; };
    return {
      fits: dialog.scrollWidth <= dialog.clientWidth,
      reset: hit(footer.querySelector("#settingsResetButton")),
      save: hit(footer.querySelector("#settingsSaveButton")),
      close: hit(dialog.querySelector("#settingsCloseButton")),
    };
  });
  assert.equal(layout.fits, true, `settings does not overflow at ${width}x${height} (${language})`);
  assert.equal(layout.reset && layout.save && layout.close, true, `settings controls own their hit targets at ${width}x${height} (${language})`);
  await page.locator("#settingsTabModels").click();
  const precisionTitle = language === "ja" ? "輪郭を補正" : "Refine contours";
  assert.equal(await page.locator("#settingsPrecisionTitle").textContent(), precisionTitle, `contour refinement has the concise title at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#settingsHandTitle").textContent(), language === "ja" ? "手 (anime_hand_detection)" : "Hands (anime_hand_detection)", `hand detector label identifies its model at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#settingsHandSegmentationTitle").textContent(), language === "ja" ? "手 (HandSegNet anime SDXL)" : "Hands (HandSegNet anime SDXL)", `hand segmentation label identifies its model at ${width}x${height} (${language})`);
  const expectedPathPlaceholder = language === "ja" ? "パスを指定してください" : "Specify a path";
  for (const selector of ["#settingsTargetModel", "#settingsNtd11Model", "#settingsSensitiveModel", "#settingsSamModel", "#settingsHandModel", "#settingsHandSegmentationModel"]) {
    assert.equal(await page.locator(selector).getAttribute("placeholder"), expectedPathPlaceholder, `${selector} has the localized path placeholder at ${width}x${height} (${language})`);
  }
  const modelNames = language === "ja"
    ? ["基本モデル", "NTD11", "Sensitive", "輪郭を補正", "手 (anime_hand_detection)", "手 (HandSegNet anime SDXL)", "白い液"]
    : ["Primary model", "NTD11", "Sensitive", "Refine contours", "Hands (anime_hand_detection)", "Hands (HandSegNet anime SDXL)", "White fluid"];
  const modelActionNames = [
    ...modelNames.slice(0, 6).map((model) => `${model} ${language === "ja" ? "ダウンロード" : "Download"}`),
    ...modelNames.slice(0, 6).map((model) => `${model} ${language === "ja" ? "参照" : "Browse"}`),
    ...modelNames.map((model) => `${model} ${language === "ja" ? "この設定の説明" : "About this option"}`),
    language === "ja" ? "SAM・手モデルをダウンロード" : "Download SAM & hand models",
  ];
  assert.equal(new Set(modelActionNames).size, modelActionNames.length, `model action expectations are unique at ${width}x${height} (${language})`);
  for (const name of modelActionNames) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, `model action has one accessible name: ${name} at ${width}x${height} (${language})`);
  const helpExpectations = {
    target: ["01miku/anime-nsfw-segm-yolo26", ".onnx", "https://huggingface.co/01miku/anime-nsfw-segm-yolo26"],
    ntd11: ["Anime NSFW Detection / ADetailer All-in-One", language === "ja" ? "NTD11のZIP → .pt → .onnx" : "NTD11 ZIP → .pt → .onnx", "https://civitai.com/api/download/models/2350456?fileId=2240838"],
    sensitive: ["sugarknight/sensitive-detect", ".pt → .onnx", "https://huggingface.co/sugarknight/sensitive-detect"],
    precision: ["Meta Segment Anything (SAM)", ".pth", "https://github.com/facebookresearch/segment-anything#model-checkpoints"],
    hand: ["deepghs/anime_hand_detection", ".onnx", "https://huggingface.co/deepghs/anime_hand_detection"],
    handSegmentation: ["HandSegNet anime SDXL", ".safetensors", "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl"],
    fluid: [language === "ja" ? "追加モデルなし" : "No additional model", language === "ja" ? "不要" : "Not required", ""],
  };
  for (const [key, [model, file, href]] of Object.entries(helpExpectations)) {
    const button = page.locator(`[data-model-help="${key}"]`); await button.scrollIntoViewIfNeeded(); await button.click();
    if (key === "precision") assert.equal(await page.locator("#modelHelpTitle").textContent(), precisionTitle, `contour refinement help shares the concise title at ${width}x${height} (${language})`);
    assert.equal(await page.locator("#modelHelpModel").textContent(), model, `${key} help names its model at ${width}x${height} (${language})`);
    assert.match(await page.locator("#modelHelpFile").textContent(), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${key} help names its file at ${width}x${height} (${language})`);
    assert.equal(await page.locator('[data-i18n="modelHelp.file"]').textContent(), language === "ja" ? "形式" : "Format", `model help labels the format at ${width}x${height} (${language})`);
    if (key === "target") assert.equal(await page.locator("#modelHelpText").textContent(), language === "ja"
      ? "性器候補を検出する基本モデルです。配布元のONNXを「参照」から指定します。変換は不要です。"
      : "This primary model detects genital candidates. Select an ONNX from the source with Browse. No conversion is required.", `${key} help states the model contract at ${width}x${height} (${language})`);
    if (href) {
      assert.equal(await page.locator("#modelHelpSource").getAttribute("href"), href, `${key} help links to its source at ${width}x${height} (${language})`);
      assert.equal(await page.locator("#modelHelpSource").evaluate((link) => { const rect = link.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === link; }), true, `${key} source link owns its hit target at ${width}x${height} (${language})`);
    } else assert.equal(await page.locator("#modelHelpSource").isVisible(), false, `${key} help hides an unavailable source at ${width}x${height} (${language})`);
    await assertNoUserFacingInternalModelDetails(page.locator("#modelHelpDialog"), `${key} help omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
    assert.equal(await page.locator("#modelHelpDialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true, `${key} help does not overflow at ${width}x${height} (${language})`);
    if (key === "ntd11" || key === "sensitive") {
      const expectedCommand = key === "ntd11"
        ? (language === "ja" ? '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたNTD11の.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu' : '& ".\\.venv\\Scripts\\yolo.exe" export model="path\\to\\downloaded\\NTD11.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu')
        : (language === "ja" ? '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたSensitiveの.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu' : '& ".\\.venv\\Scripts\\yolo.exe" export model="path\\to\\downloaded\\Sensitive.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu');
      assert.equal(await page.locator("#modelHelpCommand").textContent(), expectedCommand, `${key} help uses the setup-installed yolo command at ${width}x${height} (${language})`);
      assert.doesNotMatch(expectedCommand, /\n|pip install/, `${key} help keeps conversion to one command at ${width}x${height} (${language})`);
      const helpCommandLayout = await page.locator("#modelHelpDialog").evaluate((dialog) => {
        const pre = dialog.querySelector("#modelHelpCommand"); const button = dialog.querySelector("#modelHelpCopy");
        const preBox = pre.getBoundingClientRect(); const buttonBox = button.getBoundingClientRect();
        return {
          buttonBelow: buttonBox.top >= preBox.bottom,
          noOverlap: buttonBox.top >= preBox.bottom || buttonBox.bottom <= preBox.top || buttonBox.right <= preBox.left || buttonBox.left >= preBox.right,
          hit: document.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2) === button,
          actionsFollowPre: pre.nextElementSibling?.classList.contains("command-actions") && pre.nextElementSibling.contains(button),
          fits: dialog.scrollWidth <= dialog.clientWidth,
        };
      });
      assert.equal(helpCommandLayout.buttonBelow && helpCommandLayout.noOverlap && helpCommandLayout.hit && helpCommandLayout.actionsFollowPre && helpCommandLayout.fits, true, `${key} help command and copy control are separate and usable at ${width}x${height} (${language})`);
      await page.locator("#modelHelpCopy").click();
      assert.match(await page.locator("#modelHelpCopyResult").textContent(), /コピーしました|Copied/, `${key} help command can be copied at ${width}x${height} (${language})`);
    }
    await page.locator("#modelHelpCloseButton").click();
  }
  const pickerCount = await page.locator("[data-model-picker]").count();
  assert.equal(pickerCount, 6, `all model pickers are available at ${width}x${height} (${language})`);
  for (const button of await page.locator(".model-card-title [data-model-download]").all()) {
    await button.scrollIntoViewIfNeeded();
    const download = await button.evaluate((element) => {
      const title = element.closest(".model-card-title").querySelector("h4");
      const rect = element.getBoundingClientRect(); const titleRect = title.getBoundingClientRect();
      return { gap: rect.left - titleRect.right, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(download.gap >= 0 && download.gap <= 10, `model download stays beside its name at ${width}x${height} (${language})`);
    assert.equal(download.hit, true, `model download owns its hit target at ${width}x${height} (${language})`);
    assert.equal(download.overflow, false, `model download does not cause horizontal overflow at ${width}x${height} (${language})`);
  }
  const samRows = page.locator(".sam-variant");
  assert.equal(await samRows.count(), 3, `SAM card shows three variant rows at ${width}x${height} (${language})`);
  assert.equal(await samRows.evaluateAll((rows) => rows.every((row) => {
    const rect = row.getBoundingClientRect(); const radio = row.querySelector("input");
    return rect.right <= innerWidth && radio && !radio.disabled;
  })), true, `SAM rows remain selectable without overflow at ${width}x${height} (${language})`);
  const allDownload = page.locator('[data-model-download="all"]');
  await allDownload.scrollIntoViewIfNeeded(); await allDownload.click();
  assert.equal(await page.locator("#modelDownloadItems .model-download-item").count(), 3, `download confirmation uses three readable rows at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadDialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true, `download confirmation does not overflow at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadItems a").evaluateAll((links) => links.every((link) => {
    const rect = link.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === link;
  })), true, `download source links own their hit targets at ${width}x${height} (${language})`);
  await assertNoUserFacingInternalModelDetails(page.locator("#modelDownloadDialog"), `download all omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadClose").click();
  assert.equal(await allDownload.evaluate((button) => document.activeElement === button), true, `closing download confirmation restores focus at ${width}x${height} (${language})`);
  const targetDownload = page.locator('[data-model-download="target"]');
  const requestsBeforePreparation = modelDownloadRequests.length;
  await targetDownload.scrollIntoViewIfNeeded(); await targetDownload.click();
  assert.equal(await page.locator("#modelDownloadMessage").textContent(), language === "ja"
    ? "配布元から基本モデルのONNXを取得し、「参照」から指定してください。変換は不要です。"
    : "Get the primary model ONNX from the source, then select it with Browse. No conversion is required.", `primary model explains direct preparation at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadTitle").textContent(), language === "ja" ? "モデルを準備" : "Prepare model", `primary model opens the preparation dialog at ${width}x${height} (${language})`);
  await assertExternalPreparationLink(page, "https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx?download=true", `primary model at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadCommandWrap").isHidden(), true, `primary model has no conversion command at ${width}x${height} (${language})`);
  await assertNoVisibleUserFacingInternalModelDetails(page.locator("#modelDownloadDialog"), `primary model preparation omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
  for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadStart", "#modelDownloadCancel", "#modelDownloadActions"]) assert.equal(await page.locator(selector).isHidden(), true, `primary model hides ${selector} at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadClose").click();
  const ntd11Download = page.locator('[data-model-download="ntd11"]');
  await ntd11Download.scrollIntoViewIfNeeded(); await ntd11Download.click();
  const ntdCommand = language === "ja"
    ? '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたNTD11の.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu'
    : '& ".\\.venv\\Scripts\\yolo.exe" export model="path\\to\\downloaded\\NTD11.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu';
  assert.equal(await page.locator("#modelDownloadMessage").textContent(), language === "ja"
    ? "NTD11は成人向けの任意モデルです。Civitai.comへログインして年齢確認を済ませてから、下のリンクでZIPを取得・展開し、含まれる.ptをONNXへ変換して「参照」から指定してください。匿名アクセスで取得できるとは限りません。セットアップ後、Mozarieフォルダーで下のコマンドをPowerShellから実行してください。"
    : "NTD11 is an optional adult model. Sign in to Civitai.com and complete its age check before using the link below to download and extract the ZIP. Convert the included .pt file to ONNX, then select it with Browse. Anonymous access may not work. After setup, run the command below in PowerShell from the Mozarie folder.", `NTD11 download explains preparation at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadTitle").textContent(), language === "ja" ? "モデルを準備" : "Prepare model", `NTD11 opens the preparation dialog at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadItems .model-download-item").count(), 1, `NTD11 download has one source item at ${width}x${height} (${language})`);
  await assertExternalPreparationLink(page, "https://civitai.com/api/download/models/2350456?fileId=2240838", `NTD11 at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadCommand").textContent(), ntdCommand, `NTD11 download shows its conversion command at ${width}x${height} (${language})`);
  assert.doesNotMatch(ntdCommand, /\n|pip install/, `NTD11 conversion is one command at ${width}x${height} (${language})`);
  await assertNoUserFacingInternalModelDetails(page.locator("#modelDownloadDialog"), `NTD11 preparation omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
  for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadStart", "#modelDownloadCancel", "#modelDownloadActions"]) assert.equal(await page.locator(selector).isHidden(), true, `NTD11 hides ${selector} at ${width}x${height} (${language})`);
  await page.evaluate(() => { window.__copiedCommand = ""; navigator.clipboard.writeText = async (text) => { window.__copiedCommand = text; }; });
  await page.locator("#modelDownloadCopy").click();
  assert.equal(await page.evaluate(() => window.__copiedCommand), ntdCommand, `NTD11 copies its exact command at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadClose").click();
  const sensitiveDownload = page.locator('[data-model-download="sensitive"]');
  await sensitiveDownload.scrollIntoViewIfNeeded(); await sensitiveDownload.click();
  const sensitiveCommand = language === "ja"
    ? '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたSensitiveの.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu'
    : '& ".\\.venv\\Scripts\\yolo.exe" export model="path\\to\\downloaded\\Sensitive.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu';
  assert.equal(await page.locator("#modelDownloadMessage").textContent(), language === "ja"
    ? "Sensitiveは基本モデルの見落としを補う任意モデルです。配布元からSensitiveの.ptを取得し、ONNXへ変換して、「参照」から指定してください。セットアップ後、Mozarieフォルダーで下のコマンドをPowerShellから実行してください。"
    : "Sensitive is an optional model that supplements areas missed by the primary model. Get a Sensitive .pt file from the source, convert it to ONNX, then select it with Browse. After setup, run the command below in PowerShell from the Mozarie folder.", `Sensitive download explains preparation at ${width}x${height} (${language})`);
  await assertExternalPreparationLink(page, "https://huggingface.co/sugarknight/sensitive-detect/resolve/b7ec7a528841aac3d52411fb4d031d51a8225e40/sensitive_detect_v07.pt?download=true", `Sensitive at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#modelDownloadCommand").textContent(), sensitiveCommand, `Sensitive download shows its conversion command at ${width}x${height} (${language})`);
  assert.doesNotMatch(sensitiveCommand, /\n|pip install/, `Sensitive conversion is one command at ${width}x${height} (${language})`);
  await assertNoUserFacingInternalModelDetails(page.locator("#modelDownloadDialog"), `Sensitive preparation omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
  for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadStart", "#modelDownloadCancel", "#modelDownloadActions"]) assert.equal(await page.locator(selector).isHidden(), true, `Sensitive hides ${selector} at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadCopy").click();
  assert.equal(await page.evaluate(() => window.__copiedCommand), sensitiveCommand, `Sensitive copies its exact command at ${width}x${height} (${language})`);
  assert.equal(modelDownloadRequests.length, requestsBeforePreparation, `preparation dialogs make no API requests at ${width}x${height} (${language})`);
  const downloadCommandLayout = await page.locator("#modelDownloadDialog").evaluate((dialog) => {
    const pre = dialog.querySelector("#modelDownloadCommand"); const button = dialog.querySelector("#modelDownloadCopy");
    const preBox = pre.getBoundingClientRect(); const buttonBox = button.getBoundingClientRect();
    return {
      buttonBelow: buttonBox.top >= preBox.bottom,
      noOverlap: buttonBox.top >= preBox.bottom || buttonBox.bottom <= preBox.top || buttonBox.right <= preBox.left || buttonBox.left >= preBox.right,
      hit: document.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2) === button,
      actionsFollowPre: pre.nextElementSibling?.classList.contains("command-actions") && pre.nextElementSibling.contains(button),
      fits: dialog.scrollWidth <= dialog.clientWidth,
    };
  });
  assert.equal(downloadCommandLayout.buttonBelow && downloadCommandLayout.noOverlap && downloadCommandLayout.hit && downloadCommandLayout.actionsFollowPre && downloadCommandLayout.fits, true, `download command and copy control are separate and usable at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadClose").click();
  if (!await page.locator("#settingsPrecisionToggle").isChecked()) await page.locator("#settingsPrecisionCard .model-switch-track").click();
  await page.waitForFunction(() => !document.querySelector('[data-model-download="sam"]').disabled);
  await page.locator('[data-model-download="sam"]').click();
  assert.equal(await page.locator("#modelDownloadTitle").textContent(), language === "ja" ? "モデルをダウンロード" : "Download model", `supported model restores the download title at ${width}x${height} (${language})`);
  for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadActions", "#modelDownloadStart"]) assert.equal(await page.locator(selector).isHidden(), false, `supported model restores ${selector} at ${width}x${height} (${language})`);
  await assertNoUserFacingInternalModelDetails(page.locator("#modelDownloadDialog"), `SAM confirmation omits internal paths, fixed filenames, and pinned revisions at ${width}x${height} (${language})`);
  await page.locator("#modelDownloadClose").click();
  assert.equal(await page.locator('[data-model-help="samType"]').count(), 0, `SAM variants have no separate help control at ${width}x${height} (${language})`);
  assert.equal(await page.locator("#settingsSamVariants legend").count(), 0, `SAM variants omit the redundant heading at ${width}x${height} (${language})`);
  const handTrack = page.locator("#settingsHandCard .model-switch-track");
  if (!await page.locator("#settingsHandToggle").isChecked()) await handTrack.click();
  await page.waitForFunction(() => !document.querySelector("#settingsHandSegmentationToggle").disabled);
  const handSegmentationCard = page.locator("#settingsHandSegmentationCard");
  await handSegmentationCard.scrollIntoViewIfNeeded();
  const readHandSegmentationSwitch = () => page.evaluate(() => {
    const panel = document.querySelector("#settingsPanelModels");
    const card = document.querySelector("#settingsHandSegmentationCard");
    const handCard = document.querySelector("#settingsHandCard");
    const label = card.querySelector(".model-switch");
    const input = label.querySelector("input");
    const track = label.querySelector(".model-switch-track");
    const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const labelRect = rect(label); const inputRect = rect(input);
    return {
      scrollTop: panel.scrollTop,
      card: rect(card),
      handCardHeight: rect(handCard).height,
      label: labelRect,
      track: rect(track),
      input: inputRect,
      inputInsideLabel: inputRect.x >= labelRect.x && inputRect.y >= labelRect.y && inputRect.x + inputRect.width <= labelRect.x + labelRect.width && inputRect.y + inputRect.height <= labelRect.y + labelRect.height,
      checked: input.checked,
      active: card.classList.contains("active"),
      cardClasses: [...card.classList].filter((name) => name !== "active"),
      labelClasses: [...label.classList],
      trackClasses: [...track.classList],
      notes: card.querySelectorAll(".model-card-note").length,
      links: card.querySelectorAll("a").length,
    };
  });
  const beforeHandSegmentationToggle = await readHandSegmentationSwitch();
  assert.equal(beforeHandSegmentationToggle.inputInsideLabel, true, `the HandSeg switch input stays inside its label at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.card.height, beforeHandSegmentationToggle.handCardHeight, `HandSeg and hand cards have the same height at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.notes, 0, `HandSeg has no inline note at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.links, 0, `HandSeg has no download or project link at ${width}x${height} (${language})`);
  await page.mouse.click(beforeHandSegmentationToggle.label.x + beforeHandSegmentationToggle.label.width - 4, beforeHandSegmentationToggle.label.y + beforeHandSegmentationToggle.label.height / 2);
  await page.waitForFunction((checked) => document.querySelector("#settingsHandSegmentationToggle").checked === checked, !beforeHandSegmentationToggle.checked);
  const afterLabelClick = await readHandSegmentationSwitch();
  assert.equal(afterLabelClick.checked, !beforeHandSegmentationToggle.checked, `a physical HandSeg label click toggles the switch at ${width}x${height} (${language})`);
  assert.equal(afterLabelClick.active, afterLabelClick.checked, `the HandSeg active state follows the switch at ${width}x${height} (${language})`);
  assert.deepEqual({ ...afterLabelClick, checked: false, active: false }, { ...beforeHandSegmentationToggle, checked: false, active: false }, `a HandSeg label click changes no layout or card content at ${width}x${height} (${language})`);
  await page.mouse.click(afterLabelClick.track.x + afterLabelClick.track.width / 2, afterLabelClick.track.y + afterLabelClick.track.height / 2);
  await page.waitForFunction((checked) => document.querySelector("#settingsHandSegmentationToggle").checked === checked, beforeHandSegmentationToggle.checked);
  const afterTrackClick = await readHandSegmentationSwitch();
  assert.equal(afterTrackClick.checked, beforeHandSegmentationToggle.checked, `a physical HandSeg track click toggles the switch at ${width}x${height} (${language})`);
  assert.equal(afterTrackClick.active, afterTrackClick.checked, `the HandSeg active state returns with the switch at ${width}x${height} (${language})`);
  assert.deepEqual({ ...afterTrackClick, checked: false, active: false }, { ...beforeHandSegmentationToggle, checked: false, active: false }, `a HandSeg track click keeps the panel scroll and card geometry unchanged at ${width}x${height} (${language})`);
  const handSegmentationHelp = page.locator('[data-model-help="handSegmentation"]');
  await handSegmentationHelp.focus();
  await handSegmentationHelp.click();
  assert.equal(await page.locator("#modelHelpFile").textContent(), ".safetensors", `HandSeg help names its format at ${width}x${height} (${language})`);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#modelHelpDialog").isVisible(), false, `Escape closes HandSeg help at ${width}x${height} (${language})`);
  assert.equal(await handSegmentationHelp.evaluate((button) => document.activeElement === button), true, `Escape restores focus to HandSeg help at ${width}x${height} (${language})`);
  await handSegmentationHelp.click();
  await page.locator("#modelHelpCloseButton").click();
  assert.equal(await handSegmentationHelp.evaluate((button) => document.activeElement === button), true, `Close restores focus to HandSeg help at ${width}x${height} (${language})`);
  await page.locator("#settingsCloseButton").click();
}
async function assertToolRailLayout(page, position) {
  const boxes = await page.evaluate(() => {
    const read = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const ids = (selector) => [...document.querySelectorAll(selector)].map((element) => element.id);
    return {
      rail: read("#canvasToolRail"), settings: read(".canvas-settings-bar"), navigation: read(".canvas-navigation-bar"),
      mosaicTools: ids('[data-i18n-aria-label="editor.mosaicTools"] > .tool, [data-i18n-aria-label="editor.mosaicTools"] > .fill-tool-anchor > .tool'),
      exclusionTools: ids('[data-i18n-aria-label="editor.exclusionTools"] > .tool, [data-i18n-aria-label="editor.exclusionTools"] > .fill-tool-anchor > .tool'),
    };
  });
  assert.equal(overlaps(boxes.rail, boxes.settings), true, "tool settings are integrated into the top editor toolbar");
  assert.equal(overlaps(boxes.rail, boxes.navigation), false, `${position} rail must not overlap image navigation`);
  assert.ok(boxes.rail.y <= boxes.settings.y, "toolbar is fixed at the editor top");
  assert.deepEqual(boxes.mosaicTools, ["brushTool", "bucketTool", "mosaicEraserTool"], "mosaic tools keep brush, fill, eraser order");
  assert.deepEqual(boxes.exclusionTools, ["eraserTool", "excludeBucketTool", "excludeEraserTool"], "exclusion tools keep brush, fill, eraser order");
  await page.locator("#boundaryTool").click();
  const menu = await page.locator("#boundaryModeMenu").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, ids: [...element.querySelectorAll("button")].map((button) => button.id) };
  });
  assert.ok(menu.width > 0 && menu.height > 0, "toolbar boundary menu opens");
  assert.deepEqual(menu.ids, ["rectangleTool", "polygonTool", "boundaryBrushTool"], "boundary menu contains only its boundary modes");
  await page.keyboard.press("Escape");
}

async function selectFixtureImage(page, pageErrors, consoleErrors) {
  await page.locator('.gallery-item[data-id="sample"]').click();
  try { await page.waitForFunction(() => state.currentId === "sample" && !document.querySelector("#detectCurrentButton").disabled, null, { timeout: 3000 }); }
  catch (error) {
    const status = await page.locator("#connectionStatus").textContent();
    throw new Error(`image selection failed; status=${status}; pageErrors=${pageErrors.join(" | ")}; consoleErrors=${consoleErrors.join(" | ")}; cause=${error.message}`);
  }
}

// This is intentionally a separate, fresh-page sweep.  The long regression
// scenario below is allowed to concentrate on pixel-accurate editing; this
// ledger proves the public controls can be operated through a real browser
// input path.  It uses only Playwright browser actions (never .click() or
// dispatched events).  Operation and assertion coverage are recorded by this
// Node test immediately after the Playwright action and its result assertion,
// not by page-side events that production code could synthesize.  Every
// manifest assertion id must be present at the
// end of the sweep.
async function runExhaustiveAddedScenarios(page, fixtureUrl, resetScenario) {
  const setupFixture = async () => {
    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.evaluate(async () => {
      const source = document.createElement("canvas"); source.width = source.height = 240;
      source.getContext("2d").fillRect(0, 0, source.width, source.height);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = source.width; record.height = source.height;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft(); fitImage(); render();
    });
  };
  await setupFixture();
  const errorCodes = await page.evaluate(() => Object.keys(USER_ERROR_CODES));
  for (const language of ["ja", "en"]) {
    await page.evaluate((locale) => loadTranslations(locale), language);
    for (const code of errorCodes) {
      await page.evaluate((errorCode) => showUserError({ code: errorCode, message: "fixture server detail" }), code);
      if (code === "connection_lost") {
        assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "connection loss remains outside the modal error dialog");
        assert.equal(await page.locator("#connectionStatus").isVisible(), true, `connection loss is visible inline in ${language}`);
        assert.equal(await page.locator("#connectionStatus").evaluate((node) => node.classList.contains("error")), true, `connection loss uses the inline error presentation in ${language}`);
        await page.evaluate(() => clearStatus());
        continue;
      }
      await page.waitForFunction(() => document.querySelector("#errorDialog").open);
      const presentation = await page.evaluate(() => ["#errorDialogTitle", "#errorDialogCause", "#errorDialogAction"].map((selector) => document.querySelector(selector).textContent.trim()));
      assert.equal(presentation.every(Boolean), true, `${code} has title, cause, and action in ${language}`);
      assert.equal(presentation.join("\n").includes(code), false, `${code} never leaks its raw server code in ${language}`);
      assert.equal(presentation.join("\n").includes("fixture server detail"), false, `${code} never leaks server detail in ${language}`);
      await page.locator("#errorDialogClose").click();
    }
  }
  await page.evaluate(() => loadTranslations("ja"));

  await setupFixture();
  await page.evaluate(() => {
    state.images = [
      { id: "overview-unreviewed", relativePath: "unreviewed.png", width: 20, height: 20 },
      { id: "overview-reviewed-masked", relativePath: "reviewed-masked.png", width: 20, height: 20 },
      { id: "overview-hidden", relativePath: "hidden.png", width: 20, height: 20 },
    ];
    state.reviewedPaths = new Set([reviewPath(state.images[1])]);
    state.hiddenPaths = new Set([reviewPath(state.images[2])]);
    state.maskStatus = new Map([["overview-reviewed-masked", true]]);
    setViewMode("overview");
  });
  for (const [filter, expected] of [
    ["all", ["overview-unreviewed", "overview-reviewed-masked", "overview-hidden"]],
    ["unreviewed", ["overview-unreviewed"]], ["reviewed", ["overview-reviewed-masked"]],
    ["masked", ["overview-reviewed-masked"]], ["unmasked", ["overview-unreviewed"]], ["hidden", ["overview-hidden"]],
  ]) {
    await page.locator(`[data-overview-filter="${filter}"]`).click();
    await page.waitForFunction((value) => state.overviewFilter === value, filter);
    assert.deepEqual(await page.locator(".overview-item").evaluateAll((items) => items.map((item) => item.dataset.id)), expected, `overview ${filter} filter exposes exactly its matching images`);
  }
  for (const action of ["remove", "hide", "show", "clear", "detect", "reviewed", "unreviewed"]) {
    resetScenario(); await setupFixture();
    if (action === "show") await page.evaluate(() => { const image = state.images.find((item) => item.id === "sample"); state.hiddenPaths.add(reviewPath(image)); image.hidden = true; renderCatalogViews(); });
    if (action === "clear") await page.evaluate(() => { state.maskStatus.set("sample", true); currentRecord().candidateCount = 1; renderCatalogViews(); });
    if (action === "unreviewed") await page.evaluate(() => { const image = state.images.find((item) => item.id === "sample"); state.reviewedPaths.add(reviewPath(image)); image.reviewed = true; renderCatalogViews(); });
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample"]').click(); await page.locator("#selectionActionsButton").click();
    await page.locator(`[data-selection-action="${action}"]`).click();
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    if (action === "detect") {
      await page.waitForFunction(() => document.querySelector("#detectDialog").open);
      await page.locator("#detectCancelButton").click(); await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    } else if (action === "remove") await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
    else if (action === "hide") await page.waitForFunction(() => isHidden(state.images.find((image) => image.id === "sample")));
    else if (action === "show") await page.waitForFunction(() => !isHidden(state.images.find((image) => image.id === "sample")));
    else if (action === "clear") await page.waitForFunction(() => !state.maskStatus.has("sample") && state.images.find((image) => image.id === "sample")?.candidateCount === 0);
    else if (action === "reviewed") await page.waitForFunction(() => isReviewed(state.images.find((image) => image.id === "sample")));
    else await page.waitForFunction(() => !isReviewed(state.images.find((image) => image.id === "sample")));
  }

  await setupFixture();
  const bucketCanvas = await page.locator("#editorCanvas").boundingBox();
  const bucketPoint = { x: bucketCanvas.x + bucketCanvas.width / 2, y: bucketCanvas.y + bucketCanvas.height / 2 };
  await page.locator("#bucketTool").click(); await page.mouse.click(bucketPoint.x, bucketPoint.y);
  await page.waitForFunction(() => state.manualMaskPresent && canvasHasPixels(addCtx, addCanvas) && canvasHasPixels(combinedCtx, combinedCanvas));
  assert.equal(await page.evaluate(() => state.mosaicPreviewEnabled && Boolean(state.mosaicWorker)), true, "a public bucket fill rebuilds the mosaic preview worker from its composed mask");
  await page.locator("#undoButton").click(); await page.waitForFunction(() => !state.manualMaskPresent && !canvasHasPixels(addCtx, addCanvas));
  await page.locator("#excludeBucketTool").click(); await page.mouse.click(bucketPoint.x, bucketPoint.y);
  await page.waitForFunction(() => canvasHasPixels(exclusionCtx, exclusionCanvas) && !canvasHasPixels(combinedCtx, combinedCanvas));
  await page.locator("#undoButton").click(); await page.waitForFunction(() => !canvasHasPixels(exclusionCtx, exclusionCanvas));
  const boundaryRequest = async (toolId, points, expectedField) => {
    await setupFixture(); await page.locator("#boundaryTool").click(); await page.locator(`#${toolId}`).click();
    const box = await page.locator("#editorCanvas").boundingBox();
    const toClient = ([x, y]) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
    if (toolId === "boundaryBrushTool") {
      const [start, end] = points.map(toClient); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y); await page.mouse.up();
    } else for (const point of points.map(toClient)) await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !document.querySelector("#boundaryDetectButton").disabled);
    const count = await page.evaluate(() => window.__exhaustiveApi.length);
    await page.locator("#boundaryDetectButton").click();
    await page.waitForFunction((index) => window.__exhaustiveApi.slice(index).some((request) => request.url.includes("/api/boundary")), count);
    const payload = await page.evaluate((index) => JSON.parse(window.__exhaustiveApi.slice(index).find((request) => request.url.includes("/api/boundary")).body), count);
    assert.equal(typeof payload[expectedField], "object", `${toolId} sends its ${expectedField} through the public boundary API`);
    if (expectedField === "points") assert.ok(payload.points.length >= 3, "polygon detection sends the completed point shape");
    else assert.ok(payload.roi.right > payload.roi.left && payload.roi.bottom > payload.roi.top, "brush detection sends a non-empty mask ROI");
  };
  await boundaryRequest("polygonTool", [[.3, .3], [.65, .32], [.68, .68], [.3, .7]], "points");
  await boundaryRequest("boundaryBrushTool", [[.28, .42], [.72, .58]], "roi");

  await setupFixture();
  await page.evaluate(async () => {
    const source = document.createElement("canvas"); source.width = 3840; source.height = 2160;
    source.getContext("2d").fillRect(0, 0, source.width, source.height);
    state.currentImage = await createImageBitmap(source);
    const record = currentRecord(); record.width = source.width; record.height = source.height;
    canvasSizeForImage(record); prepareOriginalImage();
    state.imageCache.set(imageCacheKey(record), state.currentImage, source.width * source.height * 4);
    requestMosaicPreview(); fitImage(); render();
  });
  await page.waitForFunction(() => originalCanvas.width === 3840 && originalCanvas.height === 2160);
  await page.locator("#batchMoreButton").click(); await page.locator("#clearCatalogButton").click(); await page.locator("#confirmAccept").click();
  await page.waitForFunction(() => state.images.length === 0);
  assert.deepEqual(await page.evaluate(() => ({ original: [originalCanvas.width, originalCanvas.height], worker: state.mosaicWorker, imageCache: state.imageCache.items.size, candidateCache: state.candidateBundleCache.items.size })), { original: [1, 1], worker: null, imageCache: 0, candidateCache: 0 }, "clearing a selected 4K image releases its original canvas, preview worker, and decoded caches");
}

async function runControlLedger(page, fixtureUrl, contracts, dynamicContracts, finishCancel, holdSaveRender, releaseSaveRenders) {
  page.setDefaultTimeout(3000);
  const operated = new Set();
  const assertionPassed = new Set();
  const staticContracts = new Map(contracts.map((control) => [control.id, control]));
  const dynamicContractsBySelector = new Map(dynamicContracts.map((control) => [control.selector, control]));
  const markDynamic = async (selector, before, predicate) => {
    const contract = dynamicContractsBySelector.get(selector);
    assert.ok(contract, `${selector} has a dynamic ledger contract`);
    const after = await snapshot();
    await predicate(before, after);
    operated.add(selector); assertionPassed.add(contract.assertionId);
  };
  const setupFixture = async () => {
    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample");
    // The catalog thumbnail is intentionally 2px.  Give the editor fixture a
    // normal-sized in-memory image before exercising pointer-only tools.
    await page.evaluate(async () => {
      const source = document.createElement("canvas"); source.width = source.height = 240;
      source.getContext("2d").fillRect(0, 0, source.width, source.height);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = source.width; record.height = source.height;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft(); fitImage(); render();
    });
  };
  await setupFixture();

  // A configured server path is not a browser-granted directory. Exercise the
  // visible single-save flow with no handle and require both the disabled
  // button and the unselected label before any output picker is used.
  await page.evaluate(() => { state.outputDirectoryHandle = null; renderOutputDirectory(); });
  await page.locator("#brushTool").click();
  const unavailableOutputCanvas = await page.locator("#editorCanvas").boundingBox();
  assert.ok(unavailableOutputCanvas, "the editor canvas is available before testing an unselected save destination");
  await page.mouse.move(unavailableOutputCanvas.x + unavailableOutputCanvas.width / 2, unavailableOutputCanvas.y + unavailableOutputCanvas.height / 2);
  await page.mouse.down(); await page.mouse.move(unavailableOutputCanvas.x + unavailableOutputCanvas.width / 2 + 10, unavailableOutputCanvas.y + unavailableOutputCanvas.height / 2 + 6); await page.mouse.up();
  await page.locator("#saveButton").click();
  await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
  assert.equal(await page.locator("#singleSaveStartButton").isDisabled(), true, "single save remains disabled until a browser directory handle is selected");
  assert.equal(await page.locator("#singleSaveOutputDirectoryStatus").textContent(), await page.evaluate(() => t("apply.outputDirectoryUnset")), "single save never presents the configured server path as its browser destination");
  await page.locator("#singleSaveCloseButton").click();
  await setupFixture();

  // This snapshot intentionally contains only product results that a control
  // is allowed to prove: a particular dialog, value, state transition, canvas
  // hash, or actual request.  Do not replace these predicates with a generic
  // "the page is still alive/currentId/focus exists" check: that lets a
  // no-op handler satisfy the ledger.
  const snapshot = () => page.evaluate(() => {
    const read = (node) => ({
      value: node.value ?? "", checked: Boolean(node.checked), disabled: Boolean(node.disabled), hidden: Boolean(node.hidden),
      pressed: node.getAttribute("aria-pressed"), expanded: node.getAttribute("aria-expanded"), selected: node.getAttribute("aria-selected"),
      active: node.classList.contains("active"), text: node.textContent?.trim() || "",
    });
    const controls = Object.fromEntries([...document.querySelectorAll("button[id], input[id], select[id], textarea[id]")].map((node) => [node.id, read(node)]));
    const canvas = document.querySelector("#editorCanvas");
    let canvasHash = 0;
    if (canvas?.width && canvas?.height) {
      const data = canvas.getContext("2d").getImageData(0, 0, Math.min(canvas.width, 32), Math.min(canvas.height, 32)).data;
      for (let index = 0; index < data.length; index += 17) canvasHash = (canvasHash * 31 + data[index]) >>> 0;
    }
    return {
      controls,
      dialogs: Object.fromEntries([...document.querySelectorAll("dialog")].map((dialog) => [dialog.id, dialog.open])),
      popovers: Object.fromEntries([...document.querySelectorAll("[popover]")].map((node) => [node.id, node.matches(":popover-open")])),
      flags: {
        boundaryActionsHidden: document.querySelector("#boundaryActions")?.hidden,
        modelDownloadCancelHidden: document.querySelector("#modelDownloadCancel")?.hidden,
        applyPauseHidden: document.querySelector("#applyPauseButton")?.hidden,
      },
      state: {
        tool: state.tool, view: state.viewMode, displayMode: state.displayMode, scale: state.view?.scale, history: state.history?.length, historyIndex: state.historyIndex,
        galleryCollapsed: state.galleryCollapsed, inspectorCollapsed: state.inspectorCollapsed, mosaicPreview: state.mosaicPreviewEnabled,
        current: state.currentId, imageIds: state.images.map((image) => image.id), images: state.images.map((image) => ({ id: image.id, reviewed: image.reviewed, hidden: image.hidden })), selectedImageIds: [...state.selectedImageIds].sort(), batchMode: state.batchMode,
        galleryFilter: state.galleryFilter, overviewFilter: state.overviewFilter, overviewQuery: state.overviewQuery, overviewFolder: state.overviewFolder, hiddenCount: state.hiddenPaths.size,
        candidateDisplay: [...state.blinkCandidateIds || []].sort(), candidateDisplayModes: [...state.blinkModes || []].sort(),
      },
      canvasHash,
      candidateControls: [...document.querySelectorAll("[data-candidate-batch], [data-candidate-display-toggle], [data-candidate-effective-toggle]")]
        .map((node) => `${node.dataset.candidateBatch || node.dataset.candidateDisplayToggle || node.dataset.candidateEffectiveToggle}:${node.getAttribute("aria-pressed")}:${node.className}`).join("|"),
      overviewControls: [...document.querySelectorAll("[data-overview-filter]")].map((node) => `${node.dataset.overviewFilter}:${node.getAttribute("aria-pressed")}:${node.className}`).join("|"),
      api: window.__ledgerApi?.slice() || [], pickers: { ...window.__ledgerPickers }, clipboardWrites: window.__ledgerClipboardWrites || 0,
    };
  });
  const changed = (before, after, path, control) => assert.notDeepEqual(path(before), path(after), `${control} must change its explicit ${path.name || "product result"}`);
  const apiChanged = (before, after, control, endpoint = null) => {
    const requests = after.api.slice(before.api.length);
    assert.ok(requests.length > 0, `${control} must issue a product API request`);
    if (endpoint) assert.ok(requests.some((request) => request.url.includes(endpoint)), `${control} must request ${endpoint}; got ${requests.map((request) => request.url).join(", ")}`);
  };
  const dialog = (id, expected, control) => async (before, after) => {
    if (after.dialogs[id] !== expected) await page.waitForFunction(([dialogId, open]) => document.querySelector(`#${dialogId}`)?.open === open, [id, expected]);
    const settled = await snapshot();
    assert.equal(settled.dialogs[id], expected, `${control} must ${expected ? "open" : "close"} #${id}`);
  };
  const assertFitPostcondition = async () => {
    const layout = await page.evaluate(() => {
      const inset = { left: 20, right: 20, top: Math.max(58, toolRail.offsetHeight + 12), bottom: 62 };
      const available = { width: Math.max(1, stage.clientWidth - inset.left - inset.right), height: Math.max(1, stage.clientHeight - inset.top - inset.bottom) };
      const expectedScale = Math.min(available.width / state.currentImage.width, available.height / state.currentImage.height);
      const expected = {
        scale: expectedScale,
        x: inset.left + (available.width - state.currentImage.width * expectedScale) / 2,
        y: inset.top + (available.height - state.currentImage.height * expectedScale) / 2,
      };
      const rendered = {
        left: state.view.x, right: state.view.x + state.currentImage.width * state.view.scale,
        top: state.view.y, bottom: state.view.y + state.currentImage.height * state.view.scale,
      };
      return { inset, stage: { width: stage.clientWidth, height: stage.clientHeight }, expected, actual: { ...state.view }, rendered };
    });
    const epsilon = 0.01;
    for (const key of ["scale", "x", "y"]) assert.ok(Math.abs(layout.actual[key] - layout.expected[key]) <= epsilon, `fitButton must restore ${key}: expected=${layout.expected[key]}, actual=${layout.actual[key]}`);
    assert.ok(layout.rendered.left >= layout.inset.left - epsilon, "fitButton keeps the rendered image inside the left inset");
    assert.ok(layout.rendered.right <= layout.stage.width - layout.inset.right + epsilon, "fitButton keeps the rendered image inside the right inset");
    assert.ok(layout.rendered.top >= layout.inset.top - epsilon, "fitButton keeps the rendered image inside the top inset");
    assert.ok(layout.rendered.bottom <= layout.stage.height - layout.inset.bottom + epsilon, "fitButton keeps the rendered image inside the bottom inset");
  };
  const toolFor = {
    brushTool: "brush", mosaicEraserTool: "mosaic_eraser", eraserTool: "eraser", excludeEraserTool: "exclude_eraser",
    rectangleTool: "boundary", polygonTool: "polygon", boundaryBrushTool: "boundary_brush", bucketTool: "bucket", excludeBucketTool: "exclude_bucket",
  };
  const clickPredicates = {
    pickFolder: (before, after) => assert.equal(after.popovers.pickerMenu, true, "pickFolder must open the image-import menu"),
    pickImages: (before, after) => assert.ok(after.pickers.files > before.pickers.files, "pickImages must invoke the file picker"),
    pickFolderFiles: (before, after) => assert.ok(after.pickers.directory > before.pickers.directory, "pickFolderFiles must invoke the directory picker"),
    // Project-aware folder imports first ask whether the source belongs to an
    // existing project.  The decisive import is still the folder request;
    // wait for it rather than mistaking that harmless preflight for the
    // control's result.
    loadFolderButton: async (before) => {
      await page.waitForFunction((count) => window.__ledgerApi.slice(count).some((request) => request.url.includes("/api/folder")), before.api.length);
      apiChanged(before, await snapshot(), "loadFolderButton", "/api/folder");
    },
    settingsButton: dialog("settingsDialog", true, "settingsButton"), updateToast: dialog("settingsDialog", true, "updateToast"),
    batchMoreButton: (before, after) => assert.equal(after.popovers.batchMoreMenu, true, "batchMoreButton must open the batch menu"),
    clearAllMasksButton: dialog("confirmDialog", true, "clearAllMasksButton"), clearCatalogButton: dialog("confirmDialog", true, "clearCatalogButton"),
    overviewButton: (before, after) => assert.equal(after.state.view, "overview", "overviewButton must enter overview"),
    closeOverviewButton: (before, after) => assert.equal(after.state.view, "edit", "closeOverviewButton must return to editor"),
    collapseGalleryButton: (before, after) => changed(before, after, (item) => item.state.galleryCollapsed, "collapseGalleryButton"),
    collapseInspectorButton: (before, after) => changed(before, after, (item) => item.state.inspectorCollapsed, "collapseInspectorButton"),
    boundaryTool: (before, after) => changed(before, after, (item) => item.controls.boundaryTool.expanded, "boundaryTool"),
    singleViewButton: (before, after) => assert.equal(after.state.displayMode, "single", "singleViewButton must select the single editor view"),
    compareViewButton: (before, after) => assert.equal(after.state.displayMode, "compare", "compareViewButton must select the compare editor view"),
    fitButton: () => assertFitPostcondition(),
    undoButton: (before, after) => changed(before, after, (item) => item.state.historyIndex, "undoButton"),
    redoButton: (before, after) => changed(before, after, (item) => item.state.historyIndex, "redoButton"),
    mosaicPreviewButton: (before, after) => changed(before, after, (item) => item.state.mosaicPreview, "mosaicPreviewButton"),
    mosaicHelpButton: dialog("mosaicHelpDialog", true, "mosaicHelpButton"), mosaicHelpCloseButton: dialog("mosaicHelpDialog", false, "mosaicHelpCloseButton"),
    previousImageButton: async (before, after) => { await page.waitForFunction((current) => state.currentId !== current, before.state.current); assert.notEqual((await snapshot()).state.current, before.state.current, "previousImageButton must navigate"); },
    nextImageButton: async (before, after) => { await page.waitForFunction((current) => state.currentId !== current, before.state.current); assert.notEqual((await snapshot()).state.current, before.state.current, "nextImageButton must navigate"); },
    reviewAndNextButton: async (before, after) => { await page.waitForFunction((id) => currentRecord()?.id === id && currentRecord()?.reviewed === true, before.state.current); assert.notDeepEqual((await snapshot()).state.images, before.state.images, "reviewAndNextButton must mark the image reviewed"); },
    hideAndNextButton: async (before, after) => { await page.waitForFunction((id) => currentRecord()?.id !== id || Boolean(currentRecord()?.hidden), before.state.current); assert.notDeepEqual((await snapshot()).state.images, before.state.images, "hideAndNextButton must hide the image"); },
    removeAndNextButton: dialog("confirmDialog", true, "removeAndNextButton"), removeCurrentImageButton: async (before) => { await page.waitForFunction((count) => state.hiddenPaths.size !== count, before.state.hiddenCount); assert.notEqual((await snapshot()).state.hiddenCount, before.state.hiddenCount, "removeCurrentImageButton must toggle hidden state"); },
    boundaryDetectButton: (before, after) => apiChanged(before, after, "boundaryDetectButton", "/api/boundary"),
    boundaryCancelButton: (before, after) => assert.equal(after.flags.boundaryActionsHidden, true, "boundaryCancelButton must hide boundary actions"),
    detectCurrentButton: dialog("processingDialog", true, "detectCurrentButton"), saveButton: dialog("singleSaveDialog", true, "saveButton"), saveAllButton: dialog("applyDialog", true, "saveAllButton"),
    clearCurrentMasksButton: dialog("confirmDialog", true, "clearCurrentMasksButton"),
    batchModeButton: (before, after) => assert.equal(after.state.batchMode, true, "batchModeButton must enable batch mode"),
    selectionActionsButton: (before, after) => assert.equal(after.popovers.selectionActionsMenu, true, "selectionActionsButton must open selection actions"),
    selectionClearButton: (before, after) => assert.equal(after.state.batchMode, false, "selectionClearButton must clear batch mode"),
    toggleReviewMenuItem: (before, after) => assert.equal(after.popovers.catalogContextMenu, false, "toggleReviewMenuItem must complete and close the catalog context menu"),
    copyImagePathMenuItem: (before, after) => assert.ok(after.clipboardWrites > before.clipboardWrites, "copyImagePathMenuItem must write the clipboard"),
    removeImageMenuItem: async (before) => { await page.waitForFunction((count) => state.hiddenPaths.size !== count, before.state.hiddenCount); const settled = await snapshot(); assert.notEqual(settled.state.hiddenCount, before.state.hiddenCount, "removeImageMenuItem must toggle hidden state"); assert.equal(settled.popovers.catalogContextMenu, false, "removeImageMenuItem must close its context menu"); },
    detectAllButton: dialog("detectDialog", true, "detectAllButton"), detectCancelButton: dialog("detectDialog", false, "detectCancelButton"),
    detectStartButton: dialog("processingDialog", true, "detectStartButton"),
    settingsCloseButton: dialog("settingsDialog", false, "settingsCloseButton"),
    settingsChooseOutputDirectory: (before, after) => assert.ok(after.pickers.directory > before.pickers.directory, "settingsChooseOutputDirectory opens the browser directory picker"),
    checkUpdateButton: dialog("confirmDialog", true, "checkUpdateButton"),
    settingsResetButton: async (before, after) => { await page.waitForFunction((count) => window.__ledgerApi.slice(count).some((request) => request.url.includes("/api/settings/reset")), before.api.length); apiChanged(before, await snapshot(), "settingsResetButton", "/api/settings/reset"); },
    settingsSaveButton: (before, after) => apiChanged(before, after, "settingsSaveButton", "/api/settings"),
    modelDownloadClose: dialog("modelDownloadDialog", false, "modelDownloadClose"),
    modelDownloadCopy: (before, after) => assert.ok(after.clipboardWrites > before.clipboardWrites, "modelDownloadCopy must write the clipboard"),
    modelDownloadStart: (before, after) => apiChanged(before, after, "modelDownloadStart", "/api/model-download/start"),
    modelDownloadCancel: (before, after) => apiChanged(before, after, "modelDownloadCancel", "/api/model-download/cancel"),
    chooseOutputDirectoryButton: (before, after) => assert.ok(after.pickers.directory > before.pickers.directory, "chooseOutputDirectoryButton opens the browser directory picker"),
    singleSaveChooseOutputDirectoryButton: async () => {
      await page.waitForFunction(() => Boolean(state.outputDirectoryHandle));
      assert.ok(await page.locator("#singleSaveOutputDirectoryStatus").textContent(), "singleSaveChooseOutputDirectoryButton shows the selected output directory");
    },
    singleSaveCloseButton: dialog("singleSaveDialog", false, "singleSaveCloseButton"),
    singleSaveStartButton: dialog("confirmDialog", true, "singleSaveStartButton"),
    applyCloseButton: dialog("applyDialog", false, "applyCloseButton"),
    applyPauseButton: async () => { await page.waitForFunction(() => state.browserSave?.paused === true); },
    applyCancelButton: async () => { await page.waitForFunction(() => state.browserSave?.cancelled === true); },
    applyStartButton: async () => { await page.waitForFunction(() => state.applyRunning && state.saving); },
    processingPauseButton: (before, after) => apiChanged(before, after, "processingPauseButton", "/api/job/"),
    processingCancelButton: (before, after) => apiChanged(before, after, "processingCancelButton", "/api/job/cancel"),
    modelHelpCloseButton: dialog("modelHelpDialog", false, "modelHelpCloseButton"),
    modelHelpCopy: (before, after) => assert.ok(after.clipboardWrites > before.clipboardWrites, "modelHelpCopy must write the clipboard"),
    confirmAccept: dialog("confirmDialog", false, "confirmAccept"), errorDialogClose: dialog("errorDialog", false, "errorDialogClose"),
  };
  for (const [id, tool] of Object.entries(toolFor)) clickPredicates[id] = (before, after) => assert.equal(after.state.tool, tool, `${id} must select ${tool}`);
  for (const id of ["settingsTabGeneral", "settingsTabModels", "settingsTabDisplay", "settingsTabShortcuts", "settingsTabConfirm", "settingsTabInfo"]) {
    clickPredicates[id] = (before, after) => assert.equal(after.controls[id].selected, "true", `${id} must select its settings tab`);
  }
  const inputPredicate = (id, before, after, expected) => {
    const beforeValue = before.controls[id]; const afterValue = after.controls[id];
    assert.notDeepEqual(afterValue, beforeValue, `${id} must produce an observable value/checked transition`);
    if (expected.check !== undefined) assert.equal(afterValue.checked, expected.check, `${id} must apply the requested checked value`);
    else assert.equal(afterValue.value, expected.value, `${id} must apply the requested value`);
  };
  const predicateRegistry = new Map(contracts.filter((contract) => !contract.exemptReason).map((contract) => [
    contract.predicateId,
    contract.action === "change" || contract.action === "keyboard"
      ? (before, after, expected) => inputPredicate(contract.id, before, after, expected)
      : clickPredicates[contract.id],
  ]));
  assert.equal(predicateRegistry.size, contracts.filter((contract) => !contract.exemptReason).length, "every active static manifest assertion must resolve to exactly one predicate");
  const missingPredicates = contracts.filter((contract) => !contract.exemptReason && !predicateRegistry.get(contract.predicateId)).map((contract) => `${contract.predicateId} (${contract.id})`);
  assert.equal(missingPredicates.join("\n"), "", `every active static manifest assertion must have a concrete predicate\n${missingPredicates.join("\n")}`);
  const assertResult = async (id, before, expected = {}) => {
    const after = await snapshot();
    const contract = staticContracts.get(id);
    assert.ok(contract, `${id} has a static ledger contract`);
    const predicate = predicateRegistry.get(contract.predicateId);
    assert.ok(predicate, `${id} needs an explicit browser-ledger predicate for ${contract.predicateId}`);
    await predicate(before, after, expected);
    operated.add(id); assertionPassed.add(contract.assertionId);
    return after;
  };
  const closeDialogs = async () => page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()));
  const click = async (id) => {
    if (id !== "errorDialogClose" && await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
    const before = await snapshot();
    await page.locator(`#${id}`).click();
    await assertResult(id, before);
  };
  const input = async (id, value) => {
    const locator = page.locator(`#${id}`);
    const kind = await locator.evaluate((node) => `${node.tagName}:${node.type || ""}`);
    // Establish the opposite value first when a fixture default happens to
    // match the requested one.  The recorded action below then always proves a
    // real form transition instead of passing because the initial DOM did.
    if (kind.startsWith("SELECT:")) {
      const current = await locator.inputValue();
      const requested = value === "__first__" ? await locator.locator("option").first().getAttribute("value") : String(value);
      if (current === requested) {
        const alternative = await locator.locator("option").evaluateAll((options, currentValue) => options.find((option) => !option.disabled && option.value !== currentValue)?.value, current);
        if (alternative !== undefined) await locator.selectOption(alternative);
      }
      const before = await snapshot(); await locator.selectOption(value === "__first__" ? { index: 0 } : value);
      await assertResult(id, before, { kind: "input", value: requested }); return;
    }
    if (kind === "INPUT:checkbox" || kind === "INPUT:radio") {
      const requested = Boolean(value);
      if (kind === "INPUT:checkbox" && await locator.isChecked() === requested) { await locator.focus(); await locator.press("Space"); }
      if (kind === "INPUT:radio" && requested && await locator.isChecked()) {
        const radioName = await locator.getAttribute("name");
        const alternativeId = await page.locator(`input[type="radio"][name="${radioName}"]`).evaluateAll((radios, ownId) => radios.find((radio) => radio.id !== ownId)?.id, await locator.getAttribute("id"));
        if (alternativeId) await page.locator(`#${alternativeId}`).check();
      }
      const before = await snapshot();
      if (kind === "INPUT:checkbox") { await locator.focus(); await locator.press("Space"); }
      else if (requested) await locator.check(); else await locator.uncheck();
      await assertResult(id, before, { kind: "input", check: requested }); return;
    }
    const current = await locator.inputValue();
    if (current === String(value)) await locator.fill(`${value}_precondition`);
    const before = await snapshot();
    await locator.fill(String(value)); await locator.press("Tab");
    await assertResult(id, before, { kind: "input", value: String(value) });
  };
  await page.waitForFunction(() => !document.querySelector("#updateToast").hidden);
  await click("updateToast"); await click("settingsCloseButton");

  // Import/workspace: all three file pickers are exercised with the browser
  // File System Access fixture, and the explicit path uses a real key press.
  await click("pickFolder");
  await input("folderPath", "G:\\fixture");
  await click("pickImages"); await click("pickFolder"); await click("pickFolderFiles");
  await click("pickFolder"); await click("loadFolderButton"); await page.waitForFunction(() => state.images.some((image) => image.id === "sample")); await closeDialogs();
  // Folder loading replaces the thumbnail-backed bitmap; re-enter the same
  // normal-size editor fixture before pointer-only controls continue.
  await setupFixture();

  // Gallery/editor controls operate after a genuine gallery selection.
  for (const id of ["brushTool", "bucketTool", "mosaicEraserTool", "eraserTool", "excludeBucketTool", "excludeEraserTool"]) await click(id);
  for (const id of ["rectangleTool", "polygonTool", "boundaryBrushTool"]) { await click("boundaryTool"); await click(id); }
  for (const id of ["singleViewButton", "compareViewButton", "singleViewButton", "fitButton", "mosaicPreviewButton"]) await click(id);
  await click("collapseGalleryButton"); await click("collapseGalleryButton");
  await click("collapseInspectorButton"); await click("collapseInspectorButton");
  await page.setViewportSize({ width: 1024, height: 900 });
  const galleryHeading = await page.evaluate(() => {
    const title = document.querySelector(".gallery-heading h2").getBoundingClientRect();
    const action = document.querySelector("#batchMoreButton").getBoundingClientRect();
    const close = document.querySelector("#collapseGalleryButton").getBoundingClientRect();
    return { titleRight: title.right, actionLeft: action.left, actionRight: action.right, closeLeft: close.left, localCountHidden: getComputedStyle(document.querySelector(".gallery-local-count")).display === "none" };
  });
  assert.equal(galleryHeading.localCountHidden, true, "1024px gallery hides the secondary local count before it can overlap the heading action");
  assert.ok(galleryHeading.titleRight <= galleryHeading.actionLeft, "1024px gallery title and all-images action do not overlap");
  assert.ok(galleryHeading.actionRight <= galleryHeading.closeLeft, "1024px gallery all-images action and close control do not overlap");
  await page.setViewportSize({ width: 1280, height: 900 });
  await input("brushSize", "50"); await input("divisor", "101"); await click("bucketTool"); await input("bucketTolerance", "21");
  await click("mosaicHelpButton"); await click("mosaicHelpCloseButton");
  await page.locator("#compareViewButton").click();
  const compareCanvas = await page.locator("#editorCanvas").boundingBox();
  const splitterBefore = await page.locator("#compareSplitter").boundingBox();
  assert.deepEqual(await page.locator("#compareSplitter").evaluate((node) => ({ touchAction: getComputedStyle(node).touchAction, userSelect: getComputedStyle(node).userSelect })), { touchAction: "none", userSelect: "none" }, "the compare splitter owns touch dragging without text selection");
  await page.mouse.move(splitterBefore.x + splitterBefore.width / 2, splitterBefore.y + splitterBefore.height / 2); await page.mouse.down(); await page.mouse.move(compareCanvas.x + compareCanvas.width * .3, splitterBefore.y + splitterBefore.height / 2); await page.mouse.up();
  assert.equal(await page.locator("#compareSplitter").getAttribute("aria-valuenow"), "30", "pointer dragging fixes the compare split at 30 percent");
  await page.locator("#compareSplitter").focus(); await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await page.locator("#compareSplitter").getAttribute("aria-valuenow"), "35", "Shift+Arrow adjusts the compare split by five percent");
  await page.keyboard.press("Home"); assert.equal(await page.locator("#compareSplitter").getAttribute("aria-valuenow"), await page.locator("#compareSplitter").getAttribute("aria-valuemin"), "Home moves the compare split to its dynamic minimum");
  await page.keyboard.press("End"); assert.equal(await page.locator("#compareSplitter").getAttribute("aria-valuenow"), await page.locator("#compareSplitter").getAttribute("aria-valuemax"), "End moves the compare split to its dynamic maximum");
  const splitterAfterKeys = await page.locator("#compareSplitter").boundingBox();
  await page.mouse.move(splitterAfterKeys.x + splitterAfterKeys.width / 2, splitterAfterKeys.y + splitterAfterKeys.height / 2); await page.mouse.down(); await page.mouse.move(compareCanvas.x + compareCanvas.width * .5, splitterAfterKeys.y + splitterAfterKeys.height / 2); await page.mouse.up();
  const compareBefore = await page.evaluate(() => ({ history: state.history.length, scale: state.view.scale, x: state.view.x, y: state.view.y, right: state.view.x + stage.clientWidth * state.compareSplit, singlePressed: $("#singleViewButton").getAttribute("aria-pressed"), comparePressed: $("#compareViewButton").getAttribute("aria-pressed") }));
  assert.deepEqual({ singlePressed: compareBefore.singlePressed, comparePressed: compareBefore.comparePressed }, { singlePressed: "false", comparePressed: "true" }, "compare buttons are an exclusive accessible toggle");
  await click("brushTool");
  const rightStroke = await page.evaluate(() => {
    const rect = canvas.getBoundingClientRect(); const offset = stage.clientWidth * state.compareSplit;
    const y = rect.top + state.view.y + state.currentImage.height * state.view.scale * .5;
    return { start: { x: rect.left + offset + state.view.x + state.currentImage.width * state.view.scale * .75, y }, end: { x: rect.left + offset + state.view.x + state.currentImage.width * state.view.scale * .25, y } };
  });
  await page.mouse.move(rightStroke.start.x, rightStroke.start.y);
  await page.mouse.down(); await page.mouse.move(rightStroke.end.x, rightStroke.end.y); await page.mouse.up();
  await page.waitForFunction((history) => state.history.length > history, compareBefore.history);
  const rightEdit = await page.evaluate(() => ({ history: state.history.length, points: state.history.at(-1)?.points || [], width: state.currentImage.width, scale: state.view.scale, x: state.view.x, right: state.view.x + stage.clientWidth * state.compareSplit }));
  const rightSpan = Math.max(...rightEdit.points.map((point) => point.x)) - Math.min(...rightEdit.points.map((point) => point.x));
  assert.ok(rightEdit.points.length > 1 && rightSpan <= rightEdit.width && rightEdit.points.at(-1).x < rightEdit.points[0].x, "a right-pane stroke remains one shared-image stroke with the selected split");
  assert.equal(rightEdit.right - rightEdit.x, await page.locator("#canvasStage").evaluate((node) => node.clientWidth * state.compareSplit), "both compare panes retain one shared view transform");
  await page.mouse.move(rightStroke.start.x, rightStroke.start.y); await page.mouse.wheel(0, 120);
  const rightZoom = await page.evaluate(() => ({ scale: state.view.scale, x: state.view.x, y: state.view.y }));
  assert.ok(rightZoom.scale < rightEdit.scale, "wheel zoom-out from the right pane updates the shared transform");
  const leftPanStart = await page.evaluate(() => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + state.view.x + state.currentImage.width * state.view.scale * .25, y: rect.top + state.view.y + state.currentImage.height * state.view.scale * .5 };
  });
  await page.mouse.move(leftPanStart.x, leftPanStart.y); await page.mouse.down({ button: "middle" }); await page.mouse.move(leftPanStart.x + 12, leftPanStart.y + 8); await page.mouse.up({ button: "middle" });
  const leftPan = await page.evaluate(() => ({ x: state.view.x, y: state.view.y, scale: state.view.scale }));
  assert.deepEqual({ x: Math.round(leftPan.x - rightZoom.x), y: Math.round(leftPan.y - rightZoom.y), scale: leftPan.scale }, { x: 12, y: 8, scale: rightZoom.scale }, "middle pan from either pane keeps the shared compare transform synchronized");
  await click("boundaryTool"); await click("rectangleTool");
  const rightBoundary = await page.evaluate(() => {
    state.compareSplit = .5; updateCompareSplitter(); fitImage();
    const rect = canvas.getBoundingClientRect(); const offset = stage.clientWidth * state.compareSplit;
    const point = (ratio) => ({ x: rect.left + offset + state.view.x + state.currentImage.width * state.view.scale * ratio, y: rect.top + state.view.y + state.currentImage.height * state.view.scale * ratio });
    return { start: point(.35), end: point(.62) };
  });
  await page.mouse.move(rightBoundary.start.x, rightBoundary.start.y); await page.mouse.down(); await page.mouse.move(rightBoundary.end.x, rightBoundary.end.y); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector("#boundaryActions").hidden);
  await click("boundaryTool"); await click("boundaryBrushTool");
  const rightCursor = await page.evaluate(() => {
    const rect = canvas.getBoundingClientRect(); const offset = stage.clientWidth * state.compareSplit;
    return { x: rect.left + offset + state.view.x + state.currentImage.width * state.view.scale * .5, y: rect.top + state.view.y + state.currentImage.height * state.view.scale * .5 };
  });
  await page.mouse.move(rightCursor.x, rightCursor.y);
  const sideBoundBefore = await page.evaluate(() => {
    const action = document.querySelector("#boundaryActions").getBoundingClientRect(); const cursor = document.querySelector("#brushCursor").getBoundingClientRect();
    return { actionLeft: action.left, anchor: boundaryActionAnchor(), cursorLeft: cursor.left, split: state.compareSplit, width: stage.clientWidth };
  });
  await page.locator("#compareSplitter").focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForFunction(() => Math.abs(state.compareSplit - .7) < .01);
  const sideBoundAfter = await page.evaluate(() => {
    const action = document.querySelector("#boundaryActions").getBoundingClientRect(); const cursor = document.querySelector("#brushCursor").getBoundingClientRect();
    return { actionLeft: action.left, anchor: boundaryActionAnchor(), cursorLeft: cursor.left, split: state.compareSplit, width: stage.clientWidth };
  });
  const splitDelta = Math.round(sideBoundAfter.width * (sideBoundAfter.split - sideBoundBefore.split));
  assert.ok(Math.abs((sideBoundAfter.anchor.left - sideBoundBefore.anchor.left) - splitDelta) <= 1, "moving the split relocates the right-side boundary action anchor without retaining its old pixel offset");
  assert.ok(Math.abs((sideBoundAfter.cursorLeft - sideBoundBefore.cursorLeft) - splitDelta) <= 1, "moving the split relocates the right-side brush cursor without retaining its old pixel offset");
  await page.locator("#singleViewButton").click();
  const singleBoundaryAnchor = await page.evaluate(() => {
    const anchor = boundaryActionAnchor(); const roi = boundaryDraftBounds(activeBoundaryShape() || state.boundaryDrafts.find((draft) => draft.id === state.boundaryActiveId) || state.boundaryDrafts.at(-1));
    return { actual: anchor.left, expected: state.view.x + roi.left * state.view.scale };
  });
  assert.ok(Math.abs(singleBoundaryAnchor.actual - singleBoundaryAnchor.expected) <= 1, "single view removes the right-side boundary offset");
  await page.locator("#compareViewButton").click();
  const restoredBoundaryAnchor = await page.evaluate(() => {
    const anchor = boundaryActionAnchor(); const roi = boundaryDraftBounds(activeBoundaryShape() || state.boundaryDrafts.find((draft) => draft.id === state.boundaryActiveId) || state.boundaryDrafts.at(-1));
    return { actual: anchor.left, expected: compareSplitX() + state.view.x + roi.left * state.view.scale };
  });
  assert.ok(Math.abs(restoredBoundaryAnchor.actual - restoredBoundaryAnchor.expected) <= 1, "returning to compare restores the boundary action to the current right-side split");
  await page.locator("#singleViewButton").click(); await click("fitButton");
  await page.evaluate(() => { state.manualMaskPresent = true; renderCandidates(); });
  for (const selector of ["[data-candidate-batch]", "[data-candidate-display-toggle]", "[data-candidate-effective-toggle]"]) {
    const before = await snapshot(); await page.locator(selector).first().click();
    await markDynamic(selector, before, (prior, after) => {
      if (selector === "[data-candidate-batch]") apiChanged(prior, after, "candidate batch", "/api/candidates/batch");
      else assert.notDeepEqual(after.state.candidateDisplayModes, prior.state.candidateDisplayModes, `${selector} must change candidate display mode`);
    });
  }
  await click("brushTool");
  const ledgerCanvas = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(ledgerCanvas.x + ledgerCanvas.width / 2, ledgerCanvas.y + ledgerCanvas.height / 2);
  await page.mouse.down(); await page.mouse.move(ledgerCanvas.x + ledgerCanvas.width / 2 + 8, ledgerCanvas.y + ledgerCanvas.height / 2 + 8); await page.mouse.up();
  await page.waitForFunction(() => state.history.length > 0);
  await click("undoButton"); await click("redoButton");
  for (const id of ["detectTargetPenis", "detectTargetPussy", "confidence"]) await input(id, id === "confidence" ? "0.51" : true);

  // Detection includes the disabled boundary action before a boundary is
  // created by the main pixel scenario.  The disabled state is asserted here;
  // all start/cancel/pause controls are then enabled by a real detection run.
  assert.equal(await page.locator("#boundaryDetectButton").isDisabled(), true, "boundary detection is disabled until a boundary is drawn");
  const boundaryDragPoints = () => page.evaluate(() => {
    const rect = canvas.getBoundingClientRect();
    const point = (ratio) => ({ x: rect.left + state.view.x + state.currentImage.width * state.view.scale * ratio, y: rect.top + state.view.y + state.currentImage.height * state.view.scale * ratio });
    return { start: point(.25), end: point(.75) };
  });
  const dragBoundary = async () => {
    const { start, end } = await boundaryDragPoints();
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y); await page.mouse.up();
  };
  await click("boundaryTool"); await click("rectangleTool");
  await dragBoundary();
  await page.waitForFunction(() => !document.querySelector("#boundaryActions").hidden);
  await click("boundaryDetectButton");
  await page.waitForTimeout(50);
  if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
  await click("boundaryTool"); await click("rectangleTool");
  await dragBoundary();
  await page.waitForFunction(() => !document.querySelector("#boundaryActions").hidden);
  await click("boundaryCancelButton");
  await click("detectCurrentButton");
  await click("processingCancelButton");
  await page.waitForFunction(() => state.job?.kind === "detect" && state.job?.state === "running" && state.job?.cancelRequested === true);
  finishCancel();
  await page.evaluate(() => pollJob());
  await page.waitForFunction(() => !document.querySelector("#processingDialog").open && state.processing === null);
  await closeDialogs();
  await setupFixture();
  await click("detectAllButton");
  await input("detectParallelism", "1"); await input("dialogTargetPenis", true); await input("dialogTargetPussy", true); await input("detectConfidenceRange", "0.52"); await input("detectConfidenceNumber", "0.53");
  await click("detectCancelButton"); await click("detectAllButton"); await click("detectStartButton");
  await click("processingPauseButton");
  await page.waitForFunction(() => state.processing?.state === "paused");
  await click("processingPauseButton");
  await page.waitForFunction(() => state.processing?.state === "running");
  await click("processingCancelButton");
  await page.waitForFunction(() => state.job?.kind === "detect" && state.job?.state === "running" && state.job?.cancelRequested === true);
  finishCancel();
  await page.evaluate(() => pollJob());
  await page.waitForFunction(() => !document.querySelector("#processingDialog").open && state.processing === null);
  await closeDialogs(); await setupFixture();

  // Navigation and context menu use their actual selected-image handlers.
  const galleryBefore = await snapshot(); await page.locator('.gallery-item[data-id="sample-two"]').click();
  await page.waitForFunction(() => state.currentId === "sample-two");
  await markDynamic(".gallery-item", galleryBefore, (prior, after) => assert.equal(after.state.current, "sample-two", "gallery item must select sample-two"));
  await click("previousImageButton"); await click("nextImageButton");
  for (const id of ["reviewAndNextButton", "hideAndNextButton", "removeCurrentImageButton"]) await click(id);
  await page.locator('.gallery-item[data-id="sample"]').click();
  for (const id of ["toggleReviewMenuItem", "copyImagePathMenuItem", "removeImageMenuItem"]) {
    await page.locator('.gallery-item[data-id="sample"]').click({ button: "right" }); await click(id);
  }
  await closeDialogs();
  await setupFixture(); await click("removeAndNextButton");
  if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await click("confirmAccept");
  await setupFixture();

  // Overview and its dynamic controls.  Batch mode is asserted disabled in
  // edit view then enabled by the actual overview transition.
  await input("galleryFilter", "all"); await click("overviewButton");
  assert.equal(await page.locator("#batchModeButton").isDisabled(), false, "overview enables batch mode when images exist");
  await click("batchModeButton"); await input("overviewQuery", "sample");
  await page.evaluate(() => { state.images.forEach((image) => { image.relativePath = `ledger-folder/${image.id}.png`; }); renderOverview(); });
  await input("overviewFolder", "ledger-folder");
  await page.locator('[data-overview-filter="reviewed"]').click();
  const overviewFilterBefore = await snapshot(); await page.locator('[data-overview-filter="all"]').click();
  await markDynamic("[data-overview-filter]", overviewFilterBefore, (prior, after) => assert.equal(after.state.overviewFilter, "all", "overview filter must set all"));
  const overviewItemBefore = await snapshot(); await page.locator(".overview-item").last().click();
  await markDynamic(".overview-item", overviewItemBefore, (prior, after) => assert.notDeepEqual(after.state.selectedImageIds, prior.state.selectedImageIds, "overview item must change the selected image set in batch mode"));
  await click("selectionActionsButton"); const selectionBefore = await snapshot(); await page.locator('[data-selection-action="reviewed"]').click();
  await markDynamic("[data-selection-action]", selectionBefore, (prior, after) => apiChanged(prior, after, "selection action", "/api/")); await click("selectionClearButton"); await click("closeOverviewButton");

  // Saving exposes every option on the actual dialog.  The fixture accepts a
  // submission so pause/cancel are reached through a running save job.
  await setupFixture(); await click("brushTool");
  const clearCanvas = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(clearCanvas.x + clearCanvas.width / 2, clearCanvas.y + clearCanvas.height / 2);
  await page.mouse.down(); await page.mouse.move(clearCanvas.x + clearCanvas.width / 2 + 8, clearCanvas.y + clearCanvas.height / 2 + 8); await page.mouse.up();
  await page.evaluate(() => { state.blinkCandidateIds.add("manual:apply"); state.blinkModes.set("manual:apply", "normal"); state.blinkPhase = true; state.blinkTimer = setInterval(() => {}, 1000); flushRender(); });
  await page.waitForFunction(() => !document.querySelector("#clearCurrentMasksButton").disabled); await click("clearCurrentMasksButton");
  if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await click("confirmAccept");
  await page.waitForFunction(() => {
    const empty = (target) => { const data = target.getContext("2d").getImageData(0, 0, target.width, target.height).data; for (let index = 3; index < data.length; index += 4) if (data[index]) return false; return true; };
    return empty(combinedCanvas) && empty(effectiveExclusionCanvas)
      && state.blinkCandidateIds.size === 0 && state.blinkModes.size === 0 && state.blinkTimer === null;
  });
  await setupFixture(); await click("brushTool");
  const saveCanvas = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(saveCanvas.x + saveCanvas.width / 2, saveCanvas.y + saveCanvas.height / 2);
  await page.mouse.down(); await page.mouse.move(saveCanvas.x + saveCanvas.width / 2 + 8, saveCanvas.y + saveCanvas.height / 2 + 8); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector("#saveButton").disabled);
  await click("saveButton");
  for (const [id, value] of [["singleSaveCopyMode", true], ["singleSaveSuffix", "_ledger"], ["singleSaveDeleteOriginal", true]]) await input(id, value);
  await click("singleSaveChooseOutputDirectoryButton");
  await input("singleSaveOverwriteMode", true);
  // Keep the public save operation observable.  A fast fixture response can
  // otherwise finish between clicking Start and the state assertion below.
  holdSaveRender(true);
  await click("singleSaveStartButton");
  await click("confirmAccept");
  await page.waitForFunction(() => state.saving);
  releaseSaveRenders();
  await page.waitForFunction(() => !state.saving);
  await input("singleSaveCopyMode", true); await click("singleSaveCloseButton");
  await page.evaluate(() => { addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, 1, 1); markMaskDirty(); refreshMaskStatus(true); });
  await page.waitForFunction(() => !document.querySelector("#saveAllButton").disabled);
  await click("saveAllButton");
  for (const [id, value] of [["applyTargetMode", "masked"], ["applyCopyMode", true], ["applySuffix", "_ledger"], ["deleteOriginal", true], ["applyDivisor", "102"]]) await input(id, value);
  await click("chooseOutputDirectoryButton"); await page.waitForTimeout(50);
  if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
  await input("applyOverwriteMode", true); await input("applyCopyMode", true); await click("applyCloseButton");
  await setupFixture(); await click("brushTool");
  const runningSaveCanvas = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(runningSaveCanvas.x + runningSaveCanvas.width / 2, runningSaveCanvas.y + runningSaveCanvas.height / 2);
  await page.mouse.down(); await page.mouse.move(runningSaveCanvas.x + runningSaveCanvas.width / 2 + 8, runningSaveCanvas.y + runningSaveCanvas.height / 2 + 8); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector("#saveAllButton").disabled); await click("saveAllButton"); await click("chooseOutputDirectoryButton");
  if (await page.locator("#deleteOriginal").isDisabled()) assert.equal(await page.locator("#deleteOriginal").isChecked(), false, "an unavailable source-delete action stays safely unchecked");
  else await input("deleteOriginal", false);
  holdSaveRender(true); await click("applyStartButton");
  await page.waitForFunction(() => !document.querySelector("#applyPauseButton").hidden);
  await click("applyPauseButton"); await click("applyCancelButton"); releaseSaveRenders(); await page.waitForFunction(() => !state.saving); await click("applyCloseButton");
  await click("saveAllButton"); await click("applyCloseButton");
  await page.waitForTimeout(100);
  if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();

  // Confirmation/error dialogs are opened from their public controls.
  await setupFixture();
  await click("batchMoreButton"); await click("clearAllMasksButton"); await input("confirmNeverShow", true); await click("confirmAccept"); await page.waitForTimeout(50);
  await page.waitForFunction(() => !state.masksClearing && !state.catalogMutation);
  if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
  await setupFixture();
  const catalogBefore = await snapshot(); await click("batchMoreButton"); await click("clearCatalogButton"); await click("confirmAccept");
  await page.waitForFunction(() => state.images.length === 0);
  const catalogAfter = await snapshot();
  assertCatalogClearResult({ api: catalogAfter.api.slice(catalogBefore.api.length) }, { imageIds: catalogAfter.state.imageIds });
  await page.evaluate(() => showUserError(new Error("ledger fixture error")));
  await click("errorDialogClose");
  for (const [locale, expected] of [["ja", ["モデルをダウンロードできません", "選択中のモデルはダウンロード対象として登録されていません。", "設定の検出タブで対象のモデルを選び直してから、もう一度実行してください。"]], ["en", ["Model download is unavailable", "The selected model is not registered for download.", "Choose a listed model in Settings > Detection, then try again."]]]) {
    await page.evaluate(async (language) => { await loadTranslations(language); showUserError(codedError("model_download_invalid")); }, locale);
    assert.deepEqual(await page.evaluate(() => [document.querySelector("#errorDialogTitle").textContent, document.querySelector("#errorDialogCause").textContent, document.querySelector("#errorDialogAction").textContent]), expected, `model_download_invalid has an exact ${locale} presentation`);
    await page.locator("#errorDialogClose").click();
  }
  await page.evaluate(() => loadTranslations("ja"));

  // Settings covers all tabs and every model toggle/file field.  The values
  // are changed through the form and saved, so the result is a POST payload,
  // not merely a visual state change.
  await click("settingsButton");
  for (const id of ["settingsTabGeneral", "settingsTabModels", "settingsTabDisplay", "settingsTabShortcuts", "settingsTabConfirm", "settingsTabInfo"]) await click(id);
  await click("settingsTabGeneral");
  for (const [id, value] of [["settingsLanguage", "en"], ["settingsPort", "8767"], ["settingsDefaultOutputDirectory", "G:\\output"], ["settingsImportParallelism", "2"], ["settingsSaveParallelism", "1"], ["settingsOpenBrowser", true]]) await input(id, value);
  await click("settingsChooseOutputDirectory"); await page.waitForTimeout(50);
  if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
  await click("settingsTabModels");
  await input("settingsTargetModel", "gpu-options.onnx"); await input("settingsProvider", "gpu");
  await page.waitForFunction(() => document.querySelectorAll("#settingsGpuDevice option").length > 1);
  await input("settingsGpuDevice", "4"); await input("settingsProvider", "cpu");
  for (const [id, value] of [["settingsTargetModel", "target.onnx"], ["settingsNtd11Toggle", true], ["settingsNtd11Model", "ntd.onnx"], ["settingsSensitiveToggle", true], ["settingsSensitiveModel", "sensitive.onnx"], ["settingsPrecisionToggle", true]]) await input(id, value);
  if (await page.locator("#settingsSamModel").isDisabled()) { await page.locator("#settingsPrecisionToggle").focus(); await page.locator("#settingsPrecisionToggle").press("Space"); }
  await input("settingsSamModel", "sam.pth");
  for (const [id, value] of [["settingsHandToggle", true], ["settingsHandModel", "hand.onnx"], ["settingsHandSegmentationToggle", true], ["settingsHandSegmentationModel", "hand.safetensors"], ["settingsFluidToggle", true]]) await input(id, value);
  await page.locator('input[name="settingsSamVariant"][value="vit_b"]').check();
  const samVariantBefore = await snapshot(); await page.locator('input[name="settingsSamVariant"][value="vit_l"]').check();
  await markDynamic('input[name=settingsSamVariant]', samVariantBefore, (prior, after) => assert.notEqual(after.controls.settingsSamType.value, prior.controls.settingsSamType.value, "SAM variant must change the selected variant"));
  const pickerBefore = await snapshot(); await page.locator("[data-model-picker]").first().click();
  await markDynamic("[data-model-picker]", pickerBefore, (prior, after) => apiChanged(prior, after, "model picker", "/api/model-file/pick"));
  const modelDownloadBefore = await snapshot(); await page.locator('[data-model-download="sam"]').click();
  await markDynamic("[data-model-download]", modelDownloadBefore, (prior, after) => assert.equal(after.dialogs.modelDownloadDialog, true, "model download link must open its dialog"));
  await click("modelDownloadStart"); await page.waitForFunction(() => !document.querySelector("#modelDownloadCancel").hidden); await click("modelDownloadCancel"); await click("modelDownloadClose");
  const modelHelpBefore = await snapshot(); await page.locator('[data-model-help="ntd11"]').click();
  await markDynamic("[data-model-help]", modelHelpBefore, (prior, after) => assert.equal(after.dialogs.modelHelpDialog, true, "model help link must open its dialog")); await click("modelHelpCopy"); await click("modelHelpCloseButton");
  await click("settingsTabDisplay");
  for (const [id, value] of [["settingsApplyColor", "#113355"], ["settingsExcludeColor", "#335511"], ["settingsOpacity", "0.7"], ["settingsMosaicPreview", true], ["settingsExcludeForcedDefault", true]]) await input(id, value);
  await click("settingsTabShortcuts"); await input("settingsShortcutsEnabled", true);
  await click("settingsTabConfirm"); for (const id of ["confirmClearMasks", "confirmClearCatalog", "confirmRemoveImage", "confirmCandidateDelete", "confirmCandidateRoleDelete", "confirmOverwriteSource", "confirmDeleteSourceAfterCopy"]) await input(id, true);
  await click("settingsTabInfo"); await click("checkUpdateButton");
  if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmDialog").press("Escape");
  await click("settingsResetButton"); await click("settingsSaveButton"); await click("settingsCloseButton");

  // Static controls that are only visible in a model dialog are explicitly
  // opened last.  This also gives the copy controls a clipboard result.
  await click("settingsButton"); await click("settingsTabModels"); await page.locator('[data-model-download="ntd11"]').click(); await click("modelDownloadCopy"); await click("modelDownloadClose"); await page.locator('[data-model-help="ntd11"]').click(); await click("modelHelpCopy"); await click("modelHelpCloseButton"); await click("settingsCloseButton");

  const activeContracts = contracts.filter((control) => !control.exemptReason);
  const missing = activeContracts.filter((control) => !operated.has(control.id)).map((control) => `${control.assertionId} (${control.id})`);
  const failedAssertions = activeContracts.filter((control) => !assertionPassed.has(control.assertionId)).map((control) => control.assertionId);
  assert.equal(missing.join("\n"), "", `all ${activeContracts.length} operable static controls are operated through Playwright\n${missing.join("\n")}`);
  assert.equal(failedAssertions.join("\n"), "", `all ${activeContracts.length} operable static controls have a concrete passing assertion\n${failedAssertions.join("\n")}`);
  // Dynamic entries have explicit fixture coverage above; query their public
  // selectors after the scenario as a guard against selector drift.
  const missingDynamic = dynamicContracts.filter((control) => !operated.has(control.selector)).map((control) => `${control.assertionId} (${control.selector})`);
  const failedDynamicAssertions = dynamicContracts.filter((control) => !assertionPassed.has(control.assertionId)).map((control) => control.assertionId);
  assert.deepEqual(missingDynamic, [], `all ${dynamicContracts.length} dynamic controls are operated through Playwright`);
  assert.deepEqual(failedDynamicAssertions, [], `all ${dynamicContracts.length} dynamic controls have a concrete passing assertion`);
}

async function main() {
  let server;
  let browser;
  let fixtureUrl;
  let detectRequests, applyRequests, saveRequests, catalogRemoveRequests, folderRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs, modelDownloadPolls, resetScenario, setCatalog, resetJob, finishCancel, finishApply, setUpdateAvailable;
  let settingsRequests;
  let settingsActions;
  let settingsStatusRequests;
  let updateRequests;
  let cancelRequests, holdDetection, holdSaveRender, releaseSaveRenders, failCancel, failNextSettingsSave, failModelDownloadStatus, resetModelDownload;
  let deferFullSettings;
  let releaseNextFullSettings, releaseFullSettings;
  let deferUpdateStatus, releaseUpdateStatus;
  try {
    ({ server, url: fixtureUrl, detectRequests, applyRequests, saveRequests, catalogRemoveRequests, folderRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs, modelDownloadPolls, cancelRequests, holdDetection, holdSaveRender, releaseSaveRenders, failCancel, failNextSettingsSave, failModelDownloadStatus, resetModelDownload, resetScenario, setCatalog, resetJob, finishCancel, finishApply, setUpdateAvailable, deferFullSettings, releaseNextFullSettings, releaseFullSettings, deferUpdateStatus, releaseUpdateStatus } = await startFixtureServer());
    browser = await chromium.launch();
    // A real unsupported-browser bootstrap must stop before any API request or
    // editor binding. This covers the user-visible File System Access contract.
    const unsupportedBrowserPage = await newCoveredPage(browser);
    await unsupportedBrowserPage.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showDirectoryPicker;
    });
    await unsupportedBrowserPage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await unsupportedBrowserPage.waitForFunction(() => document.body.textContent.includes("File System Access API"));
    assert.match(await unsupportedBrowserPage.locator("body").textContent(), /File System Access API/, "unsupported browsers receive the startup requirement");
    await stopCoveredPage(unsupportedBrowserPage, true);
    // Bootstrap tolerates a missing translation payload and an empty root,
    // while an image-list transport failure remains a visible user error.
    const degradedBootstrapPage = await newCoveredPage(browser);
    await degradedBootstrapPage.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0]?.url || args[0]);
        if (url.includes("/i18n/")) return new Response("unavailable", { status: 503 });
        if (url.includes("/api/settings?status=0")) {
          const response = await originalFetch(...args); const body = await response.json();
          delete body.settings.general.shortcuts_enabled;
          return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/api/images")) {
          const response = await originalFetch(...args); const body = await response.json(); body.root = "";
          return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        }
        return originalFetch(...args);
      };
    });
    await degradedBootstrapPage.goto(fixtureUrl, { waitUntil: "networkidle" });
    assert.equal(await degradedBootstrapPage.locator("#folderPath").inputValue(), "", "an empty catalogue root remains an empty folder field");
    await stopCoveredPage(degradedBootstrapPage, true);
    const settingsFailurePage = await newCoveredPage(browser);
    await settingsFailurePage.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => String(args[0]?.url || args[0]).includes("/api/settings?status=0")
        ? Promise.reject(new Error("settings unavailable"))
        : fetchOriginal(...args);
    });
    await settingsFailurePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await settingsFailurePage.waitForFunction(() => !document.querySelector("#connectionStatus").hidden);
    assert.equal(await settingsFailurePage.locator("#connectionStatus").textContent(), "Mozarieに接続できません", "initial settings failure uses the inline connection status");
    assert.equal(await settingsFailurePage.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "initial settings failure does not open an error dialog");
    await settingsFailurePage.locator("#settingsButton").click();
    assert.equal(await settingsFailurePage.locator("#settingsDialog").evaluate((dialog) => dialog.open), false, "the editor is not bound when initial settings are unavailable");
    await stopCoveredPage(settingsFailurePage, true);
    const connectionRecoveryPage = await newCoveredPage(browser);
    await connectionRecoveryPage.addInitScript(() => {
      window.__connectionOffline = false;
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => String(args[0]?.url || args[0]).includes("/api/job") && window.__connectionOffline
        ? Promise.reject(new Error("fixture offline"))
        : fetchOriginal(...args);
    });
    await connectionRecoveryPage.goto(fixtureUrl, { waitUntil: "networkidle" });
    await connectionRecoveryPage.evaluate(async () => {
      window.__connectionOffline = true;
      state.pollFailures = 2;
      await pollJob();
    });
    await connectionRecoveryPage.waitForFunction(() => !document.querySelector("#connectionStatus").hidden);
    assert.equal(await connectionRecoveryPage.locator("#connectionStatus").textContent(), "Mozarieに接続できません", "three failed polls show the inline connection status");
    assert.equal(await connectionRecoveryPage.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "failed polls do not open an error dialog");
    await connectionRecoveryPage.evaluate(async () => {
      window.__connectionOffline = false;
      await pollJob();
    });
    await connectionRecoveryPage.waitForFunction(() => document.querySelector("#connectionStatus").hidden);
    assert.equal(await connectionRecoveryPage.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "a recovered poll clears the inline connection status without a dialog");
    await connectionRecoveryPage.evaluate(async () => {
      try { await api("/missing"); } catch (error) { showUserError(error); }
    });
    await connectionRecoveryPage.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await connectionRecoveryPage.locator("#connectionStatus").isHidden(), true, "an HTTP error keeps the recovered connection status cleared");
    await connectionRecoveryPage.locator("#errorDialog").evaluate((dialog) => dialog.close());
    await stopCoveredPage(connectionRecoveryPage, true);
    const initialPage = await newCoveredPage(browser, { viewport: { width: 1280, height: 720 } });
    await initialPage.addInitScript(() => {
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => {
        const url = String(args[0]?.url || args[0]);
        if (url.includes("/api/images")) return new Promise((resolve) => { window.__releaseInitialImages = () => fetchOriginal(...args).then(resolve); });
        return fetchOriginal(...args);
      };
    });
    await initialPage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await initialPage.waitForFunction(() => typeof window.__releaseInitialImages === "function");
    assert.equal(await initialPage.locator("#connectionStatus").isHidden(), true, "the initial empty catalog has no header notice");
    assert.equal(await initialPage.locator("#canvasStage").evaluate((stage) => Math.round(stage.getBoundingClientRect().height)), 672, "the editor has no notification strip gap at 1280x720");
    assert.equal(await initialPage.evaluate(() => typeof setStatus), "function");
    await initialPage.evaluate(() => setStatus("Test notification"));
    assert.equal(await initialPage.locator("#connectionStatus").isVisible(), true, "setStatus shows the header notice");
    await initialPage.evaluate(() => clearStatus());
    assert.equal(await initialPage.locator("#connectionStatus").isHidden(), true, "clearStatus hides the header notice again");
    await stopCoveredPage(initialPage, true);

    // This is an actual browser catalogue load and control interaction.  It
    // protects the window renderer from quietly reverting to a full-DOM list.
    if (!browserCoverage) {
      setCatalog(Array.from({ length: 20000 }, (_, index) => ({
        id: `performance-${index}`,
        relativePath: `set-${String(index % 40).padStart(2, "0")}/image-${String(index).padStart(5, "0")}.png`,
        sourceKind: "fixture", width: 100, height: 80,
        candidateCount: 0, enabledCandidateCount: 0, reviewed: index % 2 === 0,
      })));
      const performancePage = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
      await performancePage.addInitScript(() => {
        window.showOpenFilePicker = async () => [];
        window.showDirectoryPicker = async () => ({ async *values() {} });
      });
      try {
        const loadStart = performance.now();
        await performancePage.goto(fixtureUrl, { waitUntil: "networkidle" });
        const loadElapsed = performance.now() - loadStart;
        const mounted = await performancePage.locator(".gallery-item, .overview-item").count();
        assert.ok(loadElapsed <= 1500, `20k catalogue becomes interactive within 1.5s (actual ${loadElapsed.toFixed(1)}ms)`);
        assert.ok(mounted < 2000, `20k catalogue keeps mounted cards below 2000 (actual ${mounted})`);
        const timings = [];
        for (let index = 0; index < 10; index += 1) {
          let started = performance.now();
          await performancePage.locator("#overviewButton").click();
          await performancePage.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
          timings.push(performance.now() - started);
          started = performance.now();
          await performancePage.locator("#closeOverviewButton").click();
          await performancePage.waitForFunction(() => document.querySelector("#overviewPane").hidden);
          timings.push(performance.now() - started);
          started = performance.now();
          await performancePage.locator("#galleryFilter").selectOption(index % 2 ? "reviewed" : "unreviewed");
          await performancePage.waitForFunction((filter) => state.galleryFilter === filter, index % 2 ? "reviewed" : "unreviewed");
          timings.push(performance.now() - started);
        }
        const p95 = [...timings].sort((left, right) => left - right)[Math.ceil(timings.length * 0.95) - 1];
        assert.ok(p95 <= 250, `gallery switch and filter p95 is within 250ms (actual ${p95.toFixed(1)}ms)`);
        console.log(`browser performance: 20k initial=${loadElapsed.toFixed(1)}ms mounted=${mounted} switch-filter-p95=${p95.toFixed(1)}ms`);
      } finally {
        await stopCoveredPage(performancePage, true);
        resetScenario();
      }
    }
    const page = await newCoveredPage(browser);
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => { window.__openFilesCalled = true; return []; };
      window.__ledgerPickers = { directory: 0 };
      window.showDirectoryPicker = async () => {
        window.__openDirectoryCalled = true;
        window.__ledgerPickers.directory += 1;
        const files = new Map();
        return {
          name: "ledger-output",
          async queryPermission() { return "granted"; },
          async getFileHandle(name, options = {}) {
            if (!options.create && !files.has(name)) throw new DOMException("missing", "NotFoundError");
            if (!files.has(name)) files.set(name, new Uint8Array());
            return { async createWritable() { return new WritableStream({ write(bytes) { files.set(name, new Uint8Array(bytes)); } }); } };
          },
          async *values() {},
        };
      };
      window.__copiedPaths = [];
      window.__clipboardFail = false;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (text) => {
          if (window.__clipboardFail) throw new DOMException("fixture clipboard failure", "NotAllowedError");
          window.__copiedPaths.push(text);
        },
      } });
    });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    // Keep the manifest presence check on an isolated page.  Do not use
    // HTMLElement.click() or synthetic input/change events here: those do not
    // prove that a user can operate a control, and (worse) used to count hidden
    // or disabled controls as tested.  The behavioural assertions below use
    // Playwright pointer/keyboard actions with their required application state.
    const inventoryPage = await newCoveredPage(browser);
    const inventoryErrors = [];
    inventoryPage.on("pageerror", (error) => inventoryErrors.push(error.message));
    for (const [width, language] of [[1024, "ja"], [1920, "en"]]) {
      await inventoryPage.setViewportSize({ width, height: 768 });
      await inventoryPage.goto(fixtureUrl, { waitUntil: "networkidle" });
      await inventoryPage.evaluate((locale) => loadTranslations(locale), language);
      const inventory = await inventoryPage.evaluate((contracts) => contracts.map(({ id }) => {
        const node = document.getElementById(id);
        return { id, present: Boolean(node) };
      }), uiControlManifest);
      assert.equal(inventory.every((control) => control.present), true, `all manifest controls remain in the ${language}/${width} DOM: ${JSON.stringify(inventory.filter((control) => !control.present))}`);
      await inventoryPage.waitForTimeout(25);
    }
    await stopCoveredPage(inventoryPage, true);
    assert.deepEqual(inventoryErrors, [], `inventory loading does not raise page errors: ${inventoryErrors.join("; ")}`);
    assert.equal(uiDynamicControlManifest.every((control) => control.selector && control.action && control.expected), true, "dynamic controls retain explicit action contracts");
    const favicon = await page.request.get(`${fixtureUrl}/favicon.ico`);
    assert.equal(favicon.status(), 200, "favicon is delivered by the static server");
    assert.match(favicon.headers()["content-type"] || "", /^image\/(?:x-icon|vnd\.microsoft\.icon)/, "favicon uses an icon MIME type");
    assert.ok((await favicon.body()).length > 0, "favicon response has icon data");
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/favicon.ico", "document uses the real favicon asset");
    assert.doesNotMatch(await page.locator("#connectionStatus").textContent(), /フォルダを選択してください|Choose an image folder/, "the header never presents the empty-catalog instruction");
    for (const [width, height] of [[1024, 768], [1920, 1080]]) {
      await assertConnectionStatusLayout(page, width, height, "ja");
      await assertConnectionStatusLayout(page, width, height, "en");
    }
    await page.evaluate(() => loadTranslations("ja"));
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, activeElapsed: 10 }));
    assert.match(await page.locator("#processingProgressText").textContent(), /残り約 20秒/, "detection ETA uses active elapsed time after the first completion");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "paused", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "paused detection hides ETA");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "complete", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "terminal detection hides ETA");
    await page.evaluate(() => showProcessing({ kind: "import", state: "running", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "imports never show a detection ETA");
    await page.evaluate(() => closeProcessing());
    const processingLayout = await page.locator("#processingDialog").evaluate((dialog) => ({
      describedBy: dialog.getAttribute("aria-describedby"),
      children: [...dialog.querySelector(".dialog-body").children].map((element) => element.id || element.className),
    }));
    assert.equal(processingLayout.describedBy, "processingProgressText processingCurrent", "the processing dialog describes progress before the current filename");
    assert.deepEqual(processingLayout.children, ["processingTitle", "processingProgress", "processingProgressText", "processingCurrent", "dialog-actions"], "processing shows progress, then the current filename, then actions");
    const processingStateBeforeFilenameChecks = await page.evaluate(() => ({
      images: state.images,
      detectionTargetIds: state.detectionTargetIds,
    }));
    await page.evaluate(() => {
      state.images = [
        { id: "one", relativePath: "001.png" },
        { id: "two", relativePath: "002.png" },
        { id: "three", relativePath: "003.png" },
      ];
      state.detectionTargetIds = ["one", "two", "three"];
    });
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 0, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: [] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "001.png", "detection shows the first unfinished filename rather than the last parallel worker update");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "001.png", "a later completed filename does not move the display ahead of earlier unfinished work");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "paused", total: 3, completed: 2, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["one", "three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "002.png", "paused detection keeps the earliest unfinished filename");
    await page.evaluate(() => closeProcessing());
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, current: "server.png", imageIds: [], completedImageIds: ["one"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "server.png", "current jobs use the server filename when no current image id is supplied");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 1, completed: 0, current: "optimistic.png", imageIds: ["not-in-catalog"], completedImageIds: [] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "optimistic.png", "unmapped active detection targets retain the server filename");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "complete", total: 3, completed: 3, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["one", "two", "three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "", "completed detection has no current filename");
    await page.evaluate((previous) => {
      state.images = previous.images;
      state.detectionTargetIds = previous.detectionTargetIds;
      closeProcessing();
    }, processingStateBeforeFilenameChecks);
    const fullSettingsBeforeOpen = settingsRequests.filter((search) => search === "").length;
    const settingsStatusBeforeOpen = settingsStatusRequests.length;
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsDialog").isVisible(), true, "settings opens immediately from the cached lightweight response");
    assert.equal(settingsRequests.filter((search) => search === "").length, fullSettingsBeforeOpen, "opening settings does not start a full status request");
    assert.equal(await page.locator("#settingsStatusButton").count(), 0, "settings has no manual model/GPU status button");
    assert.equal(await page.locator("#settingsStatusResult").count(), 0, "settings has no model/GPU status message");
    await page.locator("#settingsTabModels").click();
    await page.waitForFunction(() => document.querySelector("#settingsGpuDevice option:not(:disabled)"));
    assert.equal(settingsStatusRequests.length, settingsStatusBeforeOpen + 1, "the Models tab refreshes model and GPU status once");
    for (const selector of ['#settingsSamVariants input', '#settingsSamModel', '[data-model-picker="sam_checkpoint"]', '[data-model-download="sam"]']) {
      assert.equal(await page.locator(selector).first().isDisabled(), true, `standard mode disables ${selector}`);
    }
    await page.locator("#settingsPrecisionCard .model-switch-track").click();
    await page.waitForFunction(() => !document.querySelector("#settingsSamModel").disabled);
    for (const selector of ['#settingsSamVariants input', '#settingsSamModel', '[data-model-picker="sam_checkpoint"]', '[data-model-download="sam"]']) {
      assert.equal(await page.locator(selector).first().isDisabled(), false, `high precision enables ${selector}`);
    }
    await page.locator("#settingsProvider").evaluate((select) => { select.value = "cpu"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await page.locator("#settingsGpuDevice").isDisabled(), true, "CPU disables the GPU selector");
    await page.locator("#settingsProvider").evaluate((select) => { select.value = "gpu"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await page.locator("#settingsGpuDevice").isDisabled(), false, "GPU re-enables the GPU selector");
    assert.equal(await page.locator("#settingsHandSegmentationCard .model-card-note").count(), 0, "HandSeg matches the other model cards without an inline explanation");
    assert.equal(await page.locator("#settingsHandSegmentationCard a").count(), 0, "HandSeg keeps download information out of Settings");
    await page.locator('[data-model-help="handSegmentation"]').click();
    assert.equal(await page.locator("#modelHelpFile").textContent(), ".safetensors", "HandSeg help names its format");
    await page.locator("#modelHelpCloseButton").click();
    const statusesBeforeSamBrowse = settingsStatusRequests.length;
    await page.locator('[data-model-picker="sam_checkpoint"]').click();
    await page.waitForFunction(() => document.querySelector("#settingsSamModel").value === "C:\\models\\sam_vit_l_0b3195.pth");
    await page.waitForFunction(() => document.querySelector("#settingsGpuLoading").hidden);
    assert.equal(settingsStatusRequests.length, statusesBeforeSamBrowse + 1, "a successful model pick refreshes status once");
    assert.deepEqual(modelPickerRequests.at(-1), { modelKey: "sam_checkpoint", currentPath: "" }, "SAM browse posts its model key and current path");
    assert.equal(await page.locator("#settingsSamType").inputValue(), "vit_l", "known SAM filename synchronizes the model type without saving");
    assert.equal(await page.locator('input[name="settingsSamVariant"]:checked').inputValue(), "vit_l", "the matching accessible SAM radio is selected");
    await page.locator("#settingsSamModel").fill("C:\\custom\\large.pth");
    await page.locator('input[name="settingsSamVariant"][value="vit_h"]').check();
    await page.locator("#settingsSamModel").fill("C:\\custom\\huge.pth");
    await page.locator('input[name="settingsSamVariant"][value="vit_l"]').check();
    assert.equal(await page.locator("#settingsSamModel").inputValue(), "C:\\custom\\large.pth", "switching SAM variants preserves each path");
    await page.locator('input[name="settingsSamVariant"][value="vit_l"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator('input[name="settingsSamVariant"]:checked').inputValue(), "vit_h", "SAM radios support native keyboard navigation");
    await page.locator('input[name="settingsSamVariant"][value="vit_l"]').check();
    await page.waitForFunction(() => document.querySelector('[data-sam-status="vit_l"]').textContent.length > 0);
    assert.match(await page.locator('[data-sam-status="vit_l"]').textContent(), /外部ファイル|External file/, "configured SAM path is identified as external");
    assert.match(await page.locator('[data-sam-status="vit_b"]').textContent(), /未取得|Not acquired/, "unconfigured SAM variants remain selectable and show their status");
    const retainedSamPath = await page.locator("#settingsSamModel").inputValue();
    await page.locator("#settingsPrecisionCard .model-switch-track").click();
    assert.equal(await page.locator("#settingsSamModel").isDisabled(), true, "standard mode disables an existing SAM path without clearing it");
    assert.equal(await page.locator("#settingsSamModel").inputValue(), retainedSamPath, "standard mode keeps the existing SAM path for a later high precision run");
    await page.locator("#settingsPrecisionCard .model-switch-track").click();
    await page.waitForFunction(() => !document.querySelector("#settingsSamModel").disabled);
    await page.locator("#settingsTargetModel").fill("legacy-sam-status.onnx");
    await page.evaluate(() => refreshSettingsStatus());
    await page.waitForFunction(() => !document.querySelector('[data-sam-status="vit_b"]').textContent);
    assert.equal(await page.locator(".sam-variant.unacquired").count(), 0, "an older backend without SAM variants shows no misleading unacquired state");
    await page.locator("#settingsTargetModel").fill("unknown-vram.onnx");
    await page.evaluate(() => refreshSettingsStatus());
    await page.waitForFunction(() => document.querySelector("#settingsGpuDevice").textContent.includes("Unknown VRAM"));
    assert.doesNotMatch(await page.locator("#settingsGpuDevice").textContent(), /VRAM: - GB/, "an unknown VRAM value omits the VRAM fragment");
    await page.locator('[data-model-help="precision"]').click();
    assert.equal(await page.locator("#modelHelpSamTable").isVisible(), true, "contour help includes the SAM type comparison");
    await page.locator("#modelHelpCloseButton").click();
    const targetBeforeCancel = await page.locator("#settingsTargetModel").inputValue();
    const statusBeforeCancel = await page.locator("#settingsResult").textContent();
    const cancelResponse = page.waitForResponse((response) => response.url().includes("/api/model-file/pick") && response.status() === 200);
    await page.locator('[data-model-picker="target_segmentation"]').click();
    await cancelResponse;
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), targetBeforeCancel, "cancelled model browse leaves its input unchanged");
    assert.equal(await page.locator("#settingsResult").textContent(), statusBeforeCancel, "cancelled model browse leaves status unchanged");
    assert.equal(await page.locator("[data-model-download]").count(), 7, "model preparation and downloadable models expose their actions");
    const requestsBeforeModelPreparation = modelDownloadRequests.length;
    await page.locator('[data-model-download="ntd11"]').click();
    assert.equal(await page.locator("#modelDownloadDialog").isVisible(), true, "unsupported model download opens its own modal");
    assert.equal(await page.locator("#modelDownloadTitle").textContent(), "モデルを準備", "unsupported model opens the preparation title");
    assert.equal(await page.locator("#modelDownloadMessage").textContent(), "NTD11は成人向けの任意モデルです。Civitai.comへログインして年齢確認を済ませてから、下のリンクでZIPを取得・展開し、含まれる.ptをONNXへ変換して「参照」から指定してください。匿名アクセスで取得できるとは限りません。セットアップ後、Mozarieフォルダーで下のコマンドをPowerShellから実行してください。", "NTD11 download explains how to prepare its model");
    assert.equal(await page.locator("#modelDownloadItems .model-download-item").count(), 1, "unsupported download uses the same one-item layout");
    await assertExternalPreparationLink(page, "https://civitai.com/api/download/models/2350456?fileId=2240838", "NTD11");
    assert.equal(await page.locator("#modelDownloadCommand").textContent(), '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたNTD11の.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu', "NTD11 download shows its conversion command");
    for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadStart", "#modelDownloadCancel", "#modelDownloadActions"]) assert.equal(await page.locator(selector).isHidden(), true, `NTD11 hides ${selector}`);
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="sensitive"]').click();
    assert.equal(await page.locator("#modelDownloadMessage").textContent(), "Sensitiveは基本モデルの見落としを補う任意モデルです。配布元からSensitiveの.ptを取得し、ONNXへ変換して、「参照」から指定してください。セットアップ後、Mozarieフォルダーで下のコマンドをPowerShellから実行してください。", "Sensitive download explains how to prepare its model");
    await assertExternalPreparationLink(page, "https://huggingface.co/sugarknight/sensitive-detect/resolve/b7ec7a528841aac3d52411fb4d031d51a8225e40/sensitive_detect_v07.pt?download=true", "Sensitive");
    assert.equal(await page.locator("#modelDownloadCommand").textContent(), '& ".\\.venv\\Scripts\\yolo.exe" export model="ダウンロードしたSensitiveの.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu', "Sensitive download shows its conversion commands");
    await page.evaluate(() => { window.__copiedCommand = ""; navigator.clipboard.writeText = async (text) => { window.__copiedCommand = text; }; });
    await page.locator("#modelDownloadCopy").click();
    assert.match(await page.locator("#modelDownloadCopyResult").textContent(), /コピーしました|Copied/, "conversion command copy reports success locally");
    assert.match(await page.evaluate(() => window.__copiedCommand), /yolo\.exe" export/, "conversion command copy uses the Clipboard API");
    assert.equal(modelDownloadRequests.length, requestsBeforeModelPreparation, "preparation dialogs make no download API requests");
    assert.doesNotMatch(`${await page.locator("#modelDownloadMessage").textContent()} ${await page.locator("#modelDownloadStatus").textContent()}`, /MIT|ライセンスのまま|変換済みONNX|already converted/i, "Sensitive download omits implementation and license rationale");
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="sam"]').click();
    assert.equal(await page.locator("#modelDownloadTitle").textContent(), "モデルをダウンロード", "supported model restores the download title");
    for (const selector of ["#modelDownloadProgress", "#modelDownloadStatus", "#modelDownloadSecurity", "#modelDownloadActions", "#modelDownloadStart"]) assert.equal(await page.locator(selector).isHidden(), false, `supported model restores ${selector}`);
    assert.equal(modelDownloadRequests.length, 0, "opening a download confirmation does not start a request");
    assert.equal(await page.locator("#modelDownloadItems .model-download-item").count(), 1, "individual confirmation has one semantic item");
    assert.equal(await page.locator("#modelDownloadItems code").count(), 0, "download confirmation does not expose internal destination paths");
    assert.match(await page.locator("#modelDownloadItems strong").textContent(), /SAM.*vit_l/, "individual confirmation identifies the selected SAM variant");
    assert.match(await page.locator("#modelDownloadSecurity").textContent(), /SHA-256/, "confirmation explains the pinned checksum boundary");
    const statusesBeforeSamDownload = settingsStatusRequests.length;
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#settingsSamModel").value.includes("models\\sam_vit_l_0b3195.pth"));
    await page.waitForFunction(() => document.querySelector("#settingsGpuLoading").hidden);
    assert.equal(settingsStatusRequests.length, statusesBeforeSamDownload + 1, "a completed download refreshes status once");
    assert.deepEqual(modelDownloadRequests.at(-1), { modelKey: "sam_vit_l", samType: "vit_l" }, "individual model download sends only the allowlisted key and selected SAM type");
    assert.match(await page.locator("#modelDownloadStatus").textContent(), /完了|complete/i, "download success is reported inside the modal");
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="hand_detection"]').click();
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open, null, { timeout: 3000 });
    assert.equal(await page.locator("#modelDownloadStatus").textContent(), "", "download errors do not remain inside the download modal");
    assert.doesNotMatch(await page.locator("#errorDialog").textContent(), /fixture download failed/, "raw download errors are not shown");
    await page.locator("#errorDialogClose").click();
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="all"]').click();
    assert.equal(await page.locator("#modelDownloadItems .model-download-item").count(), 3, "Download all lists three separate models");
    assert.equal((await page.locator("#modelDownloadItems strong").allTextContents()).some((item) => /SAM.*vit_l/.test(item)), true, "Download all lists only the selected SAM variant");
    assert.doesNotMatch(await page.locator("#modelDownloadDialog").textContent(), /models\\|\.pth|\.onnx|\.safetensors/, "Download all does not expose internal filenames or paths");
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#settingsHandSegmentationModel").value.includes("models\\handsegnet\\handsegnet_vit_b_best.safetensors"));
    assert.deepEqual(modelDownloadRequests.at(-1), { modelKey: "all", samType: "vit_l" }, "Download all uses the selected SAM type without browser-provided URLs or paths");
    assert.equal(await page.locator("#settingsHandModel").inputValue(), "C:\\Mozarie\\models\\ultralytics\\anime-hand-v1.0-s.onnx", "Download all reflects each completed model path immediately");
    await page.locator("#modelDownloadClose").click();
    const jobsBeforeDoubleClick = modelDownloadJobs();
    const errorsBeforeDoubleStart = pageErrors.length;
    await page.evaluate(() => startModelDownload("sam"));
    await page.waitForFunction(() => document.querySelector("#modelDownloadDialog").open);
    assert.equal(modelDownloadJobs(), jobsBeforeDoubleClick, "confirmation does not create a download job");
    await page.locator("#modelDownloadStart").click();
    assert.equal(modelDownloadJobs(), jobsBeforeDoubleClick + 1, "confirmation starts exactly one download job");
    assert.deepEqual(pageErrors.slice(errorsBeforeDoubleStart), [], "opening and confirming a download does not reopen the dialog");
    await page.locator("#modelDownloadCancel").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent.includes("キャンセル"));
    assert.ok(modelDownloadPolls() >= 2, "download progress is polled while a job is active");
    await page.locator("#modelDownloadClose").click();
    failModelDownloadStatus(true);
    await page.locator('[data-model-download="sam"]').click();
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#modelDownloadCancel").isHidden(), true, "a download status error hides the unavailable cancel action");
    assert.equal(await page.locator("#modelDownloadClose").isDisabled(), false, "a download status error lets the user close the modal");
    const pollsAfterFailure = modelDownloadPolls();
    await page.waitForTimeout(500);
    assert.equal(modelDownloadPolls(), pollsAfterFailure, "a download status error stops further polling");
    await page.locator("#errorDialogClose").click();
    await page.locator("#modelDownloadClose").click();
    failModelDownloadStatus(false); resetModelDownload();
    await page.waitForTimeout(50);
    const statusesBeforeStaleResponse = settingsStatusRequests.length;
    const gpuBeforeStaleResponse = await page.locator("#settingsGpuDevice").textContent();
    await page.locator("#settingsTargetModel").fill("unsaved.onnx");
    deferFullSettings();
    await page.evaluate(() => { void refreshSettingsStatus(); });
    await page.waitForTimeout(20);
    assert.equal(settingsStatusRequests.length, statusesBeforeStaleResponse + 1, "one silent refresh captures the current form");
    assert.equal(settingsStatusRequests.at(-1).models.target_segmentation, "unsaved.onnx", "the silent refresh validates the current form");
    assert.equal(await page.locator("#settingsGpuLoading").isVisible(), true, "GPU loading is visible while status is pending");
    assert.equal(await page.locator("#settingsGpuLoading").getAttribute("role"), "status", "GPU loading is announced as status");
    assert.equal(await page.locator("#settingsGpuDevice").getAttribute("aria-busy"), "true", "GPU selector reports that its options are loading");
    await page.locator("#settingsTargetModel").fill("changed-while-checking.onnx");
    releaseFullSettings();
    await page.waitForFunction(() => document.querySelector("#settingsGpuLoading").hidden);
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), "changed-while-checking.onnx", "model status refresh keeps unsaved form values");
    assert.equal(await page.locator("#settingsGpuDevice").textContent(), gpuBeforeStaleResponse, "a stale response leaves GPU state unchanged without a message");
    assert.equal(await page.locator("#settingsGpuLoading").isHidden(), true, "GPU loading clears when a stale response completes");
    assert.equal(await page.locator("#settingsGpuDevice").getAttribute("aria-busy"), null, "GPU selector is no longer busy after the response");
    deferFullSettings();
    await page.evaluate(() => { void refreshSettingsStatus(); void refreshSettingsStatus(); });
    await page.waitForTimeout(20);
    releaseNextFullSettings();
    await page.waitForTimeout(20);
    assert.equal(await page.locator("#settingsGpuLoading").isVisible(), true, "an older status response does not clear a newer loading indicator");
    releaseFullSettings();
    await page.waitForFunction(() => document.querySelector("#settingsGpuLoading").hidden);
    await page.locator("#settingsTargetModel").fill("gpu-options.onnx");
    await page.evaluate(() => refreshSettingsStatus());
    await page.waitForFunction(() => document.querySelector("#settingsGpuDevice").textContent.includes("Legacy Test"));
    assert.equal(await page.locator("#settingsGpuLoading").isHidden(), true, "GPU loading clears after a successful response");
    assert.match(await page.locator("#settingsGpuDevice").textContent(), /^CUDA 3: RTX Test \/ VRAM: 16 GBCUDA 4: Legacy Test \/ VRAM: 3 GB \(このPyTorchでは非対応\)$/, "status shows the CUDA backend, actual GPU names, VRAM, and the incompatibility without a fabricated fallback device");
    assert.equal(await page.locator('#settingsGpuDevice option[value="4"]').evaluate((option) => option.disabled), true, "unsupported GPUs remain unavailable");
    assert.equal(await page.locator('#settingsGpuDevice option[value="0"]').count(), 0, "a pending or mismatched setting never creates a fake GPU 0 option");
    await page.locator("#settingsGpuDevice").selectOption("3");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "設定を保存しました。");
    assert.equal(await page.locator("#settingsGpuDevice").inputValue(), "3", "the supported GPU choice remains selected after saving");
    await page.locator("#settingsTargetModel").fill("no-gpu.onnx");
    await page.evaluate(() => refreshSettingsStatus());
    await page.waitForFunction(() => document.querySelector("#settingsGpuDevice").disabled);
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true, "the settings dialog stays open behind the error dialog");
    assert.equal(await page.locator("#settingsResult").textContent(), "", "settings errors do not remain inline");
    assert.equal(await page.locator("#connectionStatus").isHidden(), true, "settings errors do not appear in the header");
    assert.match(await page.locator("#errorDialog").textContent(), /GPUを使えません[\s\S]*CPUを選択してください/, "no usable GPU tells the user to select CPU");
    assert.equal(await page.locator("dialog[open]").count(), 2, "one error dialog is shown above settings");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true, "Escape closes only the error dialog");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settingsSaveButton", "closing the error dialog restores focus to its action");
    assert.equal(await page.locator(".help-button").evaluateAll((buttons) => buttons.every((button) => {
      const rect = button.getBoundingClientRect(); return rect.width === 28 && rect.height === 28;
    })), true, "all model help buttons, including SAM type, share the compact 28px target");
    await page.locator("#settingsTabShortcuts").click();
    assert.equal(await page.locator("#shortcutBindings > .form-row").evaluateAll((rows) => rows.length === 10 && rows.every((row) => {
      const children = [...row.children];
      return children.length === 3 && children.every((child) => Math.abs((child.getBoundingClientRect().y + child.getBoundingClientRect().height / 2) - (row.getBoundingClientRect().y + row.getBoundingClientRect().height / 2)) < 2);
    })), true, "all shortcut bindings keep one three-column row");
    await page.locator("#settingsTabInfo").click();
    const versionRow = await page.evaluate(() => {
      const version = document.querySelector("#settingsVersion").getBoundingClientRect();
      const button = document.querySelector("#checkUpdateButton").getBoundingClientRect();
      return { sameRow: Math.abs((version.y + version.height / 2) - (button.y + button.height / 2)) < 2, buttonWidth: button.width };
    });
    assert.equal(versionRow.sameRow, true, "the update button shares the version row");
    assert.ok(versionRow.buttonWidth > 0 && versionRow.buttonWidth < 180, "the update button remains compact and clickable");
    assert.equal(await page.locator("#checkUpdateButton").evaluate((button) => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button; }), true, "the version update button owns its hit target");
    await page.waitForFunction(() => document.querySelector("#checkUpdateButton").dataset.available === "false");
    const updatesBeforeClick = updateRequests.length;
    deferUpdateStatus();
    try {
      await page.locator("#checkUpdateButton").click();
      assert.equal(updateRequests.length, updatesBeforeClick + 1, "explicit update checking sends exactly one request");
      assert.equal(await page.locator("#updateStatus").textContent(), "確認中…");
    } finally {
      releaseUpdateStatus();
    }
    await page.waitForFunction(() => document.querySelector("#updateStatus").textContent.includes("最新"));
    await page.locator("#settingsDialog").evaluate((dialog) => dialog.close());
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false, "bucket tolerance is hidden until the fill tool is selected");
    await page.locator("#boundaryTool").click();
    await page.locator("#bucketTool").click();
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), true, "bucket tolerance appears for the fill tool");
    assert.deepEqual(await page.evaluate(() => ({
      bucket: $("#bucketTool").getAttribute("aria-expanded"), exclude: $("#excludeBucketTool").getAttribute("aria-expanded"),
      controls: [$("#bucketTool").getAttribute("aria-controls"), $("#excludeBucketTool").getAttribute("aria-controls")],
      outputFor: $("#bucketToleranceValue").getAttribute("for"),
    })), { bucket: "true", exclude: "false", controls: ["bucketToleranceControl", "bucketToleranceControl"], outputFor: "bucketTolerance" }, "the active fill button exposes the shared tolerance range semantically");
    for (const width of [1024, 360]) {
      await page.setViewportSize({ width, height: 768 });
      for (const selector of ["#bucketTool", "#excludeBucketTool"]) {
        await page.locator(selector).click();
        const panel = await page.locator("#bucketToleranceControl").evaluate((node) => {
          const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth };
        });
        assert.ok(panel.left >= 0 && panel.right <= panel.width, `${width}px ${selector} tolerance panel stays within the viewport (${JSON.stringify(panel)})`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.deepEqual(await page.evaluate(() => [$("#bucketTool").getAttribute("aria-expanded"), $("#excludeBucketTool").getAttribute("aria-expanded")]), ["false", "true"], "switching fill controls updates both expanded states");
    await page.locator("#brushTool").click();
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false, "bucket tolerance hides when switching away from fill");
    assert.deepEqual(await page.evaluate(() => [$("#bucketTool").getAttribute("aria-expanded"), $("#excludeBucketTool").getAttribute("aria-expanded")]), ["false", "false"], "leaving the fill tools collapses both tolerance controls");
    for (const selector of ["#removeAndNextButton", "#hideAndNextButton"]) assert.equal(await page.locator(selector).isDisabled(), true, `${selector} is disabled without a selected image`);
    assert.equal(await page.locator("[data-candidate-batch]").evaluateAll((buttons) => buttons.every((button) => button.disabled)), true, "candidate batch actions are disabled without a selected image or candidate");
    await selectFixtureImage(page, pageErrors, consoleErrors);
    const workspaceFlagBefore = await page.evaluate(() => ({ current: state.currentId, filter: state.galleryFilter, hidden: isHidden(currentRecord()), reviewed: isReviewed(currentRecord()) }));
    await page.evaluate(() => {
      window.__workspaceFlagFetch = window.fetch;
      window.fetch = (input, ...rest) => String(input?.url || input).includes("/api/workspace/image/")
        ? Promise.resolve(new Response(JSON.stringify({ error_code: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } }))
        : window.__workspaceFlagFetch(input, ...rest);
    });
    await page.locator("#hideAndNextButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.deepEqual(await page.evaluate(() => ({ current: state.currentId, filter: state.galleryFilter, hidden: isHidden(currentRecord()), reviewed: isReviewed(currentRecord()) })), workspaceFlagBefore, "a failed hide keeps the visible filter, current image, and flags unchanged");
    await page.locator("#errorDialogClose").click();
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.deepEqual(await page.evaluate(() => ({ current: state.currentId, filter: state.galleryFilter, hidden: isHidden(currentRecord()), reviewed: isReviewed(currentRecord()) })), workspaceFlagBefore, "a failed review-and-next keeps the current image and review flag unchanged");
    await page.locator("#errorDialogClose").click();
    await page.evaluate(() => { window.fetch = window.__workspaceFlagFetch; delete window.__workspaceFlagFetch; });
    const atomicDraftFailure = await page.evaluate(async () => {
      const before = {
        id: state.currentId,
        image: state.currentImage,
        candidates: state.candidates,
        fileName: $("#currentFileName").textContent,
        empty: $("#emptyState").hidden,
        addPixels: canvasHasPixels(addCtx, addCanvas),
      };
      state.drafts.delete("sample-two");
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => String(args[0]?.url || args[0]).includes("/api/workspace/manual/sample-two")
        ? Promise.resolve(new Response(JSON.stringify({ error_code: "workspace_write_failed" }), { status: 500, headers: { "Content-Type": "application/json" } }))
        : fetchOriginal(...args);
      await selectImage("sample-two", true, { saveCurrentDraft: false });
      window.fetch = fetchOriginal;
      return {
        id: state.currentId === before.id,
        image: state.currentImage === before.image,
        candidates: state.candidates === before.candidates,
        fileName: $("#currentFileName").textContent === before.fileName,
        empty: $("#emptyState").hidden === before.empty,
        addPixels: canvasHasPixels(addCtx, addCanvas) === before.addPixels,
      };
    });
    assert.deepEqual(atomicDraftFailure, { id: true, image: true, candidates: true, fileName: true, empty: true, addPixels: true }, "a rejected manual workspace GET preserves the previous editor atomically");
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.doesNotMatch(await page.locator("#errorDialog").textContent(), /manual draft rejected/, "workspace errors do not expose raw request text");
    await page.locator("#errorDialogClose").click();
    const delayedDraftSave = await page.evaluate(async () => {
      const originalEncoder = canvasToDataUrl;
      const originalDraft = state.drafts.get(state.currentId);
      const gates = [];
      canvasToDataUrl = () => new Promise((resolve) => gates.push(resolve));
      state.drafts.delete(state.currentId);
      addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, 2, 2);
      markDraftDirty("add");
      const first = saveDraft();
      state.manualExclusionForced = !state.manualExclusionForced;
      markDraftDirty("add");
      const second = saveDraft();
      gates[1]("newer"); gates[0]("older");
      await Promise.all([first, second]);
      const result = { latestLayer: state.drafts.get(state.currentId)?.add === "newer", dirty: state.draftDirty };
      state.drafts.set(state.currentId, originalDraft);
      canvasToDataUrl = originalEncoder;
      return result;
    });
    assert.deepEqual(delayedDraftSave, { latestLayer: true, dirty: false }, "per-image draft saves commit delayed canvas encodes in capture order");
    const manualExclusionVisibility = await page.evaluate(() => {
      const candidates = state.candidates; const candidateImages = state.candidateImages;
      const manualEnabled = state.manualEnabled; const manualExclusionEnabled = state.manualExclusionEnabled;
      const manualExclusionEraseEnabled = state.manualExclusionEraseEnabled;
      const manualExclusionForced = state.manualExclusionForced; const manualMaskPresent = state.manualMaskPresent;
      const exclusion = document.createElement("canvas"); exclusion.width = addCanvas.width; exclusion.height = addCanvas.height;
      exclusion.getContext("2d").fillRect(0, 0, exclusion.width, exclusion.height);
      addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, addCanvas.width, addCanvas.height);
      exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
      state.candidateImages = new Map([["temporary-exclude", exclusion]]);
      state.candidates = [{ id: "temporary-exclude", role: "exclude", enabled: true, forced: false }];
      state.manualEnabled = true; state.manualExclusionEnabled = false; state.manualExclusionForced = true; state.manualMaskPresent = true;
      markMaskDirty(); const nonForced = hasEffectiveMask();
      state.candidates[0].forced = true;
      markMaskDirty(); const forced = hasEffectiveMask();
      exclusionEraseCtx.fillStyle = "#fff"; exclusionEraseCtx.fillRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
      markMaskDirty(); const forcedErased = hasEffectiveMask();
      state.candidates = candidates; state.candidateImages = candidateImages;
      state.manualEnabled = manualEnabled; state.manualExclusionEnabled = manualExclusionEnabled;
      state.manualExclusionEraseEnabled = manualExclusionEraseEnabled;
      state.manualExclusionForced = manualExclusionForced; state.manualMaskPresent = manualMaskPresent;
      addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height); exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
      markMaskDirty(); flushMaskComposition();
      return { nonForced, forced, forcedErased };
    });
    assert.deepEqual(manualExclusionVisibility, { nonForced: true, forced: false, forcedErased: true }, "manual exclusion erase restores forced exclusions without creating a new mosaic");
    const restoredHistory = await page.evaluate(async () => {
      resetCurrentDraft(); state.drafts.delete("sample");
      beginManualStroke({ x: 12, y: 12 }); completeManualStroke(); await saveDraft();
      const saved = state.drafts.get("sample");
      addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); state.history = []; state.historyIndex = 0;
      restoreDraft("sample", state.imageGeneration);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const restored = state.history.length === 1 && state.historyIndex === 1 && canvasHasPixels(addCtx, addCanvas);
      restoreSnapshot(0);
      const undoWorked = !canvasHasPixels(addCtx, addCanvas) && !$("#redoButton").disabled;
      restoreSnapshot(1);
      const redoWorked = canvasHasPixels(addCtx, addCanvas);
      state.drafts.set("sample", saved); resetCurrentDraft(); state.drafts.delete("sample");
      return { restored, undoWorked, redoWorked };
    });
    assert.deepEqual(restoredHistory, { restored: true, undoWorked: true, redoWorked: true }, "manual history survives changing away and back to an image");
    const mosaicEraserHistory = await page.evaluate(() => {
      const candidates = state.candidates; const candidateImages = state.candidateImages; const tool = state.tool;
      const automatic = document.createElement("canvas"); automatic.width = addCanvas.width; automatic.height = addCanvas.height; automatic.getContext("2d").fillRect(2, 2, 8, 8);
      state.candidates = [{ id: "automatic-range", role: "apply", enabled: true, labelToken: "penis", source: "target", refinement: null }]; state.candidateImages = new Map([["automatic-range", automatic]]);
      const manual = document.createElement("canvas"); manual.width = manual.height = 64;
      const exclusion = document.createElement("canvas"); exclusion.width = exclusion.height = 64;
      const exclusionErase = document.createElement("canvas"); exclusionErase.width = exclusionErase.height = 64;
      const from = { x: 16, y: 16 }; const to = { x: 48, y: 48 };
      paintStrokeOnContexts(manual.getContext("2d"), exclusion.getContext("2d"), exclusionErase.getContext("2d"), from, to, "brush", 12);
      const added = canvasHasPixels(manual.getContext("2d"), manual);
      paintStrokeOnContexts(manual.getContext("2d"), exclusion.getContext("2d"), exclusionErase.getContext("2d"), from, to, "mosaic_eraser", 12);
      const erased = !canvasHasPixels(manual.getContext("2d"), manual);
      const point = { x: Math.floor(addCanvas.width / 2), y: Math.floor(addCanvas.height / 2) };
      addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); resetHistoryToCurrentManualMask(); state.tool = "brush";
      beginManualStroke(point); appendManualStrokePoint({ x: point.x + 1, y: point.y + 1 }); completeManualStroke();
      state.tool = "mosaic_eraser"; beginManualStroke(point); appendManualStrokePoint({ x: point.x + 1, y: point.y + 1 }); completeManualStroke();
      const historyTools = state.history.map((stroke) => stroke.tool);
      restoreSnapshot(1); const undo = state.historyIndex === 1 && canvasHasPixels(addCtx, addCanvas); restoreSnapshot(2); const redo = state.historyIndex === 2;
      const automaticUnchanged = state.candidates[0].enabled && canvasHasPixels(automatic.getContext("2d"), automatic);
      state.candidates = candidates; state.candidateImages = candidateImages; state.tool = tool; resetHistoryToCurrentManualMask(); renderCandidates();
      return { added, erased, undo, redo, automaticUnchanged, historyTools };
    });
    assert.deepEqual(mosaicEraserHistory, { added: true, erased: true, undo: true, redo: true, automaticUnchanged: true, historyTools: ["brush", "mosaic_eraser"] }, `mosaic eraser removes only manual mosaic strokes and participates in undo/redo: ${JSON.stringify(mosaicEraserHistory)}`);
    const exclusionEraseRow = await page.evaluate(() => {
      exclusionEraseCtx.fillStyle = "#fff"; exclusionEraseCtx.fillRect(3, 3, 4, 4); state.manualExclusionEraseEnabled = true; renderCandidates();
      const row = document.querySelector(".candidate-row-manual-exclude-erase");
      const result = { present: Boolean(row), enabled: row?.classList.contains("enabled"), toggle: row?.querySelector(".candidate-toggle")?.textContent };
      exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height); renderCandidates(); return result;
    });
    assert.deepEqual(exclusionEraseRow, { present: true, enabled: true, toggle: "ON" }, "manual exclusion erase has its own visible ON/OFF row");
    const eta = await page.evaluate(() => {
      state.detectionEta = null;
      const first = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 1, total: 4, activeElapsed: 10 });
      const polled = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 1, total: 4, activeElapsed: 40 });
      const completed = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 2, total: 4, activeElapsed: 40 });
      return { first, polled, completed };
    });
    assert.equal(eta.polled, eta.first, "ETA is retained between image completions");
    assert.notEqual(eta.completed, eta.first, "ETA is recalculated after an image completes");
    await assertDesktopLayout(page, 1024, 768);
    await assertSettingsDialogLayout(page, 1024, 768, "ja", modelDownloadRequests);
    await page.evaluate(() => loadTranslations("en"));
    await assertDesktopLayout(page, 1920, 1080);
    await assertSettingsDialogLayout(page, 1920, 1080, "en", modelDownloadRequests);
    await page.evaluate(() => loadTranslations("ja"));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsLanguage").inputValue(), "ja", "the compact settings API flow starts in Japanese");
    const actionsBeforeSettingsFooter = settingsActions.length;
    await page.locator("#settingsResetButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "初期値に戻しました。");
    const settingsResultBox = await page.locator("#settingsResult").boundingBox(); const resetBox = await page.locator("#settingsResetButton").boundingBox();
    assert.ok(settingsResultBox && resetBox && resetBox.x - (settingsResultBox.x + settingsResultBox.width) <= 12, "settings result stays beside Reset");
    assert.deepEqual(settingsActions.at(-1), { path: "/api/settings/reset", method: "POST" }, "the compact reset button reaches its dedicated API route");
    const shortcutsAfterReset = await page.locator("[data-shortcut-action]").evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.equal(shortcutsAfterReset.length, 10, "reset restores every shortcut binding before compact save");
    assert.equal(shortcutsAfterReset.every(Boolean) && new Set(shortcutsAfterReset).size === shortcutsAfterReset.length, true, "reset restores valid unique shortcut bindings before compact save");
    const savesBeforeCompactSave = settingsActions.filter((action) => action.path === "/api/settings" && action.method === "POST").length;
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "設定を保存しました。");
    assert.equal(settingsActions.filter((action) => action.path === "/api/settings" && action.method === "POST").length, savesBeforeCompactSave + 1, "the compact save button posts exactly once");
    assert.deepEqual(settingsActions.at(-1), { path: "/api/settings", method: "POST" }, "the compact save button reaches the settings API route");
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    assert.equal(settingsActions.length, actionsBeforeSettingsFooter + 2, "the compact close button does not call a settings API route");
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.equal(await page.locator(".editor-context-bar").count(), 0, "the old editor context row must be removed");
    assert.equal(await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().height >= 690), true, "the canvas stage keeps a full editing surface beneath the compact status line at 1024x768");
    for (const selector of ["#canvasStage", ".canvas-tool-rail", ".canvas-settings-bar", "#currentFileName", "#previousImageButton", "#imagePosition", "#nextImageButton", "#reviewAndNextButton", "#saveButton"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} must be visible on desktop`);
    }
    await assertToolRailLayout(page, "top");
    await page.locator("#canvasStage").evaluate((stage) => { stage.dataset.toolPosition = "left"; });
    for (const [language, labels] of [["ja", ["削除して次へ", "非表示にして次へ", "確認済にして次へ"]], ["en", ["Remove and next", "Hide and next", "Mark reviewed and next"]]]) {
      await page.evaluate((locale) => loadTranslations(locale), language);
      assert.deepEqual(await page.locator(".canvas-navigation-bar > button").evaluateAll((buttons) => buttons.slice(-3).map((button) => button.textContent.trim())), labels, `${language} navigation actions follow the requested order`);
      await assertCompactNavigationLayout(page, language);
    }
    await page.evaluate(() => loadTranslations("ja"));
    const stageWidth = await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().width);
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#collapseGalleryButton").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#galleryPaneContent").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#galleryPaneContent").evaluate((pane) => pane.inert), true);
    assert.equal(await page.locator("#galleryPane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 40);
    assert.equal(await page.locator("#candidatePane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 270, "collapsing the gallery keeps the 1024px inspector width");
    assert.ok(await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().width) > stageWidth, "collapsing the gallery must enlarge the canvas");
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#collapseGalleryButton").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#galleryPaneContent").getAttribute("aria-hidden"), "false");
    assert.equal(await page.locator("#galleryPaneContent").evaluate((pane) => pane.inert), false);
    await page.locator("#collapseInspectorButton").click();
    await page.waitForFunction(() => document.querySelector(".studio-grid").classList.contains("inspector-collapsed"));
    assert.equal(await page.locator("#candidatePaneContent").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), true);
    assert.equal(await page.locator("#candidatePane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 40);
    await page.locator("#collapseGalleryButton").click();
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), true, "left panel state must not reopen the right panel");
    await page.locator("#collapseInspectorButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("inspector-collapsed"));
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), false);
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#canvasStage > .canvas-tool-rail").count(), 1, "only editor tools stay in the canvas overlay");
    assert.equal(await page.locator("#overviewDetectAllButton").count(), 0, "overview must not duplicate global actions");
    await page.locator("#applyDialog").evaluate((dialog) => dialog.showModal());
    assert.equal(await page.locator('#applyDialog [data-i18n="apply.metadata"]').textContent(), "対応するメタデータを引き継ぎます。同名時は自動連番です。", "save dialog describes only supported metadata carryover");
    assert.doesNotMatch(await page.locator('#applyDialog [data-i18n="apply.metadata"]').textContent(), /検証|validated/, "save dialog makes no verification claim");
    assert.equal(await page.locator("#applyTargetMode").inputValue(), "all", "the normal batch save target is the complete image list");
    assert.equal(await page.locator("#applySuffix").isDisabled(), false);
    await page.locator("#applyDialog").evaluate((dialog) => dialog.close());

    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.evaluate(() => {
      addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, 1, 1);
      markMaskDirty(); refreshMaskStatus(true);
    });
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, targets: saveTargets("masked"), hasMask: hasEffectiveMask() })), { currentId: "sample", targets: ["sample"], hasMask: true }, "the batch test has one real masked filesystem source");
    await page.locator("#saveAllButton").click();
    await page.locator("#applyTargetMode").selectOption("masked");
    await page.locator("#applyOverwriteMode").check();
    const saveRequestStart = saveRequests.length;
    await page.locator("#applyStartButton").click();
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.applyRunning && state.saving, null, { timeout: 5000 });
    await page.waitForFunction(() => !state.applyRunning && !state.saving, null, { timeout: 5000 });
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, `batch overwrite must not fail: ${await page.locator("#applyResult").textContent}`);
    assert.deepEqual(saveRequests.slice(saveRequestStart).map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"], "batch overwrite renders and commits through the browser-owned save path");
    assert.match(await page.locator("#applyResult").textContent(), /完了しました。1件を処理しました。/, "batch overwrite reports its completed result");
    assert.equal(await page.locator("#applyCloseButton").isDisabled(), false, "the completed overwrite dialog can be closed");
    await page.locator("#applyCloseButton").click();
    assert.equal(await page.locator("#applyDialog").evaluate((dialog) => dialog.open), false, "the completed copy dialog closes");
    assert.equal(await page.locator("#settingsButton").isDisabled(), false, "background controls unlock after a reconciled browser overwrite");

    await selectFixtureImage(page, pageErrors, consoleErrors);
    assert.equal(await page.locator("#removeAndNextButton").isDisabled(), false, "remove and next enables after selecting an image");
    assert.equal(await page.locator("#hideAndNextButton").isDisabled(), false, "hide and next enables after selecting an image");
    assert.equal(await page.locator("[data-candidate-batch]").evaluateAll((buttons) => buttons.some((button) => !button.disabled)), true, "saving preserves the selected image's candidate actions");
    await page.locator("#confidence").evaluate((input) => {
      input.value = "1.00";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const detectionControls = await page.evaluate(() => {
      const saved = [...state.settings.detection.targets];
      state.settings.detection.targets = [];
      setDetectionTargets(["penis"]); // Unsaved form state must not enable detection.
      updateActionButtons();
      const empty = { all: document.querySelector("#detectAllButton").disabled, current: document.querySelector("#detectCurrentButton").disabled };
      state.settings.detection.targets = saved;
      setDetectionTargets(saved);
      updateActionButtons();
      return { empty, restored: { all: document.querySelector("#detectAllButton").disabled, current: document.querySelector("#detectCurrentButton").disabled } };
    });
    assert.deepEqual(detectionControls, { empty: { all: true, current: true }, restored: { all: false, current: false } }, "detection actions use persisted targets, not unsaved controls");
    await page.locator("#detectCurrentButton").click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#detectDialog").isVisible(), false, "current-image detection must not open settings");
    assert.equal(detectRequests.length, 1, "current-image detection should start immediately");
    assert.deepEqual(detectRequests[0].imageIds, ["sample"]);
    assert.equal(detectRequests[0].confidence, 1.00, "current-image detection should use the right-pane threshold");
    assert.equal(detectRequests[0].parallelism, 1, "current-image detection must stay serial");
    assert.deepEqual(detectRequests[0].targetClasses, ["penis", "pussy"], "current-image detection starts with both right-pane targets");
    assert.equal(Object.hasOwn(detectRequests[0], "mode"), false, "current-image detection must not submit a mode override");
    resetJob();
    await page.evaluate(async () => { await pollJob(); closeProcessing(); });
    await page.locator("label.target-chip:has(#detectTargetPussy)").click();
    await page.waitForFunction(() => document.querySelector("#detectTargetPussy").checked === false);
    await page.locator("#detectCurrentButton").click();
    await page.waitForTimeout(50);
    assert.deepEqual(detectRequests[1].targetClasses, ["penis"], "current-image detection uses the visible penis-only choice");
    resetJob();
    await page.evaluate(async () => { await pollJob(); closeProcessing(); });
    await page.locator("label.target-chip:has(#detectTargetPenis)").click();
    await page.waitForFunction(() => document.querySelector("#detectTargetPenis").checked === false);
    await page.locator("#detectCurrentButton").click();
    await page.waitForTimeout(50);
    assert.equal(detectRequests.length, 2, "current-image detection must not start without a selected target");
    assert.match(await page.locator("#detectionTargetValidation").textContent(), /penis|pussy/, "current-image detection explains which target to select");
    await page.locator("label.target-chip:has(#detectTargetPussy)").click();
    await page.waitForFunction(() => document.querySelector("#detectTargetPussy").checked === true);
    await page.locator("#detectCurrentButton").click();
    await page.waitForTimeout(50);
    assert.deepEqual(detectRequests[2].targetClasses, ["pussy"], "current-image detection uses the visible pussy-only choice");

    const currentDetectionRequests = detectRequests.length;
    await page.reload({ waitUntil: "networkidle" });
    const persistedDetection = await page.evaluate(() => structuredClone(state.settings.detection));
    failNextSettingsSave();
    await page.locator("#detectAllButton").click();
    await page.locator("#dialogTargetPussy").evaluate((input) => { input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.locator("#detectConfidenceNumber").fill("0.67");
    await page.locator("#detectParallelism").fill("4");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    const failedDetectionSave = await page.evaluate(() => ({
      settings: state.settings.detection,
      dialogOpen: document.querySelector("#detectDialog").open,
      allDisabled: document.querySelector("#detectAllButton").disabled,
      currentDisabled: document.querySelector("#detectCurrentButton").disabled,
    }));
    assert.deepEqual(failedDetectionSave, { settings: persistedDetection, dialogOpen: false, allDisabled: false, currentDisabled: true }, "a failed detection-settings save leaves persisted targets and main actions untouched");
    await page.locator("#errorDialogClose").click();
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectDialog").isVisible(), true, "detect settings should open before any request");
    assert.equal(detectRequests.length, currentDetectionRequests, "opening settings must not start another detection");
    await page.locator("#detectConfidenceNumber").fill("0.67");
    assert.equal(await page.locator("#detectParallelism").isDisabled(), false, "GPU keeps the same editable worker control");
    assert.equal(await page.locator("#detectParallelism").inputValue(), "2", "the saved worker count is shown without rewriting it");
    await page.locator("#settingsProvider").evaluate((select) => { select.value = "cpu"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.locator("#detectParallelism").fill("4");
    await page.locator("#settingsProvider").evaluate((select) => { select.value = "gpu"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await page.locator("#detectParallelism").inputValue(), "4", "GPU preserves the requested worker count");
    await page.locator("#settingsProvider").evaluate((select) => { select.value = "cpu"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await page.locator("#detectParallelism").inputValue(), "4", "switching providers does not rewrite the worker count");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open === false);
    await page.waitForTimeout(50);
    assert.equal(detectRequests.length, currentDetectionRequests + 1, "starting settings should call detection once");
    assert.equal(detectRequests[currentDetectionRequests].confidence, 0.67, "dialog threshold should be submitted");
    assert.equal(detectRequests[currentDetectionRequests].parallelism, 4, "dialog parallelism should be submitted on GPU");
    assert.equal(Object.hasOwn(detectRequests[currentDetectionRequests], "mode"), false, "all-image detection must not submit a mode override");
    resetJob();
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabModels").click();
    await page.waitForFunction(() => document.querySelector("#settingsGpuDevice option[value='3']"));
    assert.equal(await page.locator("#settingsGpuDevice").inputValue(), "3", "the saved GPU choice survives reopening after reload");
    await page.locator("#settingsCloseButton").click();
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectParallelism").inputValue(), "4", "the saved GPU worker count survives reload");
    await page.locator("#detectDialog").evaluate((dialog) => dialog.close());
    holdDetection(true);
    await page.locator("#detectAllButton").click();
    const heldDetectionStarted = page.waitForResponse((response) => response.url().includes("/api/detect") && response.request().method() === "POST");
    await page.locator("#detectStartButton").click();
    await heldDetectionStarted;
    await page.waitForFunction(() => document.querySelector("#processingDialog").open);
    const lockedDetectionReads = await page.evaluate(() => {
      const candidateControls = () => [...document.querySelectorAll("[data-candidate-batch], [data-candidate-display-toggle], [data-candidate-effective-toggle]")]
        .map((node) => ({ type: node.dataset.candidateBatch ? "batch" : node.dataset.candidateDisplayToggle ? "display" : "effective", pressed: node.getAttribute("aria-pressed"), disabled: node.disabled }));
      const controlsBefore = candidateControls();
      const originalHasPixels = canvasHasPixels;
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      let hasPixelsCalls = 0;
      let getImageDataCalls = 0;
      canvasHasPixels = (...args) => { hasPixelsCalls += 1; return originalHasPixels(...args); };
      CanvasRenderingContext2D.prototype.getImageData = function(...args) {
        getImageDataCalls += 1;
        return originalGetImageData.apply(this, args);
      };
      try { updateActionButtons(); } finally {
        canvasHasPixels = originalHasPixels;
        CanvasRenderingContext2D.prototype.getImageData = originalGetImageData;
      }
      return { hasPixelsCalls, getImageDataCalls, controlsBefore, controlsAfter: candidateControls() };
    });
    assert.deepEqual({ hasPixelsCalls: lockedDetectionReads.hasPixelsCalls, getImageDataCalls: lockedDetectionReads.getImageDataCalls }, { hasPixelsCalls: 0, getImageDataCalls: 0 }, "locked detection controls avoid manual-mask canvas readback");
    assert.deepEqual(lockedDetectionReads.controlsAfter.map((control) => control.pressed), lockedDetectionReads.controlsBefore.map((control) => control.pressed), "locked detection controls preserve candidate pressed state");
    assert.deepEqual([...new Set(lockedDetectionReads.controlsAfter.map((control) => control.type))].sort(), ["batch", "display", "effective"], "the locked detection control refresh covers every candidate-control kind");
    assert.equal(lockedDetectionReads.controlsAfter.every((control) => control.disabled), true, "locked detection controls disable every candidate control");
    assert.equal(await page.locator("#processingCancelButton").evaluate((button) => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button; }), true, "the processing cancel button owns its physical hit target");
    failCancel(true);
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => !document.querySelector("#processingCancelButton").disabled);
    assert.equal(cancelRequests(), 1, "a failed processing cancel sends one request and re-enables the button");
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.doesNotMatch(await page.locator("#errorDialog").textContent(), /cancel failed/, "a failed cancel does not expose raw request text");
    await page.locator("#errorDialogClose").click();
    failCancel(false);
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => state.job?.kind === "detect" && state.job?.state === "running" && state.job?.cancelRequested === true);
    assert.equal(await page.locator("#processingCancelButton").isDisabled(), true, "the cancel control stays disabled while the detector finishes its in-flight image");
    assert.match(await page.locator("#connectionStatus").textContent(), /現在の画像は完了する場合があります/, "cancellation is shown immediately with the in-flight image notice");
    await page.locator("#processingCancelButton").evaluate((button) => button.click());
    assert.equal(cancelRequests(), 2, "a processing cancel cannot be sent twice");
    finishCancel();
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => !document.querySelector("#processingDialog").open);
    assert.equal(await page.locator("#processingCancelButton").isDisabled(), false, "the cancel control is re-enabled only after the terminal cancellation is observed");
    holdDetection(false);
    resetJob();
    await page.evaluate(async () => { await pollJob(); closeProcessing(); });
    const menu = page.locator("#pickerMenu");
    assert.equal(await menu.isVisible(), false, "the picker menu should be initially hidden");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), false, "the picker menu should initially be closed");

    await page.locator("#pickFolder").click();
    assert.equal(await menu.isVisible(), true, "the picker menu should be visible after opening");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), true, "the picker menu should be open after opening");
    const [pickerBox, triggerBox] = await Promise.all([menu.boundingBox(), page.locator("#pickFolder").boundingBox()]);
    assert.ok(Math.abs(pickerBox.x - triggerBox.x) <= 1, "picker left edge should align with its trigger");
    assert.ok(Math.abs(pickerBox.y - (triggerBox.y + triggerBox.height + 6)) <= 1, "picker should sit 6px below its trigger");

    await page.locator("#pickImages").click();
    assert.equal(await page.evaluate(() => window.__openFilesCalled), true, "native image picker should be preferred");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting image files");

    await page.locator("#pickFolder").click();
    await page.locator("#pickFolderFiles").click();
    assert.equal(await page.evaluate(() => window.__openDirectoryCalled), true, "native folder picker should be preferred");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting a folder");

    assert.equal(await page.locator("footer.batch-bar").count(), 0, "batch controls must not live below the editor");
    const batchMenu = page.locator("#batchMoreMenu");
    assert.equal(await batchMenu.isVisible(), false, "destructive batch commands should not be visible by default");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, `folder picker must not leave an error dialog open: ${await page.locator("#errorDialog").textContent()}`);
    await page.locator("#batchMoreButton").evaluate((button) => { button.disabled = false; });
    await page.locator("#batchMoreButton").click();
    assert.equal(await batchMenu.isVisible(), true, "batch menu should reveal destructive commands on demand");
    await page.waitForFunction(() => document.querySelector("#batchMoreButton").getAttribute("aria-expanded") === "true");
    assert.equal(await page.locator("#batchMoreButton").getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#batchMoreMenu").matches(":popover-open"));
    await page.waitForFunction(() => document.querySelector("#batchMoreButton").getAttribute("aria-expanded") === "false");
    assert.equal(await page.locator("#batchMoreButton").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".appbar-commands #batchMoreButton").count(), 0, "batch menu belongs beside the image count, not in the appbar");
    assert.equal(await page.locator(".gallery-heading #batchMoreButton").count(), 1);
    assert.equal(await page.locator(".gallery-batch-bar").count(), 0, "batch edit leaves no control row in the gallery");
    assert.equal(await page.locator("#galleryFilter").inputValue(), "all");
    assert.deepEqual(await page.locator("#galleryFilter option").allTextContents(), ["すべて", "モザイクあり", "モザイク無し", "非表示", "確認済", "未確認"]);
    assert.equal(await page.locator("#galleryDropOverlay").evaluate((element) => element.parentElement.classList.contains("gallery-viewport")), true, "the drop overlay must be outside the scrolling gallery");
    assert.equal(await page.locator("#galleryFilteredEmptyState").count(), 1, "the gallery needs a filtered-empty state");
    assert.equal(await page.locator("#overviewEmptyState").count(), 1, "the overview needs an empty state");
    assert.equal(await page.locator(".overview-filters").getAttribute("role"), null, "overview filters are toggle buttons, not incomplete tabs");
    for (const selector of ["#brushTool", "#eraserTool", "#boundaryTool", ".overview-filter"]) {
      assert.notEqual(await page.locator(selector).first().getAttribute("aria-pressed"), null, `${selector} must expose its toggle state`);
    }
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("role"), "menu");
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("tabindex"), "-1");
    await page.locator('.gallery-item[data-id="sample"]').click({ button: "right" });
    await page.waitForFunction(() => document.querySelector("#catalogContextMenu").matches(":popover-open"));
    assert.equal(await page.locator("#copyImagePathMenuItem").isVisible(), true, "filesystem gallery cards expose Copy path");
    await page.locator("#copyImagePathMenuItem").click();
    assert.deepEqual(await page.evaluate(() => window.__copiedPaths), ["G:\\画像 フォルダー\\sample image.png"], "copy path preserves spaces and Unicode characters");
    assert.equal(await page.locator("#connectionStatus").textContent(), "パスをコピーしました。", "successful copying reports a localized status");
    assert.equal(await page.evaluate(async () => { await loadTranslations("en"); return t("status.pathCopied"); }), "Path copied.", "copy success has an English status");
    await page.evaluate(() => loadTranslations("ja"));
    await page.locator('.gallery-item[data-id="sample-two"]').click({ button: "right" });
    await page.waitForFunction(() => document.querySelector("#catalogContextMenu").matches(":popover-open"));
    await page.waitForFunction(() => state.contextMenuImageId === "sample-two");
    assert.equal(await page.locator("#copyImagePathMenuItem").getAttribute("hidden"), "", "session images never expose their temporary path");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#catalogContextMenu").matches(":popover-open"));
    const keyboardMenu = await page.locator('.gallery-item[data-id="sample"]').evaluate((card) => {
      card.focus();
      const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
      const dispatched = card.dispatchEvent(event); const menu = document.querySelector("#catalogContextMenu");
      const cardRect = card.getBoundingClientRect(); const rect = menu.getBoundingClientRect();
      return { dispatched, defaultPrevented: event.defaultPrevented, open: menu.matches(":popover-open"), contextMenuImageId: state.contextMenuImageId, focusedId: document.activeElement?.id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, cardLeft: cardRect.left, cardTop: cardRect.top, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.deepEqual({ dispatched: keyboardMenu.dispatched, defaultPrevented: keyboardMenu.defaultPrevented, open: keyboardMenu.open, contextMenuImageId: keyboardMenu.contextMenuImageId, focusedId: keyboardMenu.focusedId }, { dispatched: false, defaultPrevented: true, open: true, contextMenuImageId: "sample", focusedId: "toggleReviewMenuItem" }, "cancelable Shift+F10 opens the focused card menu synchronously");
    assert.ok(keyboardMenu.left >= 0 && keyboardMenu.top >= 0 && keyboardMenu.right <= keyboardMenu.viewportWidth && keyboardMenu.bottom <= keyboardMenu.viewportHeight && keyboardMenu.left >= keyboardMenu.cardLeft && keyboardMenu.top >= keyboardMenu.cardTop, "keyboard menu starts from the card and remains in the viewport");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#catalogContextMenu").evaluate((menu) => menu.matches(":popover-open")), false, "Tab closes the catalog context menu without trapping focus");
    const pointerContextBefore = await page.evaluate(async () => {
      window.__pointerContextSaved = { images: state.images, currentId: state.currentId, galleryFilter: state.galleryFilter, overviewFilter: state.overviewFilter, viewMode: state.viewMode, batchMode: state.batchMode, selectedImageIds: state.selectedImageIds, selectionAnchorId: state.selectionAnchorId };
      state.images = Array.from({ length: 96 }, (_, index) => ({ id: `pointer-${index}`, relativePath: `pointer/${index}.png`, sourcePath: `G:/pointer/${index}.png`, width: 80, height: 60 }));
      state.currentId = "pointer-0"; state.galleryFilter = "all"; state.viewMode = "edit"; state.batchMode = false; state.selectedImageIds = new Set(["pointer-0"]); state.selectionAnchorId = "pointer-0";
      renderGallery(true); const gallery = document.querySelector("#gallery"); gallery.scrollTop = 100; resetCatalogWindows(); renderGallery(true);
      const firstCard = document.querySelector('.gallery-item[data-id="pointer-0"]');
      const firstInViewport = firstCard.getBoundingClientRect().top >= gallery.getBoundingClientRect().top;
      scrollCatalogImage("gallery", "pointer-0"); const firstSelectionTop = gallery.scrollTop;
      scrollCatalogImage("gallery", "pointer-1"); const visibleSelectionTop = gallery.scrollTop;
      gallery.scrollTop = 100; await new Promise((resolve) => requestAnimationFrame(resolve)); renderGallery(true);
      const current = document.querySelector('.gallery-item[data-id="pointer-0"]'); const target = document.querySelector('.gallery-item[data-id="pointer-1"]'); current.focus();
      const snapshot = () => ({ scrollTop: gallery.scrollTop, currentId: state.currentId, selected: [...state.selectedImageIds].sort(), focused: document.activeElement?.dataset.id, tabStops: [...document.querySelectorAll('.gallery-item[tabindex="0"]')].map((item) => item.dataset.id) });
      const before = snapshot(); let pointerPrevented = false; target.onpointerdown({ button: 2, preventDefault() { pointerPrevented = true; } });
      target.oncontextmenu({ type: "contextmenu", currentTarget: target, clientX: target.getBoundingClientRect().left + 4, clientY: target.getBoundingClientRect().top + 4, preventDefault() {} });
      return { before, after: snapshot(), pointerPrevented, target: state.contextMenuImageId, contextScroll: state.contextMenuScroll, firstInViewport, firstSelectionTop, visibleSelectionTop };
    });
    assert.deepEqual({ firstInViewport: pointerContextBefore.firstInViewport, firstSelectionTop: pointerContextBefore.firstSelectionTop, visibleSelectionTop: pointerContextBefore.visibleSelectionTop }, { firstInViewport: true, firstSelectionTop: 0, visibleSelectionTop: 0 }, "a replaced catalog starts at its first visible card and selecting another visible card does not move the gallery");
    assert.equal(pointerContextBefore.pointerPrevented, true, "secondary gallery pointerdown prevents focus movement");
    assert.deepEqual(pointerContextBefore.after, pointerContextBefore.before, "right-clicking a visible unselected gallery card leaves logical focus, selection, tab stop, current image, and scroll unchanged");
    assert.equal(pointerContextBefore.target, "pointer-1", "the gallery menu targets the right-clicked card");
    await page.locator("#removeImageMenuItem").click();
    await page.waitForFunction(() => state.hiddenPaths.has("pointer/1.png"));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const pointerContextAfter = await page.evaluate(() => ({ scrollTop: document.querySelector("#gallery").scrollTop, currentId: state.currentId, selected: [...state.selectedImageIds].sort(), focused: document.activeElement?.dataset.id, tabStops: [...document.querySelectorAll('.gallery-item[tabindex="0"]')].map((item) => item.dataset.id), hidden: [...state.hiddenPaths] }));
    assert.deepEqual({ scrollTop: pointerContextAfter.scrollTop, currentId: pointerContextAfter.currentId, selected: pointerContextAfter.selected }, { scrollTop: pointerContextBefore.before.scrollTop, currentId: pointerContextBefore.before.currentId, selected: pointerContextBefore.before.selected }, "the gallery action applies only to its menu target and does not change its scroll, current image, or selection after rendering");
    assert.deepEqual(pointerContextAfter.hidden, ["pointer/1.png"], "the gallery action changes only the right-clicked target");
    const overviewPointerBefore = await page.evaluate(async () => {
      state.viewMode = "overview"; state.batchMode = true; state.overviewFilter = "all"; state.selectedImageIds = new Set(["pointer-0", "pointer-2"]); state.selectionAnchorId = "pointer-0";
      renderOverview(true); const grid = document.querySelector("#overviewGrid"); grid.scrollTop = 100; await new Promise((resolve) => requestAnimationFrame(resolve)); renderOverview(true);
      const current = document.querySelector('.overview-item[data-id="pointer-0"]'); const target = document.querySelector('.overview-item[data-id="pointer-1"]'); current.focus();
      const snapshot = () => ({ scrollTop: grid.scrollTop, currentId: state.currentId, selected: [...state.selectedImageIds].sort(), focused: document.activeElement?.dataset.id, tabStops: [...document.querySelectorAll('.overview-item[tabindex="0"]')].map((item) => item.dataset.id) });
      const before = snapshot(); let pointerPrevented = false; target.onpointerdown({ button: 2, preventDefault() { pointerPrevented = true; } });
      target.oncontextmenu({ type: "contextmenu", currentTarget: target, clientX: target.getBoundingClientRect().left + 4, clientY: target.getBoundingClientRect().top + 4, preventDefault() {} });
      return { before, after: snapshot(), pointerPrevented, target: state.contextMenuImageId };
    });
    assert.equal(overviewPointerBefore.pointerPrevented, true, "secondary overview pointerdown prevents focus movement");
    assert.deepEqual(overviewPointerBefore.after, overviewPointerBefore.before, "right-clicking an overview card leaves logical focus, selection, tab stop, current image, and scroll unchanged");
    assert.equal(overviewPointerBefore.target, "pointer-1", "the overview menu targets the right-clicked card");
    await page.keyboard.press("Escape");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const overviewPointerAfter = await page.evaluate(() => ({ scrollTop: document.querySelector("#overviewGrid").scrollTop, currentId: state.currentId, selected: [...state.selectedImageIds].sort(), focused: document.activeElement?.dataset.id, tabStops: [...document.querySelectorAll('.overview-item[tabindex="0"]')].map((item) => item.dataset.id) }));
    assert.deepEqual(overviewPointerAfter, overviewPointerBefore.before, "closing an overview pointer menu preserves the prior logical state after rendering");
    await page.evaluate(() => { const saved = window.__pointerContextSaved; state.images = saved.images; state.currentId = saved.currentId; state.galleryFilter = saved.galleryFilter; state.overviewFilter = saved.overviewFilter; state.batchMode = saved.batchMode; state.selectedImageIds = saved.selectedImageIds; state.selectionAnchorId = saved.selectionAnchorId; setViewMode(saved.viewMode); renderCatalogViews(); delete window.__pointerContextSaved; });
    const gridKeyboard = await page.evaluate(() => {
      const saved = { images: state.images, currentId: state.currentId, galleryFilter: state.galleryFilter, overviewFilter: state.overviewFilter, viewMode: state.viewMode, batchMode: state.batchMode, selectedImageIds: state.selectedImageIds, selectionAnchorId: state.selectionAnchorId };
      const press = (key, modifiers = {}) => {
        const origin = document.activeElement;
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }); origin.dispatchEvent(event);
        return { defaultPrevented: event.defaultPrevented, activeId: document.activeElement?.dataset.id, mounted: Boolean(document.querySelector(`.gallery-item[data-id="${document.activeElement?.dataset.id}"], .overview-item[data-id="${document.activeElement?.dataset.id}"]`)) };
      };
      state.images = Array.from({ length: 32 }, (_, index) => ({ id: `keyboard-${index}`, relativePath: `keyboard/${index}.png`, width: 80, height: 60, hasEffectiveMask: index % 2 === 0 }));
      state.currentId = null; state.galleryFilter = "all"; renderGallery(true);
      const galleryColumns = Number(document.querySelector("#gallery").getAttribute("aria-colcount"));
      const visibleCount = galleryColumns * 3 + 2;
      state.images = Array.from({ length: visibleCount * 2 }, (_, index) => ({ id: `keyboard-${index}`, relativePath: `keyboard/${index}.png`, width: 80, height: 60, hasEffectiveMask: index % 2 === 0 }));
      state.galleryFilter = "masked"; renderGallery(true);
      const filtered = state.images.filter(imageMatchesGalleryFilter);
      const fullRowStart = galleryColumns;
      document.querySelector(`.gallery-item[data-id="${filtered[fullRowStart + Math.min(1, galleryColumns - 1)].id}"]`).focus();
      const home = press("Home"); const end = press("End"); const ctrlHome = press("Home", { ctrlKey: true }); const ctrlEnd = press("End", { ctrlKey: true });
      document.querySelector(`.gallery-item[data-id="${filtered.at(-1).id}"]`).focus();
      const incompleteHome = press("Home"); const incompleteEnd = press("End");
      document.querySelector('.gallery-item[tabindex="0"]').focus();
      const arrow = press("ArrowDown"); const pageDown = press("PageDown"); const right = press("ArrowRight");
      const galleryRole = document.querySelector("#gallery").getAttribute("role"); const galleryCellRole = document.querySelector(".gallery-item").parentElement.getAttribute("role");
      setViewMode("overview"); state.overviewFilter = "all"; state.batchMode = true; renderOverview(true);
      const overviewColumns = Number(document.querySelector("#overviewGrid").getAttribute("aria-colcount"));
      const overviewVisibleCount = overviewColumns * 3 + 2;
      state.images = Array.from({ length: overviewVisibleCount }, (_, index) => ({ id: `keyboard-${index}`, relativePath: `keyboard/${index}.png`, width: 80, height: 60, hasEffectiveMask: true }));
      state.selectedImageIds = new Set(["keyboard-0"]); state.selectionAnchorId = "keyboard-0"; renderOverview(true);
      document.querySelector(`.overview-item[data-id="keyboard-${overviewVisibleCount - 1}"]`).focus();
      const overviewIncompleteHome = press("Home"); const overviewIncompleteEnd = press("End");
      document.querySelector('.overview-item[data-id="keyboard-0"]').focus();
      const ctrlOnly = press("ArrowRight", { ctrlKey: true }); const selectedAfterCtrl = [...state.selectedImageIds].sort();
      document.querySelector('.overview-item[data-id="keyboard-0"]').focus();
      const shift = press("ArrowRight", { shiftKey: true }); const additiveShift = press("ArrowRight", { shiftKey: true, ctrlKey: true });
      const overviewRole = document.querySelector("#overviewGrid").getAttribute("role"); const overviewCssColumns = getComputedStyle(document.querySelector("#overviewGrid")).getPropertyValue("--catalog-columns"); const overviewCellRole = document.querySelector(".overview-item").parentElement.getAttribute("role");
      const result = { arrow, pageDown, home, end, ctrlHome, ctrlEnd, incompleteHome, incompleteEnd, overviewIncompleteHome, overviewIncompleteEnd, right, ctrlOnly, selectedAfterCtrl, shift, additiveShift, selected: [...state.selectedImageIds].sort(), galleryRole, overviewRole, galleryColumns, visibleCount, overviewColumns, overviewVisibleCount, overviewCssColumns, galleryCellRole, overviewCellRole };
      state.images = saved.images; state.currentId = saved.currentId; state.galleryFilter = saved.galleryFilter; state.overviewFilter = saved.overviewFilter; state.batchMode = saved.batchMode; state.selectedImageIds = saved.selectedImageIds; state.selectionAnchorId = saved.selectionAnchorId; setViewMode(saved.viewMode); renderCatalogViews();
      return result;
    });
    for (const movement of [gridKeyboard.arrow, gridKeyboard.pageDown, gridKeyboard.home, gridKeyboard.end, gridKeyboard.ctrlHome, gridKeyboard.ctrlEnd, gridKeyboard.incompleteHome, gridKeyboard.incompleteEnd, gridKeyboard.overviewIncompleteHome, gridKeyboard.overviewIncompleteEnd, gridKeyboard.right, gridKeyboard.ctrlOnly, gridKeyboard.shift, gridKeyboard.additiveShift]) { assert.equal(movement.defaultPrevented, true, JSON.stringify(movement)); assert.equal(movement.mounted, true, JSON.stringify(movement)); }
    assert.ok(Number.isInteger(gridKeyboard.galleryColumns) && gridKeyboard.galleryColumns >= 1, "the 1024px gallery exposes its actual logical column count");
    assert.equal(gridKeyboard.home.activeId, `keyboard-${gridKeyboard.galleryColumns * 2}`, "Home uses the filtered current-row start");
    assert.equal(gridKeyboard.end.activeId, `keyboard-${(gridKeyboard.galleryColumns * 2 - 1) * 2}`, "End uses the filtered current-row end");
    assert.equal(gridKeyboard.ctrlHome.activeId, "keyboard-0", "Ctrl+Home reaches the filtered grid start");
    assert.equal(gridKeyboard.ctrlEnd.activeId, `keyboard-${(gridKeyboard.visibleCount - 1) * 2}`, "Ctrl+End reaches the filtered grid end");
    assert.equal(gridKeyboard.incompleteHome.activeId, `keyboard-${(gridKeyboard.visibleCount - Math.min(2, gridKeyboard.galleryColumns)) * 2}`, "Home finds the start of the final logical row at the 1024px column count");
    assert.equal(gridKeyboard.incompleteEnd.activeId, `keyboard-${(gridKeyboard.visibleCount - 1) * 2}`, "End finds the end of the incomplete final row");
    assert.ok(gridKeyboard.overviewColumns >= 2, "the overview grid has multiple logical columns for the incomplete-row interaction");
    assert.equal(gridKeyboard.overviewIncompleteHome.activeId, `keyboard-${gridKeyboard.overviewVisibleCount - 2}`, "Home finds the start of the incomplete overview row");
    assert.equal(gridKeyboard.overviewIncompleteEnd.activeId, `keyboard-${gridKeyboard.overviewVisibleCount - 1}`, "End finds the end of the incomplete overview row");
    assert.deepEqual(gridKeyboard.selectedAfterCtrl, ["keyboard-0"], "Ctrl-only movement does not alter the logical selection");
    assert.deepEqual(gridKeyboard.selected, ["keyboard-0", "keyboard-1", "keyboard-2"], "Shift and Ctrl+Shift keyboard selection retains the logical range");
    assert.deepEqual({ galleryRole: gridKeyboard.galleryRole, overviewRole: gridKeyboard.overviewRole, galleryCellRole: gridKeyboard.galleryCellRole, overviewCellRole: gridKeyboard.overviewCellRole }, { galleryRole: "grid", overviewRole: "grid", galleryCellRole: "gridcell", overviewCellRole: "gridcell" }, "virtual catalogues expose a grid composite with grid cells");
    assert.ok(Number(gridKeyboard.galleryColumns) >= 1 && Number(gridKeyboard.overviewColumns) === Number(gridKeyboard.overviewCssColumns), "virtual grids expose the same logical column counts as their visible layout");
    await page.locator("#overviewButton").click();
    await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample"]').click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.locator('.overview-item[data-id="sample"]').focus();
    assert.equal(await page.locator('.overview-item[data-id="sample"]').getAttribute("aria-haspopup"), "menu", "overview cards announce their context menu");
    await page.keyboard.press("ContextMenu");
    await page.waitForFunction(() => document.querySelector("#catalogContextMenu").matches(":popover-open"));
    assert.deepEqual(await page.evaluate(() => [...state.selectedImageIds].sort()), ["sample", "sample-two"], "opening a context menu leaves the batch selection unchanged");
    assert.equal(await page.locator("#copyImagePathMenuItem").isVisible(), true, "filesystem overview cards expose Copy path");
    await page.locator("#copyImagePathMenuItem").click();
    assert.deepEqual(await page.evaluate(() => window.__copiedPaths), ["G:\\画像 フォルダー\\sample image.png", "G:\\画像 フォルダー\\sample image.png"], "overview copies only the context-menu image");
    await page.evaluate(() => { window.__clipboardFail = true; });
    await page.locator('.overview-item[data-id="sample"]').click({ button: "right" });
    await page.locator("#copyImagePathMenuItem").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    const clipboardError = await page.locator("#errorDialog").textContent();
    assert.match(clipboardError, /パスをコピーできません/, "clipboard failure uses a readable error dialog");
    assert.doesNotMatch(clipboardError, /NotAllowedError|fixture clipboard failure/, "clipboard failure never exposes the raw DOMException");
    await page.locator("#errorDialogClose").click();
    await page.waitForFunction(() => !document.querySelector("#errorDialog").open);
    assert.equal(await page.locator('.overview-item[data-id="sample"]').evaluate((item) => document.activeElement === item), true, "closing a copy failure returns focus to the context-menu card");
    await page.locator("#selectionClearButton").click();
    await page.locator("#closeOverviewButton").click();
    await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
    for (const selector of ["#confirmDialog", "#detectDialog", "#applyDialog", "#processingDialog"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-labelledby"), `${selector} must have an accessible title`);
    }
    for (const selector of ["#detectConfidenceRange", "#detectConfidenceNumber", "#detectParallelism", "#processingProgress", "#applyProgress"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-label"), `${selector} must have an accessible name`);
    }
    const dismissFromBackdrop = async (selector) => {
      await page.locator(selector).evaluate((dialog) => { if (!dialog.open) dialog.showModal(); });
      const { outside } = await dialogPointerPoints(page, selector);
      await pointerGesture(page, outside);
      await page.waitForFunction((target) => document.querySelector(target).open === false, selector);
    };
    await dismissFromBackdrop("#mosaicHelpDialog");
    await dismissFromBackdrop("#modelHelpDialog");
    await dismissFromBackdrop("#applyDialog");
    await page.locator("#settingsDialog").evaluate((dialog) => { if (!dialog.open) dialog.showModal(); });
    await page.locator("#settingsDialog").evaluate((dialog) => {
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]')].filter((element) => element.offsetParent !== null);
      focusable.at(-1).focus();
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.contains(document.activeElement)), true, "modal focus stays inside the settings dialog");
    const settingsPoints = await dialogPointerPoints(page, "#settingsDialog");
    await pointerGesture(page, settingsPoints.inside, settingsPoints.outside);
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true, "dragging from settings content to its backdrop must not close it");
    await pointerGesture(page, settingsPoints.outside, settingsPoints.inside);
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true, "dragging from the backdrop into settings content must not close it");
    await pointerGesture(page, settingsPoints.outside);
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    await page.locator("#settingsDialog").evaluate((dialog) => dialog.showModal());
    await page.locator("#settingsCloseButton").click();
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), false, "settings close button still closes the dialog");
    await page.locator("#settingsButton").focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), "settingsButton", "settings trigger receives focus before its async opening");
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => document.activeElement.id === "settingsButton");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settingsButton", "async settings opening restores focus to its invoker");
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator('[data-model-help="ntd11"]').focus();
    await page.locator('[data-model-help="ntd11"]').click();
    await page.waitForFunction(() => document.querySelector("#modelHelpDialog").open);
    await page.locator("#modelHelpCloseButton").click();
    await page.waitForFunction(() => document.activeElement?.dataset?.modelHelp === "ntd11");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.modelHelp), "ntd11", "model help restores focus to its invoker");
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => document.activeElement.id === "settingsButton");
    await page.locator("#mosaicHelpDialog").evaluate((dialog) => dialog.showModal());
    const mosaicHelpPoints = await dialogPointerPoints(page, "#mosaicHelpDialog");
    await page.mouse.click(mosaicHelpPoints.outside.x, mosaicHelpPoints.outside.y, { button: "right" });
    assert.equal(await page.locator("#mosaicHelpDialog").evaluate((dialog) => dialog.open), true, "right-clicking a dismissible backdrop must not close the dialog");
    await page.locator("#mosaicHelpCloseButton").click();
    await page.locator("#mosaicHelpDialog").evaluate((dialog) => dialog.showModal());
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#mosaicHelpDialog").open);

    await page.evaluate(() => { state.pendingDetectionTargetIds = ["sample"]; $("#detectDialog").showModal(); });
    const detectPoints = await dialogPointerPoints(page, "#detectDialog");
    await pointerGesture(page, detectPoints.outside);
    await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    assert.deepEqual(await page.evaluate(() => state.pendingDetectionTargetIds), [], "detect backdrop dismissal clears its pending target IDs");

    await page.evaluate(() => {
      window.__confirmBackdropResult = undefined;
      void confirmAction("Backdrop", "Dismiss").then((accepted) => { window.__confirmBackdropResult = accepted; });
    });
    const confirmPoints = await dialogPointerPoints(page, "#confirmDialog");
    await pointerGesture(page, confirmPoints.outside);
    await page.waitForFunction(() => window.__confirmBackdropResult !== undefined);
    assert.equal(await page.evaluate(() => window.__confirmBackdropResult), false, "confirm backdrop dismissal keeps the cancel result");

    await page.locator("#modelDownloadDialog").evaluate((dialog) => dialog.showModal());
    const downloadPoints = await dialogPointerPoints(page, "#modelDownloadDialog");
    await pointerGesture(page, downloadPoints.outside);
    assert.equal(await page.locator("#modelDownloadDialog").evaluate((dialog) => dialog.open), true, "model download confirmation keeps its existing backdrop lock");
    await page.locator("#modelDownloadDialog").evaluate((dialog) => dialog.close());
    await page.evaluate(() => modelDownloadConfirmation("sam"));
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadClose").disabled);
    const runningDownloadPoints = await dialogPointerPoints(page, "#modelDownloadDialog");
    await pointerGesture(page, runningDownloadPoints.outside);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#modelDownloadDialog").evaluate((dialog) => dialog.open), true, "a running model download ignores backdrop and Escape dismissal");
    await page.locator("#modelDownloadCancel").click();
    await page.waitForFunction(() => !document.querySelector("#modelDownloadClose").disabled);
    await page.locator("#modelDownloadClose").click();

    await page.locator("#applyDialog").evaluate((dialog) => { state.applyRunning = true; dialog.showModal(); });
    const applyPoints = await dialogPointerPoints(page, "#applyDialog");
    await pointerGesture(page, applyPoints.outside);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#applyDialog").evaluate((dialog) => dialog.open), true, "a running save ignores backdrop and Escape dismissal");
    await page.locator("#applyDialog").evaluate((dialog) => { state.applyRunning = false; dialog.close(); });

    await page.locator("#processingDialog").evaluate((dialog) => dialog.showModal());
    const processingPoints = await dialogPointerPoints(page, "#processingDialog");
    await pointerGesture(page, processingPoints.outside);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#processingDialog").getAttribute("open"), "", "processing dialog must ignore backdrop and Escape dismissal");
    await page.locator("#processingDialog").evaluate((dialog) => dialog.close());
    assert.equal(await page.locator(".help-button").first().textContent(), "", "help buttons use an information icon instead of a question mark");
    assert.ok(await page.locator(".help-button").first().getAttribute("aria-label"));

    await selectFixtureImage(page, pageErrors, consoleErrors);
    assert.equal(await page.locator('.gallery-item[aria-pressed], .gallery-item.batch-selected').count(), 0, "the normal gallery owns only the current-image state");
    await page.locator("#overviewButton").click();
    await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
    const currentBeforeBatch = await page.locator(".overview-item.current").getAttribute("data-id");
    await page.locator("#batchModeButton").click();
    assert.equal(await page.locator("#batchModeButton").getAttribute("aria-pressed"), "true", "batch edit is an explicit overview mode");
    assert.equal(await page.locator("#overviewSelectionBar").isVisible(), true, "batch controls appear immediately below the overview toolbar");
    assert.equal(await page.locator('[data-selection-action]').count(), 7, "overview batch edit retains all seven actions");
    await page.locator('.overview-item[data-id="sample"]').focus();
    await page.keyboard.press("Space");
    await page.locator('.overview-item[data-id="sample-two"]').click();
    assert.equal(await page.locator("#overviewPane").isVisible(), true, "batch selection stays in the overview");
    assert.equal(await page.locator(".overview-item.current").getAttribute("data-id"), currentBeforeBatch, "batch selection does not change the current image");
    assert.equal(await page.locator("#selectionCount").textContent(), "2件を選択中", "the overview selection bar reports the selected image count");
    assert.equal(await page.locator('.overview-item[data-id="sample"]').evaluate((item) => item.classList.contains("batch-selected")), true, "the first overview selection is green");
    assert.equal(await page.locator('.overview-item[data-id="sample-two"]').evaluate((item) => item.classList.contains("batch-selected")), true, "the second overview selection is green");
    assert.equal(await page.locator('.overview-item[data-id="sample"]').getAttribute("aria-pressed"), "true", "keyboard overview selection exposes its selected state");
    for (const [width, height, language] of [[1024, 768, "ja"], [1920, 1080, "en"]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((language) => loadTranslations(language), language);
      await page.locator("#selectionActionsButton").click();
      const geometry = await page.locator("#selectionActionsMenu").evaluate((menu) => {
        const button = document.querySelector("#selectionActionsButton").getBoundingClientRect(); const rect = menu.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, buttonRight: button.right, buttonBottom: button.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth };
      });
      assert.equal(geometry.right, geometry.buttonRight, `selection menu right aligns with its button at ${width}x${height} (${language})`);
      assert.ok(geometry.top >= geometry.buttonBottom + 4 && geometry.top <= geometry.buttonBottom + 6 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight && geometry.scrollWidth <= geometry.viewportWidth, `selection menu stays in the viewport without horizontal overflow at ${width}x${height} (${language})`);
      await page.locator("#selectionActionsMenu").evaluate((menu) => menu.hidePopover());
    }
    await page.evaluate(() => loadTranslations("ja"));
    await page.setViewportSize({ width: 1280, height: 720 });
    const batchDetectBefore = detectRequests.length;
    await page.locator("#selectionActionsButton").click();
    const selectionMenu = await page.locator("#selectionActionsMenu").evaluate((menu) => {
      const button = document.querySelector("#selectionActionsButton").getBoundingClientRect(); const rect = menu.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, buttonRight: button.right, buttonBottom: button.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.equal(selectionMenu.right, selectionMenu.buttonRight, "selection menu right edge anchors to its button");
    assert.ok(selectionMenu.top >= selectionMenu.buttonBottom && selectionMenu.right <= selectionMenu.viewportWidth && selectionMenu.bottom <= selectionMenu.viewportHeight, `selection menu is visibly anchored below its button: ${JSON.stringify(selectionMenu)}`);
    await page.locator('[data-selection-action="detect"]').click();
    await page.locator("#detectStartButton").click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(detectRequests.length, batchDetectBefore + 1, "batch auto detect sends exactly one request");
    assert.deepEqual(detectRequests.at(-1).imageIds.sort(), ["sample", "sample-two"], "batch auto detect receives exactly the selected gallery ids");
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => !document.querySelector("#processingDialog").open, null, { timeout: 5000 });
    await page.locator("#selectionClearButton").click();
    assert.equal(await page.locator('.overview-item.batch-selected').count(), 0, "exiting batch edit clears every green overview selection");
    assert.equal(await page.locator('.overview-item[aria-pressed]').count(), 0, "exiting batch edit removes overview selection semantics");
    await page.locator("#batchModeButton").click();
    assert.equal(await page.locator("#selectionCount").textContent(), "0件を選択中", "re-entering batch edit starts with no stale selection");
    await page.locator("#selectionClearButton").click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
    assert.equal(await page.locator('.gallery-item[aria-pressed], .gallery-item.batch-selected').count(), 0, "returning to the gallery never restores overview selection semantics");

    const catalogCardsAndHidden = await page.evaluate(async () => {
      const box = (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height }; };
      const image = state.images.find((item) => item.id === "sample");
      await setHidden(image, true); state.galleryFilter = "all"; renderGallery(true);
      const galleryCard = document.querySelector('.gallery-item[data-id="sample"]'); const galleryImage = galleryCard.querySelector("img"); const galleryFooter = galleryCard.querySelector(".catalog-card-footer");
      const allIncludesHidden = Boolean(galleryCard) && galleryCard.classList.contains("hidden");
      state.galleryFilter = "hidden"; renderGallery(true); const hiddenOnly = document.querySelectorAll(".gallery-item").length === 1;
      const gallery = { card: box(galleryCard), image: box(galleryImage), footer: box(galleryFooter), name: box(galleryCard.querySelector(".gallery-name")), meta: box(galleryCard.querySelector(".gallery-meta")) };
      state.galleryFilter = "all"; setViewMode("overview"); state.overviewFilter = "all"; renderOverview(true);
      const overviewCard = document.querySelector('.overview-item[data-id="sample"]'); const overviewImage = overviewCard.querySelector("img"); const overviewFooter = overviewCard.querySelector(".catalog-card-footer");
      const overviewIncludesHidden = overviewCard.classList.contains("hidden");
      const result = {
        allIncludesHidden, hiddenOnly, overviewIncludesHidden,
        gallery,
        overview: { card: box(overviewCard), image: box(overviewImage), footer: box(overviewFooter), name: box(overviewCard.querySelector(".overview-item-name")), meta: box(overviewCard.querySelector(".overview-item-dimensions")) },
      };
      await setHidden(image, false); state.galleryFilter = "all"; setViewMode("edit"); return result;
    });
    assert.deepEqual({ all: catalogCardsAndHidden.allIncludesHidden, hidden: catalogCardsAndHidden.hiddenOnly, overview: catalogCardsAndHidden.overviewIncludesHidden }, { all: true, hidden: true, overview: true }, "All includes dimmed hidden cards while Hidden isolates them");
    for (const [name, card] of Object.entries({ gallery: catalogCardsAndHidden.gallery, overview: catalogCardsAndHidden.overview })) {
      assert.equal(card.footer.height, 32, `${name} card footer has one shared 32px row`);
      assert.ok(card.image.left - card.card.left >= 5 && card.image.right <= card.card.right - 5 && card.image.top - card.card.top >= 5, `${name} preview stays inside the card border`);
      assert.ok(Math.abs(card.name.top - card.meta.top) <= 1 && Math.abs(card.name.bottom - card.meta.bottom) <= 1, `${name} filename and dimensions share one baseline row: ${JSON.stringify(card)}`);
    }

    for (const [width, language] of [[1024, "ja"], [1920, "en"]]) {
      await page.setViewportSize({ width, height: 768 }); await page.evaluate((locale) => loadTranslations(locale), language);
      const editor = await page.evaluate(() => {
        const box = (selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
        const toolbar = box("#canvasToolRail"); const stage = box("#canvasStage"); const controls = [...document.querySelectorAll(".candidate-section-actions > button")].map((node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, text: node.textContent }; });
        const candidateOverflow = [...document.querySelectorAll(".candidate-section-actions, .candidate-row")].some((node) => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight);
        const candidateHit = [...document.querySelectorAll(".candidate-section-actions > button")].every((button) => { const rect = button.getBoundingClientRect(); const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return button === target || button.contains(target); });
        const targetChoices = document.querySelector(".candidate-pane .target-choices"); const targetPane = document.querySelector(".candidate-pane"); const targetBounds = targetChoices.getBoundingClientRect(); const paneBounds = targetPane.getBoundingClientRect(); const targetInputs = [...targetChoices.querySelectorAll('input[type="checkbox"]')]; const targetChips = [...targetChoices.querySelectorAll(".target-chip")]; const targetLabel = targetChoices.querySelector(".target-choices-label").getBoundingClientRect();
        const blockHeading = document.querySelector(".block-control-heading"); const blockLabel = blockHeading.querySelector('label[for="divisor"]'); const blockHelp = document.querySelector("#mosaicHelpButton"); const headingBox = blockHeading.getBoundingClientRect(); const labelBox = blockLabel.getBoundingClientRect(); const helpBox = blockHelp.getBoundingClientRect();
        return { toolbar, stage, controls, candidateOverflow, candidateHit, targets: { count: targetInputs.length, native: targetInputs.every((input) => input.type === "checkbox"), oneLine: new Set([targetLabel.top, ...targetChips.map((item) => item.getBoundingClientRect().top)].map(Math.round)).size === 1, centered: targetChips.every((chip) => Math.abs((chip.getBoundingClientRect().top + chip.getBoundingClientRect().bottom) / 2 - (targetLabel.top + targetLabel.bottom) / 2) <= 1), withinPane: targetBounds.left >= paneBounds.left && targetBounds.right <= paneBounds.right, compact: targetChips.every((chip) => { const rect = chip.getBoundingClientRect(); return rect.height >= 26 && rect.height <= 28; }), selected: targetChips.every((chip) => chip.classList.contains("is-selected")), tracksAbsent: !targetChoices.querySelector(".target-switch-track") }, overviewAll: document.querySelector('[data-overview-filter="all"]').textContent, orientation: document.querySelector("#canvasToolRail").getAttribute("aria-orientation"), help: { label: blockHelp.getAttribute("aria-label"), title: blockHelp.title, parent: blockHelp.parentElement.className, nestedInLabel: Boolean(blockHelp.closest("label")), followsLabel: helpBox.left >= labelBox.right, fitsHeading: headingBox.left <= labelBox.left && headingBox.right >= helpBox.right && headingBox.width >= labelBox.width + helpBox.width }, toolPosition: document.querySelector("#settingsToolPosition") };
      });
      assert.ok(editor.toolbar.left === editor.stage.left && editor.toolbar.right === editor.stage.right && editor.toolbar.top === editor.stage.top && editor.toolbar.height > 30, `toolbar fills the editor top at ${width}/${language}`);
      assert.equal(editor.toolPosition, null, "legacy tool position control is absent");
      assert.equal(editor.overviewAll, language === "ja" ? "すべて" : "All", `overview All is localized at ${width}/${language}`);
      assert.ok(editor.help.label && editor.help.title, `localized mosaic help trigger is labelled at ${width}/${language}`);
      assert.equal(editor.help.parent, "block-control-heading", `mosaic help follows the block-size label at ${width}/${language}`);
      assert.equal(editor.help.nestedInLabel, false, `mosaic help is not nested in the block-size label at ${width}/${language}`);
      assert.equal(editor.help.followsLabel && editor.help.fitsHeading, true, `mosaic help sits immediately after the block-size label at ${width}/${language}`);
      assert.equal(editor.orientation, "horizontal", `toolbar exposes its horizontal layout at ${width}/${language}`);
      assert.ok(editor.controls.every((control) => control.width > 0 && control.height >= 25 && control.height <= 28), `candidate section controls use compact buttons at ${width}/${language}`);
      assert.equal(editor.controls.filter((control) => control.text === (language === "ja" ? "検出範囲" : "Detection range")).length, 2, `both candidate sections expose a detection-range button at ${width}/${language}`);
      assert.equal(editor.candidateOverflow, false, `candidate controls do not overflow at ${width}/${language}`);
      assert.equal(editor.candidateHit, true, `candidate display segments own their hit targets at ${width}/${language}`);
      assert.equal(editor.targets.count === 2 && editor.targets.native && editor.targets.oneLine && editor.targets.centered && editor.targets.withinPane && editor.targets.compact && editor.targets.selected && editor.targets.tracksAbsent, true, `target label and chips stay compact and aligned at ${width}/${language}`);
      if (width === 1024 && language === "ja") {
        const penis = page.locator("#detectTargetPenis"); const pussy = page.locator("#detectTargetPussy");
        await penis.focus(); await penis.press("Space");
        assert.equal(await penis.isChecked(), false, "keyboard toggles the penis target off");
        assert.equal(await page.locator("#detectTargetPenis").evaluate((input) => input.closest(".target-chip").classList.contains("is-selected")), false, "an unselected target uses the neutral chip");
        await pussy.focus(); await pussy.press("Space");
        const zeroTargets = await page.evaluate(() => ({ targets: settingsPayload().detection.targets, visible: !document.querySelector("#detectionTargetValidation").hidden, text: document.querySelector("#detectionTargetValidation").textContent }));
        assert.deepEqual(zeroTargets.targets, [], "settings payload preserves an explicit empty target selection");
        assert.equal(zeroTargets.visible && zeroTargets.text === "penis または pussy を選択してください。", true, "empty target selection shows localized inline validation");
        await penis.focus(); await penis.press("Space"); await pussy.focus(); await pussy.press("Space");
      }
      await page.locator("#mosaicHelpButton").click();
      const mosaicHelp = await page.locator("#mosaicHelpDialog").evaluate((dialog) => {
        const links = [...dialog.querySelectorAll(".mosaic-guideline-links a")];
        const row = dialog.querySelector(".mosaic-guideline-links");
        return {
          guideline: dialog.querySelector('[data-i18n="mosaicHelp.guideline"]').textContent,
          noFormula: !dialog.querySelector("#mosaicHelpFormula, #mosaicHelpBlock"),
          links: links.map((link) => ({ text: link.textContent, href: link.href, target: link.target, rel: link.rel })),
          oneLine: getComputedStyle(row).whiteSpace === "nowrap" && row.scrollWidth <= row.clientWidth,
        };
      });
      const guideline = language === "ja"
        ? "モザイクの既定値は、以下のサイトのガイドラインを基準に、画像の長辺の1/100（最低4 px）に設定しています。"
        : "The default mosaic setting uses the following sites' guidelines as a reference: 1/100 of the image's long edge (minimum 4 px).";
      assert.equal(mosaicHelp.guideline, guideline, `mosaic help gives the localized default at ${width}/${language}`);
      assert.equal(mosaicHelp.noFormula, true, `mosaic help omits implementation formula details at ${width}/${language}`);
      assert.deepEqual(mosaicHelp.links, [
        { text: "BOOTH", href: "https://booth.pm/guidelines", target: "_blank", rel: "noreferrer" },
        { text: "pixiv", href: "https://www.pixiv.net/terms/?page=guideline", target: "_blank", rel: "noreferrer" },
        { text: "FANZA", href: "https://terms.dmm.co.jp/doujin_regulation", target: "_blank", rel: "noreferrer" },
        { text: "DLsite", href: "https://www.dlsite.com/home/mosaic", target: "_blank", rel: "noreferrer" },
      ], `mosaic help keeps the requested guideline links in order at ${width}/${language}`);
      assert.equal(mosaicHelp.oneLine, true, `mosaic guideline links remain on one line at ${width}/${language}`);
      await page.locator("#mosaicHelpCloseButton").click();
    }
    const targetModes = await page.evaluate(async () => {
      state.maskStatus.set("sample", true); state.maskStatus.set("sample-two", true);
      await setReviewed(state.images.find((image) => image.id === "sample"), true);
      state.currentId = "sample-two";
      return ["current", "all", "masked", "reviewed"].map((mode) => ({ mode, ids: saveTargets(mode), count: saveTargets(mode).length }));
    });
    assert.deepEqual(targetModes, [{ mode: "current", ids: ["sample-two"], count: 1 }, { mode: "all", ids: ["sample", "sample-two"], count: 2 }, { mode: "masked", ids: ["sample", "sample-two"], count: 2 }, { mode: "reviewed", ids: ["sample"], count: 1 }], "save target modes keep the full catalogue as the normal batch target while retaining explicit filters");
    const editorHistoryAndDisplay = await page.evaluate(async () => {
      // This block verifies the transient editor-history implementation itself.
      // Folder import now creates a durable project, so isolate the legacy
      // in-memory history scenario instead of accidentally routing it through
      // the project's HTTP undo endpoint.
      const original = { candidates: state.candidates, images: state.candidateImages, removed: state.removedCandidateIds, history: state.history, index: state.historyIndex, baseRemoved: state.historyRemovedCandidateIds, baseCandidates: state.historyCandidateIds, settings: state.settings.confirmations.candidateDelete, project: state.project, projectReadOnly: state.projectReadOnly };
      state.project = null; state.projectReadOnly = false;
      const mask = document.createElement("canvas"); mask.width = addCanvas.width; mask.height = addCanvas.height; mask.getContext("2d").fillRect(0, 0, 16, 16);
      const candidate = { id: "history-candidate", role: "apply", enabled: true, labelToken: "penis", source: "target", refinement: null, color: "#fff" };
      state.candidates = [candidate]; state.candidateImages = new Map([[candidate.id, mask]]); state.removedCandidateIds = new Set(); state.settings.confirmations.candidateDelete = false; resetHistoryToCurrentManualMask();
      await deleteCandidate(candidate); const afterDelete = state.removedCandidateIds.has(candidate.id) && state.history.length === 1 && currentRecord().candidateCount === 0;
      restoreSnapshot(0); const undo = !state.removedCandidateIds.has(candidate.id); restoreSnapshot(1); const redo = state.removedCandidateIds.has(candidate.id);
      for (let index = 0; index < 13; index += 1) recordHistoryOperation({ kind: "removeCandidates", ids: [`trim-${index}`] });
      const trimmed = state.history.length > 12 && !state.historyRemovedCandidateIds.has("trim-0");
      state.removedCandidateIds.delete(candidate.id);
      renderCandidates();
      document.querySelector('[data-candidate-effective-toggle="apply"]').click();
      const effective = state.blinkModes.get(candidate.id) === "effective"; state.currentId = "sample"; state.drafts.set("sample-two", { candidateRevision: 0, removedCandidateIds: [] }); await selectImage("sample-two", true); const cleared = state.blinkCandidateIds.size === 0 && state.blinkModes.size === 0;
      state.candidates = original.candidates; state.candidateImages = original.images; state.removedCandidateIds = original.removed; state.history = original.history; state.historyIndex = original.index; state.historyRemovedCandidateIds = original.baseRemoved; state.historyCandidateIds = original.baseCandidates; state.settings.confirmations.candidateDelete = original.settings; state.project = original.project; state.projectReadOnly = original.projectReadOnly;
      return { afterDelete, undo, redo, trimmed, effective, cleared };
    });
    assert.deepEqual(editorHistoryAndDisplay, { afterDelete: true, undo: true, redo: true, trimmed: true, effective: true, cleared: false }, `durable undo/redo and selection failure preserve the current display state: ${JSON.stringify(editorHistoryAndDisplay)}`);
    const candidateDisplayLifecycle = await page.evaluate(async () => {
      const original = {
        candidates: state.candidates, images: state.candidateImages, removed: state.removedCandidateIds,
        tool: state.tool, confirmation: state.settings.confirmations.candidateRoleDelete,
      };
      const candidate = { id: "display-exclude", role: "exclude", enabled: true, forced: true, labelToken: "hand", source: "hand_exclusion", refinement: null, color: "#000" };
      const resetLayers = () => {
        exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
        exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
        state.activeStroke = null; state.mosaicPending = false;
      };
      state.candidates = [candidate]; state.candidateImages = new Map(); state.removedCandidateIds = new Set();
      state.settings.confirmations.candidateRoleDelete = false; state.tool = "exclude_eraser";
      resetLayers(); exclusionCtx.fillRect(2, 2, 4, 4);
      clearCandidateBlink(); setCandidateDisplayMode([candidate.id, "manual:exclude"], "normal");
      beginManualStroke({ x: 8, y: 8 });
      const joinsNormal = candidateDisplayMode("manual:excludeErase") === "normal";
      resetLayers(); exclusionCtx.fillRect(2, 2, 4, 4); state.candidates = [];
      clearCandidateBlink(); setCandidateDisplayMode(["manual:exclude"], "normal");
      beginManualStroke({ x: 8, y: 8 });
      const joinsManualOnly = candidateDisplayMode("manual:excludeErase") === "normal";
      state.candidates = [candidate];
      resetLayers(); exclusionCtx.fillRect(2, 2, 4, 4); clearCandidateBlink(); setCandidateDisplayMode([candidate.id], "normal");
      beginManualStroke({ x: 8, y: 8 });
      const skipsHiddenManual = candidateDisplayMode("manual:excludeErase") === "off";
      resetLayers(); clearCandidateBlink(); setCandidateDisplayMode([candidate.id], "normal");
      await batchCandidateOperation("exclude:delete");
      const roleDeleteClearsDisplay = state.removedCandidateIds.has(candidate.id)
        && state.blinkCandidateIds.size === 0 && state.blinkModes.size === 0 && state.blinkTimer === null
        && !document.querySelector("#candidatePane").classList.contains("blink-active");
      clearCandidateBlink(); state.candidates = original.candidates; state.candidateImages = original.images;
      state.removedCandidateIds = original.removed; state.tool = original.tool;
      state.settings.confirmations.candidateRoleDelete = original.confirmation;
      renderCandidates(); render();
      return { joinsNormal, joinsManualOnly, skipsHiddenManual, roleDeleteClearsDisplay };
    });
    assert.deepEqual(candidateDisplayLifecycle, { joinsNormal: true, joinsManualOnly: true, skipsHiddenManual: true, roleDeleteClearsDisplay: true }, `browser candidate display lifecycle clears deleted ranges and only adds an exclusion erase to a fully normal existing range: ${JSON.stringify(candidateDisplayLifecycle)}`);
    const workspaceDraftRetention = await page.evaluate(async () => {
      // This verifies the in-memory draft/history fallback independently from
      // the durable-project implementation exercised in the project UI suite.
      const originalProject = state.project; const originalProjectReadOnly = state.projectReadOnly;
      state.project = null; state.projectReadOnly = false;
      const draft = (label) => ({
        add: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+XwUPpQAAAABJRU5ErkJggg==",
        exclusion: "", exclusionErase: "", manualEnabled: true, manualExclusionEnabled: true,
        manualExclusionEraseEnabled: true, manualExclusionForced: true, manualMaskPresent: true,
        candidateRevision: 0, removedCandidateIds: [], history: [{ kind: "clearManual", role: "apply", label }], historyIndex: 1,
        historyBase: { add: "", exclusion: "", exclusionErase: "", removedCandidateIds: [], candidateIds: [] },
      });
      state.drafts.set("sample", draft("A")); state.drafts.set("sample-two", draft("B"));
      await selectImage("sample", true, { saveCurrentDraft: false });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await selectImage("sample-two", true, { saveCurrentDraft: false });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await selectImage("sample", true, { saveCurrentDraft: false });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const restoredHistory = state.history.length === 1 && state.historyIndex === 1;
      restoreSnapshot(0); const undo = state.historyIndex === 0;
      restoreSnapshot(1); const redo = state.historyIndex === 1;
      const bulk = draftPayload(["sample", "sample-two"]);
      const result = { restoredHistory, undo, redo, bulk: Object.keys(bulk).sort(), retained: [state.drafts.has("sample"), state.drafts.has("sample-two")] };
      state.project = originalProject; state.projectReadOnly = originalProjectReadOnly;
      return result;
    });
    assert.deepEqual(workspaceDraftRetention, { restoredHistory: true, undo: true, redo: true, bulk: ["sample", "sample-two"], retained: [true, true] }, "workspace persistence keeps per-image undo drafts and includes both manual masks in bulk saving");

    // This deliberately uses real pointer events rather than the canvas helpers.
    // A stroke updates both the effective mask and mosaic preview during the
    // drag. The one worker keeps only the newest pending frame. Test both a
    // normal editor image and a 4K image.
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const [width, height] of (browserCoverage ? [[1024, 768]] : [[1024, 768], [3840, 2160]])) {
      // Chromium's precise-coverage counters are signed 32-bit values.  One
      // real sample is enough for instrumentation; the ordinary E2E run keeps
      // the full eight-event pointer gesture below.
      const pointerSteps = browserCoverage ? 1 : 8;
      await page.locator("#brushTool").click();
      await page.locator("#editorCanvas").scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(async ({ width, height }) => {
        // The previous bitmap remains owned by the fixture cache.  Releasing
        // the preview is sufficient here; closing it races a queued render.
        releaseMosaicPreview();
        const source = document.createElement("canvas"); source.width = width; source.height = height;
        const sourceContext = source.getContext("2d");
        sourceContext.fillStyle = "#ffffff"; sourceContext.fillRect(0, 0, width, height);
        // Fine black/white stripes guarantee that a block mosaic changes pixels in
        // the painted region, including when the 4K image is fitted to the stage.
        sourceContext.fillStyle = "#000000";
        for (let x = 0; x < width; x += 4) sourceContext.fillRect(x, 0, 2, height);
        state.currentImage = await createImageBitmap(source);
        const record = state.images.find((image) => image.id === "sample");
        record.width = width; record.height = height;
        canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft();
        state.candidates = []; state.candidateImages = new Map(); state.removedCandidateIds = new Set();
        state.mosaicPreviewEnabled = true; fitImage(); requestMosaicPreview();
        const rect = canvas.getBoundingClientRect();
        const logical = { x: Math.round(width * 0.48), y: Math.round(height * 0.5) };
        return {
          beforeGeneration: state.mosaicPreviewGeneration,
          x: rect.left + state.view.x + logical.x * state.view.scale,
          y: rect.top + state.view.y + logical.y * state.view.scale,
          endX: rect.left + state.view.x + (logical.x + Math.max(24, Math.round(width * 0.08))) * state.view.scale,
          endY: rect.top + state.view.y + logical.y * state.view.scale,
          logical,
        };
      }, { width, height });
      await page.waitForFunction(() => !state.mosaicWorkerBusy && state.mosaicSourceId && !state.mosaicPreviewRequested, null, { timeout: 15000 });
      const normalCursors = await page.evaluate(() => ["brush", "mosaic_eraser", "eraser", "exclude_eraser", "boundary", "polygon", "boundary_brush", "bucket", "exclude_bucket"].map((tool) => {
        setTool(tool); return getComputedStyle(document.querySelector("#editorCanvas")).cursor;
      }));
      assert.deepEqual(normalCursors, Array(9).fill("default"), `${width}x${height} ordinary editor tools never use crosshair, cell, or a hidden cursor`);
      await page.mouse.move(geometry.x, geometry.y); await page.mouse.down({ button: "middle" });
      assert.equal(await page.locator("#editorCanvas").evaluate((node) => getComputedStyle(node).cursor), "grabbing", `${width}x${height} middle-button panning alone uses grabbing`);
      await page.mouse.up({ button: "middle" });
      assert.equal(await page.locator("#editorCanvas").evaluate((node) => getComputedStyle(node).cursor), "default", `${width}x${height} ending a pan restores the standard pointer`);
      await page.locator("#brushTool").click();
      await page.mouse.move(geometry.x, geometry.y);
      await page.mouse.down();
      await page.mouse.move(geometry.endX, geometry.endY, { steps: pointerSteps });
      await page.waitForFunction(({ logical }) => state.activeStroke?.points.length >= 2
        && combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0, geometry);
      const duringBrush = await page.evaluate(({ logical }) => ({
        active: state.activeStroke?.points.length >= 2,
        mask: combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0,
        preview: [...mosaicCtx.getImageData(logical.x, logical.y, 1, 1).data]
          .some((value, index) => value !== originalCtx.getImageData(logical.x, logical.y, 1, 1).data[index]),
      }), geometry);
      assert.deepEqual(duringBrush, { active: true, mask: true, preview: true }, `${width}x${height} brush updates its mosaic preview during the drag`);
      await page.mouse.up();
      await page.waitForFunction(() => !state.activeStroke && state.history.length > 0 && !state.mosaicWorkerBusy && !state.mosaicPending, null, { timeout: 15000 });
      const afterBrushPreview = await page.evaluate(({ logical }) => [...mosaicCtx.getImageData(logical.x, logical.y, 1, 1).data]
        .some((value, index) => value !== originalCtx.getImageData(logical.x, logical.y, 1, 1).data[index]), geometry);
      assert.equal(afterBrushPreview, true, `${width}x${height} brush confirms one mosaic worker frame after pointerup`);
      if (width === 3840) {
        await page.locator("#compareViewButton").click();
        await page.evaluate(() => { state.compareSplit = .5; updateCompareSplitter(); flushRender(); });
        const cursorGeometry = await page.evaluate(() => {
          const rect = canvas.getBoundingClientRect();
          const point = { x: Math.round(state.currentImage.width * .5), y: Math.round(state.currentImage.height * .5) };
          const x = rect.left + state.view.x + point.x * state.view.scale;
          const y = rect.top + state.view.y + point.y * state.view.scale;
          return { left: { x, y }, right: { x: x + rect.width * state.compareSplit, y }, width: rect.width };
        });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => {
          const canvas = document.querySelector("#editorCanvas");
          const cursor = document.querySelector("#brushCursor");
          const originalClearRect = ctx.clearRect.bind(ctx);
          const metrics = { recording: false, starts: [], latencies: [], clears: 0, sides: new Set(), last: null };
          const begin = (event) => { if (metrics.recording) metrics.starts.push(performance.now()); };
          const end = (event) => {
            if (!metrics.recording) return;
            const started = metrics.starts.shift();
            if (started === undefined) return;
            metrics.latencies.push(performance.now() - started);
            const rect = canvas.getBoundingClientRect();
            metrics.sides.add(event.clientX - rect.left >= rect.width * state.compareSplit ? "right" : "left");
            metrics.last = { x: event.clientX, y: event.clientY };
          };
          ctx.clearRect = (...args) => { if (metrics.recording) metrics.clears += 1; return originalClearRect(...args); };
          canvas.addEventListener("pointermove", begin, true); canvas.addEventListener("pointermove", end);
          window.__brushCursorPerf = { metrics, cursor, originalClearRect, begin, end, canvas };
        });
        const cursorMetrics = [];
        for (const tool of ["#brushTool", "#mosaicEraserTool", "#eraserTool", "#excludeEraserTool"]) {
          await page.locator(tool).click();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.evaluate(() => { window.__brushCursorPerf.metrics.latencies.length = 0; window.__brushCursorPerf.metrics.clears = 0; window.__brushCursorPerf.metrics.sides.clear(); window.__brushCursorPerf.metrics.recording = true; });
          for (let index = 0; index < 240; index += 1) {
            const side = index % 2 ? "right" : "left";
            const point = cursorGeometry[side];
            await page.mouse.move(point.x + (index % 30), point.y + Math.floor(index / 30));
          }
          cursorMetrics.push(await page.evaluate(() => {
            const value = window.__brushCursorPerf; const { metrics, cursor } = value;
            metrics.recording = false;
            const latency = [...metrics.latencies].sort((left, right) => left - right);
            const rect = cursor.getBoundingClientRect();
            return {
              count: latency.length, clears: metrics.clears, sides: [...metrics.sides].sort(), hidden: cursor.hidden,
              center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, last: metrics.last,
              p95: latency[Math.max(0, Math.ceil(latency.length * .95) - 1)] || 0,
            };
          }));
        }
        for (const metric of cursorMetrics) {
          assert.ok(metric.count >= 240, `4K ${metric.count}-event hover stream records every pointer move`);
          assert.equal(metric.clears, 0, "4K hover-only cursor movement does not redraw the image canvas");
          assert.deepEqual(metric.sides, ["left", "right"], "4K compare hover keeps the cursor synchronized in either editable pane");
          assert.equal(metric.hidden, false, "4K brush cursor remains visible while hovering");
          assert.ok(Math.abs(metric.center.x - metric.last.x) <= 1 && Math.abs(metric.center.y - metric.last.y) <= 1, `4K brush cursor center follows the final pointer within one pixel (${JSON.stringify(metric)})`);
          assert.ok(metric.p95 < 16.7, `4K hover cursor p95 stays below one frame (actual ${metric.p95.toFixed(2)}ms)`);
        }
        await page.locator("#brushTool").click();
        await page.evaluate(() => { const metrics = window.__brushCursorPerf.metrics; metrics.latencies.length = 0; metrics.clears = 0; metrics.sides.clear(); metrics.recording = true; });
        await page.mouse.move(cursorGeometry.left.x, cursorGeometry.left.y); await page.mouse.down();
        for (let index = 1; index <= 100; index += 1) await page.mouse.move(cursorGeometry.left.x + index, cursorGeometry.left.y + Math.floor(index / 10));
        await page.mouse.up();
        const dragCursorMetric = await page.evaluate(() => {
          const value = window.__brushCursorPerf; const { metrics, cursor } = value; metrics.recording = false;
          const latency = [...metrics.latencies].sort((left, right) => left - right); const rect = cursor.getBoundingClientRect();
          return { count: latency.length, p95: latency[Math.max(0, Math.ceil(latency.length * .95) - 1)] || 0, center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, last: metrics.last };
        });
        assert.ok(dragCursorMetric.count >= 100, "4K drag keeps every pointer event available to the brush cursor");
        assert.ok(Math.abs(dragCursorMetric.center.x - dragCursorMetric.last.x) <= 1 && Math.abs(dragCursorMetric.center.y - dragCursorMetric.last.y) <= 1, `4K drawing cursor follows the final pointer without waiting for canvas composition (${JSON.stringify(dragCursorMetric)})`);
        assert.ok(dragCursorMetric.p95 < 16.7, `4K drawing cursor p95 stays below one frame (actual ${dragCursorMetric.p95.toFixed(2)}ms)`);
        await page.evaluate(() => {
          const value = window.__brushCursorPerf; const { canvas, begin, end, originalClearRect } = value;
          ctx.clearRect = originalClearRect; canvas.removeEventListener("pointermove", begin, true); canvas.removeEventListener("pointermove", end); delete window.__brushCursorPerf;
        });
        console.log(`4K cursor performance: hover-p95=${Math.max(...cursorMetrics.map((metric) => metric.p95)).toFixed(2)}ms moves=${cursorMetrics[0].count}`);
        await page.locator("#singleViewButton").click();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const comparePixels = await page.evaluate(({ logical }) => {
          const sample = (offset = 0) => {
            const x = Math.round((offset + state.view.x + logical.x * state.view.scale) * (window.devicePixelRatio || 1));
            const y = Math.round((state.view.y + logical.y * state.view.scale) * (window.devicePixelRatio || 1));
            return [...ctx.getImageData(x, y, 1, 1).data];
          };
          state.compareSplit = .5;
          const rightOffset = stage.clientWidth * state.compareSplit;
          state.displayMode = "compare"; state.mosaicPreviewEnabled = true; clearCandidateBlink(); flushRender();
          const staticLeft = sample(); const staticRight = sample(rightOffset);
          state.blinkCandidateIds.add("manual:apply"); state.blinkModes.set("manual:apply", "normal"); state.blinkPhase = true; flushRender();
          const blinkLeft = sample(); const blinkRight = sample(rightOffset);
          state.blinkPhase = false; flushRender();
          const blinkOffRight = sample(rightOffset);
          state.mosaicPreviewEnabled = false; state.blinkPhase = true; flushRender();
          const noMosaicLeft = sample(); const noMosaicBlinkRight = sample(rightOffset);
          clearCandidateBlink(); state.displayMode = "single"; state.mosaicPreviewEnabled = true; flushRender();
          return { staticLeft, staticRight, blinkLeft, blinkRight, blinkOffRight, noMosaicLeft, noMosaicBlinkRight };
        }, geometry);
        const same = (left, right) => left.every((value, index) => value === right[index]);
        const visible = (pixel) => pixel[3] > 0 && pixel.slice(0, 3).some((value) => value > 0);
        assert.equal(same(comparePixels.staticLeft, comparePixels.blinkLeft), true, "4K compare blink never changes the left mosaic pane");
        assert.equal(visible(comparePixels.staticRight) && visible(comparePixels.blinkRight) && visible(comparePixels.noMosaicBlinkRight), true, "4K compare range and blink overlays render only in the right pane");
        assert.equal(same(comparePixels.blinkOffRight, [0, 0, 0, 255]), true, "4K compare blink-off leaves the right pane black instead of leaking a range overlay");
        assert.equal(same(comparePixels.staticLeft, comparePixels.noMosaicLeft), false, "4K compare mosaic toggle changes only the left image rendering");
        const mismatchedPixels = await page.evaluate(() => {
          const width = originalCanvas.width; const height = originalCanvas.height;
          const source = originalCtx.getImageData(0, 0, width, height).data;
          const mask = combinedCtx.getImageData(0, 0, width, height).data;
          const actual = mosaicCtx.getImageData(0, 0, width, height).data;
          const expected = new Uint8ClampedArray(source);
          const divisor = Math.max(1, Math.min(10000, Math.round(Number(document.querySelector("#divisor").value) || 100)));
          const blockSize = Math.max(4, Math.ceil(Math.max(width, height) / divisor));
          for (let top = 0; top < height; top += blockSize) for (let left = 0; left < width; left += blockSize) {
            const bottom = Math.min(height, top + blockSize); const right = Math.min(width, left + blockSize);
            let red = 0; let green = 0; let blue = 0; let weight = 0;
            for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
              const pixel = y * width + x; if (!mask[pixel * 4 + 3]) continue;
              const index = pixel * 4; const alpha = source[index + 3]; red += source[index] * alpha; green += source[index + 1] * alpha; blue += source[index + 2] * alpha; weight += alpha;
            }
            if (!weight) continue;
            const color = [Math.round(red / weight), Math.round(green / weight), Math.round(blue / weight)];
            for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
              const pixel = y * width + x; if (!mask[pixel * 4 + 3]) continue;
              const index = pixel * 4; expected[index] = color[0]; expected[index + 1] = color[1]; expected[index + 2] = color[2];
            }
          }
          let mismatches = 0;
          for (let index = 0; index < actual.length; index += 1) if (actual[index] !== expected[index]) mismatches += 1;
          return mismatches;
        });
        assert.equal(mismatchedPixels, 0, "the 4K worker preview exactly matches the mosaic pixel golden");

        await page.evaluate(() => {
          const samples = []; let started = 0; let pendingMax = 0; const canvas = document.querySelector("#editorCanvas");
          const begin = (event) => { if (window.__editorPerf.recording && (event.buttons & 1)) started = performance.now(); };
          const end = () => { if (window.__editorPerf.recording && started) samples.push(performance.now() - started); started = 0; pendingMax = Math.max(pendingMax, state.mosaicPending ? 1 : 0); window.__editorPerf.pendingMax = pendingMax; };
          window.__editorPerf = { samples, pendingMax, recording: false, begin, end };
          canvas.addEventListener("pointermove", begin, true); canvas.addEventListener("pointermove", end);
        });
        const toolPixels = [
          ["#brushTool", "add", (value) => value > 0],
          ["#mosaicEraserTool", "add", (value) => value === 0],
          ["#eraserTool", "exclusion", (value) => value > 0],
          ["#excludeEraserTool", "exclusionErase", (value) => value > 0],
        ];
        const toolMetrics = [];
        for (const [tool, layer, accepts] of toolPixels) {
          await page.locator(tool).click();
          await page.evaluate(() => { window.__editorPerf.samples.length = 0; window.__editorPerf.recording = true; });
          await page.mouse.move(geometry.x, geometry.y); await page.mouse.down(); await page.mouse.move(geometry.endX, geometry.endY, { steps: 100 }); await page.mouse.up();
          const toolMetric = await page.evaluate(() => {
            const value = window.__editorPerf; value.recording = false;
            const samples = [...value.samples].sort((left, right) => left - right);
            return { count: samples.length, drag: samples.reduce((total, duration) => total + duration, 0), p95: samples[Math.max(0, Math.ceil(samples.length * .95) - 1)] || 0 };
          });
          assert.ok(toolMetric.count >= 100, `4K ${tool} records every 100-point drag event`);
          toolMetrics.push(toolMetric);
          await page.waitForFunction(() => !state.activeStroke);
          const pixels = await page.evaluate(({ layer, logical }) => ({
            add: addCtx.getImageData(logical.x, logical.y, 1, 1).data[3],
            exclusion: exclusionCtx.getImageData(logical.x, logical.y, 1, 1).data[3],
            exclusionErase: exclusionEraseCtx.getImageData(logical.x, logical.y, 1, 1).data[3],
          }[layer]), { layer, logical: geometry.logical });
          assert.equal(accepts(pixels), true, `4K ${tool} changes its intended pixel layer`);
        }
        await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending, null, { timeout: 15000 });
        const editorPerf = await page.evaluate(() => {
          let undo = 0; for (let index = 0; index < 10; index += 1) { const start = performance.now(); restoreSnapshot(Math.max(0, state.historyIndex - 1)); undo = Math.max(undo, performance.now() - start); }
          let redo = 0; for (let index = 0; index < 10; index += 1) { const start = performance.now(); restoreSnapshot(Math.min(state.history.length, state.historyIndex + 1)); redo = Math.max(redo, performance.now() - start); }
          const value = window.__editorPerf;
          const result = { pendingMax: value.pendingMax, undo, redo };
          const canvas = document.querySelector("#editorCanvas"); canvas.removeEventListener("pointermove", value.begin, true); canvas.removeEventListener("pointermove", value.end); delete window.__editorPerf;
          return result;
        });
        editorPerf.drag = Math.max(...toolMetrics.map((metric) => metric.drag));
        editorPerf.p95 = Math.max(...toolMetrics.map((metric) => metric.p95));
        assert.ok(editorPerf.drag < 250, `each 4K 100-point drag completes within 250ms (actual max ${editorPerf.drag.toFixed(1)}ms)`);
        assert.ok(editorPerf.p95 < 16.7, `4K pointer handler p95 stays under one frame (actual max ${editorPerf.p95.toFixed(2)}ms)`);
        assert.ok(editorPerf.undo < 250 && editorPerf.redo < 250, `4K undo/redo each stay under 250ms (actual ${editorPerf.undo.toFixed(1)}/${editorPerf.redo.toFixed(1)}ms)`);
        assert.equal(editorPerf.pendingMax <= 1, true, "4K preview keeps at most one pending worker frame");
        console.log(`4K editor performance: drag=${editorPerf.drag.toFixed(1)}ms pointer-p95=${editorPerf.p95.toFixed(2)}ms undo=${editorPerf.undo.toFixed(1)}ms redo=${editorPerf.redo.toFixed(1)}ms pending=${editorPerf.pendingMax}`);
      }

      await page.locator("#eraserTool").click();
      const exclusionGeometry = await page.evaluate(({ logical }) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + state.view.x + logical.x * state.view.scale,
          y: rect.top + state.view.y + logical.y * state.view.scale,
          endX: rect.left + state.view.x + (logical.x + Math.max(24, Math.round(state.currentImage.width * 0.08))) * state.view.scale,
          endY: rect.top + state.view.y + logical.y * state.view.scale,
          logical,
        };
      }, geometry);
      await page.mouse.move(exclusionGeometry.x, exclusionGeometry.y);
      await page.mouse.down();
      await page.mouse.move(exclusionGeometry.endX, exclusionGeometry.endY, { steps: pointerSteps });
      await page.waitForFunction(({ logical }) => state.activeStroke?.points.length >= 2
        && exclusionCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0
        && combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] === 0, exclusionGeometry);
      const duringExclusion = await page.evaluate(({ logical }) => ({
        active: state.activeStroke?.points.length >= 2,
        exclusion: exclusionCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0,
        removedFromEffectiveMask: combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] === 0,
      }), exclusionGeometry);
      assert.deepEqual(duringExclusion, { active: true, exclusion: true, removedFromEffectiveMask: true }, `${width}x${height} exclusion immediately removes the effective mosaic area`);
      await page.mouse.up();
    }
    await page.evaluate(() => releaseMosaicPreview());
    await page.waitForFunction(() => !state.mosaicWorker && !state.mosaicSourceImage);

    const ledgerPage = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
    setUpdateAvailable(true);
    await ledgerPage.addInitScript(() => {
      window.__ledgerApi = [];
      window.__ledgerPickers = { files: 0, directory: 0 };
      window.__ledgerClipboardWrites = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const input = args[0]; const init = args[1] || {};
        window.__ledgerApi.push({ url: String(input?.url || input), method: init.method || input?.method || "GET", body: init.body || "" });
        return originalFetch(...args);
      };
      window.showOpenFilePicker = async () => { window.__ledgerPickers.files += 1; return []; };
      window.showDirectoryPicker = async () => {
        window.__ledgerPickers.directory += 1;
        return {
          name: "ledger-output",
          async queryPermission() { return "granted"; },
          async requestPermission() { return "granted"; },
          async *values() {},
        };
      };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { window.__ledgerClipboardWrites += 1; } } });
    });
    holdDetection(true);
    try {
      await runControlLedger(ledgerPage, fixtureUrl, uiControlManifest, uiDynamicControlManifest, finishCancel, holdSaveRender, releaseSaveRenders);
    } finally {
      holdDetection(false);
      await stopCoveredPage(ledgerPage, true);
    }

    resetScenario();
    const exhaustivePage = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
    await exhaustivePage.addInitScript(() => {
      window.__exhaustiveApi = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const input = args[0]; const init = args[1] || {};
        window.__exhaustiveApi.push({ url: String(input?.url || input), method: init.method || input?.method || "GET", body: init.body || "" });
        return originalFetch(...args);
      };
    });
    try {
      await runExhaustiveAddedScenarios(exhaustivePage, fixtureUrl, resetScenario);
    } finally {
      await stopCoveredPage(exhaustivePage, true);
    }

    // Run the browser-owned save path in a fresh, stateful fixture.  This is
    // deliberately after the control ledger because remove-after-save changes
    // the catalogue for real; the fixture is reset instead of faking state in
    // the page.
    resetScenario();
    const browserSavePage = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
    await browserSavePage.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      const files = new Map([["sample_検証.png", new Uint8Array([0])]]);
      let outputPermission = "prompt";
      const permissionCalls = [];
      const outputHandle = {
        name: "fixture-output",
        async queryPermission(options) { permissionCalls.push(["query", options.mode]); return outputPermission; },
        async requestPermission(options) { permissionCalls.push(["request", options.mode]); if (outputPermission === "prompt") outputPermission = "granted"; return outputPermission; },
        async getFileHandle(name, options = {}) {
          if (!options.create && !files.has(name)) throw new DOMException("missing", "NotFoundError");
          if (!files.has(name)) files.set(name, new Uint8Array());
          return { async createWritable() {
            const chunks = [];
            return new WritableStream({
              write(chunk) { chunks.push(new Uint8Array(chunk)); },
              close() { files.set(name, chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))); },
            });
          } };
        },
        async removeEntry(name) { files.delete(name); },
      };
      window.__outputPermission = {
        calls: permissionCalls,
        set(value) { outputPermission = value; },
      };
      const outputStore = {
        get(key) {
          const request = {};
          queueMicrotask(() => { request.result = key === "output-directory" ? { handle: outputHandle } : undefined; request.onsuccess?.(); });
          return request;
        },
        put() {},
      };
      Object.defineProperty(window, "indexedDB", { configurable: true, value: {
        open() {
          const request = {};
          queueMicrotask(() => {
            request.result = { transaction() { return { objectStore() { return outputStore; } }; }, close() {} };
            request.onsuccess?.();
          });
          return request;
        },
      }});
      window.__singleSaveFiles = files;
      window.showDirectoryPicker = async () => outputHandle;
    });
    try {
      await browserSavePage.goto(fixtureUrl, { waitUntil: "networkidle" });
      await browserSavePage.locator("#pickFolder").click();
      await browserSavePage.locator("#folderPath").fill("G:\\selected-folder");
      await browserSavePage.locator("#loadFolderButton").click();
      await browserSavePage.waitForFunction(() => state.images.length === 2);
      assert.deepEqual(folderRequests, [{ path: "G:\\selected-folder" }], "folder selection posts the typed path and reloads the catalogue");
      await browserSavePage.locator('.gallery-item[data-id="sample"]').click();
      await browserSavePage.waitForFunction(() => state.currentId === "sample" && state.currentImage);
      await browserSavePage.locator("#brushTool").click();
      const canvasBox = await browserSavePage.locator("#editorCanvas").boundingBox();
      assert.ok(canvasBox, "the editor canvas is available for a user brush gesture");
      await browserSavePage.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await browserSavePage.mouse.down();
      await browserSavePage.mouse.move(canvasBox.x + canvasBox.width / 2 + 12, canvasBox.y + canvasBox.height / 2 + 8);
      await browserSavePage.mouse.up();
      await browserSavePage.waitForFunction(() => !document.querySelector("#saveButton").disabled);
      await browserSavePage.locator("#saveButton").click();
      await browserSavePage.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
      await browserSavePage.waitForFunction(() => state.outputDirectoryHandle?.name === "fixture-output");
      assert.equal(await browserSavePage.locator("#singleSaveStartButton").isDisabled(), false, "a restored output directory is available until its save-click permission check");
      assert.deepEqual(await browserSavePage.evaluate(() => window.__outputPermission.calls), [], "restoring the IndexedDB handle does not prompt before a save click");
      await browserSavePage.waitForFunction(() => document.querySelector("#singleSaveOutputDirectoryStatus").textContent.includes("fixture-output"));
      assert.match(await browserSavePage.locator("#singleSaveOutputDirectoryStatus").textContent(), /fixture-output/, "the restored output directory updates its visible destination");
      await browserSavePage.locator("#singleSaveCopyMode").check();
      await browserSavePage.locator("#singleSaveSuffix").fill("_検証");
      await browserSavePage.locator("#singleSaveDeleteOriginal").check();
      await browserSavePage.locator("#singleSaveStartButton").click();
      await browserSavePage.waitForFunction(() => window.__outputPermission.calls.length === 2);
      assert.deepEqual(await browserSavePage.evaluate(() => window.__outputPermission.calls), [["query", "readwrite"], ["request", "readwrite"]], "single save requests read/write access from the restored handle in its click chain");
      await browserSavePage.locator("#confirmAccept").click();
      await browserSavePage.waitForFunction(() => state.saving, null, { timeout: 5000 });
      await browserSavePage.waitForFunction(() => !state.saving, null, { timeout: 5000 });
      assert.deepEqual(saveRequests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"], "single copy-and-delete drives prepare, render, and commit in order");
      assert.equal(await browserSavePage.evaluate(() => window.__singleSaveFiles.has("sample_検証_1.png")), true, "single save keeps Unicode suffixes and avoids an existing output name");
      assert.deepEqual(await browserSavePage.evaluate(() => ({ imageIds: state.images.map((image) => image.id), currentId: state.currentId, reviewed: state.images.find((image) => image.id === "sample")?.reviewed })), { imageIds: ["sample", "sample-two"], currentId: "sample", reviewed: false }, "single save reloads without changing catalogue or reviewed state");
      await browserSavePage.evaluate(() => window.__outputPermission.set("prompt"));
      await browserSavePage.locator("#singleSaveChooseOutputDirectoryButton").click();
      await browserSavePage.waitForFunction(() => window.__outputPermission.calls.length === 4);
      assert.deepEqual(await browserSavePage.evaluate(() => window.__outputPermission.calls.slice(-2)), [["query", "readwrite"], ["request", "readwrite"]], "a newly selected output directory uses the same explicit permission check");
    } finally {
      await stopCoveredPage(browserSavePage, true);
    }

    // Navigation and overview selection are user operations, so exercise the
    // visible controls and keyboard modifiers rather than page-side helpers.
    resetScenario();
    const navigationPage = await newCoveredPage(browser, { viewport: { width: 1280, height: 900 } });
    await navigationPage.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    try {
      await navigationPage.goto(fixtureUrl, { waitUntil: "networkidle" });
      await navigationPage.locator('.gallery-item[data-id="sample"]').click();
      await navigationPage.waitForFunction(() => state.currentId === "sample");
      await navigationPage.locator("#nextImageButton").click();
      await navigationPage.waitForFunction(() => state.currentId === "sample-two");
      await navigationPage.locator("#previousImageButton").click();
      await navigationPage.waitForFunction(() => state.currentId === "sample");
      await navigationPage.locator("#reviewAndNextButton").click();
      await navigationPage.waitForFunction(() => state.currentId === "sample-two" && state.images.find((image) => image.id === "sample")?.reviewed);
      await navigationPage.locator("#previousImageButton").click();
      await navigationPage.waitForFunction(() => state.currentId === "sample");
      await navigationPage.locator("#hideAndNextButton").click();
      await navigationPage.waitForFunction(() => state.currentId === "sample-two" && state.images.find((image) => image.id === "sample")?.hidden);
      await navigationPage.locator("#overviewButton").click();
      await navigationPage.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
      // Foldered cards are reached through the rendered overview UI, not a
      // private renderer call. This proves the folder select has real options.
      await navigationPage.evaluate(() => {
        state.images[0].relativePath = "nested/sample.png";
        state.images[1].relativePath = "nested/deeper/sample-two.png";
      });
      await navigationPage.locator("#closeOverviewButton").click();
      await navigationPage.locator("#overviewButton").click();
      await navigationPage.waitForFunction(() => document.querySelector("#overviewFolder option[value='nested']"));
      await navigationPage.locator("#overviewFolder").selectOption("nested");
      await navigationPage.locator("#batchModeButton").click();
      await navigationPage.locator('.overview-item[data-id="sample-two"]').click();
      await navigationPage.locator('.overview-item[data-id="sample"]').click({ modifiers: ["Control"] });
      await navigationPage.locator('.overview-item[data-id="sample"]').click({ modifiers: ["Control", "Shift"] });
      assert.deepEqual(await navigationPage.evaluate(() => [...state.selectedImageIds].sort()), ["sample", "sample-two"], "overview modifier selection preserves both images");
    } finally {
      await stopCoveredPage(navigationPage, true);
    }

    await runCandidateBlinkScenario(browser);
    await runExhaustiveCandidateScenarios(browser);

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors.sort(), ["Failed to load resource: the server responded with a status of 400 (Bad Request)", "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"].sort(), `unexpected console errors: ${consoleErrors.join("; ")}`);
  } finally {
    await writeBrowserCoverage();
    await browser?.close();
    if (server) await closeServer(server);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { closeServer, runCandidateBlinkScenario, startFixtureServer };
