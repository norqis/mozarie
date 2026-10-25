const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = []; const preparedOrders = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/save/prepare") preparedOrders.push(request.postDataJSON());
    });
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 4);
    const original = await page.evaluate(() => state.images.map((image) => ({ id: image.id, path: image.relativePath })));
    await page.locator("#overviewButton").click();
    await page.locator("#reorderImagesButton").click();
    await page.locator(".overview-item").first().click();
    await page.locator("#reorderLast").click();
    await page.locator("#reorderApply").click();
    await page.waitForFunction(() => !state.reorder);
    const expectedOrder = [...original.slice(1), original[0]];
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), expectedOrder.map((image) => image.id));
    await page.locator("#closeOverviewButton").click();
    for (const placement of ["only", "prefix", "suffix"]) {
      await page.locator("#saveAllButton").click();
      await page.locator("#applyNumbering").check();
      await page.locator("#applySuffix").fill("_custom");
      await page.locator("#applyNumberingDigits").fill("2");
      await page.locator("#applyNumberingPlacement").selectOption(placement);
      await page.waitForFunction(() => !document.querySelector("#applyStartButton").disabled);
      await page.locator("#applyStartButton").click();
      await page.waitForFunction(() => !state.saveStarting && !state.applyRunning && !state.saving);
      assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false,
        await page.locator("#errorDialogCause").textContent());
      await page.locator("#applyCloseButton").click();
    }
    await page.locator("#saveAllButton").click();
    await page.locator("label:has(#applyFilterReviewed)").click();
    await page.locator("#applyNumberingDigits").fill("3");
    await page.locator("#applyNumberingPlacement").selectOption("prefix");
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => !state.saveStarting && !state.applyRunning && !state.saving);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
    await page.locator("#applyCloseButton").click();
    await page.locator("#saveAllButton").click();
    await page.locator("label:has(#applyFilterReviewed)").click();
    await page.locator("#applyNumberingDigits").fill("2");
    await page.locator("#applyNumberingPlacement").selectOption("only");
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyStartButton").click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saveStarting && !state.applyRunning && !state.saving);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false,
      await page.locator("#errorDialogCause").textContent());
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.relativePath)), ["01.png", "02.png", "03.png", "04.png"]);
    assert.equal(preparedOrders.length, 5);
    const reviewedIds = [original[1].id, original[3].id];
    for (const [index, request] of preparedOrders.entries()) {
      assert.deepEqual(request.imageIds, index === 3 ? reviewedIds : expectedOrder.map((image) => image.id));
      assert.equal(request.suffix, "_custom");
      assert.equal(request.numbering.digits, index === 3 ? 3 : 2);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ order: expectedOrder.map((image) => image.path), saves: preparedOrders.length }));
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
