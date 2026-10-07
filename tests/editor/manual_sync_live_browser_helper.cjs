"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const [origin] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const peer = await context.newPage();
    for (const current of [page, peer]) {
      current.setDefaultTimeout(10000);
      await current.goto(origin, { waitUntil: "domcontentloaded" });
      await current.waitForFunction(() => state.settings && state.images.length === 2);
    }
    await page.bringToFront();
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    const imageId = await page.evaluate(() => state.currentId);
    const peerSave = async (points) => peer.evaluate(async ({ imageId, points }) => {
      const record = (await api("/api/images")).images.find((image) => image.id === imageId);
      const mask = document.createElement("canvas"); mask.width = record.width; mask.height = record.height;
      const ctx = mask.getContext("2d"); ctx.fillStyle = "white";
      for (const [x, y] of points) ctx.fillRect(x, y, 1, 1);
      return api(`/api/workspace/manual/${imageId}`, { method: "POST", body: JSON.stringify({
        add: mask.toDataURL(), hasEffectiveMask: points.length > 0, expectedManualRevision: record.manualRevision,
      }) });
    }, { imageId, points });
    const pixels = () => page.evaluate(() => [addCtx.getImageData(20, 20, 1, 1).data[3], addCtx.getImageData(35, 25, 1, 1).data[3]]);
    await peerSave([[20, 20]]);
    await page.evaluate(() => syncCatalogOnReturn());
    assert.deepEqual(await pixels(), [255, 0], "return to the editor loads the other window's brush pixels");
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("3");
    await page.locator("#brushSize").dispatchEvent("input");
    const point = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + state.view.x + 35 * state.view.scale, y: rect.top + state.view.y + 25 * state.view.scale };
    });
    await page.mouse.click(point.x, point.y);
    await page.evaluate(async () => { await flushWorkspaceDraft(state.currentId); await refreshProjectHistory(state.currentId); });
    assert.deepEqual(await pixels(), [255, 255]);
    await page.evaluate(async () => {
      addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
      refreshManualLayerPresence("add"); markMaskDirty(); markDraftDirty("add");
      await saveDraft(); await flushWorkspaceDraft(state.currentId); await refreshProjectHistory(state.currentId);
    });
    assert.deepEqual(await pixels(), [0, 0]);
    await page.evaluate(() => restoreProjectHistory("undo"));
    assert.deepEqual(await pixels(), [255, 255], "undo empty draft deletion restores both the old and latest stroke");
    await page.evaluate(() => restoreProjectHistory("redo"));
    assert.deepEqual(await pixels(), [0, 0], "redo returns to the actual empty mask");
    await page.evaluate(() => restoreProjectHistory("undo"));
    // Keep a real encoded draft queued while another image is selected.
    await page.evaluate(async () => {
      addCtx.fillStyle = "white"; addCtx.fillRect(50, 35, 1, 1);
      refreshManualLayerPresence("add"); markMaskDirty(); markDraftDirty("add");
      await saveDraft();
      clearTimeout(state.workspaceDraftTimers.get(state.currentId));
      const other = state.images.find((image) => image.id !== state.currentId);
      await selectImage(other.id, true, { saveCurrentDraft: false });
    });
    await peerSave([[10, 30]]);
    await page.evaluate(() => syncCatalogOnReturn());
    const conflict = await page.evaluate(async (id) => {
      try { await flushWorkspaceDraft(id); return null; } catch (error) { return error.code; }
    }, imageId);
    assert.equal(conflict, "manual_revision_conflict", "inactive dirty draft retains its old version and cannot overwrite the peer");
    assert.equal(await page.evaluate((id) => Boolean(state.drafts.get(id)?.add), imageId), true, "failed save retains the local draft");
    const saved = await peer.evaluate(async (id) => {
      const data = await api(`/api/workspace/manual/${id}`);
      const bitmap = await createImageBitmap(await fetch(data.draft.add).then((response) => response.blob()));
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [ctx.getImageData(10, 30, 1, 1).data[3], ctx.getImageData(50, 35, 1, 1).data[3]];
    }, imageId);
    assert.deepEqual(saved, [255, 0], "durable peer pixels survive the conflicting write");
    console.log("peer manual sync, inactive conflict, and empty-mask undo/redo passed");
  } finally {
    await context.close(); await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
