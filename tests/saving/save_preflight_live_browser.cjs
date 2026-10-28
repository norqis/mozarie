"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const writes = [];
    page.on("request", (request) => {
      if (["/api/save/render", "/api/save/reserve"].includes(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.evaluate(() => appStartup);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "red"; ctx.fillRect(0, 0, 12, 8);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
      const originals = [];
      for (const name of ["a.png", "b.png", "clear.png", "a.jpg", "b.jpg"]) {
        const handle = await root.getFileHandle(name, { create: true });
        const writer = await handle.createWritable(); await writer.write(name.endsWith("png") ? png : jpeg); await writer.close();
        if (name.endsWith("png")) originals.push({ handle, file: await handle.getFile() });
      }
      window.preflightRoot = root;
      window.originalBytes = await Promise.all(["a.png", "b.png", "clear.png", "a.jpg", "b.jpg"].map(async (name) =>
        [name, [...new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).arrayBuffer())]]));
      window.parentPickerCount = 0;
      window.showDirectoryPicker = async () => { window.parentPickerCount++; return root; };
      const event = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: originals.map(({ file }) => file),
        items: originals.map(({ file, handle }) => ({ kind: "file", getAsFile: () => file, getAsFileSystemHandle: () => Promise.resolve(handle) })) } });
      document.querySelector("#gallery").dispatchEvent(event);
    });
    await page.waitForFunction(() => !state.importing && state.images.length === 3);
    await page.locator(".gallery-item").filter({ hasText: "a.png" }).click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    const acceptOverwrite = async () => {
      await page.locator("#confirmDialog").waitFor({ state: "visible" });
      await page.locator("#confirmAccept").click();
    };
    await page.locator("#saveButton").click();
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption("jpg");
    await page.locator("#singleSaveStartButton").click();
    await acceptOverwrite();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#errorDialogCause").textContent(), /a\.jpg/);
    assert.equal(writes.length, 0, "single collision is detected before reserving or rendering");
    await page.locator("#errorDialogClose").click();
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#saveAllButton").click();
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyOutputFormat").selectOption("jpg");
    await page.locator("#applyStartButton").click();
    await acceptOverwrite();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    const cause = await page.locator("#errorDialogCause").textContent();
    assert.match(cause, /a\.jpg/); assert.match(cause, /b\.jpg/);
    assert.equal(writes.length, 0, "every batch target is checked before the first render");
    const preserved = await page.evaluate(async () => {
      for (const [name, bytes] of window.originalBytes) {
        const file = await (await window.preflightRoot.getFileHandle(name)).getFile();
        if (JSON.stringify([...new Uint8Array(await file.arrayBuffer())]) !== JSON.stringify(bytes)) return false;
      }
      try { await window.preflightRoot.getFileHandle("clear.jpg"); return false; }
      catch (error) { if (error.name !== "NotFoundError") throw error; }
      return true;
    });
    assert.equal(preserved, true);
    assert.equal(await page.locator("#applyStartButton").isEnabled(), true);
    await page.locator("#errorDialogClose").click();
    await page.evaluate(async () => { await window.preflightRoot.removeEntry("a.jpg"); await window.preflightRoot.removeEntry("b.jpg"); });
    await page.locator("#applyStartButton").click();
    await acceptOverwrite();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && state.images.every((image) => image.relativePath.endsWith(".jpg")));
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    assert.equal(writes.length, 6);
    const jpegOutputs = await page.evaluate(async () => {
      for (const name of ["a.jpg", "b.jpg", "clear.jpg"]) {
        const bytes = new Uint8Array(await (await (await window.preflightRoot.getFileHandle(name)).getFile()).arrayBuffer());
        if (bytes[0] !== 255 || bytes[1] !== 216) return false;
      }
      return true;
    });
    assert.equal(jpegOutputs, true);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
