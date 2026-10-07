"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

async function sourceDeleteScenario(closeOwner) {
  const fixture = await startFixtureServer();
  let browser; let context;
  try {
    browser = await chromium.launch(); context = await browser.newContext();
    const open = async () => {
      const page = await context.newPage();
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.settings && state.images.length === 2);
      return page;
    };
    const first = await open(); const second = await open();
    fixture.holdSourceDeletePrepare(true);
    await first.evaluate(() => {
      state.settings.confirmations.removeImage = false;
      window.deletion = permanentlyDeleteImages([state.images[0]], state.images);
    });
    await expect.poll(() => fixture.sourceDeleteRequests.filter((request) => request.path.endsWith("/prepare")).length).toBe(1);
    const token = fixture.sourceDeleteOperations()[0][0];
    await first.evaluate(() => resumePendingSourceDeletes());
    await second.evaluate(() => resumePendingSourceDeletes());
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), ["/api/catalog/delete-source/prepare"], "neither tab touches the active deletion's intent");
    if (closeOwner) {
      await first.close();
      await expect.poll(() => second.evaluate(async (token) => (await navigator.locks.query()).held.some((lock) => lock.name === `mozarie-source-delete:${token}`), token)).toBe(false);
      fixture.releaseSourceDeletePrepares();
      await second.evaluate(() => resumePendingSourceDeletes());
      assert.equal(fixture.sourceDeleteRequests.some((request) => request.path.endsWith("/status")), true, "the abandoned deletion is recoverable after the owner closes");
      assert.equal(fixture.sourceDeleteRequests.some((request) => request.path.endsWith("/cancel")), false, "a native source remains available for an explicit deletion retry");
      assert.deepEqual(fixture.catalogImageIds(), ["sample", "sample-two"]);
    } else {
      fixture.releaseSourceDeletePrepares(); await first.evaluate(() => window.deletion);
      assert.deepEqual(fixture.catalogImageIds(), ["sample-two"]);
      assert.deepEqual(await first.evaluate(async () => (await pendingSourceDeletes()).map((entry) => entry.deleteToken)), []);
      assert.equal(fixture.sourceDeleteRequests.some((request) => request.path.endsWith("/cancel")), false);
    }
  } finally {
    fixture.releaseSourceDeletePrepares();
    await context?.close(); await browser?.close();
    fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
}

test("active source deletion survives recovery in the same tab and another tab", { timeout: 60000 }, () => sourceDeleteScenario(false));
test("closing the source deletion tab releases its intent for recovery", { timeout: 60000 }, () => sourceDeleteScenario(true));
