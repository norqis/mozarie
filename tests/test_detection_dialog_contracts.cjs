"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function withPage(run) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await run(page, fixture);
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

async function selectFirst(page) {
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && Boolean(state.currentImage));
}

test("SD-049 editor confidence slider keeps display and request value identical", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    await page.locator("#confidence").evaluate((input) => { input.value = "0.61"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.locator("#confidenceValue").textContent(), "0.61");
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.equal(fixture.detectRequests.at(-1).confidence, 0.61);
  });
});

test("SD-050 all-image confidence number synchronizes the slider and start request", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.locator("#detectConfidenceNumber").fill("0.73");
    await page.locator("#detectConfidenceNumber").dispatchEvent("input");
    assert.equal(await page.locator("#detectConfidenceRange").inputValue(), "0.73");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.equal(fixture.detectRequests.at(-1).confidence, 0.73);
  });
});

test("SD-052 current-image detection targets only the selected image and restores editing", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.deepEqual(fixture.detectRequests.at(-1).imageIds, ["sample"]);
    await page.waitForFunction(() => !state.processing && !isBusy());
    assert.equal(await page.locator("#editorCanvas").isEnabled(), true);
  });
});

test("SD-053 all-image dialog counts only processable non-hidden images before start", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.evaluate(() => { state.images[1].hidden = true; state.hiddenImageIds.add(state.images[1].id); renderCatalogViews(); updateActionButtons(); });
    const before = fixture.detectRequests.length;
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.match(await page.locator("#detectTargetCount").textContent(), /1/);
    assert.equal(fixture.detectRequests.length, before);
  });
});

test("SD-054 cancelling the all-image dialog starts no detection", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    const before = fixture.detectRequests.length;
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCancelButton").click();
    await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    assert.equal(fixture.detectRequests.length, before);
    assert.equal(await page.evaluate(() => state.processing), null);
  });
});
