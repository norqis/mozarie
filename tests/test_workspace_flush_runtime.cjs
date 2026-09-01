const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workspacePath = path.join(__dirname, "..", "static", "js", "workspace.js");
const source = fs.readFileSync(workspacePath, "utf8");
const writes = [];
const state = {
  images: [{ id: "one" }],
  drafts: new Map([["one", { add: "data:image/png;base64,a", hasEffectiveMask: true }]]),
  draftSaveChains: new Map(),
  currentId: null,
  draftDirty: false,
};
const context = {
  state, Map, Set, Promise, Object, Number, encodeURIComponent, window: {}, indexedDB: undefined,
  clearTimeout, setTimeout,
  api(url, options) { writes.push({ url, options }); return Promise.resolve({}); },
  saveDraft() {}, showUserError() {},
};
vm.runInNewContext(source, context, { filename: workspacePath });
vm.runInNewContext("globalThis.workspaceFlushTest={flushAllWorkspaceMutations};", context, { filename: "test-workspace-flush-exports.js" });

(async () => {
  state.workspaceDraftTimers.set("one", setTimeout(() => {}, 5000));
  await context.workspaceFlushTest.flushAllWorkspaceMutations();
  assert.equal(state.workspaceDraftTimers.size, 0, "a pending manual timer is consumed before the global transition settles");
  assert.deepEqual(writes.map(({ url, options }) => [url, options.method]), [["/api/workspace/manual/one", "POST"]], "global flush persists the current manual snapshot exactly once");
  state.workspaceDraftChains.set("one", Promise.resolve().then(() => { throw new Error("write rejected"); }));
  await assert.rejects(context.workspaceFlushTest.flushAllWorkspaceMutations(), /write rejected/, "a rejected queued manual write prevents a global transition");
  console.log("test_workspace_flush_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
