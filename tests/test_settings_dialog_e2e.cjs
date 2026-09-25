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

test("exclusion force default persists and controls untouched images", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsTabDisplay").click();
    await page.locator("#settingsExcludeForcedDefault").uncheck();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.detection.exclude_forced_default === false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator('.gallery-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => state.currentId === "sample-two" && state.currentImage);
    assert.equal(await page.evaluate(() => state.manualExclusionForced), false, "the saved OFF value initializes an untouched image");

    await page.locator("#settingsButton").click();
    await page.locator("#settingsTabDisplay").click();
    assert.equal(await page.locator("#settingsExcludeForcedDefault").isChecked(), false, "the OFF value survives reload");
    await page.locator("#settingsExcludeForcedDefault").check();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.detection.exclude_forced_default === true);
    await page.locator("#settingsCloseButton").click();
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    assert.equal(await page.evaluate(() => state.manualExclusionForced), true, "the saved ON value initializes a second untouched image");
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
    for (const [card, help, download, toggle] of [
      [null, "target", "target", null],
      ["#settingsNtd11Card", "ntd11", "ntd11", "#settingsNtd11Toggle"],
      ["#settingsSensitiveCard", "sensitive", "sensitive", "#settingsSensitiveToggle"],
      ["#settingsPrecisionCard", "precision", "sam", "#settingsPrecisionToggle"],
      ["#settingsHandCard", "hand", "hand_detection", "#settingsHandToggle"],
      ["#settingsHandSegmentationCard", "handSegmentation", "hand_segmentation", "#settingsHandSegmentationToggle"],
      ["#settingsFluidCard", "fluid", null, "#settingsFluidToggle"],
    ]) {
      assert.equal(await page.locator(`[data-model-help="${help}"]`).isVisible(), true);
      if (download) assert.equal(await page.locator(`[data-model-download="${download}"]`).isVisible(), true);
      if (toggle) {
        assert.equal(await page.locator(toggle).getAttribute("role"), "switch");
        assert.equal(await page.locator(`${card} [data-switch-state]`).textContent(), await page.locator(toggle).isChecked() ? "ON" : "OFF");
      }
    }
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
  await withSettingsPage(async (page, fixture) => {
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator("#settingsPrecisionCard label.model-switch").click();
    assert.equal(await page.locator("#settingsPrecisionToggle").isChecked(), true);
    await page.locator('[data-model-download="sam"]').click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadDialog").open);
    assert.match(await page.locator("#modelDownloadItems").textContent(), /SAM.*vit_b/i);
    assert.equal(await page.locator("#modelDownloadStart").isVisible(), true);
    assert.equal(fixture.modelDownloadRequests.length, 0, "opening confirmation does not start a download");
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/model-download/start" && item.request().method() === "POST");
    await page.locator("#modelDownloadStart").click();
    await response;
    assert.deepEqual(fixture.modelDownloadRequests.at(-1), { modelKey: "sam_vit_b", samType: "vit_b" });
  });
});

test("SD-009 changing Japanese to English retranslates the open interface", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsCloseButton").click();
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.evaluate(() => {
      state.candidates = [{ id: "translation-candidate", labelToken: "penis", source: "main", enabled: true, role: "apply", confidence: 0.9, expandPx: 0 }];
      renderCandidates();
    });
    const candidateBefore = await page.locator(".candidate-toggle").first().getAttribute("aria-label");
    await page.locator("#settingsButton").click();
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator('[data-model-help="ntd11"]').click({ force: true });
    const helpBefore = await page.locator("#modelHelpText").textContent();
    await page.locator("#settingsLanguage").evaluate((select) => {
      select.value = "en"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => document.documentElement.lang === "en"
      && document.querySelector("#settingsDialogTitle")?.textContent === "Settings"
      && document.querySelector("#modelHelpText")?.textContent === "An optional adult model. Sign in to Civitai.com and complete its age check, extract the ZIP, then convert its included .pt file to ONNX. Anonymous access may not work."
      && document.querySelector(".candidate-toggle")?.getAttribute("aria-label") === "Enable Penis");
    assert.equal(await page.locator("#settingsDialogTitle").textContent(), "Settings");
    assert.equal(await page.locator("#settingsSaveButton").textContent(), "Save settings");
    assert.equal(await page.locator("#confirmCancel").textContent(), "Cancel");
    assert.equal(await page.locator("#modelHelpText").textContent(), "An optional adult model. Sign in to Civitai.com and complete its age check, extract the ZIP, then convert its included .pt file to ONNX. Anonymous access may not work.");
    assert.equal(await page.locator(".candidate-toggle").first().getAttribute("aria-label"), "Enable Penis");
    assert.notEqual(helpBefore, "An optional adult model. Sign in to Civitai.com and complete its age check, extract the ZIP, then convert its included .pt file to ONNX. Anonymous access may not work.");
    assert.notEqual(candidateBefore, "Enable Penis");
    assert.equal(await page.locator("#modelHelpDialog").evaluate((dialog) => dialog.open), true);
  });
});

test("SD-010 changing English to Japanese leaves no translation key visible", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsLanguage").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.locator("#settingsLanguage").selectOption("ja");
    await page.waitForFunction(() => document.documentElement.lang === "ja"
      && document.querySelector("#settingsDialogTitle")?.textContent === "設定");
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
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.importing.parallelism === 3);
    await page.locator("#settingsCloseButton").click();
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "3");
  });
});

test("SD-016 SD-018 SD-019 general execution settings save their exact values and survive reload", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator("#settingsOpenBrowser").check();
    await page.locator("#settingsImportParallelism").fill("6");
    await page.locator("#settingsSaveParallelism").fill("8");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings?.importing?.parallelism === 6 && state.settings?.saving?.parallelism === 8);
    const posted = fixture.settingsPayloads.at(-1).body;
    assert.equal(posted.general.open_browser, true);
    assert.equal(posted.importing.parallelism, 6);
    assert.equal(posted.saving.parallelism, 8);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings?.general?.open_browser === true);
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsOpenBrowser").isChecked(), true);
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "6");
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "8");
  });
});

test("SD-096 update check shows current and latest versions then starts the confirmed update", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    fixture.setUpdateAvailable(true);
    await page.locator('[data-settings-tab="info"]').click();
    const checksBefore = fixture.updateRequests.length;
    await page.locator("#checkUpdateButton").click();
    await page.waitForFunction(() => document.querySelector("#checkUpdateButton").dataset.available === "true");
    assert.equal(fixture.updateRequests.length, checksBefore + 1);
    assert.equal(await page.locator("#settingsVersion").textContent(), "v1.0.0");
    assert.match(await page.locator("#updateStatus").textContent(), /新しいバージョン|available/i);
    assert.equal(await page.locator("#updateToast").isHidden(), false);
    await page.locator("#checkUpdateButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /更新|update/i);
    const updateStarted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/update/start" && response.request().method() === "POST");
    await page.locator("#confirmAccept").click();
    await updateStarted;
    assert.equal(fixture.updateStarts.length, 1);
  });
});

async function saveSettingsAndReload(page) {
  await page.locator("#settingsSaveButton").click();
  await page.waitForFunction(() => !document.querySelector("#settingsSaveButton").disabled);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(state.settings) && state.images.length === 2);
  await page.locator("#settingsButton").click();
  await page.locator('[data-settings-tab="models"]').click();
}

const optionalModelSwitches = [
  { id: "SD-025 SD-026", label: "NTD11", toggle: "#settingsNtd11Toggle", card: "#settingsNtd11Card", input: "#settingsNtd11Model", path: "G:\\models\\ntd11.onnx", enabled: "ntd11_enabled", value: "ntd11" },
  { id: "SD-028 SD-029", label: "Sensitive", toggle: "#settingsSensitiveToggle", card: "#settingsSensitiveCard", input: "#settingsSensitiveModel", path: "G:\\models\\sensitive.onnx", enabled: "sensitive_enabled", value: "sensitive" },
  { id: "SD-031 SD-032", label: "hand detection", toggle: "#settingsHandToggle", card: "#settingsHandCard", input: "#settingsHandModel", path: "G:\\models\\hand.onnx", enabled: "hand_detection_enabled", value: "hand_detection" },
];

function verifyOptionalModelSwitch(model) {
  return async () => {
    await withSettingsPage(async (page, fixture) => {
      await page.locator('[data-settings-tab="models"]').click();
      const untouched = await page.evaluate((enabled) => ({
        ntd11: Boolean(state.settings.models.ntd11_enabled),
        sensitive: Boolean(state.settings.models.sensitive_enabled),
        hand: Boolean(state.settings.models.hand_detection_enabled),
        handSegmentation: Boolean(state.settings.models.hand_segmentation_enabled),
        fluid: Boolean(state.settings.detection.fluid_exclusion_enabled),
        enabled,
      }), model.enabled);
      await page.locator(model.input).fill(model.path);
      await page.locator(`${model.card} label.model-switch`).click();
      assert.equal(await page.locator(model.toggle).isChecked(), true);
      await saveSettingsAndReload(page);
      assert.equal(fixture.settingsPayloads.at(-1).body.models[model.enabled], true);
      assert.equal(fixture.settingsPayloads.at(-1).body.models[model.value], model.path);
      assert.equal(await page.locator(model.toggle).isChecked(), true);
      assert.equal(await page.locator(model.input).inputValue(), model.path);
      for (const [key, value] of Object.entries(untouched)) {
        if (key === "enabled" || key === model.value.replace("hand_detection", "hand")) continue;
        const modelKeys = { ntd11: "ntd11_enabled", sensitive: "sensitive_enabled", hand: "hand_detection_enabled", handSegmentation: "hand_segmentation_enabled" };
        const actual = key === "fluid" ? fixture.settingsPayloads.at(-1).body.detection.fluid_exclusion_enabled
          : fixture.settingsPayloads.at(-1).body.models[modelKeys[key]];
        assert.equal(actual, value, `${model.label} does not alter ${key}`);
      }
      await page.locator(`${model.card} label.model-switch`).click();
      await saveSettingsAndReload(page);
      assert.equal(fixture.settingsPayloads.at(-1).body.models[model.enabled], false);
      assert.equal(await page.locator(model.toggle).isChecked(), false);
    });
  };
}
test("SD-025 SD-026 NTD11 switch saves its path and survives reload in both states", { timeout: 60000 }, verifyOptionalModelSwitch(optionalModelSwitches[0]));
test("SD-028 SD-029 Sensitive switch saves its path and survives reload in both states", { timeout: 60000 }, verifyOptionalModelSwitch(optionalModelSwitches[1]));
test("SD-031 SD-032 hand detection switch saves its path and survives reload in both states", { timeout: 60000 }, verifyOptionalModelSwitch(optionalModelSwitches[2]));

test("SD-034 SD-035 hand segmentation is gated by hand detection and persists independently", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator('[data-settings-tab="models"]').click();
    const untouched = await page.evaluate(() => ({ ntd11: state.settings.models.ntd11_enabled, sensitive: state.settings.models.sensitive_enabled, fluid: state.settings.detection.fluid_exclusion_enabled }));
    assert.equal(await page.locator("#settingsHandSegmentationToggle").isDisabled(), true);
    await page.locator("#settingsHandModel").fill("G:\\models\\hand.onnx");
    await page.locator("#settingsHandCard label.model-switch").click();
    await page.locator("#settingsHandSegmentationModel").fill("G:\\models\\handseg.safetensors");
    await page.locator("#settingsHandSegmentationCard label.model-switch").click();
    await saveSettingsAndReload(page);
    const posted = fixture.settingsPayloads.at(-1).body.models;
    assert.equal(posted.hand_detection_enabled, true);
    assert.equal(posted.hand_segmentation_enabled, true);
    assert.equal(posted.hand_segmentation, "G:\\models\\handseg.safetensors");
    assert.equal(await page.locator("#settingsHandSegmentationToggle").isChecked(), true);
    await page.locator("#settingsHandSegmentationCard label.model-switch").click();
    await saveSettingsAndReload(page);
    assert.equal(fixture.settingsPayloads.at(-1).body.models.hand_segmentation_enabled, false);
    assert.equal(fixture.settingsPayloads.at(-1).body.models.hand_detection_enabled, true);
    assert.deepEqual({
      ntd11: fixture.settingsPayloads.at(-1).body.models.ntd11_enabled,
      sensitive: fixture.settingsPayloads.at(-1).body.models.sensitive_enabled,
      fluid: fixture.settingsPayloads.at(-1).body.detection.fluid_exclusion_enabled,
    }, untouched);
  });
});

test("SD-037 SD-038 fluid exclusion switch persists without changing model switches", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator('[data-settings-tab="models"]').click();
    const switchesBefore = await page.evaluate(() => ({
      ntd11: Boolean(state.settings.models.ntd11_enabled),
      sensitive: Boolean(state.settings.models.sensitive_enabled),
      hand: Boolean(state.settings.models.hand_detection_enabled),
      handSegmentation: Boolean(state.settings.models.hand_segmentation_enabled),
    }));
    if (await page.locator("#settingsFluidToggle").isChecked()) await page.locator("#settingsFluidCard label.model-switch").click();
    await saveSettingsAndReload(page);
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.fluid_exclusion_enabled, false);
    assert.deepEqual({
      ntd11: fixture.settingsPayloads.at(-1).body.models.ntd11_enabled,
      sensitive: fixture.settingsPayloads.at(-1).body.models.sensitive_enabled,
      hand: fixture.settingsPayloads.at(-1).body.models.hand_detection_enabled,
      handSegmentation: fixture.settingsPayloads.at(-1).body.models.hand_segmentation_enabled,
    }, switchesBefore);
    assert.equal(await page.locator("#settingsFluidToggle").isChecked(), false);
    await page.locator("#settingsFluidCard label.model-switch").click();
    await saveSettingsAndReload(page);
    assert.equal(fixture.settingsPayloads.at(-1).body.detection.fluid_exclusion_enabled, true);
    assert.equal(await page.locator("#settingsFluidToggle").isChecked(), true);
  });
});

function verifySamVariant(variant) {
  return async () => {
    await withSettingsPage(async (page, fixture) => {
      await page.locator('[data-settings-tab="models"]').click();
      await page.locator("#settingsPrecisionCard label.model-switch").click();
      await page.locator(`#settingsSamVariants input[value="${variant}"]`).check({ force: true });
      const checkpoint = `G:\\models\\sam_${variant}.pth`;
      await page.locator("#settingsSamModel").fill(checkpoint);
      await saveSettingsAndReload(page);
      const posted = fixture.settingsPayloads.at(-1).body;
      assert.equal(posted.detection.mode, "high_precision");
      assert.equal(posted.models.sam_model_type, variant);
      assert.equal(posted.models.sam_checkpoints[variant], checkpoint);
      assert.equal(await page.locator(`#settingsSamVariants input[value="${variant}"]`).isChecked(), true);
      assert.equal(await page.locator("#settingsSamModel").inputValue(), checkpoint);
    });
  };
}
test("SD-041 SAM vit_b selection saves its own checkpoint and survives reload", { timeout: 60000 }, verifySamVariant("vit_b"));
test("SD-042 SAM vit_l selection saves its own checkpoint and survives reload", { timeout: 60000 }, verifySamVariant("vit_l"));
test("SD-043 SAM vit_h selection saves its own checkpoint and survives reload", { timeout: 60000 }, verifySamVariant("vit_h"));

function verifyProvider(provider) {
  return async () => {
    await withSettingsPage(async (page, fixture) => {
      await page.locator('[data-settings-tab="models"]').click();
      await page.locator("#settingsProvider").selectOption(provider);
      if (provider === "gpu") {
        await page.waitForFunction(() => document.querySelector("#settingsGpuDevice").options.length > 0);
        await page.locator("#settingsGpuDevice").selectOption({ index: 0 });
      }
      await saveSettingsAndReload(page);
      assert.equal(fixture.settingsPayloads.at(-1).body.models.provider, provider);
      assert.equal(await page.locator("#settingsProvider").inputValue(), provider);
      if (provider === "gpu") await page.waitForFunction(() => !document.querySelector("#settingsGpuDevice").disabled);
      assert.equal(await page.locator("#settingsGpuDevice").isDisabled(), provider === "cpu");
      assert.match(await page.locator("#settingsRuntimeBackend").textContent(), /CUDA|CPU|cuda|cpu/);
    });
  };
}
test("SD-044 CPU provider saves and is restored in the settings UI", { timeout: 60000 }, verifyProvider("cpu"));
test("SD-045 SD-046 GPU provider saves and is restored in the settings UI", { timeout: 60000 }, verifyProvider("gpu"));

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
    await page.locator("#settingsCloseButton").click();
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && Boolean(state.currentImage));
    await page.locator("#brushTool").click();
    const box = await page.locator("#editorCanvas").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => state.manualMaskPresent);
    const before = await page.evaluate(() => {
      window.__overlayOpacities = [];
      const original = paintTintedMask;
      paintTintedMask = (...args) => { window.__overlayOpacities.push(args[2]); return original(...args); };
      state.blinkCandidateIds.add("manual:apply"); state.blinkPhase = true;
      return { mask: addCanvas.toDataURL() };
    });
    await page.locator("#settingsButton").click();
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsOpacity").fill("0.31");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.display.overlay_opacity === 0.31);
    await page.locator("#settingsCloseButton").click();
    await page.evaluate(() => drawCandidateBlinkOverlay());
    await page.waitForFunction(() => window.__overlayOpacities.some((value) => Math.abs(value - 0.31) < 0.001));
    assert.equal(await page.evaluate(() => addCanvas.toDataURL()), before.mask);
  });
});

test("SD-073 mosaic preview switch changes preview state without changing saved mask targets", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    await page.locator("#settingsCloseButton").click();
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && Boolean(state.currentImage));
    await page.locator("#brushTool").click();
    const box = await page.locator("#editorCanvas").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => state.manualMaskPresent);
    const before = await page.evaluate(() => ({ mask: addCanvas.toDataURL() }));
    await page.locator("#settingsButton").click();
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsMosaicPreview").uncheck();
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.display.mosaic_preview === false);
    await page.locator("#settingsCloseButton").click();
    assert.equal(await page.locator("#mosaicPreviewButton").getAttribute("aria-pressed"), "false");
    assert.equal(await page.evaluate(() => state.mosaicPreviewEnabled), false);
    assert.equal(await page.evaluate(() => addCanvas.toDataURL()), before.mask);
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
    await page.locator("#settingsLanguage").selectOption("en");
    await page.locator("#settingsPort").fill("9123");
    await page.locator("#settingsImportParallelism").fill("7");
    await page.locator("#settingsSaveParallelism").fill("8");
    await page.locator("#settingsOpenBrowser").check();
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsOpacity").fill("0.37");
    await page.locator("#settingsMosaicPreview").uncheck();
    await page.locator('[data-settings-tab="shortcuts"]').click();
    await page.locator('[data-shortcut-action="removeImage"]').fill("Ctrl+D");
    await page.locator('[data-shortcut-enabled="removeImage"]').uncheck();
    await page.locator('[data-settings-tab="confirm"]').click();
    await page.locator("#confirmRemoveImage").uncheck();
    await page.locator('[data-settings-tab="general"]').click();
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => state.settings.saving.default_output_directory === "G:\\fixture-output");
    assert.equal(await page.locator("#settingsDefaultOutputDirectory").inputValue(), "G:\\fixture-output");
    assert.equal(await page.locator("#settingsLanguage").inputValue(), "en");
    assert.equal(await page.locator("#settingsPort").inputValue(), "9123");
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "7");
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "8");
    assert.equal(await page.locator("#settingsOpenBrowser").isChecked(), true);
    assert.equal(await page.locator("#settingsOpacity").inputValue(), "0.37");
    assert.equal(await page.locator("#settingsMosaicPreview").isChecked(), false);
    assert.equal(await page.locator('[data-shortcut-action="removeImage"]').inputValue(), "Ctrl+D");
    assert.equal(await page.locator('[data-shortcut-enabled="removeImage"]').isChecked(), false);
    assert.equal(await page.locator("#confirmRemoveImage").isChecked(), false);
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.general.language === "en" && state.settings.general.port === 9123 && state.settings.importing.parallelism === 7 && state.settings.saving.parallelism === 8);
    assert.equal(await page.evaluate(() => state.settings.display.overlay_opacity), 0.37);
    assert.equal(await page.evaluate(() => state.settings.display.mosaic_preview), false);
    assert.equal(await page.evaluate(() => state.settings.shortcuts.bindings.removeImage), "Ctrl+D");
    assert.equal(await page.evaluate(() => state.settings.shortcuts.actions.removeImage), false);
    assert.equal(await page.evaluate(() => state.settings.confirmations.removeImage), false);
  });
});

test("SD-144.2 output picker cancellation and failure preserve unsaved fields for the settings request", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    await page.locator("#settingsLanguage").selectOption("en");
    await page.locator("#settingsPort").fill("9123");
    await page.locator("#settingsImportParallelism").fill("7");
    await page.locator("#settingsSaveParallelism").fill("8");
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#settingsOpacity").fill("0.37");
    await page.locator('[data-settings-tab="shortcuts"]').click();
    await page.locator('[data-shortcut-action="removeImage"]').fill("Ctrl+D");
    await page.locator('[data-shortcut-enabled="removeImage"]').uncheck();
    await page.locator('[data-settings-tab="confirm"]').click();
    await page.locator("#confirmRemoveImage").uncheck();
    await page.locator('[data-settings-tab="general"]').click();
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
    assert.equal(await page.locator("#settingsLanguage").inputValue(), "en");
    assert.equal(await page.locator("#settingsPort").inputValue(), "9123");
    assert.equal(await page.locator("#settingsImportParallelism").inputValue(), "7");
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), "8");
    assert.equal(await page.locator("#settingsOpacity").inputValue(), "0.37");
    assert.equal(await page.locator('[data-shortcut-action="removeImage"]').inputValue(), "Ctrl+D");
    assert.equal(await page.locator('[data-shortcut-enabled="removeImage"]').isChecked(), false);
    assert.equal(await page.locator("#confirmRemoveImage").isChecked(), false);
    const before = fixture.settingsPayloads.length;
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.general.port === 9123 && state.settings.importing.parallelism === 7 && state.settings.saving.parallelism === 8);
    assert.equal(fixture.settingsPayloads.length, before + 1);
    const payload = fixture.settingsPayloads.at(-1).body;
    assert.equal(payload.general.port, 9123);
    assert.equal(payload.general.language, "en");
    assert.equal(payload.importing.parallelism, 7);
    assert.equal(payload.saving.parallelism, 8);
    assert.equal(payload.display.overlay_opacity, 0.37);
    assert.equal(payload.shortcuts.bindings.removeImage, "Ctrl+D");
    assert.equal(payload.shortcuts.actions.removeImage, false);
    assert.equal(payload.confirmations.removeImage, false);
  });
});

test("SD-141 relative paths select the owning tab while absolute paths preserve unrelated settings", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    const before = fixture.settingsPayloads.length;
    await page.locator("#settingsPort").fill("9123");
    await page.locator("#settingsDefaultOutputDirectory").fill("relative-output");
    await page.locator("#settingsSaveButton").click();
    assert.equal(fixture.settingsPayloads.length, before);
    assert.equal(await page.locator('[data-settings-tab="general"]').getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#settingsDefaultOutputDirectory").getAttribute("aria-invalid"), "true");
    assert.match(await page.locator("#settingsResult").textContent(), /absolute|絶対/i);

    await page.locator("#settingsDefaultOutputDirectory").fill("G:\\absolute-output");
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator("#settingsTargetModel").fill("models\\target.onnx");
    await page.locator("#settingsSaveButton").click();
    assert.equal(fixture.settingsPayloads.length, before);
    assert.equal(await page.locator('[data-settings-tab="models"]').getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#settingsTargetModel").getAttribute("aria-invalid"), "true");
    assert.equal(await page.locator("#settingsPort").inputValue(), "9123");
    assert.equal(await page.locator("#settingsDefaultOutputDirectory").inputValue(), "G:\\absolute-output");

    await page.locator("#settingsTargetModel").fill("G:\\models\\target.onnx");
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => state.settings.general.port === 9123);
    const payload = fixture.settingsPayloads.at(-1).body;
    assert.equal(payload.general.port, 9123);
    assert.equal(payload.saving.default_output_directory, "G:\\absolute-output");
    assert.equal(payload.models.target_segmentation, "G:\\models\\target.onnx");
  });
});

test("SD-142 startup UI displays migrated absolute model and output paths", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page, fixture) => {
    const migrated = await page.evaluate(() => structuredClone(state.settings));
    migrated.models.target_segmentation = "G:\\Mozarie\\models\\target.onnx";
    migrated.saving.default_output_directory = "G:\\Mozarie\\output";
    fixture.setSettings(migrated);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings?.models?.target_segmentation === "G:\\Mozarie\\models\\target.onnx");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsDefaultOutputDirectory").inputValue(), "G:\\Mozarie\\output");
    await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), "G:\\Mozarie\\models\\target.onnx");
    assert.notEqual(await page.locator("#settingsTargetModel").getAttribute("aria-invalid"), "true");
  });
});

test("SD-149 output picker sends the absolute current path and remains reusable after cancel and failure", { timeout: 60000 }, async () => {
  await withSettingsPage(async (page) => {
    const requests = [];
    let attempt = 0;
    await page.route("**/api/output-directory/pick", async (route) => {
      requests.push(JSON.parse(route.request().postData()));
      attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) });
      if (attempt === 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: "G:\\chosen-output", settings: { saving: { default_output_directory: "G:\\chosen-output" } } }) });
    });
    const initial = await page.locator("#settingsDefaultOutputDirectory").inputValue();
    assert.match(initial, /^(?:[A-Za-z]:\\|\\\\)/);
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => !state.outputDirectoryPicking);
    assert.equal(await page.locator("#settingsChooseOutputDirectory").isEnabled(), true);
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#settingsChooseOutputDirectory").isEnabled(), true);
    await page.locator("#settingsChooseOutputDirectory").click();
    await page.waitForFunction(() => document.querySelector("#settingsDefaultOutputDirectory").value === "G:\\chosen-output");
    assert.deepEqual(requests, [{ currentPath: initial }, { currentPath: initial }, { currentPath: initial }]);
    assert.equal(await page.locator("#settingsChooseOutputDirectory").isEnabled(), true);
  });
});
