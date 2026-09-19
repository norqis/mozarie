"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("SD-148 detection progress shows staged work and locks pause only while publication is pending", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await page.evaluate(() => showProcessing({
      kind: "detect", state: "running", startedAt: 1, total: 2, processed: 0, completed: 0,
      current: "sample.png", imageIds: ["sample", "sample-two"], completedImageIds: [], activeElapsed: 0,
    }));
    assert.equal(await page.locator("#processingProgress").getAttribute("max"), "2");
    assert.equal(await page.locator("#processingProgress").evaluate((progress) => String(progress.value)), "0");
    assert.match(await page.locator("#processingProgressText").textContent(), /0\s*\/\s*2/);
    assert.match(await page.locator("#processingCurrent").textContent(), /sample\.png/);
    assert.equal(await page.locator("#processingPauseButton").isEnabled(), true);

    await page.evaluate(() => showProcessing({
      kind: "detect", state: "running", startedAt: 1, total: 2, processed: 1, completed: 0,
      current: "sample-two.png", imageIds: ["sample", "sample-two"], completedImageIds: [], activeElapsed: 4,
    }));
    assert.equal(await page.locator("#processingProgress").evaluate((progress) => String(progress.value)), "1");
    assert.match(await page.locator("#processingProgressText").textContent(), /1\s*\/\s*2/);
    assert.match(await page.locator("#processingProgressText").textContent(), /残り約|remaining/i);
    assert.match(await page.locator("#processingCurrent").textContent(), /sample-two\.png/);
    assert.equal(await page.locator("#processingPauseButton").isEnabled(), true);

    await page.evaluate(() => showProcessing({
      kind: "detect", state: "running", startedAt: 1, total: 2, processed: 2, completed: 0,
      current: "", imageIds: ["sample", "sample-two"], completedImageIds: [], activeElapsed: 8,
    }));
    assert.equal(await page.locator("#processingProgress").evaluate((progress) => String(progress.value)), "2");
    assert.match(await page.locator("#processingProgressText").textContent(), /2\s*\/\s*2/);
    assert.equal(await page.locator("#processingCurrent").textContent(), "");
    assert.equal(await page.locator("#processingPauseButton").isDisabled(), true);

    await page.evaluate(() => showProcessing({
      kind: "detect", state: "complete", startedAt: 1, total: 2, processed: 2, completed: 2,
      current: "", imageIds: ["sample", "sample-two"], completedImageIds: ["sample", "sample-two"], activeElapsed: 8,
    }));
    assert.equal(await page.locator("#processingProgress").evaluate((progress) => String(progress.value)), "2");
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約|remaining/i);
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("SD-055 SD-056 sixty visible images start at zero complete at sixty and restore controls", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await page.evaluate(() => {
      const prototype = state.images[0];
      state.images = Array.from({ length: 61 }, (_, index) => ({
        ...prototype, id: `progress-${index}`, relativePath: `progress-${index}.png`, hidden: index === 60,
        reviewed: false, candidates: [], candidateCount: 0, enabledCandidateCount: 0,
      }));
      state.hiddenImageIds = new Set(["progress-60"]);
      renderCatalogViews(); updateActionButtons();
    });
    await page.locator("#detectAllButton").click();
    assert.match(await page.locator("#detectTargetCount").textContent(), /60/);
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect");
    assert.deepEqual(fixture.detectRequests.at(-1).imageIds, Array.from({ length: 60 }, (_, index) => `progress-${index}`));
    assert.equal(await page.locator("#processingProgress").getAttribute("max"), "60");
    assert.match(await page.locator("#processingProgressText").textContent(), /0\s*\/\s*60/);
    await page.evaluate(() => showProcessing({
      kind: "detect", state: "complete", startedAt: 1, total: 60, processed: 60, completed: 60,
      current: "", imageIds: Array.from({ length: 60 }, (_, index) => `progress-${index}`),
      completedImageIds: Array.from({ length: 60 }, (_, index) => `progress-${index}`), activeElapsed: 10,
    }));
    assert.match(await page.locator("#processingProgressText").textContent(), /60\s*\/\s*60/);
    await page.evaluate(() => { state.job = null; closeProcessing(); });
    assert.equal(await page.locator("#detectAllButton").isEnabled(), true);
    assert.equal(await page.locator("#settingsButton").isEnabled(), true);
  } finally {
    await browser.close();
    await closeServer(fixture.server);
  }
});

async function withHeldDetection(run) {
  const fixture = await startFixtureServer();
  fixture.holdDetection(true);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await page.locator("#detectAllButton").click();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" && document.querySelector("#processingDialog").open);
    await run(page, fixture);
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

test("SD-057 SD-058 pause and resume preserve the same detection job and visible progress", { timeout: 60000 }, async () => {
  await withHeldDetection(async (page) => {
    const before = await page.evaluate(() => ({ total: state.processing.total, imageIds: [...state.processing.imageIds] }));
    await page.locator("#processingPauseButton").click();
    await page.waitForFunction(() => state.processing?.state === "paused");
    assert.match(await page.locator("#processingPauseButton").textContent(), /再開|Resume/i);
    assert.deepEqual(await page.evaluate(() => ({ total: state.processing.total, imageIds: [...state.processing.imageIds] })), before);
    await page.locator("#processingPauseButton").click();
    await page.waitForFunction(() => state.processing?.state === "running");
    assert.match(await page.locator("#processingPauseButton").textContent(), /一時停止|Pause/i);
    assert.deepEqual(await page.evaluate(() => ({ total: state.processing.total, imageIds: [...state.processing.imageIds] })), before);
  });
});

test("SD-059 SD-148.2 cancel is sent once and stays visibly pending until terminal acknowledgement", { timeout: 60000 }, async () => {
  await withHeldDetection(async (page, fixture) => {
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => state.job?.cancelRequested === true);
    assert.equal(fixture.cancelRequests(), 1);
    assert.equal(await page.locator("#processingCancelButton").isDisabled(), true);
    assert.equal(await page.locator("#processingDialog").evaluate((dialog) => dialog.open), true);
    await page.locator("#processingCancelButton").evaluate((button) => button.click());
    assert.equal(fixture.cancelRequests(), 1);
    fixture.finishCancel();
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => !document.querySelector("#processingDialog").open && state.processing === null);
  });
});
