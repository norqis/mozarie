"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function main() {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await browserContext.newPage();
  try {
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      window.__splitWrites = 0;
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "mozarie.compareSplit") window.__splitWrites += 1;
        return originalSetItem.call(this, key, value);
      };
    });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.locator(".gallery-item").first().click();

    const tolerancePanel = page.locator("#bucketToleranceControl");
    const toleranceInput = page.locator("#bucketTolerance");
    const openTolerance = async () => {
      await page.locator("#bucketTool").click();
      assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), true, "fill tolerance can be reopened");
    };
    const saveTolerance = async (value) => {
      await toleranceInput.evaluate((input, next) => { input.value = next; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }, value);
      await page.waitForFunction((next) => state.settings.editing.fill_color_tolerance === next, Number(value));
    };
    await openTolerance(); await page.locator("#bucketToleranceClose").click();
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), false, "the X closes fill tolerance");
    await openTolerance(); await page.locator("#bucketTool").click();
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), false, "pressing the active fill tool again closes tolerance");
    await openTolerance(); await page.keyboard.press("Escape");
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), false, "Escape closes fill tolerance");
    await openTolerance(); await page.locator("#currentFileName").click();
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), false, "clicking the background closes fill tolerance");
    await openTolerance(); await saveTolerance("35"); await page.locator("#excludeBucketTool").click();
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), true, "switching fill tools moves and keeps tolerance open");
    assert.deepEqual(await page.evaluate(() => [$("#bucketTool").getAttribute("aria-expanded"), $("#excludeBucketTool").getAttribute("aria-expanded")]), ["false", "true"], "ARIA follows the open fill tool");
    await saveTolerance("36");
    await page.locator("#brushTool").click();
    assert.equal(await tolerancePanel.evaluate((node) => node.matches(":popover-open")), false, "switching to another tool closes tolerance");
    await page.reload({ waitUntil: "networkidle" }); await page.locator(".gallery-item").first().click();
    assert.equal(await toleranceInput.inputValue(), "36", "the shared tolerance changed from exclusion fill survives a reload");
    await openTolerance(); assert.equal(await toleranceInput.inputValue(), "36", "reopening shows the immediately saved shared tolerance");
    await page.locator("#bucketToleranceClose").click();

    const canvasBox = await page.locator("#editorCanvas").boundingBox();
    const fillPoint = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    const maskBeforeExcludeFill = await page.evaluate(() => ({ add: addCanvas.toDataURL(), manualMaskPresent: state.manualMaskPresent, history: state.history.length }));
    await page.locator("#excludeBucketTool").click();
    await page.locator("#bucketToleranceClose").click();
    await page.mouse.move(fillPoint.x, fillPoint.y); await page.mouse.down(); await page.mouse.move(fillPoint.x + 20, fillPoint.y + 10); await page.mouse.up();
    await page.waitForFunction((count) => state.history.length === count + 1 && canvasHasPixels(exclusionCtx, exclusionCanvas), maskBeforeExcludeFill.history);
    assert.deepEqual(await page.evaluate(() => ({ add: addCanvas.toDataURL(), manualMaskPresent: state.manualMaskPresent, tool: state.history.at(-1)?.tool })), { add: maskBeforeExcludeFill.add, manualMaskPresent: maskBeforeExcludeFill.manualMaskPresent, tool: "exclude_bucket" }, "exclude fill drag records once and leaves the mosaic layer and its presence flag byte-for-byte unchanged");
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !canvasHasPixels(exclusionCtx, exclusionCanvas));
    assert.equal(await page.evaluate((before) => addCanvas.toDataURL() === before, maskBeforeExcludeFill.add), true, "undoing exclude fill leaves the mosaic layer unchanged");
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => canvasHasPixels(exclusionCtx, exclusionCanvas));
    assert.equal(await page.evaluate((before) => addCanvas.toDataURL() === before, maskBeforeExcludeFill.add), true, "redoing exclude fill restores only the exclusion layer");
    await page.locator("#undoButton").click(); await page.waitForFunction(() => !canvasHasPixels(exclusionCtx, exclusionCanvas));

    await page.locator("#compareViewButton").click();
    const compareCanvas = await page.locator("#editorCanvas").boundingBox();
    for (const fraction of [.25, .75]) {
      await page.mouse.click(compareCanvas.x + compareCanvas.width * fraction, compareCanvas.y + compareCanvas.height / 2);
      await page.waitForFunction(() => canvasHasPixels(exclusionCtx, exclusionCanvas));
      assert.equal(await page.evaluate((before) => addCanvas.toDataURL() === before && !state.manualMaskPresent, maskBeforeExcludeFill.add), true, `exclude fill from either compare pane changes only exclusion (${fraction})`);
      await page.locator("#undoButton").click(); await page.waitForFunction(() => !canvasHasPixels(exclusionCtx, exclusionCanvas));
    }

    const canvas = await page.locator("#editorCanvas").boundingBox();
    const splitter = page.locator("#compareSplitter");
    const handle = await splitter.boundingBox();
    const viewBefore = await page.evaluate(() => ({ ...state.view }));
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    assert.equal(await splitter.evaluate((node) => node.classList.contains("dragging")), true, "a live pointer drag exposes its visual state");
    for (let index = 0; index < 200; index += 1) {
      await page.mouse.move(canvas.x + canvas.width * (.25 + (index % 20) / 100), handle.y + handle.height / 2);
    }
    assert.equal(await page.evaluate(() => window.__splitWrites), 0, "drag frames never write storage");
    assert.deepEqual(await page.evaluate(() => ({ ...state.view })), viewBefore, "split dragging preserves zoom and pan");
    await page.mouse.move(canvas.x + canvas.width * .37, handle.y + handle.height / 2);
    await page.mouse.up();
    assert.equal(await splitter.evaluate((node) => node.classList.contains("dragging")), false, "pointerup clears the drag visual state");
    assert.equal(await page.evaluate(() => window.__splitWrites), 1, "pointerup persists the final ratio once");
    assert.equal(await splitter.getAttribute("aria-valuenow"), "37", "pointerup flushes the final pointer coordinate");
    const panes = await page.evaluate(() => comparePaneBounds());
    assert.equal(panes.every((pane) => pane.width >= 160), true, "both live panes respect the 160px minimum");

    await splitter.focus();
    const writesBeforeKey = await page.evaluate(() => window.__splitWrites);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate((before) => window.__splitWrites === before + 1, writesBeforeKey), true, "a keyboard adjustment persists once");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Home");
    assert.equal(await splitter.getAttribute("aria-valuenow"), await splitter.getAttribute("aria-valuemin"), "Home uses the dynamic minimum");
    await page.keyboard.press("End");
    assert.equal(await splitter.getAttribute("aria-valuenow"), await splitter.getAttribute("aria-valuemax"), "End uses the dynamic maximum");
    await splitter.dblclick();
    assert.equal(await splitter.getAttribute("aria-valuenow"), "50", "double-click restores 50/50");

    const splitAfterReset = await splitter.boundingBox();
    await page.mouse.move(splitAfterReset.x + splitAfterReset.width / 2, splitAfterReset.y + splitAfterReset.height / 2);
    await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width * .39, splitAfterReset.y + splitAfterReset.height / 2); await page.mouse.up();
    assert.equal(await splitter.getAttribute("aria-valuenow"), "39");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("#compareSplitter").getAttribute("aria-valuenow"), "39", "reload restores the persisted and clamped ratio");

    const narrow = await page.evaluate(() => {
      const grid = document.querySelector(".studio-grid");
      grid.style.gridTemplateColumns = "40px 300px 40px";
      state.displayMode = "compare"; resizeRenderCanvas(); updateCompareSplitter();
      const separator = document.querySelector("#compareSplitter");
      return { width: stage.clientWidth, disabled: separator.getAttribute("aria-disabled"), value: separator.getAttribute("aria-valuenow") };
    });
    assert.deepEqual(narrow, { width: 300, disabled: "true", value: "50" }, "a sub-320px stage is fixed at an accessible 50/50 split");
  } finally {
    await browserContext.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
}

main().then(() => console.log("test_padding_splitter_e2e: passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
