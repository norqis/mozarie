const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const gallerySource = fs.readFileSync(path.join(__dirname, "..", "static", "js", "gallery.js"), "utf8");
const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
const canvasSource = fs.readFileSync(path.join(__dirname, "..", "static", "js", "editor-canvas.js"), "utf8");
const resourcesPath = path.join(__dirname, "..", "static", "js", "resources.js");
const resourcesOriginalSource = fs.readFileSync(resourcesPath, "utf8");
const resourcesSource = resourcesOriginalSource.replace(/async function fetchBitmap[^\n]*/, "async function fetchBitmap(...args) { return globalThis.__fetchBitmap(...args); }");
assert.match(gallerySource, /onmouseenter = \(\) => \{ schedulePrefetch\(image, 2\); prefetchNeighbors\(image\); \}/);
assert.doesNotMatch(gallerySource, /onmouseenter[^\n]*loadCandidateBundle/);
assert.match(canvasSource, /candidateBundleCache\.take\(oldKey\)/, "candidate revisions transfer cache ownership without closing displayed masks");
const state = { currentId: null, pendingImageId: null, currentImage: null, pendingImageKey: null, pendingCandidateKey: null, candidateImages: new Map(), imageInflight: new Map(), prefetchQueue: [], prefetchTimer: null, prefetchActive: 0, catalogEpoch: 1, catalogLoadControllers: new Set() };
const responseError = (response, payload) => { const error = new Error(); error.status = response.status; error.code = typeof payload?.error_code === "string" ? payload.error_code : (response.status === 404 ? "api_not_found" : "internal_error"); error.params = payload?.params || {}; return error; };
const context = { state, setTimeout() { return 1; }, clearTimeout() {}, fetch() {}, document: { querySelector() { return null; } }, encodeURIComponent, Promise, Set, Map, Math, AbortController, DOMException, responseError, __fetchBitmap: null };
vm.runInNewContext(resourcesSource, context);
vm.runInNewContext("globalThis.resourceTest = { WeightedLru, drainPrefetchQueue };", context, { filename: "test-resources-exports.js" });
vm.runInNewContext(canvasSource, context, { filename: canvasPath });
const closed = []; const cache = new context.resourceTest.WeightedLru(8, (value) => closed.push(value.id), () => false);
cache.set("one", { id: "one" }, 4); cache.set("two", { id: "two" }, 4); cache.get("one"); cache.set("three", { id: "three" }, 4);
assert.equal(cache.has("one"), true, "recent entry remains"); assert.equal(cache.has("two"), false, "least-recent entry is evicted"); assert.deepEqual(closed, ["two"]);
const owned = cache.take("one");
assert.equal(owned.id, "one"); assert.deepEqual(closed, ["two"], "take transfers ownership without release");
cache.delete("three"); assert.deepEqual(closed, ["two", "three"], "explicit delete releases once");
cache.set("oversize", { id: "oversize" }, 9);
assert.equal(cache.has("oversize"), false, "oversize decoded resource is never cached");
assert.deepEqual(closed, ["two", "three"], "uncached oversize remains with its caller");
const current = { id: "current" }; const pinned = new context.resourceTest.WeightedLru(4, (value) => closed.push(value.id), (key) => key === "current");
pinned.set("current", current, 4); pinned.set("next", { id: "next" }, 4);
assert.equal(pinned.has("current"), true, "current resource is pinned during cache pressure");
pinned.trim(); pinned.delete("current");
assert.deepEqual(closed, ["two", "three", "next", "current"], "trim and explicit removal release each owned resource once");

const calls = []; const thumbnailContext = { state: { images: [], viewMode: "edit", galleryNodes: new Map(), galleryFilter: "all" }, Map, encodeURIComponent, IntersectionObserver: class { observe() {} unobserve() { calls.push("unobserve"); } }, $: () => ({ scrollTop: 0 }), t: () => "", imageAssetVersion: () => "", updateActionButtons() {}, document: { querySelectorAll() { return []; } } };
vm.runInNewContext(gallerySource, thumbnailContext, { filename: path.join(__dirname, "..", "static", "js", "gallery.js") });
vm.runInNewContext("globalThis.thumbnailTest = { observeThumbnail, renderGallery, thumbnailObservers };", thumbnailContext, { filename: "test-resources-gallery-exports.js" });
const preview = { dataset: {}, removeAttribute() {} }; thumbnailContext.thumbnailTest.observeThumbnail(preview, { id: "old" }); thumbnailContext.thumbnailTest.thumbnailObservers.get("gallery").unobserve = () => calls.push("unobserve");
thumbnailContext.state.galleryNodes.set("old", { querySelector() { return preview; }, parentNode: { remove() { calls.push("remove"); } } });
thumbnailContext.thumbnailTest.renderGallery();
assert.deepEqual(calls, ["unobserve", "remove"], "filtered thumbnail nodes unobserve before removal");

async function runResourceCoverageCases() {
  const timers = [];
  let tokenAvailable = true;
  const state = {
    currentImage: null, pendingImageKey: null, pendingCandidateKey: null, candidateImages: new Map(),
    imageInflight: new Map(), prefetchQueue: [], prefetchTimer: null, prefetchActive: 0,
  };
  let response = { ok: true, blob: async () => "image" };
  const context = {
    responseError,
    state, Map, Math, Promise, Set, Uint8Array, encodeURIComponent,
    document: { querySelector() { return tokenAvailable ? { content: "coverage-token" } : null; } },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    fetch: async () => response,
    createImageBitmap: async (blob) => ({ blob }),
    t: (key) => key === "errorCode.stale_asset" ? "stale asset" : "image load failed",
    imageAssetVersion: (record) => record.assetVersion || "",
    imageCacheKey: (record) => `${record.id}:${record.assetVersion || ""}`,
    cachedImage: async (record) => ({ id: record.id, close() { record.closed = true; } }),
  };
  vm.runInNewContext(resourcesOriginalSource, context, { filename: resourcesPath });
  vm.runInNewContext("globalThis.resourceCoverage = { WeightedLru, decodedImageWeight, closeBitmap, releaseCandidateBitmapBundle, isPinnedImage, isPinnedCandidateBundle, imageUrl, maskUrl, fetchBitmap, schedulePrefetch, drainPrefetchQueue };", context, { filename: "test-resources-coverage-exports.js" });
  const api = context.resourceCoverage;

  const released = [];
  const cache = new api.WeightedLru(2, (item) => released.push(item), () => false);
  cache.set("a", "a", 1); cache.set("b", "b", 1); cache.get("a"); cache.set("a", "new", 1);
  assert.deepEqual(released, ["a"], "replacing a cached value releases the old owner");
  assert.equal(cache.take("b"), "b", "take returns and removes a cached resource without releasing it");
  cache.delete("a");
  assert.deepEqual(released, ["a", "new"], "delete releases the resource it owns");
  assert.equal(cache.take("missing"), null, "take returns null for a missing resource"); cache.delete("missing"); cache.trim();
  cache.set("same", "value", 1); cache.set("same", "value", 1);
  cache.set("large", "large", 3);
  assert.equal(cache.has("large"), false, "an unpinned oversized cache value stays with its caller");
  const pinnedCache = new api.WeightedLru(1, () => {}, (key) => key === "pinned");
  pinnedCache.set("pinned", "value", 2);
  assert.equal(pinnedCache.has("pinned"), true, "a pinned oversized value remains available");
  const pressureReleased = []; const pressureCache = new api.WeightedLru(1, (value) => pressureReleased.push(value), () => false);
  pressureCache.set("one", "one", 1); pressureCache.set("two", "two", 1);
  assert.deepEqual(pressureReleased, ["one"], "an unpinned cache entry is evicted under pressure");
  assert.equal(api.decodedImageWeight({ width: 2, height: 3 }), 24, "decoded weights use RGBA bytes");
  assert.equal(api.decodedImageWeight(), 1, "decoded weights have a positive minimum");
  assert.equal(api.decodedImageWeight({ width: 0, height: 3 }), 1, "zero dimensions still use the positive minimum");

  const closable = { close() { this.closed = true; } }; const source = { src: "blob:source" };
  api.closeBitmap(closable); api.closeBitmap(source); api.closeBitmap(null);
  assert.equal(closable.closed, true, "bitmap resources use close when supplied");
  assert.equal(source.src, "", "image-like resources clear their source when close is unavailable");
  const candidate = { closed: 0, close() { this.closed += 1; } };
  api.releaseCandidateBitmapBundle({ candidateImages: new Map([["candidate", candidate]]) }); api.releaseCandidateBitmapBundle({}); api.releaseCandidateBitmapBundle(null);
  assert.equal(candidate.closed, 1, "candidate bundles release every bitmap they own");

  state.currentImage = closable; state.pendingImageKey = "pending"; state.candidateImages = new Map(); state.pendingCandidateKey = "candidate-pending";
  assert.equal(api.isPinnedImage("other", closable), true, "the displayed image is pinned");
  assert.equal(api.isPinnedImage("pending", {}), true, "the pending image key is pinned");
  assert.equal(api.isPinnedCandidateBundle("other", { candidateImages: state.candidateImages }), true, "the displayed candidate bundle is pinned");
  assert.equal(api.isPinnedCandidateBundle("candidate-pending", {}), true, "the pending candidate key is pinned");
  assert.equal(api.isPinnedImage("other", {}), false, "unrelated images are not pinned");
  assert.equal(api.isPinnedCandidateBundle("other", {}), false, "unrelated candidate bundles are not pinned");
  assert.equal(api.imageUrl({ id: "a b", assetVersion: "v/1" }), "/api/image/a%20b?v=v%2F1", "image URLs encode ids and versions");
  assert.equal(api.imageUrl({ id: "plain" }), "/api/image/plain", "unversioned image URLs omit the query");
  assert.equal(api.maskUrl("image/id", "candidate id", 4), "/api/mask/image%2Fid/candidate%20id?v=4-candidate%20id", "mask URLs encode every path component");

  assert.deepEqual(await api.fetchBitmap("/ok"), { blob: "image" }, "successful bitmap responses decode their blob");
  tokenAvailable = false;
  assert.deepEqual(await api.fetchBitmap("/no-token"), { blob: "image" }, "bitmap loading works without a document token");
  tokenAvailable = true;
  response = { ok: false, status: 409, json: async () => ({ error_code: "stale_asset", params: { detail: "x" } }) };
  await assert.rejects(api.fetchBitmap("/stale"), (error) => error.status === 409 && error.code === "stale_asset", "failed bitmap responses retain their API error");
  response = { ok: false, status: 500, json: async () => { throw new Error("invalid JSON"); } };
  await assert.rejects(api.fetchBitmap("/invalid"), (error) => error.status === 500 && error.code === "internal_error", "invalid error payloads use the stable internal code");
  response = { ok: false, status: 400, json: async () => ({ error_code: "unknown" }) };
  await assert.rejects(api.fetchBitmap("/unknown"), (error) => error.status === 400 && error.code === "unknown", "unknown API errors use the generic image-load message");

  const first = { id: "first", assetVersion: "1" }; const second = { id: "second", assetVersion: "1" };
  api.schedulePrefetch(null); api.schedulePrefetch(first, 1); api.schedulePrefetch(first, 3); state.imageInflight.set("second:1", Promise.resolve()); api.schedulePrefetch(second, 4);
  assert.deepEqual(state.prefetchQueue.map((entry) => entry.record.id), ["first"], "prefetch skips duplicates and already-loading images");
  state.imageInflight.clear();
  for (const index of [0, 1, 2, 3, 4]) api.schedulePrefetch({ id: `queued-${index}` }, index);
  assert.equal(state.prefetchQueue.length, 4, "prefetch keeps a bounded queue");
  state.prefetchQueue = []; api.drainPrefetchQueue();
  state.prefetchQueue = [{ record: first }]; state.pendingImageKey = ""; first.closed = false;
  timers.at(-1)();
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.closed, true, "an unpinned prefetch is released when it is not cached");
  context.cachedImage = async (record) => { if (record.id === "failed") throw new Error("fixture failure"); return { id: record.id, close() { record.closed = true; } }; };
  state.prefetchQueue = [{ record: { id: "failed" } }]; api.drainPrefetchQueue();
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.prefetchActive, 0, "a failed prefetch releases its active slot");
}

(async () => {
  const record = { id: "oversize", assetVersion: "v1" }; let releases = 0; let resolveBitmap;
  context.catalogRecordMatches = (candidate, epoch, { version } = {}) => candidate === record && epoch === state.catalogEpoch && version === record.assetVersion;
  context.__fetchBitmap = () => new Promise((resolve) => { resolveBitmap = resolve; });
  state.prefetchQueue.push({ record }); context.resourceTest.drainPrefetchQueue();
  resolveBitmap({ width: 10000, height: 10000, close() { releases += 1; } });
  for (let index = 0; index < 4 && state.prefetchActive; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 1, "uncached background prefetch releases its bitmap exactly once");
  assert.equal(state.imageCache.has("oversize:v1"), false, "oversize prefetch remains uncached");

  const joined = { id: "joined", assetVersion: "v1" }; context.catalogRecordMatches = (candidate, epoch, { version } = {}) => candidate === joined && epoch === state.catalogEpoch && version === joined.assetVersion;
  state.pendingImageKey = "joined:v1"; state.prefetchQueue.push({ record: joined }); context.resourceTest.drainPrefetchQueue();
  resolveBitmap({ width: 10000, height: 10000, close() { releases += 1; } });
  for (let index = 0; index < 4 && state.prefetchActive; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 1, "the exact pending image key keeps a joined foreground image available");
  const errorContext = { state: {}, fetch: async () => ({ ok: false, status: 400, json: async () => ({ error_code: "stale_asset" }) }), document: { querySelector() { return null; } }, t: () => "load failed", Promise, Set, Map, Math, AbortController, DOMException, encodeURIComponent, responseError };
  vm.runInNewContext(fs.readFileSync(resourcesPath, "utf8"), errorContext, { filename: resourcesPath });
  vm.runInNewContext("globalThis.fetchBitmapForTest = fetchBitmap;", errorContext, { filename: "test-resources-error-exports.js" });
  await assert.rejects(errorContext.fetchBitmapForTest("/api/image/stale"), (error) => error.code === "stale_asset" && error.status === 400, "full-image stale response retains its error code");
  await runResourceCoverageCases();
  console.log("test_resources: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
