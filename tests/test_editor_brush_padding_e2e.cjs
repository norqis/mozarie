const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function setup(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
  await page.evaluate(async () => {
    const image = document.createElement("canvas"); image.width = 128; image.height = 96;
    const imageContext = image.getContext("2d");
    const pixels = imageContext.createImageData(128, 96);
    for (let i = 0; i < pixels.data.length; i += 4) { pixels.data[i] = (i * 17) % 251; pixels.data[i + 1] = (i * 13) % 239; pixels.data[i + 2] = (i * 7) % 233; pixels.data[i + 3] = 255; }
    imageContext.putImageData(pixels, 0, 0);
    state.currentImage = await createImageBitmap(image); Object.assign(currentRecord(), { width: 128, height: 96 });
    canvasSizeForImage(image); prepareOriginalImage(); resetCurrentDraft();
    const mask = (radius) => { const target = document.createElement("canvas"); target.width = 128; target.height = 96; const context = target.getContext("2d"); context.fillStyle = "#fff"; context.beginPath(); context.arc(90, 30, radius, 0, Math.PI * 2); context.fill(); return target; };
    state.candidates = [
      { id: "synthetic", role: "apply", enabled: true, expandPx: 0, labelToken: "penis", source: "target", color: "#fff" },
      { id: "synthetic-fluid", role: "exclude", enabled: true, forced: true, expandPx: 0, labelToken: "fluid", source: "fluid_exclusion", color: "#fff" },
    ];
    state.candidateImages.set("synthetic", await createImageBitmap(mask(8)));
    state.candidateImages.set("synthetic-fluid", await createImageBitmap(mask(3)));
    window.__paddingPngs = Array.from({ length: 41 }, (_, value) => mask(8 + value).toDataURL().split(",")[1]);
    state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
    state.manualExclusionForced = false;
    addCtx.fillStyle = "#fff"; addCtx.fillRect(15, 55, 20, 20);
    exclusionCtx.fillStyle = "#fff"; exclusionCtx.fillRect(15, 55, 10, 20);
    refreshManualLayerPresence("add", "exclusion", "exclusionErase");
    resetHistoryToCurrentManualMask(); invalidateMaskComposition(); flushMaskComposition();
    updateBrushSize(10); state.mosaicPreviewEnabled = true; requestMosaicPreview(); renderCandidates(); fitImage(); render();
  });
  await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPreviewRequested && mosaicCanvas.width === 128);
  const pngs = (await page.evaluate(() => window.__paddingPngs)).map((png) => Buffer.from(png, "base64"));
  await page.route("**/api/mask/sample/synthetic?*", (route) => route.fulfill({ contentType: "image/png", body: pngs[Math.min(40, Number(new URL(route.request().url()).searchParams.get("expandPx")))] }));
  return pngs;
}

async function snapshot(page) {
  return page.evaluate(() => ({
    mask: [...combinedCtx.getImageData(0, 0, 128, 96).data],
    preview: [...mosaicCtx.getImageData(0, 0, 128, 96).data],
  }));
}

test("brush boundaries survive candidate padding preview transitions", { timeout: 45000 }, async (t) => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
  try {
    for (const tool of ["brush", "eraser", "mosaic_eraser", "exclude_eraser"]) await t.test(`${tool} cancels padding without retaining the expanded contour outside its circle`, async () => {
      await setup(page, fixture.url); const before = await snapshot(page);
      await page.evaluate((tool) => setTool(tool), tool);
      await page.locator('[data-candidate-blink-id="synthetic"] .candidate-padding-button').click();
      await page.locator("#candidatePaddingInput").fill("10");
      await page.waitForFunction(() => state.candidatePaddingPreviewImages.size === 1 && !state.maskDirty && !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      assert.ok((await snapshot(page)).mask[(30 * 128 + 105) * 4 + 3] > 0, "the expanded contour is visible before cancellation");
      const startX = tool === "brush" ? 40 : 25;
      const points = await page.evaluate((x) => { const rect = canvas.getBoundingClientRect(); return [x, x + 5].map((px) => ({ x: rect.left + state.view.x + px * state.view.scale, y: rect.top + state.view.y + 65 * state.view.scale })); }, startX);
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 3 }); await page.mouse.up();
      await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      const after = await snapshot(page);
      for (let y = 0; y < 96; y += 1) for (let x = 0; x < 128; x += 1) {
        if (Math.hypot(x + .5 - Math.max(startX, Math.min(startX + 5, x + .5)), y + .5 - 65) <= 6) continue;
        const i = (y * 128 + x) * 4;
        assert.equal(after.mask[i + 3], before.mask[i + 3], `outside brush mask ${tool} at ${x},${y}`);
        if (x > 50) assert.deepEqual(after.preview.slice(i, i + 4), before.preview.slice(i, i + 4), `remote preview ${tool} at ${x},${y}`);
      }
      const savedMask = await page.evaluate(async () => { const bitmap = await createImageBitmap(await (await fetch(buildCombinedMask())).blob()); const target = document.createElement("canvas"); target.width = 128; target.height = 96; const context = target.getContext("2d"); context.drawImage(bitmap, 0, 0); bitmap.close(); return [...context.getImageData(0, 0, 128, 96).data]; });
      assert.ok(savedMask.every((value, index) => value === after.mask[index]), "the saved mask uses the corrected circle boundary");
      await page.evaluate(async () => { await restoreSnapshot(0); flushMaskComposition(); await flushWorkspaceDraft(state.currentId); });
      assert.ok((await snapshot(page)).mask.every((value, index) => value === before.mask[index]), "undo restores the original mask including the distant candidate");
      await page.unroute("**/api/mask/sample/synthetic?*");
    });

    await t.test("holding padding steps renders multiple visible contours before release and cancels cleanly", async () => {
      await setup(page, fixture.url); const before = await snapshot(page);
      await page.locator('[data-candidate-blink-id="synthetic"] .candidate-padding-button').click();
      const button = page.locator("#candidatePaddingIncrease"); const bounds = await button.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
      await page.waitForFunction(() => Number($("#candidatePaddingInput").value) >= 4 && combinedCtx.getImageData(101, 30, 1, 1).data[3] > 0);
      const first = Number(await page.locator("#candidatePaddingInput").inputValue());
      await page.waitForFunction((first) => Number($("#candidatePaddingInput").value) >= first + 3 && combinedCtx.getImageData(104, 30, 1, 1).data[3] > 0, first);
      assert.equal(await page.evaluate(() => state.candidates[0].expandPx), 0, "held previews remain uncommitted");
      await page.mouse.move(10, 10); await page.mouse.up();
      assert.equal(await page.evaluate(() => candidatePaddingRepeat), null, "pointer capture stops the hold even when released outside the button");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !state.maskDirty && !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      assert.ok((await snapshot(page)).mask.every((value, index) => value === before.mask[index]), "Escape restores every original candidate pixel");
      await page.unroute("**/api/mask/sample/synthetic?*");
    });

    await t.test("padding confirmation persists the newest queued value and failure restores original pixels", async () => {
      const pngs = await setup(page, fixture.url); let committed = 0; const sent = [];
      await page.unroute("**/api/mask/sample/synthetic?*");
      await page.route("**/api/mask/sample/synthetic?*", (route) => {
        const value = new URL(route.request().url()).searchParams.get("expandPx");
        return route.fulfill({ contentType: "image/png", body: pngs[value === null ? committed : Number(value)] });
      });
      await page.route("**/api/candidate/sample/synthetic", (route) => { committed = route.request().postDataJSON().expandPx; sent.push(committed); return route.fulfill({ json: { candidateRevision: 2 } }); });
      await page.locator('[data-candidate-blink-id="synthetic"] .candidate-padding-button').click();
      assert.equal(await page.evaluate(async () => { for (const value of [2, 3, 9]) { $("#candidatePaddingInput").value = String(value); scheduleCandidatePaddingPreview(); } return commitCandidatePadding(); }), true);
      await page.waitForFunction(() => !state.maskDirty && !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      assert.deepEqual(sent, [9], "confirmation sends only the newest value even when an older preview is loading");
      assert.equal(await page.evaluate(() => state.candidates[0].expandPx), 9);
      assert.equal(await page.evaluate(() => state.candidatePaddingPreviewImages.size), 0);
      const beforeFailure = await snapshot(page);
      await page.unroute("**/api/candidate/sample/synthetic");
      await page.route("**/api/candidate/sample/synthetic", (route) => route.fulfill({ status: 409, json: { error: "conflict", code: "candidate_conflict" } }));
      await page.route("**/api/candidates/sample", (route) => route.fulfill({ status: 503, json: { error: "unavailable", code: "internal_error" } }));
      await page.locator('[data-candidate-blink-id="synthetic"] .candidate-padding-button').click();
      await page.locator("#candidatePaddingInput").fill("15");
      await page.waitForFunction(() => state.candidatePaddingPreviewImages.size === 1 && !state.maskDirty && !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      assert.equal(await page.evaluate(() => commitCandidatePadding()), false);
      await page.waitForFunction(() => !state.maskDirty && !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      const afterFailure = await snapshot(page);
      assert.ok(afterFailure.mask.every((value, index) => value === beforeFailure.mask[index]), "failed confirmation restores every original mask pixel");
      assert.ok(afterFailure.preview.every((value, index) => value === beforeFailure.preview[index]), "failed confirmation restores the original rendered mosaic");
      assert.equal(await page.evaluate(() => state.candidates[0].expandPx), 9);
      await page.unroute("**/api/candidates/sample"); await page.unroute("**/api/candidate/sample/synthetic"); await page.unroute("**/api/mask/sample/synthetic?*");
    });

    await t.test("padding repeat stops on cancel capture loss blur visibility and popover close", async () => {
      await setup(page, fixture.url);
      await page.clock.install();
      for (const stop of ["pointercancel", "lostpointercapture", "blur", "visibilitychange", "close"]) {
        await page.evaluate(() => openCandidatePadding("synthetic", document.querySelector('[data-candidate-blink-id="synthetic"] .candidate-padding-button')));
        const button = page.locator("#candidatePaddingIncrease"); const bounds = await button.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
        await page.evaluate((stop) => {
          const repeat = candidatePaddingRepeat;
          if (stop === "blur") window.dispatchEvent(new Event("blur"));
          else if (stop === "visibilitychange") { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); delete document.hidden; }
          else if (stop === "close") closeCandidatePadding();
          else repeat.button.dispatchEvent(new PointerEvent(stop, { pointerId: repeat.pointerId }));
        }, stop);
        const value = await page.locator("#candidatePaddingInput").inputValue();
        await page.clock.runFor(700);
        assert.equal(await page.locator("#candidatePaddingInput").inputValue(), value, `${stop} cancels the repeating timer`);
        assert.equal(await page.evaluate(() => candidatePaddingRepeat), null);
        await page.mouse.up(); await page.evaluate(() => closeCandidatePadding());
      }
      await page.unroute("**/api/mask/sample/synthetic?*");
    });
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});
