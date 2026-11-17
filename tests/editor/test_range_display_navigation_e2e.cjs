const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

test("bulk range display follows image navigation without carrying image-specific selections", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const ids = ["first", "second", "empty", "last", "broken"];
  fixture.setCatalog(ids.map((id) => ({ id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 2, height: 2, candidateRevision: 1, reviewed: false, hidden: false })));
  const mask = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==";
  try {
    const page = await context.newPage();
    // Control only the external clock; keep the actual drawing and timer lifecycle.
    await page.addInitScript(() => {
      const start = window.setInterval.bind(window), stop = window.clearInterval.bind(window);
      const timers = new Map(); let sequence = 0;
      window.setInterval = (callback, delay, ...args) => {
        if (delay !== 200) return start(callback, delay, ...args);
        const id = `blink-${++sequence}`; timers.set(id, () => callback(...args)); return id;
      };
      window.clearInterval = (id) => { if (!timers.delete(id)) stop(id); };
      window.tickRangeDisplay = () => [...timers.values()].forEach((tick) => tick());
      window.rangeTimerCount = () => timers.size;
    });
    await page.route("**/api/candidates/*", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const candidates = id === "empty" ? [] : ["apply", "exclude"].map((role) => ({
        id: `${id}-${role}`, role, enabled: true, forced: false, expandPx: 0,
        labelToken: role === "apply" ? "penis" : "hand", source: role === "apply" ? "target" : "hand_exclusion",
        refinement: null, confidence: .9, color: role === "apply" ? "#ff3d4d" : "#28d3ff",
      }));
      await route.fulfill({ json: { candidates, candidateRevision: 1 } });
    });
    await page.route("**/api/workspace/manual/*", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      await route.fulfill({ json: { draft: { candidateRevision: 1, add: id === "empty" ? "" : mask, exclusion: id === "empty" ? "" : mask, exclusionErase: id === "empty" ? "" : mask } } });
    });
    await page.route("**/api/image/broken**", (route) => route.fulfill({ status: 500, json: { error_code: "image_read_failed" } }));
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => appStartup);
    const select = async (id) => {
      await page.locator(`.gallery-item[data-id="${id}"]`).click();
      await page.waitForFunction((id) => state.currentId === id && !state.pendingImageId, id);
    };
    const closeSettings = async () => {
      await page.locator("#settingsCloseButton").click();
      await page.waitForFunction(() => !document.querySelector("#settingsDialog").open && document.activeElement.id === "settingsButton");
      await page.locator("#editorCanvas").focus();
    };
    const snapshot = () => page.evaluate(() => ({
      current: state.currentId, ids: [...state.blinkCandidateIds].sort(), modes: [...state.blinkModes].sort(),
      roles: [...state.blinkRoleModes].sort(), timer: state.blinkTimer, timerCount: window.rangeTimerCount(),
    }));
    const expectedIds = (id) => [`${id}-apply`, `${id}-exclude`, "manual:apply", "manual:exclude", "manual:excludeErase"].sort();
    const assertDisplay = async (id, applyMode, excludeMode) => {
      const actual = await snapshot();
      assert.deepEqual(actual.ids, expectedIds(id), "only the destination image's candidates and manual ranges blink");
      for (const [role, mode] of [["apply", applyMode], ["exclude", excludeMode]]) {
        const selector = mode === "normal" ? "data-candidate-display-toggle" : "data-candidate-effective-toggle";
        assert.equal(await page.locator(`[${selector}="${role}"]`).getAttribute("aria-pressed"), "true");
        assert.ok(actual.modes.filter(([range]) => range.endsWith(role) || (role === "exclude" && range === "manual:excludeErase")).every(([, value]) => value === mode));
      }
      assert.equal(actual.timerCount, 1, "both roles share one blink timer");
      const phase = await page.evaluate(() => {
        const before = state.blinkPhase; window.tickRangeDisplay(); flushRender();
        return { changed: state.blinkPhase !== before, matches: document.querySelector("#candidatePane").classList.contains("blink-phase") === state.blinkPhase };
      });
      assert.deepEqual(phase, { changed: true, matches: true });
    };
    await select("first");
    const rangeKeys = [
      ["Shift+A", "apply", "normal", "mosaicDetectionRanges"], ["Shift+S", "apply", "effective", "mosaicAppliedRanges"],
      ["Shift+D", "exclude", "normal", "exclusionDetectionRanges"], ["Shift+F", "exclude", "effective", "exclusionAppliedRanges"],
    ];
    for (const [key, role, mode] of rangeKeys) {
      await page.locator("#editorCanvas").focus();
      await page.keyboard.down("Shift"); await page.keyboard.down(key.split("+")[1]);
      assert.deepEqual((await snapshot()).roles, [[role, mode]], `${key} turns its role display ON`);
      await page.keyboard.down(key.split("+")[1]);
      assert.deepEqual((await snapshot()).roles, [[role, mode]], `${key} does not toggle repeatedly while held`);
      await page.keyboard.up(key.split("+")[1]); await page.keyboard.up("Shift");
      await page.keyboard.press(key);
      assert.deepEqual((await snapshot()).roles, [], `${key} turns the same display OFF`);
    }
    await page.locator("#brushSize").focus();
    for (const [key] of rangeKeys) await page.keyboard.press(key);
    assert.deepEqual((await snapshot()).roles, [], "range shortcuts do not run while an editor input owns focus");
    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabShortcuts").click();
    await page.locator("#settingsTabGeneral").click(); await page.locator("#settingsPort").focus();
    for (const [key] of rangeKeys) await page.keyboard.press(key);
    assert.deepEqual((await snapshot()).roles, [], "range shortcuts do not run behind a modal");
    await page.locator("#settingsTabShortcuts").click();
    for (const [key, , , action] of rangeKeys) {
      const input = page.locator(`[data-shortcut-action="${action}"]`);
      assert.equal(await input.inputValue(), key);
      assert.ok(await input.getAttribute("aria-label"), "each new shortcut has a translated name");
    }
    await page.locator('[data-shortcut-action="mosaicDetectionRanges"]').press("Control+Alt+A");
    await page.locator('[data-shortcut-enabled="mosaicDetectionRanges"]').uncheck();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.shortcuts.bindings.mosaicDetectionRanges === "Ctrl+Alt+A" && state.settings.shortcuts.actions.mosaicDetectionRanges === false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => appStartup);
    await select("first");
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Control+Alt+A");
    assert.deepEqual((await snapshot()).roles, [], "a saved per-action OFF blocks the remapped key after reload");
    await page.locator("#settingsButton").click(); await page.locator("#settingsTabShortcuts").click();
    assert.equal(await page.locator('[data-shortcut-action="mosaicDetectionRanges"]').inputValue(), "Ctrl+Alt+A");
    await page.locator('[data-shortcut-enabled="mosaicDetectionRanges"]').check();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.shortcuts.actions.mosaicDetectionRanges === true);
    await closeSettings();
    await page.keyboard.press("Shift+A");
    assert.deepEqual((await snapshot()).roles, [], "the former default key no longer activates a remapped action");
    await page.keyboard.press("Control+Alt+A");
    assert.deepEqual((await snapshot()).roles, [["apply", "normal"]]);
    await page.keyboard.press("Control+Alt+A");
    await page.locator("#settingsButton").click(); await page.locator("#settingsTabShortcuts").click();
    await page.locator("#settingsShortcutsEnabled").uncheck(); await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.navigationShortcutsEnabled === false);
    await closeSettings();
    for (const key of ["Control+Alt+A", "Shift+S", "Shift+D", "Shift+F"]) await page.keyboard.press(key);
    assert.deepEqual((await snapshot()).roles, [], "global OFF blocks all four range shortcuts");
    await page.locator("#settingsButton").click(); await page.locator("#settingsTabShortcuts").click();
    await page.locator("#settingsShortcutsEnabled").check(); await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.navigationShortcutsEnabled === true);
    await closeSettings();
    await page.keyboard.press("Control+Alt+A");
    await page.keyboard.press("Shift+F");
    await page.locator("#nextImageButton").click();
    await page.waitForFunction(() => state.currentId === "second" && !state.pendingImageId);
    await assertDisplay("second", "normal", "effective");
    await page.locator("#previousImageButton").click();
    await page.waitForFunction(() => state.currentId === "first" && !state.pendingImageId);
    await assertDisplay("first", "normal", "effective");
    await select("empty");
    assert.deepEqual(await snapshot(), { current: "empty", ids: [], modes: [], roles: [["apply", "normal"], ["exclude", "effective"]], timer: null, timerCount: 0 });
    const emptyDisplay = await snapshot();
    await page.locator("#editorCanvas").focus();
    for (const key of ["Control+Alt+A", "Shift+S", "Shift+D", "Shift+F"]) await page.keyboard.press(key);
    assert.deepEqual(await snapshot(), emptyDisplay, "disabled range buttons reject every shortcut on an empty image");
    await select("last");
    await assertDisplay("last", "normal", "effective");
    const beforeFailure = await snapshot();
    await page.locator('.gallery-item[data-id="broken"]').click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    assert.deepEqual(await snapshot(), beforeFailure, "failed image loading leaves the old display and timer intact");
    await page.locator("#errorDialogClose").click();
    await page.locator("#editorCanvas").focus();
    await page.keyboard.press("Shift+S");
    await page.keyboard.press("Shift+D");
    await select("second");
    await assertDisplay("second", "effective", "normal");
    // Removing a manual row clears that row, while the bulk preference stays ON.
    await page.locator('[data-candidate-blink-id="manual:apply"] .candidate-delete').click();
    assert.deepEqual((await snapshot()).roles, [["apply", "effective"], ["exclude", "normal"]]);
    await select("first");
    await assertDisplay("first", "effective", "normal");
    await page.locator('[data-candidate-effective-toggle="apply"]').click();
    await page.locator('[data-candidate-display-toggle="exclude"]').click();
    await select("second");
    assert.deepEqual((await snapshot()).ids, []);
    assert.deepEqual((await snapshot()).roles, []);
    await page.locator('[data-candidate-blink-id="second-apply"] .candidate-display-toggle').click();
    await select("first");
    assert.deepEqual((await snapshot()).ids, [], "individual range selections are not inherited");
    await page.locator('[data-candidate-display-toggle="apply"]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "editorCanvas", "bulk display clicks do not keep focus away from editor shortcuts");
    await page.locator("#batchMoreButton").click();
    await page.locator("#clearCatalogButton").click();
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => state.images.length === 0);
    assert.deepEqual((await snapshot()).roles, [], "catalog clear resets bulk display preferences");
    assert.equal((await snapshot()).timerCount, 0);
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});
