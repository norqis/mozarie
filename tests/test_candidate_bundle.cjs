const assert = require("node:assert/strict"); const fs = require("node:fs"); const path = require("node:path"); const vm = require("node:vm");
const resourcesPath = path.join(__dirname, "..", "static", "js", "resources.js"); const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
const record = { id: "image", assetVersion: "v1", candidateRevision: 4 }; const state = { images: [record], currentId: "image", pendingImageId: null, candidateImages: new Map(), catalogEpoch: 1, catalogLoadControllers: new Set(), candidateInflight: new Map(), imageInflight: new Map(), prefetchQueue: [], prefetchTimer: null, prefetchActive: 0, galleryNodes: new Map(), overviewNodes: new Map(), drafts: new Map() };
let apiResult; let bitmapLoader;
const validCandidateTokens = (candidate) => candidate?.labelToken === "penis" && candidate.source === "target" && candidate.refinement === null;
const context = { state, Map, Set, Math, Promise, AbortController, DOMException, setTimeout, clearTimeout, document: { querySelector() { return null; } }, encodeURIComponent, validCandidateTokens, codedError(code) { const error = new Error(code); error.code = code; return error; }, api: async () => apiResult, isCurrentGeneration: () => true, abortCatalogLoads() { for (const controller of state.catalogLoadControllers) controller.abort(); state.catalogLoadControllers.clear(); state.imageInflight.clear(); state.candidateInflight.clear(); }, catalogRecordMatches: (current, epoch, { version, revision } = {}) => epoch === state.catalogEpoch && current === record && record.assetVersion === version && (revision == null || record.candidateRevision === revision) };
vm.runInNewContext(fs.readFileSync(resourcesPath, "utf8"), context, { filename: resourcesPath });
vm.runInNewContext(fs.readFileSync(canvasPath, "utf8"), context, { filename: canvasPath });
vm.runInNewContext("globalThis.loadCandidateBundle = loadCandidateBundle; globalThis.cachedImage = cachedImage;", context, { filename: "test-candidate-bundle-exports.js" }); context.fetchBitmap = (...args) => bitmapLoader(...args);

(async () => {
  let decodes = 0; apiResult = { candidates: [{ id: "stale", labelToken: "penis", source: "target", refinement: null }], candidateRevision: 5 }; bitmapLoader = async () => { decodes += 1; return { close() {} }; };
  record.candidateRevision = 4; const changed = context.loadCandidateBundle("image", 1); record.candidateRevision = 5;
  await changed; assert.equal(decodes, 1, "metadata is authoritative when candidate revision changes"); assert.equal(state.catalogLoadControllers.size, 0, "request unregisters its controller"); for (const [key] of state.candidateBundleCache.items) state.candidateBundleCache.delete(key);
  record.candidateRevision = 4; apiResult = { candidates: [{ id: "invalid-token", labelToken: "unknown", source: "target", refinement: null }], candidateRevision: 5 };
  await assert.rejects(context.loadCandidateBundle("image", 1), (error) => error.code === "response_invalid", "an unknown candidate label token is rejected before any mask is fetched");
  let closed = 0; record.candidateRevision = 4; apiResult = { candidates: [{ id: "kept", labelToken: "penis", source: "target", refinement: null }, { id: "broken", labelToken: "penis", source: "target", refinement: null }], candidateRevision: 5 };
  bitmapLoader = async (source) => { if (source.includes("broken")) throw new Error("decode failed"); return { width: 1, height: 1, close() { closed += 1; } }; };
  await assert.rejects(context.loadCandidateBundle("image", 1), /decode failed/); assert.equal(closed, 1, "a failed mask decode closes accumulated decoded masks exactly once"); assert.equal(state.catalogLoadControllers.size, 0, "failed request unregisters its controller"); console.log("test_candidate_bundle: passed");
  let imageClosed = 0; let candidateClosed = 0; const staleImage = { close() { imageClosed += 1; } }; const staleCandidate = { close() { candidateClosed += 1; } };
  state.imageCache.set("stale:v1", staleImage, 1); state.candidateBundleCache.set("stale:1", { candidateImages: new Map([["candidate", staleCandidate]]) }, 1); state.drafts.set("stale", { add: "kept" });
  context.forgetThumbnail = () => {}; context.invalidateStaleAsset("stale");
  assert.equal(imageClosed, 1, "non-current stale image closes exactly once"); assert.equal(candidateClosed, 1, "non-current stale candidate closes exactly once"); assert.equal(state.drafts.get("stale").add, "kept", "stale cleanup preserves drafts");
  const stale = { id: "stale", assetVersion: "v1", candidateRevision: 0 }; state.images.push(stale); let resolveFull; let fullClosed = 0;
  context.fetchBitmap = () => new Promise((resolve) => { resolveFull = resolve; }); context.api = async () => { const error = new Error("stale"); error.code = "stale_asset"; throw error; };
  const fullPending = context.cachedImage(stale); await assert.rejects(context.loadCandidateBundle("stale", 1), /stale/); context.invalidateStaleAsset("stale"); resolveFull({ width: 1, height: 1, close() { fullClosed += 1; } }); await assert.rejects(fullPending, (error) => error.name === "AbortError");
  assert.equal(state.imageCache.has("stale:v1"), false, "aborted full load cannot reinsert after candidate stale"); assert.equal(fullClosed, 1, "aborted full bitmap closes once");
})().catch((error) => { console.error(error); process.exitCode = 1; });
