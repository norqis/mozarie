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
vm.runInNewContext("globalThis.workspaceTest={queueWorkspaceDraft,flushDraftSaves,flushWorkspaceDraft,flushAllWorkspaceMutations,queueWorkspaceMutation,queueWorkspaceFlags,workspaceDraftPayload,directoryCatalogStore,rememberedOutputDirectoryHandle,rememberOutputDirectoryHandle,catalogForDirectoryHandle,loadWorkspaceDraft,scheduleManualWorkspaceSave};", context, { filename: "test-workspace-exports.js" });

(async () => {
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  assert.deepEqual(calls.map(([, method]) => method), ["DELETE", "POST"], "draft snapshots choose DELETE or POST at enqueue time");

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
