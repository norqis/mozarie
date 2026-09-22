"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", "interaction.js"), "utf8");

function range(first, after) {
  const start = source.indexOf(first);
  const end = source.indexOf(after, start);
  assert.notEqual(start, -1, first);
  assert.notEqual(end, -1, after);
  return source.slice(start, end);
}

function codedError(code) { return Object.assign(new Error(code), { code }); }

test("source-delete permission, revalidation, persistence, and recovery contracts", async () => {
  const permissionSource = range("function browserDeleteEntry", "async function preflightBrowserSourceDelete");
  const events = [];
  const fileHandle = { name: "image.png" };
  const resolved = {
    async isSameEntry(handle) { events.push("same-entry"); return handle === fileHandle; },
    async getFile() { events.push("stat"); return { size: 12, lastModified: 34 }; },
  };
  const parentHandle = {
    requestPermission(options) { events.push(`permission:${options.mode}`); return Promise.resolve("granted"); },
    async queryPermission(options) { events.push(`query:${options.mode}`); return "granted"; },
    async getFileHandle(name) { events.push(`resolve:${name}`); return resolved; },
    async removeEntry(name) { events.push(`remove:${name}`); },
  };
  const access = { fileHandle, parentHandle };
  const api = new Function("sourceAccessFor", "codedError", `${permissionSource}; return { beginBrowserDeletePermissionRequests, browserDeleteHandle };`)(
    () => access, codedError,
  );
  const image = { id: "image", sourceKind: "session", sizeBytes: 12, mtimeNs: 34_000_000 };
  const finishPermissions = api.beginBrowserDeletePermissionRequests([image]);
  events.push("after-begin");
  assert.deepEqual(await finishPermissions(), [], "the delete-confirm click starts read/write permission synchronously and accepts the granted parent");
  assert.deepEqual(events.slice(0, 2), ["permission:readwrite", "after-begin"], "permission starts before later draft or network work can run");
  await api.browserDeleteHandle({ name: "image.png", fileHandle, parentHandle }, image);
  assert.deepEqual(events.slice(-5), ["query:readwrite", "resolve:image.png", "same-entry", "stat", "remove:image.png"], "deletion re-resolves the parent entry and verifies identity, size, and mtime immediately before removeEntry");

  const changed = { ...image, sizeBytes: 13 };
  await assert.rejects(api.browserDeleteHandle({ name: "image.png", fileHandle, parentHandle }, changed), (error) => error.code === "stale_asset");
  assert.equal(events.filter((event) => event === "remove:image.png").length, 1, "a changed source is never removed");

  const multiEvents = [];
  const deniedParent = { requestPermission() { multiEvents.push("denied"); return "denied"; } };
  const failedParent = { requestPermission() { multiEvents.push("failed"); throw new Error("prompt failed"); } };
  const accessById = new Map([
    ["denied-a", { fileHandle: { name: "a.png" }, parentHandle: deniedParent }],
    ["denied-b", { fileHandle: { name: "b.png" }, parentHandle: deniedParent }],
    ["failed", { fileHandle: { name: "failed.png" }, parentHandle: failedParent }],
  ]);
  const multi = new Function("sourceAccessFor", "codedError", `${permissionSource}; return beginBrowserDeletePermissionRequests;`)(
    (imageId) => accessById.get(imageId), codedError,
  );
  const settle = multi([
    { id: "denied-a", sourceKind: "session" }, { id: "denied-b", sourceKind: "session" }, { id: "failed", sourceKind: "session" },
  ]);
  assert.deepEqual(multiEvents, ["denied", "failed"], "each distinct parent is prompted synchronously once");
  assert.deepEqual(await settle(), [
    { imageId: "denied-a", reason: "source_permission_denied" },
    { imageId: "denied-b", reason: "source_permission_denied" },
    { imageId: "failed", reason: "source_permission_denied" },
  ], "denials and exceptions are retained as per-image failures");
});

test("source-delete browser phases persist deleting before I/O and distinguish missing from unknown", async () => {
  const deletionSource = range("async function deleteBrowserSources", "async function commitSourceDeleteWithRetry");
  const persisted = [];
  let removeStarted = false;
  const deleteBrowserHandle = async () => { removeStarted = true; };
  const deleteBrowserSources = new Function("browserDeleteHandle", "codedError", `${deletionSource}; return deleteBrowserSources;`)(deleteBrowserHandle, codedError);
  const entries = [{ imageId: "one", state: "ready" }];
  const result = await deleteBrowserSources([{ id: "one", sourceKind: "session" }], entries, async () => {
    persisted.push({ state: entries[0].state, removeStarted });
  });
  assert.deepEqual(persisted, [{ state: "deleting", removeStarted: false }, { state: "deleted", removeStarted: true }], "deleting is durable before file I/O and deleted is durable after it");
  assert.deepEqual(result, { deleted: ["one"], failed: [] });

  const recoverySource = range("async function recoverPendingBrowserDeletes", "async function resumePendingSourceDeletes");
  const writes = [];
  const recover = new Function("rememberPendingSourceDelete", `${recoverySource}; return recoverPendingBrowserDeletes;`)(async (pending) => writes.push(structuredClone({
    states: pending.browserEntries.map((entry) => entry.state), deleted: pending.browserDeletedImageIds,
  })));
  const notFound = Object.assign(new Error("gone"), { name: "NotFoundError" });
  const pending = { browserEntries: [
    { imageId: "gone", name: "gone.png", state: "deleting", parentHandle: { async getFileHandle() { throw notFound; } } },
    { imageId: "unknown", name: "unknown.png", state: "unknown", parentHandle: { async getFileHandle() { throw new Error("offline"); } } },
    { imageId: "exists", name: "exists.png", state: "deleting", parentHandle: { async getFileHandle() { return {}; } } },
  ] };
  assert.deepEqual(await recover(pending), { deleted: ["gone"], unresolved: true });
  assert.deepEqual(pending.browserEntries.map((entry) => entry.state), ["deleted", "unknown", "ready"], "NotFound commits browser deletion, another exception stays recoverable, and an existing entry returns to ready");
  assert.deepEqual(writes, [{ states: ["deleted", "unknown", "ready"], deleted: ["gone"] }], "the recovered states are durably rewritten once");
});

test("source-delete lost commit response retries the same token without duplicating the terminal result", async () => {
  const retrySource = range("async function commitSourceDeleteWithRetry", "async function claimSourceDelete");
  const calls = [];
  const terminal = { state: "committed", removedImageIds: ["one"], cleanupPendingCount: 1, failed: [{ imageId: "two", reason: "stale_asset" }] };
  const fn = new Function("catalogApi", `${retrySource}; return commitSourceDeleteWithRetry;`)(async (url, payload, options) => {
    calls.push({ url, payload: structuredClone(payload), options });
    if (calls.length === 1) throw codedError("connection_lost");
    return structuredClone(terminal);
  });
  const payload = { imageIds: ["one", "two"], deleteToken: "00000000-0000-4000-8000-000000000001", browserDeletedImageIds: ["one"] };
  assert.deepEqual(await fn(payload), terminal);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1], "lost-response replay uses the exact same token, targets, browser deletion receipt, and POST method");
});

test("source-delete refuses file I/O when the durable local intent cannot be written", async () => {
  const operationSource = range("async function permanentlyDeleteImages", "async function removeImageFromCatalog");
  let removeCalls = 0;
  let shownError = null;
  const image = { id: "one", sourceKind: "session" };
  const state = { importing: false, catalogMutation: false };
  let cancelledPermissionStarts = 0;
  const cancelled = new Function(
    "isBusy", "state", "confirmAction", "t", "beginBrowserDeletePermissionRequests",
    `${operationSource}; return permanentlyDeleteImages;`,
  )(() => false, state, async () => false, (key) => key, () => { cancelledPermissionStarts += 1; });
  await cancelled([image], [image]);
  assert.equal(cancelledPermissionStarts, 0, "cancelling confirmation never starts a permission request");
  const fn = new Function(
    "isBusy", "state", "confirmAction", "t", "beginBrowserDeletePermissionRequests", "deletionSelectionSnapshot", "crypto",
    "invalidatePendingImage", "updateActionButtons", "updateSelectionActionBar", "rememberPendingSourceDelete", "restoreDeletionSelection", "showUserError",
    `${operationSource}; return permanentlyDeleteImages;`,
  )(
    () => false, state, async (_title, _message, _key, onConfirm) => { onConfirm(); return true; }, (key) => key,
    () => async () => { removeCalls += 1; return []; }, () => ({ currentImageId: "one" }), { randomUUID: () => "token" },
    () => {}, () => {}, () => {}, async () => { throw codedError("source_delete_recovery_unavailable"); }, async () => {},
    (error) => { shownError = error; },
  );
  await fn([image], [image]);
  assert.equal(removeCalls, 0, "failure to persist the preparing intent stops before browser-source preflight or removeEntry");
  assert.equal(shownError?.code, "source_delete_recovery_unavailable");
  assert.equal(state.catalogMutation, false, "the public operation also releases its busy state");
});

test("source-delete startup recovery reconciles a lost prepare, an already-missing entry, and an empty receipt", async () => {
  const resumeSource = range("async function resumePendingSourceDeletes", "async function resumePendingSourceDeletesFromUser");
  const calls = [];
  const remembered = [];
  const forgotten = [];
  const acknowledgements = [];
  const missing = Object.assign(new Error("gone"), { name: "NotFoundError" });
  const pending = [
    { deleteToken: "lost-prepare", imageIds: ["one"], browserDeletedImageIds: [], browserEntries: [], state: "preparing" },
    { deleteToken: "missing-entry", imageIds: ["two"], browserDeletedImageIds: [], state: "prepared", browserEntries: [
      { imageId: "two", name: "two.png", state: "deleting", parentHandle: { async getFileHandle() { throw missing; } } },
    ] },
    { deleteToken: "empty", imageIds: [], browserDeletedImageIds: [], browserEntries: [], state: "prepared" },
    { deleteToken: "existing-cancel", imageIds: ["one"], browserDeletedImageIds: [], browserEntries: [{ imageId: "one", state: "ready" }], state: "prepared" },
    { deleteToken: "existing-retry", imageIds: ["one"], browserDeletedImageIds: [], browserEntries: [{ imageId: "one", state: "ready" }], state: "prepared", retryOnResume: true },
  ];
  const statusCounts = new Map();
  const api = async (url, options) => {
    const token = JSON.parse(options.body).deleteToken;
    calls.push(`${url}:${token}`);
    if (url.endsWith("/status")) {
      const count = (statusCounts.get(token) || 0) + 1; statusCounts.set(token, count);
      if (token === "lost-prepare" && count === 1) throw codedError("source_delete_not_prepared");
      if (token === "missing-entry") return count === 1 ? { state: "prepared", preparedSourceKinds: {} } : { state: "committed" };
      if (token === "existing-retry") return count === 1 ? { state: "prepared", preparedSourceKinds: {} } : { state: "committed" };
      return count === 1 ? { state: "prepared", preparedSourceKinds: {} } : { state: "cancelled" };
    }
    if (url.endsWith("/cancel")) return { state: "cancelled" };
    throw new Error(`unexpected ${url}`);
  };
  const catalogApi = async (url, payload) => {
    calls.push(`${url}:${payload.deleteToken}`);
    if (url.endsWith("/prepare")) return { preparedImageIds: [] };
    if (url.endsWith("delete-source")) return { state: "committed", removedImageIds: ["two"] };
    throw new Error(`unexpected ${url}`);
  };
  const fn = new Function(
    "pendingSourceDeletes", "api", "catalogApi", "state", "deletionSelectionSnapshot", "galleryFilteredImages",
    "restoreDeletionSelection", "selectImage", "browserDeleteEntry", "rememberPendingSourceDelete",
    "recoverPendingBrowserDeletes", "claimSourceDelete", "deleteBrowserSources", "setStatus", "t",
    "releaseSourceDeleteClaim", "commitSourceDeleteWithRetry", "acknowledgeSourceDelete", "isDefinitiveCommitRejection",
    "restoreCopiedBrowserSourcesAfterRejectedDelete", "forgetPendingSourceDelete", "resyncCatalog",
    `${resumeSource}; return resumePendingSourceDeletes;`,
  )(
    async () => pending, api, catalogApi, { images: [{ id: "one" }, { id: "two" }] },
    () => ({ currentImageId: null, pendingImageId: null }), () => [], async () => {}, async () => {}, () => null,
    async (value) => remembered.push(structuredClone(value)),
    async (value) => {
      if (value.deleteToken === "missing-entry") {
        value.browserEntries[0].state = "deleted"; value.browserDeletedImageIds = ["two"];
        remembered.push({ deleteToken: value.deleteToken, state: value.state, imageIds: [...value.imageIds], browserDeletedImageIds: ["two"] });
        return { deleted: ["two"], unresolved: false };
      }
      return { deleted: [], unresolved: false };
    },
    async (token) => ({ state: "claimed", deleteToken: token }), async (images, entries, onChanged) => {
      const deleted = images.map((image) => image.id); entries.forEach((entry) => { entry.state = "deleted"; }); await onChanged?.();
      return { deleted, failed: [] };
    }, () => {}, (key) => key,
    async () => {}, async (payload) => catalogApi("/api/catalog/delete-source", payload),
    async (token) => acknowledgements.push(token), () => false, async () => false,
    async (token) => forgotten.push(token), async () => {},
  );
  await fn(false);

  assert.ok(calls.includes("/api/catalog/delete-source/prepare:lost-prepare"), "a locally durable preparing token recreates the lost server prepare");
  assert.ok(remembered.some((value) => value.deleteToken === "lost-prepare" && value.state === "prepared" && value.imageIds.length === 0));
  assert.ok(calls.includes("/api/catalog/delete-source:missing-entry"), `NotFound is treated as a completed browser deletion and committed with the same token: ${JSON.stringify(calls)}`);
  assert.deepEqual(acknowledgements.sort(), ["empty", "existing-cancel", "existing-retry", "lost-prepare", "missing-entry"], "every terminal committed or cancelled receipt is acknowledged once");
  assert.equal(forgotten.length, 0, "recovery does not discard a nonterminal durable token through the error shortcut");
  assert.ok(calls.includes("/api/catalog/delete-source/cancel:empty"), "a prepared receipt with zero targets follows cancel, status, and ack");
  assert.ok(calls.includes("/api/catalog/delete-source/cancel:existing-cancel"), "an existing browser entry can be cancelled without claiming it");
  assert.ok(calls.includes("/api/catalog/delete-source:existing-retry"), "an existing browser entry marked retry-on-resume is deleted and committed with the same token");
});
