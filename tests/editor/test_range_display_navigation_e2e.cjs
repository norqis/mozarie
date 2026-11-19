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

test("bulk range modes survive individual off disable deletion and role deletion across navigation", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch();
  const defaults = structuredClone(require("../../config/defaults.json"));
  defaults.confirmations.candidateDelete = false; defaults.confirmations.candidateRoleDelete = false;
  fixture.setSettings(defaults);
  try {
    for (const role of ["apply", "exclude"]) for (const mode of ["normal", "effective"]) for (const action of ["rangeOff", "disable", "delete", "deleteRole"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const label = `${role}/${mode}/${action}`;
      fixture.resetScenario(); fixture.setCatalog(["first", "second"].map(id => ({ id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 80, height: 60, candidateRevision: 1, reviewed: false, hidden: false })));
      try {
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        if (process.env.MOZARIE_JS_COVERAGE === "1") await page.coverage.startJSCoverage({ resetOnNavigation: false });
        await page.addInitScript(() => {
          const start = window.setInterval.bind(window), stop = window.clearInterval.bind(window);
          const timers = new Map(); let sequence = 0;
          window.setInterval = (callback, delay, ...args) => { if (delay !== 200) return start(callback, delay, ...args); const id = `range-${++sequence}`; timers.set(id, () => callback(...args)); return id; };
          window.clearInterval = id => { if (!timers.delete(id)) stop(id); };
          window.tickRangeDisplay = () => [...timers.values()].forEach(tick => tick()); window.rangeTimerCount = () => timers.size;
        });
        const assets = await page.evaluate(() => {
          const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 60; const c = canvas.getContext("2d");
          c.fillStyle = "#fff"; c.fillRect(0, 0, 80, 60); const source = canvas.toDataURL().split(",")[1];
          const masks = {};
          for (const [name, x] of [["apply-a", 5], ["apply-b", 25], ["exclude-a", 45], ["exclude-b", 65]]) { c.clearRect(0, 0, 80, 60); c.fillRect(x, 10, 15, 20); masks[name] = canvas.toDataURL().split(",")[1]; }
          return { source, masks };
        });
        const candidates = new Map(["first", "second"].map(imageId => [imageId, ["apply", "exclude"].flatMap(candidateRole => ["a", "b"].map(suffix => ({ id: `${imageId}-${candidateRole}-${suffix}`, role: candidateRole, enabled: true, forced: true, expandPx: 0, labelToken: candidateRole === "apply" ? "penis" : "hand", source: candidateRole === "apply" ? "target" : "hand_exclusion", refinement: null, confidence: .9, color: candidateRole === "apply" ? "#ff3d4d" : "#28d3ff" })))]));
        await page.route("**/api/image/*", route => route.fulfill({ contentType: "image/png", body: Buffer.from(assets.source, "base64") }));
        await page.route("**/api/mask/**", route => {
          const id = new URL(route.request().url()).pathname.split("/").at(-1); const key = id.slice(id.indexOf("-") + 1);
          return route.fulfill({ contentType: "image/png", body: Buffer.from(assets.masks[key], "base64") });
        });
        await page.route("**/api/candidates/*", route => {
          const id = new URL(route.request().url()).pathname.split("/").at(-1);
          return route.fulfill({ json: { candidates: candidates.get(id), candidateRevision: 1 } });
        });
        await page.route("**/api/candidate/**", route => {
          const parts = new URL(route.request().url()).pathname.split("/"); const imageId = parts.at(-2), id = parts.at(-1);
          Object.assign(candidates.get(imageId).find(candidate => candidate.id === id), route.request().postDataJSON());
          return route.fulfill({ json: { candidateRevision: 2 } });
        });
        await page.route("**/api/workspace/manual/*", route => route.request().method() === "GET" ? route.fulfill({ json: { draft: null, manualRevision: 0 } }) : route.continue());
        await page.goto(fixture.url, { waitUntil: "domcontentloaded" }); await page.evaluate(() => appStartup);
        await page.locator('.gallery-item[data-id="first"]').click(); await page.waitForFunction(() => state.currentId === "first" && !currentImageActionPending());
        await page.locator("#mosaicPreviewButton").click();
        const attribute = mode === "normal" ? "data-candidate-display-toggle" : "data-candidate-effective-toggle";
        const bulk = page.locator(`[${attribute}="${role}"]`); await bulk.click();
        const row = page.locator(`[data-candidate-blink-id="first-${role}-a"]`);
        if (action === "rangeOff") await row.locator(mode === "normal" ? ".candidate-display-toggle" : ".candidate-effective-toggle").click();
        else if (action === "disable") { await row.locator(".candidate-toggle").click(); await page.waitForFunction(() => !state.candidateUpdateChains.size && !currentImageActionPending()); }
        else if (action === "delete") await row.locator(".candidate-delete").click();
        else await page.locator(`[data-candidate-batch="${role}:delete"]`).click();
        await page.evaluate(() => flushWorkspaceDraft(state.currentId));
        assert.equal(await page.evaluate(role => state.blinkRoleModes.get(role), role), mode, `${label}: bulk preference survives`);
        if (action === "rangeOff") assert.equal(await bulk.getAttribute("aria-pressed"), "mixed", `${label}: current image keeps its mixed state`);
        const assertDestination = async () => {
          const stateView = await page.evaluate(({ role, mode }) => {
            const ids = state.candidates.filter(candidate => candidate.role === role && !state.removedCandidateIds.has(candidate.id)).map(candidate => candidate.id);
            const x = role === "apply" ? 10 : 50; const y = 20;
            const transformed = transformImagePoint({ x, y }); const ratio = canvas.width / stage.clientWidth;
            const px = Math.floor((state.view.x + transformed.x * state.view.scale) * ratio), py = Math.floor((state.view.y + transformed.y * state.view.scale) * ratio);
            const paint = () => { flushRender(); return [...ctx.getImageData(px, py, 1, 1).data]; };
            if (!state.blinkPhase) window.tickRangeDisplay(); const on = paint(); window.tickRangeDisplay(); const off = paint();
            return { ids, modes: ids.map(id => candidateDisplayMode(id)), selected: [...state.blinkCandidateIds].sort(), roleMode: state.blinkRoleModes.get(role), timerCount: window.rangeTimerCount(), on, off };
          }, { role, mode });
          assert.deepEqual(stateView.ids.sort(), [`second-${role}-a`, `second-${role}-b`], label);
          assert.deepEqual(stateView.modes, [mode, mode], label); assert.deepEqual(stateView.selected, stateView.ids.sort(), label);
          assert.equal(stateView.roleMode, mode, label); assert.equal(stateView.timerCount, 1, label);
          assert.notDeepEqual(stateView.on, stateView.off, `${label}: actual range overlay blinks`); assert.deepEqual(stateView.off, [255, 255, 255, 255], `${label}: off phase shows the source`);
          assert.equal(await bulk.getAttribute("aria-pressed"), "true", label);
        };
        await page.locator("#nextImageButton").click(); await page.waitForFunction(() => state.currentId === "second" && !currentImageActionPending()); await assertDestination();
        await page.locator("#previousImageButton").click(); await page.waitForFunction(() => state.currentId === "first" && !currentImageActionPending());
        assert.equal(await page.evaluate(role => state.blinkRoleModes.get(role), role), mode, `${label}: previous keeps the selected mode`);
        await page.locator("#nextImageButton").click(); await page.waitForFunction(() => state.currentId === "second" && !currentImageActionPending()); await assertDestination();
        await bulk.click(); await page.locator("#previousImageButton").click(); await page.waitForFunction(() => state.currentId === "first" && !currentImageActionPending());
        assert.equal(await page.evaluate(role => state.blinkRoleModes.has(role), role), false, `${label}: explicit bulk OFF is retained`);
        await page.locator("#nextImageButton").click(); await page.waitForFunction(() => state.currentId === "second" && !currentImageActionPending());
        assert.equal(await page.evaluate(() => state.blinkCandidateIds.size), 0, label); assert.equal(await page.evaluate(() => window.rangeTimerCount()), 0, label);
        await page.locator(`[data-candidate-blink-id="second-${role}-a"] .candidate-display-toggle`).click();
        await page.locator("#previousImageButton").click(); await page.waitForFunction(() => state.currentId === "first" && !currentImageActionPending());
        assert.equal(await page.evaluate(() => state.blinkCandidateIds.size), 0, `${label}: individual-only selections never carry over`);
        assert.deepEqual(errors, [], label);
        if (process.env.MOZARIE_JS_COVERAGE === "1" && process.env.MOZARIE_BROWSER_COVERAGE_FILE) await require("../test_import_picker_e2e.cjs").appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, await page.coverage.stopJSCoverage());
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await closeServer(fixture.server); }
});
