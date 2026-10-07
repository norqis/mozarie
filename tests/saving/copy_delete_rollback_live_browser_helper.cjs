"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");

(async () => {
  const origin = process.argv[2]; const mode = process.argv[3];
  const browser = await chromium.launch(); const context = await browser.newContext();
  try {
    const open = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(15000);

      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.settings && Number.isSafeInteger(state.serverCatalogGeneration));
      return page;
    };
    let page = await open();
    const original = await page.evaluate(async () => {
      const parent = await navigator.storage.getDirectory();
      const handle = await parent.getFileHandle("source.png", { create: true });
      const surface = document.createElement("canvas"); surface.width = 20; surface.height = 20;
      const draw = surface.getContext("2d"); draw.fillStyle = "red"; draw.fillRect(0, 0, 10, 20); draw.fillStyle = "blue"; draw.fillRect(10, 0, 10, 20);
      const blob = await new Promise((resolve) => surface.toBlob(resolve));
      const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
      await importFileHandles([{ handle, parentHandle: parent }]);
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.waitForFunction(() => state.images.length === 1 && !state.importing);
    if (!["rollback-unselected", "workspace-switch"].includes(mode)) {
      await page.locator(".gallery-item").first().click();
      await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
      await page.evaluate(() => openProjectNameDialog("name"));
      await page.locator("#projectNameInput").fill("Copy delete rollback");
      await page.locator("#projectNameConfirm").click();
      await page.waitForFunction(() => state.project?.id && !state.projectOperationPending);
    }
    const imageId = await page.evaluate(() => state.images[0].id);
    const peer = await open(); await peer.waitForFunction(() => state.images.length === 1);
    if (mode === "workspace-switch") {
      const before = await page.evaluate(() => ({ workspaceId: state.workspaceId, access: state.sourceAccess.size, currentId: state.currentId }));
      assert.equal(before.access, 1); assert.equal(before.currentId, null);
      await peer.evaluate(async () => {
        await catalogApi("/api/project/close", {}, { method: "POST" });
        const parent = await navigator.storage.getDirectory();
        await importFileHandles([{ handle: await parent.getFileHandle("source.png"), parentHandle: parent }]);
      });
      await page.evaluate(() => syncCatalogOnReturn());
      const after = await page.evaluate(() => ({ workspaceId: state.workspaceId, access: state.sourceAccess.size,
        images: state.images.map((image) => image.id), currentId: state.currentId }));
      assert.notEqual(after.workspaceId, before.workspaceId); assert.equal(after.access, 0);
      assert.equal(after.currentId, null); assert.equal(after.images.length, 1); assert.notEqual(after.images[0], imageId);
      console.log("unselected workspace switch discarded the previous workspace's source access");
      return;
    }
    let foreign; const deleting = !mode.startsWith("flip");
    let interceptions = 0;
    await page.route(deleting ? "**/api/catalog/delete-source" : "**/api/catalog/delete-source/prepare", async (route) => {
      interceptions += 1;
      if (mode === "foreign") foreign = await peer.evaluate(async () => {
        const parent = await navigator.storage.getDirectory();
        const handle = await parent.getFileHandle("source.png", { create: true });
        const surface = document.createElement("canvas"); surface.width = 20; surface.height = 20;
        const draw = surface.getContext("2d"); draw.fillStyle = "blue"; draw.fillRect(0, 0, 20, 20);
        const blob = await new Promise((resolve) => surface.toBlob(resolve));
        const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
        return [...new Uint8Array(await blob.arrayBuffer())];
      });
      await peer.evaluate(async ({ imageId, deleting }) => {
        await api(deleting ? `/api/workspace/manual/${imageId}` : `/api/images/${imageId}/transform`, {
          method: "POST", body: JSON.stringify(deleting ? { manualEnabled: false, hasEffectiveMask: false } : { flipH: true, flipV: false }),
        });
      }, { imageId, deleting });
      await route.continue();
    });
    if (mode === "remember-failure") await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "projectSources") throw new DOMException("fixture handle persistence failure", "UnknownError");
        return put.apply(this, args);
      };
    });
    if (mode === "checkpoint-failure") await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "sourceDeletes" && args[0]?.state === "restored") {
          IDBObjectStore.prototype.put = put;
          throw new DOMException("fixture restoration checkpoint failure", "UnknownError");
        }
        return put.apply(this, args);
      };
    });
    let lostCancel = false;
    if (["resume", "lost-ack"].includes(mode)) await page.route(mode === "lost-ack" ? "**/api/catalog/delete-source/ack" : "**/api/catalog/delete-source/cancel", async (route) => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      lostCancel = true; await route.abort("failed");
    });
    if (mode.endsWith("single")) {
      await page.locator("#saveButton").click();
      await page.locator("#singleSaveCopyMode").check();
      await page.locator("#singleSaveSuffix").fill("_copy");
      await page.locator("#singleSaveDeleteOriginal").check();
      await page.locator("#singleSaveStartButton").click();
      await page.locator("#confirmAccept").click();
      await page.waitForFunction(() => !state.saving && !state.saveStarting && state.singleSave === null);
      if (deleting) await page.waitForFunction(() => !state.pendingImageId && state.workspaceDraftRevisions.get(state.currentId) === 1);
    } else await page.evaluate(async (imageId) => { await runBrowserSave([imageId], "_copy", true, "copy"); }, imageId);
    assert.equal(interceptions, 1, "the actual copy reached the destructive phase once");
    await page.unroute(deleting ? "**/api/catalog/delete-source" : "**/api/catalog/delete-source/prepare");
    await peer.close();
    if (["resume", "remember-failure", "lost-ack"].includes(mode)) {
      if (mode !== "remember-failure") assert.equal(lostCancel, true);
      const pending = await page.evaluate(async () => (await pendingSourceDeletes()).map(({deleteToken,state}) => ({deleteToken,state})));
      assert.deepEqual(pending.map((entry) => entry.state), ["restored"]);
      await page.close();
      await context.addInitScript(() => {
        window.recoveryWrites = 0;
        FileSystemFileHandle.prototype.createWritable = async function () { window.recoveryWrites += 1; throw new Error("recovery must not rewrite a restored source"); };
      });
      page = await open();
      await expect.poll(() => page.evaluate(async () => [
        (await pendingSourceDeletes()).length, state.images.length, state.sourceAccess.size,
        Boolean(state.currentImage), Boolean(state.pendingImageId),
      ]), { timeout: 15000 }).toEqual([0, 1, 1, true, false]);
      assert.equal(await page.evaluate(() => window.recoveryWrites), 0);
    }
    if (mode === "rollback-unselected") assert.deepEqual(await page.evaluate(() => ({
      currentId: state.currentId, project: state.project, access: state.sourceAccess.size,
      canOverwrite: sourceCanOverwrite(state.images[0], "original"), canDelete: sourceCanDelete(state.images[0]),
      manualRevision: state.images[0].manualRevision,
    })), { currentId: null, project: null, access: 1, canOverwrite: true, canDelete: true, manualRevision: 1 });
    const result = await page.evaluate(async (imageId) => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle("source.png")).getFile();
      const access = state.sourceAccess.get(imageId);
      const image = (await api("/api/images")).images.find((image) => image.id === imageId);
      let permissionError = null;
      try { await ensureHandlePermission(access, false); } catch (error) { permissionError = error.code; }
      return { bytes: [...new Uint8Array(await file.arrayBuffer())], pending: (await pendingSourceDeletes()).length, intents: (await pendingSourceDeletes()).map(({deleteToken,state})=>({deleteToken,state})),
        fileMtime: file.lastModified, accessMtime: access?.lastModified, databaseMtime: Math.round(image.mtimeNs / 1000000),
        fileSize: file.size, accessSize: access?.size, databaseSize: image.sizeBytes, permissionError, flipH: image.flipH };
    }, imageId);
    assert.deepEqual(result.bytes, foreign || original, "rollback never overwrites a file created by another operation");
    if (["foreign", "checkpoint-failure"].includes(mode)) {
      assert.equal(result.pending, 1, "the unresolved rollback retains its durable snapshot and intent");
      const retained = await page.evaluate(async () => {
        await resumePendingSourceDeletes();
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle("source.png")).getFile();
        return { bytes: [...new Uint8Array(await file.arrayBuffer())], count: (await pendingSourceDeletes()).length };
      });
      assert.deepEqual(retained.bytes, result.bytes); assert.equal(retained.count, 1);
    } else {
      assert.equal(result.permissionError, null);
      assert.equal(result.accessMtime, result.fileMtime); assert.equal(result.databaseMtime, result.fileMtime);
      assert.equal(result.accessSize, result.fileSize); assert.equal(result.databaseSize, result.fileSize);
      if (deleting) assert.equal(result.pending, 0, JSON.stringify(result));
      else assert.equal(result.flipH, true);
      await page.evaluate(async (imageId) => { await runBrowserSave([imageId], "_retry", false, "copy"); }, imageId);
    }
    console.log("copy deletion race preserved original, edits and recovery state:", mode);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
