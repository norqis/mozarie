"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

const hyphenImages = [
  { id: "hyphen-image-01", relativePath: "first-image.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\first-image.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
  { id: "hyphen-image-02", relativePath: "second-image.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\second-image.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
];

async function nextFrame(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function paneGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; };
    return { gallery: rect("#galleryPane"), canvas: rect("#editorCanvas"), inspector: rect("#candidatePane"), overflow: document.documentElement.scrollWidth > innerWidth };
  });
}

async function dragPane(page, selector, targetX, label) {
  const splitter = page.locator(selector);
  const box = await splitter.boundingBox();
  assert.ok(box, `${label} splitter is visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let index = 0; index < 200; index += 1) {
    const wobble = (index % 20) - 10;
    await page.mouse.move(targetX + wobble, box.y + box.height / 2);
  }
  await nextFrame(page);
  assert.equal(await page.evaluate(() => window.__paneWrites), 0, `${label} drag frames do not persist local storage`);
  await page.mouse.move(targetX, box.y + box.height / 2);
  await page.mouse.up();
  await nextFrame(page);
  assert.equal(await page.evaluate(() => window.__paneWrites), 1, `${label} pointerup persists exactly once`);
}

async function assertPaneKeyboardAndCancel(page, selector, side, collapseButton) {
  const splitter = page.locator(selector);
  const initial = Number(await splitter.getAttribute("aria-valuenow"));
  const minimum = Number(await splitter.getAttribute("aria-valuemin"));
  const maximum = Number(await splitter.getAttribute("aria-valuemax"));
  assert.equal(await splitter.getAttribute("role"), "separator", `${side} splitter has a separator role`);
  assert.equal(await splitter.getAttribute("aria-orientation"), "vertical", `${side} splitter describes its orientation`);
  assert.ok(initial >= minimum && initial <= maximum, `${side} splitter exposes a clamped ARIA value`);

  await splitter.focus();
  await page.keyboard.press("Home");
  assert.equal(Number(await splitter.getAttribute("aria-valuenow")), Number(await splitter.getAttribute("aria-valuemin")), `${side} Home clamps to the advertised minimum`);
  await page.keyboard.press("End");
  assert.equal(Number(await splitter.getAttribute("aria-valuenow")), Number(await splitter.getAttribute("aria-valuemax")), `${side} End clamps to the advertised maximum`);
  const beforeArrow = Number(await splitter.getAttribute("aria-valuenow"));
  await page.keyboard.press(side === "gallery" ? "Shift+ArrowLeft" : "Shift+ArrowRight");
  const afterArrow = Number(await splitter.getAttribute("aria-valuenow"));
  assert.notEqual(afterArrow, beforeArrow, `${side} keyboard adjustment changes its width`);

  // A native pointer down owns pointer id 1 in Chromium.  Dispatching only
  // the cancellation is the browser-level equivalent of the OS cancelling a
  // drag (for example when focus is lost), and verifies restoration rather
  // than merely testing a helper in isolation.
  const box = await splitter.boundingBox();
  const beforeCancel = Number(await splitter.getAttribute("aria-valuenow"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await nextFrame(page);
  await splitter.evaluate((node) => node.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
  await page.mouse.up();
  await nextFrame(page);
  assert.equal(Number(await splitter.getAttribute("aria-valuenow")), beforeCancel, `${side} cancelled drag restores the prior width without persisting it`);

  await page.locator(collapseButton).click();
  const collapsedWidth = Number(await splitter.getAttribute("aria-valuenow"));
  const writesBeforeCollapsed = await page.evaluate(() => window.__paneWrites);
  await splitter.dispatchEvent("pointerdown", { button: 0, pointerId: 19, clientX: box.x });
  await splitter.press("ArrowRight");
  assert.equal(Number(await splitter.getAttribute("aria-valuenow")), collapsedWidth, `${side} collapsed pane ignores splitter input`);
  assert.equal(await page.evaluate(() => window.__paneWrites), writesBeforeCollapsed, `${side} collapsed pane does not write local storage`);
  await page.locator(collapseButton).click();
}

async function canvasState(page) {
  return page.evaluate(() => {
    flushRender();
    const alpha = (context, canvas) => context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
    const firstOpaque = (context, canvas) => {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return { x: ((index - 3) / 4) % canvas.width, y: Math.floor((index - 3) / 4 / canvas.width), alpha: pixels[index] };
      return null;
    };
    const point = window.__visualMaskRegressionPoint || firstOpaque(addCtx, addCanvas) || { x: Math.floor(addCanvas.width / 2), y: Math.floor(addCanvas.height / 2) };
    const pointAlpha = (context, canvas) => context.getImageData(point.x, point.y, 1, 1).data[3];
    const dpr = devicePixelRatio || 1;
    const [, right] = comparePaneBounds();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((right.offset + state.view.x + state.currentImage.width * state.view.scale / 2) * dpr)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((state.view.y + state.currentImage.height * state.view.scale / 2) * dpr)));
    const rightPixel = [...ctx.getImageData(x, y, 1, 1).data];
    return {
      add: alpha(addCtx, addCanvas), exclusion: alpha(exclusionCtx, exclusionCanvas), exclusionErase: alpha(exclusionEraseCtx, exclusionEraseCanvas),
      effectiveExclusion: alpha(effectiveExclusionCtx, effectiveExclusionCanvas), combined: alpha(combinedCtx, combinedCanvas), rightPixel,
      center: {
        add: pointAlpha(addCtx, addCanvas), exclusion: pointAlpha(exclusionCtx, exclusionCanvas), exclusionErase: pointAlpha(exclusionEraseCtx, exclusionEraseCanvas),
        effectiveExclusion: pointAlpha(effectiveExclusionCtx, effectiveExclusionCanvas), combined: pointAlpha(combinedCtx, combinedCanvas),
      },
      point,
      blinkIds: state.blinkCandidateIds.size, blinkTimer: state.blinkTimer,
    };
  });
}

async function drawOnLeft(page, tool) {
  await page.locator(tool).click();
  const point = await page.evaluate(() => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + state.view.x + state.currentImage.width * state.view.scale / 2, y: rect.top + state.view.y + state.currentImage.height * state.view.scale / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 6, point.y + 4, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
  await nextFrame(page);
}

async function acceptConfirm(page) {
  await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
  await page.locator("#confirmAccept").click();
}

async function main() {
  const fixture = await startFixtureServer();
  fixture.setCatalog(hyphenImages);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      window.__paneWrites = 0;
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "mozarie.galleryWidth" || key === "mozarie.inspectorWidth") window.__paneWrites += 1;
        return originalSetItem.call(this, key, value);
      };
    });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll(".gallery-item img").length >= 2 && [...document.querySelectorAll(".gallery-item img")].every((image) => image.complete && image.naturalWidth > 0));

    const initialGallery = await page.evaluate(() => {
      const gallery = document.querySelector("#gallery");
      const first = document.querySelector(".gallery-item").getBoundingClientRect();
      return { scrollTop: gallery.scrollTop, firstVisible: first.top >= gallery.getBoundingClientRect().top && first.bottom <= gallery.getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth > innerWidth, thumbnailUrls: [...document.querySelectorAll(".gallery-item img")].map((image) => image.currentSrc) };
    });
    assert.equal(initialGallery.scrollTop, 0, "initial project gallery starts at the top");
    assert.equal(initialGallery.firstVisible, true, "initial project gallery keeps the first card in view");
    assert.equal(initialGallery.overflow, false, "initial gallery has no horizontal document scroll");
    assert.ok(initialGallery.thumbnailUrls.every((url) => url.includes("hyphen-image-")), "hyphenated image IDs resolve the actual thumbnail route");

    await page.evaluate(() => { window.__paneWrites = 0; });
    const beforeGallery = await paneGeometry(page);
    await dragPane(page, "#gallerySplitter", beforeGallery.gallery.left + 268, "gallery");
    const afterGallery = await paneGeometry(page);
    assert.ok(afterGallery.gallery.width > beforeGallery.gallery.width, "gallery pointer drag widens the gallery pane");
    assert.ok(Math.abs(afterGallery.inspector.width - beforeGallery.inspector.width) <= 1, "gallery drag leaves inspector width unchanged");
    assert.notEqual(afterGallery.canvas.width, beforeGallery.canvas.width, "gallery drag resizes the center editor");
    assert.equal(afterGallery.overflow, false, "gallery drag never creates horizontal document overflow");
    await assertPaneKeyboardAndCancel(page, "#gallerySplitter", "gallery", "#collapseGalleryButton");

    await page.evaluate(() => { window.__paneWrites = 0; });
    const beforeInspector = await paneGeometry(page);
    await dragPane(page, "#candidateSplitter", beforeInspector.inspector.right - 340, "inspector");
    const afterInspector = await paneGeometry(page);
    assert.ok(afterInspector.inspector.width > beforeInspector.inspector.width, "inspector pointer drag widens the candidate pane");
    assert.ok(Math.abs(afterInspector.gallery.width - beforeInspector.gallery.width) <= 1, "inspector drag leaves gallery width unchanged");
    assert.notEqual(afterInspector.canvas.width, beforeInspector.canvas.width, "inspector drag resizes the center editor");
    assert.equal(afterInspector.overflow, false, "inspector drag never creates horizontal document overflow");
    await assertPaneKeyboardAndCancel(page, "#candidateSplitter", "inspector", "#collapseInspectorButton");

    const persisted = await page.evaluate(() => ({ gallery: localStorage.getItem("mozarie.galleryWidth"), inspector: localStorage.getItem("mozarie.inspectorWidth") }));
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await page.evaluate(() => ({ gallery: getComputedStyle(document.querySelector(".studio-grid")).getPropertyValue("--gallery-width").trim(), inspector: getComputedStyle(document.querySelector(".studio-grid")).getPropertyValue("--inspector-width").trim() })), { gallery: `${persisted.gallery}px`, inspector: `${persisted.inspector}px` }, "both independently persisted pane widths restore after reload");

    await page.locator('.gallery-item[data-id="hyphen-image-01"]').click();
    await page.waitForFunction(() => state.currentId === "hyphen-image-01" && state.currentImage);
    await page.locator("#compareViewButton").click();
    await drawOnLeft(page, "#brushTool");
    await page.evaluate(() => {
      const pixels = addCtx.getImageData(0, 0, addCanvas.width, addCanvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) {
        if (!pixels[index]) continue;
        window.__visualMaskRegressionPoint = { x: ((index - 3) / 4) % addCanvas.width, y: Math.floor((index - 3) / 4 / addCanvas.width) };
        return;
      }
      throw new Error("manual mosaic stroke did not paint a probe pixel");
    });
    let masks = await canvasState(page);
    assert.deepEqual(masks.center, { add: 255, exclusion: 0, exclusionErase: 0, effectiveExclusion: 0, combined: 255 }, `two-pane mosaic brush immediately updates the shared stroke pixel (${JSON.stringify(masks.point)})`);
    assert.ok(masks.rightPixel.some((value, index) => index < 3 && value > 0), "two-pane right side visibly renders the mosaic range overlay");

    await drawOnLeft(page, "#eraserTool");
    masks = await canvasState(page);
    assert.deepEqual(masks.center, { add: 255, exclusion: 255, exclusionErase: 0, effectiveExclusion: 255, combined: 0 }, "a forced exclusion wins over the same hand-drawn center pixel immediately");
    assert.ok(masks.rightPixel[2] > masks.rightPixel[0], "the right comparison side visibly renders the exclusion color for a forced exclusion");

    await page.locator(".candidate-row-manual-exclude .candidate-forced").click();
    await page.waitForFunction(() => state.manualExclusionForced === false);
    masks = await canvasState(page);
    assert.equal(masks.center.combined, 255, "a normal exclusion lets the hand-drawn center pixel win immediately");
    assert.ok(masks.rightPixel[2] > masks.rightPixel[0], "the right comparison side keeps the exclusion color for a normal exclusion");

    await page.locator(".candidate-row-manual-exclude .candidate-forced").click();
    await page.waitForFunction(() => state.manualExclusionForced === true);
    masks = await canvasState(page);
    assert.equal(masks.center.combined, 0, "turning force back on immediately restores forced exclusion precedence at the same center pixel");

    await drawOnLeft(page, "#excludeEraserTool");
    masks = await canvasState(page);
    assert.deepEqual(masks.center, { add: 255, exclusion: 255, exclusionErase: 255, effectiveExclusion: 0, combined: 255 }, "exclusion erase restores the same forced center pixel immediately");

    await page.locator("#clearCurrentMasksButton").click();
    await acceptConfirm(page);
    await page.waitForFunction(() => !canvasHasPixels(addCtx, addCanvas) && !canvasHasPixels(exclusionCtx, exclusionCanvas) && !canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas));
    await nextFrame(page);
    masks = await canvasState(page);
    assert.deepEqual({ ...masks.center, blinkIds: masks.blinkIds, blinkTimer: masks.blinkTimer }, { add: 0, exclusion: 0, exclusionErase: 0, effectiveExclusion: 0, combined: 0, blinkIds: 0, blinkTimer: null }, "clear current removes every live mask layer and the blink state");
    assert.deepEqual(masks.rightPixel.slice(0, 3), [0, 0, 0], "after clear current, the right comparison side is black with no stale overlay");

    await drawOnLeft(page, "#brushTool");
    await page.locator('.gallery-item[data-id="hyphen-image-02"]').click();
    await page.waitForFunction(() => state.currentId === "hyphen-image-02" && state.currentImage);
    await drawOnLeft(page, "#brushTool");
    await page.locator("#batchMoreButton").click();
    await page.locator("#clearAllMasksButton").click();
    await acceptConfirm(page);
    await page.waitForFunction(() => !canvasHasPixels(addCtx, addCanvas) && !canvasHasPixels(exclusionCtx, exclusionCanvas) && !canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas));
    await nextFrame(page);
    masks = await canvasState(page);
    assert.deepEqual(masks.center, { add: 0, exclusion: 0, exclusionErase: 0, effectiveExclusion: 0, combined: 0 }, "clear all removes the active image's visible and effective center pixel on the next frame");
    await page.locator('.gallery-item[data-id="hyphen-image-01"]').click();
    await page.waitForFunction(() => state.currentId === "hyphen-image-01" && !canvasHasPixels(addCtx, addCanvas) && !canvasHasPixels(exclusionCtx, exclusionCanvas) && !canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas));
    masks = await canvasState(page);
    assert.deepEqual(masks.center, { add: 0, exclusion: 0, exclusionErase: 0, effectiveExclusion: 0, combined: 0 }, "clear all also removes the other image's mask layers");
  } finally {
    await context.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
}

main().then(() => console.log("test_visual_interaction_regressions: passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
