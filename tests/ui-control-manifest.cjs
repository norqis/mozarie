// Every id-addressable control in static/index.html has one contract here.
// Dynamic template controls deliberately use data-* selectors and are exercised
// by the candidate, gallery, overview, model, and context-menu E2E cases.
const ids = `
projectButton projectClose projectNew projectName projectOpenList projectSourceSelect projectResume projectComplete projectMosaicZip projectExcludeZip projectDelete projectCloseWorkspace projectListClose projectSort projectNameInput projectNameCancel sourceMismatchClear sourceMismatchCancel sameSourceOpen sameSourceSeparate sameSourceCancel projectDeleteCancel projectDeleteConfirm pickFolder detectAllButton saveAllButton folderPath loadFolderButton pickImages pickFolderFiles settingsButton updateToast batchMoreButton clearAllMasksButton clearCatalogButton galleryFilter overviewButton collapseGalleryButton
brushTool bucketTool mosaicEraserTool eraserTool excludeBucketTool excludeEraserTool boundaryTool rectangleTool polygonTool boundaryBrushTool singleViewButton compareViewButton fitButton undoButton redoButton mosaicPreviewButton brushSize mosaicHelpButton divisor bucketTolerance
previousImageButton nextImageButton removeAndNextButton hideAndNextButton reviewAndNextButton boundaryDetectButton boundaryCancelButton collapseInspectorButton detectCurrentButton saveButton downloadCurrentMosaicMask downloadCurrentExcludeMask clearCurrentMasksButton removeCurrentImageButton detectTargetPenis detectTargetPussy confidence
closeOverviewButton batchModeButton overviewQuery overviewFolder selectionActionsButton selectionClearButton toggleReviewMenuItem copyImagePathMenuItem removeImageMenuItem confirmNeverShow confirmAccept errorDialogClose
detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber detectCancelButton detectStartButton
settingsCloseButton settingsTabGeneral settingsTabModels settingsTabDisplay settingsTabShortcuts settingsTabConfirm settingsTabInfo settingsLanguage settingsPort settingsDefaultOutputDirectory settingsChooseOutputDirectory settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsTargetModel settingsNtd11Toggle settingsNtd11Model settingsSensitiveToggle settingsSensitiveModel settingsPrecisionToggle settingsSamType settingsSamModel settingsHandToggle settingsHandModel settingsHandSegmentationToggle settingsHandSegmentationModel settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy checkUpdateButton settingsResetButton settingsSaveButton
modelDownloadClose modelDownloadCopy modelDownloadStart modelDownloadCancel applyTargetMode applyCopyMode applyOverwriteMode applySuffix deleteOriginal applyOutputDirectoryStatus chooseOutputDirectoryButton applyDivisor applyCloseButton applyPauseButton applyCancelButton applyStartButton singleSaveCopyMode singleSaveOverwriteMode singleSaveSuffix singleSaveDeleteOriginal singleSaveChooseOutputDirectoryButton singleSaveCloseButton singleSaveStartButton mosaicHelpCloseButton processingPauseButton processingCancelButton modelHelpCloseButton modelHelpCopy
`.trim().split(/\s+/);

// Text-entry controls are exercised with a real keyboard event.  Selects,
// switches, ranges, and numeric inputs receive input/change.  Every remaining
// id is a button-style activation.  The separate list keeps a new control from
// silently bypassing the interaction sweep.
const keyboardIds = new Set(`
projectNameInput folderPath overviewQuery settingsDefaultOutputDirectory settingsTargetModel settingsNtd11Model settingsSensitiveModel settingsSamModel settingsHandModel settingsHandSegmentationModel applySuffix applyOutputDirectoryStatus singleSaveSuffix
`.trim().split(/\s+/));
const changeIds = new Set(`
  projectSort sourceMismatchClear galleryFilter brushSize divisor bucketTolerance confidence detectTargetPenis detectTargetPussy detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber overviewFolder confirmNeverShow settingsLanguage settingsPort settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsNtd11Toggle settingsSensitiveToggle settingsPrecisionToggle settingsSamType settingsHandToggle settingsHandSegmentationToggle settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy applyTargetMode applyCopyMode applyOverwriteMode deleteOriginal applyDivisor singleSaveCopyMode singleSaveOverwriteMode singleSaveDeleteOriginal
`.trim().split(/\s+/));

const fixtureForScenario = {
  import: "import",
  detection: "detect",
  editor: "editor",
  overview: "overview",
  settings: "settings",
  save: "save",
  processing: "processing",
  confirmation: "confirmation",
  gallery: "workspace",
  candidate: "editor",
  workspace: "workspace",
};
const exemptReasons = {
  // A readonly status field has no product handler.  Its adjacent button is
  // the user operation that changes it and is covered by the save fixture.
  applyOutputDirectoryStatus: "readonly output-directory status; chooseOutputDirectoryButton is the operable control",
  settingsSamType: "hidden selected-SAM value; input[name=settingsSamVariant] is the operable control",
  // Project lifecycle needs both native directory handles and browser file
  // handles.  A compact VM browser-runtime suite exercises every branch,
  // including readonly/resume, all sorts, mismatch choices and deletion,
  // without making the canvas performance E2E reopen OS pickers.
  projectButton: "covered by the dedicated project UI runtime suite",
  projectClose: "covered by the dedicated project UI runtime suite",
  projectNew: "covered by the dedicated project UI runtime suite",
  projectName: "covered by the dedicated project UI runtime suite",
  projectOpenList: "covered by the dedicated project UI runtime suite",
  projectSourceSelect: "covered by the dedicated project UI runtime suite",
  projectResume: "covered by the dedicated project UI runtime suite",
  projectComplete: "covered by the dedicated project UI runtime suite",
  projectMosaicZip: "covered by the dedicated project UI runtime suite",
  projectExcludeZip: "covered by the dedicated project UI runtime suite",
  projectDelete: "covered by the dedicated project UI runtime suite",
  projectCloseWorkspace: "covered by the dedicated project UI runtime suite",
  projectListClose: "covered by the dedicated project UI runtime suite",
  projectSort: "covered by the dedicated project UI runtime suite",
  projectNameInput: "covered by the dedicated project UI runtime suite",
  projectNameCancel: "covered by the dedicated project UI runtime suite",
  sourceMismatchClear: "covered by the dedicated project UI runtime suite",
  sourceMismatchCancel: "covered by the dedicated project UI runtime suite",
  sameSourceOpen: "covered by the dedicated project UI runtime suite",
  sameSourceSeparate: "covered by the dedicated project UI runtime suite",
  sameSourceCancel: "covered by the dedicated project UI runtime suite",
  projectDeleteCancel: "covered by the dedicated project UI runtime suite",
  projectDeleteConfirm: "covered by the dedicated project UI runtime suite",
  downloadCurrentMosaicMask: "covered by the dedicated project UI runtime suite",
  downloadCurrentExcludeMask: "covered by the dedicated project UI runtime suite",
};

function interactionFor(id) {
  const action = keyboardIds.has(id) ? "keyboard" : changeIds.has(id) ? "change" : "click";
  let resultKind = "dom";
  let scenario = "workspace";
  if (/^project/.test(id) || /^sourceMismatch/.test(id)) {
    resultKind = "dialog"; scenario = "workspace";
  } else if (/^(pickFolder|folderPath|loadFolderButton|pickImages|pickFolderFiles)/.test(id)) {
    resultKind = "dialog"; scenario = "import";
  } else if (/^(detect|confidence|boundaryDetectButton|boundaryCancelButton)/.test(id)) {
    resultKind = "api"; scenario = "detection";
  } else if (/^(save|apply|deleteOriginal|chooseOutputDirectoryButton|singleSave)/.test(id)) {
    resultKind = "api"; scenario = "save";
  } else if (/^(settings|modelDownload|modelHelp)/.test(id)) {
    resultKind = /^settings(?:Language|Port|DefaultOutputDirectory|ImportParallelism|SaveParallelism|OpenBrowser|Provider|GpuDevice|TargetModel|Ntd11|Sensitive|Precision|Sam|Hand|Fluid|ApplyColor|ExcludeColor|Opacity|MosaicPreview|ExcludeForcedDefault|ShortcutsEnabled)/.test(id) ? "value" : "dialog";
    scenario = "settings";
  } else if (/^(brush|mosaicEraser|eraser|excludeEraser|boundaryTool|rectangleTool|polygonTool|boundaryBrushTool|bucketTool|excludeBucketTool|singleViewButton|compareViewButton|fitButton|undoButton|redoButton|mosaicPreviewButton|brushSize|divisor|bucketTolerance)/.test(id)) {
    resultKind = "canvas"; scenario = "editor";
  } else if (/^(overview|closeOverview|batchMode|overviewQuery|overviewFolder|selection)/.test(id)) {
    resultKind = "navigation"; scenario = "overview";
  } else if (/^(confirm|errorDialog)/.test(id)) {
    resultKind = "dialog"; scenario = "confirmation";
  } else if (/^(processing)/.test(id)) {
    resultKind = "api"; scenario = "processing";
  } else if (/^(previousImage|nextImage|removeAndNext|hideAndNext|reviewAndNext|clearAllMasks|clearCatalog|galleryFilter|batchMore|collapseGallery)/.test(id)) {
    resultKind = "dom"; scenario = "gallery";
  }
  const expected = `${resultKind} result is asserted by the ${scenario} fixture scenario`;
  // `assertionId` is deliberately a stable, inspectable link to the browser
  // ledger.  The ledger is allowed to use a fresh page for the same fixture,
  // but it may not silently treat a merely-present control as covered.
  const assertionId = `${scenario}:${id}`;
  return { action, resultKind, scenario, fixture: fixtureForScenario[scenario], assertionId, predicateId: assertionId, exemptReason: exemptReasons[id], expected };
}

const controls = ids.map((id) => ({ id, ...interactionFor(id) }));
const dynamicControls = [
  ...[
    ["[data-candidate-batch]", "click", "dom", "candidate", "editor", "candidate:data-candidate-batch", "selects the candidate batch"],
    ["[data-candidate-display-toggle]", "click", "canvas", "candidate", "editor", "candidate:data-candidate-display-toggle", "changes candidate display visibility"],
    ["[data-candidate-effective-toggle]", "click", "canvas", "candidate", "editor", "candidate:data-candidate-effective-toggle", "changes effective candidate visibility"],
    ["[data-overview-filter]", "change", "navigation", "overview", "overview", "overview:data-overview-filter", "filters the overview fixture"],
    ["[data-selection-action]", "click", "api", "overview", "overview", "overview:data-selection-action", "applies an isolated selection action"],
    [".gallery-item", "click", "navigation", "gallery", "workspace", "gallery:gallery-item", "selects the isolated gallery image"],
    [".overview-item", "click", "navigation", "overview", "overview", "overview:overview-item", "selects the isolated overview image"],
    ["[data-model-download]", "click", "dialog", "settings", "settings", "settings:data-model-download", "opens the model download dialog"],
    ["[data-model-help]", "click", "dialog", "settings", "settings", "settings:data-model-help", "opens model help"],
    ["[data-model-picker]", "click", "dialog", "settings", "settings", "settings:data-model-picker", "uses the picker fixture"],
    ["input[name=settingsSamVariant]", "change", "value", "settings", "settings", "settings:settingsSamVariant", "selects the SAM variant"],
  ].map(([selector, action, resultKind, scenario, fixture, assertionId, expected]) => ({ selector, action, resultKind, scenario, fixture, assertionId, predicateId: assertionId, expected })),
];

const scenarioContracts = Object.fromEntries([...new Set([...controls, ...dynamicControls].map((control) => control.scenario))].map((scenario) => {
  const scenarioControls = [...controls, ...dynamicControls].filter((control) => control.scenario === scenario);
  return [scenario, {
    controls: scenarioControls.map((control) => control.id || control.selector),
    assertions: [...new Set(scenarioControls.map((control) => `${control.resultKind}:${control.expected}`))],
  }];
}));

module.exports = {
  controls,
  dynamicControls,
  scenarioContracts,
};
