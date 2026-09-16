const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("project Ctrl+Z flushes the durable edit and keeps browser history canvases released", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context; let page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
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
          if (url.endsWith("/commit")) history.canUndo = true;
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/api/project/history/sample")) {
          if (method === "POST" && url.endsWith("/undo")) { history.undo += 1; history.canUndo = false; history.canRedo = true; }
          if (method === "POST" && url.endsWith("/redo")) { history.redo += 1; history.canUndo = true; history.canRedo = false; }
          return new Response(JSON.stringify({ canUndo: history.canUndo, canRedo: history.canRedo, changedImageIds: ["sample"] }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/api/images") && method === "GET") {
          history.imageSnapshots += 1;
          const response = await nativeFetch(input, init);
          const snapshot = await response.json();
          return new Response(JSON.stringify({ ...snapshot, project, readOnly: false, historyDurable: true, catalogGeneration: snapshot.catalogGeneration }), { headers: { "Content-Type": "application/json" } });
        }
        return nativeFetch(input, init);
      };
      state.project = project;
      state.projectReadOnly = false;
      state.historyDurable = true;
      state.projectHistory = new Map([["sample", { canUndo: false, canRedo: false }]]);
      resetHistoryToCurrentManualMask();
      beginManualStroke({ x: 8, y: 8 });
      completeManualStroke();
    });
    await page.waitForFunction(() => window.__projectHistoryFixture.writes >= 3 && !document.querySelector("#undoButton").disabled);
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
    await page.evaluate(() => {
      state.settings.shortcuts.bindings.redo = "Ctrl+Y";
      state.view = { scale: 1.7, x: 31, y: -19 };
    });
    await page.keyboard.press("Control+Z");
    await page.waitForFunction(() => {
      const history = window.__projectHistoryFixture;
      return history.undo === 1 && history.imageSnapshots === 1 && state.project?.id === "fixture-project" && document.querySelector("#redoButton").disabled === false;
    });
    await page.keyboard.press("Control+Y");
    await page.waitForFunction(() => {
      const history = window.__projectHistoryFixture;
      return history.redo === 1 && history.imageSnapshots === 2 && state.project?.id === "fixture-project" && document.querySelector("#undoButton").disabled === false;
    });
    await page.evaluate(() => { state.projectReadOnly = true; updateHistoryButtons(); });
    assert.equal(await page.locator("#undoButton").isDisabled(), true, "completed projects disable database undo in the browser");
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, viewMode: state.viewMode, view: state.view })), {
      currentId: "sample", viewMode: "edit", view: { scale: 1.7, x: 31, y: -19 },
    }, "durable undo and redo keep the selected image, editor mode, and zoom/pan");
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("empty project history shortcuts do not fetch, lock, or change the current editor", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context; let page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => {
      const nativeFetch = window.fetch;
      const calls = { history: 0, snapshots: 0 };
      window.__emptyProjectHistoryFixture = calls;
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input);
        if (url.includes("/api/project/history/")) calls.history += 1;
        if (url.includes("/api/images")) calls.snapshots += 1;
        return nativeFetch(input, init);
      };
      state.project = { id: "fixture-project", status: "working" };
      state.projectReadOnly = false;
      state.historyDurable = true;
      state.projectHistory = new Map([["sample", { canUndo: false, canRedo: false }]]);
      state.viewMode = "edit";
      state.settings.shortcuts.bindings.redo = "Ctrl+Y";
    });
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Y");
    const result = await page.evaluate(() => ({
      ...window.__emptyProjectHistoryFixture,
      currentId: state.currentId,
      viewMode: state.viewMode,
      historyBusy: state.projectHistoryBusy,
      busy: isBusy(),
    }));
    assert.deepEqual(result, { history: 0, snapshots: 0, currentId: "sample", viewMode: "edit", historyBusy: false, busy: false });
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("history completion recreates every candidate control after success, no-op, and failure", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context; let page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => {
      state.project = { id: "fixture-project", status: "working" };
      state.projectReadOnly = false; state.historyDurable = true;
      state.candidates = [
        { id: "apply", role: "apply", enabled: true, forced: false, expandPx: 1, labelToken: "penis", confidence: .9, color: "#fff" },
        { id: "exclude", role: "exclude", enabled: true, forced: true, expandPx: 1, labelToken: "hand", confidence: .9, color: "#fff" },
      ];
      state.manualMaskPresent = true; state.manualExclusionPresent = true; state.manualExclusionErasePresent = true;
      renderCandidates(); updateActionButtons();
      window.__historyControls = () => [...document.querySelectorAll("#candidatePane .candidate-row button, #candidatePane [data-candidate-batch], #candidatePane [data-candidate-padding-batch]")]
        .map((button) => ({ type: button.className || button.dataset.candidateBatch || button.dataset.candidatePaddingBatch, disabled: button.disabled }));
      window.__nativeHistoryFetch = window.fetch;
    });
    const controlTypes = await page.evaluate(() => window.__historyControls().map((item) => item.type));
    for (const required of ["candidate-toggle", "candidate-display-toggle", "candidate-effective-toggle", "candidate-forced", "candidate-padding-button", "candidate-delete"]) {
      assert.ok(controlTypes.includes(required), `fixture includes ${required}`);
    }
    assert.ok(controlTypes.some((value) => value.includes("apply:toggle")), "fixture includes apply batch controls");
    assert.ok(controlTypes.some((value) => value.includes("exclude:toggle")), "fixture includes exclusion batch controls");

    await page.evaluate(() => {
      const nativeFetch = window.__nativeHistoryFetch;
      let release;
      window.__releaseHistory = () => release?.();
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input); const method = init.method || "GET";
        if (url.includes("/api/project/history/sample") && method === "GET") return new Response(JSON.stringify({ canUndo: true, canRedo: false }), { headers: { "Content-Type": "application/json" } });
        if (url.endsWith("/api/project/history/sample/undo")) return new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ canUndo: false, canRedo: true, changedImageIds: ["other"] }), { headers: { "Content-Type": "application/json" } })); });
        if (url.includes("/api/images") && method === "GET") {
          const response = await nativeFetch(input, init); const snapshot = await response.json();
          return new Response(JSON.stringify({ ...snapshot, project: state.project, readOnly: false, historyDurable: true }), { headers: { "Content-Type": "application/json" } });
        }
        return nativeFetch(input, init);
      };
      state.projectHistory = new Map([["sample", { canUndo: true, canRedo: false }]]);
      void restoreProjectHistory("undo");
    });
    await page.waitForFunction(() => state.projectHistoryBusy === true);
    assert.ok((await page.evaluate(() => window.__historyControls())).every((item) => item.disabled), "all dynamic rows and batch controls lock during restoration");
    await page.evaluate(() => window.__releaseHistory());
    await page.waitForFunction(() => state.projectHistoryBusy === false);
    assert.ok((await page.evaluate(() => window.__historyControls())).every((item) => !item.disabled), "successful restoration unlocks recreated dynamic controls");

    for (const mode of ["noop", "postFailure", "reloadFailure"]) {
      await page.evaluate((outcome) => {
        const nativeFetch = window.__nativeHistoryFetch;
        window.fetch = async (input, init = {}) => {
          const url = String(input?.url || input); const method = init.method || "GET";
          if (url.includes("/api/project/history/sample") && method === "GET") return new Response(JSON.stringify({ canUndo: true, canRedo: false }), { headers: { "Content-Type": "application/json" } });
          if (url.endsWith("/api/project/history/sample/undo")) {
            if (outcome === "postFailure") return new Response(JSON.stringify({ error: { code: "workspace_write_failed" } }), { status: 500, headers: { "Content-Type": "application/json" } });
            return new Response(JSON.stringify({ canUndo: false, canRedo: true, changedImageIds: outcome === "noop" ? [] : ["other"] }), { headers: { "Content-Type": "application/json" } });
          }
          if (url.includes("/api/images") && method === "GET" && outcome === "reloadFailure") return new Response(JSON.stringify({ error: { code: "workspace_write_failed" } }), { status: 500, headers: { "Content-Type": "application/json" } });
          if (url.includes("/api/images") && method === "GET") {
            const response = await nativeFetch(input, init); const snapshot = await response.json();
            return new Response(JSON.stringify({ ...snapshot, project: state.project, readOnly: false, historyDurable: true }), { headers: { "Content-Type": "application/json" } });
          }
          return nativeFetch(input, init);
        };
        state.projectHistory = new Map([["sample", { canUndo: true, canRedo: false }]]);
        void restoreProjectHistory("undo");
      }, mode);
      await page.waitForFunction(() => state.projectHistoryBusy === false);
      assert.ok((await page.evaluate(() => window.__historyControls())).every((item) => !item.disabled), `${mode} restoration unlocks recreated dynamic controls`);
    }
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});

test("manual output-directory commits lock every save entry point until the settings response settles", { timeout: 20000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  let context; let page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.evaluate(() => {
      state.applyTargetIds = ["sample"];
      document.querySelector("#applyCopyMode").checked = true;
      window.__failManualOutputDirectoryCommit = false;
      const nativeFetch = window.fetch;
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input);
        if (url === "/api/settings?status=0" && init.method === "POST") {
          if (window.__failManualOutputDirectoryCommit) return new Response(JSON.stringify({ error_code: "invalid_settings" }), { status: 400, headers: { "Content-Type": "application/json" } });
          const requestedDirectory = JSON.parse(init.body).saving.default_output_directory;
          return new Promise((resolve) => {
            window.__releaseOutputDirectoryCommit = () => resolve(new Response(JSON.stringify({
              settings: { ...state.settings, saving: { ...state.settings.saving, default_output_directory: requestedDirectory } },
            }), { headers: { "Content-Type": "application/json" } }));
          });
        }
        return nativeFetch(input, init);
      };
    });
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open, null, { timeout: 3000 });
    await page.locator("#applyOutputDirectoryStatus").fill("C:/manual-output");
    await page.locator("#applyOutputDirectoryStatus").press("Enter");
    await page.waitForFunction(() => state.outputDirectoryCommitPending === true, null, { timeout: 3000 });
    for (const selector of [
      "#applyOutputDirectoryStatus", "#singleSaveOutputDirectoryStatus", "#chooseOutputDirectoryButton", "#singleSaveChooseOutputDirectoryButton",
      "#applyStartButton", "#singleSaveStartButton", "#saveAllButton", "#saveButton", "#settingsSaveButton", "#settingsResetButton",
    ]) assert.equal(await page.locator(selector).isDisabled(), true, `${selector} stays disabled during the directory write`);
    await page.evaluate(() => window.__releaseOutputDirectoryCommit());
    await page.waitForFunction(() => state.outputDirectoryCommitPending === false, null, { timeout: 3000 });
    assert.deepEqual(await page.evaluate(() => ({
      settings: state.settings.saving.default_output_directory,
      settingsInput: document.querySelector("#settingsDefaultOutputDirectory").value,
      applyInput: document.querySelector("#applyOutputDirectoryStatus").value,
      singleInput: document.querySelector("#singleSaveOutputDirectoryStatus").value,
    })), {
      settings: "C:/manual-output", settingsInput: "C:/manual-output", applyInput: "C:/manual-output", singleInput: "C:/manual-output",
    }, "the canonical server path updates all three output-directory displays together");
    for (const selector of ["#applyOutputDirectoryStatus", "#singleSaveOutputDirectoryStatus", "#chooseOutputDirectoryButton", "#singleSaveChooseOutputDirectoryButton", "#settingsSaveButton", "#settingsResetButton"]) {
      assert.equal(await page.locator(selector).isDisabled(), false, `${selector} unlocks after the directory write`);
    }
    await page.evaluate(() => { window.__failManualOutputDirectoryCommit = true; });
    await page.locator("#applyOutputDirectoryStatus").fill("relative-output");
    await page.locator("#applyOutputDirectoryStatus").press("Enter");
    await page.waitForFunction(() => document.querySelector("#errorDialog").open, null, { timeout: 3000 });
    assert.equal(await page.locator("#applyOutputDirectoryStatus").inputValue(), "relative-output", "a rejected manual directory remains editable for correction");
    await page.locator("#errorDialogClose").click();
    await page.waitForFunction(() => document.activeElement === document.querySelector("#applyOutputDirectoryStatus"), null, { timeout: 3000 });
    await page.evaluate(() => { window.__failManualOutputDirectoryCommit = false; });
    await page.locator("#applyOutputDirectoryStatus").fill("C:/retry-output");
    await page.locator("#applyOutputDirectoryStatus").press("Enter");
    await page.waitForFunction(() => state.outputDirectoryCommitPending === true, null, { timeout: 3000 });
    await page.evaluate(() => window.__releaseOutputDirectoryCommit());
    await page.waitForFunction(() => state.settings.saving.default_output_directory === "C:/retry-output", null, { timeout: 3000 });
    await page.evaluate(() => { runBrowserSave = async () => { window.__saveStartedAfterDirectoryCommit = true; }; });
    await page.locator("#applyOutputDirectoryStatus").fill("C:/click-output");
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => state.outputDirectoryCommitPending === true, null, { timeout: 3000 });
    await page.evaluate(() => window.__releaseOutputDirectoryCommit());
    await page.waitForFunction(() => window.__saveStartedAfterDirectoryCommit === true, null, { timeout: 3000 });
  } finally {
    await context?.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
