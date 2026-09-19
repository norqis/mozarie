"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function openFixture(fixture) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2 && document.querySelectorAll(".gallery-item").length === 2);
  return { browser, context, page };
}

async function closeFixture(fixture, opened) {
  await opened?.context?.close();
  await opened?.browser?.close();
  await closeServer(fixture.server);
}

test("filter popovers close accessibly and retain search, folder, and checkbox state across views", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    const button = page.locator("#galleryFilterButton"); const popover = page.locator("#galleryFilterMenu");
    await button.click(); assert.equal(await popover.evaluate((node) => node.matches(":popover-open")), true);
    await page.keyboard.press("Tab"); assert.equal((await page.evaluate(() => document.activeElement?.closest("#galleryFilterMenu") != null)), true, "Tab enters the open filter menu");
    await page.keyboard.press("Escape"); assert.equal(await popover.evaluate((node) => node.matches(":popover-open")), false, "Escape closes the filter menu");
    await button.click(); await page.locator('[data-gallery-filter="reviewed"]').check();
    await page.locator("#collapseGalleryButton").click(); assert.equal(await popover.evaluate((node) => node.matches(":popover-open")), false, "collapsing the gallery closes its menu");
    await page.locator("#collapseGalleryButton").click(); await page.locator("#overviewButton").click();
    await page.locator("#overviewQuery").fill("sample"); await page.locator("#overviewFolder").selectOption("");
    await page.locator("#overviewFilterButton").click(); await page.locator('[data-overview-filter="reviewed"]').check();
    await page.locator("#closeOverviewButton").click();
    assert.deepEqual(await page.evaluate(() => ({ gallery: [...state.galleryFilter], overview: [...state.overviewFilter], query: state.overviewQuery, folder: state.overviewFolder })), { gallery: ["reviewed"], overview: ["reviewed"], query: "sample", folder: "" });
    assert.equal(await page.locator("#overviewFilterMenu").evaluate((node) => node.matches(":popover-open")), false, "switching views closes the old menu");
  } finally { await closeFixture(fixture, opened); }
});

test("batch flag actions change only selected images and report the selection count", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample"]').click();
    assert.equal(await page.locator("#selectionCount").textContent(), "1件を選択中");
    const unchanged = () => page.evaluate(() => structuredClone(state.images.find((image) => image.id === "sample-two")));
    for (const [action, field, expected] of [["reviewed", "reviewed", true], ["unreviewed", "reviewed", false], ["hide", "hidden", true], ["show", "hidden", false]]) {
      const before = await unchanged();
      await page.locator("#selectionActionsButton").click();
      await page.locator(`[data-selection-action="${action}"]`).click();
      await page.waitForFunction(([key, value]) => state.images.find((image) => image.id === "sample")?.[key] === value, [field, expected]);
      assert.deepEqual(await unchanged(), before, `${action} leaves the unselected image unchanged`);
      assert.equal(await page.locator("#selectionCount").textContent(), "1件を選択中", `${action} retains the selection`);
    }
  } finally { await closeFixture(fixture, opened); }
});

test("batch detection cancel and processing locks preserve selection, catalog, and project state", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click(); await page.locator('.overview-item[data-id="sample"]').click();
    const before = await page.evaluate(() => ({ ids: state.images.map((image) => image.id), selected: [...state.selectedImageIds], project: structuredClone(state.project) }));
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="detect"]').click(); await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    await page.locator("#detectCancelButton").click();
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), selected: [...state.selectedImageIds], project: structuredClone(state.project) })), before);
    await page.locator("#overviewFilterButton").click();
    await page.evaluate(() => { state.job = { kind: "detect", state: "running", total: 1, completed: 0, imageIds: ["sample"] }; showProcessing(state.job); updateActionButtons(); });
    assert.equal(await page.locator("#overviewFilterMenu").evaluate((node) => node.matches(":popover-open")), false, "processing closes the filter menu");
    assert.equal(await page.locator('[data-selection-action="detect"]').isDisabled(), true, "processing disables selection detection");
    await page.evaluate(() => { state.job = { kind: "idle", state: "idle" }; showProcessing({ kind: "detect", state: "complete", total: 1, completed: 1, imageIds: ["sample"], completedImageIds: ["sample"] }); state.processing = null; updateActionButtons(); });
    await page.waitForFunction(() => !document.querySelector('[data-selection-action="detect"]').disabled);
    assert.deepEqual(await page.evaluate(() => [...state.selectedImageIds]), before.selected, "completion re-enables actions without losing selection");
  } finally { await closeFixture(fixture, opened); }
});

test("project table sorts actual rows in both directions for name, creation, and update", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.locator("#projectButton").click(); await page.locator("#projectOpenList").click();
    await page.locator('#projectListBody [data-project-action="open"]').first().waitFor();
    const rows = () => page.locator('#projectListBody tr').evaluateAll((items) => items.map((row) => row.dataset.projectId));
    for (const key of ["name", "created", "updated"]) {
      const button = page.locator(`[data-project-sort="${key}"]`);
      await button.click(); await page.waitForFunction((value) => document.querySelector(`[data-project-sort="${value}"]`)?.closest("th")?.getAttribute("aria-sort") === "ascending", key);
      const ascending = await rows();
      await button.click(); await page.waitForFunction((value) => document.querySelector(`[data-project-sort="${value}"]`)?.closest("th")?.getAttribute("aria-sort") === "descending", key);
      const descending = await rows();
      assert.deepEqual(descending, [...ascending].reverse(), `${key} descending reverses the actual ascending project rows`);
    }
  } finally { await closeFixture(fixture, opened); }
});

test("completed projects keep browsing and exports enabled while every mutation stays disabled", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.evaluate(() => {
      state.project = { id: "completed-project", name: "Completed", status: "completed", imageCount: state.images.length };
      state.projectReadOnly = true; state.currentId = state.images[0].id; state.currentImage = state.images[0]; renderCatalogViews(); updateActionButtons();
    });
    for (const selector of ["#detectAllButton", "#detectCurrentButton", "#saveAllButton", "#saveButton", "#reviewAndNextButton", "#removeCurrentImageButton", "#undoButton", "#redoButton", "#brushTool", "#bucketTool"]) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} is disabled in a completed project`);
    }
    for (const selector of ["#nextImageButton", "#galleryFilterButton", "#overviewButton", "#downloadCurrentMosaicMask", "#downloadCurrentExcludeMask"]) {
      assert.equal(await page.locator(selector).isDisabled(), false, `${selector} remains available in a completed project`);
    }
    await page.locator("#galleryFilterButton").click(); assert.equal(await page.locator("#galleryFilterMenu").evaluate((node) => node.matches(":popover-open")), true, "completed projects retain filtering");
    await page.keyboard.press("Escape"); await page.locator("#projectButton").click();
    assert.equal(await page.locator("#projectResume").isVisible(), true, "completed projects expose Resume work");
    assert.equal(await page.locator("#projectComplete").isDisabled(), true, "completed projects cannot be completed twice");
  } finally { await closeFixture(fixture, opened); }
});

test("pending selection mutation disables controls and a stale delayed result cannot change the replacement catalog", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened; let release; let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.route("**/api/workspace/images", async (route) => {
      markStarted(); await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ flags: { sample: { reviewed: true } } }) });
    });
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click(); await page.locator('.overview-item[data-id="sample"]').click(); await page.locator("#selectionActionsButton").click();
    const action = page.locator('[data-selection-action="reviewed"]').click(); await started;
    assert.equal(await page.locator("#overviewFilterButton").isDisabled(), true, "current overview controls are disabled while the selection request is pending");
    await page.evaluate(() => { state.catalogEpoch += 1; state.images = state.images.map((image) => ({ ...image, reviewed: false })); renderCatalogViews(); });
    release(); await action;
    assert.equal(await page.evaluate(() => state.images.find((image) => image.id === "sample").reviewed), false, "a delayed response from the prior catalog is ignored");
    assert.equal(await page.locator("#overviewFilterButton").isDisabled(), false, "current overview controls re-enable after the stale request settles");
  } finally { await closeFixture(fixture, opened); }
});

test("batch mask clear retains source records, unselected images, and project identity", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click(); await page.locator('.overview-item[data-id="sample"]').click();
    const before = await page.evaluate(() => ({ ids: state.images.map((image) => image.id), other: structuredClone(state.images.find((image) => image.id === "sample-two")), project: structuredClone(state.project) }));
    await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="clear"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open); await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.masksClearing);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), other: structuredClone(state.images.find((image) => image.id === "sample-two")), project: structuredClone(state.project) })), before);
  } finally { await closeFixture(fixture, opened); }
});

test("catalog clear cancel preserves workspace and confirmation removes only image data", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); let opened;
  try {
    opened = await openFixture(fixture); const { page } = opened;
    const before = await page.evaluate(() => ({ ids: state.images.map((image) => image.id), project: structuredClone(state.project) }));
    await page.locator("#batchMoreButton").click(); await page.locator("#clearCatalogButton").click(); await page.locator("#confirmCancel").click();
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), project: structuredClone(state.project) })), before, "cancel retains list and project data");
    await page.locator("#batchMoreButton").click(); await page.locator("#clearCatalogButton").click(); await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.images.length === 0);
    assert.deepEqual(await page.evaluate(() => ({ count: state.images.length, project: structuredClone(state.project) })), { count: 0, project: before.project }, "confirmation clears image data while retaining the project");
  } finally { await closeFixture(fixture, opened); }
});
