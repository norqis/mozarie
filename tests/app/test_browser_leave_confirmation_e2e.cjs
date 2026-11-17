const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

test("browser back asks before leaving while image navigation stays inside the editor", { timeout: 30000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const previousUrl = `${fixture.url}/previous-page`;
    await page.route("**/previous-page", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Previous page</title>Previous page" }));
    await page.goto(previousUrl);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => appStartup);
    let dialogs = 0;
    page.on("dialog", () => { dialogs += 1; });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.locator("#nextImageButton").click();
    await page.waitForFunction(() => state.currentId === "sample-two" && !state.pendingImageId);
    await page.locator("#previousImageButton").click();
    await page.waitForFunction(() => state.currentId === "sample" && !state.pendingImageId);
    assert.equal(dialogs, 0, "moving between images never asks to leave the page");
    const editorUrl = page.url();
    const snapshot = () => page.evaluate(() => ({ current: state.currentId, images: state.images.map(({ id }) => id), historyIndex: state.historyIndex }));
    const before = await snapshot();
    const dismissedDialog = page.waitForEvent("dialog");
    await page.evaluate(() => history.back());
    const dismiss = await dismissedDialog;
    assert.equal(dismiss.type(), "beforeunload");
    await dismiss.dismiss();
    assert.equal(page.url(), editorUrl, "cancelling keeps the editor URL");
    assert.deepEqual(await snapshot(), before, "cancelling preserves the current editor state");
    const acceptedDialog = page.waitForEvent("dialog");
    await page.evaluate(() => history.back());
    const accept = await acceptedDialog;
    assert.equal(accept.type(), "beforeunload");
    await accept.accept();
    await page.waitForURL(previousUrl);
    assert.equal(page.url(), previousUrl, "confirming really returns to the previous page");
    assert.equal(dialogs, 2, "each back attempt asks once");
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});
