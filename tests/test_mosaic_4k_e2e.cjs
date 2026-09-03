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
        postMessage(payload, transfer) {
          if (payload.type === "render" && window.__dragRoiMetrics?.watchFinal) window.__dragRoiMetrics.finalFullPreview += 1;
          return super.postMessage(payload, transfer);
        }
      };
      window.__dragRoiMetrics = { paint: [], patchStarts: [], patchLatency: [], fullCompose: 0, finalFullCompose: 0, finalFullPreview: 0, fullMaskBitmap: 0, patchMaskBitmap: 0, fullMaskRead: 0, toBlob: 0, pendingMax: 0, watchFinal: false };
      const nativePaint = paintPendingManualStroke;
      paintPendingManualStroke = () => {
        const started = performance.now(); const result = nativePaint();
        window.__dragRoiMetrics.paint.push(performance.now() - started);
        window.__dragRoiMetrics.pendingMax = Math.max(window.__dragRoiMetrics.pendingMax, state.mosaicPending ? 1 : 0);
        return result;
      };
      const nativeCompose = composeCurrentMask;
      composeCurrentMask = (roi) => {
        if (state.activeStroke && !roi) window.__dragRoiMetrics.fullCompose += 1;
        if (window.__dragRoiMetrics.watchFinal && !roi) window.__dragRoiMetrics.finalFullCompose += 1;
        return nativeCompose(roi);
      };
      const nativeCreateImageBitmap = window.createImageBitmap;
      window.createImageBitmap = (...args) => {
        if (args[0] === combinedCanvas) {
          if (args.length === 1) window.__dragRoiMetrics.fullMaskBitmap += 1;
          else { window.__dragRoiMetrics.patchMaskBitmap += 1; window.__dragRoiMetrics.patchStarts.push(performance.now()); }
        }
        return nativeCreateImageBitmap(...args);
      };
      const nativeMosaicDrawImage = mosaicCtx.drawImage.bind(mosaicCtx);
      mosaicCtx.drawImage = (image, ...args) => {
        const result = nativeMosaicDrawImage(image, ...args);
        if (state.activeStroke && image?.width < originalCanvas.width) {
          const started = window.__dragRoiMetrics.patchStarts.shift();
          if (started !== undefined) window.__dragRoiMetrics.patchLatency.push(performance.now() - started);
        }
        return result;
      };
      const nativeMaskRead = combinedCtx.getImageData.bind(combinedCtx);
      combinedCtx.getImageData = (...args) => {
        if (state.activeStroke && args[2] === combinedCanvas.width && args[3] === combinedCanvas.height) window.__dragRoiMetrics.fullMaskRead += 1;
        return nativeMaskRead(...args);
      };
      const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(...args) {
        if (state.activeStroke) window.__dragRoiMetrics.toBlob += 1;
        return nativeToBlob.apply(this, args);
      };
      const source = document.createElement("canvas"); source.width = 3840; source.height = 2160;
      const sourceContext = source.getContext("2d");
      sourceContext.fillStyle = "#fff"; sourceContext.fillRect(0, 0, source.width, source.height);
      sourceContext.fillStyle = "#000";
      for (let x = 0; x < source.width; x += 4) sourceContext.fillRect(x, 0, 2, source.height);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = source.width; record.height = source.height;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft();
      // Share one full-size mask across eight enabled exclusions. This keeps
      // memory bounded while retaining the actual 4K drawImage source size.
      const exclusion = document.createElement("canvas"); exclusion.width = source.width; exclusion.height = source.height;
      exclusion.getContext("2d").fillRect(0, 0, 32, 32);
      state.candidates = Array.from({ length: 8 }, (_, index) => ({ id: `exclude-${index}`, role: "exclude", enabled: true, forced: true }));
      state.candidateImages = new Map(state.candidates.map((candidate) => [candidate.id, exclusion])); state.removedCandidateIds = new Set();
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
    await page.evaluate(() => { window.__dragRoiMetrics = { paint: [], patchStarts: [], patchLatency: [], fullCompose: 0, finalFullCompose: 0, finalFullPreview: 0, fullMaskBitmap: 0, patchMaskBitmap: 0, fullMaskRead: 0, toBlob: 0, pendingMax: 0, watchFinal: false }; });
    await page.locator("#brushTool").click();
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.endX, geometry.endY, { steps: 48 });
    await page.waitForFunction(({ logical }) => state.activeStroke?.points.length >= 2
      && combinedCtx.getImageData(logical.x, logical.y, 1, 1).data[3] > 0
      && [...mosaicCtx.getImageData(logical.x, logical.y, 1, 1).data].some((value, index) => value !== originalCtx.getImageData(logical.x, logical.y, 1, 1).data[index]), geometry);
    const dragMetrics = await page.evaluate(() => {
      const percentile = (samples) => {
        const sorted = samples.slice().sort((left, right) => left - right);
        return sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] || 0;
      };
      return { ...window.__dragRoiMetrics, p95: percentile(window.__dragRoiMetrics.paint), patchP95: percentile(window.__dragRoiMetrics.patchLatency), samples: window.__dragRoiMetrics.paint.length, patchSamples: window.__dragRoiMetrics.patchLatency.length };
    });
    assert.ok(dragMetrics.samples >= 2, "the 4K gesture paints multiple coalesced frames");
    assert.ok(dragMetrics.p95 < 33.4, `4K ROI paint p95 stays under one 30fps frame (${dragMetrics.p95.toFixed(1)}ms)`);
    assert.equal(dragMetrics.fullCompose, 0, "dragging never performs a full mask composition");
    assert.equal(dragMetrics.fullMaskBitmap, 0, "dragging never captures a full-size mask bitmap");
    assert.ok(dragMetrics.patchMaskBitmap > 0, "dragging sends one or more cropped mask patches");
    assert.ok(dragMetrics.patchSamples >= 1, "a cropped preview patch reaches the mosaic canvas before pointerup");
    assert.ok(dragMetrics.patchP95 < 33.4, `4K preview patch p95 stays under one 30fps frame (${dragMetrics.patchP95.toFixed(1)}ms)`);
    assert.equal(dragMetrics.fullMaskRead, 0, "dragging never reads the complete combined mask");
    assert.equal(dragMetrics.toBlob, 0, "dragging never serializes a canvas");
    assert.ok(dragMetrics.pendingMax <= 1, "dragging retains at most one newest worker patch");
    assert.equal(await page.evaluate(() => state.candidates.filter((candidate) => candidate.role === "exclude" && candidate.enabled).length), 8, "the drag stays within the 8-exclusion workload");
    const pointerUpAt = await page.evaluate(() => { window.__dragRoiMetrics.watchFinal = true; return performance.now(); });
    await page.mouse.up();
    await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
    const metrics = await page.evaluate((started) => new Promise((resolve) => setTimeout(() => resolve({
      completionMs: performance.now() - started,
      workerMax: window.__mosaicWorkerMetrics.maxActive,
      active: window.__mosaicWorkerMetrics.active,
      pending: state.mosaicPending,
      busy: state.mosaicWorkerBusy,
      finalFullCompose: window.__dragRoiMetrics.finalFullCompose,
      finalFullPreview: window.__dragRoiMetrics.finalFullPreview,
    }), 500)), pointerUpAt);
    assert.ok(metrics.completionMs < 1500, `4K preview settles after pointerup within the explicit limit (${metrics.completionMs.toFixed(1)}ms)`);
    assert.equal(metrics.finalFullCompose, 1, "pointerup performs exactly one final full mask composition");
    assert.equal(metrics.finalFullPreview, 1, "pointerup schedules exactly one final full preview");
    assert.equal(metrics.workerMax, 1, "4K preview creates at most one mosaic worker");
    assert.equal(metrics.active, 1, "the reusable worker remains singular after the settled frame");
    assert.equal(metrics.pending, false, "4K preview has no retained pending frame after settling");
    assert.equal(metrics.busy, false, "4K preview does not keep CPU work running after settling");
    console.log(`4K focused preview: paintP95=${dragMetrics.p95.toFixed(1)}ms patchP95=${dragMetrics.patchP95.toFixed(1)}ms complete=${metrics.completionMs.toFixed(1)}ms workers=${metrics.workerMax}`);
  } finally {
    await page?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
