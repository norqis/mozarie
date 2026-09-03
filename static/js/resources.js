class WeightedLru {
  constructor(limit, release, isPinned) { this.limit = limit; this.release = release; this.isPinned = isPinned; this.items = new Map(); this.weight = 0; }
  has(key) { return this.items.has(key); }
  get(key) { const entry = this.items.get(key); if (!entry) return null; this.items.delete(key); this.items.set(key, entry); return entry.value; }
  take(key) { const entry = this.items.get(key); if (!entry) return null; this.items.delete(key); this.weight -= entry.weight; return entry.value; }
  set(key, value, weight) { if (weight > this.limit && !this.isPinned(key, value)) return value; const old = this.items.get(key); if (old) { this.items.delete(key); this.weight -= old.weight; if (old.value !== value) this.release(old.value); } this.items.set(key, { value, weight }); this.weight += weight; this.trim(); return value; }
  delete(key) { const entry = this.items.get(key); if (!entry) return; this.items.delete(key); this.weight -= entry.weight; this.release(entry.value); }
  trim() { for (const [key, entry] of this.items) { if (this.weight <= this.limit) break; if (this.isPinned(key, entry.value)) continue; this.items.delete(key); this.weight -= entry.weight; this.release(entry.value); } }
}
function decodedImageWeight(image) { return Math.max(1, Number(image?.width || 0) * Number(image?.height || 0) * 4); }
function closeBitmap(image) { if (typeof image?.close === "function") image.close(); else if (image && "src" in image) image.src = ""; }
function releaseCandidateBitmapBundle(bundle) {
  const images = bundle?.candidateImages;
  for (const image of images?.values?.() || []) closeBitmap(image);
  images?.clear?.();
  if (bundle) { bundle.candidates = []; bundle.candidateImages = new Map(); }
}
function isPinnedImage(key, image) { return image === state.currentImage || key === state.pendingImageKey; }
function isPinnedCandidateBundle(key, bundle) { return bundle?.candidateImages === state.candidateImages || key === state.pendingCandidateKey; }
state.imageCache = new WeightedLru(128 * 1024 * 1024, closeBitmap, isPinnedImage);
state.candidateBundleCache = new WeightedLru(128 * 1024 * 1024, releaseCandidateBitmapBundle, isPinnedCandidateBundle);
function imageUrl(record) { const version = imageAssetVersion(record); return `/api/image/${encodeURIComponent(record.id)}${version ? `?v=${encodeURIComponent(version)}` : ""}`; }
function maskUrl(imageId, candidateId, revision) { return `/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidateId)}?v=${encodeURIComponent(`${revision}-${candidateId}`)}`; }
async function fetchBitmap(url, signal) { const response = await fetch(url, { signal, headers: { "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" } }); if (!response.ok) throw responseError(response, await response.json().catch(() => ({}))); return createImageBitmap(await response.blob()); }
function schedulePrefetch(record, priority = 0) { if (!record || state.prefetchQueue.some((entry) => entry.record.id === record.id) || state.imageInflight.has(imageCacheKey(record))) return; state.prefetchQueue.push({ record, priority }); state.prefetchQueue.sort((left, right) => right.priority - left.priority); state.prefetchQueue.length = Math.min(4, state.prefetchQueue.length); clearTimeout(state.prefetchTimer); state.prefetchTimer = setTimeout(drainPrefetchQueue, 80); }
function drainPrefetchQueue() { state.prefetchTimer = null; while (state.prefetchActive < 2 && state.prefetchQueue.length) { const { record } = state.prefetchQueue.shift(); state.prefetchActive += 1; cachedImage(record).then((image) => { const key = imageCacheKey(record); if (!state.imageCache.has(key) && !isPinnedImage(key, image)) closeBitmap(image); }).catch(() => {}).finally(() => { state.prefetchActive -= 1; drainPrefetchQueue(); }); } }
