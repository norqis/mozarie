"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

test("legacy source aliases restore distinct same-name file handles without swapping images", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); fixture.setCatalog([]);
  const browser = await chromium.launch(); const context = await browser.newContext();
  try {
    const project = { id: "legacy-files", name: "Legacy", status: "working" };
    const sources = [
      { id: "raw-source", kind: "browser-files", identity: "legacy" },
      { id: "prefixed-source", kind: "browser-files", identity: "browser:legacy" },
    ];
    const sourceImages = sources.map((source, index) => ({ id: `image-${index}`, sourceId: source.id, relativePath: "same.png", width: 4, height: 3, candidateRevision: index + 1, sourceKind: "session" }));
    let images = [];
    const snapshot = () => ({ project, sources, sourceImages, images, catalogGeneration: 1, historyDurable: false });
    await context.route("**/api/images", (route) => route.fulfill({ json: snapshot() }));
    await context.route("**/api/projects", (route) => route.fulfill({ json: { projects: [project] } }));
    await context.route("**/api/project/open", (route) => { images = []; return route.fulfill({ json: { ...snapshot(), needsSource: true } }); });
    await context.route("**/api/import/start", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
    await context.route("**/api/import/finish", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.project?.id === "legacy-files");
    const expected = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory(); const values = [];
      for (const [index, color] of ["red", "blue"].entries()) {
        const parent = await root.getDirectoryHandle(String(index), { create: true });
        const handle = await parent.getFileHandle("same.png", { create: true });
        const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 3;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 4, 3);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
        await rememberProjectSource(state.project.id, handle, `image-${index}`, "legacy", `client-${index}`, "same.png", parent);
        values.push([...new Uint8Array(await blob.arrayBuffer())]);
      }
      // A stale pending alias must not replace either image's known handle.
      const first = await (await root.getDirectoryHandle("0")).getFileHandle("same.png");
      await rememberProjectSource(state.project.id, first, null, "legacy", "pending", "same.png");
      return values;
    });
    const requests = [];
    await context.route("**/api/import/file", async (route) => {
      const headers = route.request().headers(); const sourceId = headers["x-mozarie-source-id"];
      const record = sourceImages.find((image) => image.sourceId === sourceId);
      assert.ok(record, "restore must send a canonical source ID");
      const index = sourceImages.indexOf(record);
      assert.deepEqual([...route.request().postDataBuffer()], expected[index]);
      assert.equal(headers["x-mozarie-import-intent"], "restore");
      requests.push(record.id); images = [...images.filter((image) => image.id !== record.id), record]; fixture.setCatalog(images);
      await route.fulfill({ json: { ...snapshot(), imported: [{ imageId: record.id, clientKey: decodeURIComponent(headers["x-mozarie-client-key"]) }] } });
    });
    const rowCount = await page.evaluate(async () => (await rememberedProjectSources(state.project.id)).files.length);
    for (let reopen = 0; reopen < 2; reopen += 1) {
      requests.length = 0;
      await page.evaluate((project) => openProject(project), project);
      assert.deepEqual([...requests].sort(), ["image-0", "image-1"]);
      const restored = await page.evaluate(async () => ({
        images: state.images.map((image) => image.id).sort(), pending: pendingBrowserProjectSources.length,
        bytes: await Promise.all(["image-0", "image-1"].map(async (id) => [...new Uint8Array(await (await state.sourceAccess.get(id).fileHandle.getFile()).arrayBuffer())])),
        rows: (await rememberedProjectSources(state.project.id)).files.length,
        sources: ["image-0", "image-1"].map((id) => state.sourceAccess.get(id).sourceId),
      }));
      assert.deepEqual(restored.images, ["image-0", "image-1"]); assert.equal(restored.pending, 0);
      assert.deepEqual(restored.bytes, expected);
      assert.deepEqual(restored.sources, ["raw-source", "prefixed-source"]);
      assert.equal(restored.rows, rowCount, "reopening must not multiply stored handles");
    }
  } finally {
    await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});

test("legacy directory aliases restore every canonical source and retain permission retry targets", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); fixture.setCatalog([]);
  const browser = await chromium.launch(); const context = await browser.newContext();
  try {
    const project = { id: "legacy-directory", name: "Legacy directory", status: "working" };
    const sources = [
      { id: "raw-directory", kind: "browser-directory", identity: "legacy" },
      { id: "prefixed-directory", kind: "browser-directory", identity: "browser:legacy" },
    ];
    const records = sources.map((source, index) => ({ id: `image-${index}`, sourceId: source.id, relativePath: `${index}.png`, sourceKind: "session", width: 1, height: 1 }));
    let images = [];
    const snapshot = () => ({ project, sources, images, catalogGeneration: 1, historyDurable: false });
    await context.route("**/api/images", (route) => route.fulfill({ json: snapshot() }));
    await context.route("**/api/projects", (route) => route.fulfill({ json: { projects: [project] } }));
    await context.route("**/api/project/open", (route) => { images = []; return route.fulfill({ json: { ...snapshot(), needsSource: true } }); });
    await context.route("**/api/import/start", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
    await context.route("**/api/import/finish", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
    const uploads = [];
    await context.route("**/api/import/file", (route) => {
      const headers = route.request().headers(); const sourceId = headers["x-mozarie-source-id"];
      const path = decodeURIComponent(headers["x-mozarie-relative-path"]);
      uploads.push([sourceId, path]);
      const record = records.find((image) => image.sourceId === sourceId && image.relativePath === path);
      if (record) { images.push(record); fixture.setCatalog(images); }
      return route.fulfill({ json: { ...snapshot(), imported: record ? [{ imageId: record.id, clientKey: decodeURIComponent(headers["x-mozarie-client-key"]) }] : [] } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.project?.id === "legacy-directory");
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const png = await (await fetch("/api/image/fixture")).blob();
      for (const name of ["0.png", "1.png"]) {
        const file = await root.getFileHandle(name, { create: true }); const writer = await file.createWritable();
        await writer.write(png); await writer.close();
      }
      await rememberProjectSource(state.project.id, root, null, "legacy");
      window.directoryAllowed = false;
      FileSystemDirectoryHandle.prototype.queryPermission = async () => window.directoryAllowed ? "granted" : "prompt";
    });
    await page.evaluate((project) => openProject(project), project);
    assert.equal(uploads.length, 0);
    assert.deepEqual(await page.evaluate(() => pendingBrowserProjectSources.map((source) => [source.sourceId, source.rememberedSourceId]).sort()),
      [["prefixed-directory", "legacy"], ["raw-directory", "legacy"]]);
    await page.evaluate(() => { window.directoryAllowed = true; });
    for (let reopen = 0; reopen < 2; reopen += 1) {
      uploads.length = 0;
      await page.evaluate((project) => openProject(project), project);
      assert.equal(uploads.length, 4, "both canonical sources are restored exactly once from the shared directory handle");
      assert.deepEqual(await page.evaluate(async () => ({
        ids: state.images.map((image) => image.id).sort(),
        sources: ["image-0", "image-1"].map((id) => state.sourceAccess.get(id).sourceId),
        stored: (await rememberedProjectSources(state.project.id)).directories.map((row) => row.sourceId),
        pending: pendingBrowserProjectSources.length,
      })), { ids: ["image-0", "image-1"], sources: ["raw-directory", "prefixed-directory"], stored: ["legacy"], pending: 0 });
    }
  } finally {
    await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});
