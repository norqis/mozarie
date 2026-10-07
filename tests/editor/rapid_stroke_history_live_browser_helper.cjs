"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const [origin, mode] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let releaseUpload = () => {};
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1);
    await page.locator(".gallery-item").click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("3");
    await page.locator("#brushSize").dispatchEvent("input");
    const coordinates = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      return [15, 32, 49].map((x) => ({ x: rect.left + state.view.x + x * state.view.scale, y: rect.top + state.view.y + 30 * state.view.scale }));
    });
    const pixels = () => page.evaluate(() => [15, 32, 49].map((x) => addCtx.getImageData(x, 30, 1, 1).data[3]));
    const click = (index) => page.mouse.click(coordinates[index].x, coordinates[index].y);
    const flush = () => page.evaluate(async () => { await flushWorkspaceDraft(state.currentId); await refreshProjectHistory(); });
    const history = async (direction, expected) => {
      await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
      await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId);
      assert.deepEqual(await pixels(), expected, `${mode}: ${direction} changes one completed stroke`);
    };
    if (mode === "encoder") {
      await page.evaluate(() => {
        const native = HTMLCanvasElement.prototype.toBlob;
        window.strokeEncoderCallbacks = [];
        window.releaseStrokeEncoder = () => {
          HTMLCanvasElement.prototype.toBlob = native;
          for (const callback of window.strokeEncoderCallbacks.splice(0)) callback();
        };
        HTMLCanvasElement.prototype.toBlob = function (callback, ...options) {
          const hold = this === addCanvas;
          return native.call(this, (blob) => hold ? window.strokeEncoderCallbacks.push(() => callback(blob)) : callback(blob), ...options);
        };
      });
    }
    let uploadStarted;
    if (mode === "upload") {
      const gate = new Promise((resolve) => { releaseUpload = resolve; });
      let started;
      uploadStarted = new Promise((resolve) => { started = resolve; });
      let first = true;
      await page.route("**/api/workspace/manual/*/commit", async (route) => {
        if (first) { first = false; started(); await gate; }
        await route.continue();
      });
    }
    await click(0);
    if (mode === "encoder") await page.waitForFunction(() => window.strokeEncoderCallbacks.length > 0);
    if (mode === "upload") await uploadStarted;
    await click(1);
    await click(2);
    assert.deepEqual(await pixels(), [255, 255, 255], "pending encoding or network never blocks drawing");
    if (mode === "encoder") {
      // Each real pointerup must have captured its canvas before waiting on the first encoder.
      await page.waitForFunction(() => window.strokeEncoderCallbacks.length === 3);
      await page.evaluate(() => window.releaseStrokeEncoder());
    }
    releaseUpload();
    await flush();
    await history("undo", [255, 255, 0]);
    await history("undo", [255, 0, 0]);
    await history("undo", [0, 0, 0]);
    await history("redo", [255, 0, 0]);
    await history("redo", [255, 255, 0]);
    await history("redo", [255, 255, 255]);
    // Reopen through a fresh browser page; durable history keeps its operation boundaries.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1);
    await page.locator(".gallery-item").click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    await history("undo", [255, 255, 0]);
    await history("redo", [255, 255, 255]);
    const enabled = page.locator(".candidate-row-manual-apply .candidate-toggle");
    await enabled.click();
    await enabled.click();
    await flush();
    await history("undo", [255, 255, 255]);
    assert.equal(await enabled.getAttribute("aria-pressed"), "false");
    await history("undo", [255, 255, 255]);
    assert.equal(await enabled.getAttribute("aria-pressed"), "true");
    await page.locator("#mosaicEraserTool").click();
    await page.locator("#brushSize").fill("3");
    await page.locator("#brushSize").dispatchEvent("input");
    await click(0); await click(1);
    await flush();
    assert.deepEqual(await pixels(), [0, 0, 255]);
    await history("undo", [0, 255, 255]);
    await history("undo", [255, 255, 255]);
    await page.locator(".candidate-row-manual-apply .candidate-delete").click();
    await flush();
    assert.deepEqual(await pixels(), [0, 0, 0]);
    await history("undo", [255, 255, 255]);
    await history("redo", [0, 0, 0]);
    console.log(`${mode}: each completed stroke and clear keeps its durable history boundary`);
  } finally {
    releaseUpload();
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
