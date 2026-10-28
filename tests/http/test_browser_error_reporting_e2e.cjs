"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");
const { waitForAppStartup } = require("../helpers/app_startup.cjs");

test("single copy respects server preflight conflicts before render", { timeout: 30000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route("**/api/save/prepare", (route) => route.fulfill({ json: {
      entries: [{ imageId: "image-1", relativePath: "source.png", candidateRevision: 0 }], conflicts: ["existing.jpg"],
    } }));
    const writes = [];
    page.on("request", (request) => { if (/\/api\/save\/(render|reserve)$/.test(request.url())) writes.push(request.url()); });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await waitForAppStartup(page);
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    await page.locator("#saveButton").click();
    await page.locator("#singleSaveCopyMode").check();
    await page.locator("#singleSaveStartButton").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#errorDialogCause").textContent(), /existing\.jpg/);
    assert.deepEqual(writes, []);
  } finally {
    await browser?.close();
    await closeServer(fixture.server);
  }
});

test("displayed and uncaught browser errors report original details without recursive failures", { timeout: 30000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const reports = [];
    await page.route("**/api/client-error", async (route) => {
      reports.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await waitForAppStartup(page);
    const emit = async (action) => {
      const response = page.waitForResponse("**/api/client-error");
      await page.evaluate(action);
      await response;
    };
    await emit(async () => {
      try {
        await writeSourceHandle({ fileHandle: { createWritable: async () => { throw new DOMException("original writer lock message", "NoModificationAllowedError"); } } }, new Response("test"));
      } catch (error) { showUserError(error); }
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].cause.message, "original writer lock message");
    assert.equal(reports[0].cause.name, "NoModificationAllowedError");
    assert.equal(reports[0].phase, "create_source_writer");
    assert.equal(reports[0].displayedCause, await page.locator("#errorDialogCause").textContent());
    assert.equal(reports[0].action, await page.locator("#errorDialogAction").textContent());
    assert.equal(reports[0].path, "/");
    assert.ok(!JSON.stringify(reports[0]).includes("mozarie-token"));
    await emit(() => {
      state.images.push({ id: "failed-entry", relativePath: "failed.jpg", sourceKind: "session" });
      document.querySelector("#applyDialog").showModal();
      document.querySelector("#applyOverwriteMode").checked = true;
      document.querySelector("#applyOutputFormat").value = "jpg";
      const error = codedError("output_files_exist", { files: "failed.jpg" });
      error.imageId = "failed-entry"; error.savePhase = "check_output_target";
      showUserError(error);
    });
    const batchError = reports.at(-1);
    assert.equal(batchError.imageId, "failed-entry");
    assert.equal(batchError.image, "failed.jpg");
    assert.equal(batchError.saveMode, "overwrite");
    assert.equal(batchError.format, "jpg");
    await page.evaluate(() => { document.querySelector("#applyDialog").close(); });
    await emit(() => { showUserError(codedError("connection_lost")); });
    await page.waitForFunction(() => state.status.connectionFailure);
    await emit(() => { window.dispatchEvent(new ErrorEvent("error", { error: new Error("uncaught script failure") })); });
    await emit(() => { window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("uncaught rejection") })); });
    assert.equal(reports.filter((report) => report.code === "connection_lost").length, 1);
    assert.ok(reports.some((report) => report.source === "error" && report.message === "uncaught script failure"));
    assert.ok(reports.some((report) => report.source === "unhandledrejection" && report.message === "uncaught rejection"));
    await page.unroute("**/api/client-error");
    let failures = 0;
    await page.route("**/api/client-error", (route) => { failures++; return route.abort("failed"); });
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request.url().endsWith("/api/client-error") });
    await page.evaluate(() => { showUserError(codedError("save_write_failed")); });
    await failed;
    await page.evaluate(() => Promise.resolve());
    assert.equal(failures, 1);
    assert.equal(await page.locator("#errorDialogCause").textContent(), await page.evaluate(() => t("errorDialog.save_write_failed.cause")));
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = () => { throw new TypeError("logging transport unavailable"); };
      try { showUserError(codedError("source_permission_denied")); }
      finally { window.fetch = originalFetch; }
    });
    assert.equal(await page.locator("#errorDialogCause").textContent(), await page.evaluate(() => t("errorDialog.source_permission_denied.cause")));
  } finally {
    await browser?.close();
    await closeServer(fixture.server);
  }
});
