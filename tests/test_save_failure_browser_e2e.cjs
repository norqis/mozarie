"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("source snapshot failure in Chromium preserves source copy candidates draft and catalog", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/api/mask/**", (route) => route.fulfill({
      status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64"),
    }));
    await context.route("**/api/candidates/sample", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ candidateRevision: 0, candidates: [
        { id: "kept-candidate", role: "apply", enabled: false, forced: false, expandPx: 0, labelToken: "penis", source: "target", refinement: null, confidence: 0.9, color: "#ff3d4d" },
      ] }),
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2 && !state.importing);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage && !currentImageActionPending());
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const sourceHandle = await root.getFileHandle("source.png", { create: true });
      const copyHandle = await root.getFileHandle("copy.png", { create: true });
      const bytes = await (await fetch("/api/image/sample")).arrayBuffer();
      for (const handle of [sourceHandle, copyHandle]) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      }
      const sourceFile = await sourceHandle.getFile();
      const image = state.images.find((entry) => entry.id === "sample");
      image.sourceKind = "session";
      image.relativePath = sourceFile.name;
      image.sizeBytes = sourceFile.size;
      image.mtimeNs = sourceFile.lastModified * 1000000;
      state.sourceAccess.set(image.id, { fileHandle: sourceHandle, parentHandle: root, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
      state.settings.confirmations.overwriteSource = false;
      beginManualStroke({ x: 10, y: 10 });
      completeManualStroke();
      await saveDraft();
      await flushWorkspaceDraft(image.id);
      window.__sourceFailureBytes = [...new Uint8Array(bytes)];
      // File reads are the external failure boundary. The application still
      // owns source preparation, snapshotting, cancellation and error UI.
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function readSource() {
        if (this.name === "source.png") throw new DOMException("read denied", "NotReadableError");
        return read.call(this);
      };
    });
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
    await page.locator("#singleSaveOverwriteMode").check();
    assert.equal(await page.evaluate(() => state.candidates.length), 1, "the fixture has a candidate to preserve");
    const before = await page.evaluate(() => ({ images: structuredClone(state.images), candidates: structuredClone(state.candidates), draft: addCanvas.toDataURL(), currentId: state.currentId }));
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open && !state.saving && !state.saveStarting);
    assert.equal(await page.locator("#errorDialogCause").textContent(), await page.evaluate(() => t("errorDialog.project_source_unavailable.cause")));
    assert.equal(fixture.saveRequests.some((request) => request.path === "/api/save/commit"), false);
    assert.equal(fixture.saveRequests.some((request) => request.path === "/api/save/cancel"), true);
    const after = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const bytes = async (name) => [...new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).slice().arrayBuffer())];
      return {
        state: { images: structuredClone(state.images), candidates: structuredClone(state.candidates), draft: addCanvas.toDataURL(), currentId: state.currentId },
        source: await bytes("source.png"), copy: await bytes("copy.png"), expected: window.__sourceFailureBytes,
      };
    });
    assert.deepEqual(after.state, before, "a source read failure preserves the editor and catalog");
    assert.deepEqual(after.source, after.expected, "a source read failure preserves the original file");
    assert.deepEqual(after.copy, after.expected, "a source read failure preserves the existing copy");
  } finally {
    await context?.close();
    await browser?.close();
    await closeServer(fixture.server);
  }
});
