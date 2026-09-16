const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

const lockExceptions = new Set([
  "applyPauseButton", "applyCancelButton", "processingPauseButton", "processingCancelButton", "errorDialogClose",
]);

async function withFixture(body) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await body({ fixture, page });
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
}

async function openSample(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
}

async function seedCandidateUi(page) {
  await page.evaluate(() => {
    const image = currentRecord();
    const mask = document.createElement("canvas");
    mask.width = image.width; mask.height = image.height;
    mask.getContext("2d").fillRect(12, 12, 24, 24);
    state.candidates = [
      { id: "lifecycle-candidate", role: "apply", enabled: true, forced: false, expandPx: 0, labelToken: "penis", source: "target", refinement: null, confidence: 0.9, color: "#ff3d4d" },
      { id: "lifecycle-exclude", role: "exclude", enabled: true, forced: true, expandPx: 0, labelToken: "hand", source: "hand_exclusion", refinement: null, confidence: 0.8, color: "#28d3ff" },
    ];
    state.candidateImages = new Map([["lifecycle-candidate", mask], ["lifecycle-exclude", mask]]);
    state.removedCandidateIds.clear();
    image.candidateCount = 2; image.enabledCandidateCount = 1; image.candidateRevision = 1;
    state.maskStatus.set(image.id, true);
    state.settings.confirmations.clearMasks = false;
    resetHistoryToCurrentManualMask(); renderCandidates(); updateActionButtons();
  });
  await page.waitForFunction(() => document.querySelector(".candidate-row .candidate-toggle") && !document.querySelector("#clearCurrentMasksButton").disabled);
}

async function rerenderCandidateUi(page) {
  await page.evaluate(() => {
    // This is the product renderer, called while the real network/worker request
    // remains pending. It replaces candidate rows in the same way a refreshed
    // candidate bundle does; no renderer or action function is substituted.
    renderCandidates(); updateActionButtons();
  });
}

async function assertNativeControlsLocked(page, label) {
  await page.waitForFunction((exceptions) => [...document.querySelectorAll("button, input, select, textarea")]
    .filter((control) => !control.disabled && !exceptions.includes(control.id)).length === 0, [...lockExceptions]);
  const leaked = await page.evaluate((exceptions) => [...document.querySelectorAll("button, input, select, textarea")]
    .filter((control) => !control.disabled && !exceptions.includes(control.id))
    .map((control) => control.id || control.className || control.outerHTML.slice(0, 80)), [...lockExceptions]);
  assert.deepEqual(leaked, [], `${label}: every native control is disabled while the operation is busy`);
  for (const selector of [
    ".candidate-row .candidate-toggle", ".candidate-row .candidate-display-toggle", ".candidate-row .candidate-effective-toggle",
    ".candidate-row .candidate-padding-button", "[data-candidate-batch]", "[data-candidate-display-toggle]",
    "[data-candidate-effective-toggle]", "[data-candidate-padding-batch]",
  ]) {
    const controls = page.locator(selector);
    assert.ok(await controls.count() > 0, `${label}: ${selector} remains present after the inner candidate rerender`);
    assert.equal(await controls.evaluateAll((nodes) => nodes.every((node) => node.disabled)), true, `${label}: ${selector} is locked after the inner candidate rerender`);
  }
}

async function assertSettled(page, label, available = ["#detectCurrentButton", "#saveButton", "#flipHorizontalButton"]) {
  await page.waitForFunction(() => !isBusy());
  assert.equal(await page.locator("[data-disabled-by-lock]").count(), 0, `${label}: no busy-lock marker remains after the operation settles`);
  for (const selector of available) assert.equal(await page.locator(selector).isDisabled(), false, `${label}: ${selector} is enabled again`);
}

async function assertCandidateControlsEnabledAfterSettle(page, label) {
  for (const selector of [
    ".candidate-row .candidate-toggle", ".candidate-row .candidate-forced", ".candidate-row .candidate-delete",
    ".candidate-row .candidate-display-toggle", ".candidate-row .candidate-effective-toggle", ".candidate-row .candidate-padding-button",
    "[data-candidate-batch]", "[data-candidate-display-toggle]", "[data-candidate-effective-toggle]", "[data-candidate-padding-batch]",
  ]) {
    const controls = page.locator(selector);
    assert.ok(await controls.count() > 0, `${label}: ${selector} is still generated after the product operation finalizes`);
    assert.equal(await controls.evaluateAll((nodes) => nodes.every((node) => !node.disabled)), true, `${label}: ${selector} is enabled after the product operation finalizes without a forced rerender`);
  }
}

async function renderProjectActionsWhileBusy(page, label) {
  await page.evaluate(async () => { await showProjectList({ keepClosed: true }); });
  const actions = page.locator("[data-project-action]");
  assert.ok(await actions.count() >= 4, `${label}: the real project table generated its open, export, and delete actions`);
  assert.equal(await actions.evaluateAll((nodes) => nodes.every((node) => node.disabled)), true, `${label}: project actions generated during a busy rerender are locked`);
}

async function installResponseGate(page, pattern) {
  let markReady;
  let releaseReply;
  const routeReady = new Promise((resolve) => { markReady = resolve; });
  const replyReady = new Promise((resolve) => { releaseReply = resolve; });
  await page.route(pattern, async (route) => {
    markReady(route.request());
    const reply = await replyReady;
    if (reply === "continue") await route.continue();
    else await route.fulfill(reply);
  });
  return { routeReady, release: releaseReply };
}

test("clear masks keeps rerendered controls locked and releases them after success, failure, and no-op", { timeout: 60000 }, async () => {
  await withFixture(async ({ fixture, page }) => {
    await openSample(page, fixture.url);
    await seedCandidateUi(page);

    const clearGate = await installResponseGate(page, "**/api/masks/clear");
    await page.locator("#clearCurrentMasksButton").click();
    await page.waitForFunction(() => state.masksClearing);
    await rerenderCandidateUi(page);
    await renderProjectActionsWhileBusy(page, "clear success");
    await assertNativeControlsLocked(page, "clear success");
    clearGate.release("continue");
    await assertSettled(page, "clear success");

    const clearRequests = await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/masks/clear")).length);
    assert.equal(await page.locator("#clearCurrentMasksButton").isDisabled(), true, "a cleared image has no remaining clear operation to start");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/masks/clear")).length), clearRequests, "the disabled clear control is a no-op and sends no second request");
    await page.locator("#projectButton").click();
    await page.locator("#projectOpenList").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-project-action]").length >= 4);
    assert.equal(await page.locator("[data-project-action]").evaluateAll((nodes) => nodes.every((node) => !node.disabled)), true, "project actions are enabled again after the clear settles");
    await page.locator('[data-project-action="delete"]').click();
    await page.waitForFunction(() => document.querySelector("#projectDeleteDialog").open);
    await page.locator("#projectDeleteCancel").click();
    await page.locator("#projectListClose").click();

    await page.unroute("**/api/masks/clear");
    await seedCandidateUi(page);
    const failureGate = await installResponseGate(page, "**/api/masks/clear");
    await page.locator("#clearCurrentMasksButton").click();
    await page.waitForFunction(() => state.masksClearing);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "clear failure");
    failureGate.release({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
    await assertSettled(page, "clear failure", ["#clearCurrentMasksButton", "#detectCurrentButton", "#saveButton"]);
    await page.locator("#errorDialogClose").click();
    await assertCandidateControlsEnabledAfterSettle(page, "clear failure");
    const candidateRow = page.locator('[data-candidate-blink-id="lifecycle-candidate"]');
    await candidateRow.locator(".candidate-delete").click();
    await page.waitForFunction(() => state.removedCandidateIds.has("lifecycle-candidate"));
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !state.removedCandidateIds.has("lifecycle-candidate") && document.querySelector('[data-candidate-blink-id="lifecycle-candidate"] .candidate-delete'));
    await candidateRow.locator(".candidate-delete").click();
    await page.waitForFunction(() => state.removedCandidateIds.has("lifecycle-candidate"));
    await page.unroute("**/api/masks/clear");
    await page.locator("#clearCurrentMasksButton").click();
    await page.waitForFunction(() => !state.masksClearing);
    assert.equal(await page.locator("#clearCurrentMasksButton").isDisabled(), true, "the failed clear control can be clicked again and completes through the real fixture route");
  });
});

test("single and batch saves hold native controls, then complete or cancel through their real HTTP lifecycle", { timeout: 60000 }, async () => {
  await withFixture(async ({ fixture, page }) => {
    await openSample(page, fixture.url);
    await seedCandidateUi(page);

    const renderGate = await installResponseGate(page, "**/api/save/render");
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => state.saving);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "single save");
    const saveToken = (await renderGate.routeReady).postDataJSON().clientSaveToken;
    renderGate.release({ status: 200, contentType: "application/json", headers: { "X-Mozarie-Save-Token": saveToken }, body: JSON.stringify({ saveToken }) });
    await assertSettled(page, "single save", ["#saveButton", "#saveAllButton", "#detectCurrentButton"]);
    await page.waitForFunction(() => !state.saving);
    await page.locator("#singleSaveCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#singleSaveDialog").open);

    await page.unroute("**/api/save/render");
    await page.evaluate(() => { state.settings.saving.parallelism = 1; });
    const batchRenderGate = await installResponseGate(page, "**/api/save/render");
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open && !document.querySelector("#applyStartButton").disabled);
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => state.saving && state.browserSave);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "batch save");
    assert.equal(await page.locator("#applyCancelButton").isDisabled(), false, "batch save keeps its actual cancel control available");
    await page.locator("#applyCancelButton").click();
    await page.waitForFunction(() => state.browserSave?.cancelled === true);
    const batchSaveToken = (await batchRenderGate.routeReady).postDataJSON().clientSaveToken;
    batchRenderGate.release({ status: 200, contentType: "application/json", headers: { "X-Mozarie-Save-Token": batchSaveToken }, body: JSON.stringify({ saveToken: batchSaveToken }) });
    await page.waitForFunction(() => !state.saving);
    await assertSettled(page, "batch save cancellation", ["#saveAllButton", "#detectCurrentButton"]);
    await page.locator("#applyCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#applyDialog").open);
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await page.locator("#applyCloseButton").click();
  });
});

test("boundary, fill, transform, undo, and redo recover from pending work without stale locks", { timeout: 60000 }, async () => {
  await withFixture(async ({ fixture, page }) => {
    await page.addInitScript(() => {
      class HeldFloodFillWorker {
        constructor() { window.__heldFillWorker = this; }
        postMessage() {}
        terminate() { this.terminated = true; }
      }
      window.Worker = HeldFloodFillWorker;
    });
    await openSample(page, fixture.url);
    await seedCandidateUi(page);

    const boundaryGate = await installResponseGate(page, "**/api/boundary");
    await page.evaluate(() => {
      state.boundaryDrafts = [{ id: "lifecycle-boundary", type: "rectangle", roi: { left: 8, top: 8, right: 36, bottom: 36 }, point: { x: 22, y: 22 } }];
      state.boundaryActiveId = "lifecycle-boundary";
      updateBoundaryActions(); render();
    });
    await page.locator("#boundaryDetectButton").click();
    await page.waitForFunction(() => state.boundaryPending);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "boundary add");
    boundaryGate.release({ status: 200, contentType: "application/json", body: JSON.stringify({
      candidates: [{ id: "boundary-lifecycle", role: "apply", enabled: true, forced: false, labelToken: "boundary", source: "boundary", confidence: 1, color: "#ff3d4d" }], candidateRevision: 2,
    }) });
    await page.waitForFunction(() => !state.boundaryPending);
    await assertSettled(page, "boundary add");
    await seedCandidateUi(page);

    await page.locator("#bucketTool").click();
    const box = await page.locator("#editorCanvas").boundingBox();
    assert.ok(box, "fill uses the real editor canvas");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => state.fillPending && window.__heldFillWorker);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "fill worker");
    await page.evaluate(() => window.__heldFillWorker.onmessage({ data: { spans: [0, 0, 2] } }));
    await assertSettled(page, "fill worker");
    assert.deepEqual(await page.evaluate(() => ({
      filledAlpha: addCtx.getImageData(0, 0, 1, 1).data[3] > 0,
      untouchedAlpha: addCtx.getImageData(80, 60, 1, 1).data[3],
      history: state.history.at(-1) && { tool: state.history.at(-1).tool, spans: state.history.at(-1).spans },
    })), { filledAlpha: true, untouchedAlpha: 0, history: { tool: "bucket", spans: [0, 0, 2] } }, "the real fill completion paints only the returned span and records that span for undo");

    const transformGate = await installResponseGate(page, "**/api/images/sample/transform");
    await page.locator("#flipHorizontalButton").click();
    await page.waitForFunction(() => state.transformPending);
    await rerenderCandidateUi(page);
    await assertNativeControlsLocked(page, "transform failure");
    transformGate.release({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
    await assertSettled(page, "transform failure");
    await page.locator("#errorDialogClose").click();
    await assertCandidateControlsEnabledAfterSettle(page, "transform failure");

    await page.unroute("**/api/images/sample/transform");
    await page.locator("#flipVerticalButton").click();
    await page.waitForFunction(() => currentRecord()?.flipV === true && !state.transformPending);
    const canvas = await page.locator("#editorCanvas").boundingBox();
    await page.locator("#brushTool").click();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 10, canvas.y + canvas.height / 2 + 8);
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector("#undoButton").disabled);
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !document.querySelector("#redoButton").disabled);
    await page.locator("#redoButton").click();
    await page.waitForFunction(() => !document.querySelector("#undoButton").disabled);
  });
});
