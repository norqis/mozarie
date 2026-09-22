"use strict";

// Python owns the real HTTP server, settings, SQLite, images and cleanup.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const [origin, sourcePath] = process.argv.slice(2);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==";

async function ready(page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length && !state.projectOperationPending);
}

async function drop(page, names, { target = "#gallery", rejectHandle = false, invalid = false } = {}) {
  const before = await page.evaluate(() => state.images.length);
  const result = await page.evaluate(({ names, target, rejectHandle, invalid, png }) => {
    const transfer = new DataTransfer();
    for (const name of names) {
      const bytes = invalid ? new Uint8Array([0, 1, 2]) : Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/png" });
      Object.defineProperty(file, "lastModified", { value: 12345.678 });
      const item = transfer.items.add(file);
    }
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    if (rejectHandle) Object.defineProperty(event, "dataTransfer", { value: {
      types: ["Files"], files: [...transfer.files], items: [...transfer.files].map((file) => ({ kind: "file", getAsFile: () => file,
        getAsFileSystemHandle: () => Promise.reject(new DOMException("Unavailable", "NotAllowedError")) })),
    } });
    document.querySelector(target).dispatchEvent(event);
    return { prevented: event.defaultPrevented, began: state.importing };
  }, { names, target, rejectHandle, invalid, png });
  assert.equal(result.prevented, true, "file drop prevents navigation");
  assert.equal(result.began, true, "the drop starts one import session synchronously");
  await page.waitForFunction(() => !state.importing && state.importSession === null);
  assert.equal(await page.locator("#galleryDropOverlay").isHidden(), true);
  if (!invalid) assert.equal(await page.evaluate(() => state.images.length), before + names.length);
}

(async () => {
  const started = performance.now();
  const browser = await chromium.launch({ headless: true });
  try {
    const settingsContext = await browser.newContext();
    try {
      const page = await settingsContext.newPage();
      await ready(page);
      const output = await page.evaluate(() => state.settings.saving.default_output_directory);
      await page.locator("#settingsButton").click();
      await page.locator("#settingsImportParallelism").fill("9");
      const saved = page.waitForResponse((r) => r.url().includes("/api/settings?status=0") && r.request().method() === "POST");
      await page.locator("#settingsSaveButton").click();
      assert.equal((await saved).status(), 200, "a full form preserves the missing unchanged output folder");
      await page.waitForFunction(() => state.settings.importing.parallelism === 9 && !settingsMutationPending);
      assert.equal(await page.evaluate(() => state.settings.saving.default_output_directory), output);
      assert.equal(await page.locator("#errorDialog").isVisible(), false);
      await page.locator("#settingsCloseButton").click();
      await page.evaluate(async () => { setFillColorTolerance(47); await saveFillColorTolerance(); });
      assert.equal(await page.evaluate(() => state.settings.editing.fill_color_tolerance), 47);
      // GPU inference is an external boundary. Settings and all HTTP uploads
      // below remain real; reaching this request proves detection was not
      // aborted by the missing output folder during its settings save.
      let detected;
      await page.route("**/api/detect", (route) => {
        detected = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await page.locator("#detectAllButton").click();
      await page.locator("#detectConfidenceNumber").fill("0.71");
      const requested = page.waitForResponse((r) => r.url().endsWith("/api/detect"));
      await page.locator("#detectStartButton").click();
      assert.equal((await requested).status(), 200);
      assert.equal(detected.confidence, 0.71);
      assert.equal(detected.imageIds.length, 1);
    } finally { await settingsContext.close(); }

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await ready(page);
      const uploads = [], lifecycle = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/import/file")) uploads.push(request.headers());
        if (/\/api\/import\/(start|finish)$/.test(request.url())) lifecycle.push(request.url().split("/").pop());
      });
      const url = page.url();
      await drop(page, ["fallback-null.png"]);
      await drop(page, ["fallback-rejected.png"], { target: "body", rejectHandle: true });
      assert.deepEqual(lifecycle, ["start", "finish", "start", "finish"], "one server lifecycle per drop, including outside the gallery");
      assert.equal(uploads.length, 2, "bubbling does not duplicate uploads");
      assert.equal(page.url(), url);
      assert.ok(uploads.every((headers) => headers["x-mozarie-file-mtime"] === "12346"), "fractional File mtimes use integer milliseconds on the wire");

      // Real OPFS handles exercise the normal handle branch and file picker
      // source metadata without involving user files or an OS dialog.
      await page.evaluate(async ({ png }) => {
        const root = await navigator.storage.getDirectory();
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        async function make(name) {
          const handle = await root.getFileHandle(name, { create: true });
          const writer = await handle.createWritable(); await writer.write(bytes); await writer.close();
          return handle;
        }
        window.fixtureDropHandle = await make("handle-drop.png");
        window.fixturePickerHandle = await make("handle-picker.png");
        window.showOpenFilePicker = async () => [window.fixturePickerHandle];
        const transfer = new DataTransfer();
        const file = await window.fixtureDropHandle.getFile();
        transfer.items.add(file);
        const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], items: [{ kind: "file",
          getAsFile: () => file, getAsFileSystemHandle: () => Promise.resolve(window.fixtureDropHandle),
        }] } });
        document.querySelector("#gallery").dispatchEvent(event);
      }, { png });
      await page.waitForFunction(() => !state.importing && state.images.some((image) => image.relativePath === "handle-drop.png"));
      await page.locator("#pickFolder").click();
      await page.locator("#pickImages").click();
      await page.waitForFunction(() => !state.importing && state.images.some((image) => image.relativePath === "handle-picker.png"));
      assert.deepEqual(await page.evaluate(() => ["handle-drop.png", "handle-picker.png"].map((name) => {
        const image = state.images.find((item) => item.relativePath === name);
        const access = state.sourceAccess.get(image.id);
        return access ? { name: access.name, sourceKind: access.sourceKind, handle: access.fileHandle.kind, path: access.relativePath } : { missing: image, sources: [...state.sourceAccess.keys()] };
      })), ["handle-drop.png", "handle-picker.png"].map((name) => ({ name, sourceKind: "browser-files", handle: "file", path: name })));

      // Read every transfer entry before the first promise can resolve. A
      // second item's data would be unavailable after an await in the loop.
      assert.deepEqual(await page.evaluate(async () => {
        let readable = true; const calls = [];
        const item = (name, reject) => ({ kind: "file",
          getAsFile() { if (!readable) throw new Error("protected data store"); calls.push(`file:${name}`); return new File(["x"], name); },
          getAsFileSystemHandle() { if (!readable) throw new Error("protected data store"); calls.push(`handle:${name}`); return reject ? Promise.reject(new Error("no handle")) : Promise.resolve(null); },
        });
        const pending = directFilesFromDrop({ items: [item("one.png", false), item("two.png", true)], files: [] });
        readable = false;
        const result = await pending;
        return { calls, names: result.handleEntries.map((entry) => entry.file.name) };
      }), { calls: ["file:one.png", "handle:one.png", "file:two.png", "handle:two.png"], names: ["one.png", "two.png"] });
      assert.equal(await page.evaluate(() => {
        const transfer = new DataTransfer(); transfer.setData("text/plain", "own-drag");
        const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
        document.querySelector("#gallery").dispatchEvent(event);
        return event.defaultPrevented || state.importing;
      }), false, "non-file dragging remains available");

      assert.deepEqual(await page.evaluate(async () => {
        const image = { id: "fractional-delete", sourceKind: "session", sizeBytes: 1, mtimeNs: 12346000000 };
        const file = new File(["x"], "fractional-delete.png");
        Object.defineProperty(file, "lastModified", { value: 12345.678, configurable: true });
        let removed = 0;
        const fileHandle = { kind: "file", name: file.name, getFile: async () => file };
        const parentHandle = { kind: "directory", queryPermission: async () => "granted", getFileHandle: async () => fileHandle, removeEntry: async () => { removed += 1; } };
        state.sourceAccess.set(image.id, { fileHandle, parentHandle, name: file.name });
        try {
          const check = await preflightBrowserSourceDelete([image]);
          await browserDeleteHandle(browserDeleteEntry(image), image);
          Object.defineProperty(file, "lastModified", { value: 12347.001 });
          const changed = await preflightBrowserSourceDelete([image]);
          return { ready: check.ready.length, failed: check.failed, removed, changed: changed.failed.map((entry) => entry.reason) };
        } finally { state.sourceAccess.delete(image.id); }
      }), { ready: 1, failed: [], removed: 1, changed: ["stale_asset"] }, "fractional timestamps match import precision while changed sources remain protected");

      for (const name of ["bad-first.png", "bad-second.png"]) {
        const beforeRequests = uploads.length;
        await drop(page, [name], { invalid: true });
        assert.equal(uploads.length, beforeRequests + 1);
        assert.equal(await page.locator("#importFailuresDialog").isVisible(), true);
        assert.equal(await page.locator("#errorDialog").isVisible(), false);
        await page.locator("#importFailuresClose").click();
      }
      await drop(page, ["after-failure.png"], { target: "body" });
      assert.equal(await page.locator("#pickFolder").isEnabled(), true);

      // The path entry point still replaces the temporary browser catalog
      // with its original filesystem source and dimensions.
      await page.locator("#pickFolder").click();
      await page.locator("#folderPath").fill(sourcePath);
      await page.locator("#loadFolderButton").click();
      await page.waitForFunction(() => !state.importing && state.images.length === 1 && state.images[0].relativePath === "source.png");
      assert.deepEqual(await page.evaluate(() => ({ kind: state.images[0].sourceKind, width: state.images[0].width, height: state.images[0].height })), { kind: "filesystem", width: 32, height: 24 });
      assert.equal(page.url(), url);
    } finally { await context.close(); }
    console.log(`live browser settings, detection start, picker/drop/path: ${((performance.now() - started) / 1000).toFixed(3)}s`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
