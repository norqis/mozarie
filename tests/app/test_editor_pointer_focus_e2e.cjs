const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

test("pointer buttons return to editor shortcuts without stealing input menu or keyboard focus", { timeout: 30000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" }); await page.evaluate(() => appStartup);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && !state.pendingImageId);
    const focusId = () => page.evaluate(() => document.activeElement.id);
    for (const id of ["mosaicPreviewButton", "fitButton", "collapseGalleryButton", "collapseGalleryButton"]) {
      await page.locator(`#${id}`).click();
      assert.equal(await focusId(), "editorCanvas", `${id} returns pointer focus to the editor`);
    }
    await page.locator("#mosaicPreviewButton").tap();
    assert.equal(await focusId(), "editorCanvas", "touch buttons also return focus to the editor");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => state.currentId === "sample-two" && !state.pendingImageId);
    assert.equal(await page.evaluate(() => isReviewed(state.images.find(({ id }) => id === "sample"))), true, "Enter after clicking a button reviews and advances");
    await page.locator("#brushSize").click();
    assert.equal(await focusId(), "brushSize", "numeric and slider controls keep their native focus");
    await page.locator(".gallery-heading h2").click();
    assert.equal(await focusId(), "editorCanvas", "a panel heading clears the prior input focus");
    await page.locator("#brushSize").click(); await page.locator(".appbar").click({ position: { x: 1, y: 1 } });
    assert.equal(await focusId(), "editorCanvas", "header whitespace also clears the prior input focus");
    await page.locator("#galleryFilterButton").click();
    assert.equal(await page.locator("#galleryFilterMenu").evaluate((node) => node.matches(":popover-open")), true);
    assert.notEqual(await focusId(), "editorCanvas", "opening a native popover preserves its focus interaction");
    const beforeMenuEnter = await page.evaluate(() => state.currentId);
    const reviewedBeforeMenu = await page.evaluate(() => isReviewed(currentRecord()));
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => state.currentId), beforeMenuEnter, "menu focus never triggers the review shortcut");
    assert.equal(await page.evaluate(() => isReviewed(currentRecord())), reviewedBeforeMenu);
    await page.locator("#galleryFilterButton").click();
    await page.locator("#galleryFilterButton").click();
    assert.equal(await focusId(), "editorCanvas", "closing a native popover returns pointer focus to the editor");
    await page.locator("#bucketTool").click();
    await page.locator("#bucketTolerance").click();
    assert.equal(await focusId(), "bucketTolerance", "popover number input keeps focus");
    await page.locator("#brushTool").click();
    await page.locator("#boundaryTool").click();
    assert.equal(await page.locator("#boundaryModeMenu").isVisible(), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => state.currentId), beforeMenuEnter);
    assert.equal(await page.evaluate(() => isReviewed(currentRecord())), reviewedBeforeMenu, "a boundary menu does not let Enter review the current image");
    await page.locator("#brushTool").click();
    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabGeneral").click();
    assert.equal(await focusId(), "settingsTabGeneral", "modal button focus stays in its dialog");
    await page.locator("#settingsPort").click();
    assert.equal(await focusId(), "settingsPort");
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open && document.activeElement.id === "settingsButton");
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && !state.pendingImageId);
    await page.locator("#settingsButton").click(); await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open && document.activeElement.id === "settingsButton");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => state.currentId === "sample-two" && !state.pendingImageId);
    // Keyboard activation has detail=0: native Enter must still activate a focused button.
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Tab");
    await page.locator("#mosaicPreviewButton").focus();
    assert.equal(await page.locator(":focus").evaluate((node) => node.matches(":focus-visible")), true);
    const focusedButton = await focusId();
    const current = await page.evaluate(() => state.currentId);
    const preview = await page.evaluate(() => state.mosaicPreviewEnabled);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => state.currentId), current, "native Enter on a keyboard-focused button does not review an image");
    assert.equal(await page.evaluate(() => state.mosaicPreviewEnabled), !preview, "native Enter activates the keyboard-focused button");
    assert.equal(await focusId(), focusedButton, "keyboard activation preserves the button focus");
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});
