"use strict";

// Python owns the real HTTP server, model-boundary barriers and cleanup.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const [origin] = process.argv.slice(2);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    const release = async (step) => {
      const response = await context.request.get(`${origin}/__fixture__/${step}`);
      assert.equal(response.ok(), true);
    };
    const preparing = async () => {
      await page.waitForFunction(() => state.processing?.phase === "preparing_models" && document.querySelector("#processingDialog").open);
      assert.equal(await page.locator("#processingCurrent").textContent(), "モデル準備中");
      assert.equal(await page.locator("#processingProgress").evaluate((item) => item.value), 0);
      const job = await (await context.request.get(`${origin}/api/job`)).json();
      assert.equal(job.phase, "preparing_models");
      assert.equal(job.current, "", "model setup must not publish an image filename");
    };
    const start = async () => {
      await page.locator("#detectCurrentButton").click();
      await preparing();
    };
    const waitForTerminal = async (expectedState, nextButton) => {
      await page.waitForFunction(({ expectedState, nextButton }) =>
        state.job?.state === expectedState && !state.processing && !state.pollInFlight
        && !currentImageActionPending() && !document.querySelector(nextButton).disabled,
      { expectedState, nextButton });
    };
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1 && !state.projectOperationPending);
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentId && state.currentImage);
    await start();
    await page.locator("#processingPauseButton").click();
    await page.waitForFunction(() => state.processing?.state === "paused");
    assert.equal(await page.locator("#processingCurrent").textContent(), "モデル準備中");
    assert.equal(await page.locator("#processingPauseButton").textContent(), "再開");
    await page.locator("#processingPauseButton").click();
    await page.waitForFunction(() => state.processing?.state === "running");
    await release("runtime");
    await preparing();
    await release("target");
    await page.waitForFunction(() => state.processing?.phase === "" && document.querySelector("#processingCurrent").textContent === "progress.png");
    assert.equal(await page.locator("#processingDialog").evaluate((dialog) => dialog.open), true);
    await release("inference");
    await preparing();
    await release("hand");
    await waitForTerminal("complete", "#detectCurrentButton");
    assert.equal(await page.locator("#processingDialog").evaluate((dialog) => dialog.open), false);
    assert.equal(await page.locator("#detectCurrentButton").isEnabled(), true);

    const cachedRun = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/detect" && response.request().method() === "POST");
    await page.locator("#detectCurrentButton").click();
    await cachedRun;
    await waitForTerminal("complete", "#detectCurrentButton");
    assert.equal((await (await context.request.get(`${origin}/api/job`)).json()).phase, "");

    await release("reset-error");
    await start();
    await release("target");
    await waitForTerminal("error", "#errorDialogClose");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#processingDialog").evaluate((dialog) => dialog.open), false);
    assert.equal((await (await context.request.get(`${origin}/api/job`)).json()).phase, "");
    await page.locator("#errorDialogClose").click();

    await release("reset-cancel");
    await start();
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => state.job?.cancelRequested);
    assert.equal(await page.locator("#processingCancelButton").isDisabled(), true);
    await release("target");
    await waitForTerminal("cancelled", "#detectionSettingsButton");
    assert.equal(await page.locator("#detectionSettingsButton").isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
