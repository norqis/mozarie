"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function freshPage(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  return { context, page };
}

test("Delete shortcut keeps a durable source-delete intent through claim and acknowledges the committed receipt", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    fixture.holdSourceDeleteClaim(true);
    ({ context, page } = await freshPage(browser, fixture));
    const card = page.locator('.gallery-item[data-id="sample"]');
    await card.click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await card.focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /元画像/, "the source delete warning identifies that the original file is deleted");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(async () => (await pendingSourceDeletes()).some((entry) => entry.imageIds?.includes("sample")));
    const pending = await page.evaluate(async () => (await pendingSourceDeletes()).find((entry) => entry.imageIds?.includes("sample")));
    assert.deepEqual(pending.browserEntries, [], "a filesystem source persists its delete intent before the server claim without a browser-handle entry");
    fixture.releaseSourceDeleteClaims();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
    await page.waitForFunction(() => !state.catalogMutation);
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [
      "/api/catalog/delete-source/prepare",
      "/api/catalog/delete-source/claim",
      "/api/catalog/delete-source",
    ], "Delete drives the ordered prepare, claim, and commit protocol");
    assert.deepEqual(fixture.sourceDeleteRequests.map(({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration }) => ({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration })), [
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
    ], "every source-delete mutation uses the same captured catalog epoch in its body and headers");
    await page.waitForFunction(async () => (await pendingSourceDeletes()).length === 0);
    assert.deepEqual(fixture.sourceDeleteOperations(), [], "acknowledgement removes the server receipt only after commit is visible to the browser");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("source-delete confirmation can be skipped, restored in settings, and cancelled without changing the preference", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page; const pageErrors = [];
  const selectSample = async () => {
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
  };
  try {
    ({ context, page } = await freshPage(browser, fixture));
    page.on("pageerror", (error) => { pageErrors.push(error.message); });
    await selectSample();
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => $("#confirmDialog").open);
    await page.locator("#confirmNeverShow").check();
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "sample") && state.settings.confirmations.removeImage === false);
    assert.equal(fixture.settingsActions.filter((action) => action.path === "/api/settings").length, 1, "accepting next-time suppression persists only the source-delete preference");

    fixture.resetScenario();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings?.confirmations.removeImage === false);
    await selectSample();
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
    assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), false, "the persisted preference skips the next source-delete modal after reload");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "skipping the modal completes source deletion without an error dialog");

    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabConfirm").click();
    await page.locator("#confirmRemoveImage").check();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.confirmations.removeImage === true);
    fixture.resetScenario();
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSample();
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => $("#confirmDialog").open);
    const settingsWritesBeforeCancel = fixture.settingsActions.length;
    await page.locator("#confirmNeverShow").check();
    await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => !$("#confirmDialog").open);
    assert.equal(fixture.settingsActions.length, settingsWritesBeforeCancel, "cancelling a checked source-delete dialog does not persist suppression");
    assert.equal(await page.evaluate(() => state.settings.confirmations.removeImage), true, "cancelling leaves source-delete confirmation enabled");
    assert.equal(await page.evaluate(() => state.images.some((image) => image.id === "sample")), true, "cancelling keeps the source image listed");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "cancelling the modal leaves no error dialog");
    assert.deepEqual(pageErrors, [], "source-delete confirmation transitions produce no page errors");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("native confirmation closes an earlier cancelled dialog without settling its immediate replacement", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.waitForFunction(() => state.settings?.confirmations);
    await page.evaluate(() => {
      state.settings.confirmations.removeImage = true;
      window.confirmationReopen = { first: undefined, second: undefined, firstCalls: 0, secondCalls: 0 };
      void confirmAction("first", "first", "removeImage", () => { window.confirmationReopen.firstCalls += 1; }).then((value) => {
        window.confirmationReopen.first = value;
      });
    });
    await page.waitForFunction(() => $("#confirmDialog").open);
    await page.locator("#confirmNeverShow").check();
    const afterNativeClose = await page.evaluate(async () => {
      const dialog = $("#confirmDialog");
      const oldClose = new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
      $("#confirmCancel").click();
      void confirmAction("second", "second", "removeImage", () => { window.confirmationReopen.secondCalls += 1; }).then((value) => {
        window.confirmationReopen.second = value;
      });
      await oldClose;
      await Promise.resolve();
      return {
        first: window.confirmationReopen.first,
        second: window.confirmationReopen.second,
        open: dialog.open,
        title: $("#confirmTitle").textContent,
      };
    });
    assert.deepEqual(afterNativeClose, { first: false, second: undefined, open: true, title: "second" }, "the observed native close leaves the immediate replacement pending");
    assert.deepEqual(await page.evaluate(() => ({
      first: window.confirmationReopen.first,
      second: window.confirmationReopen.second,
      firstCalls: window.confirmationReopen.firstCalls,
      secondCalls: window.confirmationReopen.secondCalls,
      neverShow: $("#confirmNeverShow").checked,
      enabled: state.settings.confirmations.removeImage,
    })), {
      first: false, second: undefined, firstCalls: 0, secondCalls: 0, neverShow: false, enabled: true,
    }, "the native close event settles only the cancelled action and resets its unchecked preference state");
    const settingsPayloadsBeforeAccept = fixture.settingsPayloads.length;
    const currentSettingsWrite = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings"
      && new URL(response.url()).search === "?status=0" && response.request().method() === "POST");
    await page.locator("#confirmNeverShow").check();
    await page.locator("#confirmAccept").click();
    await currentSettingsWrite;
    await page.waitForFunction(() => window.confirmationReopen.second === true && !$("#confirmDialog").open);
    assert.deepEqual(await page.evaluate(() => ({
      first: window.confirmationReopen.first,
      second: window.confirmationReopen.second,
      firstCalls: window.confirmationReopen.firstCalls,
      secondCalls: window.confirmationReopen.secondCalls,
      enabled: state.settings.confirmations.removeImage,
    })), {
      first: false, second: true, firstCalls: 0, secondCalls: 1, enabled: false,
    }, "only the current accepted dialog invokes its callback once and saves its own checkbox");
    assert.equal(fixture.settingsPayloads.length, settingsPayloadsBeforeAccept + 1, "only the current accepted confirmation writes settings");
    assert.equal(fixture.settingsPayloads.at(-1).body.confirmations.removeImage, false, "the current accepted checkbox is the only persisted confirmation value");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("source delete can reopen immediately after cancel and commits only the current confirmation", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => { state.settings.confirmations.removeImage = true; });
    const settingsWritesBefore = fixture.settingsActions.length;
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => $("#confirmDialog").open);
    await page.locator("#confirmNeverShow").check();
    await page.evaluate(async () => {
      const dialog = $("#confirmDialog");
      const oldClose = new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
      $("#confirmCancel").click();
      $("#removeAndNextButton").click();
      await oldClose;
      await Promise.resolve();
    });
    await page.waitForFunction(() => $("#confirmDialog").open && $("#confirmNeverShow").checked === false);
    assert.equal(fixture.sourceDeleteRequests.length, 0, "the cancelled source-delete action never starts its protocol before the current confirmation");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "sample") && !state.catalogMutation);
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [
      "/api/catalog/delete-source/prepare",
      "/api/catalog/delete-source/claim",
      "/api/catalog/delete-source",
    ], "the immediate reopen commits one public source deletion after its own confirmation");
    assert.equal(fixture.settingsActions.length, settingsWritesBefore, "cancelling a checked first dialog and accepting an unchecked replacement does not change confirmation settings");
    assert.equal(await page.evaluate(() => state.settings.confirmations.removeImage), true, "the source-delete preference remains enabled after the replacement confirmation");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("unknown browser-source deletion remains recoverable instead of silently committing or cancelling", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    const token = "00000000-0000-4000-8000-000000000001";
    fixture.setSourceDeleteOperation(token, {
      state: "claimed",
      imageIds: ["sample-two"],
      preparedSourceKinds: { "sample-two": "session" },
    });
    await page.evaluate(async (deleteToken) => {
      await rememberPendingSourceDelete({
        deleteToken,
        imageIds: ["sample-two"],
        browserDeletedImageIds: [],
        browserEntries: [{ imageId: "sample-two", name: "sample-two.png", state: "unknown", fileHandle: {}, parentHandle: {} }],
      });
      await resumePendingSourceDeletes();
    }, token);
    assert.deepEqual(await page.evaluate(async () => (await pendingSourceDeletes()).map((entry) => ({ token: entry.deleteToken, state: entry.browserEntries[0]?.state }))), [{ token, state: "unknown" }], "an indeterminate browser deletion remains durable for a later recovery attempt");
    assert.equal(fixture.sourceDeleteOperations()[0]?.[1]?.state, "claimed", "the server receipt stays claimed while the browser source outcome is unknown");
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [], "unknown browser deletion never commits a source removal");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("batch source deletion keeps the current canvas when another selected image fails, then moves only after the current image commits", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const catalogue = ["first", "current", "last"].map((id) => ({
    id, relativePath: `${id}.png`, sourceKind: "filesystem", sourcePath: `G:\\fixture\\${id}.png`,
    width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false,
  }));
  async function removeSelected(page, ids) {
    await page.locator("#overviewButton").click();
    await page.locator("#batchModeButton").click();
    for (const id of ids) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
  }
  let context; let page;
  try {
    fixture.setCatalog(catalogue);
    fixture.setSourceDeleteCommitFailureIds(["current"]);
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="current"]').click();
    await page.waitForFunction(() => state.currentId === "current" && state.currentImage);
    await removeSelected(page, ["current", "last"]);
    await page.waitForFunction(() => state.images.map((image) => image.id).join(",") === "first,current");
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, hasCanvas: Boolean(state.currentImage), ids: state.images.map((image) => image.id) })), {
      currentId: "current", hasCanvas: true, ids: ["first", "current"],
    }, "a failed current source deletion keeps the selected image and canvas while another selected image is removed");
    await context.close(); context = null;

    fixture.setCatalog(catalogue);
    fixture.setSourceDeleteCommitFailureIds(["first"]);
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="current"]').click();
    await page.waitForFunction(() => state.currentId === "current" && state.currentImage);
    await removeSelected(page, ["first", "current"]);
    await page.waitForFunction(() => state.images.map((image) => image.id).join(",") === "first,last" && state.currentId === "last" && state.currentImage);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["first", "last"], "the failed peer stays listed while the committed current image is removed");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("visible delete control selects next for first and middle, previous for last, and clears every view after an all-image batch", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const catalogue = ["first", "middle", "last"].map((id) => ({
    id, relativePath: `${id}.png`, sourceKind: "filesystem", sourcePath: `G:\\fixture\\${id}.png`,
    width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false,
  }));
  let context; let page;
  async function resetPage() {
    await context?.close(); context = null;
    fixture.setCatalog(catalogue); fixture.setSourceDeleteCommitFailureIds([]);
    ({ context, page } = await freshPage(browser, fixture));
  }
  async function deleteCurrent(id) {
    await page.locator(`.gallery-item[data-id="${id}"]`).click();
    await page.waitForFunction((imageId) => state.currentId === imageId && state.currentImage, id);
    await page.locator("#removeAndNextButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
  }
  try {
    await resetPage();
    await deleteCurrent("first");
    await page.waitForFunction(() => state.currentId === "middle" && state.images.map((image) => image.id).join(",") === "middle,last");

    await resetPage();
    await deleteCurrent("middle");
    await page.waitForFunction(() => state.currentId === "last" && state.images.map((image) => image.id).join(",") === "first,last");

    await resetPage();
    await deleteCurrent("last");
    await page.waitForFunction(() => state.currentId === "middle" && state.images.map((image) => image.id).join(",") === "first,middle");

    await resetPage();
    await page.locator("#overviewButton").click();
    await page.locator("#batchModeButton").click();
    for (const id of ["first", "middle", "last"]) await page.locator(`.overview-item[data-id="${id}"]`).click();
    await page.locator("#selectionActionsButton").click();
    await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.images.length === 0 && state.currentId === null && state.currentImage === null);
    assert.equal(await page.locator("#overviewEmptyState").isHidden(), false, "the visible overview reports that an all-image deletion has no entries left");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});
