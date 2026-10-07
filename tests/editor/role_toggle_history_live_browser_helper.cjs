"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");

async function main() {
  const [origin, mode] = process.argv.slice(2);
  const boundary = mode.startsWith("boundary");
  const pending = mode.includes("pending");
  const padding = mode.includes("padding");
  const individual = mode.startsWith("individual");
  const candidateOnly = ["candidate", "individual", "forced"].includes(mode);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let releaseUpload = () => {};
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let batchRequests = 0;
    page.on("request", (request) => { if (request.method() === "POST" && /^\/api\/(?:candidates?\/|boundary$)/.test(new URL(request.url()).pathname)) batchRequests++; });
    const select = async () => {
      await page.waitForFunction(() => state.settings && state.images.length === 1);
      await page.locator(".gallery-item").click();
      await page.waitForFunction(() => state.currentImage && !state.pendingImageId && hasDurableHistory());
    };
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await select();
    const flush = () => page.evaluate(async () => { await flushWorkspaceDraft(state.currentId); await refreshProjectHistory(state.currentId); });
    const paint = async (tool, x, size) => {
      await page.locator(tool).click();
      await page.locator("#brushSize").fill(String(size));
      await page.locator("#brushSize").dispatchEvent("input");
      const point = await page.evaluate((x) => {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + state.view.x + x * state.view.scale, y: rect.top + state.view.y + 30 * state.view.scale };
      }, x);
      await page.mouse.click(point.x, point.y);
    };
    let uploadStarted;
    if (pending) {
      let started;
      uploadStarted = new Promise((resolve) => { started = resolve; });
      const gate = new Promise((resolve) => { releaseUpload = resolve; });
      let first = true;
      await page.route("**/api/workspace/manual/*/commit", async (route) => {
        if (first) { first = false; started(); await gate; }
        await route.continue();
      });
    }
    if (!candidateOnly) {
      await paint("#brushTool", 40, 12);
      if (pending) await uploadStarted;
      else await flush();
    }
    if (mode === "exclude") {
      await paint("#eraserTool", 40, 12); await flush();
      await paint("#excludeEraserTool", 44, 4); await flush();
    }
    if (boundary) {
      await page.locator("#boundaryTool").click();
      await page.locator("#rectangleTool").click();
      const [from, to] = await page.evaluate(() => {
        const rect = canvas.getBoundingClientRect();
        return [[5, 5], [15, 15]].map(([x, y]) => ({ x: rect.left + state.view.x + x * state.view.scale, y: rect.top + state.view.y + y * state.view.scale }));
      });
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.up();
    }
    const role = ["exclude", "forced"].includes(mode) ? "exclude" : "apply";
    const snapshot = () => page.evaluate((role) => {
      flushMaskComposition();
      return {
        padding: state.candidates.filter((item) => item.role === role).map((item) => item.expandPx || 0),
        forced: state.candidates.filter((item) => item.role === role).map((item) => item.forced),
        enabled: state.candidates.filter((item) => item.role === role).map((item) => item.enabled),
        manual: role === "apply" ? [state.manualEnabled] : [state.manualExclusionEnabled, state.manualExclusionEraseEnabled],
        pixels: [[9, 9], [13, 9], [40, 30], [44, 30]].map(([x, y]) => combinedCtx.getImageData(x, y, 1, 1).data[3]),
      };
    }, role);
    const before = await snapshot();
    const toggle = page.locator(boundary ? "#boundaryDetectButton" : padding ? (mode.startsWith("single") ? ".candidate-row-apply .candidate-padding-button" : '[data-candidate-padding-batch="apply"]')
      : individual ? ".candidate-row-apply .candidate-toggle"
      : mode === "forced" ? ".candidate-row-exclude .candidate-forced" : `[data-candidate-batch="${role}:toggle"]`);
    if (mode === "failure") {
      let fail = true;
      await page.route("**/api/candidates/batch", async (route) => {
        if (fail) { fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", errorCode: "internal_error" }) }); }
        else await route.continue();
      });
      await toggle.click();
      await expect(page.locator("#errorDialog")).toBeVisible();
      await page.locator("#errorDialogClose").click();
      await expect(toggle).toBeEnabled();
      assert.deepEqual(await snapshot(), before, "failed batch leaves both candidate and manual state intact");
    }
    await toggle.click();
    if (padding) {
      await page.locator("#candidatePaddingInput").fill("2");
      await page.locator("#candidatePaddingConfirm").click();
    }
    if (pending) {
      await page.waitForFunction(() => state.boundaryPending || candidateControlLocked(state.currentId));
      assert.equal(batchRequests, 0, "role mutation waits for the pending stroke commit");
      releaseUpload();
    }
    if (boundary) await page.waitForFunction(() => !state.boundaryPending && state.candidates.length === 2);
    else await expect(toggle).toBeEnabled();
    await flush();
    const disabled = await snapshot();
    if (boundary) assert.equal(disabled.enabled.length, 2);
    else if (padding) assert.ok(disabled.padding.every((value) => value === 2));
    else assert.ok((mode === "forced" ? disabled.forced : disabled.enabled).every((enabled) => !enabled));
    if (!candidateOnly && !individual && !padding && !boundary) assert.ok(disabled.manual.every((enabled) => !enabled));
    if (mode !== "forced") assert.notDeepEqual(disabled.pixels, before.pixels, "the actual composed mask changes");
    const history = async (direction, expected) => {
      await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
      await expect.poll(snapshot).toEqual(expected);
      await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId);
      if (!boundary) await expect(toggle).toBeEnabled();
      await expect(page.locator("#errorDialog")).not.toBeVisible();
    };
    await history("undo", before);
    await history("redo", disabled);
    await page.reload({ waitUntil: "domcontentloaded" }); await select();
    assert.deepEqual(await snapshot(), disabled, "reload retains the whole role state");
    await history("undo", before);
    await history("redo", disabled);
    await history("undo", before);
    if (!candidateOnly) {
      // A subsequent stroke uses the acknowledged manual revision and has its own Undo.
      await paint("#brushTool", 54, 3); await flush();
      await page.locator("#undoButton").click();
      await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId);
      assert.equal(await page.evaluate(() => addCtx.getImageData(54, 30, 1, 1).data[3]), 0);
      assert.deepEqual(await snapshot(), before);
    }
    assert.deepEqual(errors, []);
  } finally {
    releaseUpload();
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
