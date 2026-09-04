const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const test = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const python = process.env.MOZARIE_TEST_PYTHON || path.join(root, ".venv", "Scripts", "python.exe");

function pythonCounts(appDir) {
  const code = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "print(json.dumps({'sources': db.execute('select count(*) from project_sources').fetchone()[0], 'images': db.execute('select count(*) from images').fetchone()[0]}))",
  ].join("; ");
  const result = childProcess.spawnSync(python, ["-c", code, path.join(appDir, "data", "workspaces.sqlite3")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function startLiveServer(tempRoot) {
  const script = [
    "import json, os, pathlib, shutil",
    "from mozarie import http as http_module",
    "import mozarie.state as state_module",
    "from mozarie.http import MosaicHandler, ThreadingHTTPServer",
    "from mozarie.state import StudioState",
    "root = pathlib.Path(os.environ['MOZARIE_LIFECYCLE_ROOT'])",
    "app = root / 'app'",
    "shutil.copytree(pathlib.Path(os.environ['MOZARIE_REPO_ROOT']) / 'config', app / 'config')",
    "state_module.APP_DIR = app",
    "state = StudioState(root / 'cache', root / 'sessions')",
    "http_module.STATE = state",
    "server = ThreadingHTTPServer(('127.0.0.1', 0), MosaicHandler)",
    "print(json.dumps({'port': server.server_port, 'appDir': str(app)}), flush=True)",
    "try: server.serve_forever()\nfinally: state.shutdown()",
  ].join("\n");
  const child = childProcess.spawn(python, ["-u", "-c", script], {
    cwd: root,
    env: { ...process.env, MOZARIE_LIFECYCLE_ROOT: tempRoot, MOZARIE_REPO_ROOT: root, MOZARIE_RUNTIME: "cpu" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const firstLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`live server did not start: ${stderr.join("")}`)), 15000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.once("line", (line) => { lines.close(); clearTimeout(timer); resolve(line); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`live server exited (${code}): ${stderr.join("")}`)); });
  });
  const info = JSON.parse(firstLine);
  return {
    ...info,
    process: child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function installBrowserSources(page) {
  return page.addInitScript(() => {
    const storageKey = "mozarie-lifecycle-idb";
    const sourceName = () => localStorage.getItem("mozarie-lifecycle-name") || "source.png";
    const sourceMtime = () => Number(localStorage.getItem("mozarie-lifecycle-mtime") || "1700000000000");
    const makeHandle = (name = sourceName()) => ({
      kind: "file", name,
      async getFile() {
        const canvas = new OffscreenCanvas(64, 64);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, 64, 64);
        return new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png", lastModified: sourceMtime() });
      },
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async isSameEntry(other) { return other?.kind === "file" && other?.name === name; },
    });
    const read = () => JSON.parse(localStorage.getItem(storageKey) || '{"directories":[],"projectSources":[]}');
    const write = (value) => localStorage.setItem(storageKey, JSON.stringify(value));
    const request = (value) => {
      const result = {};
      queueMicrotask(() => { result.result = value; result.onsuccess?.(); });
      return result;
    };
    const restore = (row) => row?.handle ? { ...row, handle: makeHandle(row.handle.name) } : row;
    const database = {
      objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
      transaction(storeName) {
        const key = Array.isArray(storeName) ? storeName[0] : storeName;
        const transaction = {};
        queueMicrotask(() => transaction.oncomplete?.());
        return {
          objectStore() {
            return {
              getAll() { return request((read()[key] || []).map(restore)); },
              get(recordKey) { return request(restore((read()[key] || []).find((row) => (row.catalogId || row.key) === recordKey))); },
              put(row) {
                const all = read(); const rows = all[key] || [];
                const identity = row.key || row.catalogId;
                const stored = { ...row, handle: row.handle ? { kind: row.handle.kind, name: row.handle.name } : undefined };
                const index = rows.findIndex((item) => (item.key || item.catalogId) === identity);
                if (index >= 0) rows[index] = stored; else rows.push(stored);
                all[key] = rows; write(all);
              },
              delete(recordKey) { const all = read(); all[key] = (all[key] || []).filter((row) => (row.key || row.catalogId) !== recordKey); write(all); },
            };
          },
        };
      },
    };
    Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() {
      const open = {};
      queueMicrotask(() => { open.result = database; open.onupgradeneeded?.(); open.onsuccess?.(); });
      return open;
    } } });
    window.showOpenFilePicker = async () => [makeHandle()];
    window.showDirectoryPicker = async () => ({ kind: "directory", name: "unused", async *values() {} });
  });
}

async function importOneFile(page) {
  await page.locator("#pickFolder").click();
  await page.locator("#pickImages").click();
  try {
    await page.waitForFunction(() => state.images.length === 1 && !state.importing, null, { timeout: 6000 });
  } catch (error) {
    const detail = await page.evaluate(() => ({
      images: state.images.length, importing: state.importing,
      error: document.querySelector("#errorDialog")?.innerText || "",
      status: document.querySelector("#connectionStatus")?.textContent || "",
    }));
    throw new Error(`browser import did not finish: ${JSON.stringify(detail)}; ${error.message}`);
  }
  await page.locator(".gallery-item").click();
  await page.waitForFunction(() => Boolean(state.currentImage));
}

async function draw(page, tool, start) {
  await page.locator(tool).click();
  const box = await page.locator("#editorCanvas").boundingBox();
  assert.ok(box, "editor canvas is visible for a real pointer gesture");
  await page.mouse.move(box.x + box.width * start, box.y + box.height * start);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (start + .08), box.y + box.height * (start + .08));
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("project browser lifecycle preserves browser source identity and completed-project boundaries", { timeout: 90000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-browser-lifecycle-"));
  const live = await startLiveServer(tempRoot);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const sourceRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/import/file") sourceRequests.push({
      sourceId: request.headers()["x-mozarie-source-id"], name: decodeURIComponent(request.headers()["x-mozarie-name"] || ""),
    });
  });
  t.after(async () => { await page.close(); await browser.close(); await live.stop(); fs.rmSync(tempRoot, { recursive: true, force: true }); });
  await installBrowserSources(page);
  await page.goto(`http://127.0.0.1:${live.port}`, { waitUntil: "networkidle" });

  await importOneFile(page);
  const browserSourceId = sourceRequests.at(-1)?.sourceId;
  assert.match(browserSourceId || "", /^[0-9a-f-]+$/i, "initial browser upload supplies a stable source ID");
  const imageId = await page.evaluate(() => state.currentId);
  await page.locator("#brushSize").fill("8");
  await draw(page, "#brushTool", .16);
  await draw(page, "#eraserTool", .46);
  await draw(page, "#excludeEraserTool", .72);
  await page.waitForFunction((id) => {
    const draft = state.drafts.get(id);
    return Boolean(draft?.add && draft?.exclusion && draft?.exclusionErase);
  }, imageId);
  assert.ok(await page.evaluate(() => state.history.length >= 3), "three real manual gestures are retained in projectless undo history before saving");
  await page.locator("#reviewAndNextButton").click();
  await page.waitForFunction((id) => state.images.find((image) => image.id === id)?.reviewed === true, imageId);
  await page.locator("#hideAndNextButton").click();
  await page.waitForFunction((id) => state.images.find((image) => image.id === id)?.hidden === true, imageId);

  await page.locator("#projectButton").click();
  await page.locator("#projectName").click();
  await page.locator("#projectNameInput").fill("Browser lifecycle");
  await page.locator("#projectNameForm button.primary").click();
  await page.waitForFunction(() => Boolean(state.project?.id));
  const first = await page.evaluate((id) => {
    const image = state.images.find((item) => item.id === id);
    const draft = state.drafts.get(id);
    return { projectId: state.project.id, imageId: image.id, sourceId: image.sourceId, candidateCount: image.candidateCount, draft: { add: Boolean(draft?.add), exclusion: Boolean(draft?.exclusion), exclusionErase: Boolean(draft?.exclusionErase) }, reviewed: image.reviewed, hidden: image.hidden };
  }, imageId);
  assert.deepEqual(first.draft, { add: true, exclusion: true, exclusionErase: true }, "project save persists all three manual layers");
  assert.equal(first.candidateCount, 0, "this live lifecycle fixture avoids inventing detector candidates without an installed model");
  assert.deepEqual(pythonCounts(live.appDir), { sources: 1, images: 1 }, "saving a browser session creates exactly one durable source and image");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#projectButton").click();
  await page.locator("#projectOpenList").click();
  await page.getByRole("button", { name: "Browser lifecycle", exact: true }).first().click();
  await page.waitForFunction((id) => state.images.length === 1 && state.images[0].id === id && !state.importing, imageId);
  await page.locator(".gallery-item").click();
  try {
    await page.waitForFunction((id) => {
      const draft = state.drafts.get(id);
      return Boolean(draft?.add && draft?.exclusion && draft?.exclusionErase);
    }, imageId, { timeout: 6000 });
  } catch (error) {
    throw new Error(`project reopen did not hydrate layers: ${JSON.stringify(await page.evaluate((id) => ({ draft: state.drafts.get(id), current: state.currentId, errors: document.querySelector("#errorDialog")?.innerText || "" }), imageId))}; ${error.message}`);
  }
  const reopened = await page.evaluate((id) => {
    const image = state.images.find((item) => item.id === id);
    return { id: image.id, sourceId: image.sourceId, reviewed: image.reviewed, hidden: image.hidden, mismatchOpen: document.querySelector("#sourceMismatchDialog").open };
  }, imageId);
  assert.equal(await page.locator("#undoButton").isDisabled(), false, "saved manual work remains available to project undo after reload");
  assert.deepEqual(
    { ...reopened, sourceId: typeof reopened.sourceId },
    { id: first.imageId, sourceId: "string", reviewed: true, hidden: true, mismatchOpen: false },
    "reopen retains image identity, flags, and has no false source warning",
  );
  const durableSourceId = reopened.sourceId;
  assert.equal(sourceRequests.at(-1).sourceId, durableSourceId, "restored IDB source ID is sent back to the real server");
  assert.deepEqual(pythonCounts(live.appDir), { sources: 1, images: 1 }, "reopening through the same file handle neither duplicates source nor image rows");
  // The lifecycle checks hidden-state persistence above. Toggle the same UI
  // action back so the completed-project checks can select the image normally.
  await page.locator("#removeCurrentImageButton").click();
  await page.waitForFunction((id) => state.images.find((image) => image.id === id)?.hidden === false, imageId);

  await page.evaluate(() => localStorage.setItem("mozarie-lifecycle-mtime", "1700000001001"));
  await page.locator("#projectButton").click();
  await page.locator("#projectOpenList").click();
  await page.getByRole("button", { name: "Browser lifecycle", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#sourceMismatchDialog").open);
  assert.equal(await page.locator("#sourceMismatchClear").isChecked(), false, "mtime-only mismatch defaults to retaining masks");
  await page.locator("#sourceMismatchForm button.primary").click();
  await page.waitForFunction(() => !document.querySelector("#sourceMismatchDialog").open);
  assert.deepEqual(pythonCounts(live.appDir), { sources: 1, images: 1 }, "accepting a fingerprint update preserves project rows");

  await page.locator("#projectButton").click();
  await page.locator("#projectComplete").click();
  await page.locator("#confirmAccept").click();
  await page.waitForFunction(() => !state.project && state.images.length === 0);
  await page.locator("#projectButton").click();
  await page.locator("#projectOpenList").click();
  await page.getByRole("button", { name: "Browser lifecycle", exact: true }).first().click();
  await page.waitForFunction((id) => state.projectReadOnly && state.images.some((image) => image.id === id), imageId);
  assert.equal(sourceRequests.at(-1).sourceId, durableSourceId, "the same durable server source ID is reused after another browser-handle restore");
  const completedReopenMismatch = await page.evaluate(async () => ({
    open: document.querySelector("#sourceMismatchDialog").open,
    images: state.images.map(({ id, mtimeNs, sizeBytes, sourceId, sourceMismatch }) => ({ id, mtimeNs, sizeBytes, sourceId, sourceMismatch })),
    server: await (await fetch("/api/project/mismatches")).json(),
  }));
  assert.equal(
    completedReopenMismatch.open,
    false,
    `accepting a browser source fingerprint prevents a false warning on the next project reopen: ${JSON.stringify(completedReopenMismatch)}`,
  );
  assert.equal(await page.locator(".gallery-item").isDisabled(), false, "completed projects remain browseable; only editing is locked");
  await page.locator(".gallery-item").click();
  assert.equal(await page.locator("#brushTool").isDisabled(), true, "completed project disables editing tools");
  await page.locator("#projectButton").click();
  assert.equal(await page.locator("#projectMosaicZip").isDisabled(), false, "completed project still allows project mask export");
  await page.locator("#projectClose").click();
  const download = page.waitForEvent("download");
  await page.locator("#downloadCurrentMosaicMask").click();
  assert.match((await download).suggestedFilename(), /mosaic-mask\.png$/, "completed project permits per-image mask export");

  const beforeRejectedImport = pythonCounts(live.appDir);
  const beforeRejectedUi = await page.evaluate(() => state.images.map(({ id, sourceId }) => ({ id, sourceId })));
  assert.equal(await page.locator("#pickFolder").isDisabled(), true, "completed project UI cannot start a new import");
  const rejected = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8); canvas.getContext("2d").fillRect(0, 0, 8, 8);
    const file = new File([await canvas.convertToBlob({ type: "image/png" })], "new-relative.png", { type: "image/png", lastModified: 1700000002000 });
    const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
    const response = await fetch("/api/import/file", { method: "POST", headers: {
      "Content-Type": "application/octet-stream", "X-Mozarie-Token": token,
      "X-Mozarie-Name": encodeURIComponent(file.name), "X-Mozarie-Relative-Path": encodeURIComponent(file.name),
      "X-Mozarie-Client-Key": crypto.randomUUID(), "X-Mozarie-File-Mtime": String(file.lastModified),
      "X-Mozarie-File-Size": String(file.size), "X-Mozarie-Source-Id": crypto.randomUUID(), "X-Mozarie-Source-Kind": "browser-files",
    }, body: file });
    return { status: response.status, body: await response.json() };
  });
  assert.deepEqual(rejected, { status: 400, body: { error_code: "project_read_only", params: {} } }, "the live server rejects a new relative path with the precise completed-project error");
  assert.deepEqual(pythonCounts(live.appDir), beforeRejectedImport, "a new relative path is rejected atomically in a completed project");
  assert.deepEqual(await page.evaluate(() => state.images.map(({ id, sourceId }) => ({ id, sourceId }))), beforeRejectedUi, "the rejected import leaves the completed-project UI list unchanged");

  await page.locator("#projectButton").click();
  await page.locator("#projectResume").click();
  await page.waitForFunction(() => !state.projectReadOnly);
  assert.equal(await page.locator("#brushTool").isDisabled(), false, "resume re-enables editing controls");
  await page.locator("#projectClose").click();
  await page.evaluate(() => localStorage.setItem("mozarie-lifecycle-name", "new-relative.png"));
  await page.locator("#pickFolder").click();
  await page.locator("#pickImages").click();
  await page.waitForFunction(() => state.images.length === 2 && !state.importing);
  assert.deepEqual(pythonCounts(live.appDir), { sources: 2, images: 2 }, "resumed project accepts a new browser source and image");
});
