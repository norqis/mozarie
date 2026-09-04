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
let sameSourceProjects = [];
let sameSourcePath = "";
let sameSourceSelectedProjectId = "";
let sameSourceDirectoryHandle = null;
let sameSourceCurrentSourceId = null;
let projectDeleteId = "";
let projectListProjects = new Map();
let projectListSelectedId = "";
let projectExportBusy = false;
let projectListAppliedSort = $("#projectSort").value;

function projectTitle(project) { return project?.name || t("project.unnamed"); }
function projectDate(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return t("project.noDate");
  const language = state.settings?.general?.language === "en" ? "en" : "ja-JP";
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(Math.floor(timestamp / 1000000)));
}
function projectSource(project) { return project?.sourceRoot || t("project.noSource"); }
function renderProjectCurrent() {
  const project = state.project;
  $("#projectCurrent").textContent = project ? `${projectTitle(project)} · ${t(`project.${project.status}`)}` : t("project.unnamed");
  $("#projectName").dataset.i18n = project ? "project.rename" : "project.saveCurrent";
  $("#projectName").textContent = t($("#projectName").dataset.i18n);
  $("#projectName").disabled = state.projectReadOnly || (!project && state.images.length === 0);
  $("#projectComplete").disabled = !project || state.projectReadOnly;
  $("#projectResume").hidden = !state.projectReadOnly;
  $("#projectResume").disabled = !project;
  $("#projectReadOnlyNotice").hidden = !state.projectReadOnly;
  $("#projectSourceSelect").disabled = !project || state.projectReadOnly;
  $("#projectCloseWorkspace").dataset.i18n = project ? "project.close" : "project.closeWork";
  $("#projectCloseWorkspace").textContent = t($("#projectCloseWorkspace").dataset.i18n);
  $("#projectCloseWorkspace").disabled = !project && state.images.length === 0;
}
function openProjectNameDialog(mode) {
  projectNameMode = mode; $("#projectNameInput").value = mode === "name" ? (state.project?.name || "") : "";
  showModalFromInvoker($("#projectNameDialog")); focusElement($("#projectNameInput"));
}
function selectedProject() { return projectListProjects.get(projectListSelectedId) || null; }

function renderProjectListSelection() {
  const project = selectedProject();
  const details = $("#projectSelectedDetails");
  details.hidden = !project;
  if (project) {
    $("#projectSelectedSummary").textContent = `${projectTitle(project)} · ${t(`project.${project.status}`)} · ${t("project.imageCount", { count: project.imageCount || 0 })}`;
    $("#projectSelectedDetailsText").textContent = `${t("project.source")}: ${projectSource(project)} · ${t("project.updated")}: ${projectDate(project.updatedAt)}`;
  }
  const options = projectListOptionElements();
  const focused = document.activeElement?.closest?.(".project-list-option");
  const rovingId = focused?.dataset.projectId || project?.id || options[0]?.dataset.projectId || "";
  for (const option of options) {
    option.setAttribute("aria-selected", String(option.dataset.projectId === projectListSelectedId));
    option.tabIndex = option.dataset.projectId === rovingId ? 0 : -1;
  }
  const blocked = isBusy() || state.importing;
  $("#projectListOpen").disabled = !project || blocked;
  $("#projectListDelete").disabled = !project || blocked;
  const exportDisabled = !project || !(project.imageCount > 0) || blocked || projectExportBusy;
  for (const id of ["#projectListMosaicZip", "#projectListExcludeZip"]) {
    const button = $(id); button.disabled = exportDisabled; button.setAttribute("aria-busy", String(projectExportBusy));
  }
}

function selectProject(projectId) {
  if (!projectListProjects.has(projectId)) return;
  projectListSelectedId = projectId;
  renderProjectListSelection();
}

function projectListOptionElements() { return [...$("#projectList").querySelectorAll(".project-list-option")]; }

function focusProjectListOption(index) {
  const options = projectListOptionElements();
  if (!options.length) return;
  const target = options[Math.max(0, Math.min(index, options.length - 1))];
  for (const option of options) option.tabIndex = option === target ? 0 : -1;
  focusElement(target);
}

function buildProjectListFragment(projects) {
  const fragment = document.createDocumentFragment();
  for (const project of projects.values()) {
    const option = document.createElement("button"); option.type = "button"; option.className = "project-list-option";
    option.setAttribute("role", "option"); option.dataset.projectId = project.id;
    const name = document.createElement("span"); name.className = "project-option-name"; name.textContent = projectTitle(project);
    const status = document.createElement("span"); status.className = "project-option-status";
    status.textContent = `${t(`project.${project.status}`)} · ${t("project.imageCount", { count: project.imageCount || 0 })}`;
    const details = document.createElement("span"); details.className = "project-option-details";
    details.textContent = `${t("project.source")}: ${projectSource(project)} · ${t("project.updated")}: ${projectDate(project.updatedAt)}`;
    option.append(name, status, details);
    option.addEventListener("click", () => selectProject(project.id));
    fragment.append(option);
  }
  return fragment;
}

async function showProjectList({ preserveSelection = false, focusProjectId = "" } = {}) {
  const sort = $("#projectSort");
  const requestedSort = sort.value;
  let focusTarget = null;
  sort.disabled = true;
  try {
    const data = await api(`/api/projects?sort=${encodeURIComponent(requestedSort)}`);
    const nextProjects = new Map((data.projects || []).map((project) => [project.id, project]));
    const nextSelectedId = preserveSelection && nextProjects.has(projectListSelectedId) ? projectListSelectedId : "";
    const fragment = buildProjectListFragment(nextProjects);
    projectListProjects = nextProjects; projectListSelectedId = nextSelectedId; projectListAppliedSort = requestedSort;
    $("#projectList").replaceChildren(fragment);
    $("#projectList").hidden = !nextProjects.size;
    $("#projectListEmpty").hidden = Boolean(nextProjects.size);
    renderProjectListSelection();
    const focusOption = focusProjectId && $("#projectList").querySelector(`.project-list-option[data-project-id="${focusProjectId}"]`);
    if (!$("#projectListDialog").open) {
      if ($("#projectDialog").open) {
        modalInvokers.delete($("#projectDialog"));
        $("#projectDialog").close();
      }
      showModalFromInvoker($("#projectListDialog"), $("#projectButton"));
      focusTarget = $("#projectSort");
    }
    if (focusOption) focusTarget = focusOption;
    else if (!nextProjects.size) focusTarget = $("#projectListClose");
  } catch (error) {
    sort.value = projectListAppliedSort;
    throw error;
  } finally {
    sort.disabled = false;
    if (focusTarget) focusElement(focusTarget);
  }
}
async function showSourceMismatches() {
  const data = await api("/api/project/mismatches"); const images = data.images || [];
  if (!images.length) return;
  const list = $("#sourceMismatchList"); list.replaceChildren();
  for (const image of images) {
    const item = document.createElement("li");
    item.textContent = image.dimensionsChanged ? `${image.relativePath} · ${t("project.dimensionsChanged")}` : image.relativePath;
    list.append(item);
  }
  $("#sourceMismatchClear").checked = false;
  const dialog = $("#sourceMismatchDialog");
  dialog.dataset.imageIds = JSON.stringify(images.map((image) => image.id));
  showModalFromInvoker(dialog);
}
async function openProject(project, resume = false) {
  try {
    if (state.candidateUpdateChains?.size) await waitForCandidateMutations();
    await flushAllWorkspaceMutations();
    if (resume) await api("/api/project/resume", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    const data = await api("/api/project/open", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    state.project = data.project; state.projectReadOnly = data.project?.status === "completed";
    modalInvokers.delete($("#projectListDialog"));
    modalInvokers.delete($("#projectDialog"));
    $("#projectListDialog").close(); $("#projectDialog").close();
    focusElement($("#projectButton"));
    if (data.needsSource) {
      const files = await rememberedProjectFileSources(project.id);
      const directories = await rememberedProjectDirectorySources(project.id);
      // Keep the native portion visible while browser handles are restored.
      resetCatalog(data.images || [], data.project?.sourceRoot || "");
      applyProjectSnapshot(await api("/api/images"));
      const handles = [...directories.map((item) => item.handle), ...files.map((item) => item.handle)].filter(Boolean);
      const granted = await Promise.all(handles.map((handle) => ensureProjectSourcePermission(handle, true)));
      for (let index = 0; index < directories.length; index += 1) {
        if (granted[index]) await importProjectDirectoryHandle(directories[index].handle, project.id, directories[index].sourceId);
      }
      if (files.length && granted.slice(directories.length).every(Boolean)) await importProjectFileHandles(files, project.id);
      if (!handles.length || granted.some((ok) => !ok)) showUserError({ code: "project_source_unavailable" });
      await showSourceMismatches();
    } else {
      resetCatalog(data.images || [], data.project?.sourceRoot || "");
      applyProjectSnapshot(await api("/api/images")); await showSourceMismatches();
    }
  } catch (error) { showUserError(error); }
}

async function downloadProjectArtifact(path, filename) {
  try {
    if (state.candidateUpdateChains?.size) await waitForCandidateMutations();
    await flushAllWorkspaceMutations();
    const response = await fetch(path, { headers: { "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" } });
    if (!response.ok) throw responseError(response, await response.json().catch(() => ({})));
    const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
  } catch (error) { showUserError(error); }
}

async function downloadProjectMasks(project, kind) {
  if (!project || projectExportBusy) return;
  projectExportBusy = true; renderProjectListSelection();
  try {
    if (state.project?.id === project.id) {
      if (state.candidateUpdateChains?.size) await waitForCandidateMutations();
      await flushAllWorkspaceMutations();
    }
    const path = `/api/project/masks/${encodeURIComponent(project.id)}/${kind}`;
    const response = await fetch(path, { headers: { "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" } });
    if (!response.ok) throw responseError(response, await response.json().catch(() => ({})));
    const name = String(project.name || "").replace(/[\\/:*?"<>|]/g, "_").replace(/[ .]+$/g, "");
    const prefix = name || `${projectTitle(project).replace(/[\\/:*?"<>|]/g, "_").replace(/[ .]+$/g, "") || "project"}-${project.id.slice(0, 8)}`;
    const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = `${prefix}-${kind}-masks.zip`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
  } catch (error) { showUserError(error); }
  finally { projectExportBusy = false; renderProjectListSelection(); }
}

async function resumeCurrentProject() {
  if (!state.project?.id) return;
  try {
    const data = await api("/api/project/resume", { method: "POST", body: JSON.stringify({ projectId: state.project.id }) });
    state.project = data.project; state.projectReadOnly = false; renderProjectCurrent(); renderCandidates(); updateActionButtons();
  } catch (error) { showUserError(error); }
}

function openProjectDeleteDialog(projectId) {
  const project = projectListProjects.get(projectId) || (state.project?.id === projectId ? state.project : null);
  if (!project) return;
  projectDeleteId = projectId;
  $("#projectDeleteTarget").textContent = `${t("project.deleteSelected")} ${projectTitle(project)}`;
  $("#projectDeleteDetails").textContent = `${t(`project.${project.status}`)} · ${t("project.imageCount", { count: project.imageCount || 0 })} · ${t("project.source")}: ${projectSource(project)}`;
  showModalFromInvoker($("#projectDeleteDialog"));
  focusElement($("#projectDeleteCancel"));
}

async function discardProjectWorkspaceChanges() {
  // Deletion intentionally discards local, unsaved work. Do not turn this
  // into a flush: that would create data solely to delete it a moment later.
  for (const timer of state.workspaceDraftTimers?.values?.() || []) clearTimeout(timer);
  state.workspaceDraftTimers?.clear?.();
  state.draftDirty = false;
  const pending = [
    ...(state.workspaceDraftChains?.values?.() || []),
    ...(state.candidateUpdateChains?.values?.() || []),
  ];
  await Promise.allSettled(pending);
  state.workspaceDraftChains?.clear?.(); state.workspaceMutationErrors?.clear?.();
  state.candidateUpdateChains?.clear?.(); state.candidateBatchPending?.clear?.();
}

async function deleteProject(projectId) {
  if (!projectId) return;
  try {
    const deletingCurrentProject = state.project?.id === projectId;
    const options = projectListOptionElements();
    const deletedIndex = options.findIndex((option) => option.dataset.projectId === projectId);
    const focusProjectId = options[deletedIndex + 1]?.dataset.projectId || options[deletedIndex - 1]?.dataset.projectId || "";
    if (deletingCurrentProject) await discardProjectWorkspaceChanges();
    await api(`/api/project/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    await forgetProjectSources(projectId);
    if (deletingCurrentProject) {
      resetCatalog([], ""); state.project = null; state.projectReadOnly = false; renderProjectCurrent(); updateActionButtons();
      $("#projectDialog").close();
    }
    projectDeleteId = "";
    modalInvokers.delete($("#projectDeleteDialog"));
    $("#projectDeleteDialog").close();
    if ($("#projectListDialog").open) {
      projectListProjects.delete(projectId);
      $("#projectList").querySelector(`.project-list-option[data-project-id="${projectId}"]`)?.remove();
      projectListSelectedId = "";
      const empty = !projectListProjects.size;
      $("#projectList").hidden = empty;
      $("#projectListEmpty").hidden = !empty;
      renderProjectListSelection();
      if (empty) focusElement($("#projectListClose"));
      else if (focusProjectId) {
        const nextIndex = projectListOptionElements().findIndex((option) => option.dataset.projectId === focusProjectId);
        if (nextIndex >= 0) focusProjectListOption(nextIndex);
      }
    } else projectListSelectedId = "";
  } catch (error) { showUserError(error); }
}

function showSameSourceDialog(projects, { path = "", directoryHandle = null, currentSourceId = null } = {}) {
  sameSourceProjects = projects;
  sameSourcePath = path;
  sameSourceDirectoryHandle = directoryHandle;
  sameSourceCurrentSourceId = currentSourceId;
  $("#sameSourceSeparate").hidden = false;
  $("#sameSourceSeparate").textContent = t(directoryHandle ? "project.sameSourceAddCurrent" : "project.sameSourceSeparate");
  const list = $("#sameSourceList"); list.replaceChildren();
  for (const project of sameSourceProjects) {
    const item = document.createElement("li");
    const choose = document.createElement("button"); choose.type = "button";
    choose.textContent = `${projectTitle(project)} · ${t(`project.${project.status}`)} · ${t("project.imageCount", { count: project.imageCount || 0 })}`;
    choose.addEventListener("click", () => { sameSourceSelectedProjectId = project.id; });
    item.append(choose);
    list.append(item);
  }
  sameSourceSelectedProjectId = sameSourceProjects[0].id;
  showModalFromInvoker($("#sameSourceDialog"));
}

async function openSameSourceDialog(path) {
  const data = await api("/api/project/source-check", { method: "POST", body: JSON.stringify({ path }) });
  const projects = (data.projects || []).filter((project) => project.id !== state.project?.id);
  if (!projects.length) return false;
  showSameSourceDialog(projects, { path });
  return true;
}

function bindEvents() {
  initCandidatePaddingPopover();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("keydown", trapModalTab));
  $("#projectButton").addEventListener("click", () => { renderProjectCurrent(); showModalFromInvoker($("#projectDialog")); });
  $("#projectClose").addEventListener("click", () => $("#projectDialog").close());
  $("#projectNew").addEventListener("click", () => openProjectNameDialog("new"));
  $("#projectName").addEventListener("click", () => openProjectNameDialog("name"));
  $("#projectOpenList").addEventListener("click", () => { void showProjectList().catch(showUserError); });
  $("#projectListClose").addEventListener("click", () => $("#projectListDialog").close());
  $("#projectSort").addEventListener("change", () => { void showProjectList({ preserveSelection: true }).catch(showUserError); });
  $("#projectList").addEventListener("keydown", (event) => {
    const options = projectListOptionElements();
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowUp") { event.preventDefault(); focusProjectListOption(index <= 0 ? 0 : index - 1); }
    else if (event.key === "ArrowDown") { event.preventDefault(); focusProjectListOption(index < 0 ? 0 : index + 1); }
    else if (event.key === "Home") { event.preventDefault(); focusProjectListOption(0); }
    else if (event.key === "End") { event.preventDefault(); focusProjectListOption(options.length - 1); }
    else if (event.key === " " || event.key === "Enter") {
      const option = document.activeElement;
      if (!option?.classList.contains("project-list-option")) return;
      event.preventDefault(); selectProject(option.dataset.projectId);
    }
  });
  $("#projectListOpen").addEventListener("click", () => { const project = selectedProject(); if (project) void openProject(project); });
  $("#projectListMosaicZip").addEventListener("click", () => { const project = selectedProject(); if (project) void downloadProjectMasks(project, "mosaic"); });
  $("#projectListExcludeZip").addEventListener("click", () => { const project = selectedProject(); if (project) void downloadProjectMasks(project, "exclude"); });
  $("#projectListDelete").addEventListener("click", () => openProjectDeleteDialog(selectedProject()?.id));
  $("#projectResume").addEventListener("click", () => { void resumeCurrentProject(); });
  $("#projectSourceSelect").addEventListener("click", () => { void (async () => {
    if (!state.project?.id) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: "read", id: "mozarie-project-source" });
      const matches = await matchingProjectDirectorySources(handle);
      const current = matches.find((source) => source.projectId === state.project.id);
      const others = new Set(matches.filter((source) => source.projectId !== state.project.id).map((source) => source.projectId));
      if (others.size) {
        const data = await api("/api/projects?sort=updated_desc");
        const projects = (data.projects || []).filter((project) => others.has(project.id));
        if (projects.length) {
          showSameSourceDialog(projects, { directoryHandle: handle, currentSourceId: current?.sourceId || null });
          return;
        }
      }
      await importProjectDirectoryHandle(handle, state.project.id, current?.sourceId || null);
      await showSourceMismatches();
    }
    catch (error) { if (error?.name !== "AbortError") showUserError(error); }
  })(); });
  $("#projectCloseWorkspace").addEventListener("click", () => { void (async () => { try { await flushAllWorkspaceMutations(); await api("/api/project/close", { method: "POST", body: "{}" }); resetCatalog([], ""); state.project = null; state.projectReadOnly = false; $("#projectDialog").close(); } catch (error) { showUserError(error); } })(); });
  $("#projectComplete").addEventListener("click", () => { void (async () => { if (!await confirmAction(t("project.complete"), t("project.completeConfirm"))) return; try { await flushAllWorkspaceMutations(); await api("/api/project/complete", { method: "POST", body: "{}" }); resetCatalog([], ""); state.project = null; state.projectReadOnly = false; $("#projectDialog").close(); } catch (error) { showUserError(error); } })(); });
  $("#projectNameCancel").addEventListener("click", () => $("#projectNameDialog").close());
  $("#projectDeleteCancel").addEventListener("click", () => { projectDeleteId = ""; $("#projectDeleteDialog").close(); });
  $("#projectDeleteConfirm").addEventListener("click", () => { void deleteProject(projectDeleteId); });
  $("#projectNameForm").addEventListener("submit", (event) => { event.preventDefault(); void (async () => { try {
    const name = $("#projectNameInput").value.trim(); const projectlessSave = projectNameMode === "name" && !state.project?.id;
    if (projectNameMode === "new" || projectlessSave) { if (state.candidateUpdateChains?.size) await waitForCandidateMutations(); await flushAllWorkspaceMutations(); }
    const data = projectNameMode === "new" ? await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }) : await api("/api/project/name", { method: "POST", body: JSON.stringify({ name }) });
    state.project = data.project; state.projectReadOnly = false;
    if (projectlessSave) {
      const snapshot = await api("/api/images"); state.images = snapshot.images || state.images; applyProjectSnapshot(snapshot); loadReviewedPaths();
      for (const image of state.images) {
        const access = state.sourceAccess.get(image.id);
        if (access?.fileHandle) void rememberProjectSource(state.project.id, access.fileHandle, image.id, image.sourceId || data.project.sourceIds?.[image.id]);
      }
    }
    $("#projectNameDialog").close(); if (projectNameMode === "new") resetCatalog([], ""); renderProjectCurrent();
  } catch (error) { showUserError(error); } })(); });
  $("#sourceMismatchCancel").addEventListener("click", () => $("#sourceMismatchDialog").close());
  $("#sourceMismatchForm").addEventListener("submit", (event) => { event.preventDefault(); void (async () => { try { const ids = JSON.parse($("#sourceMismatchDialog").dataset.imageIds || "[]"); const snapshot = await api("/api/project/mismatches", { method: "POST", body: JSON.stringify({ imageIds: ids, clearMasks: $("#sourceMismatchClear").checked }) }); state.images = snapshot.images || state.images; applyProjectSnapshot(snapshot); $("#sourceMismatchDialog").close(); renderCatalogViews(); } catch (error) { showUserError(error); } })(); });
  $("#sameSourceCancel").addEventListener("click", () => $("#sameSourceDialog").close());
  $("#sameSourceOpen").addEventListener("click", () => { const project = sameSourceProjects.find((item) => item.id === sameSourceSelectedProjectId) || sameSourceProjects[0]; $("#sameSourceDialog").close(); if (project) void openProject(project); });
  $("#sameSourceSeparate").addEventListener("click", () => { void (async () => {
    try {
      const handle = sameSourceDirectoryHandle;
      const sourceId = sameSourceCurrentSourceId;
      if (handle) {
        $("#sameSourceDialog").close();
        await importProjectDirectoryHandle(handle, state.project.id, sourceId);
        await showSourceMismatches();
        return;
      }
      if (state.candidateUpdateChains?.size) await waitForCandidateMutations();
      await flushAllWorkspaceMutations();
      const data = await api("/api/projects", { method: "POST", body: JSON.stringify({}) });
      state.project = data.project; state.projectReadOnly = false; $("#sameSourceDialog").close(); renderProjectCurrent();
      await loadFolder({ skipSameSourceWarning: true, path: sameSourcePath });
    } catch (error) { showUserError(error); }
  })(); });
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
    const invoker = modalInvokers.get(dialog);
    modalInvokers.delete(dialog);
    setTimeout(() => {
      if (dialog === $("#projectDialog") && $("#projectListDialog").open) return;
      const fallback = dialog === $("#projectListDialog") ? $("#projectButton") : invoker;
      if (fallback?.isConnected && !fallback.disabled && !dialog.open) focusElement(fallback);
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
  $("#downloadCurrentMosaicMask").addEventListener("click", () => { if (state.currentId) void downloadProjectArtifact(`/api/project/mask/${encodeURIComponent(state.currentId)}/mosaic`, "mosaic-mask.png"); });
  $("#downloadCurrentExcludeMask").addEventListener("click", () => { if (state.currentId) void downloadProjectArtifact(`/api/project/mask/${encodeURIComponent(state.currentId)}/exclude`, "exclude-mask.png"); });
  $("#bucketTolerance").addEventListener("input", (event) => setFillColorTolerance(event.currentTarget.value));
  $("#bucketTolerance").addEventListener("change", () => { void saveFillColorTolerance(); });
  $("#bucketToleranceClose").addEventListener("click", () => closeFillToleranceControl({ focus: true }));
  $("#bucketToleranceControl").addEventListener("toggle", (event) => {
    if (event.newState === "open") return;
    fillToleranceSession = null;
    $("#bucketTool").setAttribute("aria-expanded", "false");
    $("#excludeBucketTool").setAttribute("aria-expanded", "false");
  });
  const splitter = $("#compareSplitter");
  let compareDrag = null;
  const setCompareSplit = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    state.compareSplit = clampCompareSplit((clientX - rect.left) / rect.width, rect.width);
    updateCompareSplitter(); render(); updateBrushCursor();
  };
  const flushCompareDrag = () => {
    if (!compareDrag) return;
    compareDrag.frame = 0;
    if (compareDrag.latestX !== null) { const latestX = compareDrag.latestX; compareDrag.latestX = null; setCompareSplit(latestX); }
  };
  const scheduleCompareDrag = (clientX) => {
    if (!compareDrag) return;
    compareDrag.latestX = clientX;
    if (!compareDrag.frame) compareDrag.frame = requestAnimationFrame(flushCompareDrag);
  };
  const finishCompareDrag = (event, commit) => {
    if (!compareDrag || compareDrag.pointerId !== event.pointerId) return;
    if (compareDrag.frame) cancelAnimationFrame(compareDrag.frame);
    const initial = compareDrag.initial;
    compareDrag.frame = 0;
    if (commit) setCompareSplit(event.clientX);
    else { state.compareSplit = initial; updateCompareSplitter(); render(); updateBrushCursor(); }
    compareDrag = null; splitter.classList.remove("dragging");
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    if (commit) persistCompareSplit();
  };
  splitter.addEventListener("pointerdown", (event) => {
    if (state.displayMode !== "compare" || event.button !== 0 || compareSplitLimits().fixed) return;
    event.preventDefault(); compareDrag = { pointerId: event.pointerId, initial: state.compareSplit, latestX: null, frame: 0 };
    splitter.classList.add("dragging"); splitter.setPointerCapture(event.pointerId); scheduleCompareDrag(event.clientX);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (compareDrag?.pointerId === event.pointerId && splitter.hasPointerCapture(event.pointerId)) scheduleCompareDrag(event.clientX);
  });
  splitter.addEventListener("pointerup", (event) => finishCompareDrag(event, true));
  splitter.addEventListener("pointercancel", (event) => finishCompareDrag(event, false));
  splitter.addEventListener("lostpointercapture", (event) => finishCompareDrag(event, false));
  splitter.addEventListener("dblclick", () => {
    if (compareSplitLimits().fixed) return;
    state.compareSplit = .5; updateCompareSplitter(); render(); updateBrushCursor(); persistCompareSplit();
  });
  splitter.addEventListener("keydown", (event) => {
    const limits = compareSplitLimits();
    if (limits.fixed) return;
    const step = event.shiftKey ? .05 : .01;
    if (event.key === "ArrowLeft") state.compareSplit = clampCompareSplit(state.compareSplit - step);
    else if (event.key === "ArrowRight") state.compareSplit = clampCompareSplit(state.compareSplit + step);
    else if (event.key === "Home") state.compareSplit = limits.minimum;
    else if (event.key === "End") state.compareSplit = limits.maximum;
    else return;
    event.preventDefault(); updateCompareSplitter(); render(); updateBrushCursor(); persistCompareSplit();
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
  $("#selectionClearButton").addEventListener("click", () => { closeBatchMoreMenus(); state.batchMode = false; clearBatchSelection(); renderOverview(); updateSelectionActionBar(); });
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
  for (const [selector, tool] of [["#bucketTool", "bucket"], ["#excludeBucketTool", "exclude_bucket"]]) {
    $(selector).addEventListener("pointerdown", () => rememberFillToleranceTrigger(tool));
    $(selector).addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") rememberFillToleranceTrigger(tool); });
    $(selector).addEventListener("click", () => setTool(tool));
  }
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
  $("#undoButton").addEventListener("click", () => { if (state.project?.id) void restoreProjectHistory("undo"); else restoreSnapshot(state.historyIndex - 1); }); $("#redoButton").addEventListener("click", () => { if (state.project?.id) void restoreProjectHistory("redo"); else restoreSnapshot(state.historyIndex + 1); });
  const grid = $(".studio-grid");
  const paneStorage = { gallery: "mozarie.galleryWidth", inspector: "mozarie.inspectorWidth" };
  const paneDefaults = window.innerWidth < 1280 ? { gallery: 190, inspector: 270 } : { gallery: 216, inspector: 292 };
  const paneMinimums = { gallery: 144, inspector: 240 };
  const paneValues = { gallery: paneDefaults.gallery, inspector: paneDefaults.inspector };
  const paneStore = globalThis.localStorage;
  for (const side of Object.keys(paneValues)) {
    const stored = Number(paneStore?.getItem(paneStorage[side]));
    if (Number.isFinite(stored) && stored >= paneMinimums[side]) paneValues[side] = stored;
  }
  const paneWidth = (side) => state[side === "gallery" ? "galleryCollapsed" : "inspectorCollapsed"] ? 40 : paneValues[side];
  const paneMaximum = (side) => {
    const other = side === "gallery" ? paneWidth("inspector") : paneWidth("gallery");
    return Math.max(paneMinimums[side], Math.floor(grid.getBoundingClientRect().width - other - 16 - 320));
  };
  const applyPaneWidths = () => {
    grid.style.setProperty?.("--gallery-width", `${paneValues.gallery}px`);
    grid.style.setProperty?.("--inspector-width", `${paneValues.inspector}px`);
    $("#gallerySplitter").setAttribute("aria-valuenow", String(Math.round(paneValues.gallery)));
    $("#candidateSplitter").setAttribute("aria-valuenow", String(Math.round(paneValues.inspector)));
    $("#gallerySplitter").setAttribute("aria-valuemax", String(paneMaximum("gallery")));
    $("#candidateSplitter").setAttribute("aria-valuemax", String(paneMaximum("inspector")));
  };
  const updatePaneWidth = (side, requested, persist = true) => {
    const maximum = paneMaximum(side);
    paneValues[side] = Math.min(maximum, Math.max(paneMinimums[side], Math.round(requested)));
    applyPaneWidths();
    if (persist) paneStore?.setItem(paneStorage[side], String(paneValues[side]));
    requestAnimationFrame(() => { resizeRenderCanvas(); renderGallery(); });
  };
  applyPaneWidths();
  const bindPaneSplitter = (element, side) => {
    let drag = null;
    const commit = (event, accepted) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (accepted && drag.latest !== null) updatePaneWidth(side, drag.latest);
      else if (!accepted) updatePaneWidth(side, drag.initial, false);
      element.classList.remove("dragging");
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      drag = null;
    };
    const request = (clientX) => {
      if (!drag) return;
      drag.latest = side === "gallery" ? clientX - grid.getBoundingClientRect().left : grid.getBoundingClientRect().right - clientX;
      if (!drag.frame) drag.frame = requestAnimationFrame(() => { drag.frame = 0; if (drag?.latest !== null) updatePaneWidth(side, drag.latest, false); });
    };
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state[side === "gallery" ? "galleryCollapsed" : "inspectorCollapsed"]) return;
      event.preventDefault(); drag = { pointerId: event.pointerId, initial: paneValues[side], latest: null, frame: 0 };
      element.setPointerCapture(event.pointerId); element.classList.add("dragging"); request(event.clientX);
    });
    element.addEventListener("pointermove", (event) => { if (drag?.pointerId === event.pointerId && element.hasPointerCapture(event.pointerId)) request(event.clientX); });
    element.addEventListener("pointerup", (event) => commit(event, true));
    element.addEventListener("pointercancel", (event) => commit(event, false));
    element.addEventListener("lostpointercapture", (event) => commit(event, false));
    element.addEventListener("dblclick", () => updatePaneWidth(side, paneDefaults[side]));
    element.addEventListener("keydown", (event) => {
      const direction = side === "gallery" ? 1 : -1;
      const step = event.shiftKey ? 40 : 12;
      if (event.key === "ArrowLeft") updatePaneWidth(side, paneValues[side] - direction * step);
      else if (event.key === "ArrowRight") updatePaneWidth(side, paneValues[side] + direction * step);
      else if (event.key === "Home") updatePaneWidth(side, paneMinimums[side]);
      else if (event.key === "End") updatePaneWidth(side, Number.MAX_SAFE_INTEGER);
      else return;
      event.preventDefault();
    });
  };
  bindPaneSplitter($("#gallerySplitter"), "gallery");
  bindPaneSplitter($("#candidateSplitter"), "inspector");
  if (typeof ResizeObserver === "function") new ResizeObserver(() => {
    for (const side of Object.keys(paneValues)) paneValues[side] = Math.min(paneValues[side], paneMaximum(side));
    applyPaneWidths(); requestAnimationFrame(() => { resizeRenderCanvas(); renderGallery(); });
  }).observe(grid);
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
    $(isGallery ? "#gallerySplitter" : "#candidateSplitter").hidden = collapsed;
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
    if (state.projectReadOnly || currentRecord()?.sourceDimensionsChanged) return;
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
  await loadTranslations(); restoreCompareSplit(); bindEvents();
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
