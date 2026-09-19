class StateResourceCache {
  constructor(release, isOwned) { this.release = release; this.isOwned = isOwned; this.items = new Map(); }
  has(key) { return this.items.has(key); }
  get(key) { return this.items.get(key)?.value || null; }
  take(key) { const entry = this.items.get(key); if (!entry) return null; this.items.delete(key); return entry.value; }
  set(key, value) { const old = this.items.get(key); if (old?.value !== value) this.release(old?.value); this.items.set(key, { value }); this.trim(); return value; }
  delete(key) { const entry = this.items.get(key); if (!entry) return; this.items.delete(key); this.release(entry.value); }
  trim() { for (const [key, entry] of this.items) if (!this.isOwned(key, entry.value)) this.delete(key); }
}
function closeBitmap(image) { if (typeof image?.close === "function") image.close(); else if (image && "src" in image) image.src = ""; }
function releaseCandidateBitmapBundle(bundle) {
  const images = bundle?.candidateImages;
  for (const image of images?.values?.() || []) closeBitmap(image);
  images?.clear?.();
  if (bundle) { bundle.candidates = []; bundle.candidateImages = new Map(); }
}
function isOwnedImage(key, image) { return state.resourceImageKeys.has(key) || image === state.currentImage; }
function isOwnedCandidateBundle(key, bundle) { return state.resourceCandidateKeys.has(key) || bundle?.candidateImages === state.candidateImages; }
state.imageCache = new StateResourceCache(closeBitmap, isOwnedImage);
state.candidateBundleCache = new StateResourceCache(releaseCandidateBitmapBundle, isOwnedCandidateBundle);
function imageUrl(record) { const version = imageAssetVersion(record); return `/api/image/${encodeURIComponent(record.id)}${version ? `?v=${encodeURIComponent(version)}` : ""}`; }
function maskUrl(imageId, candidateId, revision) { return `/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidateId)}?v=${encodeURIComponent(`${revision}-${candidateId}`)}`; }
function candidatePaddingPreviewUrl(imageId, candidateId, revision, expandPx) { return `${maskUrl(imageId, candidateId, revision)}&expandPx=${encodeURIComponent(expandPx)}`; }
async function fetchBitmap(url, signal) { const response = await fetch(url, { signal, headers: { "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" } }); if (!response.ok) throw responseError(response, await response.json().catch(() => ({}))); return createImageBitmap(await response.blob()); }
function desiredImageResourceKeys(extra = []) {
  const keys = new Set(extra);
  for (const imageId of [state.currentId, state.pendingImageId]) {
    const image = state.images.find((item) => item.id === imageId);
    if (image) keys.add(imageCacheKey(image));
  }
  for (const image of galleryNavigationNeighbors(state.pendingImageId || state.currentId)) keys.add(imageCacheKey(image));
  if (state.pendingImageKey) keys.add(state.pendingImageKey);
  const hovered = galleryFilteredImages().find((image) => image.id === state.hoverPrefetchId);
  if (hovered) keys.add(imageCacheKey(hovered));
  return keys;
}
function desiredCandidateResourceKeys(extra = []) {
  const keys = new Set(extra);
  const current = state.images.find((image) => image.id === state.currentId);
  if (current) keys.add(candidateCacheKey(current.id, Number(current.candidateRevision || 0)));
  if (state.pendingCandidateKey) keys.add(state.pendingCandidateKey);
  return keys;
}
function syncResourceOwnership(extraImages = [], extraCandidates = []) {
  state.resourceImageKeys = desiredImageResourceKeys(extraImages);
  state.resourceCandidateKeys = desiredCandidateResourceKeys(extraCandidates);
  for (const [key, controller] of state.imageLoadControllers) if (!state.resourceImageKeys.has(key)) { controller.abort(); state.imageLoadControllers.delete(key); }
  for (const [key, controller] of state.candidateLoadControllers) if (!state.resourceCandidateKeys.has(key)) { controller.abort(); state.candidateLoadControllers.delete(key); }
  state.imageCache.trim(); state.candidateBundleCache.trim();
}
function schedulePrefetch(record) {
  if (!record) return;
  syncResourceOwnership([imageCacheKey(record)]);
  if (state.imageCache.has(imageCacheKey(record)) || state.imageInflight.has(imageCacheKey(record))) return;
  cachedImage(record).then((image) => { if (!state.imageCache.has(imageCacheKey(record))) closeBitmap(image); }).catch(() => {});
}
