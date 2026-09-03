// Durable edits live on the local server.  Keep this queue per image so a
// quick image switch never lets an earlier canvas snapshot overwrite a later one.
state.workspaceDraftChains = new Map();
state.workspaceDraftTimers = new Map();
state.workspaceMutationErrors = new Map();
state.workspaceFlagPending = new Map();

function queueWorkspaceMutation(imageId, send, rememberFailure = true) {
  const previous = state.workspaceDraftChains.get(imageId) || Promise.resolve();
  const next = previous.catch(() => {}).then(send);
  state.workspaceDraftChains.set(imageId, next);
  if (rememberFailure) next.then(
    () => {},
    (error) => { state.workspaceMutationErrors.set(imageId, error); },
  );
  return next;
}
function queueWorkspaceFlags(imageId, payload) {
  if (!imageId) return Promise.resolve();
  return queueWorkspaceMutation(imageId, () => api(`/api/workspace/image/${encodeURIComponent(imageId)}`, {
    method: "POST", body: JSON.stringify(payload),
  }), false);
}

const DIRECTORY_DB = "mozarie-directory-catalogs";
function projectSourceId() { return globalThis.crypto?.randomUUID?.() || `source-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
async function directoryCatalogStore() {
  if (!window.indexedDB) return null;
  return new Promise((resolve) => {
    const request = indexedDB.open(DIRECTORY_DB, 2);
    request.onupgradeneeded = () => {
      const names = request.result.objectStoreNames;
      if (!names?.contains?.("directories")) request.result.createObjectStore("directories", { keyPath: "catalogId" });
      if (!names?.contains?.("projectSources")) request.result.createObjectStore("projectSources", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function rememberProjectSource(projectId, handle, imageId = null, sourceId = null) {
  const db = await directoryCatalogStore(); if (!db || !projectId || !handle) return sourceId || projectSourceId();
  try {
    const store = db.transaction("projectSources", "readwrite").objectStore("projectSources");
    const stableId = sourceId || projectSourceId();
    store.put({ key: `${projectId}:${stableId}:${imageId || "root"}`, projectId, imageId, sourceId: stableId, handle });
    return stableId;
  } catch { return sourceId || projectSourceId(); }
  finally { db.close(); }
}
async function rememberedProjectSource(projectId, sourceId = null, imageId = null) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return null;
  const rows = await new Promise((resolve) => { const request = db.transaction("projectSources").objectStore("projectSources").getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]); });
  const value = rows.find((row) => row.projectId === projectId && (!sourceId || row.sourceId === sourceId) && (imageId == null ? !row.imageId : row.imageId === imageId));
  db.close(); return value?.handle || null;
}
async function rememberedProjectFileSources(projectId) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return [];
  const rows = await new Promise((resolve) => {
    const request = db.transaction("projectSources").objectStore("projectSources").getAll();
    request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]);
  });
  db.close();
  // Preserve the server source ID.  Recreating one on every reopen would
  // create a second source and duplicate every browser-imported image.
  return rows.filter((row) => row.projectId === projectId && row.imageId && row.handle?.kind === "file")
    .map((row) => ({ sourceId: row.sourceId, handle: row.handle }));
}
async function rememberedProjectDirectorySources(projectId) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return [];
  const rows = await new Promise((resolve) => {
    const request = db.transaction("projectSources").objectStore("projectSources").getAll();
    request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]);
  });
  db.close();
  return rows.filter((row) => row.projectId === projectId && !row.imageId && row.handle?.kind === "directory")
    .map((row) => ({ sourceId: row.sourceId, handle: row.handle }));
}
async function forgetProjectSources(projectId) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return;
  try {
    const rows = await new Promise((resolve) => {
      const request = db.transaction("projectSources").objectStore("projectSources").getAll();
      request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]);
    });
    const store = db.transaction("projectSources", "readwrite").objectStore("projectSources");
    for (const row of rows) if (row.projectId === projectId) store.delete(row.key);
  } catch { /* Local handle cleanup is best effort and never blocks deletion. */ }
  finally { db.close(); }
}
async function ensureProjectSourcePermission(handle, request = false) {
  if (!handle?.queryPermission) return Boolean(handle);
  try {
    const mode = "read";
    const current = await handle.queryPermission({ mode });
    if (current === "granted") return true;
    if (!request || !handle.requestPermission) return false;
    return (await handle.requestPermission({ mode })) === "granted";
  } catch { return false; }
}
async function rememberedOutputDirectoryHandle() {
  const db = await directoryCatalogStore();
  if (!db) return null;
  const handle = await new Promise((resolve) => {
    const request = db.transaction("directories").objectStore("directories").get("output-directory");
    request.onsuccess = () => resolve(request.result?.handle || null); request.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}
async function rememberOutputDirectoryHandle(handle) {
  const db = await directoryCatalogStore();
  if (!db) return;
  try { db.transaction("directories", "readwrite").objectStore("directories").put({ catalogId: "output-directory", handle }); }
  catch { /* Directory selection remains usable without persistence. */ }
  db.close();
}
async function catalogForDirectoryHandle(handle) {
  if (state.project?.id) {
    const activated = await api("/api/workspace/catalog", { method: "POST", body: JSON.stringify({ catalogId: state.project.id }) });
    state.pendingDirectorySourceId = await rememberProjectSource(state.project.id, handle);
    return activated.catalogId || state.project.id;
  }
  // A folder is never silently matched to a prior project.  Project history
  // remains explicit; opening an older project is done from its own list.
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({}) });
  state.project = created.project || null;
  state.projectReadOnly = false;
  if (!state.project?.id) return null;
  state.pendingDirectorySourceId = await rememberProjectSource(state.project.id, handle);
  return state.project.id;
}

function workspaceDraftPayload(draft) {
  if (!draft) return { add: "", exclusion: "", exclusionErase: "", hasEffectiveMask: false, removedCandidateIds: [], candidateRevision: 0 };
  return {
    add: draft.add || "", exclusion: draft.exclusion || "", exclusionErase: draft.exclusionErase || "",
    manualEnabled: draft.manualEnabled !== false, manualExclusionEnabled: draft.manualExclusionEnabled !== false,
    manualExclusionEraseEnabled: draft.manualExclusionEraseEnabled !== false, manualExclusionForced: draft.manualExclusionForced !== false,
    hasEffectiveMask: draft.hasEffectiveMask === true,
    removedCandidateIds: draft.removedCandidateIds || [], candidateRevision: Number(draft.candidateRevision || 0),
  };
}

function queueWorkspaceDraft(imageId, immediate = false) {
  if (!imageId || !state.images.some((image) => image.id === imageId)) return Promise.resolve();
  const previousTimer = state.workspaceDraftTimers.get(imageId);
  if (previousTimer) clearTimeout(previousTimer);
  const write = () => {
    state.workspaceDraftTimers.delete(imageId);
    const draft = state.drafts.get(imageId);
    const payload = workspaceDraftPayload(draft);
    const request = draft
      ? { method: "POST", body: JSON.stringify(payload) }
      : { method: "DELETE" };
    const persisted = queueWorkspaceMutation(imageId, () => api(`/api/workspace/manual/${encodeURIComponent(imageId)}`, request));
    return persisted.then((result) => {
      // A project has a durable copy and can reload an inactive draft on
      // demand.  Projectless sessions have no equivalent recovery path, so
      // they deliberately keep the in-memory bitmap.
      if (
        state.project?.id && state.currentId !== imageId
        && state.drafts.get(imageId) === draft
        && !state.workspaceDraftTimers.has(imageId)
        && !state.draftSaveChains.has(imageId)
        && !state.workspaceMutationErrors.has(imageId)
        && state.workspaceDraftChains.get(imageId) === persisted
      ) {
        state.drafts.delete(imageId);
        state.maskStatus.delete(imageId);
      }
      return result;
    });
  };
  if (immediate) return write();
  const promise = new Promise((resolve) => state.workspaceDraftTimers.set(imageId, setTimeout(() => resolve(write().catch((error) => { showUserError(error); })), 250)));
  return promise;
}

function draftSaveEntries(imageIds = null) {
  const wanted = imageIds == null ? null : new Set(imageIds);
  return [...state.draftSaveChains.entries()].filter(([imageId]) => !wanted || wanted.has(imageId));
}

async function flushDraftSaves(imageIds = null) {
  const wanted = imageIds == null ? null : new Set(imageIds);
  if (state.currentId && state.draftDirty && (!wanted || wanted.has(state.currentId))) await saveDraft();
  while (true) {
    const chains = draftSaveEntries(imageIds);
    const results = await Promise.allSettled(chains.map(([, chain]) => chain));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const current = draftSaveEntries(imageIds);
    if (current.length === chains.length && current.every(([imageId, chain]) => chains.some(([knownId, known]) => knownId === imageId && known === chain))) return;
  }
}

async function flushWorkspaceDraft(imageId) {
  await flushDraftSaves([imageId]);
  while (true) {
    const timer = state.workspaceDraftTimers.get(imageId);
    if (timer) { clearTimeout(timer); state.workspaceDraftTimers.delete(imageId); await queueWorkspaceDraft(imageId, true); }
    const chain = state.workspaceDraftChains.get(imageId);
    await (chain || Promise.resolve());
    const failure = state.workspaceMutationErrors.get(imageId);
    if (failure) { state.workspaceMutationErrors.delete(imageId); throw failure; }
    if (!state.workspaceDraftTimers.has(imageId) && state.workspaceDraftChains.get(imageId) === chain) return;
  }
}

async function flushAllWorkspaceMutations() {
  while (true) {
    await flushDraftSaves();
    const dirtyIds = [...state.workspaceDraftTimers.keys()];
    for (const imageId of dirtyIds) {
      clearTimeout(state.workspaceDraftTimers.get(imageId));
      state.workspaceDraftTimers.delete(imageId);
      await queueWorkspaceDraft(imageId, true);
    }
    const chains = [...state.workspaceDraftChains.entries()];
    const results = await Promise.allSettled(chains.map(([, chain]) => chain));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const failedImageId = chains.map(([imageId]) => imageId).find((imageId) => state.workspaceMutationErrors.has(imageId));
    if (failedImageId) {
      const storedFailure = state.workspaceMutationErrors.get(failedImageId);
      state.workspaceMutationErrors.delete(failedImageId);
      throw storedFailure;
    }
    const stable = [...state.workspaceDraftChains.entries()];
    if (!state.workspaceDraftTimers.size && stable.length === chains.length && stable.every(([imageId, chain]) => chains.some(([knownId, known]) => knownId === imageId && known === chain))) return;
  }
}

async function loadWorkspaceDraft(imageId) {
  const data = await api(`/api/workspace/manual/${encodeURIComponent(imageId)}`);
  const draft = data.draft;
  if (!draft) return null;
  // Project undo is restored by the durable history endpoint. Keeping a
  // second operation log inside every draft duplicates PNG payloads.
  return { ...draft, history: [], historyIndex: 0, historyBase: {} };
}

function scheduleManualWorkspaceSave() {
  const imageId = state.currentId;
  if (!imageId) return Promise.resolve();
  const previous = state.draftSaveChains.get(imageId) || Promise.resolve();
  const next = previous.then(() => new Promise((resolve, reject) => setTimeout(() => {
    try { saveDraft(); resolve(); } catch (error) { reject(error); }
  }, 0)));
  state.draftSaveChains.set(imageId, next);
  next.finally(() => { if (state.draftSaveChains.get(imageId) === next) state.draftSaveChains.delete(imageId); }).catch(() => {});
  return next;
}
