const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

test("detection submit paints preparation before settings and start responses and restores controls on failure", { timeout: 60000 }, async () => {
  for (const failure of ["settings", "detect", null]) await withPage(async (page, fixture) => {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.images.length === 2 && Boolean(state.settings));
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => !state.detectionDialogPreparing);
    const previousJob = await page.evaluate(() => structuredClone(state.job));
    let settingsRoute; let detectRoute;
    let settingsSeen; let detectSeen;
    const settingsRequested = new Promise((resolve) => { settingsSeen = resolve; });
    const detectRequested = new Promise((resolve) => { detectSeen = resolve; });
    await page.route("**/api/settings?status=0", (route) => { settingsRoute = route; settingsSeen(); });
    await page.route("**/api/detect", (route) => { detectRoute = route; detectSeen(); });
    const assertPreparing = async () => {
      assert.equal(await page.locator("#processingDialog").isVisible(), true);
      assert.match(await page.locator("#processingCurrent").textContent(), /検出を準備中/);
      assert.equal(await page.locator("#processingPauseButton").isDisabled(), true);
      assert.equal(await page.locator("#processingCancelButton").isDisabled(), true);
      assert.equal(await page.evaluate(() => state.processing.phase), "preparing_request");
      assert.deepEqual(await page.evaluate(() => state.job), previousJob);
      assert.equal(fixture.detectRequests.length, 0);
    };
    await page.locator("#detectStartButton").click();
    await settingsRequested;
    await assertPreparing();
    await page.evaluate(() => { void startDetectionFromDialog({ preventDefault() {} }); });
    if (failure === "settings") {
      await settingsRoute.fulfill({ status: 400, json: { error_code: "input_invalid" } });
    } else {
      await settingsRoute.continue();
      await detectRequested;
      await assertPreparing();
      if (failure === "detect") await detectRoute.fulfill({ status: 400, json: { error_code: "input_invalid" } });
      else await detectRoute.continue();
    }
    await page.waitForFunction(() => !state.detectionStarting);
    if (failure) {
      assert.equal(await page.locator("#processingDialog").isVisible(), false);
      assert.equal(await page.locator("#errorDialog").isVisible(), true);
      assert.deepEqual(await page.evaluate(() => state.job), previousJob);
      if (failure === "settings") {
        await page.locator("#errorDialogClose").click();
        assert.equal(await page.locator("#detectStartButton").isEnabled(), true);
      }
    } else {
      assert.equal(fixture.detectRequests.length, 1);
      await page.waitForFunction(() => state.processing?.phase === "preparing_models" || state.job?.state === "complete");
    }
  });
});

async function withPage(body) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await body(page, fixture);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
}

test("project manager details keep the catalogue unchanged and expose resume downloads deletion and exact path copying", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    const path = `G:\\${"長いフォルダー名\\".repeat(18)}画像`;
    const project = { id: "ledger-project", name: "詳細のプロジェクト", status: "completed", imageCount: 2, createdAt: 1000000000, updatedAt: 2000000000, sourceRoot: path };
    const openRequests = [];
    let rejectDelete = true;
    await page.route("**/api/project/ledger-project", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      if (rejectDelete) { rejectDelete = false; return route.fulfill({ status: 500, json: { error_code: "internal_error" } }); }
      await route.fulfill({ json: { images: [], project: null, root: "" } });
    });
    await page.route("**/api/projects?*", (route) => route.fulfill({ json: { projects: [project] } }));
    await page.route("**/api/project/detail?*", (route) => route.fulfill({ json: {
      project, sources: [{ kind: "native-folder", displayName: "画像", nativePath: path }, { kind: "browser-files", displayName: "ブラウザーから追加", nativePath: null }],
    } }));
    await page.addInitScript(() => {
      window.__copiedPaths = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => {
        if (window.__rejectCopy) throw new DOMException("denied", "NotAllowedError");
        window.__copiedPaths.push(value);
      } } });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.evaluate(() => { window.__catalogBeforeDetails = { images: state.images, epoch: state.catalogEpoch, project: state.project }; });
    await page.locator("#projectButton").click(); await page.locator("#projectOpenList").click();
    await page.locator("#projectListDialog").waitFor({ state: "visible" });
    assert.deepEqual(await page.locator("#projectList thead th").allTextContents().then((values) => values.map((value) => value.replace(/[▲▼]/g, "").trim())), ["プロジェクト名", "状態", "画像数", "作成日時", "更新日時"]);
    assert.ok(await page.locator("#projectListDialog").evaluate((dialog) => dialog.getBoundingClientRect().width) > 1200);
    assert.equal(await page.locator("#projectListBody .project-completed").evaluate((node) => getComputedStyle(node).color), "rgb(121, 219, 164)");
    await page.locator("#projectListBody tr td").first().click();
    await page.locator("#projectDetailContent").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => state.images === window.__catalogBeforeDetails.images && state.catalogEpoch === window.__catalogBeforeDetails.epoch && state.project === window.__catalogBeforeDetails.project), true);
    assert.equal(await page.locator("#projectDetailSources [data-project-action=copy-path]").count(), 1);
    assert.equal(await page.locator(".project-detail-source span").first().textContent(), path);
    await page.locator('[data-project-action="copy-path"]').click();
    await page.waitForFunction(() => window.__copiedPaths.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__copiedPaths), [path]);
    await page.evaluate(() => { window.__rejectCopy = true; });
    await page.locator('[data-project-action="copy-path"]').click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    await page.locator("#errorDialogClose").click();
    await page.locator("#projectDetailBack").click();
    assert.equal(await page.locator('#projectListBody [data-project-action="open"]').evaluate((node) => node === document.activeElement), true);
    await page.locator('#projectListBody [data-project-action="open"]').press("Enter");
    await page.locator("#projectDetailContent").waitFor({ state: "visible" });
    for (const [id, kind] of [["projectDetailMosaic", "mosaic"], ["projectDetailExclude", "exclude"]]) {
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`#${id}`).click()]);
      assert.equal(download.suggestedFilename(), `${project.name}-${kind}-masks.zip`);
      await page.waitForFunction(() => !document.querySelector("#projectDetailMosaic").disabled && !document.querySelector("#projectDetailExclude").disabled);
    }
    await page.locator("#projectDetailDelete").click();
    await page.locator("#projectDeleteConfirm").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#projectDeleteCancel").isEnabled(), true);
    await page.locator("#projectDeleteCancel").click();
    assert.equal(await page.locator("#projectDetailContent").isVisible(), true);
    assert.equal(await page.locator("#projectDetailDelete").evaluate((node) => node === document.activeElement), true);
    await page.route("**/api/project/open", async (route) => {
      openRequests.push(route.request().postDataJSON());
      await route.fulfill({ json: { project: { ...project, status: "working" }, images: [], root: path, sources: [], needsSource: false, readOnly: false } });
    });
    await page.locator("#projectDetailResume").click();
    await page.waitForFunction(() => state.project?.id === "ledger-project" && !state.projectReadOnly && !document.querySelector("#projectListDialog").open);
    assert.equal(openRequests.length, 1);
    assert.equal(openRequests[0].resume, true);
    await page.locator("#projectButton").click(); await page.locator("#projectOpenList").click();
    await page.locator('#projectListBody [data-project-action="open"]').click();
    await page.locator("#projectDetailDelete").click();
    await page.locator("#projectDeleteConfirm").click();
    await page.locator("#projectListEmpty").waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectDetailPanel").isVisible(), false);
  });
});

test("project detail responses cannot reopen a cancelled or newer view and failures preserve current work", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let received;
    const requested = new Promise((resolve) => { received = resolve; });
    await page.route("**/api/project/detail?*", async (route) => {
      received(); await gate;
      await route.fulfill({ status: 500, json: { error_code: "internal_error" } });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.evaluate(() => { window.__catalogBeforeDetails = [state.images, state.catalogEpoch, state.project]; });
    await page.locator("#projectButton").click(); await page.locator("#projectOpenList").click();
    await page.locator('#projectListBody [data-project-action="open"]').click();
    await requested;
    await page.locator("#projectDetailBack").click();
    release();
    await page.waitForResponse((response) => response.url().includes("/api/project/detail?"));
    assert.equal(await page.locator("#projectListPanel").isVisible(), true);
    await page.locator('#projectListBody [data-project-action="open"]').click();
    await page.locator("#projectDetailError").waitFor({ state: "visible" });
    assert.ok((await page.locator("#projectDetailError").textContent()).length > 0);
    assert.equal(await page.locator("#projectDetailBack").isEnabled(), true);
    assert.equal(await page.evaluate(() => state.images === window.__catalogBeforeDetails[0] && state.catalogEpoch === window.__catalogBeforeDetails[1] && state.project === window.__catalogBeforeDetails[2]), true);
  });
});

test("all-image detection opens before preparation and cancelled frame callbacks cannot initialize the dialog", { timeout: 60000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => Boolean(state.currentImage));
    await page.locator("#detectionSettingsButton").click();
    assert.equal(await page.locator("#detectStartButton").textContent(), "保存");
    await page.locator("#detectCancelButton").click();
    await page.evaluate(() => {
      const nativeRaf = window.requestAnimationFrame.bind(window);
      window.__preparationFrames = [];
      window.requestAnimationFrame = (callback) => state.detectionDialogPreparing ? window.__preparationFrames.push(callback) : nativeRaf(callback);
      const targets = allImageDetectionTargets;
      window.__targetReads = 0;
      allImageDetectionTargets = (...args) => { if (state.detectionDialogPreparing) window.__targetReads++; return targets(...args); };
    });
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#detectPreparationStatus").isVisible(), true);
    assert.equal(await page.locator("#detectStartButton").isDisabled(), true);
    assert.equal(await page.locator("#detectStartButton").textContent(), "検出を開始");
    assert.equal(await page.locator("#detectParallelismRow").isVisible(), true);
    assert.equal(await page.locator("#detectCancelButton").isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__targetReads), 0);
    await page.evaluate(() => window.__preparationFrames.shift()(performance.now()));
    assert.equal(await page.evaluate(() => window.__targetReads), 0);
    await page.evaluate(() => { setDetectionDialogSubmitting(false); });
    assert.equal(await page.locator("#detectStartButton").isDisabled(), true);
    assert.equal(await page.locator("#detectConfidenceNumber").isDisabled(), true);
    await page.evaluate(() => window.__preparationFrames.shift()(performance.now()));
    assert.equal(await page.evaluate(() => window.__targetReads), 1);
    assert.equal(await page.locator("#detectPreparationStatus").isVisible(), false);
    assert.equal(await page.locator("#detectStartButton").isEnabled(), true);
    await page.locator("#detectCancelButton").click();
    await page.locator("#detectAllButton").click();
    await page.locator("#detectCancelButton").click();
    await page.evaluate(() => { while (window.__preparationFrames.length) window.__preparationFrames.shift()(performance.now()); });
    assert.equal(await page.locator("#detectDialog").evaluate((dialog) => dialog.open), false);
    assert.deepEqual(await page.evaluate(() => state.pendingDetectionTargetIds), []);
    await page.locator("#detectAllButton").click();
    await page.evaluate(() => { beginCatalogEpoch(); window.__preparationFrames.shift()(performance.now()); });
    assert.equal(await page.locator("#detectDialog").evaluate((dialog) => dialog.open), false);
    await page.locator("#detectAllButton").click();
    await page.evaluate(() => { while (window.__preparationFrames.length) window.__preparationFrames.shift()(performance.now()); });
    await page.evaluate(() => { state.project = { id: "another-project", status: "working" }; beginCatalogEpoch(); });
    await page.locator("#detectStartButton").click();
    assert.equal(await page.locator("#detectStartButton").isDisabled(), true);
    assert.ok((await page.locator("#detectPreparationStatus").textContent()).length > 0);
    assert.equal(fixture.detectRequests.length, 0);
    await page.locator("#detectCancelButton").click();
    await page.evaluate(() => {
      state.project = null;
      const targets = allImageDetectionTargets;
      allImageDetectionTargets = (...args) => { if (state.detectionDialogPreparing) throw codedError("internal_error"); return targets(...args); };
    });
    await page.locator("#detectAllButton").click();
    await page.evaluate(() => { while (window.__preparationFrames.length) window.__preparationFrames.shift()(performance.now()); });
    assert.equal(await page.locator("#detectStartButton").isDisabled(), true);
    assert.equal(await page.locator("#detectCancelButton").isEnabled(), true);
    assert.ok((await page.locator("#detectPreparationStatus").textContent()).length > 0);
  });
});
