"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const [origin, direction, outcome] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let releaseUpload = () => {};
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    const ids = await page.evaluate(() => Object.fromEntries(state.images.map((image) => [image.relativePath, image.id])));
    const select = async (id) => {
      await page.locator(`.gallery-item[data-id="${id}"]`).click();
      await page.waitForFunction((value) => state.currentId === value && state.currentImage && !state.pendingImageId, id);
    };
    await select(ids["other.png"]);
    let reached;
    const started = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { releaseUpload = resolve; });
    let first = true;
    await page.route(`**/api/workspace/manual/${ids["other.png"]}/commit`, async (route) => {
      if (first) {
        first = false; reached(); await gate;
        if (outcome === "failure") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary failure", code: "internal_error" }) });
      }
      await route.continue();
    });
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("3");
    await page.locator("#brushSize").dispatchEvent("input");
    const point = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + state.view.x + 35 * state.view.scale, y: rect.top + state.view.y + 25 * state.view.scale };
    });
    await page.mouse.click(point.x, point.y);
    await started;
    await select(ids["gesture.png"]);
    await page.waitForFunction((value) => state.projectHistory.get(state.currentId)?.[value === "undo" ? "canUndo" : "canRedo"], direction);
    const historyPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/project\/history\/.*\/(undo|redo)$/.test(new URL(request.url()).pathname)) historyPosts.push(request.url());
    });
    await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
    assert.equal(await page.evaluate((id) => state.drafts.has(id), ids["other.png"]), true, "a group history action retains the other image's pending draft");
    releaseUpload();
    await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId && state.workspaceDraftChains.size === 0);
    if (outcome === "failure") {
      await page.locator("#errorDialog").waitFor({ state: "visible" });
      assert.equal(await page.evaluate((id) => state.drafts.has(id) && state.workspaceMutationErrors.has(id), ids["other.png"]), true, "a failed upload remains retryable before any group history change");
      await page.locator("#errorDialog button").last().click();
      await page.evaluate(() => flushAllWorkspaceMutations());
    }
    assert.deepEqual(historyPosts, [], "a failed save or newer edit on another group member prevents the old group action");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.reviewed)), [direction === "undo", direction === "undo"], "the group flags are unchanged");
    await select(ids["other.png"]);
    assert.equal(await page.evaluate(() => addCtx.getImageData(35, 25, 1, 1).data[3]), 255, "the pending stroke survives revisiting the other image");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await select(ids["other.png"]);
    assert.equal(await page.evaluate(() => addCtx.getImageData(35, 25, 1, 1).data[3]), 255, "the recovered stroke survives a fresh page and real SQLite reload");
  } finally {
    releaseUpload();
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
