"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function freshPage(browser, fixture, initScript = null, expectedImageCount = 2) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((expectedCount) => {
    return Boolean(state.settings) && Boolean(state.job)
      && state.images.length === expectedCount
      && document.querySelectorAll(".gallery-item").length === expectedCount;
  }, expectedImageCount);
  return { context, page };
}

test("filter popover combines checked states and review-at-tail stays on the filtered image", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
    { id: "sample-two", relativePath: "sample-two.png", sourceKind: "session", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false, hasEffectiveMask: false },
  ]);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="masked"]').check();
    await page.locator('[data-gallery-filter="unreviewed"]').check();
    await page.waitForFunction(() => state.galleryFilter instanceof Set && state.galleryFilter.size === 2);
    assert.deepEqual(await page.evaluate(() => state.images.filter(imageMatchesGalleryFilter).map((image) => image.id)), ["sample", "sample-two"], "checked filters use OR and do not make mosaic status depend on reviewed state");

    await page.locator('[data-gallery-filter="unreviewed"]').uncheck();
    await page.waitForFunction(() => state.images.filter(imageMatchesGalleryFilter).length === 1);
    assert.deepEqual(await page.evaluate(() => state.images.filter(imageMatchesGalleryFilter).map((image) => image.id)), ["sample"], "mosaic-only still includes an already-reviewed image");

    await page.keyboard.press("Escape");
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample")?.reviewed === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample", "review at the filtered tail leaves the reviewed current image selected");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("all-image detection submits the fluid color-fill settings with default tolerance 26", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => {
      window.__detectPayloads = [];
      const nativeFetch = window.fetch;
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input);
        if (url.endsWith("/api/detect")) window.__detectPayloads.push(JSON.parse(init.body));
        return nativeFetch(input, init);
      };
    });
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "26", "the all-image dialog starts at the configured default tolerance");
    await page.locator("#detectFluidColorFillTolerance").fill("27");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => window.__detectPayloads.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__detectPayloads[0]), {
      imageIds: ["sample", "sample-two"], confidence: 0.5, parallelism: 2, targetClasses: ["penis", "pussy"], fluidColorFillEnabled: false, fluidColorFillTolerance: 27,
    }, "the modal sends an explicit fluid-fill switch and tolerance with the detection request");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("all-image detection filters images with independent OR checkboxes and persists the selection", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: true, hidden: false, hasEffectiveMask: true },
    { id: "sample-two", relativePath: "sample-two.png", sourceKind: "session", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false, hasEffectiveMask: false },
    { id: "masked-unreviewed", relativePath: "masked-unreviewed.png", sourceKind: "session", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
    { id: "unmasked-reviewed", relativePath: "unmasked-reviewed.png", sourceKind: "session", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: true, hidden: false, hasEffectiveMask: false },
    { id: "hidden-unreviewed", relativePath: "hidden-unreviewed.png", sourceKind: "session", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: true, hasEffectiveMask: true },
  ]);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture, null, 5));
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.equal(await page.locator("#detectImageFilters legend").textContent(), "検出する画像", "image filters have their own named group");
    assert.equal(await page.locator("#detectImageFilters").evaluate((field) => field.contains(document.querySelector("#dialogTargetPenis"))), false, "image filters are separate from detection classes");
    assert.deepEqual(await page.locator("[data-detection-image-filter]").evaluateAll((inputs) => inputs.map((input) => [input.dataset.detectionImageFilter, input.checked])), [
      ["masked", false], ["unmasked", false], ["reviewed", false], ["unreviewed", true],
    ], "the default filter selects only unreviewed images");
    assert.match(await page.locator("#detectTargetCount").textContent(), /2件$/, "the default excludes reviewed and hidden images");

    const setFilters = async (...filters) => {
      await page.locator("[data-detection-image-filter]").evaluateAll((inputs, selected) => {
        for (const input of inputs) {
          input.checked = selected.includes(input.dataset.detectionImageFilter);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, filters);
    };
    const targetIds = () => page.evaluate(() => [...state.pendingDetectionTargetIds]);
    await setFilters();
    assert.deepEqual(await targetIds(), ["sample", "sample-two", "masked-unreviewed", "unmasked-reviewed"], "no checked filter means every non-hidden image");
    await setFilters("masked");
    assert.deepEqual(await targetIds(), ["sample", "masked-unreviewed"], "masked ignores review state");
    await setFilters("unmasked");
    assert.deepEqual(await targetIds(), ["sample-two", "unmasked-reviewed"], "unmasked ignores review state");
    await setFilters("reviewed");
    assert.deepEqual(await targetIds(), ["sample", "unmasked-reviewed"], "reviewed ignores mask state");
    await setFilters("unreviewed");
    assert.deepEqual(await targetIds(), ["sample-two", "masked-unreviewed"], "unreviewed excludes reviewed images");
    await setFilters("masked", "unreviewed");
    assert.deepEqual(await targetIds(), ["sample", "sample-two", "masked-unreviewed"], "multiple checked filters use OR semantics");

    await page.evaluate(() => {
      for (const image of state.images) { image.reviewed = true; state.reviewedImageIds.add(image.id); }
      renderCatalogViews(); syncDetectionDialog();
    });
    await setFilters("unreviewed");
    assert.match(await page.locator("#detectTargetCount").textContent(), /0件$/, "filter changes update the target count immediately");
    assert.equal(await page.locator("#detectStartButton").isDisabled(), true, "detection cannot start with no matching image");
    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "sample-two");
      image.reviewed = false; state.reviewedImageIds.delete(image.id); renderCatalogViews(); syncDetectionDialog();
    });
    const detectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await detectRequest).postData()).imageIds, ["sample-two"], "the all-image request excludes the reviewed image");
    assert.deepEqual(fixture.settingsPayloads.at(-1).body.detection.image_filters, ["unreviewed"], "starting detection persists the selected image filters");
    await page.waitForFunction(() => state.detectionStarting === false);
    fixture.finishCancel();
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => state.job?.state === "cancelled" && state.processing === null);
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.equal(await page.locator('[data-detection-image-filter="unreviewed"]').isChecked(), true, "the saved filter is restored when the modal reopens");
    assert.deepEqual(await page.locator("#detectForm").evaluate((form) => [
      "dialogTargetPenis", "dialogTargetPussy", "detectFilterMasked", "detectFilterUnmasked",
      "detectFilterReviewed", "detectFilterUnreviewed", "detectParallelism", "detectConfidenceRange",
      "detectConfidenceNumber", "detectCandidatePadding", "detectExcludeCandidatePadding", "detectCancelButton",
    ].filter((id) => form.querySelector(`#${id}`).disabled)), [], "a successful run restores every reusable modal control before the same page reopens it");
    await page.locator("#detectCancelButton").click();

    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    assert.equal(await page.locator("#detectCurrentButton").isEnabled(), true, "the explicit current-image action still permits detection of a reviewed image");
    let explicitRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectCurrentButton").click();
    assert.deepEqual(JSON.parse((await explicitRequest).postData()).imageIds, ["sample"], "current-image detection submits the reviewed image explicitly");
    await context.close();
    fixture.resetJob();

    ({ context, page } = await freshPage(browser, fixture, null, 5));
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => state.job?.state === "idle");
    await page.evaluate(() => setViewMode("overview"));
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample"]').click();
    await page.locator("#selectionActionsButton").click();
    explicitRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator('[data-selection-action="detect"]').click();
    assert.equal(await page.locator("#detectImageFilters").isHidden(), true, "selected-image detection does not expose all-image filters");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await explicitRequest).postData()).imageIds, ["sample"], "selected-image detection submits the reviewed image explicitly");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("hiding an image removes it from the visible all-image detection and save targets", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#removeCurrentImageButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample")?.hidden === true);

    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.match(await page.locator("#detectTargetCount").textContent(), /1件$/, "the all-image dialog counts only processable images");
    const detectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await detectRequest).postData()), { imageIds: ["sample-two"], confidence: 0.5, parallelism: 2, targetClasses: ["penis", "pussy"], fluidColorFillEnabled: true, fluidColorFillTolerance: 26 }, "all-image detection never submits a hidden image");
    assert.deepEqual(await page.evaluate(() => ({ hidden: [...state.hiddenImageIds], processable: processableImages().map((image) => image.id), image: state.images.find((image) => image.id === "sample")?.hidden })), { hidden: ["sample"], processable: ["sample-two"], image: true }, "detection preserves the hidden workspace flag before saving");

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    assert.match(await page.locator("#applyTargetCount").textContent(), /1件$/, "the visible all-image save dialog excludes hidden images");
    assert.deepEqual(await page.evaluate(() => state.applyTargetIds), ["sample-two"], "the save request target state has no hidden IDs");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("filtered review and hide keep their tail, while deletion selects the previous filtered image", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
    { id: "sample-two", relativePath: "sample-two.png", sourceKind: "session", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
  ]);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => { state.galleryFilter = new Set(["masked"]); renderGallery(true); });

    await page.locator('.gallery-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => state.currentId === "sample-two" && state.currentImage);
    await page.evaluate(() => {
      // Selecting an image refreshes its fixture candidates.  Establish the
      // filter after that asynchronous refresh so this is a true two-image
      // filtered-tail case, not an index-missing fallback case.
      for (const image of state.images) state.maskStatus.set(image.id, true);
      renderGallery(true);
    });
    assert.deepEqual(await page.evaluate(() => galleryFilteredImages().map((image) => image.id)), ["sample", "sample-two"], "the selected image is the tail of the active filter");
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample-two")?.reviewed === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample-two", "reviewing the last filtered image never moves backwards");

    await page.locator("#hideAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample-two")?.hidden === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample-two", "hiding the last filtered image keeps that image on screen");

    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "sample-two");
      image.hidden = false;
      state.hiddenImageIds.delete(image.id);
      renderGallery(true);
    });
    await page.evaluate(async () => {
      const removed = new Set(["sample-two"]);
      const selection = deletionSelectionSnapshot(removed, galleryFilteredImages());
      state.images = state.images.filter((image) => !removed.has(image.id));
      await restoreDeletionSelection(selection, removed);
      renderCatalogViews();
    });
    await page.waitForFunction(() => state.images.length === 1 && state.currentId === "sample");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["sample"], "deleting the tail removes it and selects the previous filtered image");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("OR filters move from an outside current image to the first match, through the middle, and keep a one-item tail selected", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  fixture.setCatalog([
    { id: "outside", relativePath: "outside.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\outside.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
    { id: "first-match", relativePath: "first-match.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\first-match.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false },
    { id: "last-match", relativePath: "last-match.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\last-match.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: true, hidden: false },
  ]);
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture, null, 3));
    await page.locator('.gallery-item[data-id="outside"]').click();
    await page.waitForFunction(() => state.currentId === "outside" && state.currentImage);
    await page.evaluate(() => {
      state.maskStatus.set("first-match", true);
      state.reviewedImageIds = new Set(["last-match"]);
      state.images.find((image) => image.id === "last-match").reviewed = true;
      renderGallery(true);
    });
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="masked"]').check();
    await page.locator('[data-gallery-filter="reviewed"]').check();
    assert.deepEqual(await page.evaluate(() => galleryFilteredImages().map((image) => image.id)), ["first-match", "last-match"], "checked filter states combine with OR and retain their catalogue order");

    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.currentId === "first-match" && state.currentImage);
    await page.evaluate(() => { state.maskStatus.set("first-match", true); renderGallery(true); });
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.currentId === "last-match" && state.currentImage);
    await page.waitForFunction(() => !currentImageActionPending());
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "last-match")?.reviewed === true);
    assert.equal(await page.evaluate(() => state.currentId), "last-match", "reviewing the tail does not wrap or move backward");

    await page.locator("#hideAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "last-match")?.hidden === true);
    assert.equal(await page.evaluate(() => state.currentId), "last-match", "hiding the only remaining filtered tail keeps its current canvas selected");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("fill tolerance buttons change one step and candidate deletion is undoable", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#bucketTool").click();
    const tolerance = page.locator("#bucketTolerance");
    const initialTolerance = Number(await tolerance.inputValue());
    await page.locator("#bucketToleranceIncrease").click();
    assert.equal(Number(await tolerance.inputValue()), initialTolerance + 1, "plus raises fill tolerance by one");
    await page.locator("#bucketToleranceDecrease").click();
    assert.equal(Number(await tolerance.inputValue()), initialTolerance, "minus lowers fill tolerance by one");
    await page.locator("#bucketToleranceClose").click();

    await page.evaluate(() => {
      state.settings.confirmations.candidateDelete = false;
      state.candidates = [{ id: "undoable", role: "apply", enabled: true, forced: false, expandPx: 0, confidence: .61, labelToken: "penis", color: "#ff3d4d" }];
      const mask = document.createElement("canvas"); mask.width = originalCanvas.width; mask.height = originalCanvas.height;
      mask.getContext("2d").fillRect(3, 3, 8, 8);
      state.candidateImages = new Map([["undoable", mask]]);
      state.removedCandidateIds = new Set(); resetHistoryToCurrentManualMask(); renderCandidates();
    });
    const row = page.locator('.candidate-row[data-candidate-blink-id="undoable"]');
    assert.equal(await row.locator(".candidate-row-heading > button").getAttribute("class"), "candidate-delete", "candidate remove control is at the row's upper-right heading edge");
    await row.locator(".candidate-delete").click();
    await page.waitForFunction(() => state.removedCandidateIds.has("undoable"));
    assert.equal(await page.evaluate(() => $("#undoButton").disabled), false, "candidate deletion enables undo immediately");
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !state.removedCandidateIds.has("undoable"));
    assert.equal(await row.locator(".candidate-delete").count(), 1, "undo restores the deleted candidate row");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});
