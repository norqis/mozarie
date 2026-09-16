// Every id-addressable control in static/index.html has one contract here.
// Dynamic template controls deliberately use data-* selectors and are exercised
// by the candidate, gallery, overview, model, and context-menu E2E cases.
const ids = `
projectButton projectClose projectNew projectName projectOpenList projectSourceAdd projectSourceRelink projectResume projectComplete projectCloseWorkspace projectListClose projectNameInput projectNameCancel projectNameConfirm sourceMismatchClear sourceMismatchCancel sourceMismatchConfirm sameSourceOpen sameSourceSeparate sameSourceCancel projectDeleteCancel projectDeleteConfirm nativeRelinkPath nativeRelinkCancel nativeRelinkConfirm pickFolder detectAllButton saveAllButton folderPath loadFolderButton pickImages pickFolderFiles settingsButton updateToast batchMoreButton clearAllMasksButton clearCatalogButton galleryFilterButton overviewButton collapseGalleryButton
brushTool bucketTool mosaicEraserTool eraserTool excludeBucketTool excludeEraserTool boundaryTool rectangleTool polygonTool boundaryBrushTool singleViewButton compareViewButton fitButton flipHorizontalButton flipVerticalButton undoButton redoButton mosaicPreviewButton brushSize mosaicHelpButton divisor bucketTolerance bucketToleranceDecrease bucketToleranceIncrease bucketToleranceClose
previousImageButton nextImageButton removeAndNextButton hideAndNextButton reviewAndNextButton boundaryDetectButton boundaryCancelButton collapseInspectorButton detectCurrentButton saveButton downloadCurrentMosaicMask downloadCurrentExcludeMask clearCurrentMasksButton removeCurrentImageButton detectTargetPenis detectTargetPussy confidence
candidatePaddingDecrease candidatePaddingInput candidatePaddingIncrease candidatePaddingReset candidatePaddingConfirm
closeOverviewButton batchModeButton overviewFilterButton overviewQuery overviewFolder selectionActionsButton selectionClearButton toggleReviewMenuItem copyImagePathMenuItem renameImageMenuItem removeImageMenuItem confirmNeverShow confirmCancel confirmAccept errorDialogClose
sourceDeleteResume
detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber detectCandidatePadding detectExcludeCandidatePadding detectFluidColorFillEnabled detectFluidColorFillTolerance detectCancelButton detectStartButton
settingsCloseButton settingsTabGeneral settingsTabModels settingsTabDisplay settingsTabShortcuts settingsTabConfirm settingsTabInfo settingsLanguage settingsPort settingsDefaultOutputDirectory settingsChooseOutputDirectory settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsTargetModel settingsNtd11Toggle settingsNtd11Model settingsSensitiveToggle settingsSensitiveModel settingsPrecisionToggle settingsSamType settingsSamModel settingsHandToggle settingsHandModel settingsHandSegmentationToggle settingsHandSegmentationModel settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy checkUpdateButton settingsResetButton settingsSaveButton
modelDownloadClose modelDownloadCopy modelDownloadStart modelDownloadCancel applyTargetMode applyCopyMode applyOverwriteMode applySuffix deleteOriginal applyPreserveDirectoryStructure applyOutputDirectoryStatus chooseOutputDirectoryButton applyDivisor applyOutputFormat applyKeepMetadata applyRemoveSaved applyCloseButton applyPauseButton applyCancelButton applyStartButton singleSaveCopyMode singleSaveOverwriteMode singleSaveSuffix singleSaveDeleteOriginal singleSavePreserveDirectoryStructure singleSaveOutputDirectoryStatus singleSaveChooseOutputDirectoryButton singleSaveOutputFormat singleSaveKeepMetadata singleSaveRemoveSaved singleSaveCloseButton singleSaveStartButton renameImageFilename renameImageCancel renameImageConfirm mosaicHelpCloseButton processingPauseButton processingCancelButton modelHelpCloseButton modelHelpCopy
importFailuresClose
`.trim().split(/\s+/);

// Text-entry controls are exercised with a real keyboard event.  Selects,
// switches, ranges, and numeric inputs receive input/change.  Every remaining
// id is a button-style activation.  The separate list keeps a new control from
// silently bypassing the interaction sweep.
const keyboardIds = new Set(`
projectNameInput nativeRelinkPath folderPath overviewQuery candidatePaddingInput settingsDefaultOutputDirectory settingsTargetModel settingsNtd11Model settingsSensitiveModel settingsSamModel settingsHandModel settingsHandSegmentationModel applySuffix applyOutputDirectoryStatus singleSaveSuffix singleSaveOutputDirectoryStatus renameImageFilename
`.trim().split(/\s+/));
const changeIds = new Set(`
  sourceMismatchClear brushSize divisor bucketTolerance confidence detectTargetPenis detectTargetPussy detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber detectCandidatePadding detectExcludeCandidatePadding detectFluidColorFillEnabled detectFluidColorFillTolerance overviewFolder confirmNeverShow settingsLanguage settingsPort settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsNtd11Toggle settingsSensitiveToggle settingsPrecisionToggle settingsSamType settingsHandToggle settingsHandSegmentationToggle settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy applyTargetMode applyCopyMode applyOverwriteMode deleteOriginal applyPreserveDirectoryStructure applyDivisor applyOutputFormat applyKeepMetadata applyRemoveSaved singleSaveCopyMode singleSaveOverwriteMode singleSaveDeleteOriginal singleSavePreserveDirectoryStructure singleSaveOutputFormat singleSaveKeepMetadata singleSaveRemoveSaved
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
  projectNameConfirm: "covered by the dedicated project UI runtime suite",
  sourceMismatchClear: "covered by the dedicated project UI runtime suite",
  sourceMismatchCancel: "covered by the dedicated project UI runtime suite",
  sourceMismatchConfirm: "covered by the dedicated project UI runtime suite",
  sameSourceOpen: "covered by the dedicated project UI runtime suite",
  sameSourceSeparate: "covered by the dedicated project UI runtime suite",
  sameSourceCancel: "covered by the dedicated project UI runtime suite",
  projectDeleteCancel: "covered by the dedicated project UI runtime suite",
  projectDeleteConfirm: "covered by the dedicated project UI runtime suite",
  downloadCurrentMosaicMask: "covered by the dedicated project UI runtime suite",
  downloadCurrentExcludeMask: "covered by the dedicated project UI runtime suite",
  candidatePaddingDecrease: "covered by the real-browser candidate padding scenario",
  candidatePaddingInput: "covered by the real-browser candidate padding scenario",
  candidatePaddingIncrease: "covered by the real-browser candidate padding scenario",
  candidatePaddingReset: "covered by the real-browser candidate padding scenario",
  candidatePaddingConfirm: "covered by the real-browser candidate padding scenario",
  bucketToleranceClose: "covered by the dedicated real-browser fill-tolerance scenario",
  confirmCancel: "covered by confirmation cancellation scenarios in the browser interaction suite",
};

function interactionFor(id) {
  const action = keyboardIds.has(id) ? "keyboard" : changeIds.has(id) ? "change" : "click";
  let resultKind = "dom";
  let scenario = "workspace";
  if (id === "importFailuresClose") {
    resultKind = "dialog"; scenario = "import";
  } else if (/^project/.test(id) || /^sourceMismatch/.test(id)) {
    resultKind = "dialog"; scenario = "workspace";
  } else if (/^(pickFolder|folderPath|loadFolderButton|pickImages|pickFolderFiles)/.test(id)) {
    resultKind = "dialog"; scenario = "import";
  } else if (/^(detect|confidence|boundaryDetectButton|boundaryCancelButton)/.test(id)) {
    resultKind = "api"; scenario = "detection";
  } else if (/^candidatePadding/.test(id)) {
    resultKind = "dom"; scenario = "candidate";
  } else if (/^(save|apply|deleteOriginal|chooseOutputDirectoryButton|singleSave)/.test(id)) {
    resultKind = "api"; scenario = "save";
  } else if (/^renameImage/.test(id)) {
    resultKind = id === "renameImageFilename" ? "value" : (id === "renameImageConfirm" ? "api" : "dialog"); scenario = "gallery";
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
  } else if (/^(previousImage|nextImage|removeAndNext|hideAndNext|reviewAndNext|clearAllMasks|clearCatalog|galleryFilter|batchMore|collapseGallery|sourceDeleteResume)/.test(id)) {
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
    ["[data-candidate-padding-batch]", "click", "dom", "candidate", "editor", "candidate:data-candidate-padding-batch", "opens batch candidate padding"],
    ["[data-candidate-display-toggle]", "click", "canvas", "candidate", "editor", "candidate:data-candidate-display-toggle", "changes candidate display visibility"],
    ["[data-candidate-effective-toggle]", "click", "canvas", "candidate", "editor", "candidate:data-candidate-effective-toggle", "changes effective candidate visibility"],
    ["[data-overview-filter]", "change", "navigation", "overview", "overview", "overview:data-overview-filter", "filters the overview fixture"],
    ["[data-selection-action]", "click", "api", "overview", "overview", "overview:data-selection-action", "applies an isolated selection action"],
    ["[data-project-sort]", "click", "navigation", "workspace", "workspace", "workspace:data-project-sort", "sorts the project table"],
    ["[data-project-action]", "click", "api", "workspace", "workspace", "workspace:data-project-action", "opens, exports, or deletes the selected project"],
    ["#projectBrowserRestoreList button", "click", "api", "workspace", "workspace", "workspace:projectBrowserRestoreList", "restores one browser project source"],
    ["#nativeRelinkSources button", "click", "dom", "workspace", "workspace", "workspace:nativeRelinkSources", "selects one native source to relink"],
    ["#sameSourceList button", "click", "dom", "workspace", "workspace", "workspace:sameSourceList", "selects one matching-source project"],
    [".gallery-item", "click", "navigation", "gallery", "workspace", "gallery:gallery-item", "selects the isolated gallery image"],
    [".overview-item", "click", "navigation", "overview", "overview", "overview:overview-item", "selects the isolated overview image"],
    ["[data-model-download]", "click", "dialog", "settings", "settings", "settings:data-model-download", "opens the model download dialog"],
    ["[data-model-help]", "click", "dialog", "settings", "settings", "settings:data-model-help", "opens model help"],
    ["[data-model-picker]", "click", "dialog", "settings", "settings", "settings:data-model-picker", "uses the picker fixture"],
    ["input[name=settingsSamVariant]", "change", "value", "settings", "settings", "settings:settingsSamVariant", "selects the SAM variant"],
    ["[data-shortcut-action]", "keyboard", "value", "settings", "settings", "settings:data-shortcut-action", "updates one shortcut binding"],
    ["[data-shortcut-enabled]", "change", "value", "settings", "settings", "settings:data-shortcut-enabled", "enables one shortcut action"],
    [".candidate-row .candidate-toggle", "click", "dom", "candidate", "editor", "candidate:candidate-toggle", "toggles one candidate row"],
    [".candidate-row .candidate-display-toggle", "click", "canvas", "candidate", "editor", "candidate:candidate-display-toggle", "shows one candidate row range"],
    [".candidate-row .candidate-effective-toggle", "click", "canvas", "candidate", "editor", "candidate:candidate-effective-toggle", "shows one candidate row effective range"],
    [".candidate-row .candidate-padding-button", "click", "dialog", "candidate", "editor", "candidate:candidate-padding-button", "opens one candidate row padding control"],
    [".candidate-row .candidate-forced", "click", "dom", "candidate", "editor", "candidate:candidate-forced", "toggles one exclusion candidate force state"],
    [".candidate-row .candidate-delete", "click", "api", "candidate", "editor", "candidate:candidate-delete", "removes one candidate row"],
  ].map(([selector, action, resultKind, scenario, fixture, assertionId, expected]) => ({ selector, action, resultKind, scenario, fixture, assertionId, predicateId: assertionId, expected })),
];

// Static controls without ids are separate operation variants. Keep every
// concrete value here so a newly added checkbox or button cannot be hidden
// behind one broad data-* selector in the interaction ledger.
const anonymousStaticControls = [
  ...["name", "created", "updated"].map((value) => `[data-project-sort="${value}"]`),
  ...["masked", "unmasked", "reviewed", "unreviewed", "hidden"].map((value) => `[data-gallery-filter="${value}"]`),
  ...["apply:toggle", "apply:delete", "exclude:toggle", "exclude:delete"].map((value) => `[data-candidate-batch="${value}"]`),
  ...["apply", "exclude"].flatMap((value) => [
    `[data-candidate-display-toggle="${value}"]`,
    `[data-candidate-effective-toggle="${value}"]`,
    `[data-candidate-padding-batch="${value}"]`,
  ]),
  ...["masked", "unmasked", "reviewed", "unreviewed", "hidden"].map((value) => `[data-overview-filter="${value}"]`),
  ...["remove", "hide", "show", "clear", "detect", "reviewed", "unreviewed"].map((value) => `[data-selection-action="${value}"]`),
  ".gallery-item",
  ".overview-item",
  ...["all", "target", "ntd11", "sensitive", "sam", "hand_detection", "hand_segmentation"].map((value) => `[data-model-download="${value}"]`),
  ...["target", "ntd11", "sensitive", "precision", "hand", "handSegmentation", "fluid"].map((value) => `[data-model-help="${value}"]`),
  ...["target_segmentation", "ntd11", "sensitive", "sam_checkpoint", "hand_detection", "hand_segmentation"].map((value) => `[data-model-picker="${value}"]`),
  ...["vit_b", "vit_l", "vit_h"].map((value) => `input[name="settingsSamVariant"][value="${value}"]`),
];

// Dynamic controls cannot be discovered from the static id sweep.  These
// markers tie each manifest contract to the DOM template or generator that
// creates it, so a removed operation fails this compact contract check.
const dynamicSurfaceContracts = [
  { selector: "[data-project-sort]", source: "static/index.html", markers: ['data-project-sort="name"', 'data-project-sort="created"', 'data-project-sort="updated"'] },
  { selector: "[data-project-action]", source: "static/js/app.js", markers: ["button.dataset.projectAction = action", 'projectActionButton(project, "open"', 'projectActionButton(project, "mosaic"', 'projectActionButton(project, "exclude"', 'projectActionButton(project, "delete"'] },
  { selector: "#projectBrowserRestoreList button", source: "static/js/app.js", markers: ['const list = $("#projectBrowserRestoreList")', "restoreBrowserProjectSource(source)"] },
  { selector: "#nativeRelinkSources button", source: "static/js/app.js", markers: ['const list = $("#nativeRelinkSources")', "nativeRelinkSourceId = item.id"] },
  { selector: "#sameSourceList button", source: "static/js/app.js", markers: ['const list = $("#sameSourceList")', "sameSourceSelectedProjectId = project.id"] },
  { selector: "[data-shortcut-action]", source: "static/js/settings.js", markers: ["input.dataset.shortcutAction = action", "input.addEventListener(\"keydown\""] },
  { selector: "[data-shortcut-enabled]", source: "static/js/settings.js", markers: ["enabled.dataset.shortcutEnabled = action"] },
  { selector: ".candidate-row .candidate-toggle", source: "static/js/editor-masks.js", markers: ['button.className = "candidate-toggle"', "actionRow.append(enabled"] },
  { selector: ".candidate-row .candidate-display-toggle", source: "static/js/editor-masks.js", markers: ['button.className = "candidate-display-toggle"'] },
  { selector: ".candidate-row .candidate-effective-toggle", source: "static/js/editor-masks.js", markers: ['button.className = "candidate-effective-toggle"'] },
  { selector: ".candidate-row .candidate-padding-button", source: "static/js/editor-masks.js", markers: ['button.className = "candidate-padding-button"'] },
  { selector: ".candidate-row .candidate-forced", source: "static/js/editor-masks.js", markers: ['button.className = "candidate-forced"'] },
  { selector: ".candidate-row .candidate-delete", source: "static/js/editor-masks.js", markers: ['remove.className = "candidate-delete"'] },
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
  anonymousStaticControls,
  dynamicControls,
  dynamicSurfaceContracts,
  scenarioContracts,
};
