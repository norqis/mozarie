const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function withPage(body, viewport = { width: 1280, height: 900 }) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context;
  try {
    context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await body(page, fixture);
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
}

async function selectSample(page, id = "sample") {
  await page.locator(`.gallery-item[data-id="${id}"]`).click();
  await page.waitForFunction((imageId) => state.currentId === imageId && state.currentImage, id);
}

test("flip and save controls keep their text, hit targets, and current filename unobscured", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    const toolbar = await page.evaluate(() => {
      const selectors = ["#undoButton", "#redoButton", "#flipHorizontalButton", "#flipVerticalButton", "#mosaicPreviewButton"];
      return selectors.map((selector) => {
        const node = document.querySelector(selector); const box = node.getBoundingClientRect();
        return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight, hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node };
      });
    });
    for (const item of toolbar) {
      assert.equal(item.overflow, false, `${item.selector} text is not clipped`);
      assert.equal(item.hit, true, `${item.selector} center remains its own hit target`);
    }
    for (let index = 1; index < toolbar.length; index += 1) {
      assert.ok(toolbar[index - 1].right <= toolbar[index].left || toolbar[index - 1].bottom <= toolbar[index].top, `${toolbar[index - 1].selector} does not overlap ${toolbar[index].selector}`);
    }

    await selectSample(page);
    await page.evaluate(() => { currentRecord().relativePath = "sample.jpg"; });
    const beforeDialogs = await page.evaluate(() => ({ image: structuredClone(currentRecord()), saves: performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/save/")).length }));
    for (const [open, dialog, filename, format, metadata, note] of [
      ["#saveButton", "#singleSaveDialog", "#singleSaveTarget", "#singleSaveOutputFormat", "#singleSaveKeepMetadata", "#singleSaveFormatNote"],
      ["#saveAllButton", "#applyDialog", null, "#applyOutputFormat", "#applyKeepMetadata", "#applyFormatNote"],
    ]) {
      await page.locator(open).click();
      await page.waitForFunction((selector) => document.querySelector(selector).open, dialog);
      const initial = await page.evaluate(({ dialog, filename, format, metadata }) => {
        const root = document.querySelector(dialog); const name = filename ? document.querySelector(filename) : null; const formatNode = document.querySelector(format); const metadataNode = document.querySelector(metadata); const rootBox = root.getBoundingClientRect();
        const boxes = [name, formatNode, metadataNode].filter(Boolean).map((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, clipped: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight }; });
        return { root: { left: rootBox.left, right: rootBox.right, top: rootBox.top, bottom: rootBox.bottom }, boxes, filename: name?.value || name?.textContent || "" };
      }, { dialog, filename, format, metadata });
      if (filename) assert.ok(initial.filename.includes("sample"), `${dialog} displays the current filename`);
      assert.equal(initial.boxes.every((box) => !box.clipped && box.left >= initial.root.left && box.right <= initial.root.right), true, `${dialog} fields fit without clipping`);
      for (let index = 0; index < initial.boxes.length; index += 1) for (let other = index + 1; other < initial.boxes.length; other += 1) {
        const a = initial.boxes[index]; const b = initial.boxes[other];
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${dialog} filename and settings do not overlap`);
      }
      const modeName = open === "#saveButton" ? "singleSaveMode" : "batchSaveMode";
      const mode = await page.locator(`input[name="${modeName}"]:checked`).getAttribute("value");
      await page.locator(format).selectOption("original");
      assert.equal(await page.locator(metadata).isDisabled(), false, "original format keeps metadata retention available, including for a JPEG source");
      await page.locator(format).selectOption("png");
      await page.locator(metadata).check();
      await page.locator(format).selectOption("jpg");
      assert.equal(await page.locator(metadata).isDisabled(), true, "JPG disables metadata retention");
      assert.equal(await page.locator(metadata).isChecked(), false, "JPG forces metadata retention off");
      assert.equal(await page.locator(note).textContent(), "JPG形式ではメタ情報を保持しません。");
      assert.equal(await page.locator(note).evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight), true, "the JPG warning is not clipped");
      assert.equal(await page.locator(`input[name="${modeName}"]:checked`).getAttribute("value"), mode, "format changes preserve overwrite/copy mode");
      assert.equal(await page.locator(metadata).evaluate((node) => getComputedStyle(node.closest("label")).color !== getComputedStyle(document.body).color), true, "the disabled metadata row is visually muted");
      await page.locator(format).focus(); await page.keyboard.press("Tab");
      assert.notEqual(await page.evaluate((selector) => document.activeElement === document.querySelector(selector), metadata), true, "keyboard focus skips disabled metadata retention");
      await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Space");
      assert.equal(await page.locator(metadata).isChecked(), false, "Space cannot enable metadata retention while JPG keeps the control disabled");
      await page.locator(format).selectOption("png");
      assert.equal(await page.locator(metadata).isDisabled(), false, "PNG restores metadata control");
      assert.equal(await page.locator(metadata).isChecked(), true, "PNG restores the pre-JPG preference");
      assert.equal((await page.locator(note).textContent()).trim(), "", "returning from JPG removes the JPG warning");
      await page.locator(open === "#saveButton" ? "#singleSaveCloseButton" : "#applyCloseButton").click();
    }
    assert.deepEqual(await page.evaluate((before) => ({
      unchanged: JSON.stringify(currentRecord()) === JSON.stringify(before.image),
      noSaveRequest: performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/save/")).length === before.saves,
    }), beforeDialogs), { unchanged: true, noSaveRequest: true }, "closing either save dialog writes no file request and changes no image/edit state");
  });
});

test("flip actions are reversible, isolated per image, and store bounded non-pixel history", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await selectSample(page);
    await page.evaluate(() => { const image = document.createElement("canvas"); image.width = 100; image.height = 80; state.currentImage = image; Object.assign(currentRecord(), { width: 100, height: 80 }); canvasSizeForImage(image); resetHistoryToCurrentManualMask(); });
    const initial = await page.evaluate(() => ({ width: state.currentImage.width, height: state.currentImage.height, sample: currentRecord().id }));
    assert.deepEqual(initial, { width: 100, height: 80, sample: "sample" });

    await page.locator("#flipHorizontalButton").click();
    await page.waitForFunction(() => currentRecord()?.flipH === true && !state.transformPending);
    assert.deepEqual(await page.evaluate(() => ({ left: transformImagePoint({ x: 0, y: 0 }), right: transformImagePoint({ x: state.currentImage.width, y: state.currentImage.height }), size: [state.currentImage.width, state.currentImage.height] })), { left: { x: 100, y: 0 }, right: { x: 0, y: 80 }, size: [100, 80] }, "horizontal flip swaps left/right and preserves vertical coordinates and dimensions");
    await page.locator("#flipHorizontalButton").click();
    await page.waitForFunction(() => currentRecord()?.flipH === false && !state.transformPending);
    assert.deepEqual(await page.evaluate(() => transformImagePoint({ x: .4, y: 1.2 })), { x: .4, y: 1.2 }, "a second horizontal flip restores the original direction");

    await page.locator("#flipVerticalButton").click();
    await page.waitForFunction(() => currentRecord()?.flipV === true && !state.transformPending);
    assert.deepEqual(await page.evaluate(() => ({ top: transformImagePoint({ x: 0, y: 0 }), bottom: transformImagePoint({ x: state.currentImage.width, y: state.currentImage.height }) })), { top: { x: 0, y: 80 }, bottom: { x: 100, y: 0 } }, "vertical flip swaps top/bottom and preserves horizontal coordinates");
    await page.locator("#flipVerticalButton").click();
    await page.waitForFunction(() => currentRecord()?.flipV === false && !state.transformPending);

    await page.locator("#flipHorizontalButton").click(); await page.waitForFunction(() => currentRecord()?.flipH === true && !state.transformPending);
    await page.locator("#flipVerticalButton").click(); await page.waitForFunction(() => currentRecord()?.flipV === true && !state.transformPending);
    assert.deepEqual(await page.evaluate(() => ({ upperLeft: transformImagePoint({ x: 0, y: 0 }), upperRight: transformImagePoint({ x: state.currentImage.width, y: 0 }) })), { upperLeft: { x: 100, y: 80 }, upperRight: { x: 0, y: 80 } }, "combined flips move the original upper corners to the opposite lower corners");

    await page.locator("#undoButton").click();
    await page.waitForFunction(() => currentRecord()?.flipH === true && currentRecord()?.flipV === false && !state.historyRestoreBusy);
    assert.deepEqual(await page.evaluate(() => ({ thumbnail: document.querySelector('.gallery-item[data-id="sample"] img')?.style.transform || "", horizontal: document.querySelector("#flipHorizontalButton").getAttribute("aria-pressed"), vertical: document.querySelector("#flipVerticalButton").getAttribute("aria-pressed"), rangePoint: transformImagePoint({ x: 20, y: 10 }) })), { thumbnail: "scale(-1, 1)", horizontal: "true", vertical: "false", rangePoint: { x: 80, y: 10 } }, "Undo restores the previous image direction and keeps its range point, thumbnail, and editor controls aligned");
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => currentRecord()?.flipH === true && currentRecord()?.flipV === true && !state.historyRestoreBusy);
    assert.deepEqual(await page.evaluate(() => ({ thumbnail: document.querySelector('.gallery-item[data-id="sample"] img')?.style.transform || "", horizontal: document.querySelector("#flipHorizontalButton").getAttribute("aria-pressed"), vertical: document.querySelector("#flipVerticalButton").getAttribute("aria-pressed"), rangePoint: transformImagePoint({ x: 20, y: 10 }) })), { thumbnail: "scale(-1, -1)", horizontal: "true", vertical: "true", rangePoint: { x: 80, y: 70 } }, "Redo reapplies the direction and keeps its range point, thumbnail, and editor controls aligned");
    assert.equal(await page.locator("#saveButton").isDisabled(), false, "a flip-only edit remains saveable without a mosaic range");

    await page.locator("#flipVerticalButton").click(); await page.waitForFunction(() => currentRecord()?.flipV === false && !state.transformPending);
    await page.locator("#flipHorizontalButton").click(); await page.waitForFunction(() => currentRecord()?.flipH === false && !state.transformPending);
    await page.evaluate(() => { const image = document.createElement("canvas"); image.width = 3840; image.height = 2160; state.currentImage = image; Object.assign(currentRecord(), { width: 3840, height: 2160 }); });
    for (let index = 0; index < 10; index += 1) {
      const expected = index % 2 === 0;
      await page.locator("#flipHorizontalButton").click();
      await page.waitForFunction((value) => currentRecord()?.flipH === value && !state.transformPending, expected);
    }
    assert.deepEqual(await page.evaluate(() => ({ flipH: currentRecord().flipH, size: [state.currentImage.width, state.currentImage.height] })), { flipH: false, size: [3840, 2160] }, "ten 4K flip operations finish in the original direction without changing dimensions");
    await page.locator("#flipHorizontalButton").click(); await page.waitForFunction(() => currentRecord()?.flipH === true && !state.transformPending);
    await page.locator("#flipVerticalButton").click(); await page.waitForFunction(() => currentRecord()?.flipV === true && !state.transformPending);

    const history = await page.evaluate(() => {
      for (let index = 0; index < 20; index += 1) recordHistoryOperation({ kind: "transform", flipH: true, flipV: false });
      const forbidden = (value, seen = new Set()) => {
        if (value == null || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value);
        if (value instanceof Blob || value instanceof ImageData || value instanceof HTMLCanvasElement || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
        return Object.values(value).some((item) => forbidden(item, seen));
      };
      return { length: state.history.length, forbidden: state.history.some((item) => forbidden(item)), operationKeys: [...new Set(state.history.flatMap((item) => Object.keys(item)))].sort(), canvasBases: [historyAddCanvas, historyExclusionCanvas, historyExclusionEraseCanvas].map((canvas) => [canvas.width, canvas.height]) };
    });
    assert.equal(history.forbidden, false, "repeated flip history contains no Blob, ImageData, canvas, ArrayBuffer, or typed-array pixel copy");
    assert.ok(history.length >= 20, "all requested reversible transform operations remain addressable");
    assert.deepEqual(history.operationKeys, ["editorState", "flipH", "flipV", "kind"], "flip history is bounded to compact transform flags and editor state");

    await selectSample(page, "sample-two");
    assert.deepEqual(await page.evaluate(() => ({ flipH: currentRecord().flipH === true, flipV: currentRecord().flipV === true })), { flipH: false, flipV: false }, "flipping sample does not alter the second image");
    await selectSample(page, "sample");
    assert.deepEqual(await page.evaluate(() => ({ flipH: currentRecord().flipH, flipV: currentRecord().flipV })), { flipH: true, flipV: true }, "returning to the first image restores its own direction");
  });
});

test("flipped editor coordinates keep manual masks, boundaries, compare panes, zoom, and pan aligned", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await selectSample(page);
    await page.evaluate(() => { const image = document.createElement("canvas"); image.width = 100; image.height = 80; state.currentImage = image; Object.assign(currentRecord(), { width: 100, height: 80 }); canvasSizeForImage(image); resetHistoryToCurrentManualMask(); });
    await page.locator("#flipHorizontalButton").click(); await page.waitForFunction(() => currentRecord()?.flipH === true && !state.transformPending);
    const result = await page.evaluate(async () => {
      const displayedPointer = { x: state.currentImage.width * .8, y: state.currentImage.height * .25 };
      const canonical = inverseTransformImagePoint(displayedPointer);
      const display = transformImagePoint(canonical);
      const sample = (context, x, y) => context.getImageData(x, y, 1, 1).data[3];
      const clear = () => { for (const [ctx, canvas] of [[addCtx, addCanvas], [exclusionCtx, exclusionCanvas], [exclusionEraseCtx, exclusionEraseCanvas]]) ctx.clearRect(0, 0, canvas.width, canvas.height); };
      const toolResults = {};
      for (const tool of ["brush", "eraser", "mosaic_eraser", "exclude_eraser"]) {
        clear();
        if (tool === "mosaic_eraser") addCtx.fillRect(canonical.x - 2, canonical.y - 2, 5, 5);
        if (tool === "exclude_eraser") exclusionCtx.fillRect(canonical.x - 2, canonical.y - 2, 5, 5);
        state.tool = tool; beginManualStroke(canonical); completeManualStroke();
        toolResults[tool] = { add: sample(addCtx, Math.floor(canonical.x), Math.floor(canonical.y)), exclusion: sample(exclusionCtx, Math.floor(canonical.x), Math.floor(canonical.y)), exclusionErase: sample(exclusionEraseCtx, Math.floor(canonical.x), Math.floor(canonical.y)), oppositeAdd: sample(addCtx, Math.floor(displayedPointer.x), Math.floor(displayedPointer.y)) };
      }
      clear();
      const pixel = { x: Math.floor(canonical.x), y: Math.floor(canonical.y) };
      paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [pixel.y, pixel.x, pixel.x + 1], "bucket");
      const bucket = { add: sample(addCtx, pixel.x, pixel.y), exclusion: sample(exclusionCtx, pixel.x, pixel.y) };
      clear(); paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [pixel.y, pixel.x, pixel.x + 1], "exclude_bucket");
      const excludeBucket = { add: sample(addCtx, pixel.x, pixel.y), exclusion: sample(exclusionCtx, pixel.x, pixel.y) };
      state.boundaryDrafts = [{ id: "flip-boundary", type: "rectangle", roi: { left: canonical.x - 3, top: canonical.y - 2, right: canonical.x + 3, bottom: canonical.y + 2 }, point: canonical }];
      state.viewMode = "compare"; state.compareSplit = .42; state.view = { scale: 2, x: 11, y: -7 };
      const before = { ...state.view }; const left = transformImagePoint(canonical); const right = transformImagePoint(canonical);
      state.view.scale = 1.5; state.view.x += 12; state.view.y += 8;
      return { displayedPointer, canonical, display, toolResults, bucket, excludeBucket, boundaryPoint: state.boundaryDrafts[0].point, shared: { left, right }, before, after: state.view, split: state.compareSplit };
    });
    assert.deepEqual(result.canonical, { x: 20, y: 20 }, "a pointer on the displayed right maps to the canonical left exactly once");
    assert.deepEqual(result.display, result.displayedPointer, "the canonical mask maps back to the same displayed pointer");
    assert.ok(result.toolResults.brush.add > 0 && result.toolResults.brush.oppositeAdd === 0, "mosaic brush changes only the pointed canonical position");
    assert.ok(result.toolResults.eraser.exclusion > 0 && result.toolResults.eraser.add === 0, "exclusion brush adds exclusion without adding mosaic");
    assert.equal(result.toolResults.mosaic_eraser.add, 0, "mosaic eraser removes only mosaic at the pointed position");
    assert.ok(result.toolResults.exclude_eraser.exclusionErase > 0, "exclusion eraser records removal at the pointed position");
    assert.deepEqual(result.bucket, { add: 255, exclusion: 0 }, "mosaic fill routes its seed span only to mosaic");
    assert.deepEqual(result.excludeBucket, { add: 0, exclusion: 255 }, "exclusion fill routes its seed span only to exclusion");
    assert.deepEqual(result.boundaryPoint, result.canonical, "a displayed boundary keeps the canonical pointed location rather than the opposite side");
    assert.deepEqual(result.shared.left, result.shared.right, "both compare panes use the same transformed image/mask coordinates");
    assert.deepEqual(result.after, { scale: 1.5, x: result.before.x + 12, y: result.before.y + 8 }, "zoom and pan update the one shared compare transform");

    let boundaryPayload;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/boundary")) boundaryPayload = request.postDataJSON();
    });
    await page.evaluate(() => {
      state.boundaryActiveId = "flip-boundary";
      updateBoundaryActions(); render();
    });
    await page.locator("#boundaryDetectButton").click();
    await page.waitForFunction(() => !state.boundaryPending && state.boundaryDrafts.length === 0);
    assert.deepEqual(boundaryPayload.roi, { left: 17, top: 18, right: 23, bottom: 22 }, "boundary detection sends the canonical unflipped ROI");
    assert.deepEqual(boundaryPayload.point, { x: 20, y: 20 }, "boundary detection sends the canonical unflipped seed point");
    assert.deepEqual(await page.evaluate(() => transformImagePoint({ x: 20, y: 20 })), result.displayedPointer, "the returned boundary candidate uses the same single display transform as the image");
  });
});

test("failed copy is shown and leaves the source image in the catalog", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await selectSample(page);
    const before = await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId, record: structuredClone(currentRecord()) }));
    await page.route("**/api/save/render", async (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error_code: "save_write_failed" }),
    }));
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open && !state.saving);
    const presentation = await page.evaluate(() => ({
      title: document.querySelector("#errorDialogTitle").textContent.trim(),
      cause: document.querySelector("#errorDialogCause").textContent.trim(),
      action: document.querySelector("#errorDialogAction").textContent.trim(),
      ids: state.images.map((image) => image.id),
      currentId: state.currentId,
      record: structuredClone(currentRecord()),
    }));
    assert.ok(presentation.title && presentation.cause && presentation.action, "a failed copy presents a complete user-facing error dialog");
    assert.deepEqual({ ids: presentation.ids, currentId: presentation.currentId, record: presentation.record }, before, "copy failure leaves the original catalog record and selected source unchanged");
  });
});
