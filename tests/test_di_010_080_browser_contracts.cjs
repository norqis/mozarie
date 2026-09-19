"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

function record(id, { masked = false, reviewed = false, hidden = false } = {}) {
  return {
    id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 100, height: 80,
    candidateCount: masked ? 1 : 0, enabledCandidateCount: masked ? 1 : 0,
    candidateRevision: masked ? 1 : 0, hasEffectiveMask: masked, reviewed, hidden,
  };
}

async function setChecked(page, selector, values) {
  await page.locator(selector).evaluateAll((inputs, selected) => {
    for (const input of inputs) {
      input.checked = selected.includes(input.dataset.galleryFilter || input.dataset.applyImageFilter);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
}

test("eight-image gallery and save filters preserve the complete truth table and target snapshot", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    record("A", { masked: true, reviewed: true }),
    record("B", { masked: true }),
    record("C", { reviewed: true }),
    record("D"),
    record("E", { hidden: true }),
    record("F", { masked: true, hidden: true }),
    record("G", { reviewed: true, hidden: true }),
    record("H", { masked: true, reviewed: true, hidden: true }),
  ]);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 8 && document.querySelectorAll(".gallery-item").length === 8);

    const galleryIds = () => page.evaluate(() => galleryFilteredImages().map((image) => image.id));
    assert.deepEqual(await galleryIds(), ["A", "B", "C", "D", "E", "F", "G", "H"], "no gallery filters displays all eight project images");
    await page.locator("#galleryFilterButton").click();
    for (const [filters, expected, label] of [
      [["masked"], ["A", "B"], "masked"],
      [["unmasked"], ["C", "D"], "unmasked"],
      [["reviewed"], ["A", "C"], "reviewed"],
      [["unreviewed"], ["B", "D"], "unreviewed"],
      [["hidden"], ["E", "F", "G", "H"], "hidden"],
    ]) {
      await setChecked(page, "[data-gallery-filter]", filters);
      assert.deepEqual(await galleryIds(), expected, `${label} gallery filter displays exactly its expected images`);
    }

    await setChecked(page, "[data-gallery-filter]", ["unreviewed"]);
    await page.keyboard.press("Escape");
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    const applyIds = () => page.evaluate(() => [...state.applyTargetIds]);
    assert.deepEqual(await applyIds(), ["A", "B", "C", "D"], "batch save defaults to every non-hidden project image, independent of the left gallery filter");

    for (const [filters, expected, label] of [
      [["masked"], ["A", "B"], "masked"],
      [["reviewed"], ["A", "C"], "reviewed"],
      [[], ["A", "B", "C", "D"], "all"],
    ]) {
      await setChecked(page, "[data-apply-image-filter]", filters);
      assert.deepEqual(await applyIds(), expected, `${label} batch-save filter snapshots only its matching non-hidden images`);
    }

    await page.locator("#applyCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#applyDialog").open);
    await page.evaluate(() => { state.overviewQuery = "A"; });
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await setChecked(page, "[data-apply-image-filter]", []);
    assert.deepEqual(await applyIds(), ["A", "B", "C", "D"], "batch-save all ignores the overview search and uses the whole non-hidden project");

    await setChecked(page, "[data-apply-image-filter]", ["unreviewed"]);
    await page.evaluate(() => {
      for (const image of state.images) { image.reviewed = true; state.reviewedImageIds.add(image.id); }
      refreshApplyTargets();
    });
    assert.deepEqual(await applyIds(), [], "an unmatched save filter produces zero targets");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "zero targets disable batch-save start");
    await setChecked(page, "[data-apply-image-filter]", []);
    assert.equal(await page.locator("#applyStartButton").isDisabled(), false, "switching back to all restores a valid batch-save target set");

    await setChecked(page, "[data-apply-image-filter]", ["reviewed"]);
    await page.evaluate(() => {
      for (const image of state.images) { image.reviewed = false; state.reviewedImageIds.delete(image.id); }
      refreshApplyTargets();
    });
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "reviewed-only starts disabled when no image is reviewed");
    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "A");
      image.reviewed = true; state.reviewedImageIds.add(image.id); refreshApplyTargets();
    });
    assert.deepEqual(await applyIds(), ["A"], "reviewing one image immediately makes only that image eligible");

    await setChecked(page, "[data-apply-image-filter]", ["masked"]);
    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "B");
      image.hasEffectiveMask = false; image.enabledCandidateCount = 0; refreshApplyTargets();
    });
    assert.deepEqual(await applyIds(), ["A"], "clearing B's effective mask removes only B from masked save targets");
    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "B");
      image.hasEffectiveMask = true; image.enabledCandidateCount = 1; refreshApplyTargets();
    });
    assert.deepEqual(await applyIds(), ["A", "B"], "restoring B's effective mask restores B to masked save targets");

    await page.locator("#applyCloseButton").click();
    await setChecked(page, "[data-gallery-filter]", []);
    await page.locator('.gallery-item[data-id="A"]').click();
    await page.waitForFunction(() => state.currentId === "A" && state.currentImage);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
    assert.match(await page.locator("#singleSaveTarget").textContent(), /A\.png$/, "single save targets only the selected image");
    assert.equal(await page.locator("#singleSaveDialog [data-apply-image-filter]").count(), 0, "single save does not expose the batch target filters");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.hidden, image.reviewed, image.hasEffectiveMask])), [
      ["A", false, true, true], ["B", false, false, true], ["C", false, false, false], ["D", false, false, false],
      ["E", true, false, false], ["F", true, false, true], ["G", true, false, false], ["H", true, false, true],
    ], "filtering and opening save dialogs never delete images or alter hidden/mask state outside the explicit review fixture mutation");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("single save ignores a persisted batch filter that excludes the current image", { timeout: 120000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    record("A", { masked: true, reviewed: true }),
    record("B", { masked: true }),
    record("C", { reviewed: true }),
    record("D"),
    record("E", { hidden: true }),
    record("F", { masked: true, hidden: true }),
    record("G", { reviewed: true, hidden: true }),
    record("H", { masked: true, reviewed: true, hidden: true }),
  ]);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 8);

    const expectedState = [
      ["A", false, true, true], ["B", false, false, true], ["C", false, true, false], ["D", false, false, false],
      ["E", true, false, false], ["F", true, false, true], ["G", true, true, false], ["H", true, true, true],
    ];
    const runBatch = async (filters, expectedIds) => {
      const before = fixture.saveRequests.length;
      await page.locator("#saveAllButton").click();
      await page.waitForFunction(() => document.querySelector("#applyDialog").open);
      await setChecked(page, "[data-apply-image-filter]", filters);
      await page.locator("#applyOverwriteMode").check();
      await page.locator("#applyStartButton").click();
      await page.waitForFunction(() => !state.saving && !state.applyRunning && !state.saveStarting, null, { timeout: 20000 });
      const requests = fixture.saveRequests.slice(before);
      assert.deepEqual(requests.find((request) => request.path === "/api/save/prepare").payload.imageIds, expectedIds,
        `save prepare receives only ${filters.join("+") || "all"}`);
      assert.deepEqual(requests.filter((request) => request.path === "/api/save/commit").map((request) => request.payload.imageId), expectedIds,
        `save commits each ${filters.join("+") || "all"} target once`);
      assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.hidden, image.reviewed, Boolean(image.hasEffectiveMask)])), expectedState,
        "completed overwrite leaves all review, hidden, and mask classifications intact");
      await page.locator("#applyCloseButton").click();
      await page.waitForFunction(() => !document.querySelector("#applyDialog").open);
    };

    for (const [filters, expectedIds] of [
      [[], ["A", "B", "C", "D"]], [["masked"], ["A", "B"]], [["reviewed"], ["A", "C"]],
      [[], ["A", "B", "C", "D"]], [["masked"], ["A", "B"]], [["reviewed"], ["A", "C"]],
    ]) await runBatch(filters, expectedIds);

    assert.equal(await page.locator('[data-apply-image-filter="reviewed"]').isChecked(), true,
      "the reviewed-only batch filter remains selected after the batch dialog closes");
    const beforeSingle = fixture.saveRequests.length;
    await page.locator('.gallery-item[data-id="D"]').click();
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting, null, { timeout: 20000 });
    const singleRequests = fixture.saveRequests.slice(beforeSingle);
    assert.deepEqual(singleRequests.find((request) => request.path === "/api/save/prepare").payload.imageIds, ["D"],
      "single save prepares unreviewed D even though the persisted reviewed-only batch filter excludes it");
    assert.deepEqual(singleRequests.filter((request) => request.path === "/api/save/commit").map((request) => request.payload.imageId), ["D"],
      "single save commits only unreviewed D independently of the persisted batch filter");
    assert.equal(await page.locator("#singleSaveDialog [data-apply-image-filter]").count(), 0, "single save exposes no batch target selector");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => [image.id, image.hidden, image.reviewed, Boolean(image.hasEffectiveMask)])), expectedState,
      "single save leaves every image classification unchanged");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("zero-target masked filter disables start and switching to all completes the save", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.setCatalog([
    record("A"), record("B", { reviewed: true }), record("C"), record("D", { reviewed: true }),
    record("E", { hidden: true }),
  ]);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 5);
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await setChecked(page, "[data-apply-image-filter]", ["masked"]);
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), [], "masked-only has zero targets in an unmasked project");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "zero targets disable save start");
    await setChecked(page, "[data-apply-image-filter]", []);
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), ["A", "B", "C", "D"], "all restores every non-hidden target");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), false, "all enables save start");
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => !state.saving && !state.applyRunning && !state.saveStarting, null, { timeout: 20000 });
    assert.deepEqual(fixture.saveRequests.find((request) => request.path === "/api/save/prepare").payload.imageIds, ["A", "B", "C", "D"]);
    assert.deepEqual(fixture.saveRequests.filter((request) => request.path === "/api/save/commit").map((request) => request.payload.imageId), ["A", "B", "C", "D"]);
    assert.equal(fixture.saveRequests.filter((request) => request.path === "/api/save/ack").length, 4, "all four saves are acknowledged successfully");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
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
