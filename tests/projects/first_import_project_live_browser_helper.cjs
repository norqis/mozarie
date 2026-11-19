"use strict";

const assert = require("node:assert/strict");
const {chromium} = require("playwright");
const [origin, mode, source, png, mask] = process.argv.slice(2);
const directoryName = "Picked Actual Folder";

async function nativeImport(page) {
  await page.locator("#pickFolder").click();
  await page.locator("#folderPath").fill(source);
  await page.locator("#loadFolderButton").click();
}

async function pickerImport(page) {
  await page.evaluate(async ({png, directoryName}) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(directoryName, {create: true});
    const handles = [];
    for (const name of ["a.png", "b.png"]) {
      const handle = await directory.getFileHandle(name, {create: true});
      const writer = await handle.createWritable();
      try {await writer.write(Uint8Array.from(atob(png), character => character.charCodeAt(0)));}
      finally {await writer.close();}
      handles.push(handle);
    }
    window.__actualImportHandles = handles;
    window.__actualImportDirectory = directory;
    // Only the operating-system chooser is substituted. The handles, PNGs,
    // IndexedDB serialization and all product HTTP requests are real.
    window.showOpenFilePicker = async () => handles;
    window.showDirectoryPicker = async () => directory;
  }, {png, directoryName});
  await page.locator("#pickFolder").click();
  await page.locator(mode === "files" ? "#pickImages" : "#pickFolderFiles").click();
}

async function durableSnapshot(page, imageId) {
  return page.evaluate(async id => {
    const catalog = await api("/api/images");
    const manual = await api(`/api/workspace/manual/${id}`);
    return {
      workspace: catalog.workspaceId,
      images: catalog.images.map(image => ({id: image.id, relativePath: image.relativePath, sourceKind: image.sourceKind,
        sourceId: image.sourceId, width: image.width, height: image.height})),
      draft: manual.draft,
      history: await api(`/api/project/history/${id}`),
    };
  }, imageId);
}

async function selectImageById(page, id) {
  await page.locator(`.gallery-item[data-id="${id}"]`).click();
  await page.waitForFunction(id => state.currentId === id && state.currentImage && !state.pendingImageId && !state.projectHistoryBusy, id);
}

async function history(page, direction) {
  await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
  await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId);
}

async function checkHandles(page, ids) {
  if (!new Set(["files", "directory"]).has(mode)) return;
  assert.deepEqual(await page.evaluate(async ({ids, directoryName, png}) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(directoryName);
    const actual = [];
    for (const id of ids) {
      const access = state.sourceAccess.get(id);
      const file = await directory.getFileHandle(state.images.find(image => image.id === id).relativePath.split("/").at(-1));
      const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
      actual.push(Boolean(access?.fileHandle && await access.fileHandle.isSameEntry(file)
        && btoa(String.fromCharCode(...bytes)) === png));
    }
    return actual;
  }, {ids, directoryName, png}), [true, true], "promoted project keeps the original real file handles and source bytes");
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  let page;
  try {
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin, {waitUntil: "domcontentloaded"});
    await page.waitForFunction(() => state.settings && !state.images.length && !state.project && state.job);
    if (mode === "files" || mode === "directory") await pickerImport(page);
    else await nativeImport(page);
    await page.locator("#projectNameDialog").waitFor({state: "visible"});
    assert.equal(await page.locator("#projectNameTitle").textContent(), "新規プロジェクトを作成しますか？");
    const expectedName = mode === "files" ? "" : mode === "directory" ? directoryName : "Chosen Native Folder";
    assert.equal(await page.locator("#projectNameInput").inputValue(), expectedName, "the suggestion uses a genuine folder name only");
    const ids = await page.evaluate(() => state.images.map(image => image.id));
    assert.equal(ids.length, 2);
    const workspace = await page.evaluate(() => state.workspaceId);
    assert.ok(workspace);
    await checkHandles(page, ids);
    if (mode === "cancel" || mode === "escape") {
      if (mode === "cancel") await page.locator("#projectNameCancel").click();
      else await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#projectNameDialog").open);
      assert.deepEqual(await page.evaluate(() => state.images.map(image => image.id)), ids);
      assert.equal(await page.evaluate(() => state.project), null);
      assert.equal(await page.evaluate(() => state.workspaceId), workspace);
      await selectImageById(page, ids[0]);
      assert.equal(await page.locator("#brushTool").isDisabled(), false, "declining still permits editing imported images");
    } else {
      // A normal manual-save HTTP request creates existing durable edit/history
      // while the naming prompt is open, exercising promotion without replacing
      // the UI's captured import catalog or faking the persistence implementation.
      await page.evaluate(async ({id, mask}) => {
        await api(`/api/workspace/manual/${id}`, {method: "POST", body: JSON.stringify({
          add: mask, exclusion: "", exclusionErase: "", candidateRevision: 0, hasEffectiveMask: true,
        })});
      }, {id: ids[0], mask});
      const before = await durableSnapshot(page, ids[0]);
      assert.equal(before.history.canUndo, true);
      await page.locator("#projectNameInput").fill("Edited first project");
      await page.locator("#projectNameConfirm").click();
      await page.waitForFunction(() => state.project?.name === "Edited first project" && !state.projectOperationPending);
      assert.equal(await page.evaluate(() => state.project.id), workspace, "creation names the loaded workspace instead of replacing it");
      assert.deepEqual(await durableSnapshot(page, ids[0]), before, "promotion preserves image order, sources, dimensions, manual PNGs and history");
      await checkHandles(page, ids);
      await page.reload({waitUntil: "domcontentloaded"});
      await page.waitForFunction(name => state.project?.name === name && !state.projectOperationPending, "Edited first project");
      assert.deepEqual(await durableSnapshot(page, ids[0]), before, "page reload uses the same persisted project and image identities");
      await selectImageById(page, ids[0]);
      await checkHandles(page, ids);
      assert.equal(await page.evaluate(() => addCtx.getImageData(15, 15, 1, 1).data[3]), 255);
      await history(page, "undo");
      assert.equal(await page.evaluate(() => addCtx.getImageData(15, 15, 1, 1).data[3]), 0);
      await history(page, "redo");
      assert.equal(await page.evaluate(() => addCtx.getImageData(15, 15, 1, 1).data[3]), 255);
      await page.locator("#projectButton").click();
      await page.locator("#projectCloseWorkspace").click();
      await page.waitForFunction(() => !state.project && !state.images.length);
      await page.locator("#projectButton").click();
      await page.locator("#projectOpenList").click();
      await page.locator(`tr[data-project-id="${workspace}"]`).click();
      await page.locator("#projectDetailResume").click();
      await page.waitForFunction(id => state.project?.id === id && !state.projectOperationPending && state.images.length === 2, workspace);
      await selectImageById(page, ids[0]);
      await checkHandles(page, ids);
      const resumed = await durableSnapshot(page, ids[0]);
      // Undo/redo legitimately advance revisions; the actual persisted PNG and
      // source/image identities remain identical when the project is resumed.
      assert.equal(resumed.workspace, before.workspace);
      assert.deepEqual(resumed.images, before.images);
      assert.equal(resumed.draft.add, before.draft.add);
      assert.equal(resumed.history.canUndo, true);
      assert.equal(await page.evaluate(() => addCtx.getImageData(15, 15, 1, 1).data[3]), 255);
    }
    assert.deepEqual(errors, []);
    console.log(`first import ${mode}: real HTTP SQLite promotion and browser source restoration passed`);
  } finally {
    try {
      if (page && !page.isClosed() && ["files", "directory"].includes(mode)) {
        await page.evaluate(async name => {await (await navigator.storage.getDirectory()).removeEntry(name, {recursive: true});}, directoryName);
      }
    } finally {
      try {await context.close();}
      finally {await browser.close();}
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
