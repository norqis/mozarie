"use strict";

const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

let fixture; let browser; let context; let page;

before(async () => {
  fixture = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  fixture.resetScenario();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
});

afterEach(async () => { await context.close(); });
after(async () => { await browser.close(); await closeServer(fixture.server); });

async function select(id) {
  await page.locator(`.gallery-item[data-id="${id}"]`).click();
  await page.waitForFunction((imageId) => state.currentId === imageId && state.currentImage, id);
}

async function configureShortcut(action, binding, enabled = true) {
  await page.evaluate(({ action, binding, enabled }) => {
    state.settings.shortcuts.enabled = true;
    state.settings.general.shortcuts_enabled = true;
    state.navigationShortcutsEnabled = true;
    state.settings.shortcuts.bindings[action] = binding;
    state.settings.shortcuts.actions[action] = enabled;
  }, { action, binding, enabled });
}

async function drawStroke() {
  await page.locator("#brushTool").click();
  const box = await page.locator("#editorCanvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8);
  await page.mouse.up();
  await page.waitForFunction(() => state.historyIndex > 0 && !state.activeStroke && !document.querySelector("#undoButton").disabled);
}

async function assertNavigationSwitch({ id, action, key, start, enabledTarget, disabledTarget = start, extra }) {
  await select(start);
  await configureShortcut(action, key, true);
  await page.locator("#editorCanvas").focus();
  await page.keyboard.press(key);
  await page.waitForFunction(({ action, target }) => {
    if (action === "toggleOverview") return state.viewMode === target;
    if (action === "reviewAndNext") return state.currentId === target && state.images.find((image) => image.id === "sample")?.reviewed;
    return state.currentId === target;
  }, { action, target: enabledTarget });
  if (extra) await extra();
  if (action === "toggleOverview") await page.locator("#closeOverviewButton").click();
  await select(start);
  await configureShortcut(action, key, false);
  await page.locator("#editorCanvas").focus();
  await page.keyboard.press(key);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => state.currentId), disabledTarget, `${id} disabled action keeps the selected image`);
}

test("SD-075 disabled global shortcuts keep an edit unchanged while the Undo button restores it", { timeout: 60000 }, async () => {
  await select("sample");
  await drawStroke();
  const editedIndex = await page.evaluate(() => state.historyIndex);
  await page.evaluate(() => setNavigationShortcutsEnabled(false));
  await page.locator("#editorCanvas").focus();
  await page.keyboard.press("Control+Z");
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => state.historyIndex), editedIndex);
  await page.locator("#undoButton").click();
  await page.waitForFunction((index) => !state.historyRestoreBusy && state.historyIndex === index - 1, editedIndex);
});

const navigationCases = [
  ["SD-076", "previous", "P", "sample-two", "sample"],
  ["SD-077", "previous", "P", "sample-two", "sample"],
  ["SD-078", "next", "N", "sample", "sample-two"],
  ["SD-079", "previousVisible", "V", "sample-two", "sample"],
  ["SD-080", "nextVisible", "B", "sample", "sample-two"],
  ["SD-081", "first", "F", "sample-two", "sample"],
  ["SD-082", "last", "L", "sample", "sample-two"],
  ["SD-083", "reviewAndNext", "E", "sample", "sample-two"],
  ["SD-084", "toggleOverview", "G", "sample", "overview"],
];
for (const [id, action, key, start, target] of navigationCases) {
  test(`${id} shortcut performs the visible action only while its action switch is enabled`, { timeout: 60000 }, async () => {
    await assertNavigationSwitch({ id, action, key, start, enabledTarget: target });
  });
}

test("SD-085 Undo shortcut restores a real brush stroke only while enabled", { timeout: 60000 }, async () => {
  await select("sample"); await drawStroke();
  const edited = await page.evaluate(() => state.historyIndex);
  await configureShortcut("undo", "U", false); await page.locator("#editorCanvas").focus(); await page.keyboard.press("U");
  assert.equal(await page.evaluate(() => state.historyIndex), edited);
  await configureShortcut("undo", "U", true); await page.keyboard.press("U");
  await page.waitForFunction((target) => !state.historyRestoreBusy && state.historyIndex === target, edited - 1);
});

test("SD-086 Redo shortcut reapplies a real brush stroke only while enabled", { timeout: 60000 }, async () => {
  await select("sample"); await drawStroke();
  const edited = await page.evaluate(() => state.historyIndex);
  await page.locator("#undoButton").click();
  await page.waitForFunction((target) => !state.historyRestoreBusy && state.historyIndex === target, edited - 1);
  await configureShortcut("redo", "R", false); await page.locator("#editorCanvas").focus(); await page.keyboard.press("R");
  assert.equal(await page.evaluate(() => state.historyIndex), edited - 1);
  await configureShortcut("redo", "R", true); await page.keyboard.press("R");
  await page.waitForFunction((target) => !state.historyRestoreBusy && state.historyIndex === target, edited);
});

test("SD-087 duplicate shortcut values are rejected by the settings form without changing operations", { timeout: 60000 }, async () => {
  await select("sample");
  await page.locator("#settingsButton").click(); await page.locator('[data-settings-tab="shortcuts"]').click();
  await page.locator('[data-shortcut-action="previous"]').fill("Ctrl+K");
  await page.locator('[data-shortcut-action="next"]').fill("Ctrl+K");
  await page.locator("#settingsSaveButton").click();
  await page.waitForFunction(() => document.querySelector("#errorDialog").open);
  assert.equal(await page.evaluate(() => state.currentId), "sample");
  assert.equal(fixture.settingsPayloads.at(-1)?.body?.shortcuts?.bindings?.previous === "Ctrl+K", false);
});

test("SD-088 a focused text field receives navigation keys without moving the current image", { timeout: 60000 }, async () => {
  await select("sample"); await configureShortcut("next", "ArrowRight", true);
  await page.waitForFunction(() => !currentImageActionPending());
  await page.locator("#settingsButton").click();
  const port = page.locator("#settingsPort"); await port.focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => state.currentId), "sample");
  await page.locator("#settingsCloseButton").click();
  await page.waitForFunction(() => !document.querySelector("#settingsDialog").open && !currentImageActionPending());
  await page.locator("#editorCanvas").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "editorCanvas");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => state.currentId === "sample-two");
});

for (const [id, key] of [
  ["SD-089", "clearMasks"], ["SD-090", "clearCatalog"], ["SD-091", "removeImage"],
  ["SD-092", "candidateDelete"], ["SD-093", "candidateRoleDelete"], ["SD-094", "overwriteSource"],
  ["SD-095", "deleteSourceAfterCopy"],
]) {
  test(`${id} confirmation setting gates the real confirmation dialog without changing its operation target`, { timeout: 60000 }, async () => {
    await select("sample");
    await page.evaluate(({ key }) => {
      window.__confirmationOperation = { calls: 0, target: state.currentId };
      state.settings.confirmations[key] = true;
      void confirmAction("contract", "contract", key, () => { window.__confirmationOperation.calls += 1; });
    }, { key });
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(() => window.__confirmationOperation.calls === 1);
    const enabledTarget = await page.evaluate(() => window.__confirmationOperation.target);
    await page.evaluate(({ key }) => {
      state.settings.confirmations[key] = false;
      window.__confirmationOperation = { calls: 0, target: state.currentId };
      void confirmAction("contract", "contract", key, () => { window.__confirmationOperation.calls += 1; });
    }, { key });
    await page.waitForFunction(() => window.__confirmationOperation.calls === 1);
    assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), false);
    assert.deepEqual(await page.evaluate(() => ({ target: window.__confirmationOperation.target, current: state.currentId })), { target: enabledTarget, current: enabledTarget });
  });
}

test("SD-103 global shortcut disable blocks Redo while the Redo button still reapplies the edit", { timeout: 60000 }, async () => {
  await select("sample"); await drawStroke(); const edited = await page.evaluate(() => state.historyIndex);
  await page.locator("#undoButton").click(); await page.waitForFunction((target) => state.historyIndex === target, edited - 1);
  await page.evaluate(() => setNavigationShortcutsEnabled(false)); await page.locator("#editorCanvas").focus(); await page.keyboard.press("Control+Shift+Z");
  assert.equal(await page.evaluate(() => state.historyIndex), edited - 1);
  await page.locator("#redoButton").click(); await page.waitForFunction((target) => state.historyIndex === target, edited);
});

test("SD-104 global shortcut disable blocks arrow navigation while visible navigation buttons remain usable", { timeout: 60000 }, async () => {
  await select("sample"); await page.evaluate(() => setNavigationShortcutsEnabled(false)); await page.locator("#editorCanvas").focus();
  await page.keyboard.press("ArrowRight"); assert.equal(await page.evaluate(() => state.currentId), "sample");
  await page.locator("#nextImageButton").click(); await page.waitForFunction(() => state.currentId === "sample-two");
  await page.locator("#previousImageButton").click(); await page.waitForFunction(() => state.currentId === "sample");
});

test("SD-115 remapped remove shortcut replaces Delete and performs one source deletion", { timeout: 60000 }, async () => {
  await select("sample"); await configureShortcut("removeImage", "Ctrl+D", true);
  await page.evaluate(() => { state.settings.confirmations.removeImage = false; }); await page.locator('.gallery-item[data-id="sample"]').focus();
  await page.keyboard.press("Delete"); await page.waitForTimeout(80); assert.equal(fixture.sourceDeleteRequests.length, 0);
  await page.keyboard.press("Control+D"); await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
  assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), ["/api/catalog/delete-source/prepare", "/api/catalog/delete-source/claim", "/api/catalog/delete-source"]);
});

test("SD-116 duplicate remove shortcut does not dispatch two visible actions", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator("#settingsButton").click(); await page.locator('[data-settings-tab="shortcuts"]').click();
  await page.locator('[data-shortcut-action="previous"]').fill("Delete");
  await page.locator('[data-shortcut-action="removeImage"]').fill("Delete");
  await page.locator("#settingsSaveButton").click(); await page.waitForFunction(() => document.querySelector("#errorDialog").open);
  assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.currentId), "sample");
});

test("SD-117 editable controls and a noncurrent gallery card cannot start source deletion", { timeout: 60000 }, async () => {
  await select("sample");
  await page.locator("#settingsButton").click();
  const settingsControls = page.locator("#settingsDialog input, #settingsDialog textarea, #settingsDialog select, #settingsDialog button");
  let exercisedSettings = 0;
  for (let index = 0; index < await settingsControls.count(); index += 1) {
    const control = settingsControls.nth(index);
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    await control.focus(); await page.keyboard.press("Delete"); exercisedSettings += 1;
  }
  assert.ok(exercisedSettings >= 10, "every visible settings control category is exercised");
  await page.locator("#settingsCloseButton").click();
  const editorControls = page.locator('input:visible, textarea:visible, select:visible, button:visible:not(.gallery-item.current)');
  let exercisedEditor = 0;
  for (let index = 0; index < await editorControls.count(); index += 1) {
    const control = editorControls.nth(index);
    if (!await control.isEnabled()) continue;
    await control.focus(); await page.keyboard.press("Delete"); exercisedEditor += 1;
  }
  assert.ok(exercisedEditor >= 10, "visible editor inputs selects and buttons are exercised");
  await page.locator('.gallery-item[data-id="sample-two"]').focus(); await page.keyboard.press("Delete");
  await page.waitForTimeout(80); assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.currentId), "sample");
});

test("SD-118 Delete captured in the shortcut assignment field changes the field and does not delete an image", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator("#settingsButton").click(); await page.locator('[data-settings-tab="shortcuts"]').click();
  const input = page.locator('[data-shortcut-action="removeImage"]'); await input.focus(); await page.keyboard.press("Delete");
  assert.equal(await input.inputValue(), "Delete"); assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-119 an open dialog prevents the remove shortcut from starting its operation", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator('.gallery-item[data-id="sample"]').focus(); await page.locator("#settingsButton").click(); await page.keyboard.press("Delete");
  await page.waitForTimeout(80); assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-120 overview mode prevents Delete from removing the selected image", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator("#overviewButton").click(); await page.locator('.overview-item[data-id="sample"]').focus(); await page.keyboard.press("Delete");
  await page.waitForTimeout(80); assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-121 busy and importing states each prevent Delete from starting source deletion", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator('.gallery-item[data-id="sample"]').focus();
  for (const property of ["importing", "processing"]) {
    await page.evaluate((name) => { state[name] = name === "processing" ? { kind: "test" } : true; }, property);
    await page.keyboard.press("Delete"); await page.waitForTimeout(40);
    await page.evaluate((name) => { state[name] = name === "processing" ? null : false; }, property);
  }
  assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-122 read-only pending and changed-source states each prevent source deletion", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator('.gallery-item[data-id="sample"]').focus();
  const scenarios = [
    ["projectReadOnly", true], ["projectOperationPending", true], ["pendingImageId", "sample-two"], ["sourceDimensionsChanged", true],
  ];
  for (const [kind, value] of scenarios) {
    await page.evaluate(({ kind, value }) => { if (kind === "sourceDimensionsChanged") state.images.find((image) => image.id === state.currentId).sourceDimensionsChanged = value; else state[kind] = value; }, { kind, value });
    await page.keyboard.press("Delete"); await page.waitForTimeout(40);
    await page.evaluate((kind) => { if (kind === "sourceDimensionsChanged") state.images.find((image) => image.id === state.currentId).sourceDimensionsChanged = false; else state[kind] = kind === "pendingImageId" ? null : false; }, kind);
  }
  assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-123 holding Delete opens one confirmation and repeat keydowns create no delete requests", { timeout: 60000 }, async () => {
  await select("sample"); await page.locator('.gallery-item[data-id="sample"]').focus();
  await page.keyboard.down("Delete"); await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
  await page.keyboard.press("Delete"); await page.keyboard.up("Delete");
  assert.equal(fixture.sourceDeleteRequests.length, 0); await page.locator("#confirmCancel").click();
  assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-124 a failed peer deletion reconciles the visible batch while retaining the failed image", { timeout: 60000 }, async () => {
  fixture.setCatalog(["sample", "sample-two"].map((id) => ({
    id, relativePath: `${id}.png`, sourceKind: "filesystem", sourcePath: `G:\\fixture\\${id}.png`,
    width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false,
  })));
  fixture.setSourceDeleteCommitFailureIds(["sample"]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.settings && state.images.length === 2);
  await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
  await page.locator('.overview-item[data-id="sample"]').click(); await page.locator('.overview-item[data-id="sample-two"]').click();
  await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="remove"]').click();
  await page.waitForFunction(() => document.querySelector("#confirmDialog").open); await page.locator("#confirmAccept").click();
  await page.waitForFunction(() => state.images.length === 1);
  assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["sample"]);
});

test("SD-125 an unknown browser deletion remains pending and does not commit the catalog", { timeout: 60000 }, async () => {
  const token = "00000000-0000-4000-8000-000000000125";
  fixture.setSourceDeleteOperation(token, { state: "claimed", imageIds: ["sample-two"], preparedSourceKinds: { "sample-two": "session" } });
  await page.evaluate(async (deleteToken) => {
    await rememberPendingSourceDelete({ deleteToken, imageIds: ["sample-two"], browserDeletedImageIds: [], browserEntries: [{ imageId: "sample-two", name: "sample-two.png", state: "unknown", fileHandle: {}, parentHandle: {} }] });
    await resumePendingSourceDeletes();
  }, token);
  assert.deepEqual(await page.evaluate(async () => (await pendingSourceDeletes()).map((entry) => entry.browserEntries[0]?.state)), ["unknown"]);
  assert.equal(fixture.sourceDeleteRequests.length, 0); assert.equal(await page.evaluate(() => state.images.length), 2);
});

test("SD-125 a network disconnect during source deletion keeps the image and selection recoverable", { timeout: 60000 }, async () => {
  await select("sample");
  await page.route("**/api/catalog/delete-source", async (route) => route.abort("connectionfailed"));
  await page.locator('.gallery-item[data-id="sample"]').focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
  const disconnected = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/catalog/delete-source");
  await page.locator("#confirmAccept").click();
  await disconnected;
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["sample", "sample-two"]);
  assert.equal(await page.evaluate(() => state.currentId), "sample");
  assert.equal(await page.locator('.gallery-item[data-id="sample"]').getAttribute("aria-current"), "true");
});

test("SD-126 only the current gallery card can open confirmation and commit its source deletion", { timeout: 60000 }, async () => {
  await select("sample");
  await page.locator('.gallery-item[data-id="sample-two"]').focus(); await page.keyboard.press("Delete"); await page.waitForTimeout(50);
  assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), false);
  await page.locator('.gallery-item[data-id="sample"]').focus(); await page.keyboard.press("Delete"); await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
  await page.locator("#confirmAccept").click(); await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
  assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["sample-two"]);
});
