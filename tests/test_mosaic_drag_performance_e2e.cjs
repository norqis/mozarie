"use strict";

// Run without coverage instrumentation: timing includes the real brush,
// mask composition, worker response, and a browser paint frame.
const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("4K durable mosaic drag displays cropped worker previews within a gross latency budget", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    const geometry = await page.evaluate(async () => {
      const source = document.createElement("canvas"); source.width = 3840; source.height = 2160;
      const sourceContext = source.getContext("2d");
      sourceContext.fillStyle = "#fff"; sourceContext.fillRect(0, 0, source.width, source.height);
      sourceContext.fillStyle = "#000";
      for (let x = 0; x < source.width; x += 4) sourceContext.fillRect(x, 0, 2, source.height);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = source.width; record.height = source.height;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft();
      const exclusion = document.createElement("canvas"); exclusion.width = source.width; exclusion.height = source.height;
      exclusion.getContext("2d").fillRect(0, 0, 32, 32);
      state.candidates = [{ id: "ordinary-exclusion", role: "exclude", enabled: true, forced: false }];
      state.candidateImages = new Map([["ordinary-exclusion", exclusion]]);
      state.removedCandidateIds = new Set();
      state.historyDurable = true; state.project = { id: "4k-latency-fixture" };
      state.mosaicPreviewEnabled = true; fitImage(); requestMosaicPreview();
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left + state.view.x, top: rect.top + state.view.y, scale: state.view.scale };
    });
    await page.waitForFunction(() => !state.mosaicWorkerBusy && state.mosaicSourceId && !state.mosaicPreviewRequested);
    await page.locator("#brushTool").click();
    const screen = (x, y) => ({ x: geometry.left + x * geometry.scale, y: geometry.top + y * geometry.scale });
    const start = screen(600, 1000);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPending && !state.mosaicPreviewRequested);
    const samples = [];
    for (const x of [750, 900, 1050, 1200, 1350, 1500, 1650, 1800, 1950, 2100]) {
      await page.evaluate((targetX) => {
        const targetY = 1000;
        window.__mosaicDragLatency = { started: null, elapsed: null };
        canvas.addEventListener("pointermove", () => {
          if (!state.activeStroke) return;
          const probe = window.__mosaicDragLatency;
          probe.started = performance.now();
          const observe = () => {
            const maskAlpha = combinedCtx.getImageData(targetX, targetY, 1, 1).data[3];
            const mosaic = mosaicCtx.getImageData(targetX, targetY, 1, 1).data;
            const original = originalCtx.getImageData(targetX, targetY, 1, 1).data;
            if (maskAlpha && (mosaic[0] !== original[0] || mosaic[1] !== original[1] || mosaic[2] !== original[2])) {
              requestAnimationFrame(() => { probe.elapsed = performance.now() - probe.started; });
            } else requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        }, { once: true, capture: true });
      }, x);
      const point = screen(x, 1000);
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(() => Number.isFinite(window.__mosaicDragLatency?.elapsed));
      samples.push(await page.evaluate(() => window.__mosaicDragLatency.elapsed));
    }
    assert.equal(samples.length, 10, "one warmup and nine measured pointer-to-preview samples complete");
    const measured = samples.slice(1).sort((left, right) => left - right);
    const p95 = measured[Math.ceil(measured.length * .95) - 1];
    assert.ok(p95 < 450, `4K event-to-visible-preview p95 stays inside the gross regression budget (${p95.toFixed(1)}ms)`);
    const end = screen(2100, 1000);
    await page.evaluate(({ x, y }) => canvas.dispatchEvent(new PointerEvent("pointercancel", {
      pointerId: 1, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0,
    })), end);
    await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
    console.log(`4K mosaic drag: event-to-visible-preview p95=${p95.toFixed(1)}ms samples=${samples.map((value) => value.toFixed(1)).join(",")}`);
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
