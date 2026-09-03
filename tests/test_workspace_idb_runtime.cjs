const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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
  window: { indexedDB }, indexedDB, Promise, Map, Set, Object, Number, encodeURIComponent, setTimeout, clearTimeout, queueMicrotask,
  api: async (url) => {
    assert.equal(url, "/api/projects", "an unassigned directory starts explicit unnamed project work");
    return { project: { id: "fresh", name: null, status: "working" } };
  }, setStatus() {}, saveDraft() {},
};
vm.runInNewContext(source, context, { filename: workspacePath });
vm.runInNewContext("globalThis.idbTest={directoryCatalogStore, catalogForDirectoryHandle, rememberedProjectSource, rememberedProjectFileSources, rememberedProjectDirectorySources, forgetProjectSources, rememberedOutputDirectoryHandle};", context, { filename: "test-workspace-idb-exports.js" });
(async () => {
  assert.equal(await context.idbTest.catalogForDirectoryHandle({}), "fresh");
  assert.equal(context.state.project.id, "fresh");
  assert.equal(context.state.projectReadOnly, false);
  assert.deepEqual(deleted, [], "a remembered folder never silently selects or deletes a prior project");
  assert.deepEqual(writes.map((row) => row.projectId), ["fresh"], "the selected handle is retained for the explicit project");
  assert.ok(opens >= 1, "the project source handle is written to IndexedDB");

  // Local directory handles are a convenience only.  IndexedDB failures must
  // degrade to an empty catalog instead of blocking project restore/deletion.
  openFails = true;
  assert.equal(await context.idbTest.directoryCatalogStore(), null, "a failed IndexedDB open disables only local handle recall");
  openFails = false; readFails = true;
  assert.equal(await context.idbTest.rememberedProjectSource("fresh", "source"), null, "a failed source lookup behaves as an absent remembered source");
  assert.deepEqual([...await context.idbTest.rememberedProjectFileSources("fresh")], [], "a failed file-source lookup has no implicit import fallback");
  assert.deepEqual([...await context.idbTest.rememberedProjectDirectorySources("fresh")], [], "a failed directory-source lookup has no implicit import fallback");
  await context.idbTest.forgetProjectSources("fresh");
  assert.equal(await context.idbTest.rememberedOutputDirectoryHandle(), null, "a failed output-handle lookup leaves output selection explicit");
  console.log("test_workspace_idb_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
