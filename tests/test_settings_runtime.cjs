const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const settingsPath = path.join(__dirname, "..", "static", "js", "settings.js");
const source = fs.readFileSync(settingsPath, "utf8");
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const attributes = new Map();
    elements.set(id, {
      id, value: "", textContent: "", hidden: false, disabled: false, checked: false, tabIndex: -1,
      dataset: {}, options: [], parentElement: null,
      classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, toggle(value, enabled) { if (enabled) this.values.add(value); else this.values.delete(value); }, contains(value) { return this.values.has(value); } },
      append(option) { this.options.push(option); }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, getAttribute(name) { return attributes.get(name) || null; },
      closest() { return null; }, matches() { return false; }, contains() { return false; }, addEventListener() {}, focus() {},
    });
  }
  return elements.get(id);
}
const tabs = ["general", "models", "display"].map((name, index) => {
  const tab = element(`tab-${name}`); tab.dataset.settingsTab = name; tab.tabIndex = index === 0 ? 0 : -1;
  return tab;
});
tabs[0].classList.add("active");
const panels = tabs.map((tab) => { const panel = element(`panel-${tab.dataset.settingsTab}`); panel.dataset.settingsPanel = tab.dataset.settingsTab; return panel; });
const samOutputs = ["missing", "type_mismatch", "invalid_format"].map((reason) => {
  const output = element(`sam-${reason}`); output.dataset.samStatus = reason;
  output.closest = () => ({ classList: { remove() {}, toggle() {} } });
  return output;
});
const modelPickers = ["sam_checkpoint", "target_segmentation"].map((key) => {
  const button = element(`picker-${key}`); button.dataset.modelPicker = key; button.dataset.modelInput = key === "sam_checkpoint" ? "settingsSamModel" : "settingsTargetModel";
  return button;
});
const shortcutBindings = [];
const shortcutEnabled = [];
const state = { settings: null, settingsStatus: { models: {} } };
const errors = [];
const context = {
  state, Map, Set, Promise, Object, Array, Number, String, Boolean, JSON, Math, Error, RegExp,
  document: {
    activeElement: element("invoker"),
    querySelectorAll(selector) {
      if (selector === ".settings-tab") return tabs;
      if (selector === "[data-settings-panel]") return panels;
      if (selector === "[data-sam-status]") return samOutputs;
      if (selector === "[data-model-picker]") return modelPickers;
      if (selector === "[data-shortcut-action]") return shortcutBindings;
      if (selector === "[data-shortcut-enabled]") return shortcutEnabled;
      return [];
    },
    createElement() { return element(`generated-${elements.size}`); },
  },
  $: element,
  t: (key) => key,
  isBusy: () => false,
  showModalFromInvoker(dialog, invoker) { context.modal = [dialog, invoker]; },
  showUserError(error, anchor) { errors.push([error, anchor]); },
  closeBoundaryModeMenu() {}, stage: { dataset: {} }, toolRail: { setAttribute() {}, getAttribute() { return "horizontal"; } },
  focusElement(item) { context.focused = item; },
  renderSamVariantStatuses() {}, renderSettingsStatus() {}, syncProviderSelection() {},
  setNavigationShortcutsEnabled() {}, setMosaicPreviewEnabled() {}, renderOutputDirectory() {}, applyToolPosition() {}, setDetectionConfidence() {}, setDetectionTargets() {}, syncDetectionActions() {}, loadTranslations: async () => {},
  validateDetectionTargets: () => true, detectionTargets: () => ["penis"], detectionParallelism: () => 2, normaliseDetectionConfidence: Number, normaliseImportParallelism: Number, settingsPayload: () => ({ ok: true }),
  pickOutputDirectory: async () => "", api: async () => ({ settings: { general: { language: "ja", shortcuts_enabled: true }, display: { mosaic_preview: true } }, version: "v1" }), clearInterval() {}, setInterval() { return 1; },
  confirmAction: async () => true,
};
vm.runInNewContext(source, context, { filename: settingsPath });
vm.runInNewContext("globalThis.settingsTest={renderModelStatus,renderSamVariantStatuses,selectedSamType,selectSamVariant,selectSettingsTab,moveSettingsTab,setToolRailTabStop,renderSettingsStatus,setSettingsForm,openSettings,saveSettings,resetSettings,chooseSettingsOutputDirectory,chooseSettingsModelFile,handleToolRailKeydown,modelDownloadInput,renderModelDownload,refreshModelDownload,showUnsupportedModelDownload,modelDownloadConfirmation,startModelDownload,beginModelDownload,cancelModelDownload,refreshSettingsStatus,checkForUpdate,startUpdate,samTypeFromPath,shortcutFromEvent,gpuMemoryLabel,modelCardEnabled,setHandSegmentationAvailable,setPrecisionDetectionEnabled,setFluidExclusionEnabled};", context, { filename: "test-settings-exports.js" });

(async () => {
  assert.equal(context.settingsTest.shortcutFromEvent({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, key: "a" }), "Ctrl+Shift+Alt+A", "shortcut capture normalizes modifiers and single letters");
  assert.equal(context.settingsTest.shortcutFromEvent({ ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, key: "ArrowLeft" }), "Ctrl+ArrowLeft", "shortcut capture accepts the platform modifier for named keys");
  assert.equal(context.settingsTest.gpuMemoryLabel(0), "", "missing GPU memory is not rendered as a capacity");
  assert.equal(context.settingsTest.gpuMemoryLabel(8 * 1024 ** 3), "8", "whole GPU GiB values avoid unnecessary decimals");
  assert.equal(context.settingsTest.gpuMemoryLabel(7.5 * 1024 ** 3), "7.5", "fractional GPU GiB values retain one useful decimal");
  element("#settingsHandToggle").checked = true; element("#settingsHandSegmentationToggle").checked = true;
  assert.equal(context.settingsTest.modelCardEnabled("hand_segmentation"), true, "hand segmentation requires both public model switches");
  element("#settingsHandToggle").checked = false;
  assert.equal(context.settingsTest.modelCardEnabled("hand_segmentation"), false, "hand segmentation is unavailable without hand detection");
  context.settingsTest.setHandSegmentationAvailable(false);
  assert.equal(element("#settingsHandSegmentationToggle").disabled, true, "turning off hand detection disables its dependent switch");
  context.settingsTest.setHandSegmentationAvailable(true);
  assert.equal(element("#settingsHandSegmentationToggle").disabled, false, "turning hand detection on re-enables its dependent switch");
  context.settingsTest.setPrecisionDetectionEnabled(true); context.settingsTest.setFluidExclusionEnabled(true);
  assert.equal(element("#settingsPrecisionToggle").checked, true);
  assert.equal(element("#settingsFluidToggle").checked, true);
  element("#settingsSamType").value = "vit_b"; element("#settingsSamModel").value = "base.pth";
  context.settingsTest.selectSamVariant("missing");
  assert.equal(element("#settingsSamType").value, "vit_b", "unknown SAM variants leave the configured model untouched");
  state.settingsStatus = { models: { unknown: { required: true, reasonCode: "missing" }, ntd11: { enabled: true, reasonCode: "missing" } }, gpuDeviceReasonCode: "unsupported" };
  context.settingsTest.renderModelStatus();
  assert.match(element("#settingsModelStatus").textContent, /settings\.ntd11Model/, "a known invalid model identifies its setting in the status summary");
  assert.match(element("#settingsModelStatus").textContent, /settings\.gpu/, "an unsupported GPU is shown beside model errors");
  state.settingsStatus = { models: { ntd11: { enabled: true, valid: true } }, samVariants: { missing: { reasonCode: "missing" }, type_mismatch: { reasonCode: "type_mismatch" }, invalid_format: { reasonCode: "invalid_format" } } };
  context.settingsTest.renderModelStatus();
  assert.equal(element("#settingsModelStatus").textContent, "", "all valid active models clear the status summary");

  context.settingsTest.selectSettingsTab("missing");
  const moved = { currentTarget: tabs[0], key: "ArrowLeft", preventDefault() { this.prevented = true; } };
  context.settingsTest.moveSettingsTab(moved);
  assert.equal(tabs.at(-1).classList.contains("active"), true, "left arrow wraps settings tabs to the final tab");
  assert.equal(moved.prevented, true, "a handled tab key prevents browser scrolling");
  const ignored = { currentTarget: tabs[0], key: "x", preventDefault() { this.prevented = true; } };
  context.settingsTest.moveSettingsTab(ignored);
  assert.equal(ignored.prevented, undefined, "unhandled tab keys keep their native behavior");

  let formLoads = 0;
  context.setSettingsForm = () => { formLoads += 1; };
  context.refreshSettingsStatus = async () => {};
  state.settings = null;
  await context.settingsTest.openSettings();
  assert.equal(formLoads, 2, "opening settings fetches once and renders the fetched settings before showing the dialog");
  assert.equal(element("#settingsVersion").textContent, "v1", "opening settings displays the fetched version");
  context.api = async () => { throw new Error("offline"); };
  state.settings = null;
  await context.settingsTest.openSettings();
  assert.equal(errors.at(-1)[0].message, "offline", "an initial settings load failure is surfaced to the user");

  context.validateDetectionTargets = () => false;
  element("#settingsResult").textContent = "old";
  await context.settingsTest.saveSettings({ preventDefault() {} });
  assert.equal(element("#settingsResult").classList.contains("error"), true, "saving with no detection target leaves a visible inline validation error");

  state.settings = { general: {}, models: { gpu_device: 0 }, display: {} };
  context.validateDetectionTargets = () => true;
  shortcutBindings.push(
    { dataset: { shortcutAction: "previous" }, value: "Ctrl+P" },
    { dataset: { shortcutAction: "next" }, value: "Ctrl+P" },
  );
  await context.settingsTest.saveSettings({ preventDefault() {} });
  assert.equal(errors.at(-1)[0].code, "input_invalid", "saving rejects duplicate shortcut bindings before sending settings");

  context.pickOutputDirectory = async () => { state.outputDirectoryHandle = { name: "output" }; return state.outputDirectoryHandle; };
  await context.settingsTest.chooseSettingsOutputDirectory();
  assert.equal(element("#settingsDefaultOutputDirectory").value, "", "choosing an output directory keeps the configured path separate from its browser-only handle");
  context.pickOutputDirectory = async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); };
  const errorsBeforeCancel = errors.length;
  await context.settingsTest.chooseSettingsOutputDirectory();
  assert.equal(errors.length, errorsBeforeCancel, "cancelling the native picker is silent");
  context.pickOutputDirectory = async () => { throw new Error("unavailable"); };
  await context.settingsTest.chooseSettingsOutputDirectory();
  assert.equal(errors.at(-1)[0].message, "unavailable", "a real output picker failure reaches the shared localized error presenter");

  const railEvent = { target: element("#brushTool"), key: "ArrowRight", preventDefault() { this.prevented = true; } };
  context.settingsTest.handleToolRailKeydown(railEvent);
  assert.equal(context.focused, element("#bucketTool"), "right arrow follows the mosaic toolbar order");
  context.settingsTest.handleToolRailKeydown({ target: element("#bucketTool"), key: "ArrowRight", preventDefault() {} });
  assert.equal(context.focused, element("#mosaicEraserTool"), "fill precedes the mosaic eraser in the roving toolbar order");
  context.settingsTest.handleToolRailKeydown({ target: element("#excludeBucketTool"), key: "ArrowRight", preventDefault() {} });
  assert.equal(context.focused, element("#excludeEraserTool"), "exclude fill precedes the exclusion eraser in the roving toolbar order");
  context.settingsTest.handleToolRailKeydown({ target: element("#eraserTool"), key: "ArrowLeft", preventDefault() {} });
  context.settingsTest.handleToolRailKeydown({ target: element("#eraserTool"), key: "Home", preventDefault() {} });
  context.settingsTest.handleToolRailKeydown({ target: element("#eraserTool"), key: "End", preventDefault() {} });
  context.settingsTest.handleToolRailKeydown({ target: element("#eraserTool"), key: "x", preventDefault() { throw new Error("unhandled tool key must not prevent default"); } });
  context.settingsTest.handleToolRailKeydown({ target: element("not-a-tool"), key: "ArrowRight", preventDefault() { throw new Error("unknown toolbar items keep native behavior"); } });

  element("#settingsSamType").value = "vit_b";
  element("#settingsSamModel").value = "old.pth";
  context.api = async () => ({ path: "new_vit_h.pth" });
  await context.settingsTest.chooseSettingsModelFile(modelPickers[0]);
  assert.equal(element("#settingsSamModel").value, "new_vit_h.pth", "choosing a SAM model updates its detected variant path");
  context.api = async () => { throw new Error("picker failed"); };
  await context.settingsTest.chooseSettingsModelFile(modelPickers[1]);
  assert.equal(errors.at(-1)[0].message, "picker failed", "a model picker failure is surfaced with its invoking button");

  assert.equal(context.settingsTest.modelDownloadInput("hand_detection"), "#settingsHandModel", "downloaded hand models map to their settings input");
  assert.equal(context.settingsTest.modelDownloadInput("unknown"), undefined, "unknown downloaded model keys do not target an input");
  element("#settingsSamType").value = "vit_h";
  context.settingsTest.renderModelDownload({ expected: 10, received: 4, phase: "download", current: "sam_vit_h", completed: 2, total: 3, state: "complete", paths: { sam_vit_h: "downloaded.pth", hand_detection: "hand.onnx", ignored: "skip" } });
  assert.equal(element("#settingsSamModel").value, "downloaded.pth", "completed downloads populate the selected SAM path");
  assert.equal(element("#settingsHandModel").value, "hand.onnx", "completed downloads populate supported auxiliary models");
  context.api = async () => { throw new Error("download status failed"); };
  await context.settingsTest.refreshModelDownload();
  assert.equal(errors.at(-1)[0].message, "download status failed", "download polling failures remain actionable");

  context.api = async (url) => url.includes("/start") ? { state: "complete", paths: {} } : { state: "complete", paths: {} };
  context.settingsTest.startModelDownload("sam");
  await context.settingsTest.beginModelDownload();

  context.settingsPayload = () => ({ status: true });
  context.api = async () => { throw new Error("status failed"); };
  await context.settingsTest.refreshSettingsStatus();
  assert.equal(errors.at(-1)[0].message, "status failed", "the current settings status failure is reported");
  context.api = async () => { throw new Error("update failed"); };
  await context.settingsTest.checkForUpdate();
  assert.equal(element("#updateStatus").classList.contains("error"), true, "a visible update check failure is shown inline");
  element("#checkUpdateButton").dataset.available = "true";
  await context.settingsTest.startUpdate();
  assert.equal(errors.at(-1)[0].message, "update failed", "an update start failure remains anchored to the update action");

  assert.equal(context.settingsTest.samTypeFromPath("models/sam_vit-h.pth"), "vit_h", "SAM file names select their matching variant");
  assert.equal(context.settingsTest.samTypeFromPath("models/sam_vit_b.pth"), "vit_b", "SAM base file names select the base variant");
  assert.equal(context.settingsTest.samTypeFromPath("models/sam_vit_l.pth"), "vit_l", "SAM large file names select the large variant");
  assert.equal(context.settingsTest.samTypeFromPath("models/other.pth"), null, "unrecognised model names do not guess a SAM variant");

  element("#settingsSamType").value = "";
  assert.equal(context.settingsTest.selectedSamType(), "vit_b", "an empty SAM selector falls back to the base variant");
  element("#settingsSamType").value = "vit_l";
  context.settingsTest.setToolRailTabStop(element("#fitButton"));
  assert.equal(element("#fitButton").tabIndex, 0, "the requested tool becomes the roving tab stop");
  context.settingsTest.setToolRailTabStop(element("#unknownTool"));
  assert.equal(element("#fitButton").tabIndex, 0, "an unrelated item does not replace the current roving stop");
  const boundaryMenu = element("#boundaryModeMenu");
  boundaryMenu.contains = (target) => target === boundaryMenu;
  context.settingsTest.handleToolRailKeydown({ target: boundaryMenu, key: "ArrowRight", preventDefault() { throw new Error("boundary menu keeps its own navigation"); } });
  boundaryMenu.contains = () => false;
  for (const event of [
    { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "1", expected: "1" },
    { ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, key: "F2", expected: "Shift+F2" },
  ]) assert.equal(context.settingsTest.shortcutFromEvent(event), event.expected);
  context.settingsTest.renderSettingsStatus({ runtimeBackend: "other", gpus: [{ id: 4, name: "Small", totalMemory: 0, supported: false }], gpuDeviceReasonCode: "unsupported" }, 4);
  assert.equal(element("#settingsRuntimeBackend").textContent, "other", "unknown runtime labels are preserved");
  const defaultSettings = { general: { language: "ja", open_browser: false, port: 8766, shortcuts_enabled: true }, models: { provider: "gpu", gpu_device: 0, target_segmentation: "", ntd11: "", ntd11_enabled: false, sensitive: "", sensitive_enabled: false, hand_detection: "", hand_detection_enabled: false, hand_segmentation_enabled: false, sam_checkpoints: {}, sam_model_type: "vit_b" }, display: { apply_color: "", exclude_color: "", overlay_opacity: 0, mosaic_preview: false }, importing: {}, saving: {}, detection: { mode: "standard", fluid_exclusion_enabled: false, exclude_forced_default: true, threshold: .5, targets: [] }, shortcuts: {}, confirmations: {} };
  context.settingsTest.setSettingsForm(defaultSettings, { models: {}, gpus: [] });
  assert.equal(element("#settingsImportParallelism").value, "3", "empty import settings use their public default");
  assert.equal(element("#detectParallelism").value, "2", "empty detection settings use their public default");
  context.api = async () => ({ state: "failed", errorCode: "download_failed", expected: 0, received: 0, paths: null });
  await context.settingsTest.refreshModelDownload();
  context.api = async () => { throw new Error("cancel download failed"); };
  await context.settingsTest.cancelModelDownload();
  context.settingsTest.showUnsupportedModelDownload("target");
  context.settingsTest.modelDownloadConfirmation("all");
  context.settingsTest.modelDownloadConfirmation("sam");
  element("#checkUpdateButton").dataset.available = "false";
  let checked = false;
  context.api = async (url) => { checked = url === "/api/update/status"; return { available: false, current: "v1" }; };
  await context.settingsTest.startUpdate();
  assert.equal(checked, true, "starting without an available update refreshes the status instead");
  console.log("test_settings_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
