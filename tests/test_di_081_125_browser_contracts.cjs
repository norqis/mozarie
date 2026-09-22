"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function openCatalogue(browser, fixture, count) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((expected) => state.settings && state.images.length === expected, count);
  return { context, page };
}

test("DI-083 exclusion brush paints live without adding a mosaic stroke", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#eraserTool").click();
    const point = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      const logical = { x: Math.floor(state.currentImage.width / 2), y: Math.floor(state.currentImage.height / 2) };
      return {
        logical,
        x: rect.left + state.view.x + logical.x * state.view.scale,
        y: rect.top + state.view.y + logical.y * state.view.scale,
      };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 8, { steps: 8 });
    await page.waitForFunction(({ x, y }) => state.activeStroke
      && exclusionCtx.getImageData(x, y, 1, 1).data[3] > 0, point.logical);
    assert.deepEqual(await page.evaluate(({ x, y }) => ({
      active: Boolean(state.activeStroke),
      exclusion: exclusionCtx.getImageData(x, y, 1, 1).data[3],
      mosaic: addCtx.getImageData(x, y, 1, 1).data[3],
      exclusionEnabled: state.manualExclusionEnabled,
    }), point.logical), { active: true, exclusion: 255, mosaic: 0, exclusionEnabled: true },
    "the visible exclusion layer changes before pointerup and the mosaic-add layer stays empty");
    await page.mouse.up();
    await page.waitForFunction(() => !state.activeStroke);
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-084 compare view paints the same logical point in both panes before pointerup", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    const geometry = await page.evaluate(async () => {
      const source = document.createElement("canvas"); source.width = 100; source.height = 80;
      const sourceContext = source.getContext("2d"); sourceContext.fillStyle = "#ffffff"; sourceContext.fillRect(0, 0, 100, 80);
      sourceContext.fillStyle = "#000000"; for (let x = 0; x < 100; x += 4) sourceContext.fillRect(x, 0, 2, 80);
      state.currentImage = await createImageBitmap(source);
      const record = currentRecord(); record.width = 100; record.height = 80;
      canvasSizeForImage(record); prepareOriginalImage(); resetCurrentDraft();
      state.compareSplit = .5; state.displayMode = "compare"; state.mosaicPreviewEnabled = true; fitImage(); requestMosaicPreview();
      const rect = canvas.getBoundingClientRect(); const logical = { x: 48, y: 40 };
      const rightOffset = stage.clientWidth * state.compareSplit;
      return {
        logical, rightOffset,
        mapped: (() => {
          const y = rect.top + state.view.y + logical.y * state.view.scale;
          state.gestureDisplaySide = null;
          const left = pointFromEvent({ clientX: rect.left + state.view.x + logical.x * state.view.scale, clientY: y }, rect);
          state.gestureDisplaySide = null;
          const right = pointFromEvent({ clientX: rect.left + rightOffset + state.view.x + logical.x * state.view.scale, clientY: y }, rect);
          state.gestureDisplaySide = null;
          return { left, right };
        })(),
        x: rect.left + rightOffset + state.view.x + logical.x * state.view.scale,
        y: rect.top + state.view.y + logical.y * state.view.scale,
      };
    });
    await page.waitForFunction(() => !state.mosaicWorkerBusy && !state.mosaicPreviewRequested);
    await page.locator("#brushTool").click();
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.x + 16, geometry.y + 4, { steps: 6 });
    await page.waitForFunction(({ x, y }) => state.activeStroke
      && addCtx.getImageData(x, y, 1, 1).data[3] === 255
      && mosaicCtx.getImageData(x, y, 1, 1).data.some((value, index) => value !== originalCtx.getImageData(x, y, 1, 1).data[index]), geometry.logical);
    const pixels = await page.evaluate(({ logical, rightOffset }) => {
      const ratio = window.devicePixelRatio || 1;
      const sample = (offset) => [...ctx.getImageData(
        Math.round((offset + state.view.x + logical.x * state.view.scale) * ratio),
        Math.round((state.view.y + logical.y * state.view.scale) * ratio), 1, 1,
      ).data];
      return { active: Boolean(state.activeStroke), mask: addCtx.getImageData(logical.x, logical.y, 1, 1).data[3], left: sample(0), right: sample(rightOffset) };
    }, geometry);
    assert.equal(pixels.active, true);
    assert.equal(pixels.mask, 255);
    const coordinatePixels = await page.evaluate(({ logical }) => ({
      original: [...originalCtx.getImageData(logical.x, logical.y, 1, 1).data],
      preview: [...mosaicCtx.getImageData(logical.x, logical.y, 1, 1).data],
    }), geometry);
    for (const side of [geometry.mapped.left, geometry.mapped.right]) {
      assert(Math.abs(side.x - geometry.logical.x) < 0.01 && Math.abs(side.y - geometry.logical.y) < 0.01,
        `both panes resolve to the same image coordinate: ${JSON.stringify(geometry.mapped)}`);
    }
    assert.notDeepEqual(pixels.right, pixels.left,
      "the processed pane changes while both panes stay aligned to the same image coordinate");
    assert.notDeepEqual(coordinatePixels.preview, coordinatePixels.original,
      "the live stroke is already visible before pointerup");
    await page.mouse.up();
    await page.waitForFunction(() => !state.activeStroke && !state.mosaicWorkerBusy && !state.mosaicPending);
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-081 deleted project loses every browser source handle while another project is preserved", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/project/deleted-project", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, catalogGeneration: 42 }) }));
    const result = await page.evaluate(async () => {
      const file = (name) => ({ kind: "file", name });
      const directory = (name) => ({ kind: "directory", name });
      await rememberProjectSource("deleted-project", directory("deleted-root"), null, "deleted-directory");
      await rememberProjectSource("deleted-project", file("A.png"), "image-a", "deleted-file", "client-a", "A.png");
      await rememberProjectSource("other-project", directory("other-root"), null, "other-directory");
      await rememberProjectSource("other-project", file("B.png"), "image-b", "other-file", "client-b", "B.png");
      const intentId = await rememberProjectSourceCleanup("deleted-project");
      const removed = await forgetProjectSources("deleted-project");
      const deleted = await rememberedProjectSources("deleted-project");
      const other = await rememberedProjectSources("other-project");
      const db = await directoryCatalogStore();
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction("projectSources").objectStore("projectSources").getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      const cleanup = await new Promise((resolve) => {
        const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY);
        request.onsuccess = () => resolve(request.result || {});
        request.onerror = () => resolve({});
      });
      db.close();
      return { removed, intentId, deleted, other, rows, cleanup };
    });
    assert.equal(result.removed, true);
    assert.deepEqual(result.deleted, { files: [], directories: [] },
      "the deleted project's browser file and directory handles are removed");
    assert.deepEqual(result.other.files.map((row) => row.imageId), ["image-b"]);
    assert.deepEqual(result.other.directories.map((row) => row.sourceId), ["other-directory"]);
    assert.deepEqual(result.rows.map((row) => row.projectId), ["other-project", "other-project"],
      "the IndexedDB projectId index contains no deleted-project row and preserves the other project");
    assert.equal((result.cleanup.intents || []).some((intent) => intent.intentId === result.intentId), false,
      "successful cleanup clears only its durable intent");
    const cleared = await page.evaluate(async () => {
      flushAllImageMutations = async () => {};
      flushAllWorkspaceMutations = async () => {};
      projectDeleteBusy = false; state.projectOperationPending = false; state.catalogTransition = null;
      state.project = { id: "deleted-project", name: "Deleted", status: "active" }; state.serverCatalogGeneration = 41;
      state.currentId = state.images[0].id; state.candidates = [{ id: "candidate-ref" }];
      state.drafts.set(state.currentId, { add: "draft-ref" }); state.projectHistory.set(state.currentId, { canUndo: true, canRedo: false });
      state.candidateImages = new Map([["candidate-ref", document.createElement("canvas")]]);
      projectListProjects.set("deleted-project", state.project);
      await deleteProject("deleted-project");
      return { project: state.project, ids: state.images.map((image) => image.id), current: state.currentId, candidates: state.candidates.length,
        drafts: state.drafts.size, history: state.projectHistory.size, candidateImages: state.candidateImages.size };
    });
    assert.deepEqual(cleared, { project: null, ids: [], current: null, candidates: 0, drafts: 0, history: 0, candidateImages: 0 },
      "deleting the current project releases its browser image, candidate, draft, and history references");
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => state.settings && state.images.length === 2);
    const restoredOther = await page.evaluate(async () => {
      state.project = { id: "other-project", name: "Other", status: "active" };
      state.images = [{ id: "image-b", relativePath: "B.png", sourceId: "other-file", sourceKind: "session", sizeBytes: 3, mtimeNs: 456000000,
        width: 2, height: 2, reviewed: false, hidden: false }];
      await restoreBrowserProjectSourcesForCurrentCatalog([]);
      const access = state.sourceAccess.get("image-b");
      return { ids: [...state.sourceAccess.keys()], sourceId: access?.sourceId, relativePath: access?.relativePath, size: access?.size, lastModified: access?.lastModified };
    });
    assert.deepEqual(restoredOther, { ids: ["image-b"], sourceId: "other-file", relativePath: "B.png", size: 3, lastModified: 456 },
      "closing and reopening the other project restores its unchanged file handle and source metadata");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-085 through DI-098 clear confirmations preserve the exact visible target set", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const initial = [
    ["A", true, true, false], ["B", true, false, false],
    ["C", false, true, false], ["D", false, false, false],
    ["E", true, true, true], ["F", true, false, true],
    ["G", false, true, true], ["H", false, false, true],
  ].map(([id, masked, reviewed, hidden]) => ({
    id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 100, height: 80,
    candidateCount: masked ? 1 : 0, enabledCandidateCount: masked ? 1 : 0,
    hasEffectiveMask: masked, reviewed, hidden,
  }));
  let catalogue = structuredClone(initial);
  fixture.setCatalog(catalogue);
  const clearRequests = [];
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 8));
    await page.route("**/api/masks/clear", async (route) => {
      const payload = JSON.parse(route.request().postData());
      clearRequests.push(payload.imageIds);
      const ids = new Set(payload.imageIds);
      catalogue = catalogue.map((image) => ids.has(image.id) ? {
        ...image, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false,
      } : image);
      fixture.setCatalog(catalogue);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.evaluate(() => {
      state.settings.confirmations.clearMasks = true;
      state.drafts.set("A", { add: "data:image/png;base64,A-range", exclusion: "data:image/png;base64,A-exclusion", historyIndex: 2 });
      state.drafts.set("B", { add: "data:image/png;base64,B-range", exclusion: "", historyIndex: 1 });
      state.selectedImageIds = new Set(["A", "B"]);
      updateSelectionActionBar();
      document.querySelector('[data-selection-action="clear"]').click();
    });
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmTitle").textContent(), /2件/, "selected clear names exactly two targets");
    assert.doesNotMatch(await page.locator("#confirmTitle").textContent(), /全画像/, "selected clear never claims to clear all images");
    const beforeCancel = await page.evaluate(() => ({
      images: state.images.map((image) => [image.id, image.hasEffectiveMask, image.reviewed, image.hidden]),
      drafts: ["A", "B"].map((id) => [id, structuredClone(state.drafts.get(id))]),
    }));
    await page.locator("#confirmCancel").click();
    assert.deepEqual(clearRequests, [], "cancelling sends no deletion request");
    assert.deepEqual(await page.evaluate(() => ({
      images: state.images.map((image) => [image.id, image.hasEffectiveMask, image.reviewed, image.hidden]),
      drafts: ["A", "B"].map((id) => [id, structuredClone(state.drafts.get(id))]),
    })), beforeCancel, "cancelling preserves the concrete A/B ranges, history positions, review flags, and visibility");

    await page.evaluate(() => { state.selectedImageIds = new Set(["A"]); updateSelectionActionBar(); document.querySelector('[data-selection-action="clear"]').click(); });
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    const singleClear = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click(); await singleClear;
    await page.waitForFunction(() => !state.masksClearing);
    assert.deepEqual(clearRequests, [["A"]]);
    assert.deepEqual(await page.evaluate(() => state.images.filter((image) => ["A", "B"].includes(image.id)).map((image) => [image.id, image.hasEffectiveMask, image.reviewed])),
      [["A", false, true], ["B", true, false]], "single clear changes only A in the refreshed browser catalogue");
    catalogue = structuredClone(initial); fixture.setCatalog(catalogue);
    await page.evaluate(() => resyncCatalog());
    await page.evaluate(() => { state.selectedImageIds = new Set(["A", "B"]); updateSelectionActionBar(); });

    await page.evaluate(() => document.querySelector('[data-selection-action="clear"]').click());
    const selectedClear = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click();
    await selectedClear;
    await page.waitForFunction(() => !state.masksClearing && !document.querySelector("#confirmDialog").open);
    assert.deepEqual(clearRequests, [["A"], ["A", "B"]], "single and selected clear submit their exact target sets");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.hasEffectiveMask, image.reviewed, image.hidden])), [
      ["A", false, true, false], ["B", false, false, false], ["C", false, true, false], ["D", false, false, false],
      ["E", true, true, true], ["F", true, false, true], ["G", false, true, true], ["H", false, false, true],
    ], "the refreshed visible catalogue resets A and B while retaining every unrelated and hidden flag");

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator('[data-apply-image-filter="reviewed"]').check({ force: true });
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), ["A", "C"], "reviewed save retains A and C after A and B are cleared");
    assert.match(await page.locator("#applyTargetCount").textContent(), /2件/, "reviewed save reports two targets");
    await page.locator("#applyCloseButton").click();

    await page.locator("#batchMoreButton").click();
    await page.locator("#clearAllMasksButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmTitle").textContent(), /4件/, "all clear counts only the four visible processable images");
    assert.match(await page.locator("#confirmMessage").textContent(), /焼き込み済み.*復元しません/, "all clear explains that burned-in pixels are not restored");
    const allClear = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click();
    await allClear;
    await page.waitForFunction(() => !state.masksClearing);
    assert.deepEqual(clearRequests.at(-1), ["A", "B", "C", "D"], "all clear excludes every hidden image");

    const assertEmptyFilter = async (filter) => {
      await page.locator("#saveAllButton").click();
      await page.waitForFunction(() => document.querySelector("#applyDialog").open);
      await page.locator('[data-apply-image-filter="reviewed"]').uncheck({ force: true });
      await page.locator(`[data-apply-image-filter="${filter}"]`).check({ force: true });
      assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), [], `${filter} has no target after visible masks are cleared`);
      assert.equal(await page.locator("#applyStartButton").isDisabled(), true, `${filter} cannot start an empty save`);
      await page.locator("#applyCloseButton").click();
    };
    await assertEmptyFilter("masked");
    await page.locator("#saveAllButton").click();
    await page.locator('[data-apply-image-filter="reviewed"]').check({ force: true });
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), ["A", "C"], "all clear preserves reviewed membership");
    await page.locator("#applyCloseButton").click();
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("[data-apply-image-filter]").evaluateAll((inputs) => {
      for (const input of inputs) {
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), ["A", "B", "C", "D"], "unfiltered save contains all and only visible images");
    assert.match(await page.locator("#applyTargetCount").textContent(), /4件/, "unfiltered save reports four targets");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-103 DI-104 and DI-125 source cleanup removes only authoritatively absent owners", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/project/source-status?*", async (route) => {
      const url = new URL(route.request().url());
      const imageId = url.searchParams.get("imageId");
      if (imageId === "uncertain") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: imageId === "present" }),
      });
    });
    const result = await page.evaluate(async () => {
      const handle = (kind, name) => ({ kind, name });
      const cleanupRecord = async () => {
        const db = await directoryCatalogStore();
        try {
          return await new Promise((resolve) => {
            const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY);
            request.onsuccess = () => resolve(request.result || {});
            request.onerror = () => resolve({});
          });
        } finally { db.close(); }
      };
      await rememberProjectSource("gone", handle("directory", "gone"), null, "gone-root");
      await rememberProjectSource("kept", handle("directory", "kept"), null, "kept-root");
      const goneIntent = await rememberProjectSourceCleanup("gone");
      const keptIntent = await rememberProjectSourceCleanup("kept");
      await retryProjectSourceCleanup(new Set(["kept"]));
      const projectsAfterRetry = {
        gone: await rememberedProjectSources("gone"),
        kept: await rememberedProjectSources("kept"),
        cleanup: await cleanupRecord(),
      };

      for (const imageId of ["absent", "present", "uncertain"]) {
        await rememberProjectSource("images", handle("file", `${imageId}.png`), imageId, "browser-files", null, `${imageId}.png`);
      }
      const imageIntents = {};
      for (const imageId of ["absent", "present", "uncertain"]) {
        imageIntents[imageId] = await rememberProjectImageSourceCleanup("images", imageId);
      }
      await retryProjectSourceCleanup(new Set(["kept", "images"]));
      const imagesAfterRetry = {
        sources: await rememberedProjectSources("images"),
        cleanup: await cleanupRecord(),
      };

      const rejectedA = await rememberProjectSourceCleanup("reject-a");
      const rejectedB = await rememberProjectSourceCleanup("reject-b");
      await clearProjectSourceCleanup({ intentIds: [rejectedA] });
      const afterExplicitRejection = await cleanupRecord();
      return { goneIntent, keptIntent, projectsAfterRetry, imageIntents, imagesAfterRetry, rejectedA, rejectedB, afterExplicitRejection };
    });

    assert.equal(result.projectsAfterRetry.gone.directories.length, 0);
    assert.deepEqual(result.projectsAfterRetry.kept.directories.map((source) => source.sourceId), ["kept-root"]);
    assert(!result.projectsAfterRetry.cleanup.intents.some((intent) => intent.intentId === result.goneIntent));
    assert(result.projectsAfterRetry.cleanup.intents.some((intent) => intent.intentId === result.keptIntent));
    assert.deepEqual(result.imagesAfterRetry.sources.files.map((source) => source.imageId).sort(), ["present", "uncertain"]);
    assert(!result.imagesAfterRetry.cleanup.imageIntents.some((intent) => intent.intentId === result.imageIntents.absent));
    assert(result.imagesAfterRetry.cleanup.imageIntents.some((intent) => intent.intentId === result.imageIntents.present));
    assert(result.imagesAfterRetry.cleanup.imageIntents.some((intent) => intent.intentId === result.imageIntents.uncertain));
    assert(!result.afterExplicitRejection.intents.some((intent) => intent.intentId === result.rejectedA));
    assert(result.afterExplicitRejection.intents.some((intent) => intent.intentId === result.rejectedB));
    await page.evaluate(async () => {
      await rememberProjectSource("boot-gone", { kind: "directory", name: "boot-gone" }, null, "boot-root");
      await rememberProjectSourceCleanup("boot-gone");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.waitForFunction(async () => (await rememberedProjectSources("boot-gone")).directories.length === 0);
    assert.deepEqual(await page.evaluate(async () => rememberedProjectSources("boot-gone")), { files: [], directories: [] },
      "the next application startup removes handles for a project absent from the authoritative project list");
    const imageRestart = await page.evaluate(async () => {
      await rememberProjectSource("restart-images", { kind: "file", name: "absent.png" }, "absent", "restart-source", "absent", "absent.png");
      await rememberProjectSource("restart-images", { kind: "file", name: "present.png" }, "present", "restart-source", "present", "present.png");
      const absentIntent = await rememberProjectImageSourceCleanup("restart-images", "absent");
      const presentIntent = await rememberProjectImageSourceCleanup("restart-images", "present");
      return { absentIntent, presentIntent };
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.evaluate(async () => retryProjectSourceCleanup(new Set(["kept", "images", "restart-images"])));
    await page.waitForFunction(async (absentIntent) => {
      const sources = await rememberedProjectSources("restart-images");
      const db = await directoryCatalogStore();
      try {
        const cleanup = await new Promise((resolve) => {
          const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY);
          request.onsuccess = () => resolve(request.result || {}); request.onerror = () => resolve({});
        });
        return sources.files.length === 1 && sources.files[0].imageId === "present"
          && !(cleanup.imageIntents || []).some((intent) => intent.intentId === absentIntent);
      } finally { db.close(); }
    }, imageRestart.absentIntent);
    assert.deepEqual(await page.evaluate(async () => (await rememberedProjectSources("restart-images")).files.map((source) => source.imageId)), ["present"],
      "restart removes only the committed-deleted image handle and keeps the authoritative existing image handle");
    const rejectedOnly = await page.evaluate(async ({ absentIntent, presentIntent }) => {
      await clearProjectSourceCleanup({ intentIds: [absentIntent] });
      const db = await directoryCatalogStore();
      try { return await new Promise((resolve) => { const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY); request.onsuccess = () => resolve(request.result || {}); }); }
      finally { db.close(); }
    }, imageRestart);
    assert.equal((rejectedOnly.imageIntents || []).some((intent) => intent.intentId === imageRestart.absentIntent), false);
    assert.equal((rejectedOnly.imageIntents || []).some((intent) => intent.intentId === imageRestart.presentIntent), true,
      "a definitive rejected delete clears only that durable record and preserves the unrelated pending record");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-092 and DI-093 durable undo redo reconcile the visible range and review state", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  let catalogue = [{ id: "A", relativePath: "A.png", sourceKind: "filesystem", width: 100, height: 80,
    candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false, reviewed: true, hidden: false }];
  fixture.setCatalog(catalogue);
  let phase = "cleared";
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 1));
    await page.route("**/api/project/history/A**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canUndo: phase === "cleared", canRedo: phase === "restored" }) });
        return;
      }
      if (path.endsWith("/undo")) {
        phase = "restored";
        catalogue = catalogue.map((image) => ({ ...image, candidateCount: 1, enabledCandidateCount: 1, hasEffectiveMask: true }));
        fixture.setCatalog(catalogue);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changedImageIds: ["A"], canUndo: false, canRedo: true, current: { candidateRevision: 1 } }) });
      } else {
        phase = "cleared";
        catalogue = catalogue.map((image) => ({ ...image, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false }));
        fixture.setCatalog(catalogue);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changedImageIds: ["A"], canUndo: true, canRedo: false, current: { candidateRevision: 2 } }) });
      }
    });
    await page.route("**/api/images", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      images: catalogue, project: { id: "history-project", name: "History", status: "active" }, readOnly: false,
      historyDurable: true, root: "G:\\history", sources: [], needsSource: false, catalogGeneration: 90,
    }) }));
    await page.locator('.gallery-item[data-id="A"]').click();
    await page.waitForFunction(() => state.currentId === "A" && state.currentImage);
    await page.evaluate(() => {
      state.project = { id: "history-project" }; state.historyDurable = true; state.serverCatalogGeneration = 90;
      state.projectHistory.set("A", { canUndo: true, canRedo: false });
      updateHistoryButtons();
    });
    await page.evaluate(() => restoreProjectHistory("undo"));
    assert.deepEqual(await page.evaluate(() => ({ range: currentRecord()?.hasEffectiveMask, reviewed: currentRecord()?.reviewed,
      cardReviewed: document.querySelector('.gallery-item[data-id="A"]')?.classList.contains("reviewed") })),
    { range: true, reviewed: true, cardReviewed: true }, "undo restores range and review state in the current view and gallery");
    await page.evaluate(() => restoreProjectHistory("redo"));
    assert.deepEqual(await page.evaluate(() => ({ range: currentRecord()?.hasEffectiveMask, reviewed: currentRecord()?.reviewed,
      cardReviewed: document.querySelector('.gallery-item[data-id="A"]')?.classList.contains("reviewed") })),
    { range: false, reviewed: true, cardReviewed: true }, "redo removes the range and retains the same visible image review choice");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-102 DI-118 DI-123 and DI-124 send captured authority and resync one complete snapshot", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    const mutations = [];
    let imagesGets = 0;
    const authoritative = {
      images: [{ id: "new-image", relativePath: "nested/new.png", sourceKind: "filesystem", sourceId: "new-source", width: 32, height: 24,
        reviewed: true, hidden: false, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false }],
      project: { id: "new-project", name: "New", status: "active" }, readOnly: false, historyDurable: true,
      root: "G:\\new-root", sources: [{ id: "new-source", kind: "native-folder", nativePath: "G:\\new-root", exists: false }], needsSource: true,
      catalogGeneration: 44,
    };
    await page.route("**/api/project/**", async (route) => {
      const rawBody = route.request().postData();
      mutations.push({ path: new URL(route.request().url()).pathname, method: route.request().method(), headers: route.request().headers(), body: rawBody ? JSON.parse(rawBody) : null });
      const stale = new URL(route.request().url()).pathname === "/api/project/resume";
      await route.fulfill({ status: stale ? 409 : 200, contentType: "application/json", body: JSON.stringify(stale
        ? { error_code: "stale_catalog" }
        : { ok: true, catalogGeneration: 17 }) });
    });
    await page.route("**/api/images", async (route) => {
      imagesGets += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    });
    const result = await page.evaluate(async () => {
      state.project = { id: "old-project", name: "Old", status: "active" };
      state.serverCatalogGeneration = 17;
      state.root = "G:\\old-root";
      state.currentId = state.images[0].id;
      state.candidates = [{ id: "old-candidate", enabled: true, role: "apply" }];
      state.candidateImages = new Map([["old-candidate", document.createElement("canvas")]]);
      state.sourceAccess = new Map([[state.currentId, { sourceId: "old-source" }]]);
      const imageKey = "old-image:asset"; const candidateKey = "old-image:0";
      state.resourceImageKeys = new Set([imageKey]); state.resourceCandidateKeys = new Set([candidateKey]);
      state.imageCache.set(imageKey, document.createElement("canvas"));
      state.candidateBundleCache.set(candidateKey, { candidates: [{ id: "cached" }], candidateImages: new Map([["cached", document.createElement("canvas")]]) });
      const ownSnapshot = { images: state.images.map((image) => ({ ...image })), project: { ...state.project }, readOnly: false,
        historyDurable: true, root: state.root, sources: [], needsSource: false, catalogGeneration: 17 };
      const ownReplaced = reconcileCatalogSnapshot(ownSnapshot, "old-project", 17);
      if (ownReplaced || state.currentId !== ownSnapshot.images[0].id || state.candidates[0]?.id !== "old-candidate") throw new Error("own update discarded editor state");
      const transitions = [
        ["/api/project/open", { projectId: "next" }, "POST"],
        ["/api/project/source/relink", { projectId: "old-project", sourceId: "source" }, "POST"],
        ["/api/project/close", {}, "POST"],
        ["/api/project/complete", {}, "POST"],
        ["/api/project/name", { projectId: "old-project", name: "renamed" }, "POST"],
        ["/api/project/mismatches", { imageIds: ["sample"] }, "POST"],
        ["/api/project/old-project", {}, "DELETE"],
      ];
      for (const [path, payload, method] of transitions) await catalogApi(path, payload, { method });
      let code = "";
      try { await catalogApi("/api/project/resume", { projectId: "old-project" }, { method: "POST" }); }
      catch (error) { code = error.code; }
      return {
        code,
        project: state.project?.id || null,
        generation: state.serverCatalogGeneration,
        root: state.reviewRoot,
        imageIds: state.images.map((image) => image.id),
        currentId: state.currentId,
        candidates: state.candidates.map((candidate) => candidate.id),
        sourceAccess: [...state.sourceAccess.keys()],
        cacheSizes: [state.imageCache.items.size, state.candidateBundleCache.items.size],
        missing: state.missingNativeSources.map((source) => source.id),
      };
    });
    assert.equal(mutations.length, 8);
    assert.deepEqual(mutations.map((mutation) => mutation.path), [
      "/api/project/open", "/api/project/source/relink", "/api/project/close", "/api/project/complete",
      "/api/project/name", "/api/project/mismatches", "/api/project/old-project", "/api/project/resume",
    ]);
    for (const mutation of mutations) {
      assert.equal(mutation.headers["x-mozarie-expected-project-id"], "old-project");
      assert.equal(mutation.headers["x-mozarie-expected-catalog-generation"], "17");
      if (mutation.method === "DELETE") assert.equal(mutation.body, null);
      else {
        assert.equal(mutation.body.expectedProjectId, "old-project");
        assert.equal(mutation.body.expectedCatalogGeneration, 17);
      }
    }
    assert.equal(imagesGets, 1, "one stale mutation fetches exactly one authoritative catalogue");
    assert.deepEqual(result, {
      code: "stale_catalog", project: "new-project", generation: 44, root: "g:\\new-root",
      imageIds: ["new-image"], currentId: null, candidates: [], sourceAccess: [], missing: ["new-source"],
      cacheSizes: [0, 0],
    });
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-102 lost and general-error project mutations both resync the complete authoritative catalogue", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    let mode = "lost";
    let catalogueGets = 0;
    const authoritative = {
      images: [{ id: "authority", relativePath: "authority.png", sourceKind: "filesystem", width: 9, height: 7, reviewed: false, hidden: false }],
      project: { id: "authority-project", name: "Authority", status: "active" }, readOnly: false, historyDurable: true,
      root: "G:\\authority", sources: [], needsSource: false, catalogGeneration: 90,
    };
    await page.route("**/api/project/name", async (route) => {
      if (mode === "lost") await route.abort("failed");
      else await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
    });
    await page.route("**/api/images", async (route) => {
      catalogueGets += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    });
    const lost = await page.evaluate(async () => {
      state.project = { id: "before-lost" }; state.serverCatalogGeneration = 21;
      try { await catalogApi("/api/project/name", { name: "lost" }, { method: "POST" }); } catch (error) { /* expected */ }
      return [state.project?.id, state.images.map((image) => image.id), state.serverCatalogGeneration, state.reviewRoot];
    });
    assert.deepEqual(lost, ["authority-project", ["authority"], 90, "g:\\authority"]);
    mode = "general";
    const general = await page.evaluate(async () => {
      state.project = { id: "before-error" }; state.serverCatalogGeneration = 22;
      try { await catalogApi("/api/project/name", { name: "error" }, { method: "POST" }); } catch (error) { /* expected */ }
      return [state.project?.id, state.images.map((image) => image.id), state.serverCatalogGeneration, state.reviewRoot];
    });
    assert.deepEqual(general, ["authority-project", ["authority"], 90, "g:\\authority"]);
    assert.equal(catalogueGets, 2, "each ambiguous failure performs exactly one authoritative resync");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("DI-118 transition response and stale second tab converge on one complete catalogue snapshot", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let pageA; let pageB;
  const authoritative = {
    images: [{ id: "sample", relativePath: "nested/A.png", sourceKind: "filesystem", sourceId: "native-A", width: 24, height: 18, reviewed: true, hidden: false }],
    project: { id: "project-new", name: "New", status: "active" }, readOnly: false, historyDurable: true,
    root: "G:\\new", sources: [{ id: "native-A", kind: "native-folder", nativePath: "G:\\new", exists: true }],
    needsSource: false, catalogGeneration: 71,
  };
  try {
    ({ context, page: pageA } = await openCatalogue(browser, fixture, 2));
    pageB = await context.newPage(); await pageB.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await pageB.waitForFunction(() => state.settings && state.images.length === 2);
    for (const page of [pageA, pageB]) {
      await page.route("**/api/images", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) }));
    }
    await pageA.route("**/api/project/open", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) }));
    await pageB.route("**/api/project/resume", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) }));
    const first = await pageA.evaluate(async () => {
      state.project = { id: "project-old" }; state.serverCatalogGeneration = 10;
      const response = await catalogApi("/api/project/open", { projectId: "project-new" }, { method: "POST" });
      reconcileCatalogSnapshot(response, "project-old", 10);
      const listed = await api("/api/images");
      return { response, listed, state: { project: state.project.id, images: state.images.map((image) => image.id), root: state.reviewRoot,
        generation: state.serverCatalogGeneration } };
    });
    assert.deepEqual(first.response, first.listed, "the success response and immediate authoritative list expose one transition point");
    assert.deepEqual(first.state, { project: "project-new", images: ["sample"], root: "g:\\new", generation: 71 });
    const second = await pageB.evaluate(async () => {
      state.project = { id: "project-old" }; state.serverCatalogGeneration = 10;
      state.currentId = "sample"; state.candidates = [{ id: "old-project-candidate" }]; state.candidateImages = new Map([["old-project-candidate", document.createElement("canvas")]]);
      let code = ""; try { await catalogApi("/api/project/resume", { projectId: "project-old" }, { method: "POST" }); } catch (error) { code = error.code; }
      return { code, project: state.project.id, images: state.images.map((image) => image.id), root: state.reviewRoot,
        generation: state.serverCatalogGeneration, current: state.currentId, candidates: state.candidates.map((candidate) => candidate.id) };
    });
    assert.deepEqual(second, { code: "stale_catalog", project: "project-new", images: ["sample"], root: "g:\\new", generation: 71, current: null, candidates: [] },
      "the stale tab is rejected and replaces every catalogue field from the same authoritative snapshot");
  } finally {
    await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});

test("DI-120 and DI-123 definitive project-open failure preserves the prior catalogue draft and source handle", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/project/open", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error_code: "project_not_found" }) }));
    const before = await page.evaluate(async () => {
      state.project = { id: "kept-project", name: "Kept", status: "active" }; state.serverCatalogGeneration = 33;
      state.reviewRoot = "g:\\kept"; state.root = "G:\\kept"; state.currentId = state.images[0].id;
      Object.assign(state.images[0], { reviewed: true, hidden: true, flipH: true, flipV: true });
      state.candidates = [{ id: "kept-candidate", enabled: true, role: "apply" }];
      state.drafts.set(state.currentId, { add: "data:image/png;base64,kept", historyIndex: 1 });
      await rememberProjectSource("kept-project", { kind: "file", name: "sample.png", size: 123, lastModified: 456 }, state.currentId, "kept-source", "client", "sample.png");
      await rememberProjectSource("missing-project", { kind: "file", name: "target.png", size: 99, lastModified: 321 }, "target-image", "target-source", "target-client", "target.png");
      return { project: state.project.id, generation: state.serverCatalogGeneration, root: state.reviewRoot, images: state.images.map((image) => ({ id: image.id, reviewed: image.reviewed, hidden: image.hidden, flipH: image.flipH, flipV: image.flipV })),
        current: state.currentId, candidates: state.candidates.map((candidate) => candidate.id), draft: structuredClone(state.drafts.get(state.currentId)),
        sources: { kept: await rememberedProjectSources("kept-project"), target: await rememberedProjectSources("missing-project") } };
    });
    await page.evaluate(async () => { await openProject({ id: "missing-project", name: "Missing" }); });
    const after = await page.evaluate(async () => ({ project: state.project.id, generation: state.serverCatalogGeneration, root: state.reviewRoot,
      images: state.images.map((image) => ({ id: image.id, reviewed: image.reviewed, hidden: image.hidden, flipH: image.flipH, flipV: image.flipV })), current: state.currentId, candidates: state.candidates.map((candidate) => candidate.id),
      draft: structuredClone(state.drafts.get(state.currentId)), sources: { kept: await rememberedProjectSources("kept-project"), target: await rememberedProjectSources("missing-project") } }));
    assert.deepEqual(after, before, "a definitive 4xx open failure cannot publish the failed project or clear the prior draft/handle mapping");
  } finally {
    await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});

test("DI-121 failed image workspace load never publishes a partial browser selection", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  let context; let page; let pageB;
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    pageB = await context.newPage(); await pageB.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await pageB.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => { state.serverCatalogGeneration = 52; state.candidates = [{ id: "kept", enabled: true, role: "apply" }]; });
    const before = await page.evaluate(() => ({ project: state.project?.id || null, ids: state.images.map((image) => image.id), current: state.currentId,
      candidates: state.candidates.map((candidate) => candidate.id), generation: state.serverCatalogGeneration, root: state.reviewRoot }));
    const otherBefore = await pageB.evaluate(() => ({ project: state.project?.id || null, ids: state.images.map((image) => image.id), generation: state.serverCatalogGeneration, root: state.reviewRoot }));
    await page.evaluate(() => invalidateStaleAssets(["sample-two"]));
    await page.route("**/api/image/sample-two", (route) => route.abort("failed"));
    await page.locator('.gallery-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    const after = await page.evaluate(() => ({ project: state.project?.id || null, ids: state.images.map((image) => image.id), current: state.currentId,
      candidates: state.candidates.map((candidate) => candidate.id), generation: state.serverCatalogGeneration, root: state.reviewRoot }));
    assert.deepEqual(after, before, "a failed target image load leaves the previous complete editor/catalogue state visible");
    assert.deepEqual(await pageB.evaluate(() => ({ project: state.project?.id || null, ids: state.images.map((image) => image.id), generation: state.serverCatalogGeneration, root: state.reviewRoot })), otherBefore,
      "the failed tab never publishes a partial list that disagrees with another browser retaining the old authority");
  } finally {
    await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});

test("DI-109 DI-111 and DI-124 delayed mutations retain A authority and leave the switched B screen intact", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  let context; let page; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const paths = [
    "/api/candidate/sample/candidate-A", "/api/workspace/manual/sample/commit", "/api/workspace/image/sample", "/api/save/commit",
    "/api/import", "/api/detect", "/api/masks/clear", "/api/project/history/sample/undo", "/api/project/history/sample/redo",
  ];
  const requests = []; let listGets = 0;
  const authoritative = {
    images: [{ id: "B", relativePath: "B.png", sourceKind: "filesystem", width: 12, height: 8, reviewed: false, hidden: false, flipH: false, flipV: false }],
    project: { id: "project-B", name: "B", status: "active" }, readOnly: false, historyDurable: true,
    root: "G:\\B", sources: [], needsSource: false, catalogGeneration: 200,
  };
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    for (const path of paths) await page.route(`**${path}`, async (route) => {
      const raw = route.request().postData();
      requests.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers(), body: raw ? JSON.parse(raw) : null });
      await gate;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    });
    await page.route("**/api/images", async (route) => {
      listGets += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    });
    await page.evaluate((mutationPaths) => {
      state.project = { id: "project-A", name: "A", status: "active" }; state.serverCatalogGeneration = 100;
      const calls = mutationPaths.map((path) => catalogApi(path, path === "/api/import" ? { imageIds: ["sample"] } : { value: true }, { method: "POST" }));
      window.delayedAuthorityResults = Promise.allSettled(calls);
    }, paths);
    const deadline = Date.now() + 5000;
    while (requests.length < paths.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, paths.length, "all delayed mutations reached the server before the project switch");
    await page.evaluate((snapshot) => {
      state.project = structuredClone(snapshot.project); state.serverCatalogGeneration = snapshot.catalogGeneration;
      resetCatalog(structuredClone(snapshot.images), snapshot.root); applyProjectSnapshot(snapshot);
    }, authoritative);
    release();
    const result = await page.evaluate(async () => {
      const settled = await window.delayedAuthorityResults;
      return { codes: settled.map((item) => item.reason?.code), project: state.project.id, generation: state.serverCatalogGeneration,
        images: state.images.map((image) => image.id), screenCards: [...document.querySelectorAll(".gallery-item")].map((node) => node.dataset.id) };
    });
    assert.deepEqual(requests.map((request) => request.path), paths);
    for (const request of requests) {
      assert.equal(request.headers["x-mozarie-expected-project-id"], "project-A");
      assert.equal(request.headers["x-mozarie-expected-catalog-generation"], "100");
      assert.equal(request.body.expectedProjectId, "project-A"); assert.equal(request.body.expectedCatalogGeneration, 100);
    }
    assert(result.codes.every((code) => code === "stale_catalog"));
    assert.deepEqual(result, { codes: Array(paths.length).fill("stale_catalog"), project: "project-B", generation: 200, images: ["B"], screenCards: ["B"] });
    assert.equal(listGets, paths.length, "each delayed completion compares against an immediate authoritative catalogue read");
  } finally { release?.(); await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server); }
});

test("DI-122 many-image candidate enable delete and padding APIs leave catalogue reads and browser frames responsive", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  let context; let page; let release; const gate = new Promise((resolve) => { release = resolve; }); const bulkBodies = [];
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/candidates/batch", async (route) => {
      const body = JSON.parse(route.request().postData()); bulkBodies.push(body); await gate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, candidateRevisions: Object.fromEntries(body.imageIds.map((id) => [id, 2])) }) });
    });
    const result = await page.evaluate(async () => {
      const ids = Array.from({ length: 500 }, (_, index) => `image-${index}`);
      let frames = 0; const tick = () => { frames += 1; if (!window.bulkDone) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      window.bulkDone = false;
      window.bulkPromise = Promise.all([
        api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageIds: ids, role: "apply", operation: "enable" }) }),
        api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageIds: ids, role: "apply", operation: "delete" }) }),
        api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageIds: ids, role: "apply", operation: "set_padding", expandPx: 12 }) }),
      ]).finally(() => { window.bulkDone = true; });
      const listed = await api("/api/images"); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ids, listed: listed.images.map((image) => image.id), frames };
    });
    assert.equal(result.ids.length, 500); assert.deepEqual(result.listed, ["sample", "sample-two"]); assert(result.frames >= 2);
    await page.waitForFunction(() => true); while (bulkBodies.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(bulkBodies.map((body) => body.operation).sort(), ["delete", "enable", "set_padding"]);
    assert(bulkBodies.every((body) => body.imageIds.length === 500)); release(); await page.evaluate(() => window.bulkPromise);
  } finally { release?.(); await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server); }
});

test("DI-125 definitive image-delete commit 4xx removes only its own durable cleanup intent", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true }); let context; let page;
  const saveRequests = [];
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/save/prepare", async (route) => {
      saveRequests.push("prepare");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [{ imageId: "sample", candidateRevision: 0, relativePath: "sample.png" }] }) });
    });
    await page.route("**/api/save/reserve", async (route) => {
      saveRequests.push("reserve"); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "rendering" }) });
    });
    await page.route("**/api/save/render", async (route) => {
      saveRequests.push("render"); await route.fulfill({ status: 200, headers: { "X-Mozarie-Save-Token": "00000000-0000-4000-8000-000000000125" }, body: "rendered" });
    });
    await page.route("**/api/save/commit", async (route) => {
      saveRequests.push("commit-4xx"); await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error_code: "save_state_changed" }) });
    });
    await page.route("**/api/save/cancel", async (route) => {
      saveRequests.push("cancel"); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "cancelled" }) });
    });
    await page.locator('.gallery-item[data-id="sample"]').click(); await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(async () => {
      state.project = { id: "delete-project", name: "Delete", status: "active" };
      state.settings.saving.default_output_directory = "G:\\output"; state.settings.confirmations.deleteSourceAfterCopy = false;
      await openSingleSaveDialog("sample");
      $("#singleSaveCopyMode").checked = true; $("#singleSaveDeleteOriginal").checked = true;
      $("#singleSaveOutputDirectoryStatus").value = "G:\\output"; syncSingleSaveMode();
      window.otherCleanupIntent = await rememberProjectImageSourceCleanup("delete-project", "sample-two");
      await startSingleSave({ preventDefault() {} });
    });
    const intents = await page.evaluate(async () => {
      const db = await directoryCatalogStore();
      try { return await new Promise((resolve) => { const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY); request.onsuccess = () => resolve(request.result?.imageIntents || []); }); }
      finally { db.close(); }
    });
    assert.deepEqual(saveRequests, ["prepare", "reserve", "render", "commit-4xx", "cancel", "cancel"]);
    assert.deepEqual(intents.map((intent) => [intent.intentId, intent.imageId]), [[await page.evaluate(() => window.otherCleanupIntent), "sample-two"]],
      "the actual definitive HTTP rejection clears the rejected image's intent and preserves the unrelated durable record");
  } finally { await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server); }
});

test("DI-124 real import save detection clear undo and redo completion handlers capture authority before listing", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true }); let context; let page; let imageGets = 0;
  const snapshot = {
    images: [{ id: "sample", relativePath: "sample.png", sourceKind: "filesystem", width: 100, height: 80, reviewed: false, hidden: false }],
    project: { id: "project-A", name: "A", status: "active" }, readOnly: false, historyDurable: true,
    root: "G:\\A", sources: [], needsSource: false, catalogGeneration: 100,
  };
  try {
    ({ context, page } = await openCatalogue(browser, fixture, 2));
    await page.route("**/api/images", async (route) => { imageGets += 1; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }); });
    await page.route("**/api/import/start", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, catalogGeneration: 100 }) }));
    await page.route("**/api/import/file", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ added: [], failures: [], catalogId: "project-A", catalogGeneration: 100 }) }));
    await page.route("**/api/import/finish", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, catalogGeneration: 100 }) }));
    await page.route("**/api/masks/clear", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cleared: 1 }) }));
    await page.route("**/api/project/history/sample", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canUndo: true, canRedo: true }) }));
    await page.route("**/api/project/history/sample/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changedImageIds: [], canUndo: true, canRedo: true }) }));
    const captures = await page.evaluate(async (authoritative) => {
      state.project = structuredClone(authoritative.project); state.serverCatalogGeneration = 100; state.historyDurable = true;
      resetCatalog(structuredClone(authoritative.images), authoritative.root); applyProjectSnapshot(authoritative);
      window.handlerCaptures = []; window.activeCompletionHandler = "";
      const originalReconcile = reconcileCatalogSnapshot;
      reconcileCatalogSnapshot = (listed, projectId, generation) => {
        window.handlerCaptures.push([window.activeCompletionHandler, projectId, generation]);
        return originalReconcile(listed, projectId, generation);
      };
      window.activeCompletionHandler = "import";
      const session = beginImportSession();
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg=="), (value) => value.charCodeAt(0));
      await importFiles([new File([png], "new.png", { type: "image/png" })], session);
      state.project = structuredClone(authoritative.project); state.serverCatalogGeneration = 100;
      window.activeCompletionHandler = "save"; await finishApplyJob({ state: "complete", completed: 0, imageIds: [], completedImageIds: [], startedAt: 1 });
      state.project = structuredClone(authoritative.project); state.serverCatalogGeneration = 100;
      window.activeCompletionHandler = "detect"; await finishDetectionJob({ kind: "detect", state: "complete", completed: 0, imageIds: [], completedImageIds: [], startedAt: 2 });
      state.project = structuredClone(authoritative.project); state.serverCatalogGeneration = 100; state.settings.confirmations.clearMasks = false;
      window.activeCompletionHandler = "clear"; await clearMasks(["sample"], "confirm.clearAllMasks.title", "confirm.clearAllMasks.message");
      state.project = structuredClone(authoritative.project); state.serverCatalogGeneration = 100; state.historyDurable = true;
      state.currentId = "sample"; state.currentImage = document.createElement("canvas"); state.projectHistory.set("sample", { canUndo: true, canRedo: true });
      window.activeCompletionHandler = "undo"; await restoreProjectHistory("undo");
      state.projectHistory.set("sample", { canUndo: true, canRedo: true }); window.activeCompletionHandler = "redo"; await restoreProjectHistory("redo");
      return window.handlerCaptures;
    }, snapshot);
    assert.deepEqual(captures, ["import", "save", "detect", "clear", "undo", "redo"].map((name) => [name, "project-A", 100]));
    assert.equal(imageGets, 6, "each real completion handler lists exactly once after capturing project A and generation 100");
  } finally { await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server); }
});
