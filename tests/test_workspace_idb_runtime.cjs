const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workspacePath = path.join(__dirname, "..", "static", "js", "workspace.js");
const source = fs.readFileSync(workspacePath, "utf8");
const deleted = []; const writes = []; const events = []; let opens = 0;
function eventRequest(result) {
  return {
    result,
    set onsuccess(handler) { queueMicrotask(() => handler()); },
    set onerror(handler) { this._error = handler; },
  };
}
function database() {
  return {
    close() { events.push("close"); },
    transaction(_name, mode) {
      const transaction = { set oncomplete(handler) { queueMicrotask(handler); }, set onerror(_handler) {}, set onabort(_handler) {} };
      transaction.objectStore = () => ({
        getAll: () => eventRequest([{ catalogId: "stale", handle: { isSameEntry: async () => true } }]),
        delete: (id) => { deleted.push(id); events.push("delete"); }, put: (row) => writes.push(row),
      });
      return transaction;
    },
  };
}
const indexedDB = { open() { opens += 1; return eventRequest(database()); } };
const context = {
  state: { workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), draftSaveChains: new Map() },
  window: { indexedDB }, indexedDB, Promise, Map, Set, Object, Number, encodeURIComponent, setTimeout, clearTimeout, queueMicrotask,
  api: async (_url, options = {}) => options.body.includes("stale") ? Promise.reject(new Error("missing")) : { catalogId: "fresh" }, setStatus() {}, saveDraft() {},
};
vm.runInNewContext(source, context, { filename: workspacePath });
vm.runInNewContext("globalThis.idbTest={catalogForDirectoryHandle};", context, { filename: "test-workspace-idb-exports.js" });
(async () => {
  assert.equal(await context.idbTest.catalogForDirectoryHandle({}), "fresh");
  assert.deepEqual(deleted, ["stale"], "same-entry activation failure removes the stale IDB row before replacement");
  assert.ok(events.indexOf("delete") < events.indexOf("close"), "the stale row is deleted before the matching database closes");
  assert.deepEqual(writes.map((row) => row.catalogId), ["fresh"], "the replacement catalog is persisted");
  assert.ok(opens >= 2, "the stale read is closed before a fresh catalog write");
  console.log("test_workspace_idb_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
