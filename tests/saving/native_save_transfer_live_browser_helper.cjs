"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function assertNativeResponse(response) {
  assert.equal(response.status(), 200);
  assert.equal(response.request().postDataJSON().streamImage, false, "native single and batch overwrite request headers only");
  assert.equal(response.headers()["content-length"], "0");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1 && !state.projectOperationPending);
    await page.locator(".gallery-item[data-id]").click();
    await page.waitForFunction(() => state.currentImage && state.currentId === state.images[0].id);
    await page.locator("#flipHorizontalButton").click();
    await page.waitForFunction(() => state.images[0].flipH && !state.transformPending);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption("original");
    const singleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/save/render");
    await page.locator("#singleSaveStartButton").click();
    await page.locator("#confirmDialog[open] #confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    assertNativeResponse(await singleResponse);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    const sourceUrl = await page.evaluate(() => `/api/image/${state.images[0].id}`);
    const single = (await (await page.request.get(new URL(sourceUrl, process.argv[2]).href)).body()).toString("base64");
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#flipVerticalButton").click();
    await page.waitForFunction(() => state.images[0].flipV && !state.transformPending);
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyOutputFormat").selectOption("original");
    const batchResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/save/render");
    await page.locator("#applyStartButton").click();
    await page.locator("#confirmDialog[open] #confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !document.querySelector("#confirmDialog").open);
    assertNativeResponse(await batchResponse);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    const batch = (await (await page.request.get(new URL(sourceUrl, process.argv[2]).href)).body()).toString("base64");
    console.log(JSON.stringify({ single, batch }));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
