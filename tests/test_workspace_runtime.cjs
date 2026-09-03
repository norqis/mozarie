const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workspacePath = path.join(__dirname, "..", "static", "js", "workspace.js");
const source = fs.readFileSync(workspacePath, "utf8");
const calls = [];
let rejectFirst = false;
const state = {
  images: [{ id: "one" }], drafts: new Map(),
  workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), draftSaveChains: new Map(),
  currentId: null, draftDirty: false,
};
const context = {
  state, Map, Set, Promise, Object, Number, encodeURIComponent, window: {}, indexedDB: undefined,
  clearTimeout, setTimeout, queueMicrotask,
  setStatus() {}, showUserError() {}, saveDraft() {},
  api(url, options = {}) {
    calls.push([url, options.method]);
    if (rejectFirst) { rejectFirst = false; return Promise.reject(new Error("write failed")); }
    return Promise.resolve({});
  },
};
vm.runInNewContext(source, context, { filename: workspacePath });
vm.runInNewContext("globalThis.workspaceTest={queueWorkspaceDraft,flushDraftSaves,flushWorkspaceDraft,flushAllWorkspaceMutations,queueWorkspaceMutation,queueWorkspaceFlags,workspaceDraftPayload,directoryCatalogStore,rememberedOutputDirectoryHandle,rememberOutputDirectoryHandle,rememberedProjectSource,rememberedProjectFileSources,rememberedProjectDirectorySources,forgetProjectSources,ensureProjectSourcePermission,catalogForDirectoryHandle,loadWorkspaceDraft,scheduleManualWorkspaceSave};", context, { filename: "test-workspace-exports.js" });

(async () => {
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  assert.deepEqual(calls.map(([, method]) => method), ["DELETE", "POST"], "draft snapshots choose DELETE or POST at enqueue time");

  state.project = { id: "project-one" }; state.currentId = null; state.workspaceDraftChains.clear(); state.workspaceDraftTimers.clear(); state.workspaceMutationErrors.clear(); state.draftSaveChains.clear();
  const durableDraft = { add: "data:image/png;base64,durable", hasEffectiveMask: true };
  state.drafts.set("one", durableDraft); state.maskStatus = new Map([["one", true]]);
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  assert.equal(state.drafts.has("one"), false, "a durable inactive project draft is evicted from the live bitmap cache");
  assert.equal(state.maskStatus.has("one"), false, "evicting a durable project draft also drops its derived mask state");
  const originalApiForRestore = context.api;
  context.api = async () => ({ draft: { add: "data:image/png;base64,durable", hasEffectiveMask: true } });
  assert.equal((await context.workspaceTest.loadWorkspaceDraft("one")).add, "data:image/png;base64,durable", "revisiting an evicted project draft reloads its durable payload");
  context.api = originalApiForRestore;
  state.project = null;
  state.drafts.set("one", durableDraft); state.maskStatus.set("one", true);
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  assert.equal(state.drafts.get("one"), durableDraft, "projectless sessions keep their only in-memory draft copy");

  const manyImages = Array.from({ length: 400 }, (_, index) => ({ id: `many-${index}` }));
  state.images = manyImages; state.project = { id: "project-many" }; state.currentId = null;
  state.drafts.clear(); state.maskStatus.clear(); state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear(); calls.length = 0;
  for (let index = 0; index < manyImages.length; index += 1) {
    const image = manyImages[index];
    state.currentId = image.id;
    state.drafts.set(image.id, { add: `data:image/png;base64,${image.id}`, hasEffectiveMask: true });
    if (!index) continue;
    await context.workspaceTest.queueWorkspaceDraft(manyImages[index - 1].id, true);
    assert.ok(state.drafts.size <= 1, "inactive project draft bitmap data stays bounded while moving through 400 images");
  }
  state.currentId = null;
  await context.workspaceTest.queueWorkspaceDraft(manyImages.at(-1).id, true);
  assert.equal(state.drafts.size, 0, "400 persisted inactive project drafts are evicted instead of accumulating bitmap state");
  assert.equal(state.maskStatus.size, 0, "evicted project draft status entries plateau with the bitmap cache");
  assert.equal(state.workspaceDraftChains.size, 0, "settled project draft write chains do not grow with the catalogue");
  assert.ok(manyImages.every((image) => image.hasEffectiveMask === true), "draft eviction preserves each durable effective-mask scalar for masked save targets");
  assert.equal(calls.filter(([, method]) => method === "POST").length, 400, "each inactive project draft is durably saved before eviction");
  const originalApiForManyRestore = context.api;
  context.api = async () => ({ draft: { add: "data:image/png;base64,rehydrated", hasEffectiveMask: true } });
  const rehydrated = await Promise.all(manyImages.map((image) => context.workspaceTest.loadWorkspaceDraft(image.id)));
  assert.ok(rehydrated.every((draft) => draft?.add === "data:image/png;base64,rehydrated"), "evicted project drafts rehydrate on demand");
  context.api = originalApiForManyRestore;
  state.project = null; state.drafts.clear(); state.maskStatus.clear(); state.workspaceDraftChains.clear(); state.currentId = null;
  for (let index = 0; index < manyImages.length; index += 1) {
    const image = manyImages[index];
    state.currentId = image.id;
    state.drafts.set(image.id, { add: `data:image/png;base64,${image.id}`, hasEffectiveMask: true });
    if (index) await context.workspaceTest.queueWorkspaceDraft(manyImages[index - 1].id, true);
  }
  state.currentId = null;
  await context.workspaceTest.queueWorkspaceDraft(manyImages.at(-1).id, true);
  assert.equal(state.drafts.size, 400, "projectless drafts are never evicted because no durable project recovery path exists");

  state.images = [{ id: "one" }];
  calls.length = 0; state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true }); rejectFirst = true;
  const failed = context.workspaceTest.queueWorkspaceDraft("one", true);
  state.drafts.delete("one");
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  await assert.rejects(failed, /write failed/);
  await assert.rejects(context.workspaceTest.flushAllWorkspaceMutations(), /write failed/, "a recovered later DELETE does not hide the earlier write failure");
  assert.deepEqual(calls.map(([, method]) => method), ["POST", "DELETE"], "a later DELETE still runs after a rejected POST");

  let releaseDraft;
  state.currentId = "one"; state.draftDirty = true; state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear();
  context.saveDraft = () => new Promise((resolve) => { releaseDraft = () => { state.draftDirty = false; resolve(); }; });
  const transition = context.workspaceTest.flushAllWorkspaceMutations().then(() => context.api("/api/catalog/clear", { method: "POST" }));
  await Promise.resolve();
  assert.equal(calls.some(([url]) => url === "/api/catalog/clear"), false, "a dirty draft blocks its catalog transition until encoded");
  releaseDraft(); await transition;
  assert.equal(calls.some(([url]) => url === "/api/catalog/clear"), true, "the transition starts after the dirty draft resolves");

  state.currentId = "one"; state.draftDirty = true;
  context.saveDraft = () => Promise.reject(new Error("encode failed"));
  let switched = false;
  await assert.rejects(context.workspaceTest.flushAllWorkspaceMutations().then(() => { switched = true; }), /encode failed/);
  assert.equal(switched, false, "a rejected draft encoder prevents the transition");

  state.currentId = null; state.draftDirty = false; state.draftSaveChains.clear();
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  state.draftSaveChains.set("one", first);
  const flush = context.workspaceTest.flushDraftSaves(["one"]);
  let resolved = false;
  flush.then(() => { resolved = true; });
  let resolveSecond;
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  state.draftSaveChains.set("one", second);
  resolveFirst();
  await Promise.resolve();
  assert.equal(resolved, false, "a replacement encoder chain keeps the flush pending");
  resolveSecond();
  await flush;
  assert.equal(resolved, true, "the flush completes after the stable replacement chain");

  calls.length = 0;
  await context.workspaceTest.queueWorkspaceFlags(null, { hidden: true });
  await context.workspaceTest.queueWorkspaceFlags("one", { hidden: true });
  assert.deepEqual(calls.at(-1), ["/api/workspace/image/one", "POST"], "workspace flags ignore an empty image and persist a present image");

  calls.length = 0;
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  await context.workspaceTest.queueWorkspaceDraft("one");
  assert.deepEqual(calls.at(-1), ["/api/workspace/manual/one", "POST"], "a delayed draft is persisted after its debounce");

  calls.length = 0;
  rejectFirst = true;
  await context.workspaceTest.queueWorkspaceDraft("one");
  assert.equal(calls.at(-1)[0], "/api/workspace/manual/one", "a delayed failure still attempts the manual write");
  state.workspaceMutationErrors.delete("one");

  calls.length = 0;
  state.workspaceDraftTimers.set("one", setTimeout(() => {}, 5000));
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  await context.workspaceTest.flushWorkspaceDraft("one");
  assert.equal(state.workspaceDraftTimers.has("one"), false, "flushing an image sends its pending timer immediately");

  state.workspaceMutationErrors.set("one", new Error("stored failure"));
  await assert.rejects(context.workspaceTest.flushWorkspaceDraft("one"), /stored failure/, "an image flush surfaces and consumes a remembered mutation failure");

  calls.length = 0;
  const loaded = await context.workspaceTest.loadWorkspaceDraft("one");
  assert.equal(loaded, null, "loading an absent draft returns null");

  state.currentId = null;
  assert.equal(await context.workspaceTest.scheduleManualWorkspaceSave(), undefined, "no current image has no scheduled encoder");
  state.currentId = "one";
  let saved = 0;
  context.saveDraft = () => { saved += 1; };
  await context.workspaceTest.scheduleManualWorkspaceSave();
  assert.equal(saved, 1, "the current manual edit is encoded on the next task");
  context.saveDraft = () => { throw new Error("encode synchronously failed"); };
  await assert.rejects(context.workspaceTest.scheduleManualWorkspaceSave(), /encode synchronously failed/, "a synchronous encoder failure rejects its scheduling chain");

  const originalApi = context.api;
  const originalIndexedDb = context.indexedDB;
  const originalWindowIndexedDb = context.window.indexedDB;
  let createdStores = 0;
  const openedDb = { createObjectStore() { createdStores += 1; } };
  context.indexedDB = context.window.indexedDB = {
    open() {
      const request = { result: openedDb };
      queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
      return request;
    },
  };
  assert.equal(await context.workspaceTest.directoryCatalogStore(), openedDb, "a directory database creates its store on first open and returns the opened database");
  assert.equal(createdStores, 2, "the directory database owns catalog and project-source stores");
  context.indexedDB = context.window.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror());
      return request;
    },
  };
  assert.equal(await context.workspaceTest.directoryCatalogStore(), null, "an IndexedDB open error disables optional directory persistence");
  context.indexedDB = context.window.indexedDB = undefined;
  assert.equal(await context.workspaceTest.directoryCatalogStore(), null, "browsers without IndexedDB keep folder import usable");
  assert.equal(await context.workspaceTest.rememberedOutputDirectoryHandle(), null, "browsers without IndexedDB have no remembered output directory");
  await context.workspaceTest.rememberOutputDirectoryHandle({ name: "output" });

  const fileRowsDb = {
    close() {},
    transaction() { return { objectStore() { return { getAll() { const request = {}; queueMicrotask(() => request.onsuccess()); request.result = [
      { projectId: "project", imageId: "one", sourceId: "source-a", handle: { kind: "file", name: "a.png" } },
      { projectId: "project", imageId: null, sourceId: "source-a", handle: { kind: "directory", name: "folder" } },
      { projectId: "other", imageId: "two", sourceId: "source-b", handle: { kind: "file", name: "b.png" } },
    ]; return request; } }; } }; },
  };
  context.indexedDB = context.window.indexedDB = { open() { const request = { result: fileRowsDb }; queueMicrotask(() => request.onsuccess()); return request; } };
  assert.equal((await context.workspaceTest.rememberedProjectSource("project", "source-a", "one")).name, "a.png", "a remembered project source resolves by its durable source and image IDs");
  assert.equal(JSON.stringify(await context.workspaceTest.rememberedProjectFileSources("project")), JSON.stringify([{ sourceId: "source-a", handle: { kind: "file", name: "a.png" } }]), "browser file handles retain the durable source ID needed to restore the same project images");
  assert.equal(JSON.stringify(await context.workspaceTest.rememberedProjectDirectorySources("project")), JSON.stringify([{ sourceId: "source-a", handle: { kind: "directory", name: "folder" } }]), "a remembered project directory restores its durable source ID");
  assert.equal(await context.workspaceTest.ensureProjectSourcePermission({ queryPermission: async () => "granted" }), true, "a granted project source opens without another prompt");
  assert.equal(await context.workspaceTest.ensureProjectSourcePermission({ queryPermission: async () => "prompt", requestPermission: async () => "granted" }, true), true, "an explicitly requested project source can obtain browser read permission");
  assert.equal(await context.workspaceTest.ensureProjectSourcePermission({ queryPermission: async () => { throw new Error("denied"); } }), false, "a project source permission failure remains closed");

  const deletedHandleKeys = [];
  const cleanupDb = {
    close() {},
    transaction(_name, mode) { return { objectStore() { return mode === "readwrite" ? { delete(key) { deletedHandleKeys.push(key); } } : { getAll() { const request = {}; queueMicrotask(() => request.onsuccess()); request.result = [
      { key: "project:source-a:one", projectId: "project" }, { key: "project:dir:root", projectId: "project" }, { key: "other:source-b:two", projectId: "other" },
    ]; return request; } }; } }; },
  };
  context.indexedDB = context.window.indexedDB = { open() { const request = { result: cleanupDb }; queueMicrotask(() => request.onsuccess()); return request; } };
  await context.workspaceTest.forgetProjectSources("project");
  assert.deepEqual(deletedHandleKeys, ["project:source-a:one", "project:dir:root"], "deleting a project removes only its persisted browser handles");

  const outputReadErrorDb = {
    close() {},
    transaction() { return { objectStore() { return { get() { const request = {}; queueMicrotask(() => request.onerror()); return request; } }; } }; },
  };
  context.indexedDB = context.window.indexedDB = { open() { const request = { result: outputReadErrorDb }; queueMicrotask(() => request.onsuccess()); return request; } };
  assert.equal(await context.workspaceTest.rememberedOutputDirectoryHandle(), null, "an unreadable remembered output directory is treated as absent");

  const directoryEvents = [];
  context.state.project = null;
  context.api = async (url) => {
    assert.equal(url, "/api/projects", "a directory creates explicit unnamed project work");
    return { project: { id: "fresh", name: null, status: "working" } };
  };
  assert.equal(await context.workspaceTest.catalogForDirectoryHandle({}), "fresh", "a remembered directory never silently reopens old work");
  context.state.project = { id: "fresh" };
  context.api = async (url) => { assert.equal(url, "/api/workspace/catalog", "an active project activates its existing workspace catalog"); return { catalogId: "active" }; };
  assert.equal(await context.workspaceTest.catalogForDirectoryHandle({}), "active", "a selected directory activates the current project rather than creating another one");

  state.currentId = null; state.draftDirty = false; state.draftSaveChains.clear(); state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear(); state.workspaceDraftTimers.clear();
  assert.equal(JSON.stringify(context.workspaceTest.workspaceDraftPayload({})), JSON.stringify({ add: "", exclusion: "", exclusionErase: "", manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: true, hasEffectiveMask: false, removedCandidateIds: [], candidateRevision: 0 }), "a partially initialized manual draft receives the persisted defaults");
  await context.workspaceTest.flushDraftSaves(["one"]);
  state.currentId = "one"; state.draftDirty = true;
  let skippedDraftEncodes = 0;
  context.saveDraft = () => { skippedDraftEncodes += 1; };
  await context.workspaceTest.flushDraftSaves(["other"]);
  assert.equal(skippedDraftEncodes, 0, "flushing another image does not encode the current draft");
  state.currentId = null; state.draftDirty = false;
  state.draftSaveChains.set("one", Promise.resolve().then(() => { throw new Error("draft encoding failed"); }));
  await assert.rejects(context.workspaceTest.flushDraftSaves(["one"]), /draft encoding failed/, "a rejected encoded draft stops its dependent transition");
  state.draftSaveChains.clear();

  await context.workspaceTest.flushWorkspaceDraft("one");
  assert.equal(state.workspaceDraftChains.has("one"), false, "an image with no pending server write flushes without creating one");
  assert.equal(await context.workspaceTest.queueWorkspaceDraft("missing"), undefined, "a missing catalog image never schedules a manual write");
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  const debouncedOne = context.workspaceTest.queueWorkspaceDraft("one");
  const debouncedTwo = context.workspaceTest.queueWorkspaceDraft("one");
  await Promise.all([debouncedOne, debouncedTwo]);
  assert.equal(state.workspaceDraftTimers.has("one"), false, "a replacement debounce clears its earlier timer before writing");

  context.api = async () => ({});
  state.currentId = null; state.draftDirty = false; state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear(); state.workspaceDraftTimers.clear(); state.drafts.set("one", {});
  state.workspaceDraftTimers.set("one", setTimeout(() => {}, 5000));
  assert.equal(state.workspaceDraftTimers.size, 1, "the global flush fixture begins with one pending timer");
  const flushCalls = calls.length;
  await context.workspaceTest.flushAllWorkspaceMutations();
  assert.equal(state.workspaceDraftTimers.size, 0, "a global flush drains every pending workspace timer before a catalog transition");
  assert.equal(calls.length, flushCalls + 1, "a global flush sends the pending manual workspace write");

  state.workspaceDraftChains.set("one", Promise.resolve().then(() => { throw new Error("queued write failed"); }));
  await assert.rejects(context.workspaceTest.flushAllWorkspaceMutations(), /queued write failed/, "a rejected queued mutation blocks a catalog transition");
  state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear();
  context.api = originalApi;
  context.indexedDB = originalIndexedDb;
  context.window.indexedDB = originalWindowIndexedDb;
  console.log("test_workspace_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
