"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");

const resourcesPath = path.join(__dirname, "..", "static", "js", "resources.js");

function createResourceRuntime(images) {
  const released = [];
  const prefetched = [];
  let filtered = images;
  const state = {
    images, currentId: null, pendingImageId: null, pendingImageKey: null, pendingCandidateKey: null,
    currentImage: null, candidateImages: new Map(), hoverPrefetchId: null,
    imageInflight: new Map(), candidateInflight: new Map(), imageLoadControllers: new Map(),
    candidateLoadControllers: new Map(), resourceImageKeys: new Set(), resourceCandidateKeys: new Set(),
  };
  const imageCacheKey = (image) => `${image.id}:${image.assetVersion || ""}`;
  const navigationNeighbors = (id) => {
    const index = filtered.findIndex((image) => image.id === id);
    if (index < 0) return [...new Set([filtered.at(-1), filtered[0]].filter(Boolean))];
    return [filtered[index - 1], filtered[index + 1]].filter(Boolean);
  };
  const context = {
    state, Map, Set, Promise, AbortController, encodeURIComponent,
    imageAssetVersion: (image) => image?.assetVersion || "", imageCacheKey,
    candidateCacheKey: (id, revision) => `${id}:${revision}`,
    galleryNavigationNeighbors: navigationNeighbors, galleryFilteredImages: () => filtered,
    cachedImage: async (image) => { const bitmap = { id: image.id, close() { released.push(image.id); } }; prefetched.push(image.id); return bitmap; },
    document: { querySelector: () => null }, fetch: async () => ({ ok: true, blob: async () => ({}) }),
    createImageBitmap: async () => ({}), responseError: () => new Error("image request failed"),
  };
  vm.runInNewContext(fs.readFileSync(resourcesPath, "utf8"), context, { filename: resourcesPath });
  vm.runInNewContext("globalThis.resourceTest = { StateResourceCache, syncResourceOwnership, desiredImageResourceKeys, desiredCandidateResourceKeys, imageUrl, maskUrl, candidatePaddingPreviewUrl, schedulePrefetch };", context, { filename: "resource-contract-exports.js" });
  return { context, state, test: context.resourceTest, released, prefetched, imageCacheKey, setFiltered(value) { filtered = value; } };
}

nodeTest("resource ownership contracts", async (t) => {
  await t.test("current pending filtered neighbors and hover are the only retained images", () => {
    const images = [
      { id: "previous", assetVersion: "a", candidateRevision: 1 },
      { id: "current", assetVersion: "b", candidateRevision: 2 },
      { id: "next", assetVersion: "c", candidateRevision: 3 },
      { id: "hover", assetVersion: "d", candidateRevision: 4 },
      { id: "after", assetVersion: "e", candidateRevision: 5 },
    ];
    const runtime = createResourceRuntime(images);
    const { state, test } = runtime;
    state.currentId = "current"; state.pendingImageId = "current"; state.pendingImageKey = "current:b"; state.hoverPrefetchId = "hover";
    state.pendingCandidateKey = "current:2";
    assert.deepEqual([...test.desiredImageResourceKeys()].sort(), ["previous:a", "current:b", "next:c", "hover:d"].sort(), "transition ownership includes actual neighbors and an independent hovered image while retaining the current image");
    assert.deepEqual([...test.desiredCandidateResourceKeys()].sort(), ["current:2"]);
    assert.equal(test.imageUrl({ id: "a b", assetVersion: "v/1" }), "/api/image/a%20b?v=v%2F1");
    assert.equal(test.maskUrl("image/id", "candidate id", 4), "/api/mask/image%2Fid/candidate%20id?v=4-candidate%20id");
    assert.equal(test.candidatePaddingPreviewUrl("image/id", "candidate id", 4, 12), "/api/mask/image%2Fid/candidate%20id?v=4-candidate%20id&expandPx=12");
  });

  await t.test("400 selections keep decoded image ownership bounded", () => {
    const images = Array.from({ length: 400 }, (_, index) => ({ id: `image-${index}`, assetVersion: `v${index}`, candidateRevision: index }));
    const runtime = createResourceRuntime(images);
    const { state, test, released, imageCacheKey } = runtime;
    for (let index = 0; index < images.length; index += 1) {
      state.currentId = images[index].id;
      test.syncResourceOwnership();
      state.imageCache.set(imageCacheKey(images[index]), { id: images[index].id, close() { released.push(images[index].id); } });
      assert.ok(state.imageCache.items.size <= 3, `selection ${index} retains only current and actual neighbors`);
    }
    state.currentId = null; runtime.setFiltered([]); test.syncResourceOwnership();
    assert.equal(state.imageCache.items.size, 0, "leaving the catalogue releases every decoded image");
    assert.equal(released.length, 400, "each decoded image is released exactly once rather than accumulating with selection count");
  });

  await t.test("clearing selection releases edge images while hover retains only its own bitmap", () => {
    const images = [
      { id: "first", assetVersion: "a" },
      { id: "middle", assetVersion: "b" },
      { id: "last", assetVersion: "c" },
    ];
    const { state, test, released, imageCacheKey } = createResourceRuntime(images);
    state.currentId = "middle";
    test.syncResourceOwnership();
    for (const image of images) state.imageCache.set(imageCacheKey(image), { close() { released.push(image.id); } });
    state.currentId = null;
    test.syncResourceOwnership();
    assert.equal(state.imageCache.items.size, 0, "a visible catalogue without selection or hover owns no decoded images");
    assert.deepEqual(released.sort(), ["first", "last", "middle"], "selection release closes the current image and both neighboring bitmaps");

    state.hoverPrefetchId = "middle";
    test.syncResourceOwnership();
    for (const image of images) state.imageCache.set(imageCacheKey(image), { close() { released.push(`hover-${image.id}`); } });
    assert.deepEqual([...state.imageCache.items.keys()], ["middle:b"], "hover ownership retains only the hovered bitmap without a selected image");
  });

  await t.test("filter and hover changes close stale bitmaps and abort stale requests", async () => {
    const images = [
      { id: "old", assetVersion: "a" }, { id: "current", assetVersion: "b" },
      { id: "next", assetVersion: "c" }, { id: "hover", assetVersion: "d" },
    ];
    const runtime = createResourceRuntime(images);
    const { state, test, released, imageCacheKey } = runtime;
    state.currentId = "current"; state.hoverPrefetchId = "hover";
    test.syncResourceOwnership();
    for (const image of images) state.imageCache.set(imageCacheKey(image), { id: image.id, close() { released.push(image.id); } });
    const oldRequest = new AbortController(); const hoverRequest = new AbortController();
    state.imageLoadControllers.set("old:a", oldRequest); state.imageLoadControllers.set("hover:d", hoverRequest);

    runtime.setFiltered([images[1], images[2]]);
    state.hoverPrefetchId = null;
    test.syncResourceOwnership();
    assert.equal(oldRequest.signal.aborted, true, "a filter change cancels a request outside the new filtered neighbors");
    assert.equal(hoverRequest.signal.aborted, true, "ending hover cancels its request after the image leaves the filtered view");
    assert.equal(state.imageCache.has("old:a"), false, "a stale filtered bitmap is closed");
    assert.equal(state.imageCache.has("hover:d"), false, "a stale hover bitmap is closed");
    assert.deepEqual(released.sort(), ["hover", "old"], "only stale ownership is released while current and next remain");

    state.currentId = null; runtime.setFiltered([]); test.syncResourceOwnership();
    assert.equal(state.imageCache.items.size, 0, "switching away releases the remaining catalogue bitmaps");
    await test.schedulePrefetch(null);
  });
});
