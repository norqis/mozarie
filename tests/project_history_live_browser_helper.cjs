"use strict";

// This helper is intentionally not named test_*.cjs.  It is launched by the
// Windows-owned unittest fixture below so Playwright talks to the real Python
// HTTP server and its SQLite workspace instead of a JavaScript API substitute.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const [origin, sourcePath] = process.argv.slice(2);

async function waitForEditor(page) {
  const imageId = await page.locator(".gallery-item").first().getAttribute("data-id");
  assert.ok(imageId, "the imported image has a gallery item");
  // Selection itself is already covered by the gallery contract.  Calling the
  // gallery entry point also catches application-start work that could
  // otherwise discard a real user's first selection.
  await page.waitForFunction(() => !state.projectOperationPending && !isGestureActive());
  await page.locator(`.gallery-item[data-id="${imageId}"]`).click();
  try {
    await page.waitForFunction(() => state.currentId && state.currentImage && hasDurableHistory());
  } catch (error) {
    console.error("editor did not load", await page.evaluate(() => ({
      currentId: state.currentId, imageCount: state.images.length, durable: state.historyDurable,
      imageAction: state.imageActionPending, status: state.status, errorOpen: $("#errorDialog")?.open,
      projectOperationPending: state.projectOperationPending, gestureActive: isGestureActive(), busy: isBusy(), importing: state.importing,
      pendingImageId: state.pendingImageId, pendingImageKey: state.pendingImageKey, pendingCandidateKey: state.pendingCandidateKey,
      imageGeneration: state.imageGeneration, catalogEpoch: state.catalogEpoch,
      images: state.images.map((image) => ({ id: image.id, assetVersion: image.assetVersion, candidateRevision: image.candidateRevision })),
      gallery: [...document.querySelectorAll(".gallery-item")].map((item) => ({ id: item.dataset.id, disabled: item.disabled, text: item.textContent })),
    })));
    throw error;
  }
}

async function stroke(page, tool, point) {
  await page.evaluate(async ({ tool, point }) => {
    state.tool = tool;
    $("#brushSize").value = "4";
    beginManualStroke(point);
    completeManualStroke();
    await flushWorkspaceDraft(state.currentId);
    await refreshProjectHistory(state.currentId);
  }, { tool, point });
}

async function layersAt(page, point, farPoint) {
  return page.evaluate(({ point, farPoint }) => {
    const alpha = (context, x, y) => context.getImageData(x, y, 1, 1).data[3];
    return {
      currentId: state.currentId,
      view: { ...state.view },
      add: alpha(addCtx, point.add.x, point.add.y),
      exclusion: alpha(exclusionCtx, point.exclusion.x, point.exclusion.y),
      exclusionErase: alpha(exclusionEraseCtx, point.exclusionErase.x, point.exclusionErase.y),
      far: [alpha(addCtx, farPoint.x, farPoint.y), alpha(exclusionCtx, farPoint.x, farPoint.y), alpha(exclusionEraseCtx, farPoint.x, farPoint.y)],
    };
  }, { point, farPoint });
}

async function main() {
  assert.ok(origin && sourcePath, "usage: project_history_live_browser_helper.cjs <origin> <absolute-source-path>");
  const browser = await chromium.launch();
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/workspace/manual/") || request.url().includes("/api/project/history/")) {
        requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });

    await page.goto(origin, { waitUntil: "domcontentloaded" });
    // `initialise()` fetches the empty catalogue after settings.  Wait for
    // that snapshot before changing it, otherwise the deliberately guarded
    // mutation would correctly reject this helper as stale.
    await page.waitForFunction(() => state.settings && state.images.length === 0 && Number.isSafeInteger(state.serverCatalogGeneration) && !document.querySelector("#errorDialog")?.open);
    // This is the real product API, authenticated by the page's real session
    // token.  Do not replace fetch: the test must cross HTTP framing, handler,
    // StudioState, SQLite, PNG encoding, and browser image decoding.
    await page.evaluate(async (path) => { await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) }); }, sourcePath);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 1 && state.historyDurable === true);
    await waitForEditor(page);

    const points = {
      add: { x: 6, y: 7 },
      exclusion: { x: 21, y: 12 },
      exclusionErase: { x: 38, y: 24 },
    };
    const farPoint = { x: 60, y: 42 };
    await stroke(page, "brush", points.add);
    await stroke(page, "eraser", points.exclusion);
    await stroke(page, "exclude_eraser", points.exclusionErase);
    try {
      await page.waitForFunction(() => document.querySelector("#undoButton")?.disabled === false);
    } catch (error) {
      console.error("history did not become undoable", await page.evaluate(() => ({
        history: state.projectHistory.get(state.currentId), currentId: state.currentId,
        draft: state.drafts.get(state.currentId), errorOpen: $("#errorDialog")?.open,
      })), await page.evaluate(() => api(`/api/project/history/${encodeURIComponent(state.currentId)}`)), requests);
      throw error;
    }

    let pixels = await layersAt(page, points, farPoint);
    assert.ok(pixels.add > 0, "the durable apply layer contains only its hand-drawn point");
    assert.ok(pixels.exclusion > 0, "the durable exclusion layer contains only its hand-drawn point");
    assert.ok(pixels.exclusionErase > 0, "the durable exclusion-erase layer contains only its hand-drawn point");
    assert.deepEqual(pixels.far, [0, 0, 0], "the far-away pixels remain transparent in every manual layer");

    await page.evaluate(() => { state.view = { scale: 1.7, x: 31, y: -19 }; render(); });
    const selectedId = pixels.currentId;
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => document.querySelector("#redoButton")?.disabled === false && state.projectHistoryBusy === false);
    pixels = await layersAt(page, points, farPoint);
    assert.equal(pixels.currentId, selectedId, "undo keeps the selected image");
    assert.deepEqual(pixels.view, { scale: 1.7, x: 31, y: -19 }, "undo keeps zoom and pan");
    assert.ok(pixels.add > 0 && pixels.exclusion > 0, "undo keeps earlier localized layers");
    assert.equal(pixels.exclusionErase, 0, "undo removes only the latest localized layer");
    assert.deepEqual(pixels.far, [0, 0, 0], "undo never turns a transparent far pixel opaque");

    // Reload after the database cursor changed.  Redo must restore the same
    // persisted PNG through a fresh HTTP/browser decode path, not a live canvas.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 1 && state.historyDurable === true);
    await waitForEditor(page);
    await page.waitForFunction(() => document.querySelector("#redoButton")?.disabled === false);
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => document.querySelector("#redoButton")?.disabled === true && state.projectHistoryBusy === false);
    pixels = await layersAt(page, points, farPoint);
    assert.ok(pixels.add > 0 && pixels.exclusion > 0 && pixels.exclusionErase > 0, "redo restores all three localized durable layers");
    assert.deepEqual(pixels.far, [0, 0, 0], "redo keeps the distant canvas transparent");

    assert.ok(requests.some((request) => request.includes("/api/workspace/manual/")), "hand drawing used the real workspace upload route");
    assert.ok(requests.some((request) => request.endsWith("/undo")), "undo used the real history route");
    assert.ok(requests.some((request) => request.endsWith("/redo")), "redo used the real history route after reload");
  } finally {
    await context?.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
