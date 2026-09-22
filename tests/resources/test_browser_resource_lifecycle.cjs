"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

function bitmap(id) {
  return { id, closed: false, close() { assert.equal(this.closed, false, `${id} closes once`); this.closed = true; } };
}

async function closeSettingsAfterRestore(page) {
  await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
  const priorShortcut = await page.locator("#shortcutBindings input").first().elementHandle();
  try {
    await page.locator("#settingsCloseButton").click();
    // Closing restores translations asynchronously, then replaces shortcut
    // controls. Include that work before taking the next listener baseline.
    await page.waitForFunction((previous) => !document.querySelector("#settingsDialog").open
      && !previous.isConnected && document.querySelector("#shortcutBindings input")?.isConnected, priorShortcut);
  } finally { await priorShortcut.dispose(); }
}

test("candidate and project resource ownership releases every obsolete bitmap while retaining the complete current bundle", () => {
  const state = {
    images: [], currentId: null, pendingImageId: null, pendingImageKey: null, pendingCandidateKey: null, hoverPrefetchId: null,
    resourceImageKeys: new Set(), resourceCandidateKeys: new Set(), imageLoadControllers: new Map(), candidateLoadControllers: new Map(),
  };
  const context = {
    state, Map, Set,
    imageAssetVersion: (record) => record?.assetVersion || "",
    imageCacheKey: (record) => `${record.id}:${record.assetVersion || ""}`,
    candidateCacheKey: (imageId, revision) => `${imageId}:${revision}`,
    galleryNavigationNeighbors: () => [], galleryFilteredImages: () => [],
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", "resources.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "resources.js" });
  vm.runInNewContext("globalThis.resourceTest = { syncResourceOwnership };", context);

  const oldImages = [];
  const oldCandidateBitmaps = [];
  for (let project = 0; project < 12; project += 1) {
    const oldImage = bitmap(`project-${project}-image`); oldImages.push(oldImage);
    const masks = new Map(Array.from({ length: 17 }, (_, index) => {
      const mask = bitmap(`project-${project}-candidate-${index}`); oldCandidateBitmaps.push(mask); return [`candidate-${index}`, mask];
    }));
    state.imageCache.set(`project-${project}:v1`, oldImage);
    state.candidateBundleCache.set(`project-${project}:1`, { candidates: Array.from(masks.keys()), candidateImages: masks });
  }

  const currentRecord = { id: "current", assetVersion: "v2", candidateRevision: 3 };
  const currentImage = bitmap("current-image");
  const currentMasks = new Map(Array.from({ length: 65 }, (_, index) => [`current-${index}`, bitmap(`current-candidate-${index}`)]));
  const currentBundle = { candidates: Array.from(currentMasks.keys()), candidateImages: currentMasks };
  state.images = [currentRecord]; state.currentId = currentRecord.id; state.currentImage = currentImage; state.candidateImages = currentMasks;
  state.imageCache.set("current:v2", currentImage);
  state.candidateBundleCache.set("current:3", currentBundle);
  context.resourceTest.syncResourceOwnership();

  assert.ok(oldImages.every((image) => image.closed), "all images owned by closed projects are released");
  assert.ok(oldCandidateBitmaps.every((image) => image.closed), "all candidate bitmaps owned by closed projects are released");
  assert.equal(state.imageCache.items.size, 1, "only the current project image remains owned");
  assert.equal(state.candidateBundleCache.items.size, 1, "only the current candidate bundle remains owned");
  assert.equal(state.candidateBundleCache.get("current:3"), currentBundle, "the current bundle is retained regardless of its size");
  assert.equal(currentBundle.candidates.length, 65, "every current candidate remains present above the former cache-sized fixture");
  assert.equal(currentBundle.candidateImages.size, 65, "every current candidate bitmap remains displayed");
  assert.equal(currentImage.closed, false, "the current project image is not released");
  assert.ok([...currentMasks.values()].every((image) => !image.closed), "current candidate bitmaps are not released");
});

test("repeated settings, project rows, and candidate padding lifecycles retain one owner and send one commit", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(Array.from({ length: 400 }, (_, index) => ({
    id: `lifecycle-${index}`, relativePath: `lifecycle/${index}.png`, sourceKind: "fixture", width: 100, height: 80,
    candidateCount: 0, enabledCandidateCount: 0, candidateRevision: 0, reviewed: index % 2 === 0, hidden: false,
  })));
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      const originalAdd = EventTarget.prototype.addEventListener;
      const originalRemove = EventTarget.prototype.removeEventListener;
      const active = new WeakMap(); const targets = new Set(); let activeTotal = 0;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        let byType = active.get(this); if (!byType) { byType = new Map(); active.set(this, byType); targets.add(this); }
        let listeners = byType.get(type); if (!listeners) { listeners = new Set(); byType.set(type, listeners); }
        if (!listeners.has(listener)) { listeners.add(listener); activeTotal += 1; }
        return originalAdd.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const listeners = active.get(this)?.get(type); if (listeners?.delete(listener)) activeTotal -= 1;
        return originalRemove.call(this, type, listener, options);
      };
      window.__activeListenerTotal = () => activeTotal;
      window.__connectedListenerTotal = () => [...targets].filter((target) => target === window || target === document || target?.isConnected).reduce((total, target) => {
        const byType = active.get(target); return total + [...(byType?.values() || [])].reduce((sum, listeners) => sum + listeners.size, 0);
      }, 0);
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    const page = await context.newPage();
    let batchRequests = 0; let singleRequests = 0;
    let paddingRevision = 1;
    const paddingCandidates = [
      { id: "padding-one", role: "apply", enabled: true, forced: false, labelToken: "penis", source: "target", refinement: null, confidence: .9, color: "#fff", expandPx: 2 },
      { id: "padding-two", role: "apply", enabled: true, forced: false, labelToken: "pussy", source: "target", refinement: null, confidence: .8, color: "#fff", expandPx: 7 },
    ];
    await page.route("**/api/candidates/batch", async (route) => {
      batchRequests += 1;
      paddingRevision += 1;
      for (const candidate of paddingCandidates) candidate.expandPx = route.request().postDataJSON().expandPx;
      await route.fulfill({ json: { candidateRevision: paddingRevision } });
    });
    await page.route("**/api/candidate/**", async (route) => {
      singleRequests += 1;
      paddingRevision += 1;
      paddingCandidates[0].expandPx = route.request().postDataJSON().expandPx;
      await route.fulfill({ json: { candidateRevision: paddingRevision } });
    });
    await page.route("**/api/candidates/lifecycle-0", (route) => route.fulfill({ json: { candidates: batchRequests ? paddingCandidates : paddingCandidates.slice(0, 1), candidateRevision: paddingRevision } }));
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 400);
    let galleryPlateau = null;
    for (let index = 0; index < 12; index += 1) {
      const filter = index % 2 ? "reviewed" : "unreviewed";
      await page.locator("#galleryFilterButton").click();
      for (const input of await page.locator("[data-gallery-filter]:checked").all()) await input.uncheck();
      await page.locator(`[data-gallery-filter="${filter}"]`).check();
      await page.locator("#galleryFilterButton").click();
      await page.locator("#overviewButton").click(); await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
      await page.locator("#closeOverviewButton").click();
      const mounted = await page.locator(".gallery-item, .overview-item").count();
      const maps = await page.evaluate(() => [state.galleryNodes.size, state.overviewNodes.size]);
      const sample = [mounted, ...maps];
      if (galleryPlateau === null) galleryPlateau = sample;
      else assert.deepEqual(sample, galleryPlateau, "every repeated 400-image filter/overview cycle returns to the first stable connected-node and map counts");
    }
    await page.locator("#settingsButton").click(); await closeSettingsAfterRestore(page);
    await page.evaluate(() => showProjectList());
    await page.waitForFunction(() => document.querySelector("#projectListDialog").open && document.querySelectorAll("#projectListBody tr").length > 0);
    await page.locator("#projectListClose").click();
    await page.waitForFunction(() => !document.querySelector("#projectListDialog").open);
    await page.evaluate(() => { window.__settingsStaticControls = [document.querySelector("#settingsDialog"), document.querySelector("#settingsLanguage"), document.querySelector("#settingsSaveParallelism")]; });
    const baselineListeners = await page.evaluate(() => window.__connectedListenerTotal());
    for (let index = 0; index < 15; index += 1) {
      await page.locator("#settingsButton").click();
      await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
      await closeSettingsAfterRestore(page);
    }
    assert.equal(await page.locator("#settingsDialog").count(), 1, "settings always reuses its single connected dialog root");
    assert.equal(await page.locator("#settingsDialog").evaluate((node) => node.isConnected), true, "settings leaves no detached replacement root");
    assert.equal(await page.evaluate(() => window.__settingsStaticControls.every((node) => node?.isConnected) && window.__settingsStaticControls.every((node) => document.getElementById(node.id) === node)), true, "settings reuses its static root and controls instead of replacing them");
    assert.equal(await page.evaluate(() => window.__connectedListenerTotal()), baselineListeners, "settings open and close does not accumulate listeners on live controls");
    await page.evaluate(() => { window.__priorProjectRows = []; });
    const projectListenerTotal = await page.evaluate(() => window.__activeListenerTotal());
    for (let index = 0; index < 15; index += 1) {
      await page.evaluate(() => showProjectList());
      await page.waitForFunction(() => document.querySelector("#projectListDialog").open && document.querySelectorAll("#projectListBody tr").length > 0);
      const disconnected = await page.evaluate(() => window.__priorProjectRows.every((row) => !row.isConnected));
      assert.equal(disconnected, true, "every prior project table row is detached before the replacement table is observed");
      await page.evaluate(() => { window.__priorProjectRows = [...document.querySelectorAll("#projectListBody tr")]; });
      const rowIds = await page.locator("#projectListBody tr").evaluateAll((rows) => rows.map((row) => row.dataset.projectId));
      assert.equal(rowIds.length, new Set(rowIds).size, "project rows never accumulate duplicates across opens");
      await page.locator("#projectListClose").click();
    }
    assert.equal(await page.evaluate(() => projectListProjects.size === document.querySelectorAll("#projectListBody tr").length && [...projectListProjects.values()].every((value) => !(value instanceof Node))), true, "project state retains only current project data and no detached row nodes");
    assert.equal(await page.evaluate(() => window.__activeListenerTotal()), projectListenerTotal, "delegated project-row handling retains no listener on replaced rows");
    assert.equal(await page.evaluate(() => window.__connectedListenerTotal()), baselineListeners, "project manager refreshes do not accumulate listeners on live rows");

    const maskPng = await page.evaluate(async (candidates) => {
      const record = state.images[0]; state.currentId = record.id;
      const image = document.createElement("canvas"); image.width = record.width; image.height = record.height;
      const imageContext = image.getContext("2d"); imageContext.fillStyle = "#789"; imageContext.fillRect(0, 0, image.width, image.height);
      state.currentImage = await createImageBitmap(image); canvasSizeForImage(record); prepareOriginalImage();
      const mask = document.createElement("canvas"); mask.width = record.width; mask.height = record.height;
      const maskContext = mask.getContext("2d"); maskContext.fillStyle = "#fff"; maskContext.fillRect(30, 20, 20, 20);
      window.__lifecycleMask = mask;
      record.candidateRevision = 1;
      state.candidates = candidates;
      state.candidateImages = new Map([["padding-one", mask]]); state.removedCandidateIds = new Set(); renderCandidates();
      return mask.toDataURL().split(",")[1];
    }, paddingCandidates.slice(0, 1));
    await page.route("**/api/mask/lifecycle-0/*", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(maskPng, "base64") }));
    const errorDialogs = [];
    await page.exposeFunction("recordLifecycleError", (text) => errorDialogs.push(text));
    await page.evaluate(() => {
      const dialog = document.querySelector("#errorDialog");
      window.__lifecycleErrorObserver = new MutationObserver(() => { if (dialog.open) void window.recordLifecycleError(dialog.textContent); });
      window.__lifecycleErrorObserver.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    });
    const paddingTrigger = page.locator('[data-candidate-padding-id="padding-one"]');
    await paddingTrigger.waitFor();
    const paddingBaselineListeners = await page.evaluate(() => window.__connectedListenerTotal());
    const paddingActiveListeners = await page.evaluate(() => window.__activeListenerTotal());
    await page.evaluate(() => { window.__paddingStaticControls = [document.querySelector("#candidatePaddingPopover"), document.querySelector("#candidatePaddingInput"), document.querySelector("#candidatePaddingConfirm")]; });
    for (let index = 0; index < 15; index += 1) {
      await paddingTrigger.click();
      await page.waitForFunction(() => document.querySelector("#candidatePaddingPopover").matches(":popover-open"));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#candidatePaddingPopover").matches(":popover-open"));
    }
    assert.equal(await page.evaluate(() => window.__connectedListenerTotal()), paddingBaselineListeners, "padding popover reuse does not accumulate listeners on its live controls");
    assert.equal(await page.evaluate(() => window.__activeListenerTotal()), paddingActiveListeners, "padding open and cancel retains no listener on detached controls");
    assert.equal(await page.evaluate(() => window.__paddingStaticControls.every((node) => node?.isConnected && document.getElementById(node.id) === node)), true, "padding always reuses the same popover and controls");
    await paddingTrigger.click();
    await page.locator("#candidatePaddingInput").fill("7");
    await page.waitForFunction(() => state.candidatePaddingPreviewImages.size === 1 || document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "single padding preview decodes its valid fixture mask without an error dialog");
    await page.locator("#candidatePaddingConfirm").click();
    await page.waitForFunction(() => !document.querySelector("#candidatePaddingPopover").matches(":popover-open"));
    await page.waitForFunction(() => !state.candidateControlLocks.size);
    assert.equal(singleRequests, 1, "one single-row padding confirmation sends exactly one update");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "single padding confirmation succeeds without dismissing an error");
    assert.equal(await page.evaluate(() => state.candidates[0].expandPx), 7);

    await page.evaluate((candidates) => {
      const record = state.images[0]; record.candidateRevision = 2;
      state.projectReadOnly = false; state.candidateControlLocks.clear(); state.candidateBatchPending.clear();
      state.candidates = candidates;
      state.candidateImages = new Map([["padding-one", window.__lifecycleMask], ["padding-two", window.__lifecycleMask]]); renderCandidates(); updateActionButtons();
    }, paddingCandidates);
    const batchTrigger = page.locator('[data-candidate-padding-batch="apply"]');
    for (let index = 0; index < 10; index += 1) {
      await batchTrigger.click(); await page.keyboard.press("Escape");
    }
    await batchTrigger.click(); await page.locator("#candidatePaddingInput").fill("9"); await page.locator("#candidatePaddingConfirm").click();
    await page.waitForFunction(() => !state.candidateBatchPending.size);
    assert.equal(batchRequests, 1, "one batch padding confirmation sends exactly one update after repeated cancels");
    assert.deepEqual(await page.evaluate(() => state.candidates.map((candidate) => candidate.expandPx)), [9, 9], "the committed batch retains both candidates with their new padding");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "batch padding confirmation succeeds without an error dialog");
    assert.deepEqual(errorDialogs, [], "no padding lifecycle opens an error dialog, including transient failures");
    await page.evaluate(() => { window.__lifecycleErrorObserver.disconnect(); delete window.__lifecycleErrorObserver; delete window.__lifecycleMask; });
    assert.equal(await page.evaluate(() => state.candidatePaddingPreviewImages.size), 0, "padding confirmation leaves no preview bitmap owned");

    const projectRelease = await page.evaluate(() => {
      const owned = (id) => ({ id, closed: false, close() { this.closed = true; } });
      const oldRecord = { id: "old-project-image", assetVersion: "old", candidateRevision: 1, width: 4000, height: 3000 };
      const nextRecord = { id: "next-project-image", assetVersion: "next", candidateRevision: 2, width: 3000, height: 2000 };
      const oldImage = owned("old-image"); const nextImage = owned("next-image"); const oldMask = owned("old-mask"); const nextMask = owned("next-mask");
      state.images = [oldRecord, nextRecord]; state.currentId = oldRecord.id; state.currentImage = oldImage; state.candidateImages = new Map([["old", oldMask]]);
      state.resourceImageKeys = new Set([imageCacheKey(oldRecord), imageCacheKey(nextRecord)]);
      state.resourceCandidateKeys = new Set([candidateCacheKey(oldRecord.id, 1), candidateCacheKey(nextRecord.id, 2)]);
      state.imageCache.set(imageCacheKey(oldRecord), oldImage); state.imageCache.set(imageCacheKey(nextRecord), nextImage);
      state.candidateBundleCache.set(candidateCacheKey(oldRecord.id, 1), { candidates: [{ id: "old" }], candidateImages: state.candidateImages });
      state.candidateBundleCache.set(candidateCacheKey(nextRecord.id, 2), { candidates: [{ id: "next" }], candidateImages: new Map([["next", nextMask]]) });
      state.images = [nextRecord]; state.currentId = nextRecord.id; state.currentImage = nextImage; state.candidateImages = state.candidateBundleCache.get(candidateCacheKey(nextRecord.id, 2)).candidateImages;
      syncResourceOwnership();
      const afterSwitch = { oldImage: oldImage.closed, oldMask: oldMask.closed, nextImage: nextImage.closed, nextMask: nextMask.closed };
      state.currentId = null; state.currentImage = null; state.candidates = []; state.candidateImages = new Map(); clearEditor();
      return {
        afterSwitch,
        canvasSizes: [originalCanvas, addCanvas, exclusionCanvas, exclusionEraseCanvas, effectiveExclusionCanvas, combinedCanvas, mosaicCanvas].map((canvas) => [canvas.width, canvas.height]),
        empty: !state.currentId && document.querySelector("#emptyState").hidden === false,
      };
    });
    assert.deepEqual(projectRelease.afterSwitch, { oldImage: true, oldMask: true, nextImage: false, nextMask: false }, "project ownership switch releases only the former image and candidate bundle");
    assert.ok(projectRelease.canvasSizes.every(([width, height]) => width === 1 && height === 1), "closing the editor releases every large drawing buffer");
    assert.equal(projectRelease.empty, true, "closed project pixels cannot remain presented as the current image");
  } finally {
    await context?.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
});

test("repeated settings and project dialog lifecycles reuse their DOM instead of accumulating rows or controls", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    const initialSettingsNodes = await page.locator("#settingsDialog *").count();
    for (let index = 0; index < 12; index += 1) {
      await page.locator("#settingsButton").click();
      await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
      assert.equal(await page.locator("#settingsDialog *").count(), initialSettingsNodes, "each settings open reuses the same bounded form DOM");
      await page.locator("#settingsCloseButton").click();
      await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    }
    assert.equal(await page.locator("#settingsDialog").count(), 1, "settings lifecycle retains exactly one dialog root");

    for (let index = 0; index < 12; index += 1) {
      await page.evaluate(() => showProjectList());
      await page.waitForFunction(() => document.querySelector("#projectListDialog").open && document.querySelectorAll("#projectListBody tr").length > 0);
      const rowIds = await page.locator("#projectListBody tr").evaluateAll((rows) => rows.map((row) => row.dataset.projectId));
      assert.equal(new Set(rowIds).size, rowIds.length, "each project-manager open replaces its rows without retaining duplicates");
      await page.locator("#projectListClose").click();
      await page.waitForFunction(() => !document.querySelector("#projectListDialog").open);
    }
    assert.equal(await page.locator("#projectListDialog").count(), 1, "project manager lifecycle retains exactly one dialog root");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
