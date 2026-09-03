const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let response;
let transfer;
let contextFailure = 0;
let contextCalls = 0;
let sourceDraws = 0;
const self = { postMessage(value, transferList) { response = value; transfer = transferList; } };
class OffscreenCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.pixels = new Uint8ClampedArray(width * height * 4); }
  getContext() { contextCalls += 1; if (contextFailure === contextCalls) return null; return { clearRect: () => this.pixels.fill(0), drawImage: (image) => { if (image.sourceTag) sourceDraws += 1; this.pixels.set(image.pixels); }, getImageData: () => ({ data: this.pixels.slice() }), putImageData: (image) => this.pixels.set(image.data) }; }
  transferToImageBitmap() { return { width: this.width, height: this.height, pixels: this.pixels.slice(), close() { this.closed = true; } }; }
}
const context = vm.createContext({ self, Uint8ClampedArray, Math, OffscreenCanvas, ImageData: class { constructor(data) { this.data = data; } } });
const workerPath = path.join(__dirname, "..", "static", "js", "masked-mosaic-worker.js");
vm.runInContext(fs.readFileSync(workerPath, "utf8"), context, { filename: workerPath });

function render(source, mask, width, height, blockSize, generation) {
  self.onmessage({ data: {
    type: "source", sourceId: "test", source: { width, height, pixels: new Uint8ClampedArray(source), sourceTag: true, close() { this.closed = true; } },
    generation,
  } });
  self.onmessage({ data: {
    type: "render", sourceId: "test",
    mask: { width, height, pixels: new Uint8ClampedArray(mask.flatMap((alpha) => [0, 0, 0, alpha])), close() { this.closed = true; } },
    width,
    height,
    blockSize,
    generation,
  } });
  return new Uint8ClampedArray(response.output.pixels);
}

const averaged = render([
  100, 0, 0, 255,
  0, 100, 0, 255,
  9, 9, 9, 255,
], [255, 255, 0], 3, 1, 2, 7);
assert.deepEqual([...averaged], [50, 50, 0, 255, 50, 50, 0, 255, 9, 9, 9, 255], "masked pixels use their alpha-weighted block colour and unmasked pixels stay unchanged");
assert.equal(response.generation, 7, "the generation is returned unchanged");
assert.equal(transfer.length, 1, "the worker transfers one output buffer");
assert.equal(transfer[0], response.output, "the transferred bitmap is the response output");

const transparent = render([30, 40, 50, 0], [255], 1, 1, 1, 8);
assert.deepEqual([...transparent], [30, 40, 50, 0], "a fully transparent masked pixel does not invent an RGB colour");
assert.equal(response.generation, 8, "each render returns its own generation");

const untouched = render([1, 2, 3, 255, 4, 5, 6, 255], [0, 0], 2, 1, 2, 9);
assert.deepEqual([...untouched], [1, 2, 3, 255, 4, 5, 6, 255], "an unmasked block remains unchanged");

const sparse = render([
  10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255, 50, 0, 0, 255,
], [255, 0, 0, 0, 255], 5, 1, 2, 10);
assert.deepEqual([...sparse], [10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255, 50, 0, 0, 255], "sparse masks skip empty blocks inside their bounding rectangle");

// Drag previews transfer only an aligned patch.  The worker must use the
// source coordinates (not patch-local block coordinates) and leave unmasked
// pixels unchanged.
self.onmessage({ data: { type: "source", sourceId: "patch", source: { width: 4, height: 2, pixels: new Uint8ClampedArray([
  10, 0, 0, 255, 30, 0, 0, 255, 50, 0, 0, 255, 70, 0, 0, 255,
  20, 0, 0, 255, 40, 0, 0, 255, 60, 0, 0, 255, 80, 0, 0, 255,
]) }, generation: 10 } });
self.onmessage({ data: { type: "patch", sourceId: "patch", left: 2, top: 0, width: 2, height: 2, blockSize: 2, generation: 11,
  mask: { width: 2, height: 2, pixels: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]), close() { this.closed = true; } },
} });
assert.equal(response.patch, true, "a drag preview returns a patch instead of a full frame");
assert.deepEqual([...response.output.pixels], [55, 0, 0, 255, 70, 0, 0, 255, 55, 0, 0, 255, 80, 0, 0, 255], "patch mosaic averages only the aligned masked source block");

response = undefined;
const wrongPatchMask = { close() { this.closed = true; } };
self.onmessage({ data: { type: "patch", sourceId: "other-patch", left: 0, top: 0, width: 1, height: 1, blockSize: 1, generation: 12, mask: wrongPatchMask } });
assert.equal(response.type, "error", "a patch for another source reports the preview failure");
assert.equal(wrongPatchMask.closed, true, "a patch for another source closes its transferred mask");

const releasable = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]), close() { this.closed = true; } };
self.onmessage({ data: { type: "source", sourceId: "releasable", source: releasable, generation: 10 } });
self.onmessage({ data: { type: "release" } });
assert.equal(releasable.closed, true, "releasing a preview closes its retained source bitmap");

response = undefined;
const missingSourceMask = { close() { this.closed = true; } };
self.onmessage({ data: { type: "render", sourceId: "", mask: missingSourceMask, width: 1, height: 1, blockSize: 1, generation: 11 } });
assert.equal(response.type, "error", "a render without a retained source reports the preview failure");
assert.equal(missingSourceMask.closed, true, "a render without a retained source closes its transferred mask");

response = undefined;
const wrongSourceMask = { close() { this.closed = true; } };
self.onmessage({ data: { type: "render", sourceId: "different", mask: wrongSourceMask, width: 1, height: 1, blockSize: 1, generation: 12 } });
assert.equal(response.type, "error", "a frame for another source reports the preview failure");
assert.equal(wrongSourceMask.closed, true, "a frame for another source closes its transferred mask");

contextCalls = 0; contextFailure = 1;
const rejectedSource = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]), close() { this.closed = true; } };
self.onmessage({ data: { type: "source", sourceId: "bad-context", source: rejectedSource, generation: 13 } });
assert.equal(response.type, "error", "a source without a 2D context reports the preview failure");
assert.equal(rejectedSource.closed, true, "a rejected source bitmap is closed");
contextFailure = 0;

const badMask = { width: 1, height: 1, close() { this.closed = true; } };
self.onmessage({ data: { type: "source", sourceId: "render-failure", source: { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }, generation: 14 } });
self.onmessage({ data: { type: "render", sourceId: "render-failure", mask: badMask, width: 1, height: 1, blockSize: 1, generation: 14 } });
assert.equal(response.type, "error", "a malformed mask reports the preview failure");
assert.equal(badMask.closed, true, "a failed render still closes its transferred mask bitmap");

contextCalls = 0; contextFailure = 3;
self.onmessage({ data: { type: "source", sourceId: "missing-output-context", source: { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }, generation: 15 } });
self.onmessage({ data: { type: "render", sourceId: "missing-output-context", mask: { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255]) }, width: 1, height: 1, blockSize: 1, generation: 15 } });
assert.equal(response.type, "error", "a missing output context reports the preview failure");

contextCalls = 0; contextFailure = 0;
self.onmessage({ data: { type: "source", sourceId: "reused", source: { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }, generation: 16 } });
for (const generation of [16, 17]) self.onmessage({ data: { type: "render", sourceId: "reused", mask: { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255]) }, width: 1, height: 1, blockSize: 1, generation } });
assert.equal(response.generation, 17, "a retained source reuses its worker canvases for subsequent frames");

const drawsBeforeCacheCheck = sourceDraws;
self.onmessage({ data: { type: "source", sourceId: "cached-pixels", source: { width: 1, height: 1, pixels: new Uint8ClampedArray([9, 8, 7, 255]), sourceTag: true }, generation: 17 } });
for (const generation of [18, 19]) self.onmessage({ data: { type: "render", sourceId: "cached-pixels", mask: { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255]) }, width: 1, height: 1, blockSize: 1, generation } });
assert.equal(sourceDraws - drawsBeforeCacheCheck, 1, "the worker reads source pixels once when the source arrives, not once per preview frame");

const postMessage = self.postMessage;
let rejectFrame = true;
self.postMessage = (value, transferList) => {
  if (value.type === "frame" && rejectFrame) { rejectFrame = false; throw new Error("transfer rejected"); }
  response = value; transfer = transferList;
};
self.onmessage({ data: { type: "source", sourceId: "post-failure", source: { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }, generation: 18 } });
self.onmessage({ data: { type: "render", sourceId: "post-failure", mask: { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255]), close() { this.closed = true; } }, width: 1, height: 1, blockSize: 1, generation: 18 } });
assert.equal(response.type, "error", "a rejected frame transfer reports the preview failure");
self.postMessage = postMessage;

console.log("test_masked_mosaic_worker: passed");
