const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workspacePath = path.join(__dirname, "..", "static", "js", "workspace.js");
const workspaceSource = fs.readFileSync(workspacePath, "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "static", "js", "core.js"), "utf8");
const coreFlags = coreSource.slice(coreSource.indexOf("function normaliseReviewRoot"), coreSource.indexOf("function imageIndex"));
const requests = [];
const pending = [];
const state = {
  images: [{ id: "one", relativePath: "one.png", hidden: false, reviewed: false }, { id: "two", relativePath: "two.png", hidden: false, reviewed: false }],
  hiddenPaths: new Set(), reviewedPaths: new Set(), selectedImageIds: new Set(), batchMode: false,
  workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(),
};
const context = {
  state, Map, Set, Promise, Object, String, Boolean, encodeURIComponent,
  api(url, options) {
    const payload = JSON.parse(options.body);
    requests.push({ url, payload });
    return new Promise((resolve, reject) => pending.push({ resolve, reject, payload }));
  },
  showUserError(error) { context.errors.push(error); }, errors: [],
  renderCatalogViews() {}, renderGallery() {}, renderOverview() {}, updateNavigationControls() {}, updateActionButtons() {},
  t() { return ""; }, $(selector) { return { setAttribute() {}, hidden: false, textContent: "", disabled: false }; },
};
vm.runInNewContext(workspaceSource, context, { filename: workspacePath });
vm.runInNewContext(coreFlags, context, { filename: "test-core-flags.js" });
vm.runInNewContext("globalThis.flagsTest = { setHidden, setReviewed, isHidden, isReviewed };", context, { filename: "test-workspace-flags-exports.js" });

(async () => {
  const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 0));
  const image = state.images[0];
  assert.equal(await context.flagsTest.setReviewed(image, false), true, "an already-unreviewed image is accepted without a write");
  assert.equal(requests.length, 0, "an unchanged review flag sends no request");

  image.reviewed = true; state.reviewedPaths.add("one.png");
  const repeatedClear = Array.from({ length: 20 }, () => context.flagsTest.setReviewed(image, false));
  await settleQueue();
  assert.equal(requests.length, 1, "repeated same flag changes share one pending write");
  assert.equal(new Set(repeatedClear).size, 1, "repeated same flag changes share one promise");
  pending.shift().resolve({ reviewed: false, hidden: false });
  await Promise.all(repeatedClear);
  assert.equal(context.flagsTest.isReviewed(image), false, "the shared pending write updates the committed review state");

  requests.length = 0;
  const first = context.flagsTest.setReviewed(image, true);
  const second = context.flagsTest.setReviewed(image, false);
  await settleQueue();
  assert.deepEqual(requests.map((request) => request.payload), [{ reviewed: true }], "the per-image queue starts one flag write at a time");
  pending.shift().resolve({ reviewed: true, hidden: false });
  await settleQueue();
  assert.deepEqual(requests.map((request) => request.payload), [{ reviewed: true }, { reviewed: false }], "a later flag write follows the earlier response");
  pending.shift().resolve({ reviewed: false, hidden: false });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(context.flagsTest.isReviewed(image), false, "rapid queued changes finish at the final server response");

  const one = context.flagsTest.setHidden(state.images[0], true);
  const two = context.flagsTest.setHidden(state.images[1], true);
  await settleQueue();
  pending.shift().resolve({ hidden: true, reviewed: false });
  await settleQueue();
  pending.shift().reject(new Error("write failed"));
  assert.deepEqual(await Promise.all([one, two]), [true, false], "a batch can publish only its successful flag writes");
  assert.deepEqual(state.images.map((item) => item.hidden), [true, false], "a failed batch item keeps its previous visible state");
  assert.equal(context.errors.length, 1, "a failed batch item reports one user-facing error");
  console.log("test_workspace_flags_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
