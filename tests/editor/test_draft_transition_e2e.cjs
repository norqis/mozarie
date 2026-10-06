"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { appendBrowserCoverage, closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

async function withEditor(run, { seedAllLayers = false } = {}) {
  const fixture = await startFixtureServer();
  let browser, context, page;
  const pageErrors = [];
  const covered = process.env.MOZARIE_JS_COVERAGE === "1";
  let coverageStarted = false;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.setDefaultTimeout(10000);
    if (covered) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); coverageStarted = true; }
    const assets = await page.evaluate(() => {
      const source = document.createElement("canvas"); source.width = 100; source.height = 80;
      const context = source.getContext("2d");
      context.fillStyle = "#888"; context.fillRect(0, 0, 100, 80);
      const image = source.toDataURL();
      context.clearRect(0, 0, 100, 80); context.fillStyle = "#fff"; context.fillRect(3, 3, 5, 5);
      return { image, base: source.toDataURL() };
    });
    await page.route("**/api/image/**", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(assets.image.split(",")[1], "base64") }));
    await page.route("**/api/workspace/manual/sample", (route) => route.request().method() === "GET"
      ? route.fulfill({ json: { draft: { add: assets.base, exclusion: seedAllLayers ? assets.base : "", exclusionErase: seedAllLayers ? assets.base : "", candidateRevision: 0 } } })
      : route.continue());
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await select(page, "sample");
    await page.locator("#brushSize").fill("8");
    await page.locator("#brushSize").dispatchEvent("input");
    await run(page, pageErrors);
  } finally {
    try {
      if (coverageStarted && process.env.MOZARIE_BROWSER_COVERAGE_FILE) {
        const entries = await page.coverage.stopJSCoverage();
        await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, entries);
      }
    } finally {
      try { await context?.close(); }
      finally { await Promise.all([browser?.close(), closeServer(fixture.server)]); }
    }
  }
}

async function select(page, id) {
  await page.locator(`.gallery-item[data-id="${id}"]`).click();
  await page.waitForFunction((expected) => state.currentId === expected && state.currentImage && !state.pendingImageId, id);
}

async function draw(page, tool, x, y) {
  await page.locator(`#${tool}`).click();
  const point = await page.evaluate(({ x, y }) => {
    const box = canvas.getBoundingClientRect();
    return { x: box.left + state.view.x + x * state.view.scale, y: box.top + state.view.y + y * state.view.scale };
  }, { x, y });
  await page.mouse.click(point.x, point.y);
}

async function holdNextAddEncoding(page) {
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    window.draftEncodingBarrier = { ready: false, used: false };
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (this !== addCanvas || window.draftEncodingBarrier.used) return original.call(this, callback, ...args);
      window.draftEncodingBarrier.used = true;
      original.call(this, (blob) => {
        window.draftEncodingBarrier.release = (fail = false) => {
          HTMLCanvasElement.prototype.toBlob = original;
          callback(fail ? null : blob);
        };
        window.draftEncodingBarrier.ready = true;
      }, ...args);
    };
  });
}

async function pixels(page) {
  return page.evaluate(() => {
    const alpha = (context, x, y) => context.getImageData(x, y, 1, 1).data[3];
    return {
      base: alpha(addCtx, 5, 5), add: alpha(addCtx, 20, 20),
      exclusion: alpha(exclusionCtx, 40, 40), erase: alpha(exclusionEraseCtx, 40, 40),
      history: state.history.length, index: state.historyIndex,
    };
  });
}

test("image transition waits for an already encoding draft and restores pixels and history", { timeout: 30000 }, () => withEditor(async (page, pageErrors) => {
  await holdNextAddEncoding(page);
  await draw(page, "brushTool", 20, 20);
  await page.waitForFunction(() => window.draftEncodingBarrier.ready && !state.draftDirty);
  await page.locator('.gallery-item[data-id="sample-two"]').click();
  assert.equal(await page.evaluate(() => state.currentId), "sample", "the original canvas remains selected until its encoder finishes");
  assert.equal(await page.evaluate(() => state.pendingImageId), "sample-two");
  assert.equal((await pixels(page)).add, 255);
  await page.evaluate(() => window.draftEncodingBarrier.release());
  await page.waitForFunction(() => state.currentId === "sample-two" && !state.pendingImageId);
  assert.equal((await pixels(page)).add, 0, "the other image never receives the outgoing layer");
  await select(page, "sample");
  assert.deepEqual(await pixels(page), { base: 255, add: 255, exclusion: 0, erase: 0, history: 1, index: 1 });
  await page.locator("#undoButton").click();
  await page.waitForFunction(() => state.historyIndex === 0 && !state.projectHistoryBusy);
  assert.deepEqual(await pixels(page), { base: 255, add: 0, exclusion: 0, erase: 0, history: 1, index: 0 }, "undo retains the preexisting history base");
  assert.deepEqual(pageErrors, []);
}));

test("returning to the current image supersedes a pending image selection", { timeout: 30000 }, () => withEditor(async (page, pageErrors) => {
  await holdNextAddEncoding(page);
  await draw(page, "brushTool", 20, 20);
  await page.waitForFunction(() => window.draftEncodingBarrier.ready);
  await page.evaluate(() => {
    window.displayedFiles = [];
    window.fileObserver = new MutationObserver(() => window.displayedFiles.push(document.querySelector("#currentFileName").textContent));
    window.fileObserver.observe(document.querySelector("#currentFileName"), { childList: true });
    document.querySelector('.gallery-item[data-id="sample-two"]').click();
    document.querySelector('.gallery-item[data-id="sample"]').click();
  });
  assert.equal(await page.evaluate(() => state.pendingImageId), "sample", "the last click owns the pending transition");
  await page.evaluate(() => window.draftEncodingBarrier.release());
  await page.waitForFunction(() => state.currentId === "sample" && !state.pendingImageId && state.draftSaveChains.size === 0);
  assert.deepEqual(await pixels(page), { base: 255, add: 255, exclusion: 0, erase: 0, history: 1, index: 1 });
  assert.deepEqual(await page.evaluate(() => { window.fileObserver.disconnect(); return window.displayedFiles.filter((name) => name.includes("sample-two")); }), [], "a superseded selection never replaces the canvas");
  assert.deepEqual(pageErrors, []);
}));

test("failed draft encoding retains every dirty layer ROI and history base for retry", { timeout: 30000 }, () => withEditor(async (page, pageErrors) => {
  await holdNextAddEncoding(page);
  await draw(page, "brushTool", 20, 20);
  await page.waitForFunction(() => window.draftEncodingBarrier.ready);
  await draw(page, "eraserTool", 40, 40);
  await draw(page, "excludeEraserTool", 40, 40);
  const before = await pixels(page);
  assert.deepEqual(before, { base: 255, add: 255, exclusion: 255, erase: 255, history: 3, index: 3 });
  await page.evaluate(() => window.draftEncodingBarrier.release(true));
  await page.waitForFunction(() => state.draftSaveChains.size === 0);
  assert.deepEqual(await page.evaluate(() => ({
    dirty: state.draftDirty, layers: [...state.draftLayerDirty].sort(), rois: [...state.draftDirtyRois.keys()].sort(), base: state.historyBaseDirty,
  })), { dirty: true, layers: ["add", "exclusion", "exclusionErase"], rois: ["add", "exclusion", "exclusionErase"], base: true }, "failed encoding merges its captured metadata with subsequent edits");
  const errorDialog = page.locator("#errorDialog");
  await errorDialog.waitFor({ state: "visible" });
  await errorDialog.locator("button").last().click();
  assert.deepEqual(await pixels(page), before);
  await select(page, "sample-two");
  assert.deepEqual(await pixels(page), { base: 0, add: 0, exclusion: 0, erase: 0, history: 0, index: 0 });
  await select(page, "sample");
  assert.deepEqual(await pixels(page), before, "retry and reload recover the current pixels, not the failed older snapshot");
  await page.locator("#undoButton").click();
  await page.waitForFunction(() => state.historyIndex === 2 && !state.projectHistoryBusy);
  assert.deepEqual(await pixels(page), { ...before, erase: 0, index: 2 });
  await page.locator("#redoButton").click();
  await page.waitForFunction(() => state.historyIndex === 3 && !state.projectHistoryBusy);
  assert.deepEqual(await pixels(page), before);
  assert.deepEqual(pageErrors, []);
}));

test("failed outgoing encoding cancels the latest transition without clearing its canvas", { timeout: 30000 }, () => withEditor(async (page, pageErrors) => {
  await holdNextAddEncoding(page);
  await draw(page, "brushTool", 20, 20);
  await page.waitForFunction(() => window.draftEncodingBarrier.ready && !state.draftDirty);
  const before = await pixels(page);
  await page.locator('.gallery-item[data-id="sample-two"]').click();
  await page.evaluate(() => window.draftEncodingBarrier.release(true));
  await page.locator("#errorDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => !state.pendingImageId && state.draftSaveChains.size === 0);
  assert.equal(await page.evaluate(() => state.currentId), "sample");
  assert.deepEqual(await pixels(page), before);
  assert.equal(await page.evaluate(() => state.draftDirty), true, "failure keeps the displayed edit retryable");
  await page.locator("#errorDialog button").last().click();
  await select(page, "sample-two");
  await select(page, "sample");
  assert.deepEqual(await pixels(page), before);
  assert.deepEqual(pageErrors, []);
}));

test("compact server layers become the base of local undo instead of an empty history", { timeout: 30000 }, () => withEditor(async (page, pageErrors) => {
  const bases = () => page.evaluate(() => [addCtx, exclusionCtx, exclusionEraseCtx].map((context) => context.getImageData(5, 5, 1, 1).data[3]));
  assert.equal(await page.evaluate(() => hasDurableHistory()), false);
  assert.deepEqual(await bases(), [255, 255, 255], "the first selection shows every persisted PNG layer");
  await draw(page, "brushTool", 20, 20);
  await page.locator("#undoButton").click();
  await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy);
  assert.deepEqual(await bases(), [255, 255, 255], "undo keeps all three loaded layers");
  assert.equal((await pixels(page)).add, 0);
  await page.locator("#redoButton").click();
  await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
  assert.deepEqual(await bases(), [255, 255, 255]);
  assert.equal((await pixels(page)).add, 255);
  assert.deepEqual(pageErrors, []);
}, { seedAllLayers: true }));
