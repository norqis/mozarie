"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

const catalogue = [
  ["A", "one/A.png", true, false, false],
  ["B", "one/B.png", false, false, false],
  ["C", "two/C.png", true, true, false],
  ["D", "two/D.png", true, false, false],
].map(([id, relativePath, masked, reviewed, hidden]) => ({
  id,
  relativePath,
  sourceKind: "filesystem",
  sourcePath: `G:\\fixture\\${relativePath.replaceAll("/", "\\")}`,
  width: 100,
  height: 80,
  candidateCount: masked ? 1 : 0,
  enabledCandidateCount: masked ? 1 : 0,
  hasEffectiveMask: masked,
  reviewed,
  hidden,
}));

async function openPage(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.images.length === 4 && Boolean(state.settings) && Boolean(state.job));
  await page.evaluate(() => {
    for (const image of state.images) state.maskStatus.set(image.id, Boolean(image.hasEffectiveMask));
    state.settings.confirmations.removeImage = true;
    renderCatalogViews();
  });
  return { context, page };
}

async function selectImage(page, imageId) {
  await page.locator(`.gallery-item[data-id="${imageId}"]`).click();
  await page.waitForFunction((id) => state.currentId === id && Boolean(state.currentImage), imageId);
}

async function acceptDelete(page) {
  await page.locator("#removeAndNextButton").click();
  await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
  await page.locator("#confirmAccept").click();
}

test("DI-158 DI-160 and DI-166 delete against the captured filtered order and keep authority on cancel or stale response", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    let opened = await openPage(browser, fixture); context = opened.context;
    let { page } = opened;
    await selectImage(page, "B");
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="masked"]').check();
    await page.waitForFunction(() => galleryFilteredImages().map((image) => image.id).join(",") === "A,C,D");
    const requestsBeforeCancel = fixture.sourceDeleteRequests.length;
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => !document.querySelector("#confirmDialog").open);
    assert.equal(fixture.sourceDeleteRequests.length, requestsBeforeCancel, "cancel sends no delete protocol request");
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id),
      visible: galleryFilteredImages().map((image) => image.id),
      currentId: state.currentId,
      hasCanvas: Boolean(state.currentImage),
    })), { ids: ["A", "B", "C", "D"], visible: ["A", "C", "D"], currentId: "B", hasCanvas: true }, "cancel preserves catalogue, filter, current image, and canvas");

    let imageSnapshots = 0;
    await page.route("**/api/images", async (route) => { imageSnapshots += 1; await route.continue(); });
    const stalePrepareHandler = async (route) => {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    };
    await page.route("**/api/catalog/delete-source/prepare", stalePrepareHandler);
    const stalePrepare = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/catalog/delete-source/prepare");
    await acceptDelete(page);
    await stalePrepare;
    await page.waitForFunction(() => document.querySelector("#errorDialog").open && !state.catalogMutation);
    assert.ok(imageSnapshots >= 1, "a stale delete reloads the authoritative catalogue");
    assert.equal(await page.locator("#errorDialogTitle").textContent(), "画像一覧が変わりました", "a catalog conflict uses the specific Japanese guidance instead of a generic internal error");
    assert.match(await page.locator("#errorDialog").textContent(), /現在の一覧で、もう一度実行してください。/, "the dialog explains that retry follows catalogue synchronization");
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id),
      visible: galleryFilteredImages().map((image) => image.id),
      currentId: state.currentId,
      hasCanvas: Boolean(state.currentImage),
      enabled: !document.querySelector("#removeAndNextButton").disabled,
    })), { ids: ["A", "B", "C", "D"], visible: ["A", "C", "D"], currentId: "B", hasCanvas: true, enabled: true }, "409 keeps only the authoritative catalogue and leaves deletion retryable");
    await page.locator("#errorDialogClose").click();
    await page.unroute("**/api/catalog/delete-source/prepare", stalePrepareHandler);
    await acceptDelete(page);
    await page.waitForFunction(() => !state.images.some((image) => image.id === "B") && !state.catalogMutation);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["A", "C", "D"], "the same action succeeds after resynchronizing to the current catalogue");

    await context.close(); context = null;
    fixture.resetScenario(); fixture.setCatalog(catalogue);
    opened = await openPage(browser, fixture); context = opened.context; page = opened.page;
    await selectImage(page, "B");
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="masked"]').check();
    await page.waitForFunction(() => galleryFilteredImages().map((image) => image.id).join(",") === "A,C,D");
    await page.evaluate(() => { state.settings.confirmations.removeImage = false; });
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => state.images.map((image) => image.id).join(",") === "A,C,D" && state.currentId === "A" && Boolean(state.currentImage));
    const filteredDeleteResult = await page.evaluate(() => ({
      visible: galleryFilteredImages().map((image) => image.id),
      currentId: state.currentId,
      loadedWidth: state.currentImage?.naturalWidth || state.currentImage?.width,
    }));
    assert.deepEqual({ visible: filteredDeleteResult.visible, currentId: filteredDeleteResult.currentId }, { visible: ["C", "D"], currentId: "A" }, "deleting a filtered-out current image selects the first member of the captured filtered set");
    assert.ok(filteredDeleteResult.loadedWidth > 0, "the selected successor has a decoded canvas image rather than a blank selection");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-162 through DI-177 selected actions use only the selection still visible after filter search and folder changes", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  const workspacePayloads = [];
  const clearPayloads = [];
  try {
    ({ context, page } = await openPage(browser, fixture));
    await page.route("**/api/workspace/images", async (route) => {
      const payload = route.request().postDataJSON(); workspacePayloads.push(payload);
      const flags = Object.fromEntries(payload.imageIds.map((id) => [id, {}]));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ flags }) });
    });
    await page.route("**/api/masks/clear", async (route) => {
      const payload = route.request().postDataJSON(); clearPayloads.push(payload);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ clearedImageIds: payload.imageIds }) });
    });
    await page.locator("#overviewButton").click();
    await page.locator("#batchModeButton").click();
    for (const id of ["A", "C", "D"]) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#overviewFilterButton").click();
    await page.locator('[data-overview-filter="reviewed"]').check();
    await page.locator("#overviewFolder").selectOption("two");
    await page.locator("#overviewQuery").fill("C.png");
    await page.waitForFunction(() => overviewImages().map((image) => image.id).join(",") === "C"
      && [...state.selectedImageIds].join(",") === "C" && state.overviewFilter.has("reviewed")
      && state.overviewFolder === "two" && state.overviewQuery === "C.png");
    assert.deepEqual(await page.evaluate(() => ({
      visible: overviewImages().map((image) => image.id),
      selected: selectedImages().map((image) => image.id),
      count: document.querySelector("#selectionCount").textContent,
    })), { visible: ["C"], selected: ["C"], count: "1件を選択中" }, "changing the visible set removes hidden selections from both count and action targets");

    for (const action of ["hide", "show", "reviewed", "unreviewed"]) {
      await page.evaluate(() => { state.selectedImageIds = new Set(["C"]); updateSelectionActionBar(); renderOverview(); });
      await page.locator("#selectionActionsButton").click();
      await page.locator(`[data-selection-action="${action}"]`).click();
      await page.waitForFunction(() => !state.catalogMutation);
    }
    assert.deepEqual(workspacePayloads.map((payload) => payload.imageIds), [["C"], ["C"], ["C"], ["C"]], "hide, show, reviewed, and unreviewed send only the current visible intersection");

    await page.evaluate(() => { state.selectedImageIds = new Set(["C"]); updateSelectionActionBar(); renderOverview(); });
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="detect"]').click();
    assert.match(await page.locator("#detectTargetCount").textContent(), /1件$/, "selected detection displays the visible intersection count");
    const detectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await detectRequest).postData()).imageIds, ["C"], "selected detection sends only the visible intersection");

    await page.evaluate(() => { state.job = { kind: "idle", state: "idle" }; state.selectedImageIds = new Set(["C"]); updateProgress(state.job); updateSelectionActionBar(); renderOverview(); });
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="clear"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /1/, "selected clear confirms the visible intersection count");
    const clearRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click();
    await clearRequest;
    await page.waitForFunction(() => !state.masksClearing);
    assert.deepEqual(clearPayloads.at(-1)?.imageIds, ["C"], "selected clear sends only the visible intersection");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-163 and DI-184 deleting another selected image preserves the current unsaved canvas and draft", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    const before = await page.evaluate(() => {
      addCtx.fillStyle = "rgba(255, 0, 0, 1)"; addCtx.fillRect(4, 4, 1, 1);
      markDraftDirty("add");
      return { pixel: [...addCtx.getImageData(4, 4, 1, 1).data], currentId: state.currentId };
    });
    await page.locator("#overviewButton").click();
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="C"]').click();
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "C") && !state.catalogMutation);
    assert.deepEqual(await page.evaluate(() => ({
      pixel: [...addCtx.getImageData(4, 4, 1, 1).data],
      currentId: state.currentId,
      hasCanvas: Boolean(state.currentImage),
      selected: [...state.selectedImageIds],
      ids: state.images.map((image) => image.id),
      overviewIds: [...document.querySelectorAll(".overview-item")].map((item) => item.dataset.id),
      selectionCount: document.querySelector("#selectionCount").textContent,
      actionDisabled: document.querySelector("#selectionActionsButton").disabled,
    })), { ...before, hasCanvas: true, selected: [], ids: ["A", "B", "D"], overviewIds: ["A", "B", "D"],
      selectionCount: "0件を選択中", actionDisabled: true },
    "a committed peer deletion keeps the remaining list and zero selection UI aligned with the authoritative catalogue");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-184 same-project return synchronization preserves a still-authoritative editor draft", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    await page.evaluate(() => {
      addCtx.fillStyle = "rgba(37, 149, 211, 1)"; addCtx.fillRect(11, 7, 1, 1); markDraftDirty("add");
      window.__returnAuthorityImage = state.currentImage;
    });
    fixture.resetScenario();
    fixture.setCatalog(catalogue.map((image) => image.id === "D" ? { ...image, reviewed: true } : image));
    await page.evaluate(async () => { await syncCatalogOnReturn(); });
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      sameImageObject: state.currentImage === window.__returnAuthorityImage,
      pixel: [...addCtx.getImageData(11, 7, 1, 1).data], draftPresent: state.drafts.has("A"),
      peerReviewed: state.images.find((image) => image.id === "D")?.reviewed,
    })), { ids: ["A", "B", "C", "D"], currentId: "A", sameImageObject: true,
      pixel: [37, 149, 211, 255], draftPresent: true, peerReviewed: true },
    "visibility/pageshow authority refresh updates peer records without resetting a valid current canvas or its unsaved draft");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-161 DI-164 DI-168 DI-181 DI-183 and DI-185 use the captured visible order for every successor boundary", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    const matrix = await page.evaluate(() => {
      const byId = (id) => state.images.find((image) => image.id === id);
      const visible = [byId("A"), byId("C"), byId("D")];
      const successor = (anchor, removed = []) => nextVisibleImage(visible, anchor, { excludedImageIds: new Set(removed), fallback: true })?.id || null;
      const navigation = Object.fromEntries(["A", "C", "D", "B"].map((id) => [id, {
        next: nextVisibleImage(visible, id)?.id || null,
        previous: nextVisibleImage([...visible].reverse(), id)?.id || null,
      }]));
      const deletion = {
        first: successor("A", ["A"]), middle: successor("C", ["C"]), tail: successor("D", ["D"]),
        batchMiddle: successor("C", ["B", "C"]), batchTail: successor("D", ["C", "D"]),
        all: successor("C", ["A", "C", "D"]), pending: successor("C", ["C"]),
      };
      const priorImages = state.images;
      const priorHidden = state.hiddenImageIds;
      byId("D").hidden = true; state.hiddenImageIds = new Set(["D"]);
      state.galleryFilter = new Set(["hidden"]);
      renderGallery(true);
      const hidden = {
        visible: galleryFilteredImages().map((image) => image.id),
        processable: isProcessableImage(byId("D")),
        next: nextGalleryFilteredImage("D")?.id || null,
      };
      byId("D").hidden = false; state.hiddenImageIds = priorHidden;
      state.images = priorImages; state.galleryFilter = new Set(); renderGallery(true);
      return { navigation, deletion, hidden };
    });
    assert.deepEqual(matrix.navigation, {
      A: { next: "C", previous: null }, C: { next: "D", previous: "A" },
      D: { next: null, previous: "C" }, B: { next: "A", previous: "D" },
    }, "next and previous stay inside the captured filtered order, including an outside current image");
    assert.deepEqual(matrix.deletion, {
      first: "C", middle: "D", tail: "C", batchMiddle: "D", batchTail: "A", all: null, pending: "D",
    }, "single, batch, pending, tail, and all-item deletion choose the successor from the captured visible order");
    assert.deepEqual(matrix.hidden, { visible: ["D"], processable: false, next: null }, "an already-hidden H image remains viewable but is never a processing target or wrapped successor");

    const domOrder = await page.evaluate(() => {
      state.overviewFilter = new Set(["reviewed"]); state.overviewFolder = "two"; state.overviewQuery = ""; renderOverview(true);
      state.overviewFilter.clear(); state.overviewFolder = ""; renderOverview(true);
      const cards = [...document.querySelectorAll(".overview-item")];
      return {
        dom: cards.map((card) => card.dataset.id),
        tab: cards.filter((card) => card.tabIndex === 0).map((card) => card.dataset.id),
        aria: cards.map((card) => card.getAttribute("aria-label")),
      };
    });
    assert.deepEqual(domOrder.dom, ["A", "B", "C", "D"], "restored rows return to catalogue DOM and visual order");
    assert.deepEqual(domOrder.tab, ["C"], "the restored grid keeps one roving keyboard entry without duplicating stale tab stops");
    assert.equal(domOrder.aria.length, 4, "every restored row remains in the accessibility reading sequence");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-170 through DI-180 explicit all-image scope ignores view filters and excludes every hidden image", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await page.evaluate(() => {
      const hidden = state.images.find((image) => image.id === "D"); hidden.hidden = true; state.hiddenImageIds = new Set(["D"]);
      state.settings.detection.image_filters = ["masked", "unmasked", "reviewed", "unreviewed"];
      state.galleryFilter = new Set(["hidden"]);
      state.overviewFilter = new Set(["reviewed"]); state.overviewFolder = "two"; state.overviewQuery = "C.png";
      renderCatalogViews();
    });
    assert.deepEqual(await page.evaluate(() => ({
      gallery: galleryFilteredImages().map((image) => image.id), overview: overviewImages().map((image) => image.id),
      processable: processableImages().map((image) => image.id),
    })), { gallery: ["D"], overview: ["C"], processable: ["A", "B", "C"] }, "view filters narrow the two views but never the explicit all-image processing set");

    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.match(await page.locator("#detectTargetCount").textContent(), /3件$/, "all-image detection displays every non-hidden target");
    const detectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await detectRequest).postData()).imageIds, ["A", "B", "C"], "all-image detection sends the complete non-hidden project set");
    fixture.setCatalog(catalogue.map((image) => ({ ...image, hidden: image.id === "D" })));
    await page.evaluate(() => {
      state.job = { kind: "idle", state: "idle" };
      const hidden = state.images.find((image) => image.id === "D"); hidden.hidden = true; state.hiddenImageIds = new Set(["D"]);
      updateProgress(state.job); renderCatalogViews(); updateActionButtons();
    });

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    assert.match(await page.locator("#applyTargetCount").textContent(), /3件$/, "all-image save displays the complete non-hidden project set");
    assert.deepEqual(await page.evaluate(() => state.applyTargetIds), ["A", "B", "C"], "all-image save keeps the complete non-hidden target IDs despite overview filters");
    await page.locator("#applyCloseButton").click();

    await page.locator("#batchMoreButton").click();
    await page.locator("#clearAllMasksButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /3/, "all-image clear confirms the complete non-hidden target count");
    await page.locator("#confirmCancel").click();
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId })), { ids: ["A", "B", "C", "D"], currentId: null }, "cancelling explicit all-image clear changes neither catalogue nor selection");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-167 DI-172 through DI-181 failures never publish catalogue or editor changes before authority", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page; let flagAttempt = 0; let imageSnapshots = 0;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    await page.route("**/api/images", async (route) => { imageSnapshots += 1; await route.continue(); });
    await page.route("**/api/workspace/images", async (route) => {
      flagAttempt += 1;
      if (flagAttempt % 2) await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
      else await route.abort("connectionfailed");
    });
    await page.locator("#overviewButton").click();
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="C"]').click();
    for (const [action, initialHidden, initialReviewed] of [
      ["hide", false, true], ["show", true, true], ["reviewed", false, false], ["unreviewed", false, true],
    ]) {
      fixture.setCatalog(catalogue.map((image) => image.id === "C" ? { ...image, hidden: initialHidden, reviewed: initialReviewed } : image));
      await page.evaluate(({ hidden, reviewed }) => {
        const image = state.images.find((item) => item.id === "C"); image.hidden = hidden; image.reviewed = reviewed;
        if (hidden) state.hiddenImageIds.add("C"); else state.hiddenImageIds.delete("C");
        if (reviewed) state.reviewedImageIds.add("C"); else state.reviewedImageIds.delete("C");
        setViewMode("overview"); state.batchMode = true; state.selectedImageIds = new Set(["C"]);
        updateSelectionActionBar(); renderOverview(true);
      }, { hidden: initialHidden, reviewed: initialReviewed });
      const before = await page.evaluate(() => state.images.map((image) => [image.id, image.hidden, image.reviewed]));
      const flagRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/workspace/images");
      await page.locator("#selectionActionsButton").click();
      await page.locator(`[data-selection-action="${action}"]`).click();
      await flagRequest;
      await page.waitForFunction(() => !state.catalogMutation);
      assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.hidden, image.reviewed])), before,
        `${action} failure leaves every workspace flag on authoritative state`);
      if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
      await page.evaluate(() => { state.selectedImageIds = new Set(["C"]); updateSelectionActionBar(); renderOverview(); });
    }
    assert.ok(imageSnapshots >= 2, "stale flag responses reload authority while transport failures remain retryable without a false commit");

    await page.route("**/api/detect", async (route) => {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    });
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="detect"]').click();
    const candidatesBefore = await page.evaluate(() => state.images.map((image) => [image.id, image.candidateRevision, image.candidateCount]));
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => !state.detectionStarting && state.job.state !== "running");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.candidateRevision, image.candidateCount])), candidatesBefore, "stale detection starts no candidate publication");

  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("DI-158 DI-164 and DI-165 actual deletion replaces the canvas at every position and clears an all-item selection", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  const cases = [["A", "B"], ["B", "C"], ["D", "C"]];
  try {
    for (const [removedId, successorId] of cases) {
      await context?.close(); context = null;
      fixture.resetScenario(); fixture.setCatalog(catalogue);
      ({ context, page } = await openPage(browser, fixture));
      await selectImage(page, removedId);
      await page.evaluate(() => { state.settings.confirmations.removeImage = false; window.__deletedCanvasImage = state.currentImage; });
      await page.locator("#removeAndNextButton").click();
      await page.waitForFunction(({ removed, successor }) => !state.images.some((image) => image.id === removed)
        && state.currentId === successor && Boolean(state.currentImage) && state.currentImage !== window.__deletedCanvasImage,
      { removed: removedId, successor: successorId });
      assert.deepEqual(await page.evaluate((removed) => ({
        currentId: state.currentId,
        currentDom: document.querySelector('.gallery-item[aria-current="true"]')?.dataset.id,
        hasCanvas: Boolean(state.currentImage),
        removedStillSelectable: state.images.some((image) => image.id === removed),
      }), removedId), { currentId: successorId, currentDom: successorId, hasCanvas: true, removedStillSelectable: false },
      `${removedId} deletion renders only ${successorId} as the current image`);
    }

    await context.close(); context = null;
    fixture.resetScenario(); fixture.setCatalog(catalogue);
    ({ context, page } = await openPage(browser, fixture));
    await page.evaluate(() => { state.settings.confirmations.removeImage = false; });
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
    for (const id of ["A", "B", "C", "D"]) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => state.images.length === 0 && state.selectedImageIds.size === 0 && state.currentId === null
      && state.currentImage === null && !state.catalogMutation && document.querySelector("#selectionActionsButton").disabled);
    assert.deepEqual(await page.evaluate(() => ({
      selected: [...state.selectedImageIds], actionDisabled: document.querySelector("#selectionActionsButton").disabled,
      galleryIds: [...document.querySelectorAll(".gallery-item")].map((item) => item.dataset.id),
      overviewIds: [...document.querySelectorAll(".overview-item")].map((item) => item.dataset.id),
    })), { selected: [], actionDisabled: true, galleryIds: [], overviewIds: [] },
    "deleting the entire selected set leaves no deleted ID selectable in either list");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

function eightImageCatalogue() {
  return "ABCDEFGH".split("").map((id, index) => ({
    id,
    relativePath: `${index < 4 ? "visible" : "hidden"}/${id}.png`,
    sourceKind: "filesystem",
    sourcePath: `G:\\fixture\\${id}.png`,
    width: 100,
    height: 80,
    candidateCount: index % 2 === 0 ? 1 : 0,
    enabledCandidateCount: index % 2 === 0 ? 1 : 0,
    hasEffectiveMask: index % 2 === 0,
    reviewed: index % 3 === 0,
    hidden: index >= 4,
  }));
}

async function openEightImagePage(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.images.length === 8 && Boolean(state.settings) && Boolean(state.job));
  return { context, page };
}

async function stateIntegritySnapshot(page) {
  return page.evaluate(() => ({
    images: state.images.map((image) => [image.id, Boolean(image.hidden), Boolean(image.reviewed), image.candidateCount, Boolean(image.hasEffectiveMask)]),
    reviewed: [...state.reviewedImageIds].sort(),
    hidden: [...state.hiddenImageIds].sort(),
    currentId: state.currentId,
    job: { kind: state.job?.kind, state: state.job?.state, imageIds: [...(state.job?.imageIds || [])] },
    detectionTargetIds: [...state.detectionTargetIds],
    manual: [state.manualMaskPresent, state.manualExclusionPresent, state.manualExclusionErasePresent],
    draftIds: [...state.drafts.keys()].sort(),
  }));
}

function withoutSelectionLifecycle(snapshot) {
  const { currentId, draftIds, ...durable } = snapshot;
  return durable;
}

async function configureOneVisibleSelection(page) {
  if (await page.evaluate(() => state.viewMode !== "overview")) await page.locator("#overviewButton").click();
  if (await page.evaluate(() => state.batchMode)) await page.locator("#selectionClearButton").click();
  await page.locator("#batchModeButton").click();
  await page.locator("#overviewFilterButton").click();
  for (const checkbox of await page.locator("[data-overview-filter]").all()) if (await checkbox.isChecked()) await checkbox.uncheck({ force: true });
  await page.locator("#overviewFolder").selectOption("");
  await page.locator("#overviewQuery").fill("");
  await page.waitForTimeout(150);
  for (const id of ["A", "C", "D"]) await page.locator(`.overview-item[data-id="${id}"]`).click();
  await page.locator("#overviewFilterButton").click();
  await page.locator('[data-overview-filter="masked"]').check();
  await page.locator('[data-overview-filter="unmasked"]').check();
  await page.locator('[data-overview-filter="hidden"]').check();
  await page.locator("#overviewFolder").selectOption("two");
  await page.locator("#overviewQuery").fill("C.png");
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(() => ({
    visible: overviewImages().map((image) => image.id),
    filter: [...state.overviewFilter], folder: state.overviewFolder, query: state.overviewQuery,
  })), { visible: ["C"], filter: ["masked", "unmasked", "hidden"], folder: "two", query: "C.png" }, "combined filter, folder, and query leave only C visible");
  if (!await page.locator('.overview-item[data-id="C"]').getAttribute("aria-pressed").then((value) => value === "true")) {
    await page.locator('.overview-item[data-id="C"]').click();
  }
  await page.waitForFunction(() => selectedImages().map((image) => image.id).join(",") === "C");
}

test("DI-170.1 all-image detection shows and sends exactly A-D from A-H regardless of both view filters", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog(eightImageCatalogue());
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openEightImagePage(browser, fixture));
    await page.evaluate(() => {
      state.galleryFilter = new Set(["hidden"]);
      state.overviewFilter = new Set(["reviewed"]);
      state.overviewFolder = "visible";
      state.overviewQuery = "A.png";
      state.settings.detection.image_filters = ["masked"];
      renderCatalogViews();
    });
    assert.deepEqual(await page.evaluate(() => ({
      gallery: galleryFilteredImages().map((image) => image.id),
      overview: overviewImages().map((image) => image.id),
    })), { gallery: ["E", "F", "G", "H"], overview: ["A"] });
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    for (const checkbox of await page.locator("[data-detection-image-filter]").all()) if (!(await checkbox.isChecked())) await checkbox.check({ force: true });
    assert.equal(await page.locator("#detectTargetCount").textContent(), "対象: 4件", "A-D are the exact four displayed all-image targets");
    const requestPromise = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
    await page.locator("#detectStartButton").click();
    assert.deepEqual((await requestPromise).postDataJSON().imageIds, ["A", "B", "C", "D"], "the request sends exactly A-D and no hidden E-H ID");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-172.2 DI-173.2 DI-176.2 DI-177.2 selection flags publish only C after success and never on cancelled conflicted or disconnected requests", { timeout: 180000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    for (const [action, field, desired, initial] of [
      ["hide", "hidden", true, false], ["show", "hidden", false, true],
      ["reviewed", "reviewed", true, false], ["unreviewed", "reviewed", false, true],
    ]) {
      for (const failure of ["aborted", "conflict", "disconnected"]) {
        await context?.close(); context = null;
        const records = catalogue.map((image) => image.id === "C" ? { ...image, [field]: initial } : image);
        fixture.resetScenario(); fixture.setCatalog(records);
        const opened = await openPage(browser, fixture); context = opened.context; const page = opened.page;
        await configureOneVisibleSelection(page);
        const before = await stateIntegritySnapshot(page);
        let release;
        const requestSeen = new Promise((resolve) => { release = resolve; });
        await page.route("**/api/workspace/images", async (route) => {
          const payload = route.request().postDataJSON();
          assert.deepEqual(payload.imageIds, ["C"], `${action}/${failure} sends only visible selected C`);
          release();
          if (failure === "conflict") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
          else await route.abort(failure === "aborted" ? "aborted" : "connectionfailed");
        });
        await page.locator("#selectionActionsButton").click();
        await page.locator(`[data-selection-action="${action}"]`).click();
        await requestSeen;
        await page.waitForFunction(() => !state.catalogMutation);
        assert.deepEqual(await stateIntegritySnapshot(page), before, `${action}/${failure} preserves hidden, review, candidates, current image, job, and drafts`);
        if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
      }

      await context?.close(); context = null;
      const records = catalogue.map((image) => image.id === "C" ? { ...image, [field]: initial } : image);
      fixture.resetScenario(); fixture.setCatalog(records);
      const opened = await openPage(browser, fixture); context = opened.context; const page = opened.page;
      await configureOneVisibleSelection(page);
      const before = await stateIntegritySnapshot(page);
      let releaseSuccess;
      const held = new Promise((resolve) => { releaseSuccess = resolve; });
      let payload;
      await page.route("**/api/workspace/images", async (route) => {
        payload = route.request().postDataJSON(); await held;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ flags: { C: { [field]: desired } } }) });
      });
      await page.locator("#selectionActionsButton").click();
      await page.locator(`[data-selection-action="${action}"]`).click();
      await page.waitForFunction(() => state.catalogMutation);
      assert.deepEqual(await stateIntegritySnapshot(page), before, `${action} does not publish C before the authoritative response`);
      releaseSuccess();
      await page.waitForFunction(() => !state.catalogMutation);
      assert.deepEqual(payload.imageIds, ["C"]);
      assert.equal(await page.evaluate(({ field, desired }) => state.images.find((image) => image.id === "C")[field] === desired, { field, desired }), true,
        `${action} publishes C only after success`);
    }
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-174.2 DI-179.1 DI-179.2 clear actions use exact selected or all-image IDs and preserve state through cancel conflict and disconnect", { timeout: 120000 }, async () => {
  const stableCatalogue = catalogue.map((image) => image.id === "A" ? { ...image, candidateCount: 0, enabledCandidateCount: 0 } : image);
  const fixture = await startFixtureServer(); fixture.setCatalog(stableCatalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    await configureOneVisibleSelection(page);
    const original = await stateIntegritySnapshot(page);

    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="clear"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /1/, "selected clear confirms exactly C");
    await page.locator("#confirmCancel").click();
    assert.deepEqual(await stateIntegritySnapshot(page), original, "selected clear cancellation changes nothing");

    for (const failure of ["conflict", "disconnected"]) {
      let requestPayload;
      await page.route("**/api/masks/clear", async (route) => {
        requestPayload = route.request().postDataJSON();
        if (failure === "conflict") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
        else await route.abort("connectionfailed");
      });
      await configureOneVisibleSelection(page);
      await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="clear"]').click();
      const requestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
      await page.locator("#confirmAccept").click();
      await requestSeen;
      await page.waitForFunction(() => !state.masksClearing);
      assert.deepEqual(requestPayload.imageIds, ["C"], `${failure} selected clear sends only C`);
      assert.deepEqual(withoutSelectionLifecycle(await stateIntegritySnapshot(page)), withoutSelectionLifecycle(original),
        `${failure} selected clear preserves candidates, manual layers, and review state`);
      if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
      await page.unroute("**/api/masks/clear");
    }

    await configureOneVisibleSelection(page);
    const selectedClearBefore = await stateIntegritySnapshot(page);
    let releaseSelectedClear; const selectedHeld = new Promise((resolve) => { releaseSelectedClear = resolve; }); let selectedPayload;
    await page.route("**/api/masks/clear", async (route) => {
      selectedPayload = route.request().postDataJSON(); await selectedHeld;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="clear"]').click();
    const selectedRequestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click(); await selectedRequestSeen; await page.waitForFunction(() => state.masksClearing);
    assert.deepEqual(selectedPayload.imageIds, ["C"], "successful selected clear sends only C");
    assert.deepEqual(withoutSelectionLifecycle(await stateIntegritySnapshot(page)), withoutSelectionLifecycle(selectedClearBefore),
      "successful selected clear does not publish C before the response");
    fixture.setCatalog(stableCatalogue.map((image) => image.id === "C"
      ? { ...image, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false } : image));
    releaseSelectedClear(); await page.waitForFunction(() => !state.masksClearing);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.candidateCount, Boolean(image.hasEffectiveMask)])),
      [["A", 0, true], ["B", 0, false], ["C", 0, false], ["D", 1, true]], "only C is cleared after the successful response");
    await page.unroute("**/api/masks/clear");

    await page.evaluate(() => { setViewMode("edit"); });
    if (await page.evaluate(() => state.currentId !== "A")) await selectImage(page, "A");
    const allClearBefore = await stateIntegritySnapshot(page);
    await page.locator("#batchMoreButton").click(); await page.locator("#clearAllMasksButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /4/, "all clear confirms four non-hidden targets");
    await page.locator("#confirmCancel").click();
    assert.deepEqual(await stateIntegritySnapshot(page), allClearBefore, "all clear cancellation preserves the full editor and catalogue state");

    let releaseClear; const held = new Promise((resolve) => { releaseClear = resolve; }); let clearPayload;
    await page.route("**/api/masks/clear", async (route) => { clearPayload = route.request().postDataJSON(); await held; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.locator("#batchMoreButton").click(); await page.locator("#clearAllMasksButton").click();
    const allClearRequestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/masks/clear");
    await page.locator("#confirmAccept").click(); await allClearRequestSeen; await page.waitForFunction(() => state.masksClearing);
    assert.deepEqual(clearPayload.imageIds, ["A", "B", "C", "D"], "all clear sends exactly every non-hidden image");
    assert.deepEqual(await stateIntegritySnapshot(page), allClearBefore, "all clear does not publish candidate, manual, review, or current changes before response");
    fixture.setCatalog(stableCatalogue.map((image) => ({ ...image, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false })));
    releaseClear(); await page.waitForFunction(() => !state.masksClearing);
    assert.equal(await page.evaluate(() => state.images.filter((image) => !image.hidden).every((image) => !image.hasEffectiveMask && image.candidateCount === 0)), true,
      "all clear publishes cleared masks only after its successful response and authoritative reload");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-175.2 DI-178.2 detection cancel conflict disconnect and held success never publish a job or candidates early", { timeout: 120000 }, async () => {
  const fixture = await startFixtureServer(); fixture.setCatalog(catalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await configureOneVisibleSelection(page);
    const before = await stateIntegritySnapshot(page);
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="detect"]').click();
    assert.equal(await page.locator("#detectTargetCount").textContent(), "対象: 1件");
    await page.locator("#detectCancelButton").click();
    assert.deepEqual(await stateIntegritySnapshot(page), before, "selected detection dialog cancellation starts no job and changes no candidate");

    for (const failure of ["conflict", "disconnected"]) {
      let payload;
      await page.route("**/api/detect", async (route) => {
        payload = route.request().postDataJSON();
        if (failure === "conflict") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
        else await route.abort("connectionfailed");
      });
      await configureOneVisibleSelection(page);
      await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="detect"]').click();
      const requestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/detect");
      await page.locator("#detectStartButton").click(); await requestSeen;
      await page.waitForFunction(() => !state.detectionStarting && state.job.state !== "running");
      assert.deepEqual(payload.imageIds, ["C"], `${failure} selected detection sends only C`);
      const failed = await stateIntegritySnapshot(page);
      assert.deepEqual(failed.images, before.images, `${failure} selected detection leaves candidates unchanged`);
      assert.equal(failed.job.state, "idle", `${failure} selected detection leaves no running job`);
      assert.deepEqual(failed.detectionTargetIds, [], `${failure} selected detection leaves no published target IDs`);
      if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
      await page.unroute("**/api/detect");
    }

    await page.evaluate(() => { setViewMode("edit"); state.galleryFilter = new Set(["masked"]); renderCatalogViews(); });
    let releaseDetect; const held = new Promise((resolve) => { releaseDetect = resolve; }); let allPayload;
    await page.route("**/api/detect", async (route) => { allPayload = route.request().postDataJSON(); await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "detect", state: "running" }) }); });
    await page.locator("#detectAllButton").click();
    for (const checkbox of await page.locator("[data-detection-image-filter]").all()) if (!(await checkbox.isChecked())) await checkbox.check({ force: true });
    assert.equal(await page.locator("#detectTargetCount").textContent(), "対象: 4件");
    await page.locator("#detectStartButton").click(); await page.waitForFunction(() => state.detectionStarting);
    const pending = await stateIntegritySnapshot(page);
    releaseDetect(); await page.waitForFunction(() => !state.detectionStarting);
    assert.deepEqual(allPayload.imageIds, ["A", "B", "C", "D"], "all detection sends the complete non-hidden project despite the gallery filter");
    assert.deepEqual(pending.job, before.job, "a held detection response does not publish a running job optimistically");
    assert.deepEqual(pending.images, before.images, "a held detection response does not publish candidates optimistically");
    assert.deepEqual(await page.evaluate(() => state.detectionTargetIds), ["A", "B", "C", "D"], "successful response publishes the exact target set afterward");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-179.1 DI-179.2 catalogue clear changes no list or current image until its authoritative success response", { timeout: 90000 }, async () => {
  const stableCatalogue = catalogue.map((image) => image.id === "A" ? { ...image, candidateCount: 0, enabledCandidateCount: 0 } : image);
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    for (const outcome of ["cancel", "conflict", "disconnected", "success"]) {
      await context?.close(); context = null;
      fixture.resetScenario(); fixture.setCatalog(stableCatalogue);
      const opened = await openPage(browser, fixture); context = opened.context; const page = opened.page;
      await selectImage(page, "A");
      await page.evaluate(() => { state.galleryFilter = new Set(["masked"]); state.overviewFilter = new Set(["reviewed"]); state.overviewFolder = "two"; state.overviewQuery = "C.png"; renderCatalogViews(); });
      const before = await stateIntegritySnapshot(page);
      let release; const held = new Promise((resolve) => { release = resolve; }); let requestCount = 0;
      if (outcome !== "cancel") await page.route("**/api/catalog/clear", async (route) => {
        requestCount += 1;
        if (outcome === "conflict") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
        else if (outcome === "disconnected") await route.abort("connectionfailed");
        else { await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [] }) }); }
      });
      await page.locator("#batchMoreButton").click(); await page.locator("#clearCatalogButton").click();
      await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
      if (outcome === "cancel") {
        await page.locator("#confirmCancel").click();
        assert.equal(requestCount, 0, "catalogue clear cancellation sends no mutation request");
        assert.deepEqual(await stateIntegritySnapshot(page), before, "catalogue clear cancellation preserves list, candidates, manual layers, review, and current image");
        continue;
      }
      const requestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/catalog/clear");
      await page.locator("#confirmAccept").click(); await requestSeen;
      if (outcome === "success") {
        await page.waitForFunction(() => state.catalogMutation);
        assert.deepEqual(await stateIntegritySnapshot(page), before, "held catalogue clear does not optimistically change list, candidates, manual layers, review, or current image");
        release();
        await page.waitForFunction(() => !state.catalogMutation && state.images.length === 0);
        assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId, hasImage: Boolean(state.currentImage) })),
          { ids: [], currentId: null, hasImage: false }, "catalogue empties only after the success response");
      } else {
        await page.waitForFunction(() => !state.catalogMutation);
        assert.equal(requestCount, 1, `${outcome} sends exactly one catalogue-clear request`);
        assert.deepEqual(await stateIntegritySnapshot(page), before, `${outcome} preserves list, candidates, manual layers, review, and current image`);
      }
    }
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-180.1 DI-180.2 all-image save uses exact non-hidden IDs and produces nothing on close conflict disconnect or before success", { timeout: 120000 }, async () => {
  const stableCatalogue = catalogue.map((image) => image.id === "A" ? { ...image, candidateCount: 0, enabledCandidateCount: 0 } : image);
  const fixture = await startFixtureServer(); fixture.setCatalog(stableCatalogue);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    await page.evaluate(() => { state.galleryFilter = new Set(["masked"]); state.overviewFilter = new Set(["reviewed"]); state.overviewFolder = "two"; state.overviewQuery = "C.png"; renderCatalogViews(); });
    const before = await stateIntegritySnapshot(page);
    const savesBefore = fixture.saveRequests.length;
    await page.locator("#saveAllButton").click();
    assert.equal(await page.locator("#applyTargetCount").textContent(), "対象: 4件");
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), ["A", "B", "C", "D"]);
    await page.locator("#applyCloseButton").click();
    assert.equal(fixture.saveRequests.length, savesBefore, "closing before start emits no save request or output");
    assert.deepEqual(await stateIntegritySnapshot(page), before, "closing batch save preserves review, edit, candidate, and current state");

    for (const failure of ["conflict", "disconnected"]) {
      await page.locator("#saveAllButton").click(); await page.locator("#applyOverwriteMode").check();
      let payload;
      await page.route("**/api/save/prepare", async (route) => {
        payload = route.request().postDataJSON();
        if (failure === "conflict") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
        else await route.abort("connectionfailed");
      });
      const priorOutputCount = fixture.saveRequests.filter((request) => ["/api/save/render", "/api/save/commit"].includes(request.path)).length;
      await page.locator("#applyStartButton").click(); await page.waitForFunction(() => !state.saving && !state.saveStarting);
      assert.deepEqual(payload.imageIds, ["A", "B", "C", "D"], `${failure} save prepare sends exactly the non-hidden project`);
      assert.equal(fixture.saveRequests.filter((request) => ["/api/save/render", "/api/save/commit"].includes(request.path)).length, priorOutputCount,
        `${failure} creates no output or commit`);
      assert.deepEqual(withoutSelectionLifecycle(await stateIntegritySnapshot(page)), withoutSelectionLifecycle(before),
        `${failure} preserves review, candidate, and persisted edit state`);
      if (await page.locator("#errorDialog").evaluate((dialog) => dialog.open)) await page.locator("#errorDialogClose").click();
      await page.unroute("**/api/save/prepare"); await page.locator("#applyCloseButton").click();
    }

    if (await page.evaluate(() => state.currentId !== "A")) await selectImage(page, "A");
    const heldBefore = await stateIntegritySnapshot(page);
    await page.locator("#saveAllButton").click(); await page.locator("#applyOverwriteMode").check();
    let releasePrepare; const held = new Promise((resolve) => { releasePrepare = resolve; }); let preparePayload;
    await page.route("**/api/save/prepare", async (route) => { preparePayload = route.request().postDataJSON(); await held; await route.continue(); });
    const outputsBefore = fixture.saveRequests.filter((request) => ["/api/save/render", "/api/save/commit"].includes(request.path)).length;
    await page.locator("#applyStartButton").click(); await page.waitForFunction(() => state.saveStarting);
    assert.equal(fixture.saveRequests.filter((request) => ["/api/save/render", "/api/save/commit"].includes(request.path)).length, outputsBefore,
      "held prepare produces no output before authority responds");
    assert.deepEqual(await stateIntegritySnapshot(page), heldBefore, "held prepare preserves review, edit, candidate, and current state");
    releasePrepare(); await page.waitForFunction(() => !state.saving && !state.saveStarting, null, { timeout: 30000 });
    assert.deepEqual(preparePayload.imageIds, ["A", "B", "C", "D"]);
    assert.deepEqual(fixture.saveRequests.filter((request) => request.path === "/api/save/commit").slice(-4).map((request) => request.payload.imageId), ["A", "B", "C", "D"],
      "only the successful response permits each exact target to reach output commit");
    assert.deepEqual(await stateIntegritySnapshot(page), heldBefore, "successful save does not alter review, edit, candidate, or current state");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-161 DI-181 and DI-182 review and hide clicks preserve the captured filtered successor contract", { timeout: 180000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  const cases = [
    { label: "first", current: "A", masks: ["A", "C", "D"], next: "C" },
    { label: "middle", current: "C", masks: ["A", "C", "D"], next: "D" },
    { label: "tail", current: "D", masks: ["A", "C", "D"], next: "D", retained: true },
    { label: "one", current: "C", masks: ["C"], next: "C", retained: true },
    { label: "outside", current: "B", masks: ["A", "C", "D"], next: "A" },
  ];
  try {
    for (const action of [
      { button: "#reviewAndNextButton", field: "reviewed" },
      { button: "#hideAndNextButton", field: "hidden" },
    ]) {
      for (const scenario of cases) {
        await context?.close(); context = null;
        fixture.resetScenario(); fixture.setCatalog(catalogue.map((image) => ({ ...image, reviewed: false, hidden: false })));
        ({ context, page } = await openPage(browser, fixture));
        const payloads = [];
        await page.route("**/api/workspace/image/**", async (route) => {
          payloads.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
          await route.continue();
        });
        await selectImage(page, scenario.current);
        await page.evaluate(({ masks, includeHiddenFilter }) => {
          state.maskStatus = new Map(state.images.map((image) => [image.id, masks.includes(image.id)]));
          state.galleryFilter = new Set(includeHiddenFilter ? ["masked", "hidden"] : ["masked"]); renderGallery(true);
          addCtx.fillStyle = "rgba(231, 17, 83, 1)"; addCtx.fillRect(7, 6, 1, 1); markDraftDirty("add");
          window.__actionCanvasImage = state.currentImage;
        }, { ...scenario, includeHiddenFilter: action.field === "hidden" && scenario.label === "tail" });
        assert.deepEqual(await page.evaluate(() => galleryFilteredImages().map((image) => image.id)), scenario.masks,
          `${action.field} ${scenario.label} starts from the intended captured left-list order`);
        await page.locator(action.button).click();
        await page.waitForFunction(({ id, field, next }) => state.images.find((image) => image.id === id)?.[field] === true
          && state.currentId === next && Boolean(state.currentImage), { id: scenario.current, field: action.field, next: scenario.next });
        assert.deepEqual(payloads, [{ path: `/api/workspace/image/${scenario.current}`, body: { [action.field]: true } }],
          `${action.field} ${scenario.label} sends exactly the clicked current image and flag`);
        const result = await page.evaluate(({ retained }) => ({
          currentId: state.currentId,
          sameImageObject: state.currentImage === window.__actionCanvasImage,
          pixel: [...addCtx.getImageData(7, 6, 1, 1).data],
          hasCanvas: originalCanvas.width > 1 && originalCanvas.height > 1,
          retained,
        }), scenario);
        assert.equal(result.currentId, scenario.next, `${action.field} ${scenario.label} selects only its captured successor`);
        assert.equal(result.hasCanvas, true, `${action.field} ${scenario.label} never leaves a white empty editor`);
        if (scenario.retained) {
          assert.equal(result.sameImageObject, true, `${action.field} ${scenario.label} keeps the decoded current image object`);
          assert.deepEqual(result.pixel, [231, 17, 83, 255], `${action.field} ${scenario.label} keeps the current unsaved canvas pixel`);
        }
      }
    }

    await context?.close(); context = null;
    fixture.resetScenario(); fixture.setCatalog(catalogue.map((image) => ({ ...image, hidden: image.id === "D" })));
    ({ context, page } = await openPage(browser, fixture));
    const hiddenFlagPayloads = [];
    await page.route("**/api/workspace/image/**", async (route) => { hiddenFlagPayloads.push(route.request().postDataJSON()); await route.continue(); });
    await page.evaluate(() => { state.galleryFilter = new Set(["hidden"]); renderGallery(true); });
    await selectImage(page, "D");
    await page.locator("#hideAndNextButton").click();
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, hidden: state.images.find((image) => image.id === "D").hidden,
      hasCanvas: Boolean(state.currentImage) })), { currentId: "D", hidden: true, hasCanvas: true },
    "clicking the H action keeps the viewable already-hidden image and canvas");
    assert.deepEqual(hiddenFlagPayloads, [], "the already-hidden current image starts no workspace processing request");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-166 DI-167 DI-171 and DI-184 batch delete cancellation conflict and disconnect preserve authority", { timeout: 150000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  async function arrange() {
    fixture.resetScenario(); fixture.setCatalog(catalogue);
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    await page.evaluate(() => {
      addCtx.fillStyle = "rgba(19, 211, 73, 1)"; addCtx.fillRect(8, 5, 1, 1); markDraftDirty("add");
      window.__authorityImage = state.currentImage;
    });
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
    for (const id of ["A", "C", "D"]) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#overviewFilterButton").click(); await page.locator('[data-overview-filter="reviewed"]').check();
    await page.locator("#overviewFolder").selectOption("two"); await page.locator("#overviewQuery").fill("C.png");
    await page.waitForFunction(() => overviewImages().map((image) => image.id).join(",") === "C" && [...state.selectedImageIds].join(",") === "C");
  }
  async function openDeleteConfirmation() {
    await page.evaluate(() => { state.settings.confirmations.removeImage = true; });
    assert.equal(await page.locator("#selectionCount").textContent(), "1件を選択中", "the action bar exposes the one visible selected target");
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator("#confirmTitle").textContent(), "元画像を完全に削除", "the visible selection opens the permanent source deletion confirmation");
  }
  async function authoritySnapshot() {
    return page.evaluate(() => ({
      ids: state.images.map((image) => image.id), selected: [...state.selectedImageIds], currentId: state.currentId,
      sameImageObject: state.currentImage === window.__authorityImage,
      pixel: [...addCtx.getImageData(8, 5, 1, 1).data],
      visible: overviewImages().map((image) => image.id),
    }));
  }
  const unchanged = { ids: ["A", "B", "C", "D"], selected: ["C"], currentId: "A", sameImageObject: true,
    pixel: [19, 211, 73, 255], visible: ["C"] };
  try {
    await arrange();
    const beforeRequests = fixture.sourceDeleteRequests.length;
    await openDeleteConfirmation(); await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => !document.querySelector("#confirmDialog").open);
    assert.equal(fixture.sourceDeleteRequests.length, beforeRequests, "cancel sends no source-delete request");
    assert.deepEqual(await authoritySnapshot(), unchanged, "cancel preserves order, filters, selection, current object, draft pixel, and project catalogue");
    await context.close(); context = null;

    await arrange();
    let conflictPayload;
    let releaseConflict;
    const conflictGate = new Promise((resolve) => { releaseConflict = resolve; });
    await page.route("**/api/catalog/delete-source/prepare", async (route) => {
      conflictPayload = route.request().postDataJSON(); await conflictGate;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    });
    await openDeleteConfirmation();
    const conflictRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/catalog/delete-source/prepare");
    await page.locator("#confirmAccept").click(); await conflictRequest;
    assert.deepEqual(await authoritySnapshot(), unchanged, "a delayed delete does not publish selection or canvas movement before authority");
    assert.deepEqual(conflictPayload.imageIds, ["C"], "the delete request contains only the current visible-selection intersection");
    releaseConflict();
    await page.waitForFunction(() => !state.catalogMutation);
    assert.deepEqual(await authoritySnapshot(), unchanged, "409 resynchronization retains the authoritative peer canvas and unsaved draft");
    await context.close(); context = null;

    await arrange();
    let disconnectPayload;
    await page.route("**/api/catalog/delete-source/prepare", async (route) => {
      disconnectPayload = route.request().postDataJSON(); await route.abort("connectionfailed");
    });
    await openDeleteConfirmation();
    const disconnectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/catalog/delete-source/prepare");
    await page.locator("#confirmAccept").click(); await disconnectRequest;
    await page.waitForFunction(() => !state.catalogMutation);
    assert.deepEqual(disconnectPayload.imageIds, ["C"], "the disconnected request still targets only the visible selection intersection");
    assert.deepEqual(await authoritySnapshot(), unchanged, "a disconnected uncommitted delete restores the same authoritative image object and canvas pixel");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-168 DI-183 and DI-184 pending image deletion invalidates stale loads and restores only authoritative survivors", { timeout: 150000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  async function arrangePending() {
    fixture.resetScenario(); fixture.setCatalog(catalogue);
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "A");
    let releaseImage;
    const imageGate = new Promise((resolve) => { releaseImage = resolve; });
    let held = false;
    await page.route("**/api/image/B**", async (route) => {
      if (!held) { held = true; await imageGate; }
      await route.continue();
    });
    await page.locator('.gallery-item[data-id="B"]').click();
    await page.waitForFunction(() => state.pendingImageId === "B" && state.currentId === "A" && Boolean(state.currentImage));
    return releaseImage;
  }
  async function selectForDelete(ids) {
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
    for (const id of ids) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
  }
  try {
    let releaseImage = await arrangePending();
    await selectForDelete(["B", "C"]);
    await page.waitForFunction(() => !state.catalogMutation && state.images.map((image) => image.id).join(",") === "A,D"
      && state.currentId === "D" && Boolean(state.currentImage));
    releaseImage();
    await page.waitForFunction(() => state.pendingImageId === null);
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id), currentId: state.currentId,
      staleDeletedShown: state.currentId === "B" || state.pendingImageId === "B",
      hasCanvas: originalCanvas.width > 1 && originalCanvas.height > 1,
    })), { ids: ["A", "D"], currentId: "D", staleDeletedShown: false, hasCanvas: true },
    "deleting the delayed pending image invalidates its load and chooses the next surviving pre-delete overview item");
    await context.close(); context = null;

    releaseImage = await arrangePending();
    await selectForDelete(["C"]);
    await page.waitForFunction(() => !state.catalogMutation && state.images.map((image) => image.id).join(",") === "A,B,D");
    releaseImage();
    await page.waitForFunction(() => state.currentId === "B" && state.pendingImageId === null && Boolean(state.currentImage));
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId,
      ids: state.images.map((image) => image.id), hasCanvas: originalCanvas.width > 1 && originalCanvas.height > 1,
    })), { currentId: "B", ids: ["A", "B", "D"], hasCanvas: true },
    "deleting another image restores the pre-delete pending image from the authoritative catalogue");
    await context.close(); context = null;

    releaseImage = await arrangePending();
    await page.route("**/api/catalog/delete-source/prepare", async (route) => {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    });
    await selectForDelete(["A", "B"]);
    await page.waitForFunction(() => !state.catalogMutation && document.querySelector("#errorDialog").open);
    releaseImage();
    await page.waitForFunction(() => state.currentId === "B" && state.pendingImageId === null && Boolean(state.currentImage));
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      hasCanvas: originalCanvas.width > 1 && originalCanvas.height > 1,
    })), { ids: ["A", "B", "C", "D"], currentId: "B", hasCanvas: true },
    "409 keeps the pending image because the authoritative catalogue still contains it and never republishes a deleted-candidate canvas");
    await context.close(); context = null;

    releaseImage = await arrangePending();
    await page.route("**/api/catalog/delete-source/prepare", async (route) => {
      fixture.resetScenario();
      fixture.setCatalog(catalogue.filter((image) => image.id !== "A"));
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
    });
    await selectForDelete(["C"]);
    await page.waitForFunction(() => !state.catalogMutation && state.images.map((image) => image.id).join(",") === "B,C,D");
    releaseImage();
    await page.waitForFunction(() => state.currentId === "B" && state.pendingImageId === null && Boolean(state.currentImage));
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      currentExists: state.images.some((image) => image.id === state.currentId), hasCanvas: originalCanvas.width > 1 && originalCanvas.height > 1,
    })), { ids: ["B", "C", "D"], currentId: "B", currentExists: true, hasCanvas: true },
    "when resynchronization invalidates the old current image, the surviving pending image is the only editor selection restored from authority");
    await context.close(); context = null;

    releaseImage = await arrangePending();
    await selectForDelete(["A", "B", "C", "D"]);
    await page.waitForFunction(() => !state.catalogMutation && state.images.length === 0 && state.currentId === null && state.currentImage === null);
    releaseImage();
    await page.waitForFunction(() => state.pendingImageId === null);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      currentImage: state.currentImage, candidates: state.candidates.length,
    })), { ids: [], currentId: null, currentImage: null, candidates: 0 },
    "when pending deletion leaves no surviving image candidate, the editor becomes explicitly unselected and shows no stale candidate state");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-168 and DI-183 disconnected pending deletion resumes from the committed receipt after reload", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  const token = "00000000-0000-4000-8000-000000168183";
  try {
    const candidateLess = catalogue.map((image) => ({ ...image, candidateCount: 0, enabledCandidateCount: 0, hasEffectiveMask: false }));
    fixture.setCatalog(candidateLess);
    ({ context, page } = await openPage(browser, fixture));
    await selectImage(page, "C");
    fixture.setSourceDeleteOperation(token, { state: "claimed", imageIds: ["C"], preparedSourceKinds: { C: "filesystem" } });
    await page.evaluate(async (deleteToken) => {
      await rememberPendingSourceDelete({ deleteToken, imageIds: ["C"], browserDeletedImageIds: [], browserEntries: [], state: "claimed" });
    }, token);
    await page.route("**/api/catalog/delete-source/status", (route) => route.abort("connectionfailed"));
    await page.evaluate(async () => { await resumePendingSourceDeletes(); });
    await expect.poll(async () => page.evaluate(async () =>
      (await pendingSourceDeletes()).some((entry) => entry.deleteToken.endsWith("168183"))), { timeout: 30000 }).toBe(true);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      hasCanvas: Boolean(state.currentImage), candidates: state.candidates.length })),
    { ids: ["A", "B", "C", "D"], currentId: "C", hasCanvas: true, candidates: 0 },
    "a disconnected unconfirmed receipt retains the authoritative catalogue and candidate-less editor");

    await page.unroute("**/api/catalog/delete-source/status");
    const survivors = candidateLess.filter((image) => image.id !== "C");
    fixture.setCatalog(survivors);
    fixture.setSourceDeleteOperation(token, { state: "committed", imageIds: ["C"], preparedSourceKinds: { C: "filesystem" },
      images: survivors, removedImageIds: ["C"], failed: [] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect.poll(async () => page.evaluate(async () => state.images.map((image) => image.id).join(",") === "A,B,D"
      && !(await pendingSourceDeletes()).some((entry) => entry.deleteToken.endsWith("168183"))
      && Boolean(state.currentId) && Boolean(state.currentImage) && !state.catalogTransition && !state.projectOperationPending), { timeout: 30000 }).toBe(true);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
      currentExists: state.images.some((image) => image.id === state.currentId), candidates: state.candidates.length,
      canvasReady: originalCanvas.width > 1 && originalCanvas.height > 1 })),
    { ids: ["A", "B", "D"], currentId: "A", currentExists: true, candidates: 0, canvasReady: true },
    "reload/reconnect consumes the committed receipt, removes only C, and opens an authoritative candidate-less survivor canvas");
    assert.deepEqual(fixture.sourceDeleteOperations(), [], "the terminal committed receipt is acknowledged only after the reloaded catalogue publishes");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("DI-181.6 delayed conflicted and disconnected review or hide never move or erase the current editor early", { timeout: 300000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    for (const position of [
      { name: "first", id: "A", visible: ["A", "C", "D"] },
      { name: "middle", id: "C", visible: ["A", "C", "D"] },
      { name: "tail", id: "D", visible: ["A", "C", "D"] },
      { name: "outside", id: "B", visible: ["A", "C", "D"] },
      { name: "one", id: "C", visible: ["C"] },
    ]) for (const action of [
      { button: "#reviewAndNextButton", field: "reviewed" },
      { button: "#hideAndNextButton", field: "hidden" },
    ]) {
      for (const failure of ["409", "disconnect"]) {
        await context?.close(); context = null;
        fixture.resetScenario(); fixture.setCatalog(catalogue.map((image) => ({ ...image, reviewed: false, hidden: false })));
        ({ context, page } = await openPage(browser, fixture));
        await selectImage(page, position.id);
        await page.evaluate(({ id, visible }) => {
          state.maskStatus = new Map(state.images.map((image) => [image.id, visible.includes(image.id)]));
          state.galleryFilter = new Set(["masked"]); renderGallery(true);
          addCtx.fillStyle = "rgba(83, 47, 229, 1)"; addCtx.fillRect(6, 9, 1, 1); markDraftDirty("add");
          window.__navigationAuthorityImage = state.currentImage;
          window.__navigationAuthorityId = id;
        }, position);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await page.route(`**/api/workspace/image/${position.id}`, async (route) => {
          await gate;
          if (failure === "409") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "stale_catalog" }) });
          else await route.abort("connectionfailed");
        });
        const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === `/api/workspace/image/${position.id}`);
        await page.locator(action.button).click(); const capturedRequest = await request;
        assert.deepEqual(capturedRequest.postDataJSON(), { [action.field]: true }, `${action.field} ${failure} sends only the current flag mutation`);
        assert.deepEqual(await page.evaluate(({ field, id }) => ({ currentId: state.currentId,
          sameImageObject: state.currentImage === window.__navigationAuthorityImage,
          pixel: [...addCtx.getImageData(6, 9, 1, 1).data], published: state.images.find((image) => image.id === id)?.[field],
        }), { field: action.field, id: position.id }), { currentId: position.id, sameImageObject: true, pixel: [83, 47, 229, 255], published: false },
        `${position.name} ${action.field} ${failure} delay publishes neither the flag nor successor before authority`);
        release();
        await page.waitForFunction(() => state.imageMutationChains.size === 0);
        assert.deepEqual(await page.evaluate(({ field, id }) => ({ ids: state.images.map((image) => image.id), currentId: state.currentId,
          sameImageObject: state.currentImage === window.__navigationAuthorityImage,
          pixel: [...addCtx.getImageData(6, 9, 1, 1).data],
          published: state.images.find((image) => image.id === id)?.[field], catalogMutation: state.catalogMutation,
        }), { field: action.field, id: position.id }), { ids: ["A", "B", "C", "D"], currentId: position.id,
          sameImageObject: true, pixel: [83, 47, 229, 255], published: false, catalogMutation: false },
        `${position.name} ${action.field} ${failure} publishes no rejected flag or catalogue mutation`);
      }
    }
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});
