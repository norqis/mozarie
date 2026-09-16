const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");
const workspacePath = path.join(__dirname, "..", "static", "js", "workspace.js");
const source = fs.readFileSync(workspacePath, "utf8");
const deleted = []; const writes = []; const events = []; let opens = 0; let openFails = false; let readFails = false;
function eventRequest(result, fails = false) {
  return {
    result,
    set onsuccess(handler) { if (!fails) queueMicrotask(() => handler()); },
    set onerror(handler) { if (fails) queueMicrotask(() => handler()); },
  };
}
function database() {
  return {
    close() { events.push("close"); },
    transaction(_name, mode) {
      const transaction = { set oncomplete(handler) { queueMicrotask(handler); }, set onerror(_handler) {}, set onabort(_handler) {} };
      transaction.objectStore = () => ({
        index: () => ({ getAll: () => eventRequest([], readFails) }),
        getAll: () => eventRequest([{ catalogId: "stale", handle: { isSameEntry: async () => true } }], readFails),
        get: () => eventRequest(undefined, readFails),
        delete: (id) => { deleted.push(id); events.push("delete"); }, put: (row) => writes.push(row),
      });
      return transaction;
    },
  };
}
const indexedDB = { open() { opens += 1; return eventRequest(database(), openFails); } };
const context = {
  state: { workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), draftSaveChains: new Map(), project: null, projectReadOnly: false },
  window: { indexedDB }, indexedDB, crypto: { randomUUID: () => "cleanup-intent" }, IDBKeyRange: { only: (value) => value }, Promise, Map, Set, Object, Number, encodeURIComponent, setTimeout, clearTimeout, queueMicrotask,
  api: async (url) => {
    assert.equal(url, "/api/projects", "an unassigned directory starts explicit unnamed project work");
    return { project: { id: "fresh", name: null, status: "working" } };
  }, setStatus() {}, saveDraft() {},
};
vm.runInNewContext(source, context, { filename: workspacePath });
vm.runInNewContext("globalThis.idbTest={directoryCatalogStore, catalogForDirectoryHandle, rememberedProjectSource, rememberedProjectSources, forgetProjectSources, rememberedOutputDirectoryHandle};", context, { filename: "test-workspace-idb-exports.js" });
nodeTest("workspace IndexedDB runtime contracts", async () => {
  assert.equal(await context.idbTest.catalogForDirectoryHandle({}), null);
  assert.equal(context.state.project, null, "a folder import does not create or select a project implicitly");
  assert.deepEqual(deleted, [], "a remembered folder never silently selects or deletes a prior project");
  assert.deepEqual(writes, [], "a project source is stored only after an explicit project action");
  assert.equal(opens, 0, "an unassigned folder import does not touch IndexedDB project-source storage");

  // Local directory handles are a convenience only.  IndexedDB failures must
  // degrade to an empty catalog instead of blocking project restore/deletion.
  openFails = true;
  assert.equal(await context.idbTest.directoryCatalogStore(), null, "a failed IndexedDB open disables only local handle recall");
  openFails = false; readFails = true;
  assert.equal(await context.idbTest.rememberedProjectSource("fresh", "source"), null, "a failed source lookup behaves as an absent remembered source");
  assert.deepEqual(JSON.parse(JSON.stringify(await context.idbTest.rememberedProjectSources("fresh"))), { files: [], directories: [] }, "a failed source lookup has no implicit import fallback");
  await context.idbTest.forgetProjectSources("fresh");
  assert.equal(await context.idbTest.rememberedOutputDirectoryHandle(), null, "a failed output-handle lookup leaves output selection explicit");
});
