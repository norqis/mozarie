"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function withSettingsPage(run) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    const page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
    await run(page, fixture);
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

test("SD-001 settings dialog exposes its tabs and footer actions", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    assert.equal(await page.locator(".settings-tab").count(), 6);
    for (const selector of ["#settingsSaveButton", "#settingsResetButton", "#settingsCloseButton"]) {
      await page.locator(selector).waitFor({ state: "visible" });
    }
  });
});

function assertExclusiveSettingsPanel(tab, panel) {
  return async () => {
    await withSettingsPage(async (page) => {
      await page.locator(`[data-settings-tab="${tab}"]`).click();
      assert.equal(await page.locator(`[data-settings-tab="${tab}"]`).getAttribute("aria-selected"), "true");
      await page.locator(panel).waitFor({ state: "visible" });
      assert.equal(await page.locator(".settings-panel:visible").count(), 1);
    });
  };
}
test("SD-002 general tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("general", "#settingsPanelGeneral"));
test("SD-003 models tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("models", "#settingsPanelModels"));
test("SD-005 display tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("display", "#settingsPanelDisplay"));
test("SD-006 shortcuts tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("shortcuts", "#settingsPanelShortcuts"));
test("SD-007 confirm tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("confirm", "#settingsPanelConfirm"));
test("SD-008 info tab exclusively exposes its panel", { timeout: 60000 }, assertExclusiveSettingsPanel("info", "#settingsPanelInfo"));

test("SD-004 detection tab exposes every model switch help and preparation action", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await page.locator("#settingsPanelModels .model-card").count(), 7);
    assert.equal(await page.locator("#settingsPanelModels [data-model-help]").count(), 7);
    assert.equal(await page.locator("#settingsPanelModels [data-model-download]").count() >= 6, true);
    assert.equal(await page.locator("#settingsPanelModels [role=switch]").count(), 6);
  });
});

function assertModelHelp(key, { model, file, purpose, sourceHref = null, command = false, samTable = false }) {
  return async () => {
    await withSettingsPage(async (page) => {
      await page.locator('[data-settings-tab="models"]').click();
      await page.locator(`[data-model-help="${key}"]`).click();
      await page.waitForFunction(() => document.querySelector("#modelHelpDialog").open);
      assert.match(await page.locator("#modelHelpModel").textContent(), model);
      assert.match(await page.locator("#modelHelpFile").textContent(), file);
      assert.match(await page.locator("#modelHelpText").textContent(), purpose);
      assert.equal(await page.locator("#modelHelpCommandWrap").isHidden(), !command);
      assert.equal(await page.locator("#modelHelpSamTable").isHidden(), !samTable);
      if (samTable) assert.equal(await page.locator("#modelHelpSamTable tbody tr").count(), 3);
      assert.equal(await page.locator("#modelHelpSource").locator("xpath=..").isHidden(), !sourceHref);
      if (sourceHref) assert.match(await page.locator("#modelHelpSource").getAttribute("href"), sourceHref);
    });
  };
}
test("SD-063 target help shows purpose official model ONNX format and source", { timeout: 60000 }, assertModelHelp("target", { model: /anime-nsfw-segm-yolo26/i, file: /ONNX/i, purpose: /性器候補|genital candidates/i, sourceHref: /huggingface\.co\/01miku/ }));
test("SD-097 NTD11 help shows source and conversion command", { timeout: 60000 }, assertModelHelp("ntd11", { model: /Anime NSFW Detection/i, file: /ONNX/i, purpose: /成人向け|adult model/i, sourceHref: /civitai\.com/, command: true }));
test("SD-098 Sensitive help shows source and conversion command", { timeout: 60000 }, assertModelHelp("sensitive", { model: /sensitive/i, file: /ONNX/i, purpose: /見落としを補う|supplements the primary/i, sourceHref: /huggingface\.co\/sugarknight/, command: true }));
test("SD-099 SAM help shows source and all three variant rows", { timeout: 60000 }, assertModelHelp("precision", { model: /Segment Anything/i, file: /\.pth/i, purpose: /輪郭|outline/i, sourceHref: /github\.com\/facebookresearch/, samTable: true }));
test("SD-100 hand detection help shows whole-image model and ONNX source", { timeout: 60000 }, assertModelHelp("hand", { model: /anime_hand_detection/i, file: /ONNX/i, purpose: /画像全体|whole image/i, sourceHref: /huggingface\.co\/deepghs/ }));
test("SD-101 hand segmentation help shows HandSegNet safetensors source", { timeout: 60000 }, assertModelHelp("handSegmentation", { model: /HandSegNet/i, file: /safetensors/i, purpose: /手全体の輪郭|full hand-outline/i, sourceHref: /huggingface\.co\/Ov3rLoRd-MLEngineer/ }));
test("SD-102 fluid help shows that no additional model is required", { timeout: 60000 }, assertModelHelp("fluid", { model: /追加モデルなし|No additional model/i, file: /不要|Not required/i, purpose: /性器候補内の白色領域|white regions inside genital/i }));

test("SD-065 copied conversion command exactly matches the displayed command", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__copiedModelCommand = value; } },
    }));
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator('[data-model-help="ntd11"]').click();
    const displayed = await page.locator("#modelHelpCommand").textContent();
    await page.locator("#modelHelpCopy").click();
    await page.waitForFunction(() => Boolean(window.__copiedModelCommand));
    assert.equal(await page.evaluate(() => window.__copiedModelCommand), displayed);
  });
});

test("SD-064 closing model preparation returns to settings with its value intact", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator("#settingsNtd11Model").fill("G:\\models\\ntd11.onnx");
    await page.locator('[data-model-download="ntd11"]').click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadDialog").open);
    await page.locator("#modelDownloadClose").click();
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#settingsNtd11Model").inputValue(), "G:\\models\\ntd11.onnx");
  });
});

test("SD-066 model download confirmation names the selected model and exposes start", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator("#settingsPrecisionToggle").check();
    await page.locator('[data-model-download="sam"]').click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadDialog").open);
    assert.match(await page.locator("#modelDownloadItems").textContent(), /SAM.*vit_b/i);
    assert.equal(await page.locator("#modelDownloadStart").isVisible(), true);
  });
});

test("SD-009 changing Japanese to English retranslates the open interface", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsLanguage").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(await page.locator("#settingsDialogTitle").textContent(), "Settings");
    assert.equal(await page.locator("#settingsSaveButton").textContent(), "Save settings");
    assert.equal(await page.locator("#confirmCancel").textContent(), "Cancel");
  });
});

test("SD-010 changing English to Japanese leaves no translation key visible", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsLanguage").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.locator("#settingsLanguage").selectOption("ja");
    await page.waitForFunction(() => document.documentElement.lang === "ja");
    assert.equal(await page.locator("#settingsDialogTitle").textContent(), "設定");
    assert.equal(await page.locator("#settingsDialog").textContent().then((text) => /settings\.|dialog\./.test(text)), false);
  });
});

test("SD-011 saved settings are shown after closing and reopening", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsImportParallelism").fill("7");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.importing.parallelism === 7);
    await page.locator("#settingsCloseButton").click();
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "7");
  });
});

test("SD-012 saved settings survive a browser reload", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsSaveParallelism").fill("9");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.saving.parallelism === 9);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings?.saving?.parallelism === 9);
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "9");
  });
});

test("SD-013 resetting settings replaces edited controls with returned defaults", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const defaults = await page.evaluate(() => structuredClone(state.settings));
    defaults.importing.parallelism = 3;
    await page.route("**/api/settings/reset?status=0", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: defaults, version: "v1.0.0" }),
    }));
    await page.locator("#settingsImportParallelism").fill("17");
    await page.locator("#settingsResetButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsImportParallelism").value === "3");
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "3");
  });
});

test("SD-014 close returns to the editor image", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const currentId = await page.evaluate(() => state.currentId);
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    assert.equal(await page.evaluate(() => state.currentId), currentId);
    assert.equal(await page.locator("#editorCanvas").isVisible(), true);
  });
});

test("SD-015 Escape closes settings without dispatching an editor pointer action", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const before = await page.evaluate(() => ({ history: state.history.length, index: state.historyIndex }));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    assert.deepEqual(await page.evaluate(() => ({ history: state.history.length, index: state.historyIndex })), before);
  });
});

test("SD-072 overlay opacity changes display settings without changing mask ownership", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const before = await page.evaluate(() => state.images.map(({ id, candidateCount, enabledCandidateCount }) => ({ id, candidateCount, enabledCandidateCount })));
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsOpacity").fill("0.31");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.display.overlay_opacity === 0.31);
    assert.deepEqual(await page.evaluate(() => state.images.map(({ id, candidateCount, enabledCandidateCount }) => ({ id, candidateCount, enabledCandidateCount }))), before);
  });
});

test("SD-073 mosaic preview switch changes preview state without changing saved mask targets", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const before = await page.evaluate(() => state.images.map(({ id, hasEffectiveMask }) => ({ id, hasEffectiveMask })));
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsMosaicPreview").uncheck();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.display.mosaic_preview === false);
    assert.deepEqual(await page.evaluate(() => state.images.map(({ id, hasEffectiveMask }) => ({ id, hasEffectiveMask }))), before);
  });
});

function assertDuplicateShortcutRejected() {
  return async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator('[data-settings-tab="shortcuts"]').click();
    await page.locator('[data-shortcut-action="previous"]').fill("Ctrl+K");
    await page.locator('[data-shortcut-action="next"]').fill("Ctrl+K");
    const before = fixture.settingsPayloads.length;
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(fixture.settingsPayloads.length, before);
  });
  };
}
test("SD-087 duplicate shortcut bindings are rejected before settings submission", { timeout: 60000 }, assertDuplicateShortcutRejected());
test("SD-116 duplicate delete binding is explained without dispatching multiple actions", { timeout: 60000 }, assertDuplicateShortcutRejected());

test("SD-118 shortcut assignment records Delete without deleting an image", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const before = await page.evaluate(() => state.images.map((image) => image.id));
    await page.locator('[data-settings-tab="shortcuts"]').click();
    const input = page.locator('[data-shortcut-action="removeImage"]');
    await input.focus();
    await page.keyboard.press("Delete");
    assert.equal(await input.inputValue(), "Delete");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), before);
  });
});

test("SD-105 through SD-110 remove-image shortcut defaults save restore and reset", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator('[data-settings-tab="shortcuts"]').click();
    const binding = page.locator('[data-shortcut-action="removeImage"]');
    const enabled = page.locator('[data-shortcut-enabled="removeImage"]');
    assert.equal(await binding.inputValue(), "Delete");
    assert.equal(await enabled.isChecked(), true);
    await binding.fill("Ctrl+D");
    await enabled.uncheck();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.shortcuts.bindings.removeImage === "Ctrl+D" && state.settings.shortcuts.actions.removeImage === false);
    await page.locator('[data-settings-tab="shortcuts"]').click();
    assert.equal(await binding.inputValue(), "Ctrl+D");
    assert.equal(await enabled.isChecked(), false);
    const defaults = await page.evaluate(() => {
      const value = structuredClone(state.settings);
      value.shortcuts.bindings.removeImage = "Delete";
      value.shortcuts.actions.removeImage = true;
      return value;
    });
    await page.route("**/api/settings/reset?status=0", async (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ settings: defaults, version: "v1.0.0" }),
    }));
    await page.locator("#settingsResetButton").click();
    await page.waitForFunction(() => document.querySelector('[data-shortcut-action="removeImage"]').value === "Delete");
    assert.equal(await binding.inputValue(), "Delete");
    assert.equal(await enabled.isChecked(), true);
  });
});

for (const [id, key, selector] of [
  ["SD-089", "clearMasks", "#confirmClearMasks"], ["SD-090", "clearCatalog", "#confirmClearCatalog"],
  ["SD-091", "removeImage", "#confirmRemoveImage"], ["SD-092", "candidateDelete", "#confirmCandidateDelete"],
  ["SD-093", "candidateRoleDelete", "#confirmCandidateRoleDelete"], ["SD-094", "overwriteSource", "#confirmOverwriteSource"],
  ["SD-095", "deleteSourceAfterCopy", "#confirmDeleteSourceAfterCopy"],
]) {
  test(`${id} ${key} confirmation preference round-trips without changing its targets`, { timeout: 60000 }, async () => {
    await withSettingsPage(async (page) => {
      const before = await page.evaluate(() => state.images.map((image) => image.id));
      await page.locator('[data-settings-tab="confirm"]').click();
      await page.locator(selector).check();
      await page.locator("#settingsSaveButton").click();
      await page.waitForFunction((name) => state.settings.confirmations[name] === true, key);
      await page.locator('[data-settings-tab="confirm"]').click();
      await page.locator(selector).uncheck();
      await page.locator("#settingsSaveButton").click();
      await page.waitForFunction((name) => state.settings.confirmations[name] === false, key);
      assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), before);
    });
  });
}

test("SD-144.1 output picker updates only its path and preserves every unsaved general setting", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsPort").fill("9123");
    await page.locator("#settingsImportParallelism").fill("7");
    await page.locator("#settingsSaveParallelism").fill("8");
    await page.locator("#settingsOpenBrowser").check();
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => state.settings.saving.default_output_directory === "G:\\fixture-output");
    assert.equal(await page.locator("#settingsDefaultOutputDirectory").inputValue(), "G:\\fixture-output");
    assert.equal(await page.locator("#settingsPort").inputValue(), "9123");
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "7");
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "8");
    assert.equal(await page.locator("#settingsOpenBrowser").isChecked(), true);
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.general.port === 9123 && state.settings.importing.parallelism === 7 && state.settings.saving.parallelism === 8);
  });
});

test("SD-144.2 output picker cancellation and failure preserve unsaved fields for the settings request", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator("#settingsPort").fill("9123");
    await page.locator("#settingsImportParallelism").fill("7");
    await page.locator("#settingsSaveParallelism").fill("8");
    await page.route("**/api/output-directory/pick", async (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }),
    }));
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => !state.outputDirectoryPicking);
    await page.unroute("**/api/output-directory/pick");
    await page.route("**/api/output-directory/pick", async (route) => route.fulfill({
      status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }),
    }));
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#settingsPort").inputValue(), "9123");
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "7");
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "8");
    const before = fixture.settingsPayloads.length;
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.general.port === 9123 && state.settings.importing.parallelism === 7 && state.settings.saving.parallelism === 8);
    assert.equal(fixture.settingsPayloads.length, before + 1);
    const payload = fixture.settingsPayloads.at(-1).body;
    assert.equal(payload.general.port, 9123);
    assert.equal(payload.importing.parallelism, 7);
    assert.equal(payload.saving.parallelism, 8);
  });
});
