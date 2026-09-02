const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("4K drag renders a preview before pointerup with one bounded worker", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(25000);
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    const geometry = await page.evaluate(async () => {
      releaseMosaicPreview();
      const NativeWorker = window.Worker;
      window.__mosaicWorkerMetrics = { active: 0, maxActive: 0 };
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          const metrics = window.__mosaicWorkerMetrics;
          metrics.active += 1; metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
        }
        terminate() {
          const metrics = window.__mosaicWorkerMetrics;
          metrics.active = Math.max(0, metrics.active - 1);
          return super.terminate();
        }
      };
      const source = document.createElement("canvas"); source.width = 3840; source.height = 2160;
      const sourceContext = source.getContext("2d");
      sourceContext.fillStyle = "#fff"; sourceContext.fillRect(0, 0, source.width, source.height);
      sourceContext.fillStyle = "#000";
      for (let x = 0; x < source.width; x += 4) sourceContext.fillRect(x, 0, 2, source.height);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = source.width; record.height = source.height;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft();
      state.candidates = []; state.candidateImages = new Map(); state.removedCandidateIds = new Set();
      state.mosaicPreviewEnabled = true; fitImage(); requestMosaicPreview();
      const rect = canvas.getBoundingClientRect(); const logical = { x: 1840, y: 1080 };
      return {
        x: rect.left + state.view.x + logical.x * state.view.scale,
        y: rect.top + state.view.y + logical.y * state.view.scale,
        endX: rect.left + state.view.x + (logical.x + 300) * state.view.scale,
        endY: rect.top + state.view.y + logical.y * state.view.scale,
        logical,
      };
    });
    await page.waitForFunction(() => !state.mosaicWorkerBusy && state.mosaicSourceId && !state.mosaicPreviewRequested);
    await page.locator("#brushTool").click();
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.endX, geometry.endY, { steps: 3 });
    await page.waitForFunction(({ logical }) => state.activeStroke?.points.length >= 2
      && combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0
      && [...mosaicCtx.getImageData(logical.x, logical.y, 1, 1).data].some((value, index) => value !== originalCtx.getImageData(logical.x, logical.y, 1, 1).data[index]), geometry);
    const pointerUpAt = await page.evaluate(() => performance.now());
    await page.mouse.up();
    await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
    const metrics = await page.evaluate((started) => new Promise((resolve) => setTimeout(() => resolve({
      completionMs: performance.now() - started,
      workerMax: window.__mosaicWorkerMetrics.maxActive,
      active: window.__mosaicWorkerMetrics.active,
      pending: state.mosaicPending,
      busy: state.mosaicWorkerBusy,
    }), 500)), pointerUpAt);
    assert.ok(metrics.completionMs < 25000, `4K preview settles after pointerup within the explicit limit (${metrics.completionMs.toFixed(1)}ms)`);
    assert.equal(metrics.workerMax, 1, "4K preview creates at most one mosaic worker");
    assert.equal(metrics.active, 1, "the reusable worker remains singular after the settled frame");
    assert.equal(metrics.pending, false, "4K preview has no retained pending frame after settling");
    assert.equal(metrics.busy, false, "4K preview does not keep CPU work running after settling");
    console.log(`4K focused preview: complete=${metrics.completionMs.toFixed(1)}ms workers=${metrics.workerMax}`);
  } finally {
    await page?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
