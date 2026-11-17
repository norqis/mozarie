"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const [origin, mode, rawIds] = process.argv.slice(2);
const ids = JSON.parse(rawIds);
const tools = "[data-toolbar-item]:not(#undoButton):not(#redoButton), #rectangleTool, #polygonTool, #boundaryBrushTool, #brushSize, #bucketTolerance";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 4 && !state.catalogTransition);
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="unreviewed"]').check();
    await page.locator("#galleryFilterButton").click();
    const ready = async (imageId) => {
      await page.waitForFunction((id) => state.currentId === id && state.currentImage && !state.catalogMutation && !currentImageActionPending(), imageId);
      const disabledTools = await page.locator(tools).evaluateAll((controls) => controls.filter((control) => control.disabled).map((control) => control.id));
      assert.deepEqual(disabledTools, [], `all editor tools recover for the new image: ${JSON.stringify(disabledTools)}`);
      const rows = page.locator(".candidate-row button");
      assert.ok(await rows.count() >= 20, "automatic apply/exclude and all three manual layers are present");
      assert.deepEqual(await rows.evaluateAll((controls) => controls.filter((control) => control.disabled).map((control) => control.outerHTML)), [], "automatic and manual candidate controls recover after deletion");
      const bulk = page.locator("[data-candidate-batch], [data-candidate-padding-batch], [data-candidate-display-toggle], [data-candidate-effective-toggle]");
      assert.deepEqual(await bulk.evaluateAll((controls) => controls.filter((control) => control.disabled).map((control) => control.outerHTML)), [], "both roles' bulk controls recover");
      assert.equal(await page.locator("#editorCanvas").getAttribute("aria-disabled"), "false");
    };
    await page.locator(`.gallery-item[data-id="${ids["a.png"]}"]`).click();
    await ready(ids["a.png"]);
    const remove = async (targetId, hold = false) => {
      let release; let reached;
      const held = new Promise((resolve) => { reached = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const endpoint = mode === "source" ? "**/api/catalog/delete-source" : "**/api/catalog/remove";
      if (hold) await page.route(endpoint, async (route) => {
        const response = await route.fetch(); reached(); await gate;
        await route.fulfill({ response });
      });
      try {
        await page.locator(mode === "source" ? "#removeAndNextButton" : "#removeFromListButton").click();
        if (mode === "source") await page.locator("#confirmAccept").click();
        if (hold) {
          await held;
          assert.equal(await page.evaluate(() => state.catalogMutation), true);
          assert.equal(await page.locator(tools).evaluateAll((controls) => controls.every((control) => control.disabled)), true);
          assert.equal(await page.locator(".candidate-row button").evaluateAll((controls) => controls.every((control) => control.disabled)), true);
          release();
        }
        await page.waitForFunction((id) => !state.catalogMutation && !state.images.some((image) => image.id === id), targetId);
      } finally {
        release();
        if (hold) await page.unroute(endpoint);
      }
    };
    await remove(ids["a.png"], true);
    await ready(ids["c.png"]);
    // These clicks must reach the actual candidate/manual operation, not just look enabled.
    await page.locator('.candidate-row-apply .candidate-toggle').click();
    await page.waitForFunction(() => state.candidates.find((candidate) => candidate.id === "apply").enabled === false && !candidateControlLocked(state.currentId));
    const candidate = await page.evaluate(async () => (await api(`/api/candidates/${state.currentId}`)).candidates.find((item) => item.id === "apply"));
    assert.equal(candidate.enabled, false);
    await page.locator('.candidate-row-manual-exclude .candidate-toggle').click();
    await page.waitForFunction(() => !state.manualExclusionEnabled && !currentImageActionPending());
    await page.locator("#eraserTool").click();
    assert.equal(await page.evaluate(() => state.tool), "eraser");
    await page.locator(`.gallery-item[data-id="${ids["d.png"]}"]`).click();
    await ready(ids["d.png"]);
    await remove(ids["d.png"]);
    await ready(ids["c.png"]);
    await remove(ids["c.png"]);
    await page.waitForFunction(() => !state.currentId && !state.currentImage && !state.catalogMutation);
    assert.equal(await page.locator(".gallery-item").count(), 0, "the reviewed image never enters filtered deletion navigation");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), [ids["b.png"]]);
    assert.equal(await page.locator("#brushTool").isDisabled(), true);
    assert.equal(await page.locator("#eraserTool").isDisabled(), true);
    assert.equal(await page.locator(".candidate-row").count(), 0);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false);
  } finally {
    await context.close(); await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
