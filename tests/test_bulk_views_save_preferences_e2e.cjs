const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function waitForEditor(page, imageId) {
  await page.locator(`.gallery-item[data-id="${imageId}"]`).click();
  await page.waitForFunction((id) => state.currentId === id && state.currentImage && !state.pendingImageId, imageId);
}

async function holdOutputDirectorySettingsResponse(page) {
  let responseCaptured;
  let releaseResponse;
  const responseHeld = new Promise((resolve) => { responseCaptured = resolve; });
  const release = new Promise((resolve) => { releaseResponse = resolve; });
  const pattern = /\/api\/settings\?status=0$/;
  const handler = async (route) => {
    const response = await route.fetch();
    responseCaptured();
    await release;
    await route.fulfill({ response });
  };
  await page.route(pattern, handler);
  return {
    waitForResponse: () => responseHeld,
    release: () => releaseResponse(),
    stop: () => page.unroute(pattern, handler),
  };
}

async function main() {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
      window.__bulkSaveApi = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0]; const init = args[1] || {};
        const url = String(input?.url || input);
        const method = init.method || input?.method || "GET";
        const body = init.body || "";
        window.__bulkSaveApi.push({ url, method, body });
        const response = await originalFetch(...args);
        return response;
      };
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2 && state.serverCatalogGeneration !== null);

    await waitForEditor(page, "sample");
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const sourceCanvas = document.createElement("canvas"); sourceCanvas.width = sourceCanvas.height = 2;
      const sourceContext = sourceCanvas.getContext("2d"); sourceContext.fillStyle = "#010203"; sourceContext.fillRect(0, 0, 2, 2);
      const sourceBytes = new Uint8Array(await (await new Promise((resolve) => sourceCanvas.toBlob(resolve, "image/png"))).arrayBuffer());
      const removedFileHandle = await root.getFileHandle("removed-source.png", { create: true });
      const removedWriter = await removedFileHandle.createWritable();
      await removedWriter.write(sourceBytes);
      await removedWriter.close();
      const fileHandle = await root.getFileHandle("remaining-source.png", { create: true });
      const writer = await fileHandle.createWritable();
      await writer.write(sourceBytes);
      await writer.close();
      window.__remainingSourceBytes = [...sourceBytes];
      window.__removedSourceFile = removedFileHandle;
      state.sourceAccess.set("sample", { fileHandle: removedFileHandle, parentHandle: root, sourceKind: "browser-files", sourceId: "opfs-root" });
      state.sourceAccess.set("sample-two", { fileHandle, parentHandle: root, sourceKind: "browser-files", sourceId: "opfs-root" });
      state.projectlessDirectorySources.set("opfs-root", { handle: root, imageIds: new Set(["sample", "sample-two"]) });
      state.drafts.set("sample-two", { add: "", exclusion: "", exclusionErase: "", manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, removedCandidateIds: [] });
    });

    // Seed candidate records only as the fixture's initial backend data, then
    // exercise every display state through the visible batch controls.
    await page.evaluate(() => {
      state.candidates = [
        { id: "apply-one", role: "apply", enabled: true, forced: false, labelToken: "penis", confidence: .9, color: "#ff3d4d" },
        { id: "apply-two", role: "apply", enabled: true, forced: false, labelToken: "pussy", confidence: .8, color: "#ff3d4d" },
        { id: "exclude-one", role: "exclude", enabled: true, forced: true, labelToken: "hand", confidence: .8, color: "#28d3ff" },
      ];
      renderCandidates();
    });
    const normalApply = page.locator('[data-candidate-display-toggle="apply"]');
    const effectiveApply = page.locator('[data-candidate-effective-toggle="apply"]');
    const normalExclude = page.locator('[data-candidate-display-toggle="exclude"]');
    const effectiveExclude = page.locator('[data-candidate-effective-toggle="exclude"]');
    for (const control of [normalApply, effectiveApply, normalExclude, effectiveExclude]) {
      assert.equal(await control.isDisabled(), false, "candidate display controls are enabled for a selected image");
    }
    await normalApply.click();
    await page.waitForFunction(() => document.querySelector('[data-candidate-display-toggle="apply"]')?.getAttribute("aria-pressed") === "true");
    assert.equal(await normalApply.evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(35, 82, 66)", "normal display ON is visibly green");
    await effectiveApply.click();
    await page.waitForFunction(() => document.querySelector('[data-candidate-display-toggle="apply"]')?.getAttribute("aria-pressed") === "false"
      && document.querySelector('[data-candidate-effective-toggle="apply"]')?.getAttribute("aria-pressed") === "true");
    await effectiveApply.click();
    await page.waitForFunction(() => document.querySelector('[data-candidate-effective-toggle="apply"]')?.getAttribute("aria-pressed") === "false");
    await page.locator('[data-candidate-display-id="apply-one"]').click();
    await page.waitForFunction(() => document.querySelector('[data-candidate-display-toggle="apply"]')?.getAttribute("aria-pressed") === "mixed");
    await normalApply.click();
    await page.waitForFunction(() => document.querySelector('[data-candidate-display-toggle="apply"]')?.getAttribute("aria-pressed") === "true");

    await effectiveApply.click();
    assert.equal(await page.evaluate(() => state.blinkTimer !== null && state.blinkCandidateIds.size === 2), true, "one active display timer covers every enabled apply candidate");

    // The first opening initializes defaults.  Later openings must retain the
    // user's choices even when the native dialog is dismissed or a save fails.
    await page.locator("#saveButton").click();
    await page.locator("#singleSaveDialog").evaluate((dialog) => dialog.open || Promise.reject(new Error("single save did not open")));
    assert.deepEqual(await page.evaluate(() => ({ mode: document.querySelector('input[name="singleSaveMode"]:checked').value, format: $("#singleSaveOutputFormat").value, metadata: $("#singleSaveKeepMetadata").checked, remove: $("#singleSaveRemoveSaved").checked })), { mode: "copy", format: "original", metadata: true, remove: false });
    await page.locator("#singleSaveSuffix").fill("_remember");
    await page.locator("#singleSaveOutputFormat").selectOption("png");
    await page.locator("#singleSaveKeepMetadata").uncheck();
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => $("#singleSaveDialog").open);
    assert.deepEqual(await page.evaluate(() => ({ mode: document.querySelector('input[name="singleSaveMode"]:checked').value, suffix: $("#singleSaveSuffix").value, format: $("#singleSaveOutputFormat").value, metadata: $("#singleSaveKeepMetadata").checked })), { mode: "overwrite", suffix: "_remember", format: "png", metadata: false }, "single save retains overwrite, PNG, metadata, and suffix preferences");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !$("#singleSaveDialog").open);

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => $("#applyDialog").open);
    assert.equal(await page.locator("#applyRemoveSaved").isChecked(), false, "batch remove-after-save defaults off");
    await page.locator("#applyTargetMode").selectOption("all");
    await page.locator("#applyDivisor").fill("23");
    await page.locator("#applyOutputFormat").selectOption("png");
    await page.locator("#applyKeepMetadata").uncheck();
    await page.locator("#applyRemoveSaved").check();
    await page.locator("#applyCloseButton").click();
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => $("#applyDialog").open);
    assert.deepEqual(await page.evaluate(() => ({ target: $("#applyTargetMode").value, divisor: $("#applyDivisor").value, format: $("#applyOutputFormat").value, metadata: $("#applyKeepMetadata").checked, remove: $("#applyRemoveSaved").checked })), { target: "all", divisor: "23", format: "png", metadata: false, remove: true }, "batch choices persist after its first opening");
    await page.locator("#applyCloseButton").click();

    // A real settings response held after the path blur must not swallow the
    // next checkbox click. The path and save start remain locked, while local
    // save choices stay usable until the settings request completes.
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => $("#singleSaveDialog").open);
    await page.locator("#singleSaveCopyMode").check();
    const singleSettings = await holdOutputDirectorySettingsResponse(page);
    await page.locator("#singleSaveOutputDirectoryStatus").fill("G:\\fixture-output-single");
    await page.locator("#singleSaveRemoveSaved").click();
    await singleSettings.waitForResponse();
    await page.waitForFunction(() => state.outputDirectoryCommitPending);
    const singlePendingState = await page.evaluate(() => ({
      checked: $("#singleSaveRemoveSaved").checked,
      disabled: $("#singleSaveRemoveSaved").disabled,
      fieldsetDisabled: $("#singleSaveSettings").disabled,
      picking: state.outputDirectoryPicking,
      pending: state.outputDirectoryCommitPending,
      busy: isBusy(),
      busyWithoutCommit: isBusy({ ignoreOutputDirectoryCommit: true }),
    }));
    assert.equal(singlePendingState.checked, true, `single remove-after-save click survives its output-path blur: ${JSON.stringify(singlePendingState)}`);
    assert.equal(await page.locator("#singleSaveSettings").isDisabled(), false, "single local save settings remain editable while the path commit waits");
    assert.equal(await page.locator("#singleSaveOutputDirectoryStatus").isDisabled(), true, "single output path remains locked while its commit waits");
    assert.equal(await page.locator("#singleSaveChooseOutputDirectoryButton").isDisabled(), true, "single path picker remains locked while its commit waits");
    assert.equal(await page.locator("#singleSaveStartButton").isDisabled(), true, "single save start remains locked while its path commit waits");
    assert.deepEqual({ busy: singlePendingState.busy, busyWithoutCommit: singlePendingState.busyWithoutCommit }, { busy: true, busyWithoutCommit: false }, "the delayed path commit still holds the normal editor lock");
    assert.equal(await page.locator("#saveButton").isDisabled(), true, "the editor save action remains locked while its output path commits");
    singleSettings.release();
    await page.waitForFunction(() => !state.outputDirectoryCommitPending);
    await singleSettings.stop();
    assert.equal(await page.locator("#singleSaveOutputDirectoryStatus").inputValue(), "G:\\fixture-output-single", "single path commit updates the visible value after its response");
    assert.equal(await page.locator("#singleSaveStartButton").isDisabled(), false, "single save start unlocks after the path commit");
    await page.locator("#singleSaveCloseButton").click();

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => $("#applyDialog").open);
    await page.locator("#applyRemoveSaved").uncheck();
    const batchSettings = await holdOutputDirectorySettingsResponse(page);
    await page.locator("#applyOutputDirectoryStatus").fill("G:\\fixture-output-batch");
    await page.locator("#applyRemoveSaved").click();
    await batchSettings.waitForResponse();
    await page.waitForFunction(() => state.outputDirectoryCommitPending);
    assert.equal(await page.locator("#applyRemoveSaved").isChecked(), true, "batch remove-after-save click survives its output-path blur");
    assert.equal(await page.locator("#applySuffix").isDisabled(), false, "batch suffix remains editable while the path commit waits");
    assert.equal(await page.locator("#applyTargetMode").isDisabled(), false, "batch target remains editable while the path commit waits");
    await page.locator("#applySuffix").fill("_pending");
    await page.locator("#applyTargetMode").selectOption("masked");
    assert.equal(await page.locator("#applyOutputDirectoryStatus").isDisabled(), true, "batch output path remains locked while its commit waits");
    assert.equal(await page.locator("#chooseOutputDirectoryButton").isDisabled(), true, "batch path picker remains locked while its commit waits");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "batch save start remains locked while its path commit waits");
    batchSettings.release();
    await page.waitForFunction(() => !state.outputDirectoryCommitPending);
    await batchSettings.stop();
    assert.deepEqual(await page.evaluate(() => ({ path: $("#applyOutputDirectoryStatus").value, suffix: $("#applySuffix").value, target: $("#applyTargetMode").value, remove: $("#applyRemoveSaved").checked })), { path: "G:\\fixture-output-batch", suffix: "_pending", target: "masked", remove: true }, "batch path response preserves choices changed while it waited");
    await page.locator("#applyTargetMode").selectOption("all");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), false, "batch save start unlocks after the path commit");
    await page.locator("#applyCloseButton").click();

    // Copy save successfully commits before it removes only the saved entry.
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => $("#singleSaveDialog").open);
    await page.locator("#singleSaveCopyMode").check();
    await page.locator("#singleSaveRemoveSaved").check();
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => !state.saving && state.images.length === 1, null, { timeout: 8000 });
    assert.deepEqual(fixture.catalogRemoveRequests, [["sample"]], "only the successfully committed single-save image is removed from the catalog");
    assert.equal(await page.evaluate(async () => {
      const access = state.sourceAccess.get("sample-two");
      const root = state.projectlessDirectorySources.get("opfs-root");
      const file = await access?.fileHandle?.getFile();
      return Boolean(access?.fileHandle && root?.handle && root.imageIds.has("sample-two") && state.drafts.has("sample-two")
        && JSON.stringify([...new Uint8Array(await file.arrayBuffer())]) === JSON.stringify(window.__remainingSourceBytes));
    }), true, "removing one projectless item preserves the remaining OPFS handle, directory root, and draft");
    assert.equal(await page.evaluate(async () => {
      const bytes = new Uint8Array(await (await window.__removedSourceFile.getFile()).arrayBuffer());
      return !state.sourceAccess.has("sample") && JSON.stringify([...bytes]) === JSON.stringify(window.__remainingSourceBytes);
    }), true, "copy-save removal forgets only the catalog binding and leaves its real source file unchanged");

    await page.locator("#singleSaveCloseButton").click();
    await page.waitForFunction(() => !$("#singleSaveDialog").open);
    await waitForEditor(page, "sample-two");
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => $("#singleSaveDialog").open);
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveRemoveSaved").uncheck();
    await page.locator("#singleSaveOutputFormat").selectOption("original");
    await page.evaluate(() => { state.settings.confirmations.overwriteSource = true; });
    const commitsBeforeOverwrite = fixture.saveRequests.filter((request) => request.path === "/api/save/commit").length;
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => $("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !$("#confirmDialog").open, null, { timeout: 8000 });
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "overwrite must not leave an error dialog open");
    assert.equal(fixture.saveRequests.filter((request) => request.path === "/api/save/commit").length, commitsBeforeOverwrite + 1, "overwrite reaches the durable commit before its source bytes are observed");
    assert.equal(await page.evaluate(async () => {
      const bytes = new Uint8Array(await (await state.sourceAccess.get("sample-two").fileHandle.getFile()).arrayBuffer());
      return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
        && JSON.stringify([...bytes]) !== JSON.stringify(window.__remainingSourceBytes);
    }), true, "the surviving real OPFS file handle remains usable for an actual PNG overwrite save");
    assert.deepEqual(fixture.catalogImageIds(), ["sample-two"], "overwrite with remove-after-save off leaves the catalog entry in place");
    await page.locator("#singleSaveCloseButton").click();
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => $("#singleSaveDialog").open);
    assert.deepEqual(await page.evaluate(() => ({
      mode: document.querySelector('input[name="singleSaveMode"]:checked').value,
      format: $("#singleSaveOutputFormat").value,
      remove: $("#singleSaveRemoveSaved").checked,
    })), { mode: "overwrite", format: "original", remove: false }, "successful overwrite retains the next save dialog's choices");
    const removeRequest = await page.evaluate(() => window.__bulkSaveApi.find((request) => request.url.includes("/api/catalog/remove")));
    assert.match(removeRequest.body, /"expectedCatalogGeneration"/, "catalog removal carries the selected catalog generation");
  } finally {
    await context.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

if (require.main === module) nodeTest("bulk displays and save preferences in Chromium", { timeout: 60000 }, main);

module.exports = { main };
