const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

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
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

async function resetLayers(page) {
  await page.evaluate(() => {
    for (const [ctx, target] of [[addCtx, addCanvas], [exclusionCtx, exclusionCanvas], [exclusionEraseCtx, exclusionEraseCanvas]]) ctx.clearRect(0, 0, target.width, target.height);
    state.history = []; state.historyIndex = 0; state.manualEnabled = false; state.manualExclusionEnabled = false; state.manualExclusionEraseEnabled = false;
    state.manualMaskPresent = false; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false;
    state.removedCandidateIds.clear(); state.candidates = []; state.candidateImages.clear();
    markMaskDirty(); flushMaskComposition(); renderCandidates(); render();
  });
}

async function alphas(page, points) {
  return page.evaluate((points) => Object.fromEntries(Object.entries(points).map(([name, { layer, x, y }]) => {
    const contexts = { add: addCtx, exclusion: exclusionCtx, exclusionErase: exclusionEraseCtx, combined: combinedCtx };
    return [name, contexts[layer].getImageData(x, y, 1, 1).data[3]];
  })), points);
}

nodeTest("basic editor tools keep their pixel-layer contracts", { timeout: 45000 }, async (t) => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await context.newPage();
  try {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2 && document.querySelectorAll(".gallery-item").length === 2);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => {
      const image = document.createElement("canvas"); image.width = 100; image.height = 80;
      const source = image.getContext("2d"); source.fillStyle = "rgb(10, 10, 10)"; source.fillRect(0, 0, image.width, image.height);
      state.currentImage = image; Object.assign(currentRecord(), { width: 100, height: 80 });
      canvasSizeForImage(image); prepareOriginalImage(); fitImage(); render();
    });
    await page.locator("#brushSize").fill("10");
    await page.locator("#brushSize").dispatchEvent("input");

    await t.test("ED-001 drag adds mosaic only along the circular brush sweep", async () => {
      await resetLayers(page); await page.locator("#brushTool").click();
      const start = await imagePoint(page, 20, 20); const end = await imagePoint(page, 40, 20);
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal((await alphas(page, { duringDrag: { layer: "add", x: 30, y: 20 } })).duringDrag, 255, "the editable layer changes before pointerup");
      await page.mouse.up();
      assert.deepEqual(await alphas(page, { start: { layer: "add", x: 20, y: 20 }, end: { layer: "add", x: 40, y: 20 }, exclude: { layer: "exclusion", x: 30, y: 20 } }), { start: 255, end: 255, exclude: 0 });
    });

    await t.test("ED-002 click adds one brush-diameter mosaic stamp", async () => {
      await resetLayers(page); await page.locator("#brushTool").click(); await clickImage(page, 30, 30);
      const pixels = await alphas(page, { center: { layer: "add", x: 30, y: 30 }, inside: { layer: "add", x: 34, y: 30 }, outside: { layer: "add", x: 36, y: 30 } });
      assert.equal(pixels.center, 255); assert.ok(pixels.inside > 0, "an antialiased edge pixel remains inside the circular stamp"); assert.equal(pixels.outside, 0);
    });

    await t.test("ED-003 mosaic eraser removes only its swept mosaic pixels", async () => {
      await resetLayers(page);
      await page.evaluate(() => { addCtx.fillStyle = exclusionCtx.fillStyle = "#fff"; addCtx.fillRect(10, 10, 50, 1); exclusionCtx.fillRect(12, 10, 1, 1); markMaskDirty(); flushMaskComposition(); });
      await page.locator("#mosaicEraserTool").click(); await dragImage(page, { x: 20, y: 10 }, { x: 30, y: 10 });
      assert.deepEqual(await alphas(page, { erased: { layer: "add", x: 25, y: 10 }, distant: { layer: "add", x: 50, y: 10 }, exclusion: { layer: "exclusion", x: 12, y: 10 } }), { erased: 0, distant: 255, exclusion: 255 });
    });

    async function prepareFillSource() {
      await page.evaluate(() => {
        originalCtx.fillStyle = "rgb(10, 10, 10)"; originalCtx.fillRect(0, 0, originalCanvas.width, originalCanvas.height);
        originalCtx.fillStyle = "rgb(120, 120, 120)"; originalCtx.fillRect(30, 0, 20, originalCanvas.height);
        originalCtx.fillStyle = "rgb(10, 10, 10)"; originalCtx.fillRect(60, 0, 20, originalCanvas.height);
      });
    }

    await t.test("ED-004 mosaic fill changes only the connected tolerated region", async () => {
      await resetLayers(page); await prepareFillSource(); await page.locator("#bucketTool").click(); await clickImage(page, 10, 10);
      await page.waitForFunction(() => !state.fillPending && state.history.length === 1);
      assert.deepEqual(await alphas(page, { connected: { layer: "add", x: 10, y: 10 }, barrier: { layer: "add", x: 40, y: 10 }, disconnectedSame: { layer: "add", x: 70, y: 10 } }), { connected: 255, barrier: 0, disconnectedSame: 0 });
    });

    await t.test("ED-005 exclusion drag subtracts mosaic without adding to the mosaic layer", async () => {
      await resetLayers(page); await page.evaluate(() => { addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, addCanvas.width, addCanvas.height); markMaskDirty(); flushMaskComposition(); });
      await page.locator("#eraserTool").click(); await dragImage(page, { x: 20, y: 20 }, { x: 40, y: 20 });
      assert.deepEqual(await alphas(page, { add: { layer: "add", x: 30, y: 20 }, exclusion: { layer: "exclusion", x: 30, y: 20 }, effective: { layer: "combined", x: 30, y: 20 } }), { add: 255, exclusion: 255, effective: 0 });
      assert.deepEqual(await page.evaluate(() => ({ automatic: state.candidates.length, manualApply: Boolean(document.querySelector('[data-candidate-blink-id="manual:apply"]')), manualExclude: Boolean(document.querySelector('[data-candidate-blink-id="manual:exclude"]')) })), { automatic: 0, manualApply: false, manualExclude: true }, "exclusion drawing creates only its exclusion row and never a mosaic candidate row");
    });

    await t.test("ED-006 exclusion click adds one circular exclusion stamp", async () => {
      await resetLayers(page); await page.locator("#eraserTool").click(); await clickImage(page, 30, 30);
      const pixels = await alphas(page, { center: { layer: "exclusion", x: 30, y: 30 }, inside: { layer: "exclusion", x: 34, y: 30 }, outside: { layer: "exclusion", x: 36, y: 30 } });
      assert.equal(pixels.center, 255); assert.ok(pixels.inside > 0, "an antialiased edge pixel remains inside the circular exclusion"); assert.equal(pixels.outside, 0);
    });

    await t.test("ED-007 exclusion eraser restores underlying mosaic and preserves distant exclusions", async () => {
      await resetLayers(page); await page.evaluate(() => { addCtx.fillStyle = exclusionCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, addCanvas.width, addCanvas.height); exclusionCtx.fillRect(10, 10, 50, 1); state.manualEnabled = true; state.manualExclusionEnabled = true; markMaskDirty(); flushMaskComposition(); });
      await page.locator("#excludeEraserTool").click(); await dragImage(page, { x: 20, y: 10 }, { x: 30, y: 10 });
      assert.deepEqual(await alphas(page, { erasedExclusion: { layer: "exclusionErase", x: 25, y: 10 }, restoredMosaic: { layer: "combined", x: 25, y: 10 }, distantExcluded: { layer: "combined", x: 50, y: 10 } }), { erasedExclusion: 255, restoredMosaic: 255, distantExcluded: 0 });
    });

    await t.test("ED-008 exclusion fill changes only the connected exclusion region", async () => {
      await resetLayers(page); await prepareFillSource(); await page.locator("#excludeBucketTool").click(); await clickImage(page, 10, 10);
      await page.waitForFunction(() => !state.fillPending && state.history.length === 1);
      assert.deepEqual(await alphas(page, { connected: { layer: "exclusion", x: 10, y: 10 }, barrier: { layer: "exclusion", x: 40, y: 10 }, disconnectedSame: { layer: "exclusion", x: 70, y: 10 }, mosaic: { layer: "add", x: 10, y: 10 } }), { connected: 255, barrier: 0, disconnectedSame: 0, mosaic: 0 });
    });

    async function assertTolerance(toolSelector, layer, sourceId) {
      await resetLayers(page);
      await page.evaluate(() => { originalCtx.fillStyle = "rgb(10, 10, 10)"; originalCtx.fillRect(0, 0, 20, 80); originalCtx.fillStyle = "rgb(35, 35, 35)"; originalCtx.fillRect(20, 0, 20, 80); originalCtx.fillStyle = "rgb(120, 120, 120)"; originalCtx.fillRect(40, 0, 20, 80); originalCtx.fillStyle = "rgb(10, 10, 10)"; originalCtx.fillRect(60, 0, 20, 80); });
      await page.locator(toolSelector).click();
      await page.locator("#bucketTolerance").fill("5"); await page.locator("#bucketTolerance").dispatchEvent("input"); await clickImage(page, 10, 10);
      await page.waitForFunction(() => !state.fillPending && state.history.length === 1);
      assert.equal((await alphas(page, { adjacent: { layer, x: 25, y: 10 } })).adjacent, 0, `${sourceId} small tolerance excludes the adjacent color`);
      await page.locator("#undoButton").click(); await page.waitForFunction(() => state.historyIndex === 0);
      await page.locator(toolSelector).click();
      await page.locator("#bucketTolerance").fill("50"); await page.locator("#bucketTolerance").dispatchEvent("input"); await clickImage(page, 10, 10);
      await page.waitForFunction(() => !state.fillPending && state.historyIndex === 1);
      assert.ok((await alphas(page, { adjacent: { layer, x: 25, y: 10 } })).adjacent > 0, `${sourceId} larger tolerance includes the adjacent color`);
      assert.equal((await alphas(page, { disconnectedSame: { layer, x: 70, y: 10 } })).disconnectedSame, 0, `${sourceId} never crosses the disconnected barrier to an identical color`);
    }

    await t.test("ED-009 mosaic fill tolerance changes the connected result across undo", async () => assertTolerance("#bucketTool", "add", "ED-009"));
    await t.test("ED-010 exclusion fill tolerance changes only exclusion across undo", async () => {
      await assertTolerance("#excludeBucketTool", "exclusion", "ED-010");
      assert.equal((await alphas(page, { mosaic: { layer: "add", x: 10, y: 10 } })).mosaic, 0);
    });

    await t.test("ED-011 tolerance close hides the popover and keeps the fill tool selected", async () => {
      await page.locator("#bucketTool").click(); assert.equal(await page.locator("#bucketToleranceControl").isVisible(), true);
      await page.locator("#bucketToleranceClose").click(); assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false); assert.equal(await page.locator("#bucketTool").getAttribute("aria-pressed"), "true");
    });

    await t.test("ED-012 Escape closes the tolerance popover", async () => {
      await page.locator("#bucketTool").click(); await page.keyboard.press("Escape"); assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false);
    });

    await t.test("ED-013 switching tools closes tolerance and selects only the new tool", async () => {
      await page.locator("#bucketTool").click(); await page.locator("#brushTool").click();
      assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false); assert.equal(await page.locator("#bucketTool").getAttribute("aria-pressed"), "false"); assert.equal(await page.locator("#brushTool").getAttribute("aria-pressed"), "true");
    });

    await t.test("ED-014 fill tolerance survives a page reload and drives the next fill", async () => {
      await page.locator("#bucketTool").click(); await page.locator("#bucketTolerance").fill("37"); await page.locator("#bucketTolerance").dispatchEvent("input"); await page.locator("#bucketTolerance").dispatchEvent("change");
      await page.waitForFunction(() => state.settings.editing.fill_color_tolerance === 37);
      const restartedPage = await context.newPage(); await page.close(); page = restartedPage;
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" }); await page.waitForFunction(() => state.settings && state.images.length === 2);
      await page.locator('.gallery-item[data-id="sample"]').click(); await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
      assert.equal(await page.locator("#bucketTolerance").inputValue(), "37");
      await page.evaluate(() => {
        const image = document.createElement("canvas"); image.width = 100; image.height = 80; const source = image.getContext("2d");
        source.fillStyle = "rgb(10, 10, 10)"; source.fillRect(0, 0, 20, 80); source.fillStyle = "rgb(35, 35, 35)"; source.fillRect(20, 0, 20, 80);
        state.currentImage = image; Object.assign(currentRecord(), { width: 100, height: 80 }); canvasSizeForImage(image); prepareOriginalImage(); fitImage(); render();
      });
      await page.locator("#bucketTool").click(); await clickImage(page, 10, 10); await page.waitForFunction(() => !state.fillPending && state.history.length === 1);
      assert.ok((await alphas(page, { adjacent: { layer: "add", x: 25, y: 10 } })).adjacent > 0, "the reinitialized editor uses the persisted tolerance for its next fill");
    });

    await t.test("ED-015 brush size display and cursor diameter follow every requested value without drawing", async () => {
      const history = await page.evaluate(() => state.history.length);
      await page.locator("#brushTool").click(); const hover = await imagePoint(page, 10, 10); await page.mouse.move(hover.x, hover.y);
      for (const value of [1, 48, 100]) {
        await page.locator("#brushSize").fill(String(value)); await page.locator("#brushSize").dispatchEvent("input"); assert.match(await page.locator("#brushSizeValue").textContent(), new RegExp(String(value)));
        const cursor = await page.locator("#brushCursor").boundingBox(); const scale = await page.evaluate(() => state.view.scale); assert.ok(Math.abs(cursor.width - value * scale) <= 2, `cursor diameter follows ${value}px at the active image scale`);
      }
      assert.equal(await page.evaluate(() => state.history.length), history);
    });

    await t.test("ED-016 Shift wheel changes brush size without zooming or scrolling the gallery", async () => {
      await page.locator("#brushTool").click(); await page.locator("#brushSize").fill("48"); await page.locator("#brushSize").dispatchEvent("input");
      const before = await page.evaluate(() => ({ view: { ...state.view }, scroll: document.querySelector("#gallery").scrollTop })); const point = await imagePoint(page, 1, 1); await page.mouse.move(point.x, point.y); await page.keyboard.down("Shift"); await page.mouse.wheel(0, -100); await page.keyboard.up("Shift");
      assert.ok(Number(await page.locator("#brushSize").inputValue()) > 48); assert.deepEqual(await page.evaluate(() => ({ view: { ...state.view }, scroll: document.querySelector("#gallery").scrollTop })), before);
    });

    await t.test("ED-017 mosaic divisor updates calculated pixels without changing masks", async () => {
      await page.evaluate(() => { addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, addCanvas.width, addCanvas.height); state.manualEnabled = true; markMaskDirty(); flushMaskComposition(); });
      const before = await page.evaluate(() => [addCanvas.toDataURL(), exclusionCanvas.toDataURL(), exclusionEraseCanvas.toDataURL()]);
      const granularity = async (divisor) => {
        await page.locator("#divisor").fill(String(divisor)); await page.locator("#divisor").dispatchEvent("input");
        await page.evaluate(async () => { state.mosaicPreviewEnabled = true; await rebuildMosaicPreview(); });
        await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPending);
        return page.evaluate(() => {
          const data = mosaicCtx.getImageData(0, 0, mosaicCanvas.width, 1).data; let changes = 0;
          for (let x = 1; x < mosaicCanvas.width; x += 1) if (data[x * 4] !== data[(x - 1) * 4]) changes += 1;
          return { changes, label: document.querySelector("#blockSizeValue").textContent };
        });
      };
      await page.evaluate(() => { for (let x = 0; x < originalCanvas.width; x += 1) { originalCtx.fillStyle = `rgb(${x % 256},${(x * 3) % 256},${(x * 7) % 256})`; originalCtx.fillRect(x, 0, 1, originalCanvas.height); } releaseMosaicPreview(); state.mosaicPreviewEnabled = true; });
      const coarse = await granularity(10); const fine = await granularity(100);
      assert.notEqual(coarse.label, fine.label, "calculated pixel display changes with the divisor"); assert.ok(fine.changes > coarse.changes, "a finer divisor produces visibly finer mosaic blocks");
      assert.deepEqual(await page.evaluate(() => [addCanvas.toDataURL(), exclusionCanvas.toDataURL(), exclusionEraseCanvas.toDataURL()]), before, "divisor changes preserve every mask layer");
    });

    await t.test("ED-018 mosaic help shows guideline links and returns to the editor", async () => {
      await page.locator("#mosaicHelpButton").click(); assert.equal(await page.locator("#mosaicHelpDialog").evaluate((node) => node.open), true);
      assert.match(await page.locator("#mosaicHelpDialog p").first().textContent(), /長辺の1\/100.*最低4 px/);
      assert.deepEqual(await page.locator("#mosaicHelpDialog a").evaluateAll((links) => links.map((link) => ({ text: link.textContent, href: link.href, target: link.target, rel: link.rel }))), [
        { text: "BOOTH", href: "https://booth.pm/guidelines", target: "_blank", rel: "noreferrer" },
        { text: "pixiv", href: "https://www.pixiv.net/terms/?page=guideline", target: "_blank", rel: "noreferrer" },
        { text: "FANZA", href: "https://terms.dmm.co.jp/doujin_regulation", target: "_blank", rel: "noreferrer" },
        { text: "DLsite", href: "https://www.dlsite.com/home/mosaic", target: "_blank", rel: "noreferrer" },
      ]);
      await page.locator("#mosaicHelpCloseButton").click(); assert.equal(await page.locator("#mosaicHelpDialog").evaluate((node) => node.open), false); assert.equal(await page.locator("#editorCanvas").isVisible(), true);
    });
  } finally {
    await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});
