// Durable edits live on the local server.  Keep this queue per image so a
// quick image switch never lets an earlier canvas snapshot overwrite a later one.
state.workspaceDraftChains = new Map();
state.workspaceDraftTimers = new Map();
state.workspaceDraftPending = new Map();
state.workspaceMutationErrors = new Map();
state.workspaceFlagPending = new Map();

function queueWorkspaceMutation(imageId, send, rememberFailure = true) {
  const previous = state.workspaceDraftChains.get(imageId) || Promise.resolve();
  const next = previous.catch(() => {}).then(send);
  state.workspaceDraftChains.set(imageId, next);
  const clearSettledChain = () => {
    if (state.workspaceDraftChains.get(imageId) === next) state.workspaceDraftChains.delete(imageId);
  };
  next.then(clearSettledChain, clearSettledChain);
  if (rememberFailure) next.then(
    () => {
      state.workspaceMutationErrors.delete(imageId);
      if (state.workspaceUnsavedImageId === imageId) {
        delete state.workspaceUnsavedImageId;
        if (state.status?.key === "status.workspaceUnsaved") clearStatus();
      }
    },
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
const PROJECT_SOURCE_CLEANUP_KEY = "project-source-cleanup";
function projectSourceId() { return crypto.randomUUID(); }
async function directoryCatalogStore() {
  if (!window.indexedDB) return null;
  return new Promise((resolve) => {
    const request = indexedDB.open(DIRECTORY_DB, 4);
    request.onupgradeneeded = () => {
      const names = request.result.objectStoreNames;
      if (!names?.contains?.("directories")) request.result.createObjectStore("directories", { keyPath: "catalogId" });
      const sources = names?.contains?.("projectSources")
        ? request.transaction.objectStore("projectSources")
        : request.result.createObjectStore("projectSources", { keyPath: "key" });
      if (!sources.indexNames.contains("projectId")) sources.createIndex("projectId", "projectId", { unique: false });
      if (!names?.contains?.("sourceDeletes")) request.result.createObjectStore("sourceDeletes", { keyPath: "deleteToken" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function rememberPendingSourceDelete(payload) {
  const db = await directoryCatalogStore(); if (!db) throw codedError("source_delete_recovery_unavailable");
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("sourceDeletes", "readwrite");
      transaction.objectStore("sourceDeletes").put({ ...payload, savedAt: Date.now() });
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  } catch { throw codedError("source_delete_recovery_unavailable"); }
  finally { db.close(); }
}

async function forgetPendingSourceDelete(deleteToken) {
  const db = await directoryCatalogStore(); if (!db || !deleteToken) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("sourceDeletes", "readwrite"); transaction.objectStore("sourceDeletes").delete(deleteToken);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

async function pendingSourceDeletes() {
  const db = await directoryCatalogStore(); if (!db) return [];
  try { return await new Promise((resolve) => { const request = db.transaction("sourceDeletes").objectStore("sourceDeletes").getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]); }); }
  finally { db.close(); }
}

function projectSourceRows(db, projectId) {
  return new Promise((resolve) => {
    const request = db.transaction("projectSources").objectStore("projectSources").index("projectId").getAll(IDBKeyRange.only(projectId));
    request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]);
  });
}

async function rememberProjectSources(projectId, sources) {
  const prepared = sources.map((source) => ({ ...source, stableId: source.sourceId || projectSourceId() }));
  if (!prepared.length) return [];
  if (!projectId) return prepared.map((source) => source.stableId);
  if (prepared.some((source) => !source.handle)) throw codedError("project_source_unavailable");
  const db = await directoryCatalogStore();
  if (!db) throw codedError("project_source_unavailable");
  try {
    await new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction("projectSources", "readwrite");
        const store = transaction.objectStore("projectSources");
        for (const source of prepared) {
          const keyPart = source.imageId || (source.clientKey ? `pending:${source.clientKey}` : "root");
          store.put({
            key: `${projectId}:${source.stableId}:${keyPart}`,
            projectId, imageId: source.imageId || null, sourceId: source.stableId, clientKey: source.clientKey || null, relativePath: source.relativePath || null, handle: source.handle,
          });
          if (source.imageId && source.clientKey) store.delete(`${projectId}:${source.stableId}:pending:${source.clientKey}`);
        }
      } catch (error) {
        reject(error); return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(codedError("project_source_unavailable"));
      transaction.onabort = () => reject(codedError("project_source_unavailable"));
    });
    return prepared.map((source) => source.stableId);
  } catch (error) {
    if (error?.code) throw error;
    throw codedError("project_source_unavailable");
  } finally { db.close(); }
}

async function rememberProjectSource(projectId, handle, imageId = null, sourceId = null, clientKey = null, relativePath = null) {
  return (await rememberProjectSources(projectId, [{ handle, imageId, sourceId, clientKey, relativePath }]))[0];
}

async function forgetPendingProjectSource(projectId, sourceId, clientKey) {
  const db = await directoryCatalogStore();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction("projectSources", "readwrite");
        transaction.objectStore("projectSources").delete(`${projectId}:${sourceId}:pending:${clientKey}`);
      } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

async function forgetProjectImageSources(projectId, imageIds) {
  const db = await directoryCatalogStore();
  const removed = new Set(imageIds || []);
  if (!db || !projectId || !removed.size) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("projectSources", "readwrite");
      const store = transaction.objectStore("projectSources");
      const request = store.index("projectId").getAll(IDBKeyRange.only(projectId));
      request.onsuccess = () => { for (const row of request.result || []) if (removed.has(row.imageId)) store.delete(row.key); };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return true;
  } catch {
    await Promise.all([...removed].map((imageId) => rememberProjectImageSourceCleanup(projectId, imageId)));
    return false;
  }
  finally { db.close(); }
}

async function rememberProjectlessPromotionSources(projectId) {
  const sources = [...state.projectlessDirectorySources.entries()].map(([sourceId, source]) => ({ handle: source.handle, sourceId }));
  const directoryImageIds = new Set([...state.projectlessDirectorySources.values()].flatMap((source) => [...source.imageIds]));
  for (const image of state.images) {
    if (image.sourceKind !== "session" || directoryImageIds.has(image.id)) continue;
    const access = state.sourceAccess.get(image.id);
    if (!access?.fileHandle || access.sourceKind !== "browser-files" || !access.sourceId) throw codedError("project_source_unavailable");
    sources.push({ handle: access.fileHandle, imageId: image.id, sourceId: access.sourceId, clientKey: access.clientKey, relativePath: access.relativePath });
  }
  await rememberProjectSources(projectId, sources);
}
async function rememberedProjectSource(projectId, sourceId = null, imageId = null) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return null;
  const rows = await projectSourceRows(db, projectId);
  const value = rows.find((row) => row.projectId === projectId && (!sourceId || row.sourceId === sourceId) && (imageId == null ? !row.imageId : row.imageId === imageId));
  db.close(); return value?.handle || null;
}
async function rememberedProjectSources(projectId) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return { files: [], directories: [] };
  const rows = await projectSourceRows(db, projectId);
  db.close();
  // Preserve the server source ID.  Recreating one on every reopen would
  // create a second source and duplicate every browser-imported image.
  return {
    files: rows.filter((row) => (row.imageId || row.clientKey) && row.handle?.kind === "file")
      .map((row) => ({ imageId: row.imageId || null, sourceId: row.sourceId, clientKey: row.clientKey || null, relativePath: row.relativePath || row.handle.name, handle: row.handle })),
    directories: rows.filter((row) => !row.imageId && row.handle?.kind === "directory")
      .map((row) => ({ sourceId: row.sourceId, handle: row.handle })),
  };
}
async function matchingProjectDirectorySources(handle) {
  const db = await directoryCatalogStore(); if (!db || !handle?.isSameEntry) return [];
  try {
    const rows = await new Promise((resolve) => {
      const request = db.transaction("projectSources").objectStore("projectSources").getAll();
      request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]);
    });
    const matches = [];
    for (const row of rows) {
      if (!row.imageId && row.handle?.kind === "directory" && await handle.isSameEntry(row.handle).catch(() => false)) {
        matches.push({ projectId: row.projectId, sourceId: row.sourceId });
      }
    }
    return matches;
  } finally { db.close(); }
}
async function rememberProjectSourceCleanup(projectId) {
  const intentId = projectSourceId();
  const db = await directoryCatalogStore(); if (!db || !projectId) return null;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("directories", "readwrite");
      const store = transaction.objectStore("directories");
      const request = store.get(PROJECT_SOURCE_CLEANUP_KEY);
      request.onsuccess = () => {
        const intents = request.result?.intents || (request.result?.projectIds || []).map((id) => ({ projectId: id, intentId: `legacy:${id}` }));
        intents.push({ projectId, intentId });
        store.put({ ...request.result, catalogId: PROJECT_SOURCE_CLEANUP_KEY, intents });
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return intentId;
  } catch { return null; }
  finally { db.close(); }
}
async function rememberProjectImageSourceCleanup(projectId, imageId) {
  const intentId = projectSourceId();
  const db = await directoryCatalogStore(); if (!db || !projectId || !imageId) return null;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("directories", "readwrite");
      const store = transaction.objectStore("directories");
      const request = store.get(PROJECT_SOURCE_CLEANUP_KEY);
      request.onsuccess = () => {
        const value = request.result || { catalogId: PROJECT_SOURCE_CLEANUP_KEY };
        const imageIntents = value.imageIntents || [];
        imageIntents.push({ projectId, imageId, intentId });
        store.put({ ...value, catalogId: PROJECT_SOURCE_CLEANUP_KEY, imageIntents });
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
    return intentId;
  } catch { return null; }
  finally { db.close(); }
}
async function clearProjectSourceCleanup({ projectIds = [], intentIds = [] } = {}) {
  const removedProjects = new Set(projectIds);
  const removedIntents = new Set(intentIds);
  if (!removedProjects.size && !removedIntents.size) return;
  const db = await directoryCatalogStore(); if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("directories", "readwrite");
      const store = transaction.objectStore("directories");
      const request = store.get(PROJECT_SOURCE_CLEANUP_KEY);
      request.onsuccess = () => {
        const intents = request.result?.intents || (request.result?.projectIds || []).map((projectId) => ({ projectId, intentId: `legacy:${projectId}` }));
        store.put({ ...request.result, catalogId: PROJECT_SOURCE_CLEANUP_KEY,
          intents: intents.filter((intent) => !removedProjects.has(intent.projectId) && !removedIntents.has(intent.intentId)),
          imageIntents: (request.result?.imageIntents || []).filter((intent) => !removedProjects.has(intent.projectId) && !removedIntents.has(intent.intentId)),
        });
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { /* A later retry keeps the intent until it can be removed. */ }
  finally { db.close(); }
}
async function forgetProjectSources(projectId, { rememberFailure = true, clearIntent = true } = {}) {
  const db = await directoryCatalogStore(); if (!db || !projectId) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("projectSources", "readwrite");
      const store = transaction.objectStore("projectSources");
      const request = store.index("projectId").getAll(IDBKeyRange.only(projectId));
      request.onsuccess = () => { for (const row of request.result || []) store.delete(row.key); };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    if (clearIntent) await clearProjectSourceCleanup({ projectIds: [projectId] });
    return true;
  } catch {
    if (rememberFailure) await rememberProjectSourceCleanup(projectId);
    return false;
  }
  finally { db.close(); }
}
async function retryProjectSourceCleanup(existingProjectIds) {
  if (!(existingProjectIds instanceof Set)) return;
  const db = await directoryCatalogStore();
  if (!db) return;
  try {
    const pending = await new Promise((resolve) => {
      const request = db.transaction("directories").objectStore("directories").get(PROJECT_SOURCE_CLEANUP_KEY);
      request.onsuccess = () => resolve(request.result || {}); request.onerror = () => resolve({});
    });
    const projectIntents = pending.intents || (pending.projectIds || []).map((projectId) => ({ projectId, intentId: `legacy:${projectId}` }));
    const resolved = [];
    for (const projectId of new Set(projectIntents.map((intent) => intent.projectId))) {
      if (!existingProjectIds.has(projectId) && await forgetProjectSources(projectId, { rememberFailure: false, clearIntent: false })) resolved.push(projectId);
    }
    await clearProjectSourceCleanup({ projectIds: resolved });
    for (const intent of pending.imageIntents || []) {
      try {
        const status = await api(`/api/project/source-status?projectId=${encodeURIComponent(intent.projectId)}&imageId=${encodeURIComponent(intent.imageId)}`, { resyncOnStale: false });
        if (!status.exists && await forgetProjectImageSources(intent.projectId, [intent.imageId])) {
          await clearProjectSourceCleanup({ intentIds: [intent.intentId] });
        }
      } catch { /* Keep ambiguous cleanup intents for the next startup. */ }
    }
  } finally { db.close(); }
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
async function requestProjectSourcePermission(handle, mode = "read") {
  if (!handle?.requestPermission) return Boolean(handle);
  try { return (await handle.requestPermission({ mode })) === "granted"; }
  catch { return false; }
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
    state.pendingDirectorySourceId = await rememberProjectSource(state.project.id, handle);
    return state.project.id;
  }
  // Importing is usable without a project.  Durable project creation is an
  // explicit project-save action, never an import side effect.
  state.pendingDirectorySourceId = null;
  return null;
}

function workspaceDraftPayload(draft) {
  if (!draft) return { add: "", exclusion: "", exclusionErase: "", hasEffectiveMask: false, removedCandidateIds: [], candidateRevision: 0 };
  const incremental = Array.isArray(draft.dirtyLayers);
  const dirtyLayers = incremental ? draft.dirtyLayers : ["add", "exclusion", "exclusionErase"];
  const payload = {
    add: draft.add || "", exclusion: draft.exclusion || "", exclusionErase: draft.exclusionErase || "",
    manualEnabled: draft.manualEnabled !== false, manualExclusionEnabled: draft.manualExclusionEnabled !== false,
    manualExclusionEraseEnabled: draft.manualExclusionEraseEnabled !== false, manualExclusionForced: draft.manualExclusionForced !== false,
    hasEffectiveMask: draft.hasEffectiveMask === true,
    removedCandidateIds: draft.removedCandidateIds || [], candidateRevision: Number(draft.candidateRevision || 0),
  };
  if (incremental) {
    delete payload.add; delete payload.exclusion; delete payload.exclusionErase;
    payload.dirtyLayers = dirtyLayers;
    if (dirtyLayers.includes("add")) payload.add = draft.add || "";
    if (dirtyLayers.includes("exclusion")) payload.exclusion = draft.exclusion || "";
    if (dirtyLayers.includes("exclusionErase")) payload.exclusionErase = draft.exclusionErase || "";
  }
  if (draft.dirtyRois) payload.dirtyRois = draft.dirtyRois;
  return payload;
}

async function uploadManualLayer(imageId, sessionId, layer, dataUrl) {
  const blob = await fetch(dataUrl).then((response) => response.blob());
  const response = await fetch(`/api/workspace/manual/${encodeURIComponent(imageId)}/layer/${encodeURIComponent(sessionId)}/${layer}`, {
    method: "POST",
    headers: catalogRequestHeaders({ "Content-Type": "application/octet-stream" }),
    body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, data);
  applyCatalogGeneration(data);
}

async function saveWorkspaceDraft(imageId, draft) {
  if (!draft) return api(`/api/workspace/manual/${encodeURIComponent(imageId)}`, { method: "DELETE" });
  const payload = workspaceDraftPayload(draft);
  const dirtyLayers = Array.isArray(payload.dirtyLayers) ? payload.dirtyLayers : [];
  if (!dirtyLayers.length) return api(`/api/workspace/manual/${encodeURIComponent(imageId)}`, { method: "POST", body: JSON.stringify(payload) });
  const sessionId = crypto.randomUUID();
  await api(`/api/workspace/manual/${encodeURIComponent(imageId)}/begin`, { method: "POST", body: JSON.stringify({ sessionId, dirtyLayers }) });
  try {
    const emptyLayers = [];
    for (const layer of dirtyLayers) {
      const value = draft[layer] || "";
      if (!value) { emptyLayers.push(layer); continue; }
      await uploadManualLayer(imageId, sessionId, layer, value);
    }
    delete payload.add; delete payload.exclusion; delete payload.exclusionErase;
    payload.emptyLayers = emptyLayers;
    payload.sessionId = sessionId;
    return await api(`/api/workspace/manual/${encodeURIComponent(imageId)}/commit`, { method: "POST", body: JSON.stringify(payload) });
  } catch (error) {
    await api(`/api/workspace/manual/${encodeURIComponent(imageId)}/cancel`, { method: "POST", body: JSON.stringify({ sessionId }) }).catch(() => {});
    throw error;
  }
}

function queueWorkspaceDraft(imageId, immediate = false) {
  if (!imageId || !state.images.some((image) => image.id === imageId)) return Promise.resolve();
  state.workspaceDraftPending ??= new Map();
  const previousTimer = state.workspaceDraftTimers.get(imageId);
  if (previousTimer) clearTimeout(previousTimer);
  const write = () => {
    state.workspaceDraftTimers.delete(imageId);
    const draft = state.drafts.get(imageId);
    const persisted = queueWorkspaceMutation(imageId, () => saveWorkspaceDraft(imageId, draft));
    const completed = persisted.then((result) => {
      if (draft && state.drafts.get(imageId) === draft) {
        draft.dirtyLayers = [];
        draft.dirtyRois = {};
      }
      if (state.drafts.get(imageId) === draft) {
        const image = state.images.find((entry) => entry.id === imageId);
        if (image) image.hasEffectiveMask = draft?.hasEffectiveMask === true;
      }
      if (hasDurableHistory() && state.currentId === imageId) void refreshProjectHistory(imageId);
      // A project has a durable copy and can reload an inactive draft on
      // demand.  Projectless sessions have no equivalent recovery path, so
      // they deliberately keep the in-memory bitmap.
      if (
        hasDurableHistory() && state.currentId !== imageId
        && state.drafts.get(imageId) === draft
        && !state.workspaceDraftTimers.has(imageId)
        && !state.draftSaveChains.has(imageId)
        && !state.workspaceMutationErrors.has(imageId)
        && (!state.workspaceDraftChains.has(imageId) || state.workspaceDraftChains.get(imageId) === persisted)
      ) {
        state.drafts.delete(imageId);
        state.maskStatus.delete(imageId);
      }
      return result;
    });
    const pending = state.workspaceDraftPending.get(imageId);
    if (pending) {
      state.workspaceDraftPending.delete(imageId);
      pending.resolve(completed.catch((error) => {
        // Retain the bitmap and dirty layers for retry, while making it explicit
        // that the displayed hand-drawn edit is not durable yet.
        state.workspaceUnsavedImageId = imageId;
        setStatusKey("status.workspaceUnsaved", {}, "warning"); showUserError(error);
      }));
    }
    return completed;
  };
  if (immediate) return write();
  let pending = state.workspaceDraftPending.get(imageId);
  if (!pending) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pending = { promise, resolve };
    state.workspaceDraftPending.set(imageId, pending);
  }
  state.workspaceDraftTimers.set(imageId, setTimeout(() => { void write(); }, 250));
  return pending.promise;
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
    if (failure) {
      const draft = state.drafts.get(imageId);
      // A rejected debounced write leaves its bitmap and dirty layers in the
      // draft. Requeue that retained edit instead of consuming the error and
      // allowing the caller to move away with no durable retry.
      if (draft?.dirtyLayers?.length) {
        state.workspaceMutationErrors.delete(imageId);
        await queueWorkspaceDraft(imageId, true);
        continue;
      }
      state.workspaceMutationErrors.delete(imageId);
      throw failure;
    }
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
    const failedImageId = [...state.workspaceMutationErrors.keys()][0];
    if (failedImageId) {
      const storedFailure = state.workspaceMutationErrors.get(failedImageId);
      const draft = state.drafts.get(failedImageId);
      if (draft?.dirtyLayers?.length) {
        state.workspaceMutationErrors.delete(failedImageId);
        await queueWorkspaceDraft(failedImageId, true);
        continue;
      }
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
