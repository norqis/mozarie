"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function withPage(run) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await run(page, fixture);
  } finally {
    await browser.close();
    await closeServer(fixture.server);
  }
}

test("SD-018 a complete parallel import restores every primary control", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await page.route("**/api/import/file", async (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ imported: [], catalogId: "fixture-import-catalog", provisional: false }),
    }));
    await page.evaluate(async () => {
      state.settings.importing.parallelism = 6;
      await importFiles(Array.from({ length: 12 }, (_, index) => new File(["fixture"], `complete-${index}.png`, { type: "image/png" })));
    });
    assert.deepEqual(await page.evaluate(() => ({ importing: state.importing, session: state.importSession })), { importing: false, session: null });
    for (const selector of ["#pickFolder", "#detectAllButton", "#saveAllButton", "#settingsButton"]) {
      assert.equal(await page.locator(selector).isEnabled(), true, `${selector} is restored after every upload finishes`);
    }
  });
});
