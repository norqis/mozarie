"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const origin = process.argv[2];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwPCfkeE/w38GBgAc+AP+/XLlFAAAAABJRU5ErkJggg==";

async function assertSaveButtonHitTarget(page, startId, pickerId) {
  const hit = await page.evaluate(({ startId, pickerId }) => {
    const start = document.getElementById(startId).getBoundingClientRect();
    const picker = document.getElementById(pickerId).getBoundingClientRect();
    const target = document.elementFromPoint(start.left + start.width / 2, start.top + start.height / 2);
    const overlaps = start.left < picker.right && picker.left < start.right && start.top < picker.bottom && picker.top < start.bottom;
    return { target: target?.closest("button")?.id || null, overlaps };
  }, { startId, pickerId });
  assert.deepEqual(hit, { target: startId, overlaps: false }, "the visible Save button receives its center click without overlapping the folder chooser");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const outputPickerRequests = [];
    const saveRenderResponses = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/save/render") {
        saveRenderResponses.push({ payload: response.request().postDataJSON(), length: Number(response.headers()["content-length"]) });
      }
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/output-directory/pick") outputPickerRequests.push(request.url());
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length && !state.projectOperationPending);
    await page.evaluate(async (base64) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("drag-source.png", { create: true });
      const writer = await handle.createWritable();
      await writer.write(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
      await writer.close();
      window.__dragSource = handle;
      window.__pickerCalls = 0;
      window.showDirectoryPicker = async () => { window.__pickerCalls++; throw new Error("unexpected parent picker"); };
      const file = await handle.getFile();
      const transfer = new DataTransfer(); transfer.items.add(file);
      const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], items: [{
        kind: "file", getAsFile: () => file, getAsFileSystemHandle: () => Promise.resolve(handle),
      }] } });
      document.querySelector("#gallery").dispatchEvent(event);
    }, png);
    await page.waitForFunction(() => !state.importing && state.images.some((image) => image.relativePath === "drag-source.png"));
    await page.locator('.gallery-item[data-id]').filter({ hasText: "drag-source.png" }).click();
    await page.waitForFunction(() => state.currentImage && state.currentId === state.images.find((image) => image.relativePath === "drag-source.png")?.id);
    await page.evaluate(() => {
      const image = state.images.find((item) => item.relativePath === "drag-source.png");
      const handle = state.sourceAccess.get(image.id).fileHandle;
      window.__writePermissionRequests = 0;
      Object.defineProperty(handle, "queryPermission", { value: async ({ mode }) => mode === "readwrite" && !window.__writePermissionRequests ? "prompt" : "granted" });
      Object.defineProperty(handle, "requestPermission", { value: async () => { window.__writePermissionRequests++; return "granted"; } });
    });
    const before = await page.evaluate(async () => {
      const image = state.images.find((item) => item.relativePath === "drag-source.png");
      const access = state.sourceAccess.get(image.id);
      return { relativePath: image.relativePath, editedFilename: image.editedFilename, handleName: access.fileHandle.name,
        accessName: access.name, bytes: [...new Uint8Array(await (await access.fileHandle.getFile()).arrayBuffer())] };
    });
    assert.equal(before.editedFilename, null);
    assert.equal(before.handleName, "drag-source.png");
    assert.equal(before.accessName, "drag-source.png");
    await page.locator("#flipHorizontalButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.relativePath === "drag-source.png")?.flipH === true && !state.transformPending);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption("original");
    const preSave = await page.evaluate(() => {
      const image = state.images.find((item) => item.relativePath === "drag-source.png");
      const access = state.sourceAccess.get(image.id);
      return { relativePath: image.relativePath, editedFilename: image.editedFilename, handleName: access.fileHandle.name,
        accessName: access.name, format: document.querySelector("#singleSaveOutputFormat").value,
        mode: document.querySelector('input[name="singleSaveMode"]:checked').value };
    });
    assert.deepEqual(preSave, { relativePath: "drag-source.png", editedFilename: null, handleName: "drag-source.png",
      accessName: "drag-source.png", format: "original", mode: "overwrite" });
    await assertSaveButtonHitTarget(page, "singleSaveStartButton", "singleSaveChooseOutputDirectoryButton");
    await page.setViewportSize({ width: 800, height: 600 });
    await assertSaveButtonHitTarget(page, "singleSaveStartButton", "singleSaveChooseOutputDirectoryButton");
    await page.locator("#singleSaveStartButton").click();
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    const after = await page.evaluate(async () => ({
      pickerCalls: window.__pickerCalls,
      writePermissionRequests: window.__writePermissionRequests,
      errorOpen: document.querySelector("#errorDialog").open,
      bytes: [...new Uint8Array(await (await window.__dragSource.getFile()).arrayBuffer())],
    }));
    assert.equal(after.pickerCalls, 0, "unchanged source name and original format need no parent picker");
    assert.equal(outputPickerRequests.length, 0, "single source overwrite never opens the Windows output folder picker");
    assert.equal(after.writePermissionRequests, 1, "the save gesture requests source write permission once");
    assert.equal(after.errorOpen, false);
    assert.notDeepEqual(after.bytes, before.bytes, "overwrite writes real source bytes");
    assert.equal(saveRenderResponses.length, 1);
    assert.equal(saveRenderResponses[0].payload.streamImage, true, "single browser-handle saves request the image stream");
    assert.ok(saveRenderResponses[0].length > 0, "browser-handle saves receive the bytes used to overwrite the real file");
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption("original");
    await assertSaveButtonHitTarget(page, "singleSaveStartButton", "singleSaveChooseOutputDirectoryButton");
    await page.locator("#singleSaveStartButton").focus();
    await page.keyboard.press("Enter");
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    assert.equal(await page.evaluate(() => window.__pickerCalls), 0, "single Save activation by Enter needs no parent picker");
    assert.equal(outputPickerRequests.length, 0, "single Save activation by Enter needs no Windows output folder picker");
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#flipVerticalButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.relativePath === "drag-source.png")?.flipV === true && !state.transformPending);
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyOutputFormat").selectOption("original");
    await assertSaveButtonHitTarget(page, "applyStartButton", "chooseOutputDirectoryButton");
    await page.locator("#applyStartButton").click();
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    assert.equal(await page.evaluate(() => window.__pickerCalls), 0, "batch overwrite with original format also needs no parent picker");
    assert.equal(outputPickerRequests.length, 0, "batch source overwrite never opens the Windows output folder picker");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    const batchBytes = await page.evaluate(async () => [...new Uint8Array(await (await window.__dragSource.getFile()).arrayBuffer())]);
    assert.notDeepEqual(batchBytes, after.bytes, "batch browser-handle overwrite writes the changed image bytes");
    await page.locator("#applyCloseButton").click();
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyOutputFormat").selectOption("original");
    await assertSaveButtonHitTarget(page, "applyStartButton", "chooseOutputDirectoryButton");
    await page.locator("#applyStartButton").focus();
    await page.keyboard.press("Enter");
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    assert.equal(await page.evaluate(() => window.__pickerCalls), 0, "batch Save activation by Enter needs no parent picker");
    const browserBatchResponses = saveRenderResponses.slice(2).filter((response) => response.payload.imageId === saveRenderResponses[0].payload.imageId);
    assert.equal(browserBatchResponses.length, 2);
    for (const response of browserBatchResponses) {
      assert.notEqual(response.payload.streamImage, false, "batch browser-handle saves retain streaming by default");
      assert.ok(response.length > 0, "batch browser-handle saves receive a full image stream");
    }
    assert.equal(outputPickerRequests.length, 0, "batch Save activation by Enter needs no Windows output folder picker");
    await page.locator("#applyCloseButton").click();
    await page.locator("#projectButton").click();
    await page.locator("#projectName").click();
    await page.locator("#projectNameInput").fill("Drag overwrite fixture");
    await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.id && !state.projectOperationPending);
    await page.evaluate(() => openRenameImageDialog(state.images.find((image) => image.relativePath === "drag-source.png").id));
    await page.locator("#renameImageFilename").fill("intended-new-name.png");
    await page.locator("#renameImageConfirm").click();
    await page.waitForFunction(() => state.images.find((image) => image.relativePath === "drag-source.png")?.editedFilename === "intended-new-name.png");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.some((image) => image.relativePath === "drag-source.png") && !state.projectOperationPending);
    await page.waitForFunction(() => {
      const image = state.images.find((item) => item.relativePath === "drag-source.png");
      return state.sourceAccess.get(image.id)?.fileHandle;
    });
    const persisted = await page.evaluate(() => {
      const image = state.images.find((item) => item.relativePath === "drag-source.png");
      const access = state.sourceAccess.get(image.id);
      return { relativePath: image.relativePath, editedFilename: image.editedFilename,
        handleName: access?.fileHandle?.name || null, accessName: access?.name || null };
    });
    assert.equal(persisted.editedFilename, "intended-new-name.png", "an explicit pending rename survives project reload");
    assert.equal(persisted.relativePath, "drag-source.png");
    assert.equal(persisted.handleName, "drag-source.png");
    await page.evaluate(() => {
      window.__pickerCalls = 0;
      window.showDirectoryPicker = async () => { window.__pickerCalls++; throw new DOMException("cancelled", "AbortError"); };
    });
    await page.locator('.gallery-item[data-id]').filter({ hasText: "intended-new-name.png" }).click();
    await page.waitForFunction(() => state.currentImage && state.currentId === state.images.find((image) => image.relativePath === "drag-source.png")?.id);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption("original");
    await page.locator("#singleSaveStartButton").click();
    if (await page.locator("#confirmDialog").evaluate((dialog) => dialog.open)) await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => window.__pickerCalls === 1);
    assert.equal(await page.evaluate(() => window.__pickerCalls), 1, "a persisted explicit rename requests its missing parent directory");
    console.log(JSON.stringify({ before: { ...before, bytes: `${before.bytes.length} bytes` }, preSave,
      pickerCalls: after.pickerCalls, writePermissionRequests: after.writePermissionRequests, overwritten: true, persisted }));
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
