"use strict";

// Launched by the Python unittest fixture so every gesture crosses the real
// browser, HTTP handler, StudioState, SQLite workspace and PNG renderer.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const [origin] = process.argv.slice(2);

async function imagePoint(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + state.view.x + x * state.view.scale, y: rect.top + state.view.y + y * state.view.scale };
  }, { x, y });
}

async function clickImage(page, x, y) {
  const point = await imagePoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}

async function dragImage(page, from, to) {
  const start = await imagePoint(page, from.x, from.y);
  const end = await imagePoint(page, to.x, to.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

async function flushGesture(page) {
  await page.evaluate(async () => {
    await flushWorkspaceDraft(state.currentId);
    await refreshProjectHistory(state.currentId);
  });
  await page.waitForFunction(() => !state.draftDirty && !state.draftSaveChains.has(state.currentId)
    && !state.workspaceDraftTimers.has(state.currentId) && !state.workspaceDraftChains.has(state.currentId));
  assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "normal canvas gestures show no error dialog");
}

async function layerPixels(page) {
  return page.evaluate(() => {
    const alpha = (context, x, y) => context.getImageData(x, y, 1, 1).data[3];
    return {
      candidate: alpha(combinedCtx, 9, 9),
      paddingPreviewOnly: alpha(combinedCtx, 16, 10),
      erasedClick: alpha(combinedCtx, 48, 8),
      dragged: alpha(addCtx, 54, 30),
      excluded: alpha(combinedCtx, 41, 30),
      restored: alpha(combinedCtx, 47, 30),
      exclusion: alpha(exclusionCtx, 41, 30),
      exclusionErase: alpha(exclusionEraseCtx, 47, 30),
    };
  });
}

async function selectCurrentImage(page) {
  const item = page.locator(".gallery-item").first();
  const imageId = await item.getAttribute("data-id");
  assert.ok(imageId, "the named project has one source image");
  await item.click();
  try {
    await page.waitForFunction((expected) => state.currentId === expected && state.currentImage && hasDurableHistory(), imageId);
  } catch (error) {
    console.error("editor selection did not settle", await page.evaluate(() => ({
      currentId: state.currentId, currentImage: Boolean(state.currentImage), durable: hasDurableHistory(),
      pendingImageId: state.pendingImageId, imageAction: state.imageActionPending, projectOperationPending: state.projectOperationPending,
      errorOpen: document.querySelector("#errorDialog")?.open, status: state.status,
      gallery: [...document.querySelectorAll(".gallery-item")].map((node) => ({ id: node.dataset.id, disabled: node.disabled, selected: node.classList.contains("selected") })),
    })));
    throw error;
  }
  return imageId;
}

async function main() {
  assert.ok(origin, "usage: editor_gesture_live_browser_helper.cjs <origin>");
  const browser = await chromium.launch();
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const responses = [];
    const pageErrors = [];
    page.on("response", async (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/workspace/manual/") || path.startsWith("/api/project/history/") || path.startsWith("/api/save/")) {
        responses.push({ method: response.request().method(), path, status: response.status() });
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.project?.name === "gesture-project" && state.images.length === 1
      && Number.isSafeInteger(state.serverCatalogGeneration) && !document.querySelector("#errorDialog")?.open);
    const imageId = await selectCurrentImage(page);
    await page.locator("#brushSize").fill("4");
    await page.locator("#brushSize").dispatchEvent("input");

    const paddingButton = page.locator('[data-candidate-padding-id="candidate"]');
    await paddingButton.click();
    await page.locator("#candidatePaddingInput").fill("8");
    await page.locator("#candidatePaddingInput").dispatchEvent("input");
    await page.waitForFunction(() => state.candidatePaddingPreviewImages.size === 1 && document.querySelector("#candidatePaddingPopover").matches(":popover-open"));

    // The pointerdown closes an uncommitted padding preview. The same real
    // pointer sequence must still create one circular brush stamp.
    await clickImage(page, 48, 8);
    await flushGesture(page);
    assert.equal(await page.locator("#candidatePaddingPopover").isVisible(), false, "canvas input closes the padding preview");
    let pixels = await layerPixels(page);
    assert.ok(pixels.candidate > 0 && pixels.erasedClick > 0, "the committed candidate and clicked brush stamp are active");
    assert.equal(pixels.paddingPreviewOnly, 0, "the cancelled padding preview is removed before the brush ROI is composed");

    await page.locator("#brushTool").click();
    await dragImage(page, { x: 36, y: 30 }, { x: 56, y: 30 });
    await flushGesture(page);
    await page.locator("#mosaicEraserTool").click();
    await clickImage(page, 48, 8);
    await flushGesture(page);
    await page.locator("#eraserTool").click();
    await dragImage(page, { x: 40, y: 30 }, { x: 50, y: 30 });
    await flushGesture(page);
    await page.locator("#excludeEraserTool").click();
    await clickImage(page, 47, 30);
    await flushGesture(page);

    pixels = await layerPixels(page);
    assert.equal(pixels.erasedClick, 0, "mosaic eraser clears only the clicked stamp");
    assert.ok(pixels.dragged > 0 && pixels.exclusion > 0 && pixels.exclusionErase > 0, "drag, exclusion and exclusion erase reach their durable layers");
    assert.equal(pixels.excluded, 0, "forced exclusion removes the drag at a non-erased point");
    assert.ok(pixels.restored > 0, "exclusion erase restores the underlying mosaic");

    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !state.projectHistoryBusy && document.querySelector("#redoButton")?.disabled === false);
    assert.equal((await layerPixels(page)).restored, 0, "undo removes only the exclusion-erase gesture");
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => !state.projectHistoryBusy && document.querySelector("#redoButton")?.disabled === true);
    assert.ok((await layerPixels(page)).restored > 0, "redo restores the exclusion-erase gesture");

    const project = await page.evaluate(async () => {
      await flushAllImageMutations();
      await flushAllWorkspaceMutations();
      const current = { ...state.project };
      await catalogApi("/api/project/close", {}, { method: "POST" });
      resetCatalog([], ""); state.project = null; state.projectReadOnly = false; state.missingNativeSources = [];
      return current;
    });
    await page.evaluate((project) => openProject(project), project);
    await page.waitForFunction(() => state.project?.name === "gesture-project" && state.images.length === 1
      && state.historyDurable === true && !state.projectOperationPending);
    await selectCurrentImage(page);
    pixels = await layerPixels(page);
    assert.deepEqual(
      { candidate: pixels.candidate > 0, paddingPreviewOnly: pixels.paddingPreviewOnly, erasedClick: pixels.erasedClick, dragged: pixels.dragged > 0, excluded: pixels.excluded, restored: pixels.restored > 0 },
      { candidate: true, paddingPreviewOnly: 0, erasedClick: 0, dragged: true, excluded: 0, restored: true },
      "project reopen decodes the same localized SQLite PNG layers",
    );

    await page.locator("#brushTool").click();
    await dragImage(page, { x: 58, y: 42 }, { x: 62, y: 42 });
    await flushGesture(page);
    assert.ok(await page.evaluate(() => addCtx.getImageData(60, 42, 1, 1).data[3]) > 0, "the reopened project accepts a new real drag");
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !state.projectHistoryBusy && document.querySelector("#redoButton")?.disabled === false);
    assert.equal(await page.evaluate(() => addCtx.getImageData(60, 42, 1, 1).data[3]), 0, "durable undo remains active immediately after project open");

    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog")?.open && !document.querySelector("#singleSaveStartButton")?.disabled);
    await page.locator("#singleSaveSuffix").fill("_gesture");
    await page.locator("#singleSaveOutputFormat").selectOption("png");
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && document.querySelector("#singleSaveResult")?.textContent.trim().length > 0);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "saving the persisted gestures shows no error dialog");
    assert.equal(pageErrors.length, 0, `browser page errors: ${pageErrors.join(" | ")}`);

    const manualResponses = responses.filter((response) => response.path.startsWith("/api/workspace/manual/"));
    assert.ok(manualResponses.some((response) => response.method === "POST"), "real gestures upload manual PNG layers");
    assert.ok(manualResponses.every((response) => response.status >= 200 && response.status < 300), `manual workspace responses were accepted: ${JSON.stringify(manualResponses)}`);
    assert.ok(responses.some((response) => response.path.endsWith("/undo") && response.status === 200), "undo used the real history endpoint");
    assert.ok(responses.some((response) => response.path.endsWith("/redo") && response.status === 200), "redo used the real history endpoint");
    assert.ok(responses.some((response) => response.path === "/api/save/render" && response.status === 200), "PNG output used the real render endpoint");
    assert.equal(await page.evaluate(() => state.currentId), imageId, "project reopen preserves the durable image identity");
  } finally {
    await context?.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
