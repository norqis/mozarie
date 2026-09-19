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
    fixture.holdSourceDeletePrepare(true);
    fixture.holdSourceDeleteClaim(true);
    ({ context, page } = await freshPage(browser, fixture));
    const card = page.locator('.gallery-item[data-id="sample"]');
    await card.click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await card.focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(
      await page.locator("#confirmMessage").textContent(),
      "元画像、候補、手描き、履歴、確認・非表示の状態を完全に削除します。元に戻せません。同じ元画像を使う他のプロジェクトでは画像が不足する場合があります。",
      "the source delete warning names every deleted durable state, irreversibility, and the shared-source project consequence",
    );
    const singleDeleteColor = await page.locator("#removeAndNextButton").evaluate((button) => getComputedStyle(button).backgroundColor.match(/\d+/g).map(Number));
    assert.equal(singleDeleteColor[0] > singleDeleteColor[1] * 1.5 && singleDeleteColor[0] > singleDeleteColor[2] * 1.5, true, "the rendered single source-delete control is visibly red");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(async () => (await pendingSourceDeletes()).some((entry) => entry.imageIds?.includes("sample") && entry.state === "preparing"));
    for (let attempt = 0; attempt < 100 && !fixture.sourceDeleteRequests.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fixture.sourceDeleteRequests[0]?.path, "/api/catalog/delete-source/prepare", "the preparing token is already durable while the prepare response is still pending");
    fixture.releaseSourceDeletePrepares();
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
      "/api/catalog/delete-source/ack",
    ], "Delete drives the ordered prepare, claim, and commit protocol");
    assert.deepEqual(fixture.sourceDeleteRequests.slice(0, 3).map(({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration }) => ({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration })), [
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
    await page.waitForFunction(() => state.settings?.confirmations && state.images.length > 0);
    page.on("pageerror", (error) => { pageErrors.push(error.message); });
    await selectSample();
    const workBeforeCancel = await page.evaluate(() => ({
      images: structuredClone(state.images),
      currentId: state.currentId,
      currentImage: Boolean(state.currentImage),
      candidates: structuredClone(state.candidates),
      removedCandidateIds: [...state.removedCandidateIds],
      manual: {
        add: state.manualMaskPresent,
        exclusion: state.manualExclusionPresent,
        erase: state.manualExclusionErasePresent,
      },
      canUndo: state.canUndo,
      canRedo: state.canRedo,
    }));
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
    assert.deepEqual(await page.evaluate(() => ({
      images: structuredClone(state.images),
      currentId: state.currentId,
      currentImage: Boolean(state.currentImage),
      candidates: structuredClone(state.candidates),
      removedCandidateIds: [...state.removedCandidateIds],
      manual: {
        add: state.manualMaskPresent,
        exclusion: state.manualExclusionPresent,
        erase: state.manualExclusionErasePresent,
      },
      canUndo: state.canUndo,
      canRedo: state.canRedo,
    })), workBeforeCancel, "cancelling preserves the complete selected-image work state");
    assert.equal(fixture.sourceDeleteRequests.length, 0, "cancelling never contacts a source-delete route, so the original source cannot be removed");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "cancelling the modal leaves no error dialog");
    assert.deepEqual(pageErrors, [], "source-delete confirmation transitions produce no page errors");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("confirmation accept starts source permission inside the actual click callback before close or draft work", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.waitForFunction(() => state.settings?.confirmations && state.images.length > 0);
    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "sample-two");
      window.permissionOrder = [];
      const fileHandle = { name: "sample-two.png" };
      const parentHandle = { requestPermission() { window.permissionOrder.push("permission"); return Promise.resolve("granted"); } };
      state.sourceAccess.set(image.id, { fileHandle, parentHandle });
      document.querySelector("#confirmDialog").addEventListener("close", () => window.permissionOrder.push("close"), { once: true });
      window.permissionConfirmation = confirmAction("delete", "delete", "removeImage", () => {
        window.permissionOrder.push("accept-callback");
        window.permissionResolver = beginBrowserDeletePermissionRequests([image]);
      }).then(async (accepted) => {
        window.permissionOrder.push("after-confirm");
        await Promise.resolve(); window.permissionOrder.push("draft-work");
        return accepted;
      });
    });
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => window.permissionOrder.includes("draft-work"));
    const order = await page.evaluate(() => window.permissionOrder);
    assert.equal(order.indexOf("permission") > -1, true);
    assert.equal(order.indexOf("permission") < order.indexOf("close"), true, `permission starts before dialog close: ${order}`);
    assert.equal(order.indexOf("permission") < order.indexOf("draft-work"), true, `permission starts before later draft work: ${order}`);
  } finally { await context?.close(); await browser.close(); await closeServer(fixture.server); }
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
      "/api/catalog/delete-source/ack",
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
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [
      "/api/catalog/delete-source/status",
      "/api/catalog/delete-source/status",
    ], "unknown browser deletion performs status reconciliation without commit, cancel, or acknowledgement");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("zero-target prepared source delete cancels, rechecks status, acknowledges, and removes IndexedDB intent", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    fixture.setSourceDeletePrepareEmpty(true);
    ({ context, page } = await freshPage(browser, fixture));
    await page.waitForFunction(() => state.settings?.confirmations && state.images.length > 0);
    await page.evaluate(async () => {
      state.settings.confirmations.removeImage = false;
      const image = state.images.find((item) => item.id === "sample");
      await permanentlyDeleteImages([image], state.images);
    });
    assert.deepEqual(await page.evaluate(async () => (await pendingSourceDeletes()).map((entry) => entry.deleteToken)), [], "terminal ack removes the zero-target operation from real IndexedDB");
    assert.deepEqual(fixture.sourceDeleteOperations(), [], "server receipt is acknowledged after cancel and status");
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [
      "/api/catalog/delete-source/prepare",
      "/api/catalog/delete-source/claim",
      "/api/catalog/delete-source/release",
      "/api/catalog/delete-source/cancel",
      "/api/catalog/delete-source/status",
      "/api/catalog/delete-source/ack",
    ], "the zero-target operation follows release then the exact cancel, status, acknowledgement protocol without committing");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("browser-only source preflight failures stay in console and never reach server prepare", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page; const warnings = [];
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.waitForFunction(() => state.settings?.confirmations && state.images.length > 0);
    page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
    await page.evaluate(async () => {
      state.settings.confirmations.removeImage = false;
      const image = state.images.find((item) => item.id === "sample-two");
      await permanentlyDeleteImages([image], state.images);
    });
    assert.equal(fixture.sourceDeleteRequests.length, 0, "a browser preflight rejection never reaches prepare");
    assert.deepEqual(await page.evaluate(async () => (await pendingSourceDeletes()).map((entry) => entry.deleteToken)), [], "the pre-prepare browser rejection removes its preparing intent from real IndexedDB");
    assert.equal(warnings.some((line) => line.includes("成功=0") && line.includes("sample-two") && line.includes("source_action_unavailable")), true, "the browser console records the image and preflight reason");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
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
    const batchDeleteColor = await page.locator('[data-selection-action="remove"]').evaluate((button) => getComputedStyle(button).backgroundColor.match(/\d+/g).map(Number));
    assert.equal(batchDeleteColor[0] > batchDeleteColor[1] * 1.5 && batchDeleteColor[0] > batchDeleteColor[2] * 1.5, true, "the rendered batch source-delete control is visibly red");
    await page.locator('[data-selection-action="remove"]').click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
  }
  let context; let page;
  try {
    fixture.setCatalog(catalogue);
    fixture.setSourceDeleteCommitFailureIds(["current"]);
    fixture.setSourceDeleteCleanupPendingCount(2);
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="current"]').click();
    await page.waitForFunction(() => state.currentId === "current" && state.currentImage);
    await removeSelected(page, ["current", "last"]);
    await page.waitForFunction(() => state.images.map((image) => image.id).join(",") === "first,current");
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, hasCanvas: Boolean(state.currentImage), ids: state.images.map((image) => image.id) })), {
      currentId: "current", hasCanvas: true, ids: ["first", "current"],
    }, "a failed current source deletion keeps the selected image and canvas while another selected image is removed");
    assert.equal(await page.evaluate(() => state.status.message), "元画像を1件削除しました。失敗1件: current: source_changed 元画像ファイルの後処理2件を再試行します。", "the visible result reports exact removed/failed counts, first reason, and a separate cleanup-pending count");
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
