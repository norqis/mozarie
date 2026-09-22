const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function imagePoint(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const rect = canvas.getBoundingClientRect();
    const offset = state.displayMode === "compare" && state.boundaryDisplaySide === "right" ? compareSideOffset("right", rect.width) : 0;
    return { x: rect.left + offset + state.view.x + x * state.view.scale, y: rect.top + state.view.y + y * state.view.scale };
  }, { x, y });
}

async function drag(page, points, button = "left") {
  const clients = [];
  for (const point of points) clients.push(await imagePoint(page, point.x, point.y));
  await page.mouse.move(clients[0].x, clients[0].y); await page.mouse.down({ button });
  for (const point of clients.slice(1)) await page.mouse.move(point.x, point.y, { steps: 3 });
  await page.mouse.up({ button });
}

async function setup(page, url, size = 240) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
  await page.evaluate(async (size) => {
    const source = document.createElement("canvas"); source.width = source.height = size;
    const sourceContext = source.getContext("2d"); sourceContext.fillStyle = "#789"; sourceContext.fillRect(0, 0, size, size);
    state.currentImage = await createImageBitmap(source); const record = currentRecord(); record.width = size; record.height = size;
    canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft(); fitImage(); render();
  }, size);
}

async function selectBoundaryTool(page, selector) {
  await page.locator("#boundaryTool").click();
  await page.locator(selector).click();
}

async function layerSnapshot(page) {
  return page.evaluate(() => ({
    add: addCanvas.toDataURL(), exclusion: exclusionCanvas.toDataURL(), exclusionErase: exclusionEraseCanvas.toDataURL(),
    history: state.history.length, historyIndex: state.historyIndex, candidates: state.candidates.length,
  }));
}

async function overlayBounds(page) {
  return page.evaluate(() => {
    flushRender();
    const { width, height } = boundaryOverlayCanvas; const data = boundaryOverlayCtx.getImageData(0, 0, width, height).data;
    let left = width; let top = height; let right = -1; let bottom = -1; let count = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3]) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count += 1;
    }
    return { left, top, right, bottom, count };
  });
}

async function clickImage(page, x, y) { const point = await imagePoint(page, x, y); await page.mouse.click(point.x, point.y); }

async function layerAlpha(page, layer, x, y) {
  return page.evaluate(({ layer, x, y }) => ({ add: addCtx, exclusion: exclusionCtx, exclusionErase: exclusionEraseCtx })[layer].getImageData(x, y, 1, 1).data[3], { layer, x, y });
}

async function renderedPixel(page, x, y) {
  return page.evaluate(({ x, y }) => {
    state.blinkPhase = true; renderNow();
    const point = transformImagePoint({ x, y }); const px = Math.round(state.view.x + point.x * state.view.scale); const py = Math.round(state.view.y + point.y * state.view.scale);
    return [...ctx.getImageData(px, py, 1, 1).data];
  }, { x, y });
}

test("direct editor boundary and gesture observations", { timeout: 150000 }, async (t) => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
  const paddingMasks = await page.evaluate(() => Object.fromEntries([0, 8].map((padding) => {
    const mask = document.createElement("canvas"); mask.width = mask.height = 240;
    mask.getContext("2d").fillRect(20 - padding, 20 - padding, 20 + padding * 2, 20 + padding * 2);
    return [padding, mask.toDataURL("image/png").split(",")[1]];
  })));
  await page.route(/\/api\/mask\/sample\/(apply|exclude)\?/, async (route) => {
    const padding = Number(new URL(route.request().url()).searchParams.get("expandPx") || 0);
    assert.ok(paddingMasks[padding], `a seeded candidate mask exists for padding ${padding}`);
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(paddingMasks[padding], "base64") });
  });
  try {
    await t.test("ED-020.1 rectangle drag renders the diagonal-corner rectangle", async () => {
      await setup(page, fixture.url); await selectBoundaryTool(page, "#rectangleTool"); await drag(page, [{ x: 40, y: 50 }, { x: 120, y: 140 }]);
      const result = await page.evaluate(() => ({ draft: state.boundaryDrafts.at(-1), active: activeBoundaryShape() }));
      assert.equal(result.draft.type, "rectangle"); assert.ok(Math.abs(result.draft.roi.left - 40) <= 1 && Math.abs(result.draft.roi.top - 50) <= 1 && Math.abs(result.draft.roi.right - 120) <= 1 && Math.abs(result.draft.roi.bottom - 140) <= 1);
      const bounds = await overlayBounds(page); assert.ok(bounds.count > 0); assert.ok(bounds.right - bounds.left > 40 && bounds.bottom - bounds.top > 40, `rendered rectangle bounds: ${JSON.stringify(bounds)}`);
    });

    await t.test("ED-020.2 rectangle draft changes no mosaic or history before detection", async () => {
      await setup(page, fixture.url); const before = await layerSnapshot(page); await selectBoundaryTool(page, "#rectangleTool"); await drag(page, [{ x: 30, y: 30 }, { x: 90, y: 100 }]);
      assert.deepEqual(await layerSnapshot(page), before);
    });

    await t.test("ED-021.1 four polygon clicks render one closed ordered region", async () => {
      await setup(page, fixture.url); await selectBoundaryTool(page, "#polygonTool");
      const points = [{ x: 35, y: 35 }, { x: 130, y: 40 }, { x: 120, y: 135 }, { x: 40, y: 125 }];
      for (const point of points) { const client = await imagePoint(page, point.x, point.y); await page.mouse.click(client.x, client.y); }
      const polygon = await page.evaluate(() => state.boundaryDrafts.at(-1)); assert.equal(polygon.type, "polygon"); assert.deepEqual(polygon.points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })), points);
      const bounds = await overlayBounds(page); assert.ok(bounds.count > 100); assert.ok(bounds.left <= 35 && bounds.right >= 119);
    });

    await t.test("ED-021.2 polygon draft changes no mosaic or history before detection", async () => {
      await setup(page, fixture.url); const before = await layerSnapshot(page); await selectBoundaryTool(page, "#polygonTool");
      for (const point of [{ x: 35, y: 35 }, { x: 130, y: 40 }, { x: 120, y: 135 }, { x: 40, y: 125 }]) { const client = await imagePoint(page, point.x, point.y); await page.mouse.click(client.x, client.y); }
      assert.deepEqual(await layerSnapshot(page), before);
    });

    await t.test("ED-022.1 boundary brush drag renders its swept region", async () => {
      await setup(page, fixture.url); await selectBoundaryTool(page, "#boundaryBrushTool"); await drag(page, [{ x: 40, y: 80 }, { x: 100, y: 80 }, { x: 160, y: 110 }]);
      const brush = await page.evaluate(() => state.boundaryDrafts.at(-1)); assert.equal(brush.type, "brush"); assert.ok(brush.points.length >= 3); assert.ok(brush.roi.left < 40 && brush.roi.right > 160);
      assert.ok((await overlayBounds(page)).count > 100);
    });

    await t.test("ED-022.2 boundary brush changes no mosaic or history before detection", async () => {
      await setup(page, fixture.url); const before = await layerSnapshot(page); await selectBoundaryTool(page, "#boundaryBrushTool"); await drag(page, [{ x: 40, y: 80 }, { x: 160, y: 110 }]);
      assert.deepEqual(await layerSnapshot(page), before);
    });

    await t.test("ED-023.1 boundary cancel clears drafts and preserves existing mosaic and exclusion pixels", async () => {
      await setup(page, fixture.url); await page.evaluate(() => { addCtx.fillStyle = exclusionCtx.fillStyle = "#fff"; addCtx.fillRect(10, 10, 4, 4); exclusionCtx.fillRect(30, 30, 4, 4); markMaskDirty(); flushMaskComposition(); });
      const before = await layerSnapshot(page); await selectBoundaryTool(page, "#rectangleTool"); await drag(page, [{ x: 40, y: 40 }, { x: 100, y: 100 }]); await page.locator("#boundaryCancelButton").click();
      assert.equal(await page.evaluate(() => state.boundaryDrafts.length), 0); const after = await layerSnapshot(page); assert.equal(after.add, before.add); assert.equal(after.exclusion, before.exclusion); assert.equal(after.history, before.history);
    });

    await t.test("ED-024.1 detected boundary candidate exposes padding immediately and preserves outside edits", async () => {
      await setup(page, fixture.url); await page.evaluate(() => { addCtx.fillStyle = "#fff"; addCtx.fillRect(200, 200, 4, 4); state.manualEnabled = true; markMaskDirty(); flushMaskComposition(); });
      const outsideBefore = await page.evaluate(() => addCtx.getImageData(201, 201, 1, 1).data[3]);
      await selectBoundaryTool(page, "#rectangleTool"); await drag(page, [{ x: 40, y: 40 }, { x: 100, y: 100 }]);
      await page.evaluate(() => {
        const candidate = { id: "new-boundary", labelToken: "boundary", confidence: .8, role: "apply", enabled: true, forced: false, expandPx: 0, color: "#ff3d4d", source: "boundary", origin: "boundary", refinement: null };
        api = async (path) => {
          if (path === "/api/boundary") return { candidates: [candidate], candidateRevision: 5 };
          throw new Error(`unexpected direct-observation API: ${path}`);
        };
        reconcileCurrentCandidates = async () => { state.candidates = [candidate]; renderCandidates(); return true; };
      });
      await page.locator("#boundaryDetectButton").click();
      await page.waitForFunction(() => !state.boundaryPending && state.candidates.length > 0);
      const candidateId = await page.evaluate(() => state.candidates.at(-1).id); const paddingButton = page.locator(`[data-candidate-blink-id="${candidateId}"] .candidate-padding-button`);
      await paddingButton.click(); assert.equal(await page.locator("#candidatePaddingPopover").evaluate((node) => node.matches(":popover-open")), true); assert.equal(await page.locator("#candidatePaddingInput").isEditable(), true);
      assert.equal(await page.evaluate(() => addCtx.getImageData(201, 201, 1, 1).data[3]), outsideBefore); assert.equal(await page.evaluate(() => state.candidates.length), 1);
    });

    await t.test("ED-090.1 detection candidate mosaic addition is removed by one Undo", async () => {
      await setup(page, fixture.url);
      await page.evaluate(() => {
        const nativeApi = api; const nativeFetchBitmap = fetchBitmap;
        const detected = { id: "auto-undo", labelToken: "penis", confidence: .9, role: "apply", enabled: true, forced: false, expandPx: 0, color: "#ff3d4d", source: "auto", origin: "detect", refinement: null };
        const run = { applied: false, detectCalls: 0, jobCalls: 0, undoCalls: 0, startedAt: state.pageLoadedAt + 10 };
        window.__autoUndoRun = run;
        const nativeShowUserError = showUserError; showUserError = (error, invoker) => { run.error = { code: error?.code, message: error?.message }; return nativeShowUserError(error, invoker); };
        api = async (path, options = {}) => {
          if (path === "/api/detect") { run.detectCalls += 1; run.applied = true; return { ok: true }; }
          if (path === "/api/job") { run.jobCalls += 1; return { kind: "detect", state: "complete", total: 1, completed: 1, processed: 1, imageIds: ["sample"], completedImageIds: ["sample"], startedAt: run.startedAt }; }
          if (path === "/api/candidates/sample") return { candidates: run.applied ? [{ ...detected }] : [], candidateRevision: run.applied ? 91 : 90 };
          if (path === "/api/project/history/sample") return { canUndo: run.applied, canRedo: !run.applied };
          if (path === "/api/project/history/sample/undo") { run.undoCalls += 1; run.applied = false; return { canUndo: false, canRedo: true, changedImageIds: ["sample"], current: { candidateRevision: 90 } }; }
          if (path === "/api/images") {
            const snapshot = await nativeApi(path, options); const images = snapshot.images.map((image) => image.id === "sample" ? { ...image, width: 240, height: 240, candidateRevision: run.applied ? 91 : 90 } : image);
            return { ...snapshot, images, project: { id: "auto-history", status: "working" }, readOnly: false, historyDurable: true };
          }
          return nativeApi(path, options);
        };
        fetchBitmap = async (url, signal) => {
          if (String(url).includes("auto-undo")) { const mask = document.createElement("canvas"); mask.width = mask.height = 240; mask.getContext("2d").fillRect(40, 40, 60, 60); return mask; }
          return nativeFetchBitmap(url, signal);
        };
        state.project = { id: "auto-history", status: "working" }; state.projectReadOnly = false; state.historyDurable = true; state.projectHistory = new Map([["sample", { canUndo: false, canRedo: false }]]); updateActionButtons(); updateHistoryButtons();
      });
      await page.locator("#detectCurrentButton").click(); await page.waitForFunction(() => window.__autoUndoRun.detectCalls === 1 && state.job?.state === "running");
      await page.evaluate(() => pollJob());
      const afterDetection = await page.evaluate(() => ({ jobCalls: window.__autoUndoRun.jobCalls, candidates: state.candidates.length, canUndo: state.projectHistory.get("sample")?.canUndo, currentId: state.currentId, projectId: state.project?.id, error: window.__autoUndoRun.error || null }));
      assert.deepEqual(afterDetection, { jobCalls: 1, candidates: 1, canUndo: true, currentId: "sample", projectId: "auto-history", error: null });
      assert.equal(await page.evaluate(() => { flushMaskComposition(); return combinedCtx.getImageData(60, 60, 1, 1).data[3]; }), 255, "detection adds an enabled mosaic candidate");
      await page.locator("#undoButton").click(); await page.waitForFunction(() => window.__autoUndoRun.undoCalls === 1 && !state.projectHistoryBusy && state.candidates.length === 0);
      assert.deepEqual(await page.evaluate(() => { flushMaskComposition(); return { detectCalls: window.__autoUndoRun.detectCalls, jobCalls: window.__autoUndoRun.jobCalls, undoCalls: window.__autoUndoRun.undoCalls, candidates: state.candidates.length, alpha: combinedCtx.getImageData(60, 60, 1, 1).data[3], currentId: state.currentId, error: document.querySelector("#errorDialog")?.open }; }), { detectCalls: 1, jobCalls: 1, undoCalls: 1, candidates: 0, alpha: 0, currentId: "sample", error: false });
    });

    await t.test("ED-025.1 outside-image pointer input adds no mask candidate or history", async () => {
      await setup(page, fixture.url); const before = await layerSnapshot(page); await page.locator("#brushTool").click();
      await page.evaluate(() => { const rect = canvas.getBoundingClientRect(); canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 71, button: 0, buttons: 1, clientX: rect.left - 20, clientY: rect.top - 20 })); canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 71, button: 0, buttons: 0, clientX: rect.left - 20, clientY: rect.top - 20 })); });
      assert.deepEqual(await layerSnapshot(page), before);
    });

    await t.test("ED-027.1 active drag blocks image switching and drawing into another image", async () => {
      await setup(page, fixture.url); await page.locator("#brushTool").click(); const start = await imagePoint(page, 40, 40); const end = await imagePoint(page, 80, 40);
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y); await page.locator('.gallery-item[data-id="sample-two"]').dispatchEvent("click");
      assert.equal(await page.evaluate(() => state.currentId), "sample"); await page.mouse.up(); assert.equal(await page.evaluate(() => state.currentId), "sample");
    });

    await t.test("ED-028.1 and ED-028.2 Ctrl+Z waits for the active stroke and then undoes it", async () => {
      await setup(page, fixture.url); await page.locator("#brushTool").click(); const start = await imagePoint(page, 40, 40); const end = await imagePoint(page, 80, 40);
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y); await page.keyboard.press("Control+Z");
      assert.deepEqual(await page.evaluate(() => ({ drawing: state.drawing, history: state.history.length, index: state.historyIndex })), { drawing: true, history: 0, index: 0 });
      await page.mouse.up(); assert.deepEqual(await page.evaluate(() => [state.history.length, state.historyIndex]), [1, 1]); await page.keyboard.press("Control+Z"); await page.waitForFunction(() => state.historyIndex === 0);
      assert.equal(await page.evaluate(() => canvasHasPixels(addCtx, addCanvas)), false);
    });

    await t.test("ED-029.1 releasing outside the window stops later hover drawing", async () => {
      await setup(page, fixture.url); await page.locator("#brushTool").click(); const start = await imagePoint(page, 40, 40); const edge = await imagePoint(page, 70, 40);
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(edge.x, edge.y); await page.mouse.move(1279, 899); await page.mouse.up();
      const completed = await page.evaluate(() => ({ history: state.history.length, mask: addCanvas.toDataURL() })); const hover = await imagePoint(page, 160, 160); await page.mouse.move(hover.x, hover.y); await page.waitForTimeout(30);
      assert.deepEqual(await page.evaluate(() => ({ history: state.history.length, mask: addCanvas.toDataURL() })), completed);
    });

    await t.test("ED-031.1 middle drag pans image and masks without changing candidate count or mask shape", async () => {
      await setup(page, fixture.url); await page.evaluate(() => { addCtx.fillStyle = "#fff"; addCtx.fillRect(20, 20, 8, 8); state.candidates = [{ id: "one", role: "apply", enabled: true }]; render(); });
      const before = await page.evaluate(() => ({ view: { ...state.view }, add: addCanvas.toDataURL(), count: state.candidates.length })); await drag(page, [{ x: 60, y: 60 }, { x: 100, y: 90 }], "middle");
      const after = await page.evaluate(() => ({ view: { ...state.view }, add: addCanvas.toDataURL(), count: state.candidates.length })); assert.notDeepEqual(after.view, before.view); assert.equal(after.add, before.add); assert.equal(after.count, before.count);
    });

    await t.test("ED-032.1 editor canvas right-click suppresses the native menu and never paints", async () => {
      await setup(page, fixture.url); await page.locator("#brushTool").click(); const before = await layerSnapshot(page);
      const prevented = await page.evaluate(() => { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }); canvas.dispatchEvent(event); return event.defaultPrevented; });
      assert.equal(prevented, true); assert.deepEqual(await layerSnapshot(page), before);
    });

    await t.test("ED-105.1 all five point tools stamp once and one Undo reverses each click", async () => {
      for (const scenario of [
        { selector: "#brushTool", layer: "add", after: 255 },
        { selector: "#mosaicEraserTool", layer: "add", seed: "add", after: 0 },
        { selector: "#eraserTool", layer: "exclusion", after: 255 },
        { selector: "#excludeEraserTool", layer: "exclusionErase", seed: "exclusion", after: 255 },
      ]) {
        await setup(page, fixture.url);
        if (scenario.seed) await page.evaluate((seed) => { const target = seed === "add" ? addCtx : exclusionCtx; target.fillStyle = "#fff"; target.fillRect(0, 0, 240, 240); if (seed === "add") state.manualEnabled = true; else state.manualExclusionEnabled = true; resetHistoryToCurrentManualMask(); markMaskDirty(); flushMaskComposition(); }, scenario.seed);
        await page.locator(scenario.selector).click(); await clickImage(page, 100, 100); assert.equal(await layerAlpha(page, scenario.layer, 100, 100), scenario.after); assert.equal(await page.evaluate(() => state.history.length), 1);
        const circle = await page.evaluate(({ layer, seeded }) => {
          const context = ({ add: addCtx, exclusion: exclusionCtx, exclusionErase: exclusionEraseCtx })[layer]; const radius = Number($("#brushSize").value) / 2;
          const alpha = (x, y) => context.getImageData(x, y, 1, 1).data[3];
          return { radius, inside: [[100 + radius - 2, 100], [100 - radius + 2, 100], [100, 100 + radius - 2], [100, 100 - radius + 2]].map(([x, y]) => alpha(Math.round(x), Math.round(y))), outside: [[100 + radius + 2, 100], [100 - radius - 2, 100], [100, 100 + radius + 2], [100, 100 - radius - 2]].map(([x, y]) => alpha(Math.round(x), Math.round(y))), seeded };
        }, { layer: scenario.layer, seeded: Boolean(scenario.seed) });
        assert.ok(circle.inside.every((alpha) => alpha === scenario.after), `${scenario.selector} changes every cardinal pixel inside the cursor radius`);
        assert.ok(circle.outside.every((alpha) => alpha === (scenario.seed === "add" ? 255 : 0)), `${scenario.selector} changes no pixel outside the cursor radius`);
        await page.locator("#undoButton").click(); await page.waitForFunction(() => state.historyIndex === 0);
        assert.equal(await layerAlpha(page, scenario.layer, 100, 100), scenario.seed === "add" ? 255 : 0);
      }
      await setup(page, fixture.url); await selectBoundaryTool(page, "#boundaryBrushTool"); await clickImage(page, 100, 100); assert.equal(await page.evaluate(() => state.boundaryDrafts.length), 1);
      const boundaryCircle = await page.evaluate(() => { const draft = state.boundaryDrafts[0]; const radius = Number($("#brushSize").value) / 2; const center = transformImagePoint({ x: 100, y: 100 }); const pixel = (x, y) => [...boundaryOverlayCtx.getImageData(Math.round(state.view.x + x * state.view.scale), Math.round(state.view.y + y * state.view.scale), 1, 1).data]; return { radius, draftDiameter: draft.radius, width: draft.roi.right - draft.roi.left, height: draft.roi.bottom - draft.roi.top, center: pixel(center.x, center.y), outside: pixel(center.x + radius + 5, center.y) }; });
      assert.ok(Math.abs(boundaryCircle.draftDiameter - boundaryCircle.radius * 2) <= 1 && Math.abs(boundaryCircle.width - boundaryCircle.radius * 2) <= 2 && Math.abs(boundaryCircle.height - boundaryCircle.radius * 2) <= 2); assert.notDeepEqual(boundaryCircle.center, boundaryCircle.outside);
      await page.keyboard.press("Control+Z"); assert.equal(await page.evaluate(() => state.boundaryDrafts.length), 0, "boundary brush point is reversed by one Undo shortcut");
    });

    async function assertStrokeRoundTrip({ selector, layer, seed, points, control }) {
      await setup(page, fixture.url);
      if (seed) await page.evaluate((seed) => { const target = seed === "add" ? addCtx : exclusionCtx; target.fillStyle = "#fff"; target.fillRect(0, 0, 240, 240); if (seed === "add") state.manualEnabled = true; else state.manualExclusionEnabled = true; resetHistoryToCurrentManualMask(); markMaskDirty(); flushMaskComposition(); }, seed);
      await page.locator("#brushSize").fill("10"); await page.locator("#brushSize").dispatchEvent("input"); await page.locator(selector).click(); await drag(page, points);
      assert.equal(await layerAlpha(page, layer, control.x, control.y), seed === "add" && layer === "add" ? 255 : 0, "control pixel remains outside the circular sweep");
      const drawn = await page.evaluate((layer) => ({ add: addCanvas, exclusion: exclusionCanvas, exclusionErase: exclusionEraseCanvas })[layer].toDataURL(), layer);
      await page.locator("#undoButton").click(); await page.waitForFunction(() => state.historyIndex === 0); await page.locator("#redoButton").click(); await page.waitForFunction(() => state.historyIndex === 1);
      assert.equal(await page.evaluate((layer) => ({ add: addCanvas, exclusion: exclusionCanvas, exclusionErase: exclusionEraseCanvas })[layer].toDataURL(), layer), drawn, "Undo and Redo reproduce the exact stroke pixels");
    }

    await t.test("ED-107.1 straight mosaic stroke keeps control pixels and round-trips exactly", async () => assertStrokeRoundTrip({ selector: "#brushTool", layer: "add", points: [{ x: 40, y: 80 }, { x: 120, y: 80 }], control: { x: 80, y: 87 } }));
    await t.test("ED-108.1 right-angle mosaic stroke has no miter protrusion and round-trips exactly", async () => assertStrokeRoundTrip({ selector: "#brushTool", layer: "add", points: [{ x: 40, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 125 }], control: { x: 93, y: 67 } }));
    await t.test("ED-109.1 acute fast mosaic stroke has no miter protrusion and round-trips exactly", async () => assertStrokeRoundTrip({ selector: "#brushTool", layer: "add", points: [{ x: 40, y: 80 }, { x: 120, y: 80 }, { x: 55, y: 92 }], control: { x: 115, y: 88 } }));
    await t.test("ED-110.1 erasing and exclusion strokes keep control pixels and round-trip exactly", async () => {
      const shapes = [
        { points: [{ x: 40, y: 80 }, { x: 120, y: 80 }], control: { x: 80, y: 87 } },
        { points: [{ x: 40, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 125 }], control: { x: 93, y: 67 } },
        { points: [{ x: 40, y: 80 }, { x: 120, y: 80 }, { x: 55, y: 92 }], control: { x: 115, y: 88 } },
      ];
      for (const scenario of [
        { selector: "#mosaicEraserTool", layer: "add", seed: "add" },
        { selector: "#eraserTool", layer: "exclusion" },
        { selector: "#excludeEraserTool", layer: "exclusionErase", seed: "exclusion" },
      ]) for (const shape of shapes) await assertStrokeRoundTrip({ ...scenario, ...shape });
    });

    await t.test("ED-114.1 anonymous drawing fill deletion boundary and flip are one history step with buttons and shortcuts", async () => {
      const scenarios = ["brush", "fill", "candidate-delete", "boundary-candidate", "flip"];
      for (const [index, scenario] of scenarios.entries()) {
        await setup(page, fixture.url);
        await page.evaluate(() => {
          state.candidates = [
            { id: "apply", role: "apply", enabled: true, forced: false, expandPx: 0, color: "#fff" },
            { id: "exclude", role: "exclude", enabled: true, forced: true, expandPx: 0, color: "#000" },
          ];
          const mask = document.createElement("canvas"); mask.width = mask.height = 240; mask.getContext("2d").fillRect(180, 180, 4, 4);
          state.candidateImages = new Map(state.candidates.map((candidate) => [candidate.id, mask])); state.removedCandidateIds = new Set(); resetHistoryToCurrentManualMask();
          state.settings.shortcuts.bindings.undo = "Ctrl+Z"; state.settings.shortcuts.bindings.redo = "Ctrl+Shift+Z";
          queueImageMutation = async (_imageId, send) => send(); saveDraft = async () => {}; flushWorkspaceDraft = async () => {};
          syncProjectlessCandidateHistory = async () => true;
          refreshCandidateBitmap = async () => true;
          api = async (path) => path.endsWith("/transform") ? { image: { ...currentRecord() } } : { candidateRevision: Number(currentRecord().candidateRevision || 0) + 1 };
          syncLocalTransformFromHistory = async (_imageId, _generation, previousIndex, nextIndex) => {
            if (previousIndex !== nextIndex) currentRecord().flipH = nextIndex > previousIndex;
            return true;
          };
          restoreSnapshot = async (historyIndex) => {
            if (historyIndex < 0 || historyIndex > state.history.length || historyIndex === state.historyIndex) return;
            state.historyRestoreBusy = true; rebuildManualMaskFromHistory(historyIndex); state.historyIndex = historyIndex;
            state.historyRestoreBusy = false; updateHistoryButtons(); renderCandidates(); render();
          };
          renderCandidates();
        });
        if (scenario === "brush") {
          await page.locator("#brushTool").click(); await clickImage(page, 30, 30);
        } else await page.evaluate((kind) => {
          let operation = { kind };
          if (kind === "fill") { const spans = new Uint32Array([40, 40, 50]); applyFillSpans(spans, "bucket"); operation = { tool: "bucket", spans }; }
          if (kind === "candidate-toggle") state.candidates[0].enabled = false;
          if (kind === "candidate-force") state.candidates[1].forced = false;
          if (kind === "candidate-padding") state.candidates[0].expandPx = 7;
          if (kind === "candidate-delete") { state.removedCandidateIds.add("apply"); operation = { kind: "removeCandidates", ids: ["apply"] }; }
          if (kind === "candidate-batch") { state.candidates[0].enabled = false; state.candidates[1].enabled = false; operation = { kind: "candidateBatch" }; }
          if (kind === "boundary-candidate") { state.candidates.push({ id: "boundary", role: "apply", enabled: true, forced: false, expandPx: 0, color: "#f00" }); state.candidateImages.set("boundary", state.candidateImages.get("apply")); operation = { kind: "addCandidates", ids: ["boundary"] }; }
          if (kind === "flip") { currentRecord().flipH = true; operation = { kind: "transform", flipH: true, flipV: false }; }
          recordHistoryOperation(operation); renderCandidates(); render();
        }, scenario);
        assert.deepEqual(await page.evaluate(() => [state.history.length, state.historyIndex]), [1, 1], `${scenario} creates exactly one history entry`);
        const edited = await page.evaluate(() => JSON.stringify({ add: addCanvas.toDataURL(), editor: historyEditorState(), flipH: currentRecord().flipH === true }));
        if (index % 2 === 0) await page.locator("#undoButton").click(); else await page.keyboard.press("Control+Z");
        await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy);
        if (index % 2 === 0) {
          await page.evaluate(() => focusCanvas());
          await page.keyboard.press("Control+Shift+Z");
        } else await page.locator("#redoButton").click();
        await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy, null, { timeout: 5000 }); const redoState = await page.evaluate(() => ({ index: state.historyIndex, busy: state.historyRestoreBusy, actionPending: currentImageActionPending(), openDialog: hasOpenDialog(), active: document.activeElement?.id }));
        assert.equal(redoState.index, 1, `${scenario}: ${JSON.stringify(redoState)}`);
        assert.equal(await page.evaluate(() => JSON.stringify({ add: addCanvas.toDataURL(), editor: historyEditorState(), flipH: currentRecord().flipH === true })), edited, `${scenario} is restored exactly`);
      }
    });

    await t.test("ED-114.1 candidate toggle force padding and role batch are one button and shortcut history step", async () => {
      for (const [index, scenario] of ["toggle", "forced", "padding", "batch"].entries()) {
        await setup(page, fixture.url);
        await page.evaluate(() => {
          const mask = document.createElement("canvas"); mask.width = mask.height = 240; mask.getContext("2d").fillRect(20, 20, 20, 20);
          state.candidates = [
            { id: "apply", role: "apply", enabled: true, forced: false, expandPx: 0, color: "#fff", labelToken: "penis", confidence: .8 },
            { id: "exclude", role: "exclude", enabled: true, forced: true, expandPx: 0, color: "#000", labelToken: "hand", confidence: .8 },
          ];
          state.candidateImages = new Map([["apply", mask], ["exclude", mask]]); state.removedCandidateIds = new Set(); resetHistoryToCurrentManualMask();
          state.settings.shortcuts.bindings.undo = "Ctrl+Z"; state.settings.shortcuts.bindings.redo = "Ctrl+Shift+Z";
          api = async () => ({ candidateRevision: Number(currentRecord().candidateRevision || 0) + 1 }); refreshCandidateBitmap = async () => true;
          saveDraft = async () => {}; flushWorkspaceDraft = async () => {}; renderCandidates(); render();
        });
        if (scenario === "toggle") await page.locator('[data-candidate-blink-id="apply"] .candidate-toggle').click();
        if (scenario === "forced") await page.locator('[data-candidate-blink-id="exclude"] .candidate-forced').click();
        if (scenario === "padding") { await page.locator('[data-candidate-blink-id="apply"] .candidate-padding-button').click(); await page.locator("#candidatePaddingInput").fill("8"); await page.waitForFunction(() => state.candidatePaddingPreviewImages.has("apply")); assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "valid mask preview does not open an error dialog"); await page.locator("#candidatePaddingConfirm").click(); }
        if (scenario === "batch") await page.locator('[data-candidate-batch="apply:toggle"]').click();
        await page.waitForFunction(() => state.history.length === 1 && state.historyIndex === 1 && state.candidateUpdateChains.size === 0 && state.candidateBatchPending.size === 0);
        const edited = await page.evaluate(() => state.candidates.map(({ id, enabled, forced, expandPx }) => ({ id, enabled, forced, expandPx })));
        if (index % 2) await page.keyboard.press("Control+Z"); else await page.locator("#undoButton").click();
        await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy);
        if (index % 2) await page.locator("#redoButton").click(); else { await page.evaluate(() => focusCanvas()); await page.keyboard.press("Control+Shift+Z"); }
        await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
        assert.deepEqual(await page.evaluate(() => state.candidates.map(({ id, enabled, forced, expandPx }) => ({ id, enabled, forced, expandPx }))), edited, `${scenario} candidate state round-trips exactly`);
      }
    });

    await t.test("ED-116.1 and ED-116.2 anonymous reviewed and hidden toggles round-trip through history and catalog state", async () => {
      await setup(page, fixture.url);
      await page.evaluate(() => {
        state.settings.shortcuts.bindings.undo = "Ctrl+Z"; state.settings.shortcuts.bindings.redo = "Ctrl+Shift+Z";
        resetHistoryToCurrentManualMask();
      });
      for (const historyIndex of [1, 2]) {
        await page.locator('.gallery-item[data-id="sample"]').click({ button: "right" });
        await page.locator("#toggleReviewMenuItem").click();
        await page.waitForFunction((index) => state.historyIndex === index && state.imageMutationChains.size === 0, historyIndex);
      }
      assert.deepEqual(await page.evaluate(() => state.history.map(({ reviewedBefore, reviewedAfter }) => [reviewedBefore, reviewedAfter])), [[false, true], [true, false]], "explicit review actions capture their before and after choices");
      assert.deepEqual(await page.evaluate(() => [state.history.length, currentRecord().reviewed, state.reviewedImageIds.has(state.currentId)]), [2, false, false]);
      await page.locator("#undoButton").click(); await page.waitForFunction(() => state.historyIndex === 1); assert.deepEqual(await page.evaluate(() => [currentRecord().reviewed, state.reviewedImageIds.has(state.currentId)]), [true, true]);
      await page.evaluate(() => { document.querySelectorAll("[data-gallery-filter]").forEach((input) => { input.checked = input.dataset.galleryFilter === "reviewed"; }); document.querySelector('[data-gallery-filter="reviewed"]').dispatchEvent(new Event("change", { bubbles: true })); });
      assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), ["sample"], "reviewed filter shows only the reviewed image after Undo");
      await page.evaluate(() => focusCanvas()); await page.keyboard.press("Control+Shift+Z"); await page.waitForFunction(() => state.historyIndex === 2); assert.equal(await page.evaluate(() => currentRecord().reviewed), false);
      assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), [], "reviewed filter updates after Redo returns the image to unreviewed");
      await page.evaluate(() => { document.querySelectorAll("[data-gallery-filter]").forEach((input) => { input.checked = input.dataset.galleryFilter === "unreviewed"; }); document.querySelector('[data-gallery-filter="unreviewed"]').dispatchEvent(new Event("change", { bubbles: true })); });
      assert.deepEqual(new Set(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id))), new Set(["sample", "sample-two"]));
      await page.evaluate(() => resetHistoryToCurrentManualMask());
      for (const historyIndex of [1, 2]) {
        await page.locator("#removeCurrentImageButton").click();
        await page.waitForFunction((index) => state.historyIndex === index && state.imageMutationChains.size === 0, historyIndex);
      }
      await page.evaluate(() => focusCanvas()); await page.keyboard.press("Control+Z"); await page.waitForFunction(() => state.historyIndex === 1);
      assert.deepEqual(await page.evaluate(() => [currentRecord().hidden, state.hiddenImageIds.has(state.currentId)]), [true, true]);
      await page.evaluate(() => { document.querySelectorAll("[data-gallery-filter]").forEach((input) => { input.checked = input.dataset.galleryFilter === "hidden"; }); document.querySelector('[data-gallery-filter="hidden"]').dispatchEvent(new Event("change", { bubbles: true })); });
      assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), ["sample"], "hidden filter shows the hidden image after Undo");
      await page.locator("#redoButton").click(); await page.waitForFunction(() => state.historyIndex === 2);
      assert.deepEqual(await page.evaluate(() => [currentRecord().hidden, state.hiddenImageIds.has(state.currentId)]), [false, false]);
      assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), [], "hidden filter updates after Redo restores the image");
    });

    await t.test("ED-134.1 and ED-134.2 named project history preserves overview masks and selection", async () => {
      const thumbnailRoute = async (route) => { const url = new URL(route.request().url()); const stage = url.searchParams.get("v")?.endsWith("-2") ? 2 : 3; const color = stage === 2 ? "#20c060" : "#d040d0"; await route.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>` }); };
      await page.route("**/api/thumbnail/sample?*", thumbnailRoute);
      try {
        await setup(page, fixture.url); await page.evaluate(() => { state.project = { id: "named-ui", status: "working" }; state.projectReadOnly = false; state.historyDurable = true; state.settings.shortcuts.bindings.undo = "Ctrl+Z"; state.settings.shortcuts.bindings.redo = "Ctrl+Shift+Z"; state.projectHistory = new Map([["sample", { canUndo: false, canRedo: false }]]); });
        const snapshots = [];
        for (const action of [{ selector: "#brushTool", x: 40 }, { selector: "#eraserTool", x: 100 }, { selector: "#excludeEraserTool", x: 160 }]) {
          await page.locator(action.selector).click(); await clickImage(page, action.x, 100);
          snapshots.push(await page.evaluate(() => ({ add: addCanvas.toDataURL(), exclusion: exclusionCanvas.toDataURL(), exclusionErase: exclusionEraseCanvas.toDataURL(), manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualMaskPresent: true, manualExclusionForced: false, candidateRevision: Number(currentRecord()?.candidateRevision || 0), removedCandidateIds: [], hasEffectiveMask: true })));
        }
        assert.deepEqual(await page.evaluate(() => ({ durable: hasDurableHistory(), localHistory: state.history.length })), { durable: true, localHistory: 0 }, "named projects use server history instead of local snapshots");
        const edited = await page.evaluate(() => ({ add: [addCtx.getImageData(40, 100, 1, 1).data[3], addCtx.getImageData(200, 200, 1, 1).data[3]], exclusion: [exclusionCtx.getImageData(100, 100, 1, 1).data[3], exclusionCtx.getImageData(200, 200, 1, 1).data[3]], erase: [exclusionEraseCtx.getImageData(160, 100, 1, 1).data[3], exclusionEraseCtx.getImageData(200, 200, 1, 1).data[3]] }));
        await page.evaluate((drafts) => {
          const nativeApi = api; const run = { stage: 3, undoCalls: 0, redoCalls: 0, workspaceGets: 0, drafts };
          window.__durableOverviewRun = run;
          api = async (path, options = {}) => {
            if (path === "/api/project/history/sample") return { canUndo: run.stage === 3, canRedo: run.stage === 2 };
            if (path === "/api/project/history/sample/undo") { run.stage = 2; run.undoCalls += 1; return { canUndo: false, canRedo: true, changedImageIds: ["sample"], current: { candidateRevision: Number(currentRecord()?.candidateRevision || 0) } }; }
            if (path === "/api/project/history/sample/redo") { run.stage = 3; run.redoCalls += 1; return { canUndo: true, canRedo: false, changedImageIds: ["sample"], current: { candidateRevision: Number(currentRecord()?.candidateRevision || 0) } }; }
            if (path === "/api/workspace/manual/sample" && (!options.method || options.method === "GET")) { run.workspaceGets += 1; return { draft: structuredClone(run.drafts[run.stage - 1]) }; }
            if (path === "/api/images") {
              const snapshot = await nativeApi(path, options); const images = snapshot.images.map((image) => image.id === "sample" ? { ...image, width: 240, height: 240, hasEffectiveMask: true, assetVersion: `durable-mask-${run.stage}` } : image);
              return { ...snapshot, images, project: { id: "named-ui", status: "working" }, readOnly: false, historyDurable: true };
            }
            return nativeApi(path, options);
          };
          state.drafts.set("sample-two", { sentinel: "other-image-draft" }); state.projectHistory.set("sample", { canUndo: true, canRedo: false }); updateHistoryButtons();
        }, snapshots);
        await page.locator("#overviewButton").click(); await page.waitForFunction(() => state.viewMode === "overview"); await page.locator("#batchModeButton").click(); await page.locator('.overview-item[data-id="sample-two"]').click();
        const overviewPixel = async () => page.locator('.overview-item[data-id="sample"] img').evaluate(async (image) => { if (!image.complete) await new Promise((resolve) => image.addEventListener("load", resolve, { once: true })); const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; canvas.getContext("2d").drawImage(image, 0, 0, 1, 1); return [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data]; });
        assert.deepEqual(await page.evaluate(() => ({ viewMode: state.viewMode, currentId: state.currentId, selected: [...state.selectedImageIds], overviewCurrent: document.querySelector(".overview-item.current")?.dataset.id })), { viewMode: "overview", currentId: "sample", selected: ["sample-two"], overviewCurrent: "sample" });
        await page.evaluate(() => restoreProjectHistory("undo")); await page.waitForFunction(() => window.__durableOverviewRun.undoCalls === 1 && !state.projectHistoryBusy);
        assert.deepEqual(await page.evaluate(async () => { const draft = state.drafts.get("sample"); const source = await loadImage(draft.add); const probe = document.createElement("canvas"); probe.width = probe.height = 240; probe.getContext("2d").drawImage(source, 0, 0); return { pixels: [addCtx.getImageData(40, 100, 1, 1).data[3], exclusionCtx.getImageData(100, 100, 1, 1).data[3], exclusionEraseCtx.getImageData(160, 100, 1, 1).data[3]], sourceAlpha: probe.getContext("2d").getImageData(40, 100, 1, 1).data[3], distant: [addCtx.getImageData(200, 200, 1, 1).data[3], exclusionCtx.getImageData(200, 200, 1, 1).data[3], exclusionEraseCtx.getImageData(200, 200, 1, 1).data[3]], viewMode: state.viewMode, currentId: state.currentId, selected: [...state.selectedImageIds], anchor: state.selectionAnchorId, overviewCurrent: document.querySelector(".overview-item.current")?.dataset.id, otherDraft: state.drafts.get("sample-two")?.sentinel, workspaceGets: window.__durableOverviewRun.workspaceGets, restoredAdd: Boolean(draft?.add), maskedLabel: document.querySelector('.overview-item[data-id="sample"]')?.getAttribute("aria-label")?.includes(t("overview.stateMasked")) }; }), { pixels: [255, 255, 0], sourceAlpha: 255, distant: [0, 0, 0], viewMode: "overview", currentId: "sample", selected: ["sample-two"], anchor: "sample-two", overviewCurrent: "sample", otherDraft: "other-image-draft", workspaceGets: 1, restoredAdd: true, maskedLabel: true });
        assert.deepEqual((await overviewPixel()).slice(0, 3), [32, 192, 96], "overview renders the Undo mask thumbnail");
        await page.evaluate(() => restoreProjectHistory("redo")); await page.waitForFunction(() => window.__durableOverviewRun.redoCalls === 1 && !state.projectHistoryBusy);
        assert.deepEqual(await page.evaluate(() => ({ edited: { add: [addCtx.getImageData(40, 100, 1, 1).data[3], addCtx.getImageData(200, 200, 1, 1).data[3]], exclusion: [exclusionCtx.getImageData(100, 100, 1, 1).data[3], exclusionCtx.getImageData(200, 200, 1, 1).data[3]], erase: [exclusionEraseCtx.getImageData(160, 100, 1, 1).data[3], exclusionEraseCtx.getImageData(200, 200, 1, 1).data[3]] }, viewMode: state.viewMode, currentId: state.currentId, selected: [...state.selectedImageIds], overviewCurrent: document.querySelector(".overview-item.current")?.dataset.id, otherDraft: state.drafts.get("sample-two")?.sentinel })), { edited, viewMode: "overview", currentId: "sample", selected: ["sample-two"], overviewCurrent: "sample", otherDraft: "other-image-draft" });
        assert.deepEqual((await overviewPixel()).slice(0, 3), [208, 64, 208], "overview renders the Redo mask thumbnail");
      } finally { await page.unroute("**/api/thumbnail/sample?*", thumbnailRoute); }
    });

    await t.test("ED-119.1 failed individual and batch candidate controls restore state without history", async () => {
      for (const scenario of ["toggle", "forced", "padding", "batch"]) for (const failure of ["disconnect", "stale_catalog"]) {
        await setup(page, fixture.url);
        await page.evaluate((failure) => {
          const mask = document.createElement("canvas"); mask.width = mask.height = 240; mask.getContext("2d").fillRect(20, 20, 20, 20);
          state.candidates = [
            { id: "apply", role: "apply", enabled: true, forced: false, expandPx: 0, color: "#fff", labelToken: "penis", confidence: .8 },
            { id: "exclude", role: "exclude", enabled: true, forced: true, expandPx: 0, color: "#000", labelToken: "hand", confidence: .8 },
          ];
          state.candidateImages = new Map([["apply", mask], ["exclude", mask]]); state.removedCandidateIds = new Set(); resetHistoryToCurrentManualMask();
          setCandidateDisplayMode(["apply"], "normal"); state.blinkPhase = true; state.mosaicPreviewEnabled = false; mosaicCtx.fillStyle = "#345"; mosaicCtx.fillRect(0, 0, 8, 8);
          const baseline = state.candidates.map((candidate) => ({ ...candidate }));
          window.__candidateFailureRequests = [];
          api = async (path, options = {}) => { window.__candidateFailureRequests.push({ path, method: options.method }); const error = new TypeError(failure === "disconnect" ? "Failed to fetch" : "stale"); if (failure !== "disconnect") error.code = failure; throw error; };
          reconcileCurrentCandidates = async () => { state.candidates = baseline.map((candidate) => ({ ...candidate })); renderCandidates(); render(); return true; };
          flushMaskComposition(); renderCandidates(); render();
        }, failure);
        const snapshot = () => page.evaluate(() => { flushRender(); return ({ candidates: state.candidates.map(({ id, enabled, forced, expandPx }) => ({ id, enabled, forced, expandPx })), history: [state.history.length, state.historyIndex], mask: combinedCanvas.toDataURL(), reviewed: currentRecord().reviewed === true, range: { ids: [...state.blinkCandidateIds], modes: [...state.blinkModes.entries()] }, preview: { enabled: state.mosaicPreviewEnabled, pixels: mosaicCanvas.toDataURL() }, list: [...document.querySelectorAll("#candidatePane .candidate-row")].map((row) => ({ id: row.dataset.candidateBlinkId, className: row.className, controls: [...row.querySelectorAll("button")].map((button) => [button.className, button.getAttribute("aria-pressed"), button.disabled]) })) }); });
        const before = await snapshot();
        if (scenario === "toggle") await page.locator('[data-candidate-blink-id="apply"] .candidate-toggle').click();
        if (scenario === "forced") await page.locator('[data-candidate-blink-id="exclude"] .candidate-forced').click();
        if (scenario === "padding") { await page.locator('[data-candidate-blink-id="apply"] .candidate-padding-button').click(); await page.locator("#candidatePaddingInput").fill("8"); await page.waitForFunction(() => state.candidatePaddingPreviewImages.has("apply")); assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "valid mask preview does not open an error dialog"); await page.locator("#candidatePaddingConfirm").click(); }
        if (scenario === "batch") await page.locator('[data-candidate-batch="apply:toggle"]').click();
        await page.waitForFunction(() => state.candidateUpdateChains.size === 0 && state.candidateBatchPending.size === 0 && !candidateControlLocked(state.currentId) && state.candidatePaddingPreviewImages.size === 0);
        const after = await snapshot();
        assert.ok(await page.evaluate(() => window.__candidateFailureRequests.some(({ path, method }) => method === "POST" && (path.startsWith("/api/candidate/") || path === "/api/candidates/batch"))), `${scenario} ${failure} reaches its intended candidate mutation failure`);
        assert.deepEqual(after, before, `${scenario} ${failure} restores range, preview, list, candidate, review and history state`);
      }
    });

    await t.test("ED-093.1 through ED-096.1 three 4K ranges survive Undo Redo and five UI image round-trips", async () => {
      await setup(page, fixture.url, 4096);
      await page.evaluate(() => {
        window.__directRangeCounter = 0; window.__directLatestCandidate = null; window.__releasedCandidateRanges = 0;
        const nativeApi = api;
        api = async (path, options = {}) => {
          if (path === "/api/boundary") {
            const index = window.__directRangeCounter++;
            const candidate = { id: `range-${index}`, labelToken: "boundary", confidence: .8, role: "apply", enabled: true, forced: false, expandPx: 0, color: "#ff3d4d", source: "boundary", origin: "boundary", refinement: null };
            window.__directLatestCandidate = candidate; return { candidates: [candidate], candidateRevision: 10 + index };
          }
          if (path === "/api/candidates/sample" && window.__directRangeCandidates) return { candidates: window.__directRangeCandidates.map((candidate) => ({ ...candidate })), candidateRevision: 20 };
          if (path === "/api/candidates/sample-two") return { candidates: [], candidateRevision: 0 };
          if (path.startsWith("/api/candidate/")) return { candidateRevision: (currentRecord().candidateRevision || 12) + 1 };
          return nativeApi(path, options);
        };
        reconcileCurrentCandidates = async () => {
          const candidate = window.__directLatestCandidate;
          if (candidate && !state.candidates.some((item) => item.id === candidate.id)) {
            state.candidates.push(candidate);
            const mask = document.createElement("canvas"); mask.width = mask.height = 4096;
            const index = Number(candidate.id.split("-").at(-1)); mask.getContext("2d").fillRect(100 + index * 600, 100 + index * 600, 32, 32);
            mask.close = () => { window.__releasedCandidateRanges += 1; };
            state.candidateImages.set(candidate.id, mask);
          }
          renderCandidates(); render(); return true;
        };
        refreshCandidateBitmap = async () => true;
        queueImageMutation = async (_imageId, send) => send();
        saveDraft = async () => {};
        flushWorkspaceDraft = async () => {};
      });
      for (const [index, region] of [[0, [100, 100, 300, 300]], [1, [800, 800, 1000, 1000]], [2, [1500, 1500, 1700, 1700]]]) {
        await selectBoundaryTool(page, "#rectangleTool"); await drag(page, [{ x: region[0], y: region[1] }, { x: region[2], y: region[3] }]); await page.locator("#boundaryDetectButton").click();
        await page.waitForFunction((count) => !state.boundaryPending && state.candidates.length === count, index + 1);
        assert.equal(await page.locator("#candidateList .candidate-row").count(), index + 1);
        assert.deepEqual(await page.evaluate(() => [...state.candidateImages.values()].map((mask) => [mask.width, mask.height])), Array.from({ length: index + 1 }, () => [4096, 4096]));
        await page.evaluate(() => { if (state.blinkTimer) clearInterval(state.blinkTimer); setCandidateDisplayMode(state.candidates.map((candidate) => candidate.id), "normal"); state.blinkPhase = true; renderNow(); });
        for (let visibleIndex = 0; visibleIndex <= index; visibleIndex += 1) assert.notDeepEqual(await renderedPixel(page, 110 + visibleIndex * 600, 110 + visibleIndex * 600), [119, 136, 153, 255], `range ${visibleIndex} remains rendered after adding range ${index}`);
      }
      await page.evaluate(() => { state.candidates[1].enabled = false; resetHistoryToCurrentManualMask(); renderCandidates(); });
      await page.evaluate(async () => { const candidate = state.candidates[2]; candidate.expandPx = 9; if (await updateCandidate(candidate, candidate.enabled, state.maskStatus.get(state.currentId), candidate.forced, 0)) recordHistoryOperation({ kind: "candidateState" }); });
      await page.waitForFunction(() => state.history.length === 1 && state.candidates[2].expandPx === 9);
      assert.deepEqual(await page.evaluate(() => state.candidates.map(({ id, enabled, expandPx }) => ({ id, enabled, expandPx }))), [
        { id: "range-0", enabled: true, expandPx: 0 }, { id: "range-1", enabled: false, expandPx: 0 }, { id: "range-2", enabled: true, expandPx: 9 },
      ]);
      await page.locator("#undoButton").click(); await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy); const undoState = await page.evaluate(() => ({ index: state.historyIndex, length: state.history.length, drafts: state.boundaryDrafts.length, pending: state.historyRestoreBusy, expand: state.candidates[2].expandPx, error: document.querySelector("#errorDialog")?.open })); assert.equal(undoState.index, 0, JSON.stringify(undoState)); assert.equal(undoState.expand, 0);
      assert.equal(await page.evaluate(() => state.candidates.slice(0, 2).every((candidate) => state.candidateImages.has(candidate.id))), true);
      await page.evaluate(() => { setCandidateDisplayMode(state.candidates.slice(0, 2).map((candidate) => candidate.id), "normal"); state.blinkPhase = true; renderNow(); });
      for (const point of [110, 710]) assert.notDeepEqual(await renderedPixel(page, point, point), [119, 136, 153, 255], "an unchanged candidate range remains visible during Undo");
      await page.locator("#redoButton").click(); await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
      assert.equal(await page.evaluate(() => state.candidates[2].expandPx), 9);
      for (const point of [110, 710]) assert.notDeepEqual(await renderedPixel(page, point, point), [119, 136, 153, 255], "an unchanged candidate range remains visible during Redo");

      await page.evaluate(() => {
        const record = currentRecord(); record.candidateRevision = 20; record.candidateCount = 3; record.enabledCandidateCount = 2;
        window.__directRangeCandidates = state.candidates.map((candidate) => ({ ...candidate })); window.__directRangeMasks = new Map(state.candidateImages);
        fetchBitmap = async (url) => window.__directRangeMasks.get([...window.__directRangeMasks.keys()].find((id) => String(url).includes(encodeURIComponent(id)))) || document.createElement("canvas");
        state.imageCache.set(imageCacheKey(record), state.currentImage, 4096 * 4096 * 4);
        state.candidateBundleCache.set(candidateCacheKey(record.id, record.candidateRevision), { candidates: state.candidates, candidateImages: state.candidateImages, candidateRevision: record.candidateRevision }, 4096 * 4096 * 3);
        state.mosaicPreviewEnabled = false; releaseMosaicPreview();
        state.imageMutationChains.clear(); state.candidateUpdateChains.clear(); state.candidateControlLocks.clear();
        updateActionButtons(); renderCandidates();
      });
      for (let cycle = 0; cycle < 5; cycle += 1) {
        await page.locator('.gallery-item[data-id="sample-two"]').dispatchEvent("click"); await page.waitForFunction(() => state.currentId === "sample-two" && state.pendingImageId === null);
        const switched = await page.evaluate(() => ({ currentId: state.currentId, pendingId: state.pendingImageId, busy: isBusy(), actionPending: currentImageActionPending(), gesture: isGestureActive(), locks: [...state.candidateControlLocks.entries()], chains: state.imageMutationChains.size }));
        assert.equal(switched.currentId, "sample-two", `cycle ${cycle}: ${JSON.stringify(switched)}`);
        assert.deepEqual(await page.evaluate(() => ({ released: window.__releasedCandidateRanges, retainedCurrent: state.candidateImages.size, retainedBundles: [...state.candidateBundleCache.items.keys()].filter((key) => key.startsWith("sample:")).length })), { released: (cycle + 1) * 3, retainedCurrent: 0, retainedBundles: 0 }, `cycle ${cycle} releases all prior candidate range images without retaining an old bundle`);
        await page.locator('.gallery-item[data-id="sample"]').dispatchEvent("click"); await page.waitForFunction(() => state.currentId === "sample" && state.pendingImageId === null && state.candidates.length === 3);
        const switchedBack = await page.evaluate(() => ({ currentId: state.currentId, pendingId: state.pendingImageId, candidates: state.candidates.length, busy: isBusy(), actionPending: currentImageActionPending(), gesture: isGestureActive() }));
        assert.deepEqual(switchedBack, { currentId: "sample", pendingId: null, candidates: 3, busy: false, actionPending: false, gesture: false }, `cycle ${cycle}: ${JSON.stringify(switchedBack)}`);
        assert.deepEqual(await page.evaluate(() => state.candidates.map(({ id, enabled, expandPx }) => ({ id, enabled, expandPx }))), [
          { id: "range-0", enabled: true, expandPx: 0 }, { id: "range-1", enabled: false, expandPx: 0 }, { id: "range-2", enabled: true, expandPx: 9 },
        ]);
        assert.equal(await page.evaluate(() => state.candidateImages.size), 3);
      }
      assert.equal(await page.evaluate(() => window.__releasedCandidateRanges), 15, "every round-trip releases all three obsolete full-size candidate range images");
    });

    await t.test("ED-106.1 every 4K brush keeps preview copies bounded with many candidates", async () => {
      await setup(page, fixture.url, 4096);
      await page.evaluate(() => {
        const sharedMask = document.createElement("canvas"); sharedMask.width = sharedMask.height = 4096; sharedMask.getContext("2d").fillRect(0, 0, 16, 16);
        state.candidates = Array.from({ length: 24 }, (_, index) => ({ id: `load-${index}`, role: index % 2 ? "exclude" : "apply", enabled: true, forced: true, expandPx: 0 }));
        state.candidateImages = new Map(state.candidates.map((candidate) => [candidate.id, sharedMask]));
        window.__directBrushCopies = { fullCompose: 0, fullBitmap: 0, blobs: 0, patchBitmap: 0 };
        const nativeCompose = composeCurrentMask; composeCurrentMask = (roi) => { if (state.activeStroke && !roi) window.__directBrushCopies.fullCompose += 1; return nativeCompose(roi); };
        const nativeBitmap = createImageBitmap; createImageBitmap = (...args) => { if (state.activeStroke && args[0] === combinedCanvas) { if (args.length === 1) window.__directBrushCopies.fullBitmap += 1; else window.__directBrushCopies.patchBitmap += 1; } return nativeBitmap(...args); };
        const nativeBlob = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function(...args) { if (state.activeStroke) window.__directBrushCopies.blobs += 1; return nativeBlob.apply(this, args); };
        state.mosaicPreviewEnabled = true; requestMosaicPreview(); renderCandidates();
      });
      await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
      for (const scenario of [
        { selector: "#brushTool" }, { selector: "#mosaicEraserTool", seed: "add" }, { selector: "#eraserTool" }, { selector: "#excludeEraserTool", seed: "exclusion" }, { selector: "#boundaryBrushTool", boundary: true },
      ]) {
        await page.evaluate((seed) => { for (const context of [addCtx, exclusionCtx, exclusionEraseCtx]) context.clearRect(0, 0, 4096, 4096); if (seed) { const target = seed === "add" ? addCtx : exclusionCtx; target.fillStyle = "#fff"; target.fillRect(0, 0, 4096, 4096); } state.history = []; state.historyIndex = 0; clearBoundaryInteraction(); window.__directBrushCopies.fullCompose = window.__directBrushCopies.fullBitmap = window.__directBrushCopies.blobs = window.__directBrushCopies.patchBitmap = 0; markMaskDirty(); flushMaskComposition(); }, scenario.seed || "");
        if (scenario.boundary) await selectBoundaryTool(page, scenario.selector); else await page.locator(scenario.selector).click();
        await drag(page, [{ x: 1800, y: 1000 }, { x: 2100, y: 1000 }]); await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
        const endpoint = await imagePoint(page, 2100, 1000); const cursorBox = await page.locator("#brushCursor").boundingBox();
        assert.ok(cursorBox, `${scenario.selector} keeps the full-screen brush overlay visible`); assert.ok(Math.abs(cursorBox.x + cursorBox.width / 2 - endpoint.x) <= 1 && Math.abs(cursorBox.y + cursorBox.height / 2 - endpoint.y) <= 1, `${scenario.selector} overlay follows the final pointer position`);
        const copies = await page.evaluate(() => ({ ...window.__directBrushCopies, candidates: state.candidates.length }));
        assert.equal(copies.candidates, 24); assert.equal(copies.fullCompose, 0, `${scenario.selector} does not compose the full mask while dragging`); assert.equal(copies.fullBitmap, 0); assert.equal(copies.blobs, 0);
        if (!scenario.boundary) assert.ok(copies.patchBitmap > 0, `${scenario.selector} updates one or more cropped preview patches`);
      }
    });
  } finally { await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server); }
});
