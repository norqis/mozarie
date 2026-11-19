let importProjectSuggestion = null;

function captureProjectImportSuggestion() {
  return !state.project?.id && !state.images.length ? { consumed: false } : null;
}

function importProjectDirectoryName(entries) {
  const names = new Set(entries.map((entry) => {
    if (entry.rootHandle?.name) return entry.rootHandle.name;
    const relative = entry.file?.webkitRelativePath || entry.webkitRelativePath || entry.relativePath || "";
    return relative.includes("/") ? relative.split("/")[0] : entry.parentHandle?.name || "";
  }));
  return names.size === 1 ? [...names][0] : "";
}

function matchesImportProjectImages(suggestion) {
  return Boolean(suggestion && !state.project?.id && state.workspaceId === suggestion.workspaceId
    && state.images.length === suggestion.imageIds.size && state.images.every((image) => suggestion.imageIds.has(image.id)));
}

function currentImportProjectSuggestion(suggestion = importProjectSuggestion) {
  return matchesImportProjectImages(suggestion) && state.catalogEpoch === suggestion.epoch;
}

function completeProjectImportSuggestion(token, name = "", succeeded = true) {
  if (!token || token.consumed) return;
  token.consumed = true;
  if (!succeeded || state.project?.id || !state.images.length || !state.workspaceId) return;
  const suggestion = { workspaceId: state.workspaceId, imageIds: new Set(state.images.map((image) => image.id)), epoch: state.catalogEpoch, name };
  const open = () => {
    if (!currentImportProjectSuggestion(suggestion)) return;
    const failure = document.querySelector("#importFailuresDialog[open], #errorDialog[open]");
    if (failure) { failure.addEventListener("close", open, { once: true }); return; }
    if (document.querySelector("dialog[open]")) return;
    importProjectSuggestion = suggestion;
    openProjectNameDialog("import");
  };
  open();
}

function renderProjectNameDialogMode() {
  const importing = projectNameMode === "import";
  const keys = importing
    ? ["project.importCreateTitle", "project.importDoNotCreate", "project.importCreate"]
    : ["project.name", "dialog.cancel", "dialog.save"];
  ["#projectNameTitle", "#projectNameCancel", "#projectNameConfirm"].forEach((selector, index) => {
    const element = $(selector);
    element.dataset.i18n = keys[index]; element.textContent = t(keys[index]);
  });
}
