"use strict";

// Python owns the real HTTP/SQLite fixture. Only the OS picker boundary is replaced.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const [origin, firstPath, secondPath] = process.argv.slice(2);

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && Number.isSafeInteger(state.serverCatalogGeneration) && !state.catalogTransition);
    await page.locator("#projectButton").click();
    await page.locator("#projectNew").click();
    await page.locator("#projectNameInput").fill("Mixed sources");
    await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.name === "Mixed sources" && !state.projectOperationPending);
    await page.locator("#projectClose").click();
    const projectId = await page.evaluate(() => state.project.id);
    const retainedIds = new Set();
    async function checkImages(count) {
      await page.waitForFunction((count) => !state.catalogTransition && !state.importing && state.images.length === count, count);
      const snapshot = await page.evaluate(() => ({ projectId: state.project?.id, ids: state.images.map((image) => image.id), error: $("#errorDialog").open }));
      assert.equal(snapshot.projectId, projectId, "loading images never leaves the project");
      assert.equal(snapshot.error, false);
      assert.equal(new Set(snapshot.ids).size, count);
      for (const imageId of retainedIds) assert.ok(snapshot.ids.includes(imageId), "all previous image IDs survive the new source");
      snapshot.ids.forEach((imageId) => retainedIds.add(imageId));
    }
    async function loadPath(path, count) {
      await page.locator("#pickFolder").click();
      await page.locator("#folderPath").fill(path);
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/folder" && response.request().method() === "POST");
      await page.locator("#loadFolderButton").click();
      assert.equal((await response).status(), 200);
      await checkImages(count);
    }
    await loadPath(firstPath, 1);
    const firstId = [...retainedIds][0];
    await page.locator(`.gallery-item[data-id="${firstId}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, firstId);
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction((id) => state.images.find((image) => image.id === id).reviewed && !currentImageActionPending(), firstId);
    await loadPath(secondPath, 2);
    await loadPath(firstPath, 2);
    // Close/open crosses the real persistent multi-source project path.
    await page.locator("#projectButton").click();
    await page.locator("#projectCloseWorkspace").click();
    await page.waitForFunction(() => !state.project && !state.projectOperationPending);
    await page.evaluate((id) => openProject({ id }), projectId);
    await checkImages(2);
    assert.equal(await page.evaluate((id) => state.images.find((image) => image.id === id).reviewed, firstId), true);

    // Actual structured-cloneable handles exercise the normal browser source registration.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("picked-directory", { create: true });
      const files = await root.getDirectoryHandle("picked-files", { create: true });
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "red"; ctx.fillRect(0, 0, 64, 48);
      const png = await new Promise((resolve) => canvas.toBlob(resolve));
      for (const parent of [directory, files]) {
        const handle = await parent.getFileHandle("history.png", { create: true });
        const writer = await handle.createWritable(); await writer.write(png); await writer.close();
      }
      window.__importPng = [...new Uint8Array(await png.arrayBuffer())];
      window.showDirectoryPicker = async () => directory;
      window.showOpenFilePicker = async () => [await files.getFileHandle("history.png")];
    });
    await page.locator("#pickFolder").click();
    await page.locator("#pickFolderFiles").click();
    await checkImages(3);
    await page.locator("#pickFolder").click();
    await page.locator("#pickImages").click();
    await checkImages(4);
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(window.__importPng)], "history.png", { type: "image/png" }));
      return data;
    });
    try { await page.locator("body").dispatchEvent("drop", { dataTransfer: transfer }); }
    finally { await transfer.dispose(); }
    await checkImages(5);
    // A native reload must retain uploaded sources as well as both native directories.
    const generation = await page.evaluate(() => state.serverCatalogGeneration);
    await loadPath(secondPath, 5);
    await page.waitForFunction((generation) => state.serverCatalogGeneration > generation && !state.catalogTransition, generation);
    assert.equal(await page.locator(".gallery-item").count(), 5);
    const live = await page.evaluate(() => api("/api/images"));
    assert.equal(live.project.id, projectId);
    assert.equal(live.sources.length, 5);
    assert.deepEqual(new Set(live.images.map((image) => image.id)), retainedIds);
    assert.equal(live.images.find((image) => image.id === firstId).reviewed, true);
  } finally {
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
