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
