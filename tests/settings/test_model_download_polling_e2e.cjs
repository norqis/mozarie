"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

async function withDownloadPage(run) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.addInitScript(() => {
      const nativeSet = window.setInterval; const nativeClear = window.clearInterval;
      const timers = new Map(); let id = -1;
      window.setInterval = (callback, delay, ...args) => {
        if (delay !== 350) return nativeSet(callback, delay, ...args);
        timers.set(id, () => callback(...args)); return id--;
      };
      window.clearInterval = (timer) => timers.delete(timer) || nativeClear(timer);
      window.tickModelPoll = () => { for (const callback of [...timers.values()]) callback(); };
      window.modelPollCount = () => timers.size;
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabModels").click();
    await page.locator("#settingsPrecisionCard label.model-switch").click();
    await page.route("**/api/model-download/start", (route) => reply(route, "running"));
    await page.route("**/api/model-download/cancel", (route) => reply(route, "cancelled"));
    await page.locator('[data-model-download="sam"]').click();
    await run(page);
  } finally {
    await context.close(); await browser.close(); await closeServer(fixture.server);
  }
}

const reply = (route, state) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state, received: state === "complete" ? 10 : 3, expected: 10 }) });
async function holdStatus(page, fail = false) {
  let release; let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  let requests = 0;
  await page.route("**/api/model-download", async (route) => {
    requests++; reached(); await gate;
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "internal_error", error: "temporary failure" }) });
    else await reply(route, "running");
  });
  return { release, started, requests: () => requests };
}
async function begin(page) {
  await page.locator("#modelDownloadStart").click();
  await page.waitForFunction(() => document.querySelector("#modelDownloadClose").disabled);
}
async function terminal(page, state) {
  assert.equal(await page.locator("#modelDownloadStatus").textContent(), await page.evaluate((value) => t(`modelDownload.${value}`), state));
  assert.equal(await page.locator("#modelDownloadClose").isEnabled(), true);
  assert.equal(await page.locator("#modelDownloadCancel").isVisible(), false);
  assert.equal(await page.evaluate(() => window.modelPollCount()), 0);
  assert.equal(await page.locator("#errorDialog").isVisible(), false);
}

test("model progress callers share one request until it completes", { timeout: 30000 }, async () => {
  await withDownloadPage(async (page) => {
    let release; let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { reached = resolve; });
    let requests = 0;
    await page.route("**/api/model-download", async (route) => { requests++; reached(); await gate; await reply(route, "complete"); });
    try {
      await begin(page);
      await page.evaluate(() => {
        window.firstPoll = refreshModelDownload();
        window.secondPoll = refreshModelDownload();
        window.tickModelPoll(); window.tickModelPoll();
      });
      await started;
      release();
      await page.evaluate(() => Promise.all([window.firstPoll, window.secondPoll]));
      assert.equal(requests, 1, "interval ticks cannot pile up status requests");
      await terminal(page, "complete");
    } finally { release(); }
  });
});

for (const outcome of ["running", "failure"]) {
  test(`cancelled download ignores an older ${outcome} status response`, { timeout: 30000 }, async () => {
    await withDownloadPage(async (page) => {
      const held = await holdStatus(page, outcome === "failure");
      try {
        await begin(page);
        await page.evaluate(() => { window.pendingPoll = refreshModelDownload(); });
        await held.started;
        await page.locator("#modelDownloadCancel").click();
        await page.waitForFunction(() => !document.querySelector("#modelDownloadClose").disabled);
        held.release(); await page.evaluate(() => window.pendingPoll);
        await terminal(page, "cancelled");
        await page.locator("#modelDownloadClose").click();
        await page.locator('[data-model-download="sam"]').click();
        assert.equal(await page.locator("#modelDownloadStart").isVisible(), true, "a new download can be started after cancellation");
      } finally { held.release(); }
    });
  });
}

test("a previous progress response cannot replace a new completed download", { timeout: 30000 }, async () => {
  await withDownloadPage(async (page) => {
    const held = await holdStatus(page);
    try {
      await begin(page);
      await page.evaluate(() => { window.pendingPoll = refreshModelDownload(); });
      await held.started;
      await page.locator("#modelDownloadCancel").click();
      await page.waitForFunction(() => !document.querySelector("#modelDownloadClose").disabled);
      await page.locator("#modelDownloadClose").click();
      await page.locator('[data-model-download="sam"]').click();
      await page.route("**/api/model-download/start", (route) => reply(route, "complete"));
      await page.locator("#modelDownloadStart").click();
      await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent === t("modelDownload.complete"));
      held.release(); await page.evaluate(() => window.pendingPoll);
      await terminal(page, "complete");
    } finally { held.release(); }
  });
});

test("a delayed start response cannot replace a reopened confirmation", { timeout: 30000 }, async () => {
  await withDownloadPage(async (page) => {
    let release; let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { reached = resolve; });
    await page.route("**/api/model-download/start", async (route) => { reached(); await gate; await reply(route, "running"); });
    try {
      await page.locator("#modelDownloadStart").click(); await started;
      await page.locator("#modelDownloadClose").click();
      await page.locator('[data-model-download="sam"]').click();
      const finished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/model-download/start");
      release(); await (await finished).finished();
      // Evaluate after the response body has been consumed by the real API client.
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.locator("#modelDownloadStart").isVisible(), true);
      assert.equal(await page.locator("#modelDownloadClose").isEnabled(), true);
      assert.equal(await page.evaluate(() => window.modelPollCount()), 0);
    } finally { release(); }
  });
});

test("a current progress error restores close and stops polling", { timeout: 30000 }, async () => {
  await withDownloadPage(async (page) => {
    const held = await holdStatus(page, true);
    try {
      await begin(page);
      await page.evaluate(() => { window.pendingPoll = refreshModelDownload(); });
      await held.started; held.release(); await page.evaluate(() => window.pendingPoll);
      await page.locator("#errorDialog").waitFor({ state: "visible" });
      await page.locator("#errorDialog button").last().click();
      assert.equal(await page.locator("#modelDownloadClose").isEnabled(), true);
      assert.equal(await page.locator("#modelDownloadCancel").isVisible(), false);
      assert.equal(await page.evaluate(() => window.modelPollCount()), 0);
    } finally { held.release(); }
  });
});
