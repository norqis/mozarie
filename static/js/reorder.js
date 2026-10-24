function reorderImages(images = state.images) {
  const draft = state.reorder;
  if (!draft) return images;
  const byId = new Map(images.map((image) => [image.id, image]));
  return draft.ids.map((id) => byId.get(id)).filter(Boolean);
}

async function startCatalogReorder() {
  if (isBusy() || state.importing || state.projectReadOnly) return;
  await flushAllImageMutations();
  await flushAllWorkspaceMutations();
  if (isBusy() || state.importing) return;
  state.batchMode = false; clearBatchSelection();
  state.reorder = { ids: state.images.map((image) => image.id), selectedId: state.currentId,
    generation: state.serverCatalogGeneration, projectId: state.project?.id || null, pending: false, drag: null };
  const visible = overviewImages();
  if (!visible.some((image) => image.id === state.reorder.selectedId)) state.reorder.selectedId = visible[0]?.id || null;
  syncReorderControls(); renderOverview(); updateActionButtons();
}

function syncReorderControls() {
  const mode = state.reorder;
  $("#reorderActions").hidden = !mode;
  $("#reorderImagesButton").hidden = Boolean(mode);
  $("#overviewPane").classList.toggle("overview-reordering", Boolean(mode));
  for (const input of document.querySelectorAll("#overviewQuery, #overviewFolder, #overviewFilterButton, #batchModeButton, [data-overview-filter]")) input.disabled = Boolean(mode);
  const visible = mode ? overviewImages() : [];
  const index = visible.findIndex((image) => image.id === mode?.selectedId);
  $("#reorderStatus").textContent = mode ? t("reorder.position", { position: index + 1, count: visible.length }) : "";
  for (const id of ["reorderFirst", "reorderPrevious"]) $("#" + id).disabled = !mode || mode.pending || index <= 0;
  for (const id of ["reorderNext", "reorderLast"]) $("#" + id).disabled = !mode || mode.pending || index < 0 || index >= visible.length - 1;
  $("#reorderApply").disabled = !mode || mode.pending;
  $("#reorderCancel").disabled = !mode || mode.pending;
  $("#closeOverviewButton").disabled = Boolean(mode?.pending);
}

function moveReorderImage(id, destination) {
  const mode = state.reorder;
  if (!mode || mode.pending) return;
  const index = mode.ids.indexOf(id);
  if (index < 0) return;
  const target = Math.max(0, Math.min(mode.ids.length - 1, destination));
  mode.ids.splice(index, 1); mode.ids.splice(target, 0, id); mode.selectedId = id;
  renderOverview(); syncReorderControls(); scrollCatalogImage("overview", id);
}

function moveReorderSelection(direction) {
  const mode = state.reorder;
  if (!mode || mode.pending) return;
  const visible = overviewImages();
  const index = visible.findIndex((image) => image.id === mode.selectedId);
  if (index < 0) return;
  const target = direction === "first" ? 0 : direction === "last" ? visible.length - 1 : index + direction;
  if (!visible[target]) return;
  moveReorderImage(mode.selectedId, mode.ids.indexOf(visible[target].id));
}

function selectReorderImage(id) {
  if (!state.reorder || state.reorder.pending) return;
  state.reorder.selectedId = id; renderOverview(); syncReorderControls();
}

function cancelCatalogReorder() {
  if (state.reorder?.pending) return;
  stopReorderDrag();
  state.reorder = null; syncReorderControls(); renderCatalogViews(); updateActionButtons();
}

async function applyCatalogReorder() {
  const mode = state.reorder;
  if (!mode || mode.pending) return;
  stopReorderDrag(); mode.pending = true; syncReorderControls();
  try {
    const data = await api("/api/catalog/reorder", { method: "POST", resyncOnStale: false,
      body: JSON.stringify({ imageIds: mode.ids, expectedProjectId: mode.projectId, expectedCatalogGeneration: mode.generation }) });
    catalogResponse(data); state.images = data.images;
    state.reorder = null; renderCatalogViews(); updateNavigationControls();
  } catch (error) {
    if (error.code === "stale_catalog") {
      state.reorder = null;
      await resyncAfterStaleCatalog(error);
      renderCatalogViews();
    }
    showUserError(error);
  } finally {
    mode.pending = false; syncReorderControls(); updateActionButtons();
  }
}

function stopReorderDrag() {
  const drag = state.reorder?.drag;
  if (!drag) return;
  cancelAnimationFrame(drag.frame);
  state.reorder.drag = null;
  const grid = $("#overviewGrid");
  if (grid.hasPointerCapture?.(drag.pointerId)) grid.releasePointerCapture(drag.pointerId);
  grid.classList.remove("reorder-dragging");
  for (const item of state.overviewNodes.values()) item.classList.remove("reorder-target");
}

function initCatalogReorder() {
  $("#reorderImagesButton").addEventListener("click", () => { void startCatalogReorder().catch(showUserError); });
  $("#reorderCancel").addEventListener("click", cancelCatalogReorder);
  $("#reorderApply").addEventListener("click", applyCatalogReorder);
  for (const [id, offset] of [["reorderPrevious", -1], ["reorderNext", 1], ["reorderFirst", "first"], ["reorderLast", "last"]]) {
    $("#" + id).addEventListener("click", () => {
      moveReorderSelection(offset);
    });
  }
  const grid = $("#overviewGrid");
  grid.addEventListener("keydown", (event) => {
    const mode = state.reorder;
    if (!mode) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelCatalogReorder(); }
    else if (event.altKey && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      moveReorderSelection(event.key === "Home" ? "first" : event.key === "End" ? "last" : event.key === "ArrowLeft" ? -1 : 1);
    }
  }, true);
  grid.addEventListener("pointerdown", (event) => {
    const mode = state.reorder; const item = event.target.closest(".overview-item");
    if (!mode || mode.pending || event.button !== 0 || !item) return;
    selectReorderImage(item.dataset.id);
    const drag = { id: item.dataset.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false, target: null, frame: 0 };
    mode.drag = drag;
    grid.setPointerCapture(event.pointerId);
    const tick = () => {
      if (state.reorder?.drag !== drag) return;
      if (drag.moved) {
        const rect = grid.getBoundingClientRect();
        if (drag.y < rect.top + 40) grid.scrollTop -= 14;
        else if (drag.y > rect.bottom - 40) grid.scrollTop += 14;
        const target = document.elementFromPoint(drag.x, drag.y)?.closest(".overview-item");
        drag.target = target?.dataset.id || null;
        for (const node of state.overviewNodes.values()) node.classList.toggle("reorder-target", node.dataset.id === drag.target);
      }
      drag.frame = requestAnimationFrame(tick);
    };
    drag.frame = requestAnimationFrame(tick);
  });
  grid.addEventListener("pointermove", (event) => {
    const drag = state.reorder?.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6;
    grid.classList.toggle("reorder-dragging", drag.moved);
  });
  grid.addEventListener("pointerup", (event) => {
    const mode = state.reorder; const drag = mode?.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".overview-item")?.dataset.id || drag.target;
    stopReorderDrag();
    if (drag.moved && target) moveReorderImage(drag.id, mode.ids.indexOf(target));
  });
  grid.addEventListener("pointercancel", stopReorderDrag);
  grid.addEventListener("lostpointercapture", stopReorderDrag);
}
