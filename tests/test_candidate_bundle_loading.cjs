"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "editor-canvas.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function runtime(fetchBitmap) {
  const state = {
    images: [{ id: "image", assetVersion: "version", candidateRevision: 1 }], currentId: null, pendingImageId: null,
    pendingCandidateKey: null, candidateInflight: new Map(), candidateLoadControllers: new Map(), catalogLoadControllers: new Set(),
    candidateBundleCache: { get: () => null, set: (_key, value) => value }, resourceCandidateKeys: new Set(),
  };
  const context = {
    state, Map, Set, Promise, AbortController, DOMException, Math, Number, String, Boolean, Object, Array, JSON, Uint8Array, Uint8ClampedArray,
    fetchBitmap, api: async () => ({ candidates: Array.from({ length: 9 }, (_value, index) => ({ id: `candidate-${index}` })), candidateRevision: 2 }),
    maskUrl: (_imageId, candidateId) => candidateId, candidateCacheKey: (imageId, revision) => `${imageId}:${revision}`,
    imageAssetVersion: (record) => record?.assetVersion || "", validCandidateTokens: () => true, codedError: (code) => Object.assign(new Error(code), { code }),
    catalogRecordMatches: () => true, isCurrentGeneration: () => true, syncResourceOwnership() {}, closeBitmap: (bitmap) => bitmap?.close?.(),
  };
  vm.runInNewContext(source, context, { filename: "editor-canvas.js" });
  vm.runInNewContext("globalThis.bundleTest = { loadCandidateBundle, CANDIDATE_MASK_DECODE_CONCURRENCY };", context);
  return { state, test: context.bundleTest };
}

async function waitForStart(started, count) {
  while (started.length < count) await new Promise((resolve) => queueMicrotask(resolve));
}

async function boundedConcurrencyCase() {
  const started = []; const pending = [];
  const { test } = runtime(async (candidateId) => {
    started.push(candidateId);
    const gate = deferred(); pending.push(() => gate.resolve({ id: candidateId, close() {} }));
    return gate.promise;
  });
  const loading = test.loadCandidateBundle("image", 1);
  await waitForStart(started, test.CANDIDATE_MASK_DECODE_CONCURRENCY);
  assert.equal(started.length, test.CANDIDATE_MASK_DECODE_CONCURRENCY, "candidate bitmap decodes start at the bounded concurrency limit");
  pending.shift()();
  await waitForStart(started, test.CANDIDATE_MASK_DECODE_CONCURRENCY + 1);
  assert.equal(started.length, test.CANDIDATE_MASK_DECODE_CONCURRENCY + 1, "each completed decode admits exactly one queued candidate");
  while (pending.length) pending.shift()();
  const bundle = await loading;
  assert.equal(bundle.candidateImages.size, 9, "every candidate is decoded after the bounded queue drains");
}

async function cleanupCase({ abort }) {
  const decoded = [];
  const { state, test } = runtime(async (candidateId) => {
    if (!abort && candidateId === "candidate-1") throw new Error("decode failed");
    const bitmap = { id: candidateId, close() { this.closed = true; } };
    decoded.push(bitmap);
    return bitmap;
  });
  if (abort) {
    const loading = test.loadCandidateBundle("image", 1);
    await waitForStart(decoded, test.CANDIDATE_MASK_DECODE_CONCURRENCY);
    state.candidateLoadControllers.get("image:1").abort();
    await assert.rejects(loading, { name: "AbortError" });
  } else await assert.rejects(test.loadCandidateBundle("image", 1), /decode failed/);
  assert.ok(decoded.length > 0 && decoded.every((bitmap) => bitmap.closed), "failed or aborted candidate loads close every decoded bitmap");
}

(async () => {
  await boundedConcurrencyCase();
  await cleanupCase({ abort: false });
  await cleanupCase({ abort: true });
  console.log("test_candidate_bundle_loading: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
