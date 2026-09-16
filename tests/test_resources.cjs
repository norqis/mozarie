"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");

const resourcesPath = path.join(__dirname, "..", "static", "js", "resources.js");
const state = {
  images: [{ id: "previous", assetVersion: "a", candidateRevision: 1 }, { id: "current", assetVersion: "b", candidateRevision: 2 }, { id: "next", assetVersion: "c", candidateRevision: 3 }],
  currentId: "current", pendingImageId: null, pendingImageKey: null, pendingCandidateKey: null, currentImage: null, candidateImages: new Map(), hoverPrefetchId: null,
  imageInflight: new Map(), candidateInflight: new Map(), imageLoadControllers: new Map(), candidateLoadControllers: new Map(), resourceImageKeys: new Set(), resourceCandidateKeys: new Set(),
};
const context = {
  state, Map, Set, Promise, AbortController, encodeURIComponent,
  imageAssetVersion: (image) => image?.assetVersion || "", imageCacheKey: (image) => `${image.id}:${image.assetVersion || ""}`, candidateCacheKey: (id, revision) => `${id}:${revision}`,
  galleryNavigationNeighbors: (id) => id === "current" ? [state.images[0], state.images[2]] : [], galleryFilteredImages: () => state.images,
  cachedImage: async (image) => ({ id: image.id, close() {} }), document: { querySelector: () => null }, fetch: async () => ({ ok: true, blob: async () => ({}) }), createImageBitmap: async () => ({}), responseError: () => new Error("image request failed"),
};
vm.runInNewContext(fs.readFileSync(resourcesPath, "utf8"), context, { filename: resourcesPath });
vm.runInNewContext("globalThis.resourceTest = { StateResourceCache, syncResourceOwnership, desiredImageResourceKeys, desiredCandidateResourceKeys, imageUrl, maskUrl, schedulePrefetch };", context, { filename: "resource-contract-exports.js" });
const test = context.resourceTest;

const released = [];
const cache = new test.StateResourceCache((value) => { if (value) released.push(value.id); }, (key) => state.resourceImageKeys.has(key));
const currentKey = "current:b"; const oldKey = "previous:a"; const nextKey = "next:c";
state.resourceImageKeys = new Set([currentKey]);
cache.set(currentKey, { id: "current" }); cache.set(oldKey, { id: "previous" });
assert.equal(cache.has(currentKey), true, "the current decoded image is retained");
assert.equal(cache.has(oldKey), false, "unowned decoded images are released immediately");
assert.deepEqual(released, ["previous"]);

state.pendingImageId = "next"; state.hoverPrefetchId = "previous";
assert.deepEqual([...test.desiredImageResourceKeys()].sort(), [oldKey, currentKey, nextKey].sort(), "ownership includes filtered navigation, pending, and hovered images");
state.pendingCandidateKey = "next:3";
assert.deepEqual([...test.desiredCandidateResourceKeys()].sort(), ["current:2", "next:3"], "candidate ownership keeps current and pending bundles");

const controller = new AbortController(); state.imageLoadControllers.set(oldKey, controller); test.syncResourceOwnership(); cache.set(oldKey, { id: "previous-retained" });
assert.equal(cache.has(oldKey), true, "a hovered filtered image remains cached");
state.hoverPrefetchId = null; state.pendingImageId = null; test.syncResourceOwnership();
assert.equal(cache.has(oldKey), true, "filtered navigation retains the previous image after hover ends");
const owned = cache.take(currentKey); assert.equal(owned.id, "current", "take transfers an owned image without closing it");
state.currentId = null; test.syncResourceOwnership(); cache.trim();
assert.equal(cache.has(oldKey), false, "ownership is released when the navigation context ends"); assert.equal(controller.signal.aborted, true, "an unowned image request is cancelled");
assert.deepEqual(released, ["previous", "previous-retained"]);
assert.equal(test.imageUrl({ id: "a b", assetVersion: "v/1" }), "/api/image/a%20b?v=v%2F1");
assert.equal(test.maskUrl("image/id", "candidate id", 4), "/api/mask/image%2Fid/candidate%20id?v=4-candidate%20id");
nodeTest("resource contracts", async () => { await test.schedulePrefetch(state.images[2]); });
