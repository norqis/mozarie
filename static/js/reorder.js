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

function syncReorderControls(visibleImages = null) {
  const mode = state.reorder;
  $("#reorderActions").hidden = !mode;
  $("#reorderImagesButton").hidden = Boolean(mode);
  $("#overviewPane").classList.toggle("overview-reordering", Boolean(mode));
  for (const input of document.querySelectorAll("#overviewQuery, #overviewFolder, #overviewFilterButton, #batchModeButton, [data-overview-filter]")) input.disabled = Boolean(mode);
  const visible = mode ? visibleImages || overviewImages() : [];
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

function clearReorderSettle() {
  const settle = state.reorder?.settle;
  if (!settle) return;
  state.reorder.settle = null;
  settle.animation.cancel(); settle.ghost.remove(); settle.node.classList.remove("reorder-placeholder");
}

function stopReorderDrag(restore = false, settle = false) {
  clearReorderSettle();
  const drag = state.reorder?.drag;
  if (!drag) return;
  cancelAnimationFrame(drag.frame);
  const ghost = drag.ghost;
  const node = state.overviewNodes.get(drag.id);
  const destination = node?.getBoundingClientRect();
  if (ghost && settle && destination && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.classList.add("reorder-placeholder");
    const animation = ghost.animate([
      { transform: ghost.style.transform },
      { transform: `translate3d(${destination.left}px, ${destination.top}px, 0)` },
    ], { duration: 140, easing: "ease-out", fill: "forwards" });
    state.reorder.settle = { ghost, node, animation };
    animation.onfinish = clearReorderSettle;
  } else ghost?.remove();
  for (const animation of drag.animations.values()) animation.cancel();
  state.reorder.drag = null;
  const grid = $("#overviewGrid");
  if (grid.hasPointerCapture?.(drag.pointerId)) grid.releasePointerCapture(drag.pointerId);
  grid.classList.remove("reorder-dragging");
  for (const item of state.overviewNodes.values()) if (!state.reorder.settle || item !== node) item.classList.remove("reorder-placeholder");
  if (restore && drag.moved) { state.reorder.ids = drag.originalIds; renderOverview(); syncReorderControls(); }
}

function previewReorderDrag(drag) {
  const mode = state.reorder;
  const grid = $("#overviewGrid");
  drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0)`;
  const rect = grid.getBoundingClientRect();
  if (drag.x < rect.left || drag.x > rect.right || drag.y < rect.top || drag.y > rect.bottom) return;
  if (drag.y < rect.top + 40) grid.scrollTop -= 14;
  else if (drag.y > rect.bottom - 40) grid.scrollTop += 14;
  const windowState = catalogWindows.get("overview");
  const layout = catalogLayout(windowState);
  const { padding, gap } = windowState.options;
  const column = Math.max(0, Math.min(layout.columns - 1, Math.floor((drag.x - rect.left - padding + gap / 2) / (layout.itemWidth + gap))));
  const row = Math.max(0, Math.floor((drag.y - rect.top + grid.scrollTop - padding) / layout.rowHeight));
  const visible = windowState.images;
  const targetIndex = Math.min(visible.length - 1, row * layout.columns + column);
  const target = visible[targetIndex];
  if (!target || target.id === drag.id) return;
  const before = new Map();
  for (const [id, node] of state.overviewNodes) if (id !== drag.id) before.set(id, node.getBoundingClientRect());
  for (const animation of drag.animations.values()) animation.cancel();
  drag.animations.clear();
  const destination = mode.ids.indexOf(target.id);
  mode.ids.splice(mode.ids.indexOf(drag.id), 1); mode.ids.splice(destination, 0, drag.id);
  const sourceIndex = visible.findIndex((image) => image.id === drag.id);
  const [image] = visible.splice(sourceIndex, 1); visible.splice(targetIndex, 0, image);
  renderCatalogWindow(windowState); syncReorderControls(visible);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const [id, node] of state.overviewNodes) {
    const previous = before.get(id); if (!previous) continue;
    const current = node.getBoundingClientRect();
    const x = previous.left - current.left, y = previous.top - current.top;
    if (x || y) drag.animations.set(id, node.animate([
      { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" },
    ], { duration: 160, easing: "ease-out" }));
  }
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
    if (!mode || mode.pending || mode.drag || event.button !== 0 || !item) return;
    clearReorderSettle();
    selectReorderImage(item.dataset.id);
    const bounds = item.getBoundingClientRect();
    const drag = { id: item.dataset.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false, frame: 0, originalIds: mode.ids.slice(),
      offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, animations: new Map(), ghost: null };
    mode.drag = drag;
    grid.setPointerCapture(event.pointerId);
    const tick = () => {
      if (state.reorder?.drag !== drag) return;
      if (drag.moved) {
        previewReorderDrag(drag);
      }
      drag.frame = requestAnimationFrame(tick);
    };
    drag.frame = requestAnimationFrame(tick);
  });
  grid.addEventListener("pointermove", (event) => {
    const drag = state.reorder?.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
      drag.moved = true;
      const item = state.overviewNodes.get(drag.id);
      const bounds = item.getBoundingClientRect();
      drag.ghost = item.cloneNode(true);
      drag.ghost.classList.add("reorder-ghost"); drag.ghost.classList.remove("reorder-placeholder");
      drag.ghost.removeAttribute("id"); drag.ghost.removeAttribute("data-id");
      drag.ghost.setAttribute("aria-hidden", "true"); drag.ghost.inert = true;
      drag.ghost.style.width = `${bounds.width}px`; drag.ghost.style.height = `${bounds.height}px`;
      drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0)`;
      document.body.append(drag.ghost);
      item.classList.add("reorder-placeholder");
    }
    grid.classList.toggle("reorder-dragging", drag.moved);
  });
  grid.addEventListener("pointerup", (event) => {
    const mode = state.reorder; const drag = mode?.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) { drag.x = event.clientX; drag.y = event.clientY; previewReorderDrag(drag); }
    stopReorderDrag(false, drag.moved);
  });
  const cancelDrag = (event) => { if (state.reorder?.drag?.pointerId === event.pointerId) stopReorderDrag(true); };
  grid.addEventListener("pointercancel", cancelDrag);
  grid.addEventListener("lostpointercapture", cancelDrag);
}
