"use strict";

const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");
const defaults = require("../config/defaults.json");

let fixture; let browser; let context; let page; let originalSettings;
before(async () => {
  fixture = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
});
beforeEach(async () => {
  fixture.resetScenario();
  if (originalSettings) fixture.setSettings(originalSettings);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  originalSettings ||= await page.evaluate(() => state.settings);
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && state.currentImage && !currentImageActionPending());
  await page.locator("#editorCanvas").focus();
});
afterEach(async () => { await context.close(); });
after(async () => { await browser.close(); await closeServer(fixture.server); });

const tools = [
  ["mosaicBrush", "brush", "brushTool"], ["mosaicFill", "bucket", "bucketTool"], ["mosaicEraser", "mosaic_eraser", "mosaicEraserTool"],
  ["boundaryRectangle", "boundary", "rectangleTool"], ["boundaryPolygon", "polygon", "polygonTool"], ["boundaryBrush", "boundary_brush", "boundaryBrushTool"],
  ["exclusionBrush", "eraser", "eraserTool"], ["exclusionFill", "exclude_bucket", "excludeBucketTool"], ["exclusionEraser", "exclude_eraser", "excludeEraserTool"],
];
const keyFor = (action) => defaults.shortcuts.bindings[action].replace(/^Ctrl\+/, "Control+");
async function pressTool(action, tool, id) {
  await page.keyboard.press(keyFor(action));
  await page.waitForFunction((expected) => state.tool === expected, tool);
  assert.equal(await page.locator(`#${id}`).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "editorCanvas", "tool shortcuts keep canvas focus, including fill popovers");
}
async function closeSettings() {
  await page.locator("#settingsCloseButton").click();
  await page.waitForFunction(() => !document.querySelector("#settingsDialog").open && document.activeElement.id === "settingsButton");
  await page.locator("#editorCanvas").focus();
}

test("toolbar shortcuts select every drawing mode and cycle each group in visible order", { timeout: 60000 }, async () => {
  for (const entry of tools) await pressTool(...entry);
  for (const entry of [...tools.slice(0, 6), tools[0]]) {
    await pressTool("cycleMosaicTool", entry[1], entry[2]);
  }
  for (const entry of [...tools.slice(6), tools[6]]) {
    await pressTool("cycleExclusionTool", entry[1], entry[2]);
  }
  // Both cross-group directions always start at the first brush.
  await pressTool("mosaicEraser", "mosaic_eraser", "mosaicEraserTool");
  await pressTool("cycleExclusionTool", "eraser", "eraserTool");
  await pressTool("exclusionEraser", "exclude_eraser", "excludeEraserTool");
  await pressTool("cycleMosaicTool", "brush", "brushTool");
  await page.locator("#excludeEraserTool").click(); await page.keyboard.press("Q");
  assert.equal(await page.evaluate(() => state.tool), "brush", "Q follows a mouse-selected exclusion tool");
  await page.locator("#mosaicEraserTool").click(); await page.keyboard.press("W");
  assert.equal(await page.evaluate(() => state.tool), "eraser", "W follows a mouse-selected mosaic tool");
  await page.locator("#editorCanvas").focus(); await page.keyboard.press("B");
  await page.keyboard.press("T");
  assert.equal(await page.locator("#boundaryModeMenu").isVisible(), true);
  await page.keyboard.press("T");
  assert.equal(await page.locator("#boundaryModeMenu").isHidden(), true);
  await page.keyboard.down("q");
  assert.equal(await page.evaluate(() => state.tool), "bucket");
  await page.keyboard.down("q");
  assert.equal(await page.evaluate(() => state.tool), "bucket", "held Q never advances twice");
  await page.keyboard.up("q");
  await page.keyboard.down("w");
  assert.equal(await page.evaluate(() => state.tool), "eraser");
  await page.keyboard.down("w");
  assert.equal(await page.evaluate(() => state.tool), "eraser", "held W never advances twice");
  await page.keyboard.up("w");
});

test("toolbar view fit flip preview and history shortcuts perform their visible actions", { timeout: 60000 }, async () => {
  await page.keyboard.press("2");
  assert.equal(await page.locator("#compareViewButton").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("1");
  assert.equal(await page.locator("#singleViewButton").getAttribute("aria-pressed"), "true");
  const fitScale = await page.evaluate(() => state.view.scale);
  const canvas = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((scale) => state.view.scale !== scale, fitScale);
  await page.keyboard.press("F");
  await page.waitForFunction((scale) => state.view.scale === scale, fitScale);
  await page.keyboard.press("M");
  assert.equal(await page.locator("#mosaicPreviewButton").getAttribute("aria-pressed"), "false");
  await page.keyboard.press("M");
  assert.equal(await page.locator("#mosaicPreviewButton").getAttribute("aria-pressed"), "true");
  for (const [key, axis, button] of [["H", "flipH", "flipHorizontalButton"], ["V", "flipV", "flipVerticalButton"]]) {
    await page.keyboard.press(key);
    await page.waitForFunction((axis) => currentRecord()[axis] && !state.transformPending, axis);
    assert.equal(await page.locator(`#${button}`).getAttribute("aria-pressed"), "true");
    const historyIndex = await page.evaluate(() => state.historyIndex);
    await page.keyboard.press("Control+Z");
    await page.waitForFunction(({ axis, historyIndex }) => !state.historyRestoreBusy && !currentRecord()[axis] && state.historyIndex === historyIndex - 1, { axis, historyIndex });
    await page.keyboard.press("Control+Shift+Z");
    await page.waitForFunction(({ axis, historyIndex }) => !state.historyRestoreBusy && currentRecord()[axis] && state.historyIndex === historyIndex, { axis, historyIndex });
  }
});

test("toolbar shortcuts obey per-action global focus modal busy and disabled controls", { timeout: 60000 }, async () => {
  const allNew = Object.keys(defaults.shortcuts.bindings).filter((action) => !["previous", "next", "previousVisible", "nextVisible", "first", "last", "reviewAndNext", "removeImage", "toggleOverview", "undo", "redo", "renameImage"].includes(action));
  const snapshot = () => page.evaluate(() => ({ tool: state.tool, display: state.displayMode, preview: state.mosaicPreviewEnabled, flipH: currentRecord().flipH, flipV: currentRecord().flipV, menuHidden: document.querySelector("#boundaryModeMenu").hidden, view: { ...state.view } }));
  const unchanged = await snapshot();
  for (const action of allNew) {
    await page.evaluate((action) => { state.settings.shortcuts.actions[action] = false; }, action);
    await page.keyboard.press(keyFor(action));
    assert.deepEqual(await snapshot(), unchanged, `${action} disabled`);
    await page.evaluate((action) => { state.settings.shortcuts.actions[action] = true; }, action);
  }
  const before = await page.evaluate(() => ({ tool: state.tool, display: state.displayMode, preview: state.mosaicPreviewEnabled }));
  for (const status of ["global", "importing", "processing", "readonly", "disabled", "overview", "pending", "gesture"]) {
    await page.evaluate((status) => {
      if (status === "global") state.navigationShortcutsEnabled = false;
      if (status === "importing") state.importing = true;
      if (status === "processing") state.processing = { kind: "detect" };
      if (status === "readonly") { state.projectReadOnly = true; updateActionButtons(); }
      if (status === "disabled") document.querySelector("#bucketTool").disabled = true;
      if (status === "overview") setViewMode("overview");
      if (status === "pending") state.pendingImageId = "sample-two";
      if (status === "gesture") state.drawing = true;
    }, status);
    await page.keyboard.press(status === "disabled" ? "K" : "Q");
    assert.equal(await page.evaluate(() => state.tool), before.tool, status);
    await page.evaluate(() => {
      state.navigationShortcutsEnabled = true; state.importing = false; state.processing = false; state.projectReadOnly = false;
      state.pendingImageId = null; state.drawing = false;
      document.querySelector("#bucketTool").disabled = false; setViewMode("edit"); updateActionButtons(); focusCanvas();
    });
  }
  await page.locator("#brushSize").focus(); await page.keyboard.press("Q");
  assert.equal(await page.evaluate(() => state.tool), before.tool, "focused editor input owns its keys");
  await page.locator("#settingsButton").click();
  await page.locator("#settingsPort").focus(); await page.keyboard.press("Q");
  assert.equal(await page.evaluate(() => state.tool), before.tool, "modal input owns its keys");
  await closeSettings();
  await pressTool("cycleMosaicTool", "bucket", "bucketTool");
});

test("shortcut switches align after key inputs and preserve remapped disabled bindings after reload", { timeout: 60000 }, async () => {
  await page.locator("#settingsButton").click(); await page.locator("#settingsTabShortcuts").click();
  assert.equal(await page.locator("[data-shortcut-action]").count(), 30);
  const layout = await page.locator("#shortcutBindings > .form-row").evaluateAll((rows) => rows.map((row) => {
    const input = row.querySelector("[data-shortcut-action]"); const toggle = row.querySelector(".shortcut-switch");
    return { right: input.getBoundingClientRect().right, switchLeft: toggle.getBoundingClientRect().left, switchRight: toggle.getBoundingClientRect().right, border: getComputedStyle(row).borderBottomWidth, background: getComputedStyle(row).backgroundColor, role: toggle.querySelector("input").getAttribute("role") };
  }));
  assert.ok(layout.every((row) => row.right < row.switchLeft && row.switchRight === layout[0].switchRight && row.border === "1px" && row.role === "switch"));
  assert.notEqual(layout[0].background, layout[1].background);
  const input = page.locator('[data-shortcut-action="cycleMosaicTool"]');
  await input.press("Shift+Q");
  await input.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.shortcutEnabled), "cycleMosaicTool");
  await page.keyboard.press("Space");
  assert.equal(await page.locator('[data-shortcut-enabled="cycleMosaicTool"]').isChecked(), false);
  assert.equal(await page.locator('[data-shortcut-enabled="cycleMosaicTool"]').locator("..").locator("[data-switch-state]").textContent(), "OFF");
  await page.locator("#settingsShortcutsEnabled").uncheck();
  assert.equal(await page.locator("#settingsShortcutsEnabled").locator("..").locator("[data-switch-state]").textContent(), "OFF");
  await page.locator("#settingsShortcutsEnabled").check();
  await page.locator("#settingsSaveButton").click();
  await page.waitForFunction(() => state.settings.shortcuts.bindings.cycleMosaicTool === "Shift+Q" && !state.settings.shortcuts.actions.cycleMosaicTool);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  await page.locator('.gallery-item[data-id="sample"]').click();
  await page.waitForFunction(() => state.currentId === "sample" && state.currentImage && !currentImageActionPending());
  await page.locator("#editorCanvas").focus(); await page.keyboard.press("Shift+Q");
  assert.equal(await page.evaluate(() => state.tool), "brush");
  await page.locator("#settingsButton").click(); await page.locator("#settingsTabShortcuts").click();
  assert.equal(await input.inputValue(), "Shift+Q");
  await page.locator('[data-shortcut-enabled="cycleMosaicTool"]').check();
  await page.locator("#settingsSaveButton").click();
  await page.waitForFunction(() => state.settings.shortcuts.actions.cycleMosaicTool);
  await closeSettings();
  await page.keyboard.press("Q"); assert.equal(await page.evaluate(() => state.tool), "brush");
  await page.keyboard.press("Shift+Q"); await page.waitForFunction(() => state.tool === "bucket");
});
