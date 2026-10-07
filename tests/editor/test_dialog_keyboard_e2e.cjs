"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { appendBrowserCoverage, closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

async function withEditor(run) {
  let fixture, browser, context, page;
  let coverageStarted = false;
  try {
    fixture = await startFixtureServer();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    if (process.env.MOZARIE_JS_COVERAGE === "1") {
      await page.coverage.startJSCoverage({ resetOnNavigation: false }); coverageStarted = true;
    }
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 80;
      canvas.getContext("2d").fillRect(0, 0, 100, 80);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.route(/\/api\/image\/sample(?:\?|$)/, (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
    const boundaryRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/boundary") boundaryRequests.push(request.postDataJSON());
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage && !currentImageActionPending());
    await run({ fixture, page, boundaryRequests });
  } finally {
    try {
      if (coverageStarted) {
        const entries = await page.coverage.stopJSCoverage();
        if (process.env.MOZARIE_BROWSER_COVERAGE_FILE) await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, entries);
      }
    } finally {
      try { await context?.close(); }
      finally {
        try { await browser?.close(); }
        finally { if (fixture) await closeServer(fixture.server); }
      }
    }
  }
}

async function drawRectangle(page) {
  await page.locator("#boundaryTool").click();
  await page.locator("#rectangleTool").click();
  const points = await page.evaluate(() => {
    const rect = canvas.getBoundingClientRect();
    return [{ x: 20, y: 20 }, { x: 60, y: 50 }].map(({ x, y }) => ({
      x: rect.left + state.view.x + x * state.view.scale,
      y: rect.top + state.view.y + y * state.view.scale,
    }));
  });
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 3 }); await page.mouse.up();
  await page.waitForFunction(() => state.boundaryDrafts.length === 1 && canDetectBoundary());
  return page.evaluate(() => structuredClone(state.boundaryDrafts));
}

async function openRename(page) {
  await page.locator('.gallery-item[data-id="sample"]').press("F2");
  await page.locator("#renameImageDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement.id === "renameImageFilename");
}

test("rename Enter submits only the dialog and Escape preserves the pending boundary", { timeout: 30000 }, () => withEditor(async ({ page, fixture, boundaryRequests }) => {
  const draft = await drawRectangle(page);
  await openRename(page);
  await page.locator("#renameImageFilename").fill("renamed.png");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("#renameImageDialog").open && !state.renamePending && currentRecord().editedFilename === "renamed.png");
  assert.equal(fixture.renameRequests.length, 1);
  assert.equal(fixture.renameRequests[0].filename, "renamed.png");
  assert.equal(boundaryRequests.length, 0);
  assert.deepEqual(await page.evaluate(() => state.boundaryDrafts), draft);
  await openRename(page);
  await page.locator("#renameImageFilename").fill("cancelled.png");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#renameImageDialog").open);
  assert.equal(fixture.renameRequests.length, 1);
  assert.equal(await page.evaluate(() => currentRecord().editedFilename), "renamed.png");
  assert.equal(boundaryRequests.length, 0);
  assert.deepEqual(await page.evaluate(() => state.boundaryDrafts), draft);
}));

test("boundary Cancel button Enter cancels while canvas Enter detects and Escape cancels", { timeout: 30000 }, () => withEditor(async ({ page, boundaryRequests }) => {
  await drawRectangle(page);
  await page.locator("#boundaryCancelButton").press("Enter");
  await page.waitForFunction(() => !hasBoundaryDraft());
  assert.equal(boundaryRequests.length, 0, "native Cancel activation must not run detection");
  await drawRectangle(page);
  await page.locator("#editorCanvas").press("Escape");
  assert.equal(await page.evaluate(() => hasBoundaryDraft()), false);
  assert.equal(boundaryRequests.length, 0);
  await drawRectangle(page);
  await page.locator("#editorCanvas").press("Enter");
  await page.waitForFunction(() => !hasBoundaryDraft() && !state.boundaryPending && state.candidates.length === 1);
  assert.equal(boundaryRequests.length, 1);
  assert.equal(boundaryRequests[0].imageId, "sample");
}));

test("a consumed Enter does not trigger a pending boundary action", { timeout: 30000 }, () => withEditor(async ({ page, boundaryRequests }) => {
  const draft = await drawRectangle(page);
  await page.locator("#editorCanvas").evaluate((element) => {
    element.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  });
  await page.locator("#editorCanvas").press("Enter");
  assert.deepEqual(await page.evaluate(() => state.boundaryDrafts), draft);
  assert.equal(boundaryRequests.length, 0);
}));
