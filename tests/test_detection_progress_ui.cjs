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
