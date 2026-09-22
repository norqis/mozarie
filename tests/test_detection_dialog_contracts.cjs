"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function withPage(run) {
  const fixture = await startFixtureServer();
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
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await run(page, fixture);
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

async function selectFirst(page) {
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && Boolean(state.currentImage));
}

test("individual detection settings save all shared options without changing batch filters or parallelism", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    const before = await page.evaluate(() => structuredClone(state.settings.detection));
    await page.locator("#detectionSettingsButton").click();
    assert.equal(await page.locator("#detectDialogTitle").textContent(), "検出設定");
    assert.equal(await page.locator("#detectStartButton").textContent(), "保存");
    for (const selector of ["#detectTargetCount", "#detectParallelismRow", "#detectImageFilters"]) assert.equal(await page.locator(selector).isVisible(), false);
    await page.locator("#detectConfidenceNumber").fill("0.64");
    await page.locator("label.target-chip:has(#dialogTargetPussy)").click();
    await page.locator("#detectCandidatePadding").fill("7");
    await page.locator("#detectExcludeCandidatePadding").fill("15");
    await page.locator("#detectFluidColorFillTolerance").fill("41");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    assert.equal(await page.locator("#detectFluidColorFillTolerance").isDisabled(), true);
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    assert.equal(fixture.detectRequests.length, 0);
    const saved = fixture.settingsPayloads.at(-1).body.detection;
    assert.equal(saved.threshold, 0.64);
    assert.deepEqual(saved.targets, ["penis"]);
    assert.equal(saved.default_candidate_padding_px, 7);
    assert.equal(saved.default_exclude_candidate_padding_px, 15);
    assert.equal(saved.fluid_color_fill_enabled, false);
    assert.equal(saved.fluid_color_fill_tolerance, 41);
    assert.equal(saved.parallelism, before.parallelism);
    assert.deepEqual(saved.image_filters, before.image_filters);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await selectFirst(page);
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.job?.kind === "detect");
    assert.deepEqual(fixture.detectRequests.at(-1), { imageIds: ["sample"], confidence: 0.64, parallelism: 1, targetClasses: ["penis"], fluidColorFillEnabled: false, fluidColorFillTolerance: 41 });
    await page.waitForFunction(() => !state.processing && !isBusy());
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectParallelismRow").isVisible(), true);
    assert.equal(await page.locator("#detectImageFilters").isVisible(), true);
    assert.equal(await page.locator("#detectConfidenceNumber").inputValue(), "0.64");
    assert.equal(await page.locator("#detectCandidatePadding").inputValue(), "7");
    assert.equal(await page.locator("#detectExcludeCandidatePadding").inputValue(), "15");
    await page.locator("#detectCancelButton").click();
  });
});

test("cancelled detection drafts never change current-image or general settings and failed saves stay open", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    const before = await page.evaluate(() => structuredClone(state.settings.detection));
    for (const opener of ["#detectionSettingsButton", "#detectAllButton"]) {
      await page.locator(opener).click();
      await page.locator("#detectConfidenceNumber").fill("0.92");
      await page.locator("label.target-chip:has(#dialogTargetPussy)").click();
      await page.locator("label.target-chip:has(#dialogTargetPenis)").click();
      await page.locator("#detectCandidatePadding").fill("22");
      await page.locator("#detectFluidColorFillTolerance").fill("82");
      await page.locator("#detectCancelButton").click();
      assert.deepEqual(await page.evaluate(() => state.settings.detection), before);
      assert.equal(await page.evaluate(() => settingsPayload().detection.threshold), before.threshold);
      assert.deepEqual(await page.evaluate(() => settingsPayload().detection.targets), before.targets);
    }
    await page.locator("#settingsButton").click();
    await page.locator("#settingsImportParallelism").fill("6");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.importing.parallelism === 6);
    assert.deepEqual(fixture.settingsPayloads.at(-1).body.detection.targets, before.targets, "cancelled empty detection targets never block a general settings save");
    await page.locator("#settingsCloseButton").click();
    await page.locator("#detectionSettingsButton").click();
    assert.equal(await page.locator("#detectConfidenceNumber").inputValue(), before.threshold.toFixed(2));
    assert.equal(await page.locator("#detectCandidatePadding").inputValue(), String(before.default_candidate_padding_px));
    await page.locator("#detectConfidenceNumber").fill("0.66");
    fixture.failNextSettingsSave();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#detectDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#detectConfidenceNumber").inputValue(), "0.66");
    assert.deepEqual(await page.evaluate(() => state.settings.detection), before);
    assert.equal(fixture.detectRequests.length, 0);
    await page.locator("#errorDialogClose").click();
    await page.locator("#detectCancelButton").click();
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.job?.kind === "detect");
    assert.equal(fixture.detectRequests.at(-1).confidence, before.threshold);
    assert.deepEqual(fixture.detectRequests.at(-1).targetClasses, before.targets);
  });
});

test("SD-049 editor confidence slider keeps display and request value identical", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    await page.locator("#detectionSettingsButton").click();
    await page.locator("#detectConfidenceRange").evaluate((input) => { input.value = "0.61"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.locator("#detectConfidenceNumber").inputValue(), "0.61");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.equal(fixture.detectRequests.at(-1).confidence, 0.61);
  });
});

test("SD-050 all-image confidence number synchronizes the slider and start request", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.locator("#detectConfidenceNumber").fill("0.73");
    await page.locator("#detectConfidenceNumber").dispatchEvent("input");
    assert.equal(await page.locator("#detectConfidenceRange").inputValue(), "0.73");
    await page.evaluate(() => startDetectionFromDialog({ preventDefault() {} }));
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.equal(fixture.detectRequests.at(-1).confidence, 0.73);
  });
});

test("SD-052 current-image detection targets only the selected image and restores editing", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    await page.locator("#detectCurrentButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    assert.deepEqual(fixture.detectRequests.at(-1).imageIds, ["sample"]);
    await page.waitForFunction(() => !state.processing && !isBusy());
    assert.equal(await page.locator("#editorCanvas").isEnabled(), true);
  });
});

test("SD-053 all-image dialog counts only processable non-hidden images before start", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.evaluate(() => { state.images[1].hidden = true; state.hiddenImageIds.add(state.images[1].id); renderCatalogViews(); updateActionButtons(); });
    const before = fixture.detectRequests.length;
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.match(await page.locator("#detectTargetCount").textContent(), /1/);
    assert.equal(fixture.detectRequests.length, before);
  });
});

test("SD-054 cancelling the all-image dialog starts no detection", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    const before = fixture.detectRequests.length;
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCancelButton").click();
    await page.waitForFunction(() => !document.querySelector("#detectDialog").open);
    assert.equal(fixture.detectRequests.length, before);
    assert.equal(await page.evaluate(() => state.processing), null);
  });
});

function targetSelectionContract(penis, pussy, targets) {
  return async () => {
    await withPage(async (page, fixture) => {
      await page.locator("#detectAllButton").click();
      await page.evaluate(({ penis, pussy }) => {
        for (const [id, checked] of [["dialogTargetPenis", penis], ["dialogTargetPussy", pussy]]) {
          const input = document.getElementById(id); input.checked = checked; input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, { penis, pussy });
      await page.locator("#detectStartButton").click();
      await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
      assert.deepEqual(fixture.detectRequests.at(-1).targetClasses, targets);
    });
  };
}

test("SD-020 penis-only detection sends no unselected target class", { timeout: 60000 }, targetSelectionContract(true, false, ["penis"]));
test("SD-021 pussy-only detection sends no unselected target class", { timeout: 60000 }, targetSelectionContract(false, true, ["pussy"]));
test("SD-022 both-target detection sends both selected target classes", { timeout: 60000 }, targetSelectionContract(true, true, ["penis", "pussy"]));

test("SD-023 detection rejects an empty target selection without creating candidates", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.evaluate(() => {
      for (const id of ["dialogTargetPenis", "dialogTargetPussy"]) { const input = document.getElementById(id); input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    const before = fixture.detectRequests.length;
    await page.evaluate(() => startDetectionFromDialog({ preventDefault() {} }));
    assert.equal(fixture.detectRequests.length, before);
    assert.equal(await page.locator("#detectTargetValidation").isVisible(), true);
    assert.equal(await page.evaluate(() => state.images.every((image) => !(image.candidates || []).length)), true);
  });
});

test("SD-127 detection dialog persists distinct apply and exclusion padding", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCandidatePadding").fill("3");
    await page.locator("#detectExcludeCandidatePadding").fill("11");
    assert.deepEqual(await page.locator("#detectForm").evaluate(() => [
      document.querySelector("#detectCandidatePadding").value,
      document.querySelector("#detectExcludeCandidatePadding").value,
    ]), ["3", "11"]);
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    const detection = fixture.settingsPayloads.at(-1).body.detection;
    assert.equal(detection.default_candidate_padding_px, 3);
    assert.equal(detection.default_exclude_candidate_padding_px, 11);
    await page.waitForFunction(() => !state.processing && !isBusy());
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectCandidatePadding").inputValue(), "3");
    assert.equal(await page.locator("#detectExcludeCandidatePadding").inputValue(), "11");
  });
});

test("SD-131 invalid padding blocks detection while zero remains valid", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    const before = fixture.detectRequests.length;
    for (const invalid of ["-1", "1.5", ""]) {
      await page.locator("#detectCandidatePadding").fill(invalid);
      await page.evaluate(() => startDetectionFromDialog({ preventDefault() {} }));
      assert.equal(fixture.detectRequests.length, before);
      assert.equal(await page.locator("#detectCandidatePadding").getAttribute("aria-invalid"), "true");
    }
    await page.locator("#detectCandidatePadding").fill("0");
    await page.locator("#detectExcludeCandidatePadding").fill("0");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => state.processing?.kind === "detect" || state.job?.kind === "detect");
    const detection = fixture.settingsPayloads.at(-1).body.detection;
    assert.equal(detection.default_candidate_padding_px, 0);
    assert.equal(detection.default_exclude_candidate_padding_px, 0);
  });
});

test("SD-128 current-image run uses the saved apply and exclusion padding for only the current image", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await selectFirst(page);
    assert.deepEqual(await page.evaluate(() => [
      state.settings.detection.default_candidate_padding_px,
      state.settings.detection.default_exclude_candidate_padding_px,
    ]), [3, 11]);
    const request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    await page.locator("#detectCurrentButton").click();
    assert.deepEqual(JSON.parse((await request).postData()).imageIds, ["sample"]);
    assert.equal(fixture.detectRequests.length, 1);
  });
});

test("SD-129 selected-image run uses the saved apply and exclusion padding for only the selection", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    assert.deepEqual(await page.evaluate(() => [
      state.settings.detection.default_candidate_padding_px,
      state.settings.detection.default_exclude_candidate_padding_px,
    ]), [3, 11]);
    await page.evaluate(() => setViewMode("overview"));
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="detect"]').click();
    assert.deepEqual(await page.locator("#detectForm").evaluate(() => [
      document.querySelector("#detectCandidatePadding").value,
      document.querySelector("#detectExcludeCandidatePadding").value,
    ]), ["3", "11"]);
    const request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await request).postData()).imageIds, ["sample-two"]);
  });
});

test("SD-130 all-image run persists and uses the dialog apply and exclusion padding for every visible image", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCandidatePadding").fill("5");
    await page.locator("#detectExcludeCandidatePadding").fill("13");
    const request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await request).postData()).imageIds, ["sample", "sample-two"]);
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.default_candidate_padding_px, 5);
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.default_exclude_candidate_padding_px, 13);
  });
});

test("SD-131 zero padding runs all current and selected routes without substituting a nonzero value", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCandidatePadding").fill("0");
    await page.locator("#detectExcludeCandidatePadding").fill("0");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => !state.processing && !isBusy());
    assert.deepEqual([
      fixture.settingsPayloads.at(-1).body.detection.default_candidate_padding_px,
      fixture.settingsPayloads.at(-1).body.detection.default_exclude_candidate_padding_px,
    ], [0, 0]);

    await selectFirst(page);
    let request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    await page.locator("#detectCurrentButton").click();
    assert.deepEqual(JSON.parse((await request).postData()).imageIds, ["sample"]);
    await page.waitForFunction(() => !state.processing && !isBusy());

    await page.evaluate(() => setViewMode("overview"));
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="detect"]').click();
    assert.deepEqual(await page.locator("#detectForm").evaluate(() => [
      document.querySelector("#detectCandidatePadding").value,
      document.querySelector("#detectExcludeCandidatePadding").value,
    ]), ["0", "0"]);
    request = page.waitForRequest((item) => new URL(item.url()).pathname === "/api/detect" && item.method() === "POST");
    await page.locator("#detectStartButton").click();
    assert.deepEqual(JSON.parse((await request).postData()).imageIds, ["sample-two"]);
    assert.equal(fixture.detectRequests.length, 3);
  });
});
