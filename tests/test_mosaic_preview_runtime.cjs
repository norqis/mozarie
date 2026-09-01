const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const counters = { bitmaps: 0, closed: 0, workers: 0, terminated: 0, workerCanvases: 0, peakWorkerCanvases: 0 };
const draws = [];
function bitmap(kind) {
  counters.bitmaps += 1;
  return { kind, close() { if (!this.closed) { this.closed = true; counters.closed += 1; } } };
}

class Worker {
  constructor() { this.onmessage = null; this.renderJobs = []; this.renderWaiters = []; this.renderMasks = []; counters.workers += 1; }
  postMessage(payload) {
    if (payload.type === "source") {
      this.source = payload.source; this.sourceId = payload.sourceId;
      counters.workerCanvases += 1; counters.peakWorkerCanvases = Math.max(counters.peakWorkerCanvases, counters.workerCanvases);
    }
    if (payload.type === "render") {
      this.renderMasks.push(payload.mask);
      if (this.renderWaiters.length) this.renderWaiters.shift()(payload);
      else this.renderJobs.push(payload);
    }
    if (payload.type === "release") this.release();
  }
  release() {
    this.source?.close?.(); this.source = null;
    if (this.hasCanvas) return;
    if (this.sourceId !== undefined) { counters.workerCanvases -= 1; this.hasCanvas = true; }
  }
  terminate() { this.release(); this.terminated = true; counters.terminated += 1; }
  nextRender() {
    if (this.renderJobs.length) return Promise.resolve(this.renderJobs.shift());
    return new Promise((resolve) => this.renderWaiters.push(resolve));
  }
  frame(job, sourceId = job.sourceId, generation = job.generation) {
    job.mask.close?.();
    const output = bitmap("output");
    this.onmessage({ data: { type: "frame", sourceId, generation, output } });
    return output;
  }
}

const imageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const canvas = (width = 3840, height = 2160) => ({ width, height });
const state = {
  mosaicPreviewEnabled: true, currentImage: { width: 3840, height: 2160 }, currentId: "first", imageGeneration: 1, mosaicPreviewGeneration: 0,
  mosaicWorker: null, mosaicWorkerBusy: false, mosaicPending: false,
};
const previewButton = { classList: { remove() {} }, setAttribute() {} };
const context = {
  Worker, ImageData: imageData, Uint8Array, Uint8ClampedArray, state,
  createImageBitmap: async (image) => bitmap(image === state.currentImage ? "source" : "mask"), OffscreenCanvas: class {},
  requestAnimationFrame: () => 1,
  originalCanvas: canvas(), combinedCanvas: canvas(), mosaicCanvas: canvas(),
  originalCtx: { clearRect() {}, drawImage() {} }, combinedCtx: {},
  mosaicCtx: { clearRect() {}, drawImage: (image) => draws.push(image.kind) },
  calculatedBlockSize: () => 16, flushMaskComposition() {}, prepareOriginalImage() {}, render() {},
  $: () => previewButton, showUserError() {},
};
const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
vm.runInNewContext(fs.readFileSync(canvasPath, "utf8"), context, { filename: canvasPath });

(async () => {
  await context.rebuildMosaicPreview();
  const worker = state.mosaicWorker;
  const first = await worker.nextRender();
  const staleGeneration = bitmap("stale-generation");
  worker.onmessage({ data: { type: "frame", sourceId: first.sourceId, generation: first.generation - 1, output: staleGeneration } });
  assert.equal(staleGeneration.closed, true, "an outdated frame is closed");
  assert.equal(state.mosaicWorkerBusy, true, "an outdated frame cannot finish the active render");
  const staleSource = bitmap("stale-source");
  worker.onmessage({ data: { type: "frame", sourceId: "other", generation: first.generation, output: staleSource } });
  assert.equal(staleSource.closed, true, "a source-mismatched frame is closed");
  assert.equal(state.mosaicWorkerBusy, true, "a source-mismatched frame cannot finish the active render");

  state.mosaicPending = true;
  const pendingOutput = worker.frame(first);
  assert.equal(pendingOutput.closed, true, "a pending frame is closed without drawing");
  assert.deepEqual(draws, [], "a pending frame is never drawn");
  const newest = await worker.nextRender();
  const newestOutput = worker.frame(newest);
  assert.equal(newestOutput.closed, true, "the newest frame is closed after drawing");
  assert.deepEqual(draws, ["output"], "only the exact newest frame is drawn");

  let resolveMask; let oldMask; let deferFirstMask = true; let signalMaskRequest;
  const maskRequested = new Promise((resolve) => { signalMaskRequest = resolve; });
  context.createImageBitmap = (image) => {
    if (image === context.combinedCanvas && deferFirstMask) {
      deferFirstMask = false;
      oldMask = bitmap("old-mask"); signalMaskRequest();
      return new Promise((resolve) => { resolveMask = () => resolve(oldMask); });
    }
    return Promise.resolve(bitmap("source"));
  };
  const deferredBuild = context.rebuildMosaicPreview();
  await maskRequested;
  context.requestMosaicPreview();
  resolveMask();
  await deferredBuild;
  assert.equal(oldMask.closed, true, "a mask superseded while it is being captured is closed");
  assert.equal(worker.renderMasks.includes(oldMask), false, "a superseded mask is never posted to the worker");
  context.createImageBitmap = async (image) => bitmap(image === state.currentImage ? "source" : "mask");
  const replacementAfterCapture = await worker.nextRender();
  worker.frame(replacementAfterCapture);

  const throwingOutput = bitmap("throwing");
  context.mosaicCtx.drawImage = () => { throw new Error("paint failed"); };
  await context.rebuildMosaicPreview();
  const throwingJob = await worker.nextRender();
  throwingJob.mask.close?.();
  worker.onmessage({ data: { type: "frame", sourceId: throwingJob.sourceId, generation: throwingJob.generation, output: throwingOutput } });
  assert.equal(throwingOutput.closed, true, "a frame bitmap closes when canvas painting throws");
  assert.equal(state.mosaicPreviewEnabled, false, "a failed canvas paint closes the preview instead of leaking a worker frame");
  context.mosaicCtx.drawImage = (image) => draws.push(image.kind);

  context.releaseMosaicPreview();
  const releasedOutput = bitmap("released");
  worker.onmessage({ data: { type: "frame", sourceId: newest.sourceId, generation: newest.generation, output: releasedOutput } });
  assert.equal(releasedOutput.closed, true, "a released worker frame is closed");

  state.mosaicPreviewEnabled = true;
  await context.rebuildMosaicPreview();
  const errorWorker = state.mosaicWorker;
  const errorJob = await errorWorker.nextRender();
  errorJob.mask.close?.();
  errorWorker.onmessage({ data: { type: "error", code: "mosaic_preview_failed", sourceId: errorJob.sourceId, generation: errorJob.generation } });
  assert.equal(state.mosaicPreviewEnabled, false, "an exact worker error fails closed");

  const drawCountBeforeSoak = draws.length;
  state.mosaicPreviewEnabled = true;
  for (let index = 0; index < 100; index += 1) {
    context.releaseMosaicPreview();
    state.currentImage = { width: 3840, height: 2160, index }; state.currentId = `image-${index}`; state.imageGeneration = index + 2;
    await context.rebuildMosaicPreview();
    const activeWorker = state.mosaicWorker;
    const stroke = await activeWorker.nextRender();
    context.requestMosaicPreview(); context.requestMosaicPreview();
    activeWorker.frame(stroke);
    const undo = await activeWorker.nextRender();
    context.requestMosaicPreview();
    activeWorker.frame(undo);
    const newestStroke = await activeWorker.nextRender();
    activeWorker.frame(newestStroke);
    assert.equal(state.mosaicWorkerBusy, false, "each switch drains its final frame");
    assert.equal(state.mosaicPending, false, "each switch retains no pending frame");
    assert.equal(state.mosaicInFlightGeneration, 0, "each switch clears its active generation");
  }
  assert.equal(draws.length - drawCountBeforeSoak, 100, "each image switch paints only its newest stroke or undo frame");

  // Preview scheduling is deliberately tolerant of each transient editor
  // state: no selected image, an active render, a stale source decode, and a
  // source API failure all leave no frame or bitmap behind.
  context.releaseMosaicPreview(); state.mosaicPreviewEnabled = false; state.currentImage = null;
  await context.rebuildMosaicPreview();
  state.mosaicPreviewEnabled = true; state.currentImage = { width: 12, height: 9 }; state.currentId = "transient"; state.mosaicWorkerBusy = true;
  await context.rebuildMosaicPreview(); assert.equal(state.mosaicPending, true, "a render requested while busy is retained as one pending update");
  state.mosaicWorkerBusy = false; state.mosaicPending = false;
  let resolveSource; let sourceDecodes = 0;
  context.createImageBitmap = (image) => {
    if (image === state.currentImage) { sourceDecodes += 1; return new Promise((resolve) => { resolveSource = resolve; }); }
    return Promise.resolve(bitmap("mask"));
  };
  const sourceWorker = context.createMosaicWorker();
  const sourceFirst = context.ensureMosaicPreviewSource(sourceWorker); const sourceSecond = context.ensureMosaicPreviewSource(sourceWorker);
  const staleDecodedSource = bitmap("stale-source-decode"); state.currentImage = { width: 12, height: 9, newer: true };
  resolveSource(staleDecodedSource);
  assert.deepEqual(await Promise.all([sourceFirst, sourceSecond]), ["", ""], "a source decode that belongs to an old image is rejected");
  assert.equal(sourceDecodes, 1, "concurrent source requests share one bitmap decode"); assert.equal(staleDecodedSource.closed, true);
  sourceWorker.onmessage({ data: { type: "heartbeat" } });
  context.releaseMosaicPreview(); state.mosaicPreviewEnabled = true; state.currentImage = { width: 12, height: 9 }; state.currentId = "source-error";
  context.createImageBitmap = async () => { throw new Error("source unavailable"); };
  const failedWorker = context.createMosaicWorker();
  assert.equal(await context.ensureMosaicPreviewSource(failedWorker), "");
  assert.equal(state.mosaicPreviewEnabled, false, "a failed source bitmap disables only the preview");
  context.createImageBitmap = async (image) => bitmap(image === state.currentImage ? "source" : "mask");
  context.releaseMosaicPreview();
  assert.equal(state.mosaicWorker, null, "release leaves no active worker handle");
  assert.equal(counters.workerCanvases, 0, "all controlled worker canvas handles are reclaimed");
  assert.equal(counters.workers, counters.terminated, "all controlled workers are terminated");
  assert.equal(counters.closed, counters.bitmaps, "all source, mask, and output bitmaps are reclaimed");
  assert.ok(counters.peakWorkerCanvases <= 1, "at most one worker canvas bundle is live");
  assert.ok(counters.workers <= 105, "100 switches and transient states create a bounded number of workers");
  console.log("test_mosaic_preview_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
