const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const browserHandle = Boolean(process.argv[3]);
    const errors = [];
    const overwriteResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/save/render" && !response.request().postDataJSON().copyToDefault) overwriteResponses.push(response);
    });
    await page.addInitScript((handleSource) => {
      window.__directoryPickerCalls = 0;
      window.showDirectoryPicker = async () => {
        window.__directoryPickerCalls++;
        if (handleSource) return navigator.storage.getDirectory();
        throw new Error("native source save must not open a directory picker");
      };
    }, browserHandle);
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1);
    if (browserHandle) {
      await page.evaluate(async (base64) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle("drag-source.jpg", { create: true });
        const writer = await handle.createWritable();
        await writer.write(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
        await writer.close();
        const file = await handle.getFile();
        const event = new DragEvent("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], items: [{
          kind: "file", getAsFile: () => file, getAsFileSystemHandle: () => Promise.resolve(handle),
        }] } });
        document.querySelector("#gallery").dispatchEvent(event);
      }, process.argv[3]);
      await page.waitForFunction(() => !state.importing && state.images.some((image) => image.relativePath === "drag-source.jpg"));
      await page.locator(".gallery-item").filter({ hasText: "drag-source.jpg" }).click();
    } else await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.selectingImage);
    await page.locator(".gallery-item").first().press("F2");
    await page.locator("#renameImageFilename").fill("renamed.jpg");
    await page.locator("#renameImageConfirm").click();
    await page.waitForFunction(() => currentRecord()?.editedFilename === "renamed.jpg");
    for (const mode of ["copy", "overwrite"]) {
      await page.locator("#saveButton").click();
      await page.locator(mode === "copy" ? "#singleSaveCopyMode" : "#singleSaveOverwriteMode").check();
      if (mode === "copy") await page.locator("#singleSaveSuffix").fill("");
      await page.locator("#singleSaveStartButton").click();
      if (mode === "overwrite") {
        await page.locator("#confirmDialog").waitFor({ state: "visible" });
        await page.locator("#confirmAccept").click();
      }
      await page.waitForFunction(() => !state.saving && !state.saveStarting);
      assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false,
        await page.locator("#errorDialogCause").textContent());
      await page.locator("#singleSaveCloseButton").click();
    }
    assert.equal(await page.locator(".gallery-item.current .gallery-name").textContent(), "renamed.jpg");
    assert.equal(overwriteResponses.length, 1);
    assert.equal(overwriteResponses[0].headers()["x-mozarie-no-effect"], "0");
    if (browserHandle) {
      assert.equal(Number(overwriteResponses[0].headers()["content-length"]), Buffer.from(process.argv[3], "base64").length);
      const saved = await page.evaluate(async () => {
        const access = state.sourceAccess.get(state.currentId);
        const root = await navigator.storage.getDirectory();
        let oldExists = true;
        try { await root.getFileHandle("drag-source.jpg"); } catch (error) { if (error.name !== "NotFoundError") throw error; oldExists = false; }
        return { name: access.fileHandle.name, path: currentRecord().relativePath,
          bytes: [...new Uint8Array(await (await access.fileHandle.getFile()).arrayBuffer())], oldExists, pickers: window.__directoryPickerCalls };
      });
      assert.equal(saved.name, "renamed.jpg"); assert.equal(saved.path, "renamed.jpg"); assert.equal(saved.oldExists, false);
      assert.deepEqual(saved.bytes, [...Buffer.from(process.argv[3], "base64")]);
      assert.equal(saved.pickers, 1);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
