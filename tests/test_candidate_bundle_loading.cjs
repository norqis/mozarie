"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "editor-canvas.js"), "utf8");

function deferred() {
  let resolve; let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
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
    releaseCandidateBitmapBundle: (bundle) => { for (const bitmap of bundle?.candidateImages?.values?.() || []) bitmap.close?.(); },
  };
  vm.runInNewContext(source, context, { filename: "editor-canvas.js" });
  vm.runInNewContext("globalThis.bundleTest = { loadCandidateBundle, CANDIDATE_MASK_DECODE_CONCURRENCY };", context);
  return { state, test: context.bundleTest };
}

function startTracker() {
  const starts = []; const waiters = [];
  return {
    starts,
    add(entry) {
      starts.push(entry);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (starts.length >= waiters[index].count) waiters.splice(index, 1)[0].resolve();
      }
    },
    waitFor(count) {
      if (starts.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

function decodedBitmap(candidateId, decoded) {
  const bitmap = { id: candidateId, close() { this.closed = true; } };
  decoded.push(bitmap);
  return bitmap;
}

async function boundedConcurrencyCase() {
  const tracker = startTracker(); const decoded = [];
  const { test } = runtime(async (candidateId) => {
    const gate = deferred(); tracker.add({ candidateId, gate });
    await gate.promise;
    return decodedBitmap(candidateId, decoded);
  });
  const loading = test.loadCandidateBundle("image", 1);
  await tracker.waitFor(test.CANDIDATE_MASK_DECODE_CONCURRENCY);
  assert.equal(tracker.starts.length, test.CANDIDATE_MASK_DECODE_CONCURRENCY, "candidate bitmap decodes start at the bounded concurrency limit");
  let released = 0; let maxInFlight = tracker.starts.length;
  while (released < 9) {
    await tracker.waitFor(released + 1);
    maxInFlight = Math.max(maxInFlight, tracker.starts.length - released);
    assert.ok(tracker.starts.length - released <= test.CANDIDATE_MASK_DECODE_CONCURRENCY, "unsettled candidate decodes never exceed the configured limit");
    tracker.starts[released].gate.resolve();
    released += 1;
    if (released === 1) {
      await tracker.waitFor(test.CANDIDATE_MASK_DECODE_CONCURRENCY + 1);
      assert.equal(tracker.starts.length, test.CANDIDATE_MASK_DECODE_CONCURRENCY + 1, "each completed decode admits exactly one queued candidate");
    }
  }
  const bundle = await loading;
  assert.equal(tracker.starts.length, 9, "the success case drains every candidate decode before settling");
  assert.equal(maxInFlight, test.CANDIDATE_MASK_DECODE_CONCURRENCY, "the pool reaches but never exceeds its configured concurrency");
  assert.equal(bundle.candidateImages.size, 9, "every candidate is decoded after the bounded queue drains");
  assert.ok(decoded.every((bitmap) => !bitmap.closed), "success keeps decoded candidate bitmaps owned by its bundle");
}

async function failureCleanupCase() {
  const tracker = startTracker(); const decoded = [];
  const { state, test } = runtime(async (candidateId) => {
    const gate = deferred(); tracker.add({ candidateId, gate });
    await gate.promise;
    return decodedBitmap(candidateId, decoded);
  });
  const loading = test.loadCandidateBundle("image", 1);
  await tracker.waitFor(test.CANDIDATE_MASK_DECODE_CONCURRENCY);
  tracker.starts[0].gate.resolve();
  await tracker.waitFor(test.CANDIDATE_MASK_DECODE_CONCURRENCY + 1);
  const controller = state.candidateLoadControllers.get("image:1");
  tracker.starts[1].gate.reject(new Error("decode failed"));
  await new Promise((resolve) => {
    const signal = controller.signal;
    if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true });
  });
  for (const entry of tracker.starts.slice(2)) entry.gate.resolve();
  await assert.rejects(loading);
  assert.ok(decoded.length > 0 && decoded.every((bitmap) => bitmap.closed), "a failed decode closes every bitmap produced by the remaining settled workers");
}

async function abortCleanupCase() {
  const tracker = startTracker(); const decoded = [];
  const { state, test } = runtime(async (candidateId) => {
    const gate = deferred(); tracker.add({ candidateId, gate });
    await gate.promise;
    return decodedBitmap(candidateId, decoded);
  });
  const loading = test.loadCandidateBundle("image", 1);
  await tracker.waitFor(test.CANDIDATE_MASK_DECODE_CONCURRENCY);
  state.candidateLoadControllers.get("image:1").abort();
  for (const entry of tracker.starts) entry.gate.resolve();
  await assert.rejects(loading, { name: "AbortError" });
  assert.ok(decoded.length > 0 && decoded.every((bitmap) => bitmap.closed), "an aborted load closes every bitmap produced before its workers settle");
}

nodeTest("candidate bundle loading contracts", async () => {
  await boundedConcurrencyCase();
  await failureCleanupCase();
  await abortCleanupCase();
});
