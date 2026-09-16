const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeTest = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");
const interaction = fs.readFileSync(path.join(__dirname, "..", "static", "js", "interaction.js"), "utf8");

function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

function compiled(name, dependencies) {
  const names = Object.keys(dependencies);
  return new Function(...names, `${functionSource(name)}; return ${name};`)(...names.map((key) => dependencies[key]));
}

const codedError = (code) => Object.assign(new Error(code), { code });

nodeTest("a source snapshot reads durable bytes before destructive work and restores the original name and type", async () => {
  const original = new File([Uint8Array.from([3, 1, 4, 1, 5])], "nested source.png", { type: "image/png", lastModified: 123 });
  const originalArrayBuffer = original.arrayBuffer.bind(original);
  let sourceAvailable = true; let sourceReads = 0;
  original.arrayBuffer = async () => {
    sourceReads += 1;
    assert.equal(sourceAvailable, true, "snapshot bytes are read before the source can change");
    return originalArrayBuffer();
  };
  const lazySlice = Object.create(Blob.prototype);
  lazySlice.arrayBuffer = async () => {
    assert.equal(sourceAvailable, true, "a lazy slice becomes unreadable after destructive work");
    return originalArrayBuffer();
  };
  original.slice = () => lazySlice;
  const snapshotSource = compiled("snapshotSourceHandle", { Blob });
  const snapshot = await snapshotSource({ fileHandle: { getFile: async () => original } });
  sourceAvailable = false;
  assert.equal(sourceReads, 1, "the source is materialized exactly once before destructive work");
  assert.ok(snapshot instanceof Blob);
  assert.equal(snapshot.type, "image/png");
  assert.deepEqual([...new Uint8Array(await snapshot.arrayBuffer())], [3, 1, 4, 1, 5]);

  let restoredName = null; let restoredBytes = null;
  const restoredFile = new File([snapshot], original.name, { type: snapshot.type, lastModified: original.lastModified });
  const restoreSource = compiled("restoreSourceHandle", { codedError });
  await restoreSource({
    name: original.name,
    fileHandle: { name: original.name },
    parentHandle: { async getFileHandle(name) {
      restoredName = name;
      return {
        async createWritable() { return { async write(bytes) { restoredBytes = [...new Uint8Array(await bytes.arrayBuffer())]; }, async close() {}, async abort() {} }; },
        async getFile() { return restoredFile; },
      };
    } },
  }, snapshot, true);
  assert.equal(restoredName, original.name);
  assert.deepEqual(restoredBytes, [3, 1, 4, 1, 5]);
  assert.equal(restoredFile.type, original.type);
});

nodeTest("a missing browser source snapshot starts neither deletion nor commit", async (t) => {
  const prepare = t.mock.fn();
  const claim = t.mock.fn();
  const deleteHandle = t.mock.fn();
  const commit = t.mock.fn();
  const removeSource = compiled("deleteCopiedBrowserSource", {
    browserDeleteEntry: () => ({ fileHandle: { getFile: async () => ({}) }, state: "ready" }),
    snapshotSourceHandle: async () => null,
    codedError,
    crypto: { randomUUID: () => "delete-token" },
    rememberPendingSourceDelete: t.mock.fn(),
    catalogApi: prepare,
    claimSourceDelete: claim,
    browserDeleteHandle: deleteHandle,
    commitSourceDeleteWithRetry: commit,
    api: t.mock.fn(),
    acknowledgeSourceDelete: t.mock.fn(),
    isDefinitiveCommitRejection: () => true,
    restoreCopiedBrowserSourcesAfterRejectedDelete: t.mock.fn(),
    console,
  });

  const result = await removeSource({ id: "image-1" }, "save-token");
  assert.equal(result.deleted, false);
  assert.equal(result.error.code, "source_restore_failed");
  for (const mock of [prepare, claim, deleteHandle, commit]) assert.equal(mock.mock.callCount(), 0);
});

nodeTest("a rejected source snapshot starts neither deletion nor commit", async (t) => {
  const snapshotSource = compiled("snapshotSourceHandle", { Blob });
  for (const getFile of [
    async () => { throw new Error("read denied"); },
    async () => {
      const file = new File(["original"], "source.png", { type: "image/png" });
      file.arrayBuffer = async () => { throw new Error("bytes denied"); };
      return file;
    },
  ]) {
    const prepare = t.mock.fn(); const claim = t.mock.fn(); const deleteHandle = t.mock.fn(); const commit = t.mock.fn();
    const removeSource = compiled("deleteCopiedBrowserSource", {
      browserDeleteEntry: () => ({ fileHandle: { getFile }, state: "ready" }), snapshotSourceHandle: snapshotSource, codedError,
      crypto: { randomUUID: () => "delete-token" }, rememberPendingSourceDelete: t.mock.fn(), catalogApi: prepare,
      claimSourceDelete: claim, browserDeleteHandle: deleteHandle, commitSourceDeleteWithRetry: commit, api: t.mock.fn(),
      acknowledgeSourceDelete: t.mock.fn(), isDefinitiveCommitRejection: () => true, restoreCopiedBrowserSourcesAfterRejectedDelete: t.mock.fn(), console, Blob,
    });
    const result = await removeSource({ id: "image-1" }, "save-token");
    assert.equal(result.error.code, "source_restore_failed");
    for (const mock of [prepare, claim, deleteHandle, commit]) assert.equal(mock.mock.callCount(), 0);
  }
});

nodeTest("a definitive delete commit rejection restores the exact materialized source bytes", async (t) => {
  const snapshot = new Blob(["original bytes"], { type: "image/png" });
  const entry = { fileHandle: { getFile: async () => snapshot }, state: "ready" };
  const restored = t.mock.fn();
  const remembered = t.mock.fn(async () => {});
  const released = t.mock.fn(async () => {});
  const acknowledged = t.mock.fn(async () => {});
  const request = t.mock.fn(async () => ({ state: "cancelled" }));
  const restore = compiled("restoreCopiedBrowserSourcesAfterRejectedDelete", {
    Blob,
    restoreSourceHandle: restored,
    rememberPendingSourceDelete: remembered,
    releaseSourceDeleteClaim: released,
    api: request,
    acknowledgeSourceDelete: acknowledged,
  });
  const removeSource = compiled("deleteCopiedBrowserSource", {
    browserDeleteEntry: () => entry,
    snapshotSourceHandle: async () => snapshot,
    codedError,
    crypto: { randomUUID: () => "delete-token" },
    rememberPendingSourceDelete: remembered,
    catalogApi: t.mock.fn(async () => ({ preparedImageIds: ["image-1"] })),
    claimSourceDelete: t.mock.fn(async () => {}),
    browserDeleteHandle: t.mock.fn(async () => {}),
    commitSourceDeleteWithRetry: t.mock.fn(async () => { throw codedError("input_invalid"); }),
    api: request,
    acknowledgeSourceDelete: acknowledged,
    isDefinitiveCommitRejection: (error) => error.code === "input_invalid",
    restoreCopiedBrowserSourcesAfterRejectedDelete: restore,
    console,
  });

  const result = await removeSource({ id: "image-1" }, "save-token");
  assert.equal(result.deleted, false);
  assert.equal(result.error.code, "input_invalid");
  assert.equal(restored.mock.callCount(), 1);
  assert.deepEqual(restored.mock.calls[0].arguments, [entry, snapshot, true]);
  assert.equal(entry.state, "ready");
  assert.equal(released.mock.callCount(), 1);
  assert.equal(acknowledged.mock.callCount(), 1);
});

nodeTest("all source-delete mutations explicitly POST", () => {
  for (const endpoint of [
    "/api/catalog/delete-source",
    "/api/catalog/delete-source/prepare",
    "/api/catalog/delete-source/claim",
    "/api/catalog/delete-source/release",
  ]) {
    const calls = [...interaction.matchAll(new RegExp(`catalogApi\\(\\"${endpoint.replaceAll("/", "\\/")}\\"[^\\n]*`, "g"))];
    assert.ok(calls.length, `${endpoint} must use catalogApi`);
    for (const call of calls) assert.match(call[0], /method: "POST"/, `${endpoint} must explicitly POST its mutation`);
  }
});
