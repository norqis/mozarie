"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

async function withPendingSaves(run) {
  const fixture = await startFixtureServer();
  let browser; let context;
  try {
    fixture.setCatalog(["first", "second"].map((id) => ({ id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 1, height: 1, candidateRevision: 0 })));
    browser = await chromium.launch(); context = await browser.newContext();
    const pending = new Map(); const waiters = new Map(); const cancellations = []; const statuses = new Map();
    await context.route("**/api/save/commit", async (route) => {
      const payload = route.request().postDataJSON();
      statuses.set(payload.saveToken, "pending");
      pending.set(payload.imageId, { payload, complete: async () => {
        statuses.set(payload.saveToken, "committed");
        await route.fulfill({ json: { cleared: true, stale: false, sourceAction: payload.sourceAction } });
      } });
      waiters.get(payload.imageId)?.();
    });
    await context.route("**/api/save/cancel", async (route) => {
      const payload = route.request().postDataJSON();
      cancellations.push(payload.imageId); statuses.set(payload.saveToken, "cancelled");
      await route.fulfill({ json: { state: "cancelled" } });
    });
    await context.route("**/api/save/status", (route) => route.fulfill({ json: { state: statuses.get(route.request().postDataJSON().saveToken) || "unknown" } }));
    await context.route("**/api/save/ack", (route) => route.fulfill({ json: { acknowledged: true } }));
    const open = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.settings && state.images.length === 2);
      return page;
    };
    const start = async (page, id, single = false) => {
      const atCommit = new Promise((resolve) => waiters.set(id, resolve));
      if (single) {
        await page.evaluate(async (id) => {
          state.settings.confirmations.overwriteSource = false;
          await selectImage(id); await openSingleSaveDialog();
        }, id);
        await page.locator("#singleSaveOverwriteMode").check();
        await page.locator("#singleSaveStartButton").click();
      } else {
        await page.evaluate((id) => { window.saveResult = runBrowserSave([id], "", false, "overwrite").catch((error) => { window.saveError = error.code; }); }, id);
      }
      await atCommit;
    };
    await run({ open, start, pending, cancellations, context });
  } finally {
    await context?.close(); await browser?.close();
    fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
}

function activeSaveScenario(single) {
  return async () => {
    await withPendingSaves(async ({ open, start, pending, cancellations }) => {
      const first = await open(); await start(first, "first", single);
      await first.evaluate(() => reconcilePendingBrowserSaves());
      assert.deepEqual(cancellations, [], "same-tab online recovery does not cancel an active save");
      const second = await open(); await second.evaluate(() => reconcilePendingBrowserSaves());
      assert.deepEqual(cancellations, [], "new-tab startup recovery does not cancel another tab's save");
      await start(second, "second");
      assert.equal(pending.size, 2, "both saves reach commit while neither has completed");
      await pending.get("second").complete();
      await second.evaluate(() => window.saveResult);
      await pending.get("first").complete();
      await first.waitForFunction(() => !state.saving && !state.saveStarting);
      assert.deepEqual(cancellations, []);
      assert.equal(await second.evaluate(() => window.saveError || null), null);
      assert.equal(await first.evaluate(() => document.querySelector("#errorDialog").open), false);
    });
  };
}

test("batch save survives recovery in its own tab and another tab without serializing saves", { timeout: 60000 }, activeSaveScenario(false));
test("single save survives recovery in its own tab and another tab without serializing saves", { timeout: 60000 }, activeSaveScenario(true));

test("closing the saving tab releases ownership so another tab can cancel its abandoned token", { timeout: 60000 }, async () => {
  await withPendingSaves(async ({ open, start, cancellations }) => {
    const first = await open(); await start(first, "first");
    const second = await open(); await second.evaluate(() => reconcilePendingBrowserSaves());
    assert.deepEqual(cancellations, []);
    await first.close();
    await expect.poll(() => second.evaluate(async () => (await navigator.locks.query()).held.some((lock) => lock.name === "mozarie-browser-save-ownership"))).toBe(false);
    assert.equal(await second.evaluate(() => Object.keys(pendingSaveTokens()).length), 1, "the abandoned token remains in shared storage");
    await second.evaluate(() => reconcilePendingBrowserSaves());
    assert.deepEqual(cancellations, ["first"]);
  });
});

test("slow abandoned-save recovery neither blocks a new save nor includes its new token", { timeout: 60000 }, async () => {
  await withPendingSaves(async ({ open, start, pending, cancellations, context }) => {
    const first = await open(); await start(first, "first"); await first.close();
    let statusRoute; let notifyStatus;
    const atStatus = new Promise((resolve) => { notifyStatus = resolve; });
    await context.route("**/api/save/status", (route) => { statusRoute = route; notifyStatus(); });
    const second = await open(); await atStatus;
    await start(second, "second");
    assert.equal(pending.size, 2, "a new save reaches commit while old-token status is still pending");
    const cancelled = second.waitForResponse((response) => new URL(response.url()).pathname === "/api/save/cancel");
    await statusRoute.fallback(); await cancelled;
    assert.deepEqual(cancellations, ["first"]);
    await pending.get("second").complete(); await second.evaluate(() => window.saveResult);
    assert.equal(await second.evaluate(() => window.saveError || null), null);
  });
});

test("abandoned-save recovery uses the configured pool and retains only failed tokens", { timeout: 60000 }, async () => {
  await withPendingSaves(async ({ open, context }) => {
    const page = await open();
    const routes = [];
    await context.route("**/api/save/status", (route) => { routes.push(route); });
    await page.evaluate(() => {
      state.settings.saving.parallelism = 2;
      for (let index = 0; index < 4; index += 1) rememberPendingSave({ imageId: `recovery-${index}`, candidateRevision: 0 }, `token-${index}`);
      window.recovery = reconcilePendingBrowserSaves();
    });
    await expect.poll(() => routes.length).toBe(2);
    const first = routes[0].request().postDataJSON().saveToken;
    await routes[0].fulfill({ status: 503, json: { error_code: "internal_error" } });
    await expect.poll(() => routes.length).toBe(3);
    await routes[1].fulfill({ json: { state: "unknown" } });
    await expect.poll(() => routes.length).toBe(4);
    await routes[2].fulfill({ json: { state: "unknown" } });
    await routes[3].fulfill({ json: { state: "unknown" } });
    await page.evaluate(() => window.recovery);
    assert.deepEqual(await page.evaluate(() => Object.keys(pendingSaveTokens())), [first]);
  });
});
