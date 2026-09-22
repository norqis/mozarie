"use strict";

// This deliberately runs outside coverage.  The ordinary frontend runner
// invokes it once after the coverage-friendly suite, so the 20k catalogue is
// exercised without instrumenting or repeating the larger browser scenario.
const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function runGalleryPerformanceScenario() {
  let browser;
  let server;
  let url;
  let setCatalog;
  let resetScenario;
  try {
    ({ server, url, setCatalog, resetScenario } = await startFixtureServer());
    setCatalog(Array.from({ length: 20000 }, (_, index) => ({
      id: `performance-${index}`,
      relativePath: `set-${String(index % 40).padStart(2, "0")}/image-${String(index).padStart(5, "0")}.png`,
      sourceKind: "fixture", width: 100, height: 80,
      candidateCount: 0, enabledCandidateCount: 0, reviewed: index % 2 === 0,
    })));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const fullImageRequests = [];
    page.on("request", (request) => { if (/\/api\/image\//.test(new URL(request.url()).pathname)) fullImageRequests.push(request.url()); });
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    try {
      const catalogResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/images" && response.status() === 200);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await catalogResponse;
      const renderStart = performance.now();
      await page.waitForFunction(() => state.images.length === 20000 && document.querySelectorAll(".gallery-item").length > 0);
      const renderElapsed = performance.now() - renderStart;
      const mounted = await page.locator(".gallery-item, .overview-item").count();
      assert.ok(renderElapsed <= 2000, `20k catalogue renders after its API response within the extreme-regression budget (actual ${renderElapsed.toFixed(1)}ms)`);
      assert.ok(mounted < 2000, `20k catalogue keeps mounted cards below the structural virtualization limit (actual ${mounted})`);
      const timings = [];
      const mountedSamples = [mounted];
      const decodedCacheSamples = [];
      for (let index = 0; index < 10; index += 1) {
        let started = performance.now();
        await page.locator("#overviewButton").click();
        await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
        timings.push(performance.now() - started);
        started = performance.now();
        await page.locator("#closeOverviewButton").click();
        await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
        timings.push(performance.now() - started);
        started = performance.now();
        const filter = index % 2 ? "reviewed" : "unreviewed";
        await page.locator("#galleryFilterButton").click();
        for (const input of await page.locator("[data-gallery-filter]:checked").all()) await input.uncheck();
        await page.locator(`[data-gallery-filter="${filter}"]`).check();
        await page.waitForFunction((value) => state.galleryFilter instanceof Set && state.galleryFilter.size === 1 && state.galleryFilter.has(value), filter);
        await page.locator("#galleryFilterButton").click();
        timings.push(performance.now() - started);
        mountedSamples.push(await page.locator(".gallery-item, .overview-item").count());
        decodedCacheSamples.push(await page.evaluate(() => state.imageCache?.items?.size || 0));
      }
      const p95 = [...timings].sort((left, right) => left - right)[Math.ceil(timings.length * 0.95) - 1];
      assert.ok(p95 <= 500, `gallery state changes stay within the extreme-regression p95 budget (actual ${p95.toFixed(1)}ms)`);
      assert.ok(Math.max(...mountedSamples) < 2000, "repeated filtering and view switches keep the mounted DOM window bounded");
      assert.ok(Math.max(...decodedCacheSamples) <= 3, "repeated filtering and view switches keep decoded full-size image ownership bounded");
      assert.ok(fullImageRequests.length <= 3, `catalogue switches do not refetch all 20k full-size images (actual ${fullImageRequests.length})`);
      console.log(`browser performance: 20k app-render=${renderElapsed.toFixed(1)}ms mounted=${mounted} switch-filter-p95=${p95.toFixed(1)}ms`);
    } finally {
      await context.close();
      resetScenario();
    }
  } finally {
    await browser?.close();
    if (server) await closeServer(server);
  }
}

nodeTest("20k gallery DOM decoded cache and full-image requests stay bounded", runGalleryPerformanceScenario);
