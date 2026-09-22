"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

const catalogue = [
  ["A", true, true, false],
  ["B", true, false, false],
  ["C", false, true, false],
  ["D", false, false, false],
  ["E", true, true, true],
  ["F", true, false, true],
  ["G", false, true, true],
  ["H", false, false, true],
].map(([id, masked, reviewed, hidden], index) => ({
  id,
  relativePath: `${index < 4 ? "one" : "two"}/${id}.png`,
  sourceKind: "filesystem",
  sourcePath: `G:\\fixture\\${id}.png`,
  width: 100,
  height: 80,
  candidateCount: masked ? 1 : 0,
  enabledCandidateCount: masked ? 1 : 0,
  hasEffectiveMask: masked,
  reviewed,
  hidden,
}));

async function openEightImagePage(browser) {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.images.length === 8 && Boolean(state.settings) && Boolean(state.job));
  await page.evaluate(() => {
    for (const image of state.images) state.maskStatus.set(image.id, Boolean(image.hasEffectiveMask));
    renderCatalogViews();
  });
  return { fixture, context, page };
}

async function closeCase(fixture, context) {
  await context.close();
  await closeServer(fixture.server);
}

test("DI-126 through DI-157 render the complete M U R N H truth table in catalogue order", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    const rows = [
      ["DI-126", [], "ABCDEFGH"], ["DI-127", ["masked"], "AB"],
      ["DI-128", ["unmasked"], "CD"], ["DI-129", ["reviewed"], "AC"],
      ["DI-130", ["unreviewed"], "BD"], ["DI-131", ["hidden"], "EFGH"],
      ["DI-132", ["masked", "unmasked"], "ABCD"], ["DI-133", ["masked", "reviewed"], "ABC"],
      ["DI-134", ["masked", "unreviewed"], "ABD"], ["DI-135", ["masked", "hidden"], "ABEFGH"],
      ["DI-136", ["unmasked", "reviewed"], "ACD"], ["DI-137", ["unmasked", "unreviewed"], "BCD"],
      ["DI-138", ["unmasked", "hidden"], "CDEFGH"], ["DI-139", ["reviewed", "unreviewed"], "ABCD"],
      ["DI-140", ["reviewed", "hidden"], "ACEFGH"], ["DI-141", ["unreviewed", "hidden"], "BDEFGH"],
      ["DI-142", ["masked", "unmasked", "reviewed"], "ABCD"], ["DI-143", ["masked", "unmasked", "unreviewed"], "ABCD"],
      ["DI-144", ["masked", "unmasked", "hidden"], "ABCDEFGH"], ["DI-145", ["masked", "reviewed", "unreviewed"], "ABCD"],
      ["DI-146", ["masked", "reviewed", "hidden"], "ABCEFGH"], ["DI-147", ["masked", "unreviewed", "hidden"], "ABDEFGH"],
      ["DI-148", ["unmasked", "reviewed", "unreviewed"], "ABCD"], ["DI-149", ["unmasked", "reviewed", "hidden"], "ACDEFGH"],
      ["DI-150", ["unmasked", "unreviewed", "hidden"], "BCDEFGH"], ["DI-151", ["reviewed", "unreviewed", "hidden"], "ABCDEFGH"],
      ["DI-152", ["masked", "unmasked", "reviewed", "unreviewed"], "ABCD"],
      ["DI-153", ["masked", "unmasked", "reviewed", "hidden"], "ABCDEFGH"],
      ["DI-154", ["masked", "unmasked", "unreviewed", "hidden"], "ABCDEFGH"],
      ["DI-155", ["masked", "reviewed", "unreviewed", "hidden"], "ABCDEFGH"],
      ["DI-156", ["unmasked", "reviewed", "unreviewed", "hidden"], "ABCDEFGH"],
      ["DI-157", ["masked", "unmasked", "reviewed", "unreviewed", "hidden"], "ABCDEFGH"],
    ];
    for (const [manualId, filters, expectedText] of rows) {
      const expected = [...expectedText];
      const result = await page.evaluate((selected) => {
        state.galleryFilter = new Set(selected);
        state.overviewFilter = new Set(selected);
        renderGallery(true);
        renderOverview(true);
        return {
          galleryModel: galleryFilteredImages().map((image) => image.id),
          overviewModel: overviewImages().map((image) => image.id),
          galleryDom: [...document.querySelectorAll(".gallery-item")].map((item) => item.dataset.id),
          overviewDom: [...document.querySelectorAll(".overview-item")].map((item) => item.dataset.id),
        };
      }, filters);
      assert.deepEqual(result.galleryModel, expected, `${manualId}: left-list model`);
      assert.deepEqual(result.overviewModel, expected, `${manualId}: overview model`);
      assert.deepEqual(result.galleryDom, expected, `${manualId}: left-list DOM order`);
      assert.deepEqual(result.overviewDom, expected, `${manualId}: overview DOM order`);
    }
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-169 navigation and controls use only the current left-list filter", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    await page.evaluate(async () => {
      await selectImage("D");
      state.galleryFilter = new Set(["masked", "reviewed"]);
      renderGallery(true); updateGalleryCurrent(); updateNavigationControls();
    });
    await page.locator("#nextImageButton").click();
    await page.waitForFunction(() => state.currentId === "A" && !state.pendingImageId);
    const next = await page.evaluate(() => ({ id: state.currentId, ids: galleryFilteredImages().map((image) => image.id) }));
    assert.deepEqual(next, { id: "A", ids: ["A", "B", "C"] });

    await page.evaluate(async () => {
      await selectImage("D");
      state.galleryFilter = new Set(["masked", "reviewed"]);
      renderGallery(true); updateGalleryCurrent(); updateNavigationControls();
    });
    await page.locator("#previousImageButton").click();
    await page.waitForFunction(() => state.currentId === "C" && !state.pendingImageId);
    const previous = await page.evaluate(() => state.currentId);
    assert.equal(previous, "C");

    await page.evaluate(async () => {
      await selectImage("A");
      state.galleryFilter = new Set(["masked", "reviewed"]);
      state.navigationShortcutsEnabled = true;
      state.settings.shortcuts.enabled = true;
      renderGallery(true); updateGalleryCurrent(); updateNavigationControls(); updateActionButtons();
      document.body.tabIndex = -1; document.body.focus();
    });
    assert.deepEqual(await page.evaluate(() => ({
      id: state.currentId,
      position: document.querySelector("#imagePosition").textContent,
      previousDisabled: document.querySelector("#previousImageButton").disabled,
      nextDisabled: document.querySelector("#nextImageButton").disabled,
    })), { id: "A", position: "1 / 3", previousDisabled: true, nextDisabled: false });
    assert.deepEqual(await page.evaluate(() => ({
      action: navigationShortcutAction(new KeyboardEvent("keydown", { key: "ArrowRight" })),
      busy: isBusy(), active: document.activeElement?.tagName, dialog: hasOpenDialog(), shortcuts: state.navigationShortcutsEnabled,
      boundaryDraft: hasBoundaryDraft(), contextOpen: document.querySelector("#catalogContextMenu").matches(":popover-open"),
    })), { action: "next", busy: false, active: "BODY", dialog: false, shortcuts: true, boundaryDraft: false, contextOpen: false });
    for (const [key, expected] of [["ArrowRight", "A"], ["ArrowDown", "A"], ["ArrowLeft", "C"], ["ArrowUp", "C"], ["Home", "A"], ["End", "C"]]) {
      await page.evaluate(async () => { await selectImage("D"); document.body.tabIndex = -1; document.body.focus(); });
      await page.evaluate((pressed) => handleWindowKeydown(new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true })), key);
      await page.waitForFunction((id) => state.currentId === id && !state.pendingImageId, expected);
    }
    await page.evaluate(async () => { await selectImage("C"); updateNavigationControls(); updateActionButtons(); });
    assert.deepEqual(await page.evaluate(() => ({
      position: document.querySelector("#imagePosition").textContent,
      previousDisabled: document.querySelector("#previousImageButton").disabled,
      nextDisabled: document.querySelector("#nextImageButton").disabled,
    })), { position: "3 / 3", previousDisabled: false, nextDisabled: true });

    const one = await page.evaluate(async () => {
      state.images.forEach((image) => { image.hidden = image.id === "E"; });
      state.hiddenImageIds = new Set(["E"]); state.galleryFilter = new Set(["hidden"]);
      await selectImage("E"); renderGallery(true); updateGalleryCurrent(); updateNavigationControls(); updateActionButtons(); document.body.tabIndex = -1; document.body.focus();
      return {
        ids: galleryFilteredImages().map((image) => image.id),
        position: document.querySelector("#imagePosition").textContent,
        previousDisabled: document.querySelector("#previousImageButton").disabled,
        nextDisabled: document.querySelector("#nextImageButton").disabled,
        imageStored: Boolean(window.__di169SingleImage = state.currentImage),
      };
    });
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) await page.evaluate((pressed) => handleWindowKeydown(new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true })), key);
    assert.deepEqual(await page.evaluate((oldImage) => ({
      ids: galleryFilteredImages().map((image) => image.id), id: state.currentId,
      sameImage: state.currentImage === window.__di169SingleImage,
      position: document.querySelector("#imagePosition").textContent,
      previousDisabled: document.querySelector("#previousImageButton").disabled,
      nextDisabled: document.querySelector("#nextImageButton").disabled,
    })), { ids: ["E"], id: "E", sameImage: true, position: "1 / 1", previousDisabled: true, nextDisabled: true });

    const zero = await page.evaluate(async () => {
      await selectImage("D");
      state.images.forEach((image) => { image.hidden = false; });
      state.hiddenImageIds.clear(); state.galleryFilter = new Set(["hidden"]);
      renderGallery(true); updateGalleryCurrent(); updateNavigationControls(); updateActionButtons(); document.body.tabIndex = -1; document.body.focus();
      const take = () => ({
        ids: galleryFilteredImages().map((image) => image.id),
        position: document.querySelector("#imagePosition").textContent,
        previousDisabled: document.querySelector("#previousImageButton").disabled,
        nextDisabled: document.querySelector("#nextImageButton").disabled,
      });
      const beforeId = state.currentId; const beforeImage = state.currentImage; window.__di169ZeroImage = beforeImage;
      moveCurrentBy(1); moveCurrentBy(-1);
      return { ...take(), beforeId, afterId: state.currentId, sameImage: state.currentImage === beforeImage };
    });
    assert.equal(zero.position, "- / 0");
    assert.deepEqual(zero.ids, []);
    assert.equal(zero.previousDisabled, true);
    assert.equal(zero.nextDisabled, true);
    assert.equal(zero.afterId, zero.beforeId);
    assert.equal(zero.sameImage, true);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) await page.evaluate((pressed) => handleWindowKeydown(new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true })), key);
    assert.deepEqual(await page.evaluate(() => ({ id: state.currentId, sameImage: state.currentImage === window.__di169ZeroImage })), { id: zero.beforeId, sameImage: true });
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-185 repeated filter and folder changes restore visual and DOM catalogue order", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const result = await opened.page.evaluate(() => {
      const domIds = (selector) => [...document.querySelectorAll(selector)].map((item) => item.dataset.id);
      const visualIds = (selector) => [...document.querySelectorAll(selector)].map((item) => {
        const box = item.getBoundingClientRect(); return { id: item.dataset.id, top: box.top, left: box.left };
      }).sort((a, b) => Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left).map((item) => item.id);
      state.galleryFilter = new Set(["hidden"]); renderGallery(true);
      const hidden = domIds(".gallery-item");
      const hiddenVisual = visualIds(".gallery-item");
      state.galleryFilter = new Set(); renderGallery(true);
      const galleryRestored = domIds(".gallery-item");
      const galleryVisual = visualIds(".gallery-item");
      state.viewMode = "overview";
      state.overviewFilter = new Set(["hidden"]); state.overviewQuery = ""; state.overviewFolder = "two"; renderOverview(true);
      const narrowed = domIds(".overview-item");
      const narrowedVisual = visualIds(".overview-item");
      state.overviewFilter = new Set(); state.overviewFolder = ""; renderOverview(true);
      const overviewRestored = domIds(".overview-item");
      const overviewVisual = visualIds(".overview-item");
      return { hidden, galleryRestored, narrowed, overviewRestored, hiddenVisual, galleryVisual, narrowedVisual, overviewVisual };
    });
    assert.deepEqual(result.hidden, ["E", "F", "G", "H"]);
    assert.deepEqual(result.narrowed, ["E", "F", "G", "H"]);
    assert.deepEqual(result.galleryRestored, ["A", "B", "C", "D", "E", "F", "G", "H"]);
    assert.deepEqual(result.overviewRestored, ["A", "B", "C", "D", "E", "F", "G", "H"]);
    assert.deepEqual(result.galleryVisual, result.galleryRestored);
    assert.deepEqual(result.overviewVisual, result.overviewRestored);
    assert.deepEqual(result.hiddenVisual, result.hidden);
    assert.deepEqual(result.narrowedVisual, result.narrowed);
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-185 virtualized rows preserve screen reading and keyboard order", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    await page.evaluate(() => {
      const base = state.images[0];
      state.images = Array.from({ length: 40 }, (_, index) => ({
        ...base, id: `V${String(index).padStart(2, "0")}`,
        relativePath: `virtual/V${String(index).padStart(2, "0")}.png`,
        sourcePath: `G:\\fixture\\V${String(index).padStart(2, "0")}.png`,
        reviewed: false, hidden: false,
      }));
      state.currentId = "V00"; state.overviewFilter.clear(); state.overviewFolder = ""; state.overviewQuery = "";
      setViewMode("overview");
      const grid = document.querySelector("#overviewGrid");
      grid.style.setProperty("--catalog-columns", "2"); grid.style.height = "190px"; grid.style.overflow = "auto";
      renderOverview(true);
    });
    await page.waitForFunction(() => document.querySelectorAll(".overview-item").length > 0);
    const top = await page.evaluate(() => {
      const grid = document.querySelector("#overviewGrid");
      const cards = [...grid.querySelectorAll(".overview-item")];
      const byIndex = [...cards].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
      byIndex[0].focus();
      return {
        indices: byIndex.map((card) => Number(card.dataset.index)),
        labels: byIndex.map((card) => card.getAttribute("aria-label")),
        tabStops: cards.filter((card) => card.tabIndex === 0).map((card) => card.dataset.id),
      };
    });
    assert.deepEqual(top.indices, [...top.indices].sort((a, b) => a - b), "mounted top rows follow catalogue index order");
    assert.equal(top.labels.every((label, offset) => label.startsWith(`virtual/V${String(top.indices[offset]).padStart(2, "0")}.png`)), true,
      "the accessibility reading labels follow the same mounted catalogue order");
    assert.deepEqual(top.tabStops, ["V00"], "the virtual grid exposes one roving tab stop");

    await page.locator('.overview-item[data-id="V00"]').press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.dataset?.id === "V02");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.matches(".overview-item")), false,
      "Tab leaves the grid after its single roving entry instead of rereading every virtual cell");

    await page.evaluate(() => { const grid = document.querySelector("#overviewGrid"); grid.scrollTop = grid.scrollHeight; grid.dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => [...document.querySelectorAll(".overview-item")].some((card) => card.dataset.id === "V39"));
    const bottom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".overview-item")];
      const dom = cards.map((card) => Number(card.dataset.index));
      const visual = cards.map((card) => {
        const box = card.getBoundingClientRect(); return { index: Number(card.dataset.index), top: box.top, left: box.left };
      }).sort((a, b) => Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left).map((row) => row.index);
      return { dom, visual, first: Math.min(...dom), last: Math.max(...dom) };
    });
    assert.ok(bottom.first > 0 && bottom.last === 39, "scrolling replaces top rows with the final virtual window");
    assert.deepEqual(bottom.dom, [...bottom.dom].sort((a, b) => a - b), "virtual DOM order remains catalogue order after row replacement");
    assert.deepEqual(bottom.visual, bottom.dom, "screen coordinates remain in the same order as DOM and reading order after virtual scrolling");
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-186 browser image and project DELETE requests are bodyless and carry catalogue headers", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    const requests = [];
    await page.route(/\/api\/(catalog\/image\/A|project\/project-one)$/, async (route) => {
      const request = route.request();
      requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData(), headers: request.headers() });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: catalogue, catalogGeneration: 8 }) });
    });
    await page.evaluate(async () => {
      state.project = { id: "project-one", name: "DI" };
      state.serverCatalogGeneration = 7;
      await catalogApi("/api/catalog/image/A", {}, { method: "DELETE", resyncOnFailure: false });
      await catalogApi("/api/project/project-one", {}, { method: "DELETE", resyncOnFailure: false });
    });
    assert.deepEqual(requests.map(({ path, method, body }) => ({ path, method, body })), [
      { path: "/api/catalog/image/A", method: "DELETE", body: null },
      { path: "/api/project/project-one", method: "DELETE", body: null },
    ]);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.headers["content-length"], undefined);
      assert.equal(request.headers["x-mozarie-expected-project-id"], "project-one");
      assert.equal(request.headers["x-mozarie-expected-catalog-generation"], String(7 + index));
    }
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-186 candidate removal persists the workspace draft with POST instead of DELETE", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    const requests = [];
    await page.route(/\/api\/(workspace\/manual\/A|candidate\/A\/)/, async (route) => {
      const request = route.request();
      requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.locator('.gallery-item[data-id="A"]').click();
    await page.waitForFunction(() => state.currentId === "A" && Boolean(state.currentImage));
    await page.evaluate(async () => {
      state.settings.confirmations.candidateDelete = false;
      state.candidates = [{ id: "candidate-ui", role: "apply", enabled: true, forced: false, expandPx: 0, confidence: 0.9, labelToken: "penis", color: "#ff3d4d" }];
      const mask = document.createElement("canvas");
      mask.width = originalCanvas.width; mask.height = originalCanvas.height;
      mask.getContext("2d").fillRect(0, 0, 1, 1);
      state.candidateImages = new Map([["candidate-ui", mask]]);
      resetHistoryToCurrentManualMask();
      await deleteCandidate(state.candidates[0]);
      await flushWorkspaceDraft("A");
    });
    const workspaceWrites = requests.filter((request) => request.path === "/api/workspace/manual/A" && request.method !== "GET");
    assert.ok(workspaceWrites.length >= 1);
    assert.equal(workspaceWrites.every((request) => request.method === "POST"), true);
    assert.deepEqual(JSON.parse(workspaceWrites.at(-1).body).removedCandidateIds, ["candidate-ui"]);
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
    assert.equal(requests.some((request) => request.path.startsWith("/api/candidate/")), false);
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-191 deleted editor target advances to the next browser image", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const { page } = opened;
    await page.locator('.gallery-item[data-id="A"]').click();
    await page.waitForFunction(() => state.currentId === "A" && Boolean(state.currentImage));
    await page.evaluate(() => { state.drafts.set("A", { manualEnabled: true }); });
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.currentId === "B" && Boolean(state.currentImage) && !state.images.some((image) => image.id === "A"));
    const result = await page.evaluate(() => ({
      currentId: state.currentId, editTarget: currentRecord()?.id, pendingImageId: state.pendingImageId,
      hasCurrentImage: Boolean(state.currentImage), hasDeletedDraft: state.drafts.has("A"),
      ids: state.images.map((image) => image.id), currentDomId: document.querySelector('.gallery-item[aria-current="true"]')?.dataset.id,
    }));
    assert.equal(result.currentId, "B");
    assert.equal(result.editTarget, "B");
    assert.equal(result.hasCurrentImage, true);
    assert.equal(result.currentDomId, "B");
    assert.equal(result.pendingImageId, null);
    assert.equal(result.hasDeletedDraft, false);
    assert.deepEqual(result.ids, ["B", "C", "D", "E", "F", "G", "H"]);
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});

test("DI-193 stale delete resync replaces the browser catalogue", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let opened;
  try {
    opened = await openEightImagePage(browser);
    const authoritative = { images: catalogue.slice(1, 3), root: "", project: { id: "project-one", name: "DI" }, readOnly: false, catalogGeneration: 9 };
    await opened.page.route(/\/api\/catalog\/image\/A$/, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog", params: {} }) }));
    await opened.page.route(/\/api\/images$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) }));
    const result = await opened.page.evaluate(async () => {
      state.project = { id: "project-one", name: "DI" }; state.serverCatalogGeneration = 7;
      try { await catalogApi("/api/catalog/image/A", {}, { method: "DELETE" }); } catch {}
      return { ids: state.images.map((image) => image.id), generation: state.serverCatalogGeneration,
        dom: [...document.querySelectorAll(".gallery-item")].map((item) => item.dataset.id) };
    });
    assert.deepEqual(result, { ids: ["B", "C"], generation: 9, dom: ["B", "C"] });
  } finally {
    if (opened) await closeCase(opened.fixture, opened.context);
    await browser.close();
  }
});
