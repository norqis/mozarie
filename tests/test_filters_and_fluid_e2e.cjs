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

test("server save progress is restored in the UI after an offline poll reconnects", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => { clearTimeout(state.jobPollTimer); state.jobPollTimer = null; });
    let requests = 0;
    await page.route("**/api/job", async (route) => {
      requests += 1;
      if (requests === 1) { await route.abort("failed"); return; }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "apply", state: "running", total: 5, completed: 3, current: "three.png", startedAt: 99, imageIds: ["sample", "sample-two"] }) });
    });
    await page.evaluate(() => pollJob());
    assert.equal(await page.evaluate(() => state.pollFailures), 1, "the offline poll is retained as a reconnect failure");
    await page.evaluate(() => { clearTimeout(state.jobPollTimer); state.jobPollTimer = null; return pollJob(); });
    assert.equal(await page.evaluate(() => state.pollFailures), 0, "a successful reconnect clears the poll failure count");
    assert.deepEqual(await page.evaluate(() => ({ value: document.querySelector("#applyProgress").value, max: document.querySelector("#applyProgress").max, current: document.querySelector("#applyCurrentName").textContent, text: document.querySelector("#applyProgressText").textContent, open: document.querySelector("#applyDialog").open })), {
      value: 3, max: 5, current: "three.png", text: "ファイル保存の進行状況: 3 / 5件 完了", open: true,
    }, "the reconnected server state, rather than stale client progress, is shown in the save UI");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("catalog clear failure keeps the project and list, and closing the real error dialog restores actions", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => {
      state.settings.confirmations.clearCatalog = true;
      state.project = { id: "project-kept", name: "Kept project", status: "working" };
      renderProjectCurrent();
    });
    const before = await page.evaluate(() => ({ imageIds: state.images.map((image) => image.id), currentId: state.currentId, project: structuredClone(state.project) }));
    const resyncSnapshot = await page.evaluate(() => ({ images: structuredClone(state.images), root: state.root || "G:/fixture", catalogGeneration: state.serverCatalogGeneration, workspace: true, workspaceId: state.project.id, historyDurable: true, project: structuredClone(state.project), readOnly: false, sources: [], needsSource: false }));
    await page.route("**/api/images", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resyncSnapshot) }));
    await page.route("**/api/catalog/clear", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "workspace_database_error" }) }));
    await page.locator("#batchMoreButton").click();
    await page.locator("#clearCatalogButton").click();
    assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), true, "catalog clear opens its product confirmation before the action");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open && state.catalogMutation === false);
    assert.deepEqual(await page.evaluate(() => ({ imageIds: state.images.map((image) => image.id), currentId: state.currentId, project: structuredClone(state.project) })), before, "a failed clear never reports success by discarding the list, selection, or project");
    assert.equal(await page.locator("#errorDialogTitle").textContent(), "作業内容を保存できません", "the failure is presented through the real user error dialog");

    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "the error dialog returns to the prior screen");
    assert.equal(await page.locator("#saveAllButton").isEnabled(), true, "save actions are reusable after the error closes");
    await page.locator("#batchMoreButton").click();
    assert.equal(await page.locator("#clearCatalogButton").isEnabled(), true, "the failed catalog action itself is reusable after the error closes");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("single overwrite confirmation cancel returns to save dialog with source bytes and mtime unchanged", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    const before = await page.evaluate(async () => {
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg=="), (value) => value.charCodeAt(0));
      const parentHandle = await navigator.storage.getDirectory();
      const fileHandle = await parentHandle.getFileHandle("cancel-overwrite.png", { create: true });
      const writable = await fileHandle.createWritable(); await writable.write(bytes); await writable.close();
      const file = await fileHandle.getFile();
      const image = state.images.find((entry) => entry.id === "sample");
      image.sourceKind = "session"; image.relativePath = file.name; image.sizeBytes = file.size; image.mtimeNs = file.lastModified * 1_000_000;
      state.sourceAccess.set(image.id, { fileHandle, name: file.name, size: file.size, lastModified: file.lastModified, relativePath: file.name, sourceKind: "browser-files" });
      state.settings.confirmations.overwriteSource = true;
      addCtx.fillStyle = "#fff"; addCtx.fillRect(0, 0, 1, 1); markMaskDirty(); refreshMaskStatus(true);
      return { bytes: [...new Uint8Array(await file.arrayBuffer())], lastModified: file.lastModified };
    });
    await page.waitForFunction(() => !document.querySelector("#saveButton").disabled);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
    await page.locator("#singleSaveOverwriteMode").check();
    const requestsBefore = fixture.saveRequests.length;
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator("#confirmCancel").isEnabled(), true, "the overwrite confirmation exposes an operable Cancel button");
    await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => !state.saveStarting && !state.saving && !document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator("#singleSaveDialog").evaluate((dialog) => dialog.open), true, "Cancel returns to the same single-save dialog");
    const after = await page.evaluate(async () => {
      const file = await (await navigator.storage.getDirectory()).getFileHandle("cancel-overwrite.png").then((handle) => handle.getFile());
      return { bytes: [...new Uint8Array(await file.arrayBuffer())], lastModified: file.lastModified };
    });
    assert.deepEqual(after, before, "Cancel leaves the source bytes and last-modified timestamp exactly unchanged");
    assert.equal(fixture.saveRequests.length, requestsBefore, "Cancel creates no save reservation or output");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

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
    assert.equal(await page.locator('label[for="detectFluidColorFillEnabled"], #detectFluidColorFillEnabled').count() > 0, true);
    assert.match(await page.locator("#detectFluidColorFillEnabled").getAttribute("aria-label"), /精液候補を色で広げる|fluid/i);
    assert.match(await page.locator("#detectFluidColorFillTolerance").getAttribute("aria-label"), /許容範囲|tolerance/i);
    assert.equal(await page.locator("#detectFluidColorFillTolerance").getAttribute("min"), "0");
    assert.equal(await page.locator("#detectFluidColorFillTolerance").getAttribute("max"), "255");
    assert.equal(await page.locator("#detectFluidColorFillEnabled").isChecked(), true, "color expansion is enabled by default");
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "26", "the all-image dialog starts at the configured default tolerance");
    assert.equal(await page.locator("#bucketTolerance").inputValue(), "20", "the manual fill tool keeps its independent tolerance");
    await page.locator("#detectFluidColorFillTolerance").fill("27");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => window.__detectPayloads.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__detectPayloads[0]), {
      imageIds: ["sample", "sample-two"], confidence: 0.5, parallelism: 2, targetClasses: ["penis", "pussy"], fluidColorFillEnabled: false, fluidColorFillTolerance: 27,
    }, "the modal sends an explicit fluid-fill switch and tolerance with the detection request");
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.fluid_color_fill_enabled, false);
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.fluid_color_fill_tolerance, 27);
    await page.waitForFunction(() => !state.processing && !isBusy());
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectFluidColorFillEnabled").isChecked(), false, "saved OFF is restored when the dialog reopens");
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "27", "saved tolerance is restored when the dialog reopens");
    assert.equal(await page.locator("#detectFluidColorFillTolerance").isDisabled(), true, "OFF visibly disables its dependent tolerance input");
    assert.equal(await page.locator("#bucketTolerance").inputValue(), "20", "auto-detection settings never rewrite manual fill tolerance");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("SD-136 fluid color tolerance accepts inclusive bounds and rejects values outside 0 through 255", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator("#detectAllButton").click();
    const before = fixture.detectRequests.length;
    for (const invalid of ["-1", "256", ""]) {
      await page.locator("#detectFluidColorFillTolerance").fill(invalid);
      await page.evaluate(() => startDetectionFromDialog({ preventDefault() {} }));
      assert.equal(fixture.detectRequests.length, before);
      assert.equal(await page.locator("#detectFluidColorFillTolerance").getAttribute("aria-invalid"), "true");
    }
    for (const valid of ["0", "255"]) {
      await page.locator("#detectFluidColorFillTolerance").fill(valid);
      const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/detect" && item.request().method() === "POST");
      await page.locator("#detectStartButton").click();
      await response;
      assert.equal(fixture.detectRequests.at(-1).fluidColorFillTolerance, Number(valid));
      await page.waitForFunction(() => !state.processing && !isBusy());
      await page.locator("#detectAllButton").click();
      assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), valid);
    }
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("SD-139 disabling fluid color fill visibly disables tolerance without changing its value", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    const { context: openedContext, page } = await freshPage(browser, fixture); context = openedContext;
    await page.locator("#detectAllButton").click();
    await page.locator("#detectFluidColorFillTolerance").fill("41");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    assert.equal(await page.locator("#detectFluidColorFillTolerance").isDisabled(), true);
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "41");
    await page.locator("#detectFluidColorFillEnabled").check();
    assert.equal(await page.locator("#detectFluidColorFillTolerance").isEnabled(), true);
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "41");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("SD-140 current-image detection uses the saved fluid switch and tolerance without opening the dialog", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    const { context: openedContext, page } = await freshPage(browser, fixture); context = openedContext;
    await page.locator("#detectAllButton").click();
    await page.locator("#detectFluidColorFillTolerance").fill("37");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => !state.processing && !isBusy());
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && Boolean(state.currentImage));
    const request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    assert.equal(await page.locator("#detectDialog").evaluate((dialog) => dialog.open), false);
    await page.locator("#detectCurrentButton").click();
    const payload = JSON.parse((await request).postData());
    assert.equal(payload.fluidColorFillEnabled, false);
    assert.equal(payload.fluidColorFillTolerance, 37);
    assert.deepEqual(payload.imageIds, ["sample"]);
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
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

test("batch save filters images with independent OR checkboxes and persists the selection", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    { id: "masked-reviewed", relativePath: "masked-reviewed.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: true, hidden: false, hasEffectiveMask: true },
    { id: "unmasked-unreviewed", relativePath: "unmasked-unreviewed.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false, hasEffectiveMask: false },
    { id: "masked-unreviewed", relativePath: "masked-unreviewed.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
    { id: "unmasked-reviewed", relativePath: "unmasked-reviewed.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: true, hidden: false, hasEffectiveMask: false },
    { id: "hidden", relativePath: "hidden.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: true, hasEffectiveMask: true },
  ]);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture, null, 5));
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    assert.equal(await page.locator("#applyImageFilters legend").textContent(), "保存する画像", "save filters have their own named group");
    assert.deepEqual(await page.locator("[data-apply-image-filter]").evaluateAll((inputs) => inputs.map((input) => [input.dataset.applyImageFilter, input.checked])), [
      ["masked", false], ["unmasked", false], ["reviewed", false], ["unreviewed", false],
    ], "no checked filter defaults to every non-hidden image");
    const setFilters = async (...filters) => {
      await page.locator("[data-apply-image-filter]").evaluateAll((inputs, selected) => {
        for (const input of inputs) {
          input.checked = selected.includes(input.dataset.applyImageFilter);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, filters);
    };
    const targetIds = () => page.evaluate(() => [...state.applyTargetIds]);
    assert.deepEqual(await targetIds(), ["masked-reviewed", "unmasked-unreviewed", "masked-unreviewed", "unmasked-reviewed"], "the hidden image is excluded from the unfiltered save");
    await setFilters("masked");
    assert.deepEqual(await targetIds(), ["masked-reviewed", "masked-unreviewed"], "masked ignores review state");
    await setFilters("unmasked");
    assert.deepEqual(await targetIds(), ["unmasked-unreviewed", "unmasked-reviewed"], "unmasked ignores review state");
    await setFilters("reviewed");
    assert.deepEqual(await targetIds(), ["masked-reviewed", "unmasked-reviewed"], "reviewed ignores mask state");
    await setFilters("unreviewed");
    assert.deepEqual(await targetIds(), ["unmasked-unreviewed", "masked-unreviewed"], "unreviewed ignores mask state");
    await setFilters("masked", "unreviewed");
    assert.deepEqual(await targetIds(), ["masked-reviewed", "unmasked-unreviewed", "masked-unreviewed"], "multiple save filters use OR semantics");

    await page.evaluate(() => {
      for (const image of state.images) { image.reviewed = true; state.reviewedImageIds.add(image.id); }
      refreshApplyTargets();
    });
    await setFilters("unreviewed");
    assert.deepEqual(await targetIds(), [], "a filter can yield zero save targets");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "saving cannot start with no matching image");
    await page.evaluate(() => {
      for (const imageId of ["masked-unreviewed", "unmasked-unreviewed"]) {
        const image = state.images.find((item) => item.id === imageId);
        image.reviewed = false; state.reviewedImageIds.delete(image.id);
      }
      refreshApplyTargets();
    });
    let releaseSettings;
    let resolveSettingsSeen;
    const settingsSeen = new Promise((resolve) => { resolveSettingsSeen = resolve; });
    const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });
    let resolvePrepareSeen;
    const prepareSeen = new Promise((resolve) => { resolvePrepareSeen = resolve; });
    let settingsPayload = null;
    let preparePayload = null;
    await page.route("**/api/settings?status=0", async (route) => {
      settingsPayload = JSON.parse(route.request().postData());
      resolveSettingsSeen();
      await settingsGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { saving: { image_filters: ["unreviewed"] } } }) });
    });
    await page.route("**/api/save/prepare", async (route) => {
      preparePayload = JSON.parse(route.request().postData());
      resolvePrepareSeen();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
    });
    await page.locator("#applyStartButton").click();
    await settingsSeen;
    assert.deepEqual(settingsPayload.saving.image_filters, ["unreviewed"], "starting a batch save persists its filters separately");
    assert.equal(await page.locator('[data-apply-image-filter="unreviewed"]').isDisabled(), true, "filters lock after the save target snapshot is captured");
    await page.evaluate(() => {
      state.images.find((image) => image.id === "masked-unreviewed").hidden = true;
      state.hiddenImageIds.add("masked-unreviewed");
      state.images.push({ id: "new-unreviewed", relativePath: "new-unreviewed.png", sourceKind: "filesystem", reviewed: false, hidden: false, hasEffectiveMask: false });
    });
    releaseSettings();
    await prepareSeen;
    assert.deepEqual(preparePayload.imageIds, ["unmasked-unreviewed"], "an awaited setting update can remove a now-hidden captured target but cannot add a newly matching image");
    await page.waitForFunction(() => state.saveStarting === false);
    assert.equal(await page.locator('[data-apply-image-filter="unreviewed"]').isDisabled(), false, "a save-start failure unlocks the saved filters");
    assert.equal(await page.locator('[data-apply-image-filter="unreviewed"]').isChecked(), true, "a save-start failure retains the selected filter");
    await page.locator("#errorDialogClose").click();
    await page.locator("#applyCloseButton").click();
    await page.locator("#saveAllButton").click();
    assert.equal(await page.locator('[data-apply-image-filter="unreviewed"]').isChecked(), true, "the same page restores the saved selection");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("batch save keeps confirmation usable after committing a changed output directory", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", sourcePath: "G:\\fixture\\sample.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1, reviewed: false, hidden: false, hasEffectiveMask: true },
  ]);
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture, null, 1));
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("#applyOutputDirectoryStatus").evaluate((input) => { input.value = "G:\\changed-output"; });
    await page.locator("#applyOverwriteMode").check();
    await page.evaluate(() => { state.settings.confirmations.overwriteSource = true; });
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator("#confirmAccept").isEnabled(), true, "the changed-path commit does not leave confirm disabled");
    assert.equal(await page.locator("#confirmCancel").isEnabled(), true, "the changed-path commit does not leave cancel disabled");
    await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => state.saveStarting === false && !document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator('[data-apply-image-filter="masked"]').isEnabled(), true, "cancelling after a path commit unlocks the save filters");
    assert.equal(fixture.saveRequests.some((request) => request.path === "/api/save/prepare"), false, "cancelling confirmation creates no output reservation");

    fixture.holdSaveRender(true);
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(await page.locator("#confirmAccept").isEnabled(), true, "confirmation remains usable on retry");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.saving && state.applyRunning);
    fixture.releaseSaveRenders();
    await page.waitForFunction(() => !state.saving && !state.applyRunning, null, { timeout: 8000 });
    assert.deepEqual(fixture.saveRequests.map((request) => request.path), ["/api/save/prepare", "/api/save/reserve", "/api/save/render", "/api/save/commit", "/api/save/ack"], "accepting after a path commit completes the overwrite save");
  } finally {
    fixture.releaseSaveRenders();
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
