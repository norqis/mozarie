const modalInvokers = new WeakMap();

$("#errorDialogClose").addEventListener("click", () => $("#errorDialog").close());

function showModalFromInvoker(dialog, invoker = document.activeElement) {
  if (dialog.open) return;
  if (invoker?.isConnected && !invoker.disabled) modalInvokers.set(dialog, invoker);
  else modalInvokers.delete(dialog);
  dialog.showModal();
}

function trapModalTab(event) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.matches(':disabled') && !element.closest('[inert]') && !element.hidden && element.offsetParent !== null);
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  const first = focusable[0]; const last = focusable.at(-1);
  if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault(); focusElement(event.shiftKey ? last : first);
  }
}

function modelHelpInfo(key) {
  const source = (label, url) => ({ source: label, url });
  const conversionCommand = (model) => {
    const path = t(`modelHelp.${model}.conversionPath`);
    return `& ".\\.venv\\Scripts\\yolo.exe" export model="${path}" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu`;
  };
  const models = {
    target: { model: "01miku/anime-nsfw-segm-yolo26", file: ".onnx", ...source("Hugging Face", "https://huggingface.co/01miku/anime-nsfw-segm-yolo26") },
    ntd11: { model: "Anime NSFW Detection / ADetailer All-in-One", file: t("modelHelp.ntd11.file"), ...source("Civitai.com", "https://civitai.com/api/download/models/2350456?fileId=2240838"), command: conversionCommand("ntd11") },
    sensitive: { model: "sugarknight/sensitive-detect", file: ".pt → .onnx", ...source("Hugging Face", "https://huggingface.co/sugarknight/sensitive-detect"), command: conversionCommand("sensitive") },
    precision: { model: "Meta Segment Anything (SAM)", file: ".pth", ...source("Meta", "https://github.com/facebookresearch/segment-anything#model-checkpoints") },
    hand: { model: "deepghs/anime_hand_detection", file: ".onnx", ...source("Hugging Face", "https://huggingface.co/deepghs/anime_hand_detection") },
    handSegmentation: { model: "HandSegNet anime SDXL", file: ".safetensors", ...source("Hugging Face", "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl") },
    fluid: { model: t("modelHelp.noAdditionalModel"), file: t("modelHelp.notRequired"), source: "", url: "" },
  };
  return models[key];
}

function openModelHelp(key) {
  const info = modelHelpInfo(key);
  $("#modelHelpTitle").textContent = t(`modelHelp.${key}.title`);
  $("#modelHelpText").hidden = false;
  $("#modelHelpText").textContent = t(`modelHelp.${key}.text`);
  $("#modelHelpModel").textContent = info.model;
  $("#modelHelpFile").textContent = info.file;
  const source = $("#modelHelpSource"); source.textContent = info.source; source.href = info.url || "#";
  $("#modelHelpDetails").hidden = !info;
  source.closest("dd").hidden = !info.url; $("#modelHelpSourceLabel").hidden = !info.url;
  $("#modelHelpCommandWrap").hidden = !info.command;
  $("#modelHelpCommand").textContent = info.command || "";
  $("#modelHelpCopyResult").textContent = "";
  $("#modelHelpSamTable").hidden = key !== "precision";
  showModalFromInvoker($("#modelHelpDialog"));
}

async function copyCommand(commandId, resultId) {
  const result = $(resultId); result.textContent = "";
  try {
    await navigator.clipboard.writeText($(commandId).textContent);
    result.textContent = t("command.copied");
  } catch (error) { showUserError(error); }
}

let projectNameMode = "name";

function projectTitle(project) { return project?.name || t("project.unnamed"); }
function renderProjectCurrent() {
  const project = state.project;
  $("#projectCurrent").textContent = project ? `${projectTitle(project)} · ${t(`project.${project.status}`)}` : t("project.unnamed");
  $("#projectName").disabled = !project || state.projectReadOnly;
  $("#projectComplete").disabled = !project || state.projectReadOnly;
}
function openProjectNameDialog(mode) {
  projectNameMode = mode; $("#projectNameInput").value = mode === "name" ? (state.project?.name || "") : "";
  showModalFromInvoker($("#projectNameDialog")); focusElement($("#projectNameInput"));
}
async function showProjectList() {
  const sort = $("#projectSort").value;
  const data = await api(`/api/projects?sort=${encodeURIComponent(sort)}`);
  const list = $("#projectList"); list.replaceChildren();
  for (const project of data.projects || []) {
    const row = document.createElement("div"); row.className = "project-list-item";
    const open = document.createElement("button"); open.type = "button"; open.textContent = projectTitle(project);
    open.addEventListener("click", () => { void openProject(project); });
    const status = document.createElement("small");
    status.textContent = `${t(`project.${project.status}`)} · ${project.imageCount}`;
    const action = document.createElement("button"); action.type = "button"; action.textContent = t(project.status === "completed" ? "project.resume" : "project.openAction");
    action.addEventListener("click", () => { void openProject(project, project.status === "completed"); });
    row.append(open, action, status); list.append(row);
  }
  showModalFromInvoker($("#projectListDialog"));
}
async function showSourceMismatches() {
  const data = await api("/api/project/mismatches"); const images = data.images || [];
  if (!images.length) return;
  const list = $("#sourceMismatchList"); list.replaceChildren();
  for (const image of images) { const item = document.createElement("li"); item.textContent = image.relativePath; list.append(item); }
  $("#sourceMismatchClear").checked = false;
  const dialog = $("#sourceMismatchDialog");
  dialog.dataset.imageIds = JSON.stringify(images.map((image) => image.id));
  showModalFromInvoker(dialog);
}
async function openProject(project, resume = false) {
  try {
    if (resume) await api("/api/project/resume", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    const data = await api("/api/project/open", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    state.project = data.project; state.projectReadOnly = data.project?.status === "completed";
    $("#projectListDialog").close(); $("#projectDialog").close();
    if (data.needsSource) {
      const handle = await rememberedProjectSource(project.id);
      if (handle) await importDirectoryHandle(handle);
      else { resetCatalog([], ""); showUserError({ code: "source_restore_failed" }); }
    } else {
      resetCatalog(data.images || [], data.project?.sourceRoot || "");
      applyProjectSnapshot(await api("/api/images")); await showSourceMismatches();
    }
  } catch (error) { showUserError(error); }
}

function bindEvents() {
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("keydown", trapModalTab));
  $("#projectButton").addEventListener("click", () => { renderProjectCurrent(); showModalFromInvoker($("#projectDialog")); });
  $("#projectClose").addEventListener("click", () => $("#projectDialog").close());
  $("#projectNew").addEventListener("click", () => openProjectNameDialog("new"));
  $("#projectName").addEventListener("click", () => openProjectNameDialog("name"));
  $("#projectOpenList").addEventListener("click", () => { void showProjectList(); });
  $("#projectListClose").addEventListener("click", () => $("#projectListDialog").close());
  $("#projectSort").addEventListener("change", () => { void showProjectList(); });
  $("#projectCloseWorkspace").addEventListener("click", () => { void (async () => { try { await flushAllWorkspaceMutations(); await api("/api/project/close", { method: "POST", body: "{}" }); resetCatalog([], ""); state.project = null; state.projectReadOnly = false; $("#projectDialog").close(); } catch (error) { showUserError(error); } })(); });
  $("#projectComplete").addEventListener("click", () => { void (async () => { if (!await confirmAction(t("project.complete"), t("project.completeConfirm"))) return; try { await flushAllWorkspaceMutations(); await api("/api/project/complete", { method: "POST", body: "{}" }); resetCatalog([], ""); state.project = null; state.projectReadOnly = false; $("#projectDialog").close(); } catch (error) { showUserError(error); } })(); });
  $("#projectNameCancel").addEventListener("click", () => $("#projectNameDialog").close());
  $("#projectNameForm").addEventListener("submit", (event) => { event.preventDefault(); void (async () => { try { const name = $("#projectNameInput").value.trim(); const data = projectNameMode === "new" ? await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }) : await api("/api/project/name", { method: "POST", body: JSON.stringify({ name }) }); state.project = data.project; state.projectReadOnly = false; $("#projectNameDialog").close(); if (projectNameMode === "new") resetCatalog([], ""); renderProjectCurrent(); } catch (error) { showUserError(error); } })(); });
  $("#sourceMismatchCancel").addEventListener("click", () => $("#sourceMismatchDialog").close());
  $("#sourceMismatchForm").addEventListener("submit", (event) => { event.preventDefault(); void (async () => { try { const ids = JSON.parse($("#sourceMismatchDialog").dataset.imageIds || "[]"); const snapshot = await api("/api/project/mismatches", { method: "POST", body: JSON.stringify({ imageIds: ids, clearMasks: $("#sourceMismatchClear").checked }) }); state.images = snapshot.images || state.images; applyProjectSnapshot(snapshot); $("#sourceMismatchDialog").close(); renderCatalogViews(); } catch (error) { showUserError(error); } })(); });
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
    const invoker = modalInvokers.get(dialog);
    modalInvokers.delete(dialog);
    setTimeout(() => {
      if (invoker?.isConnected && !invoker.disabled && !dialog.open) focusElement(invoker);
    }, 0);
  }));
  const lightDismiss = (dialog, close) => {
    let backdropPointerId = null;
    const isBackdrop = (event) => {
      if (event.target !== dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener("pointerdown", (event) => { backdropPointerId = event.isPrimary && event.button === 0 && isBackdrop(event) ? event.pointerId : null; });
    dialog.addEventListener("pointerup", (event) => {
      const shouldClose = backdropPointerId === event.pointerId && isBackdrop(event);
      backdropPointerId = null;
      if (shouldClose) close();
    });
    dialog.addEventListener("pointercancel", () => { backdropPointerId = null; });
  };
  $("#settingsButton").addEventListener("click", () => { void openSettings(); });
  $("#updateToast").addEventListener("click", () => { void openSettings().then(() => selectSettingsTab("info")); });
  $("#settingsCloseButton").addEventListener("click", () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#settingsDialog").close(); });
  lightDismiss($("#settingsDialog"), () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("close", () => {
    const saved = state.settings;
    if (!saved?.models || !saved?.display || !saved?.detection) return;
    void (async () => {
      // Changing the select previews a language immediately.  Closing without
      // saving must restore both that language and the saved settings UI.
      await loadTranslations(saved.general.language);
      const focusBeforeRestore = document.activeElement;
      setSettingsForm(saved, state.settingsStatus);
      if (!$("#settingsDialog").open && focusBeforeRestore?.isConnected) focusElement(focusBeforeRestore);
      void refreshSettingsStatus();
    })();
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#settingsResetButton").addEventListener("click", () => { void resetSettings(); });
  $("#settingsChooseOutputDirectory").addEventListener("click", () => { void chooseSettingsOutputDirectory(); });
  document.querySelectorAll("[data-model-picker]").forEach((button) => button.addEventListener("click", () => { void chooseSettingsModelFile(button); }));
  document.querySelectorAll("[data-model-download]").forEach((button) => button.addEventListener("click", () => { void startModelDownload(button.dataset.modelDownload); }));
  $("#modelDownloadCancel").addEventListener("click", () => { void cancelModelDownload(); });
  $("#modelDownloadStart").addEventListener("click", () => { void beginModelDownload(); });
  $("#modelDownloadCopy").addEventListener("click", () => { void copyCommand("#modelDownloadCommand", "#modelDownloadCopyResult"); });
  $("#modelDownloadClose").addEventListener("click", () => $("#modelDownloadDialog").close());
  $("#modelDownloadDialog").addEventListener("cancel", (event) => { if (modelDownloadPoll) event.preventDefault(); else $("#modelDownloadDialog").close(); });
  $("#settingsProvider").addEventListener("change", syncProviderSelection);
  document.querySelectorAll('[data-settings-panel="models"] input, [data-settings-panel="models"] select').forEach((control) => {
    control.addEventListener("input", markModelStatusDirty);
    control.addEventListener("change", markModelStatusDirty);
  });
  document.querySelectorAll('input[name="settingsSamVariant"]').forEach((radio) => radio.addEventListener("change", () => {
    if (radio.checked) selectSamVariant(radio.value, true);
  }));
  $("#checkUpdateButton").addEventListener("click", () => { void startUpdate(); });
  document.querySelectorAll("[data-model-help]").forEach((button) => button.addEventListener("click", () => openModelHelp(button.dataset.modelHelp)));
  $("#modelHelpCopy").addEventListener("click", () => { void copyCommand("#modelHelpCommand", "#modelHelpCopyResult"); });
  $("#modelHelpCloseButton").addEventListener("click", () => $("#modelHelpDialog").close());
  $("#modelHelpDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#modelHelpDialog").close(); });
  lightDismiss($("#modelHelpDialog"), () => $("#modelHelpDialog").close());
  toolRail.addEventListener("keydown", handleToolRailKeydown);
  toolRailItems().forEach((item) => item.addEventListener("focus", () => setToolRailTabStop(item)));
  setToolRailTabStop();
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
    button.addEventListener("keydown", moveSettingsTab);
  });
  document.querySelectorAll("[data-model-toggle]").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      setModelCardEnabled(toggle.dataset.modelToggle, toggle.checked);
      if (toggle.dataset.modelToggle === "hand_detection") setHandSegmentationAvailable(toggle.checked);
    });
  });
  $("#settingsPrecisionToggle").addEventListener("change", () => {
    setPrecisionDetectionEnabled($("#settingsPrecisionToggle").checked);
    void refreshSettingsStatus();
  });
  $("#settingsFluidToggle").addEventListener("change", () => setFluidExclusionEnabled($("#settingsFluidToggle").checked));
  $("#pickImages").addEventListener("click", () => { void pickImageFiles(); });
  $("#pickFolderFiles").addEventListener("click", () => { void pickImageDirectory(); });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) void importDroppedFiles(event);
  });
  $("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
  $("#loadFolderButton").addEventListener("click", loadFolder);
  const detectAll = () => {
    if (!activeDetection()) openDetectionDialog(state.images.filter((image) => !isHidden(image)).map((image) => image.id));
  };
  $("#detectAllButton").addEventListener("click", detectAll);
  document.querySelectorAll("#dialogTargetPenis, #dialogTargetPussy").forEach((input) => input.addEventListener("change", () => validateDetectionTargets(detectionTargets("dialogTarget"), $("#detectTargetValidation"))));
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId], detectionConfidence(), 1, detectionTargets()));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#singleViewButton").addEventListener("click", () => setDisplayMode("single")); $("#compareViewButton").addEventListener("click", () => setDisplayMode("compare")); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#bucketTolerance").addEventListener("input", (event) => setFillColorTolerance(event.currentTarget.value));
  $("#bucketTolerance").addEventListener("change", () => { void saveFillColorTolerance(); });
  const splitter = $("#compareSplitter");
  const setCompareSplit = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    state.compareSplit = Math.max(.2, Math.min(.8, (clientX - rect.left) / rect.width));
    updateCompareSplitter(); render(); updateBrushCursor();
  };
  splitter.addEventListener("pointerdown", (event) => {
    if (state.displayMode !== "compare" || event.button !== 0) return;
    event.preventDefault(); splitter.setPointerCapture(event.pointerId); setCompareSplit(event.clientX);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) setCompareSplit(event.clientX);
  });
  const releaseCompareSplitterPointer = (event) => { if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId); };
  splitter.addEventListener("pointerup", releaseCompareSplitterPointer);
  splitter.addEventListener("pointercancel", releaseCompareSplitterPointer);
  splitter.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? .05 : .01;
    if (event.key === "ArrowLeft") state.compareSplit = Math.max(.2, state.compareSplit - step);
    else if (event.key === "ArrowRight") state.compareSplit = Math.min(.8, state.compareSplit + step);
    else if (event.key === "Home") state.compareSplit = .2;
    else if (event.key === "End") state.compareSplit = .8;
    else return;
    event.preventDefault(); updateCompareSplitter(); render(); updateBrushCursor();
  });
  $("#removeCurrentImageButton").addEventListener("click", () => { const image = currentRecord(); if (image) void setHidden(image, !isHidden(image)); });
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"); });
  $("#clearCatalogButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearCatalog(); });
  for (const [menuId, buttonId] of [["#batchMoreMenu", "#batchMoreButton"], ["#selectionActionsMenu", "#selectionActionsButton"]]) {
    $(menuId).addEventListener("toggle", () => $(buttonId).setAttribute("aria-expanded", String($(menuId).matches(":popover-open"))));
  }
  $("#galleryFilter").addEventListener("change", (event) => { if (isBusy() || state.importing) return; state.galleryFilter = event.currentTarget.value; renderGallery(); });
  $("#overviewButton").addEventListener("click", () => { if (!isBusy() && !state.importing) setViewMode("overview"); });
  $("#closeOverviewButton").addEventListener("click", () => setViewMode("edit"));
  $("#previousImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(-1)));
  $("#nextImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(1)));
  $("#reviewAndNextButton").addEventListener("click", () => { void runNavigationAction(reviewAndMoveNext); });
  $("#removeAndNextButton").addEventListener("click", () => { void removeImageFromCatalog(state.currentId); });
  $("#hideAndNextButton").addEventListener("click", () => { void hideAndMoveNext(); });
  document.querySelectorAll("[data-selection-action]").forEach((button) => button.addEventListener("click", () => { void runSelectionAction(button.dataset.selectionAction); }));
  $("#selectionClearButton").addEventListener("click", () => { state.batchMode = false; clearBatchSelection(); renderOverview(); updateSelectionActionBar(); });
  $("#batchModeButton").addEventListener("click", () => { state.batchMode = true; clearBatchSelection(); renderOverview(); updateSelectionActionBar(); });
  document.querySelectorAll("[data-candidate-batch]").forEach((button) => button.addEventListener("click", () => { void batchCandidateOperation(button.dataset.candidateBatch); }));
  document.querySelectorAll("[data-candidate-display-toggle]").forEach((button) => button.addEventListener("click", () => toggleCandidateDisplay(button.dataset.candidateDisplayToggle)));
  document.querySelectorAll("[data-candidate-effective-toggle]").forEach((button) => button.addEventListener("click", () => toggleCandidateEffective(button.dataset.candidateEffectiveToggle)));
  $("#settingsLanguage").addEventListener("change", async (event) => {
    const bindings = Object.fromEntries([...document.querySelectorAll("[data-shortcut-action]")].map((input) => [input.dataset.shortcutAction, input.value]));
    const actions = Object.fromEntries([...document.querySelectorAll("[data-shortcut-enabled]")].map((input) => [input.dataset.shortcutEnabled, input.checked]));
    await loadTranslations(event.target.value);
    renderShortcutBindings(bindings, actions);
  });
  document.querySelectorAll(".overview-filter").forEach((button) => button.addEventListener("click", () => {
    if (isBusy() || state.importing) return;
    state.overviewFilter = button.dataset.overviewFilter; renderOverview();
  }));
  let overviewQueryTimer = null;
  $("#overviewQuery").addEventListener("input", (event) => {
    state.overviewQuery = event.target.value;
    clearTimeout(overviewQueryTimer);
    overviewQueryTimer = setTimeout(() => renderOverview(), 120);
  });
  $("#overviewFolder").addEventListener("change", (event) => { state.overviewFolder = event.target.value; renderOverview(); });
  $("#brushTool").addEventListener("click", () => setTool("brush")); $("#mosaicEraserTool").addEventListener("click", () => setTool("mosaic_eraser")); $("#eraserTool").addEventListener("click", () => setTool("eraser"));
  $("#excludeEraserTool").addEventListener("click", () => setTool("exclude_eraser"));
  $("#boundaryTool").addEventListener("click", () => {
    setBoundaryModeMenuOpen($("#boundaryModeMenu").hidden);
  });
  $("#bucketTool").addEventListener("click", () => setTool("bucket"));
  $("#excludeBucketTool").addEventListener("click", () => setTool("exclude_bucket"));
  $("#rectangleTool").addEventListener("click", () => setTool("boundary"));
  $("#polygonTool").addEventListener("click", () => setTool("polygon"));
  $("#boundaryBrushTool").addEventListener("click", () => setTool("boundary_brush"));
  $("#boundaryDetectButton").addEventListener("click", () => {
    if (!canDetectBoundary()) return;
    void addBoundaryCandidate();
  });
  $("#boundaryCancelButton").addEventListener("click", cancelBoundary);
  $("#mosaicPreviewButton").addEventListener("click", () => setMosaicPreviewEnabled(!state.mosaicPreviewEnabled));
  $("#brushSize").addEventListener("input", () => updateBrushSize($("#brushSize").value));
  $("#divisor").addEventListener("input", () => {
    if (isBusy() || state.importing) return;
    const divisor = normaliseDivisor($("#divisor").value);
    $("#divisor").value = divisor;
    requestMosaicPreview(); updateBlockSizeDisplay(); render();
  });
  $("#applyDivisor").addEventListener("input", () => { if (!isBusy() && !state.importing) updateBlockSizeDisplay(); });
  $("#confidence").addEventListener("input", () => { if (!isBusy() && !state.importing) setDetectionConfidence($("#confidence").value); });
  $("#detectConfidenceRange").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceRange").value));
  $("#detectConfidenceNumber").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceNumber").value));
  document.querySelectorAll(".target-chip input").forEach((input) => input.addEventListener("change", () => {
    syncDetectionTargetSwitch(input);
    if (input.id.startsWith("dialog")) validateDetectionTargets(detectionTargets("dialogTarget"), $("#detectTargetValidation"));
    else validateDetectionTargets(detectionTargets(), $("#detectionTargetValidation"));
  }));
  $("#detectForm").addEventListener("submit", startDetectionFromDialog);
  $("#detectCancelButton").addEventListener("click", () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; $("#detectTargetValidation").hidden = true; });
  $("#detectDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#detectDialog").close(); state.pendingDetectionTargetIds = []; $("#detectTargetValidation").hidden = true; });
  lightDismiss($("#detectDialog"), () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; });
  $("#undoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex - 1)); $("#redoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex + 1));
  const grid = $(".studio-grid");
  const setPaneCollapsed = (side, collapsed) => {
    const isGallery = side === "gallery";
    const content = $(isGallery ? "#galleryPaneContent" : "#candidatePaneContent");
    const button = $(isGallery ? "#collapseGalleryButton" : "#collapseInspectorButton");
    const className = isGallery ? "gallery-collapsed" : "inspector-collapsed";
    state[isGallery ? "galleryCollapsed" : "inspectorCollapsed"] = collapsed;
    grid.classList.toggle(className, collapsed);
    content.inert = collapsed;
    content.setAttribute("aria-hidden", String(collapsed));
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = isGallery ? (collapsed ? "›" : "‹") : (collapsed ? "‹" : "›");
    const labelKey = isGallery
      ? (collapsed ? "workspace.expandGallery" : "workspace.collapseGallery")
      : (collapsed ? "workspace.expandInspector" : "workspace.collapseInspector");
    button.setAttribute("aria-label", t(labelKey));
    button.title = t(labelKey);
    requestAnimationFrame(() => { resizeRenderCanvas(); fitImage(); });
  };
  $("#collapseGalleryButton").addEventListener("click", () => setPaneCollapsed("gallery", !state.galleryCollapsed));
  $("#collapseInspectorButton").addEventListener("click", () => setPaneCollapsed("inspector", !state.inspectorCollapsed));
  setPaneCollapsed("gallery", false);
  setPaneCollapsed("inspector", false);
  $("#applyForm").addEventListener("submit", startApplyFromDialog);
  $("#chooseOutputDirectoryButton").addEventListener("click", chooseOutputDirectory);
  document.querySelectorAll('input[name="batchSaveMode"]').forEach((input) => input.addEventListener("change", syncApplyMode));
  $("#applyTargetMode").addEventListener("change", refreshApplyTargets);
  $("#mosaicHelpButton").addEventListener("click", () => {
    showModalFromInvoker($("#mosaicHelpDialog"));
  });
  $("#mosaicHelpCloseButton").addEventListener("click", () => $("#mosaicHelpDialog").close());
  lightDismiss($("#mosaicHelpDialog"), () => $("#mosaicHelpDialog").close());
  $("#applyCloseButton").addEventListener("click", () => $("#applyDialog").close());
  $("#applyPauseButton").addEventListener("click", () => {
    const paused = state.browserSave ? state.browserSave.paused : state.job?.state === "paused";
    controlApply(paused ? "resume" : "pause");
  });
  $("#applyCancelButton").addEventListener("click", () => controlApply("cancel"));
  $("#applyDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!state.applyRunning) $("#applyDialog").close(); });
  lightDismiss($("#applyDialog"), () => { if (!state.applyRunning) $("#applyDialog").close(); });
  $("#singleSaveForm").addEventListener("submit", startSingleSave);
  $("#singleSaveChooseOutputDirectoryButton").addEventListener("click", () => { void chooseSingleOutputDirectory(); });
  document.querySelectorAll('input[name="singleSaveMode"]').forEach((input) => input.addEventListener("change", syncSingleSaveMode));
  $("#singleSaveCloseButton").addEventListener("click", () => $("#singleSaveDialog").close());
  $("#singleSaveDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!state.saving) $("#singleSaveDialog").close(); });
  lightDismiss($("#singleSaveDialog"), () => { if (!state.saving) $("#singleSaveDialog").close(); });
  $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#confirmDialog").close("cancel"); });
  lightDismiss($("#confirmDialog"), () => $("#confirmDialog").close("cancel"));
  $("#processingDialog").addEventListener("cancel", (event) => event.preventDefault());
  $("#processingPauseButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing) return;
    if (processing.kind === "import") {
      const session = state.importSession; if (!session) return;
      session.paused = !session.paused;
      showProcessing({ ...processing, state: session.paused ? "paused" : "running" });
      return;
    }
    try {
      const job = await api(`/api/job/${processing.state === "paused" ? "resume" : "pause"}`, { method: "POST", body: JSON.stringify({}) });
      state.job = job; updateProgress(job); scheduleJobPoll(true);
    }
    catch (error) { showUserError(error, $("#processingPauseButton")); }
  });
  $("#processingCancelButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing || $("#processingCancelButton").disabled) return;
    $("#processingCancelButton").disabled = true;
    if (processing.kind === "import") { if (state.importSession) state.importSession.cancelled = true; return; }
    await cancelDetection();
  });
  $("#toggleReviewMenuItem").addEventListener("click", () => {
    const image = state.images.find((item) => item.id === state.contextMenuImageId);
    if (image) void setReviewed(image, !isReviewed(image));
    closeCatalogContextMenu();
  });
  $("#copyImagePathMenuItem").addEventListener("click", () => { void copyContextMenuImagePath(); });
  $("#removeImageMenuItem").addEventListener("click", () => { const image = state.images.find((item) => item.id === state.contextMenuImageId); if (image) void setHidden(image, !isHidden(image)); closeCatalogContextMenu(); });
  $("#gallery").addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragleave", (event) => {
    if (!$("#gallery").contains(event.relatedTarget)) setGalleryDropOverlay(false);
  });
  $("#gallery").addEventListener("drop", importDroppedFiles);

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    if (event.button === 1) {
      canvas.setPointerCapture(event.pointerId); state.panning = true; state.pointer = { x: event.clientX, y: event.clientY }; canvas.style.cursor = "grabbing"; updateBrushCursor(); return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    state.gestureDisplaySide = compareEventSide(event);
    const rawPoint = pointFromEvent(event); const point = clampPoint(rawPoint);
    state.drawing = true; state.pointer = point; state.hover = rawPoint; state.hoverDisplaySide = state.gestureDisplaySide;
    if (["boundary", "polygon", "boundary_brush"].includes(state.tool)) state.boundaryDisplaySide = state.gestureDisplaySide;
    if (state.tool === "boundary") { state.boundaryStart = point; state.boundaryStartClient = { x: event.clientX, y: event.clientY }; state.boundaryPoint = point; state.boundaryDragging = false; render(); return; }
    if (state.tool === "polygon") {
      const vertex = polygonVertexAt(point);
      if (vertex >= 0) {
        state.polygonDragIndex = vertex;
        state.drawing = true;
      } else {
        const completedVertex = completedPolygonVertexAt(point);
        if (completedVertex) {
          state.polygonDraftDrag = { id: completedVertex.draft.id, index: completedVertex.index };
        } else if (state.polygonPoints.length < 4) {
          state.polygonPoints.push(point);
          if (state.polygonPoints.length === 4 && polygonIsValid()) {
            addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
            state.polygonPoints = [];
          }
        }
        state.drawing = false;
      }
      updateBoundaryActions(); render(); return;
    }
    if (state.tool === "boundary_brush") { beginBoundaryBrushStroke(point); render(); return; }
    if (["bucket", "exclude_bucket"].includes(state.tool)) { state.drawing = false; fillAt(point); return; }
    beginManualStroke(rawPoint); render();
  });
  const processPointerMove = (event) => {
    if (isBusy() || state.importing) return;
    if (state.panning) {
      state.view.x += event.clientX - state.pointer.x; state.view.y += event.clientY - state.pointer.y; state.pointer = { x: event.clientX, y: event.clientY }; return;
    }
    state.hover = pointFromEvent(event);
    state.hoverDisplaySide = state.gestureDisplaySide ?? compareEventSide(event);
    if (state.drawing && (event.buttons & 1)) {
      const point = clampPoint(state.hover);
      if (state.tool === "boundary") {
        state.boundaryPoint = point;
        state.boundaryDragging ||= boundaryDragStarted(event);
      } else if (state.tool === "polygon" && state.polygonDragIndex >= 0) {
        state.polygonPoints[state.polygonDragIndex] = point;
      } else if (state.tool === "polygon" && state.polygonDraftDrag) {
        const draft = state.boundaryDrafts.find((item) => item.id === state.polygonDraftDrag.id);
        if (draft) {
          draft.points[state.polygonDraftDrag.index] = point;
          draft.roi = polygonRoi(draft.points);
          state.boundaryActiveId = draft.id;
        }
      } else if (state.tool === "boundary_brush") {
        appendBoundaryBrushPoint(point);
      } else { appendManualStrokePoint(state.hover); state.pointer = state.hover; }
    }
  };
  canvas.addEventListener("pointermove", (event) => {
    const events = event.getCoalescedEvents?.() || [event];
    for (const pointEvent of events) processPointerMove(pointEvent);
    updateBrushCursor();
    if (state.panning || state.drawing) render();
  });
  function finishCanvasGesture(event, cancelled = false) {
    const wasDrawing = state.drawing;
    const manualStrokeStarted = Boolean(state.activeStroke);
    const boundaryStarted = Boolean(state.boundaryStart);
    try { if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    state.drawing = false; state.panning = false;
    if (state.tool === "polygon") {
      if (state.polygonPoints.length === 4 && polygonIsValid()) {
        addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
        state.polygonPoints = [];
      }
      state.polygonDragIndex = -1; state.polygonDraftDrag = null; state.gestureDisplaySide = null; updateBoundaryActions(); flushRender(); return;
    }
    const boundaryStart = state.boundaryStart;
    const boundaryDragging = state.boundaryDragging;
    state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false;
    canvas.style.cursor = "default";
    if (manualStrokeStarted) {
      if (cancelled) cancelManualStroke();
      else if (wasDrawing) completeManualStroke();
    }
    if (!cancelled && wasDrawing && state.tool === "boundary_brush") completeBoundaryBrushStroke();
    if (cancelled && state.tool === "boundary_brush") state.boundaryBrushStroke = null;
    if (!cancelled && wasDrawing && boundaryStarted && !isBusy() && !state.importing && event?.button === 0) {
      const point = clampPoint(pointFromEvent(event));
      const roi = roiFromPoints(boundaryStart, point);
      if (boundaryDragging && roi) {
        addBoundaryDraft({ type: "rectangle", roi, point: pointForRoi(roi) });
        state.boundaryRoi = null;
      } else {
        const draft = rectangleDraftAt(point);
        if (draft) {
          draft.point = point;
          state.boundaryActiveId = draft.id;
        }
      }
    }
    state.gestureDisplaySide = null;
    flushRender();
  }
  canvas.addEventListener("pointerup", (event) => finishCanvasGesture(event));
  canvas.addEventListener("pointercancel", (event) => finishCanvasGesture(event, true));
  canvas.addEventListener("pointerleave", () => { if (!state.drawing) state.hover = null; render(); updateBrushCursor(); });
  canvas.addEventListener("wheel", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    event.preventDefault();
    if (event.shiftKey) {
      const current = Number($("#brushSize").value); const direction = event.deltaY < 0 ? 1 : -1;
      return updateBrushSize(Math.max(1, current + direction * Math.max(1, Math.round(current * 0.1))));
    }
    const rect = canvas.getBoundingClientRect(); const offset = compareEventOffset(event, rect); const mouseX = event.clientX - rect.left - offset; const mouseY = event.clientY - rect.top;
    const sourceX = (mouseX - state.view.x) / state.view.scale; const sourceY = (mouseY - state.view.y) / state.view.scale;
    state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    state.view.x = mouseX - sourceX * state.view.scale; state.view.y = mouseY - sourceY * state.view.scale; render(); updateBrushCursor();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.fillWorker) { event.preventDefault(); cancelFillWork(); return; }
    if (event.key === "Escape" && !$("#boundaryModeMenu").hidden) {
      event.preventDefault(); closeBoundaryModeMenu(); focusElement($("#boundaryTool")); return;
    }
    if (hasBoundaryDraft()) {
      if (event.key === "Escape") { event.preventDefault(); cancelBoundary(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        if (canDetectBoundary()) void addBoundaryCandidate();
        return;
      }
    }
    const menu = $("#catalogContextMenu");
    if (menu.matches?.(":popover-open")) {
      const items = [...menu.querySelectorAll("button:not([disabled]):not([hidden])")];
      const currentIndex = items.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeCatalogContextMenu(); return; }
      if (event.key === "Tab") { closeCatalogContextMenu({ restoreFocus: false }); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        focusElement(items[nextIndex]); return;
      }
    }
    handleWindowKeydown(event);
  });
  window.addEventListener("dragend", () => setGalleryDropOverlay(false));
  document.addEventListener("pointerdown", (event) => {
    const boundaryMenu = $("#boundaryModeMenu");
    if (!boundaryMenu.hidden && event.target !== $("#boundaryTool") && !boundaryMenu.contains?.(event.target)) closeBoundaryModeMenu();
    const menu = $("#catalogContextMenu");
    if (!menu.matches?.(":popover-open") || menu.contains(event.target)) return;
    closeCatalogContextMenu();
  });
}

async function initialise() {
  await loadTranslations();
  if (typeof window.showOpenFilePicker !== "function" || typeof window.showDirectoryPicker !== "function") {
    document.body.textContent = t("error.browserUnsupported");
    return;
  }
  try {
    const settings = await api("/api/settings?status=0");
    setSettingsForm(settings.settings, settings.status);
    $("#settingsVersion").textContent = settings.version;
  } catch (error) {
    showUserError(error);
    return;
  }
  await loadTranslations(); bindEvents();
  state.outputDirectoryHandle = await rememberedOutputDirectoryHandle();
  renderOutputDirectory();
  setNavigationShortcutsEnabled(state.settings?.general?.shortcuts_enabled ?? true);
  new ResizeObserver(resizeRenderCanvas).observe(stage); scheduleJobPoll(true);
  document.addEventListener("visibilitychange", () => scheduleJobPoll(document.visibilityState === "visible"));
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons();
  try {
    const data = await api("/api/images");
    if (typeof applyProjectSnapshot === "function") applyProjectSnapshot(data);
    if (data.images.length) {
      $("#folderPath").value = data.root || "";
      resetCatalog(data.images, data.root);
      setStatusKey("status.imagesLoaded", { count: state.images.length });
    }
  } catch (error) { showUserError(error); }
  if (document.visibilityState === "visible") setTimeout(() => { void checkForUpdate({ silent: true }); }, 1000);
}

initialise();
