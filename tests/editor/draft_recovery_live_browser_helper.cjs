"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const [origin, kind] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const select = async () => {
      await page.waitForFunction(() => state.settings && state.images.length === 2);
      await page.locator(".gallery-item").first().click();
      await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    };
    const pixels = () => page.evaluate(() => ({
      add: addCtx.getImageData(5, 5, 1, 1).data[3],
      exclusion: exclusionCtx.getImageData(15, 5, 1, 1).data[3],
      erase: exclusionEraseCtx.getImageData(25, 5, 1, 1).data[3],
      edited: addCtx.getImageData(40, 30, 1, 1).data[3],
    }));
    const flush = async () => {
      await page.evaluate(async () => {
        await flushWorkspaceDraft(state.currentId);
        if (hasDurableHistory()) await refreshProjectHistory(state.currentId);
      });
      await page.waitForFunction(() => !state.projectHistoryBusy && !state.historyRestoreBusy);
      assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    };
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await select();
    assert.equal(await page.evaluate(() => Boolean(state.project)), kind === "named");
    assert.equal(await page.evaluate(() => hasDurableHistory()), true, "native anonymous and named workspaces both keep durable history");
    const base = { add: 255, exclusion: 255, erase: 255, edited: 0 };
    assert.deepEqual(await pixels(), base, "the first load retains all three server PNG layers");
    await page.locator("#brushSize").fill("6");
    await page.locator("#brushSize").dispatchEvent("input");
    await page.locator("#brushTool").click();
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        if (this !== addCanvas) return original.call(this, callback, ...args);
        HTMLCanvasElement.prototype.toBlob = original;
        original.call(this, (blob) => { window.releaseDraftEncoding = () => callback(blob); }, ...args);
      };
    });
    const point = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + state.view.x + 40 * state.view.scale, y: rect.top + state.view.y + 30 * state.view.scale };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => typeof window.releaseDraftEncoding === "function");
    const imageId = await page.evaluate(() => state.currentId);
    await page.evaluate(() => {
      document.querySelectorAll(".gallery-item")[1].click();
      document.querySelectorAll(".gallery-item")[0].click();
    });
    assert.equal(await page.evaluate(() => state.pendingImageId), imageId, "the last durable-workspace selection owns the pending edit");
    await page.evaluate(() => window.releaseDraftEncoding());
    await page.waitForFunction((expected) => state.currentId === expected && !state.pendingImageId, imageId);
    await flush();
    assert.deepEqual(await pixels(), { ...base, edited: 255 });
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => addCtx.getImageData(40, 30, 1, 1).data[3] === 0 && !state.projectHistoryBusy && !state.historyRestoreBusy);
    assert.deepEqual(await pixels(), base, "the first undo preserves the loaded layers as its history base");
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => addCtx.getImageData(40, 30, 1, 1).data[3] === 255 && !state.projectHistoryBusy && !state.historyRestoreBusy);
    await flush();
    assert.deepEqual(await pixels(), { ...base, edited: 255 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await select();
    assert.deepEqual(await pixels(), { ...base, edited: 255 }, "a full page reload recovers the committed layers from the real server");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
