const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("project Ctrl+Z flushes the durable edit and keeps browser history canvases released", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => {
      const nativeFetch = window.fetch;
      const project = { id: "fixture-project", status: "working" };
      const history = { canUndo: false, canRedo: false, writes: 0, undo: 0, redo: 0, imageSnapshots: 0 };
      window.__projectHistoryFixture = history;
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input);
        const method = init.method || "GET";
        if (url.includes("/api/workspace/manual/sample") && method === "POST") {
          history.writes += 1;
          history.canUndo = true;
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/api/project/history/sample")) {
          if (method === "POST" && url.endsWith("/undo")) { history.undo += 1; history.canUndo = false; history.canRedo = true; }
          if (method === "POST" && url.endsWith("/redo")) { history.redo += 1; history.canUndo = true; history.canRedo = false; }
          return new Response(JSON.stringify({ canUndo: history.canUndo, canRedo: history.canRedo, changedImageIds: [] }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/api/images") && method === "GET") {
          history.imageSnapshots += 1;
          const response = await nativeFetch(input, init);
          const snapshot = await response.json();
          return new Response(JSON.stringify({ ...snapshot, project, readOnly: false }), { headers: { "Content-Type": "application/json" } });
        }
        return nativeFetch(input, init);
      };
      state.project = project;
      state.projectReadOnly = false;
      state.projectHistory = new Map([["sample", { canUndo: false, canRedo: false }]]);
      resetHistoryToCurrentManualMask();
      beginManualStroke({ x: 8, y: 8 });
      completeManualStroke();
    });
    await page.waitForFunction(() => window.__projectHistoryFixture.writes === 1 && !document.querySelector("#undoButton").disabled);
    const afterStroke = await page.evaluate(() => ({
      localHistory: state.history.length,
      historyBases: [historyAddCanvas, historyExclusionCanvas, historyExclusionEraseCanvas].map((canvas) => [canvas.width, canvas.height]),
    }));
    assert.deepEqual(afterStroke, { localHistory: 0, historyBases: [[1, 1], [1, 1], [1, 1]] }, "the project database is the undo authority and all three browser bases stay released");
    const shortcutContext = await page.evaluate(() => ({
      viewMode: state.viewMode,
      focused: document.activeElement?.id || "",
      openDialogs: [...document.querySelectorAll("dialog")].filter((dialog) => dialog.open).length,
    }));
    assert.equal(shortcutContext.viewMode, "edit", "project undo uses the editor shortcut in edit mode");
    assert.equal(shortcutContext.openDialogs, 0, "project undo shortcut is not hidden behind a dialog");
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Control+Z");
    await page.waitForFunction(() => {
      const history = window.__projectHistoryFixture;
      return history.undo === 1 && history.imageSnapshots === 1 && state.project?.id === "fixture-project" && document.querySelector("#redoButton").disabled === false;
    });
    await page.keyboard.press("Control+Shift+Z");
    await page.waitForFunction(() => {
      const history = window.__projectHistoryFixture;
      return history.redo === 1 && history.imageSnapshots === 2 && state.project?.id === "fixture-project" && document.querySelector("#undoButton").disabled === false;
    });
    await page.evaluate(() => { state.projectReadOnly = true; updateHistoryButtons(); });
    assert.equal(await page.locator("#undoButton").isDisabled(), true, "completed projects disable database undo in the browser");
  } finally {
    await page?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("completed projects keep browser navigation available without allowing edits", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);

    const controls = await page.evaluate(() => {
      state.project = { id: "completed-project", status: "completed" };
      state.projectReadOnly = true;
      renderProjectCurrent();
      state.job = { state: "running" };
      updateActionButtons();
      const busyGalleryDisabled = document.querySelector('.gallery-item[data-id="sample"]').disabled;

      state.job = null;
      updateActionButtons();
      const afterBusy = {
        gallery: document.querySelector('.gallery-item[data-id="sample"]').disabled,
        next: document.querySelector("#nextImageButton").disabled,
        overview: document.querySelector("#overviewButton").disabled,
        preview: document.querySelector("#mosaicPreviewButton").disabled,
        download: document.querySelector("#downloadCurrentMosaicMask").disabled,
        resume: document.querySelector("#projectResume").disabled,
        review: document.querySelector("#reviewAndNextButton").disabled,
        detect: document.querySelector("#detectCurrentButton").disabled,
        remove: document.querySelector("#removeCurrentImageButton").disabled,
        undo: document.querySelector("#undoButton").disabled,
        projectReadOnly: state.projectReadOnly,
      };

      setViewMode("overview");
      const overview = {
        card: document.querySelector('.overview-item[data-id="sample"]').disabled,
        filter: document.querySelector(".overview-filter").disabled,
        query: document.querySelector("#overviewQuery").disabled,
        folder: document.querySelector("#overviewFolder").disabled,
        close: document.querySelector("#closeOverviewButton").disabled,
      };
      setViewMode("edit");
      return { busyGalleryDisabled, afterBusy, overview };
    });
    assert.equal(controls.busyGalleryDisabled, true, "busy work disables gallery navigation");
    assert.deepEqual(controls.afterBusy, {
      gallery: false, next: false, overview: false, preview: false, download: false, resume: false,
      review: true, detect: true, remove: true, undo: true, projectReadOnly: true,
    }, "read-only mode restores browsing controls and keeps mutations disabled after busy work");
    assert.deepEqual(controls.overview, { card: false, filter: false, query: false, folder: false, close: false }, "read-only mode keeps overview browsing controls available");

    await page.evaluate(() => {
      window.__readOnlyShortcutRequests = 0;
      const nativeFetch = window.fetch;
      window.fetch = (...args) => {
        window.__readOnlyShortcutRequests += 1;
        return nativeFetch(...args);
      };
    });
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(25);
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, reviewed: isReviewed(currentRecord()), requests: window.__readOnlyShortcutRequests })), { currentId: "sample", reviewed: false, requests: 0 }, "read-only review shortcut does not mutate or advance");

    const resumed = await page.evaluate(() => {
      state.project = { ...state.project, status: "working" };
      state.projectReadOnly = false;
      updateActionButtons();
      const result = {
        review: document.querySelector("#reviewAndNextButton").disabled,
        detect: document.querySelector("#detectCurrentButton").disabled,
        remove: document.querySelector("#removeCurrentImageButton").disabled,
      };
      state.project = null;
      updateActionButtons();
      return result;
    });
    assert.deepEqual(resumed, { review: false, detect: false, remove: false }, "resuming work re-enables editing controls");
  } finally {
    await page?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
