const thumbnailObservers = new Map();
const catalogWindows = new Map();
function thumbnailObserver(scope) {
  if (thumbnailObservers.has(scope)) return thumbnailObservers.get(scope);
  const root = scope === "overview" ? $("#overviewGrid") : $("#gallery");
  const observer = new IntersectionObserver((entries) => { for (const entry of entries) { if (!entry.isIntersecting) continue; observer.unobserve(entry.target); loadThumbnail(entry.target); } }, { root, rootMargin: "320px" });
  thumbnailObservers.set(scope, observer); return observer;
}
function thumbnailSource(record) { const version = imageAssetVersion(record); return `/api/thumbnail/${encodeURIComponent(record.id)}${version ? `?v=${encodeURIComponent(version)}` : ""}`; }
function thumbnailFailure(image) {
  delete image.dataset.loaded;
  const notice = image.closest?.(".gallery-item, .overview-item")?.querySelector(".thumbnail-error");
  if (!notice) return;
  notice.hidden = false;
  notice.textContent = t("thumbnail.error");
  notice.onclick = (event) => { event.preventDefault(); event.stopPropagation(); retryThumbnail(image); };
  notice.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); retryThumbnail(image);
  };
  notice.setAttribute("role", "button"); notice.tabIndex = 0;
}
function retryThumbnail(image) {
  const notice = image.closest?.(".gallery-item, .overview-item")?.querySelector(".thumbnail-error");
  if (notice) notice.hidden = true;
  delete image.dataset.loaded;
  image.removeAttribute("src");
  loadThumbnail(image);
}
function loadThumbnail(image) {
  const source = image.dataset.src;
  if (!source || image.dataset.loaded === source) return;
  const notice = image.closest?.(".gallery-item, .overview-item")?.querySelector(".thumbnail-error");
  if (notice) notice.hidden = true;
  image.dataset.loaded = source;
  image.onerror = () => thumbnailFailure(image);
  image.onload = () => { if (image.dataset.loaded === source) image.onerror = null; };
  image.src = source;
}
function observeThumbnail(image, record, scope = "gallery") {
  const source = thumbnailSource(record);
  if (image.dataset.src !== source) forgetThumbnail(image);
  image.dataset.src = source; image.loading = "lazy"; image.decoding = "async";
  if (image.dataset.loaded === source) return;
  thumbnailObserver(scope).observe(image);
}
function forgetThumbnail(image) { if (!image) return; for (const observer of thumbnailObservers.values()) observer.unobserve(image); image.removeAttribute?.("src"); image.dataset.src = ""; delete image.dataset.loaded; const notice = image.closest?.(".gallery-item, .overview-item")?.querySelector(".thumbnail-error"); if (notice) notice.hidden = true; }

function catalogWindow(scope, container, nodes, options) {
  let windowState = catalogWindows.get(scope);
  if (windowState) return windowState;
  const spacer = document.createElement("div"); spacer.className = "catalog-window-spacer";
  spacer.setAttribute?.("aria-hidden", "true");
  container.append(spacer);
  container.classList.add?.("catalog-window");
  container.setAttribute?.("role", "grid");
  container.setAttribute?.("aria-multiselectable", String(scope === "overview"));
  windowState = { scope, container, nodes, spacer, options, images: [], rows: new Map(), frame: 0, focusId: null };
  const schedule = () => {
    if (windowState.frame) return;
    windowState.frame = requestAnimationFrame(() => { windowState.frame = 0; renderCatalogWindow(windowState); });
  };
  container.addEventListener("scroll", schedule, { passive: true });
  if (typeof window !== "undefined") window.addEventListener?.("resize", () => renderCatalogWindow(windowState));
  catalogWindows.set(scope, windowState); return windowState;
}

function catalogLayout(windowState) {
  const { container, options } = windowState;
  const width = Math.max(1, (Number(container.clientWidth) || options.minWidth + options.padding * 2) - options.padding * 2);
  const cssColumns = Number(globalThis.getComputedStyle?.(container).getPropertyValue("--catalog-columns"));
  const columns = cssColumns || options.columns || Math.max(1, Math.floor((width + options.gap) / (options.minWidth + options.gap)));
  const itemWidth = (width - (columns - 1) * options.gap) / columns;
  return { columns, itemWidth, rowHeight: options.rowHeight, totalHeight: Math.ceil(windowState.images.length / columns) * options.rowHeight + options.padding * 2 };
}

function catalogRow(windowState, row, layout) {
  let rowNode = windowState.rows.get(row);
  if (!rowNode) {
    rowNode = document.createElement("div"); rowNode.className = "catalog-window-row"; rowNode.setAttribute("role", "row"); windowState.rows.set(row, rowNode);
  }
  rowNode.setAttribute("aria-rowindex", String(row + 1)); rowNode.style.height = `${layout.rowHeight - windowState.options.gap}px`;
  rowNode.style.transform = `translateY(${windowState.options.padding + row * layout.rowHeight}px)`;
  rowNode.style.left = `${windowState.options.padding}px`; rowNode.style.right = `${windowState.options.padding}px`;
  rowNode.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`; rowNode.style.columnGap = `${windowState.options.gap}px`;
  if (rowNode.parentNode !== windowState.container) windowState.container.append(rowNode);
  return rowNode;
}

function setCatalogNode(windowState, image, index, layout, rowNode) {
  const { scope, nodes, options } = windowState;
  let item = nodes.get(image.id); let cell = item?.parentNode;
  if (!item) {
    item = document.querySelector(options.template).content.firstElementChild.cloneNode(true); cell = document.createElement("div"); cell.className = "catalog-window-cell"; cell.setAttribute("role", "gridcell"); cell.append(item); nodes.set(image.id, item);
  }
  const row = Math.floor(index / layout.columns); const column = index % layout.columns;
  item.dataset.id = image.id; item.dataset.index = String(index); item.style.width = ""; item.style.height = `${layout.rowHeight - options.gap}px`; item.style.transform = "";
  const current = image.id === state.currentId;
  const batchSelected = scope === "overview" && state.batchMode && state.selectedImageIds.has(image.id);
  item.classList.toggle("current", current); item.classList.toggle("batch-selected", batchSelected); item.classList.toggle("hidden", isHidden(image));
  if (current) item.setAttribute("aria-current", "true"); else item.removeAttribute?.("aria-current");
  if (scope === "overview" && state.batchMode) item.setAttribute("aria-pressed", String(batchSelected)); else item.removeAttribute?.("aria-pressed");
  cell.setAttribute("aria-selected", String(scope === "gallery" ? current : batchSelected));
  cell.setAttribute("aria-colindex", String(column + 1));
  const displayPath = imageDisplayPath(image);
  const preview = item.querySelector("img"); observeThumbnail(preview, image, scope); preview.alt = displayPath;
  const flipH = (image.flipH === true) !== (image.sourceFlipH === true); const flipV = (image.flipV === true) !== (image.sourceFlipV === true);
  preview.style.transform = flipH || flipV ? `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` : "";
  // Overview is initially rendered in a hidden panel.  Some Chromium builds
  // do not deliver that first IntersectionObserver entry after it becomes
  // visible, so load its small mounted window immediately.
  if (scope === "overview") loadThumbnail(preview);
  const reviewed = isReviewed(image);
  item.classList.toggle("reviewed", reviewed);
  if (scope === "gallery") {
    item.querySelector(".gallery-name").textContent = displayPath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} × ${image.height}`;
    item.querySelector(".gallery-review-badge").textContent = reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.setAttribute("aria-label", [displayPath, reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge")].join(t("a11y.separator")));
    item.onclick = () => { windowState.focusId = image.id; selectCatalogImage(image.id); };
    item.onmouseenter = () => { state.hoverPrefetchId = image.id; schedulePrefetch(image); };
    item.onmouseleave = () => { if (state.hoverPrefetchId === image.id) { state.hoverPrefetchId = null; syncResourceOwnership(); } };
  } else {
    item.querySelector(".overview-item-name").textContent = displayPath.split(/[\\/]/).pop();
    item.querySelector(".overview-item-dimensions").textContent = `${image.width} × ${image.height}`;
    item.querySelector(".overview-review-badge").textContent = reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.title = displayPath;
    const states = [displayPath]; if (reviewed) states.push(t("overview.stateReviewed")); if (imageHasMask(image)) states.push(t("overview.stateMasked"));
    item.setAttribute("aria-label", states.join(t("a11y.separator")));
    item.onclick = (event) => { windowState.focusId = image.id; selectOverviewImage(image.id, event); };
  }
  item.onpointerdown = (event) => { if (event.button === 2) event.preventDefault?.(); };
  item.oncontextmenu = (event) => { openCatalogContextMenu(event, image.id); };
  item.tabIndex = image.id === windowState.focusId ? 0 : -1; item.setAttribute("aria-haspopup", "menu");
  item.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault?.(); event.stopPropagation?.(); windowState.focusId = image.id; scope === "gallery" ? selectCatalogImage(image.id) : selectOverviewImage(image.id, event); }
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault?.(); event.stopPropagation?.(); openCatalogContextMenu(event, image.id); }
    else { const targetIndex = catalogMoveIndex(windowState, index, event); if (targetIndex >= 0) { event.preventDefault?.(); event.stopPropagation?.(); focusCatalogIndex(windowState, targetIndex, event); } }
  };
  const expectedCell = rowNode.children[column];
  if (expectedCell !== cell) rowNode.insertBefore(cell, expectedCell || null);
}

function catalogMoveIndex(windowState, index, event) {
  const { key } = event; const { columns, rowHeight } = catalogLayout(windowState); const length = windowState.images.length;
  if (!length) return -1;
  const page = Math.max(1, Math.floor((Number(windowState.container.clientHeight) || rowHeight) / rowHeight) - 1) * columns;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(length - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - columns);
  if (key === "ArrowDown") return Math.min(length - 1, index + columns);
  if (key === "PageUp") return Math.max(0, index - page);
  if (key === "PageDown") return Math.min(length - 1, index + page);
  if (key === "Home") return event.ctrlKey || event.metaKey ? 0 : Math.floor(index / columns) * columns;
  if (key === "End") return event.ctrlKey || event.metaKey ? length - 1 : Math.min(length - 1, (Math.floor(index / columns) + 1) * columns - 1);
  return -1;
}

function focusCatalogIndex(windowState, index, event = null) {
  const image = windowState.images[index]; if (!image) return;
  windowState.focusId = image.id;
  scrollCatalogImage(windowState.scope, image.id);
  const item = windowState.nodes.get(image.id); focusElement(item);
  if (windowState.scope === "overview" && state.batchMode && event?.shiftKey) selectOverviewImage(image.id, event);
}

function renderCatalogWindow(windowState) {
  const { container, nodes, spacer, options } = windowState;
  const layout = catalogLayout(windowState); spacer.style.height = `${layout.totalHeight}px`;
  container.setAttribute?.("aria-rowcount", String(Math.ceil(windowState.images.length / layout.columns)));
  container.setAttribute?.("aria-colcount", String(layout.columns));
  if (!windowState.images.some((image) => image.id === windowState.focusId)) windowState.focusId = windowState.images.find((image) => image.id === state.currentId)?.id || windowState.images[0]?.id || null;
  const viewport = Number(container.clientHeight) || Number.MAX_SAFE_INTEGER;
  const scrollTop = Number(container.scrollTop) || 0;
  const firstRow = Math.max(0, Math.floor(scrollTop / layout.rowHeight) - options.overscan);
  const lastRow = Math.min(Math.ceil(windowState.images.length / layout.columns), Math.ceil((scrollTop + viewport) / layout.rowHeight) + options.overscan);
  const first = firstRow * layout.columns; const last = Math.min(windowState.images.length, lastRow * layout.columns);
  const mounted = new Set(windowState.images.slice(first, last).map((image) => image.id));
  let clearedHover = false;
  for (const [id, item] of nodes) if (!mounted.has(id)) {
    if (state.hoverPrefetchId === id) {
      state.hoverPrefetchId = null;
      clearedHover = true;
    }
    forgetThumbnail(item.querySelector("img")); item.parentNode.remove(); nodes.delete(id);
  }
  for (const [row, rowNode] of windowState.rows) if (row < firstRow || row >= lastRow) { rowNode.remove(); windowState.rows.delete(row); }
  let previousRow = spacer;
  for (let row = firstRow; row < lastRow; row += 1) {
    const rowNode = catalogRow(windowState, row, layout); const rowStart = row * layout.columns;
    if (rowNode.previousElementSibling !== previousRow) container.insertBefore(rowNode, previousRow.nextElementSibling);
    previousRow = rowNode;
    for (let index = rowStart; index < Math.min(windowState.images.length, rowStart + layout.columns); index += 1) setCatalogNode(windowState, windowState.images[index], index, layout, rowNode);
  }
  for (const item of nodes.values()) item.style.visibility = "";
  if (clearedHover) syncResourceOwnership();
  return layout;
}

function renderCatalog(scope, images, nodes, options) {
  if (!document.createElement) {
    const ids = new Set(images.map((image) => image.id));
    let clearedHover = false;
    for (const [id, item] of nodes) if (!ids.has(id)) {
      if (state.hoverPrefetchId === id) {
        state.hoverPrefetchId = null;
        clearedHover = true;
      }
      forgetThumbnail(item.querySelector("img")); item.parentNode.remove(); nodes.delete(id);
    }
    if (clearedHover) syncResourceOwnership();
    return null;
  }
  const windowState = catalogWindow(scope, $(options.container), nodes, options);
  if (!nodes.size && windowState.rows.size) { for (const row of windowState.rows.values()) row.remove(); windowState.rows.clear(); }
  windowState.images = images;
  return renderCatalogWindow(windowState);
}

function resetCatalogWindows() {
  for (const windowState of catalogWindows.values()) {
    windowState.focusId = null;
    windowState.container.scrollTop = 0;
  }
}

function scrollCatalogImage(scope, imageId, behavior = "auto") {
  const windowState = catalogWindows.get(scope); if (!windowState) return;
  const index = windowState.images.findIndex((image) => image.id === imageId); if (index < 0) return;
  const layout = catalogLayout(windowState); const row = Math.floor(index / layout.columns);
  const rowTop = windowState.options.padding + row * layout.rowHeight;
  const rowBottom = rowTop + layout.rowHeight;
  const viewport = Number(windowState.container.clientHeight) || layout.rowHeight;
  const current = Number(windowState.container.scrollTop) || 0;
  const target = row === 0 ? 0 : (rowTop < current ? rowTop : rowBottom > current + viewport ? Math.max(0, rowBottom - viewport) : current);
  windowState.container.scrollTo?.({ top: target, behavior });
  if (!windowState.container.scrollTo) windowState.container.scrollTop = target;
  renderCatalogWindow(windowState);
}

function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const visibleImages = state.images.filter(imageMatchesGalleryFilter);
  const imageCount = t("gallery.count", { count: visibleImages.length });
  for (const element of document.querySelectorAll(".gallery-local-count")) element.textContent = imageCount;
  document.querySelectorAll("[data-gallery-filter]").forEach((input) => { input.checked = state.galleryFilter.has(input.dataset.galleryFilter); });
  updateFilterMenuButtons();
  $("#galleryEmptyState").hidden = state.images.length !== 0;
  $("#galleryFilteredEmptyState").hidden = !(state.images.length && !visibleImages.length);
  renderCatalog("gallery", visibleImages, state.galleryNodes, { container: "#gallery", template: "#galleryItemTemplate", padding: 8, gap: 8, minWidth: 108, rowHeight: 152, overscan: 3 });
  syncResourceOwnership();
  updateActionButtons();
}

function imageMatchesStateFilter(image, filters) {
  if (!filters.size) return true;
  if (isHidden(image)) return filters.has("hidden");
  return (filters.has("masked") && imageHasMask(image))
    || (filters.has("unmasked") && !imageHasMask(image))
    || (filters.has("reviewed") && isReviewed(image))
    || (filters.has("unreviewed") && !isReviewed(image));
}
function imageMatchesGalleryFilter(image) {
  return imageMatchesStateFilter(image, state.galleryFilter);
}
function galleryFilteredImages() { return state.images.filter(imageMatchesGalleryFilter); }
function galleryNavigationNeighbors(imageId) {
  const images = galleryFilteredImages();
  const index = images.findIndex((image) => image.id === imageId);
  if (index < 0) return [...new Set([images.at(-1), images[0]].filter(Boolean))];
  return [images[index - 1], images[index + 1]].filter(Boolean);
}
function nextVisibleImage(images, imageId, { excludedImageIds = new Set(), fallback = false } = {}) {
  const index = images.findIndex((image) => image.id === imageId);
  const next = images.slice(index < 0 ? 0 : index + 1).find((image) => !excludedImageIds.has(image.id));
  if (next || index < 0 || !fallback) return next || null;
  return images.slice(0, index).reverse().find((image) => !excludedImageIds.has(image.id)) || null;
}
function nextGalleryFilteredImage(imageId, options = {}) { return nextVisibleImage(galleryFilteredImages(), imageId, options); }
function clearCurrentImageSelection() {
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
  state.candidates = []; state.candidateImages = new Map(); clearEditor();
  updateGalleryCurrent();
  if (state.viewMode === "overview") renderOverview();
}

function updateGalleryCurrent() {
  for (const item of state.galleryNodes.values()) {
    const current = item.dataset.id === state.currentId;
    item.classList.toggle("current", current);
    item.classList.toggle("batch-selected", false);
    if (current) item.setAttribute("aria-current", "true"); else item.removeAttribute?.("aria-current");
    item.removeAttribute?.("aria-pressed");
  }
  scrollCatalogImage("gallery", state.currentId);
  updateActionButtons();
}

function overviewFolderOptions() {
  const folders = new Set();
  for (const image of state.images) {
    const parts = image.relativePath.replaceAll("\\", "/").split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}
function overviewImages() {
  const query = state.overviewQuery.trim().toLowerCase();
  const folder = state.overviewFolder;
  return state.images.filter((image) => {
    if (!imageMatchesStateFilter(image, state.overviewFilter)) return false;
    const path = image.relativePath.replaceAll("\\", "/");
    if (folder && path !== folder && !path.startsWith(`${folder}/`)) return false;
    return !query || imageDisplayPath(image).toLowerCase().includes(query) || path.toLowerCase().includes(query);
  });
}
function reconcileOverviewSelection(visibleImages = overviewImages()) {
  if (!state.batchMode) return;
  const visibleIds = new Set(visibleImages.map((image) => image.id));
  state.selectedImageIds = new Set([...state.selectedImageIds].filter((imageId) => visibleIds.has(imageId)));
  if (!visibleIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;
  updateSelectionActionBar();
}
function syncOverviewFolders() {
  const select = $("#overviewFolder");
  const options = overviewFolderOptions();
  if (state.overviewFolder && !options.includes(state.overviewFolder)) state.overviewFolder = "";
  select.textContent = "";
  const all = document.createElement("option"); all.value = ""; all.textContent = t("overview.folder"); select.append(all);
  for (const folder of options) {
    const option = document.createElement("option"); option.value = folder; option.textContent = folder; select.append(option);
  }
  select.value = state.overviewFolder;
}
function selectOverviewImage(imageId, event = null) {
  const visibleImages = overviewImages();
  const index = visibleImages.findIndex((image) => image.id === imageId);
  if (index < 0) return;
  if (!state.batchMode) {
    setViewMode("edit");
    selectCatalogImage(imageId);
    return;
  }
  const additive = event?.ctrlKey || event?.metaKey;
  const anchor = event?.shiftKey ? visibleImages.findIndex((image) => image.id === state.selectionAnchorId) : -1;
  if (event?.shiftKey && anchor >= 0) {
    const ids = visibleImages.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((image) => image.id);
    if (additive) ids.forEach((id) => state.selectedImageIds.add(id)); else state.selectedImageIds = new Set(ids);
  } else {
    if (state.selectedImageIds.has(imageId)) state.selectedImageIds.delete(imageId); else state.selectedImageIds.add(imageId);
    state.selectionAnchorId = imageId;
  }
  updateSelectionActionBar();
  renderOverview();
}
function renderOverview(force = false) {
  if (!force && state.viewMode !== "overview") return;
  const grid = $("#overviewGrid");
  if (!grid) return;
  syncOverviewFolders();
  const visibleImages = overviewImages();
  reconcileOverviewSelection(visibleImages);
  $("#overviewCount").textContent = t("overview.count", { visible: visibleImages.length, total: state.images.length });
  document.querySelectorAll("[data-overview-filter]").forEach((input) => { input.checked = state.overviewFilter.has(input.dataset.overviewFilter); });
  updateFilterMenuButtons();
  $("#overviewEmptyState").hidden = visibleImages.length !== 0;
  renderCatalog("overview", visibleImages, state.overviewNodes, { container: "#overviewGrid", template: "#overviewItemTemplate", padding: 14, gap: 10, minWidth: 1, columns: 8, rowHeight: 182, overscan: 3 });
}
function renderCatalogViews() { renderGallery(); renderOverview(); }
function setViewMode(mode, refreshGallery = true) {
  if (state.viewMode !== mode) {
    closeBatchMoreMenus();
    closeFilterPopovers();
    state.batchMode = false;
    clearBatchSelection();
    updateSelectionActionBar();
  }
  const viewGeneration = ++state.viewGeneration;
  state.viewMode = mode;
  const active = mode === "overview";
  $(".studio-grid").classList.toggle("overview-active", active);
  $("#overviewPane").hidden = !active;
  if (!active) {
    discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
    if (refreshGallery) renderGallery(true);
    resizeRenderCanvas(); focusCanvas(); return;
  }
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  renderOverview(true);
  scrollCatalogImage("overview", state.currentId);
  requestAnimationFrame(() => {
    if (state.viewMode !== "overview" || state.viewGeneration !== viewGeneration) return;
    focusElement($("#overviewPane"));
  });
}
function moveCurrentBy(offset) {
  if (isGestureActive()) return;
  const visible = galleryFilteredImages(); const index = visible.findIndex((image) => image.id === state.currentId);
  const target = index < 0 ? (offset < 0 ? visible.at(-1) : visible[0]) : visible[index + offset];
  if (target) void selectImage(target.id);
}
async function reviewAndMoveNext() {
  const current = currentRecord();
  if (isGestureActive() || currentImageActionPending() || !current) return null;
  const currentId = current.id;
  const filteredImages = galleryFilteredImages();
  const target = nextVisibleImage(filteredImages, currentId);
  const reviewed = await queueImageMutation(currentId, async () => {
    const scroll = state.contextMenuScroll;
    return saveWorkspaceFlagNow(current, "reviewed", true, () => {
      if (state.images.some((image) => image.id === current.id)) refreshReviewViews(scroll);
    });
  }, { lockCandidateControls: true });
  if (!reviewed) return null;
  if (!hasDurableHistory() && state.currentId === currentId && typeof recordHistoryOperation === "function") recordHistoryOperation({ kind: "workspaceFlag" });
  if (state.currentId !== currentId) return target;
  if (target && state.images.some((image) => image.id === target.id)) {
    await selectImage(target.id);
    return target;
  }
  return null;
}
async function hideAndMoveNext() {
  if (isGestureActive() || currentImageActionPending()) return;
  const current = currentRecord();
  if (!current) return;
  const currentId = current.id;
  const target = nextGalleryFilteredImage(currentId);
  if (!await setHidden(current, true)) return;
  if (state.currentId !== currentId) return;
  if (target) await selectImage(target.id);
}
async function runNavigationAction(action) {
  await action();
  focusCanvas();
}
function updateNavigationControls() {
  const visibleImages = galleryFilteredImages();
  const index = visibleImages.findIndex((image) => image.id === state.currentId);
  const position = index < 0 ? `- / ${visibleImages.length}` : `${index + 1} / ${visibleImages.length}`;
  $("#imagePosition").textContent = position;
  const status = $("#reviewStatus");
  const record = currentRecord();
  const reviewed = record ? isReviewed(record) : false;
  status.textContent = record ? t(reviewed ? "review.reviewed" : "review.unreviewed") : "-";
  status.classList.toggle("reviewed", Boolean(record) && reviewed);
}
