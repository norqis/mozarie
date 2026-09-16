const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
let response;
let transfer;
const self = { postMessage(value, transferList) { response = value; transfer = transferList; } };
const context = vm.createContext({ self, Uint8ClampedArray, Uint8Array, Int32Array, Math });
const workerPath = path.join(__dirname, "..", "static", "js", "flood-fill-worker.js");
vm.runInContext(fs.readFileSync(workerPath, "utf8"), context, { filename: workerPath });
const pixels = new Uint8ClampedArray([
  10, 10, 10, 255, 11, 11, 11, 255, 200, 200, 200, 255,
  11, 11, 11, 255, 10, 10, 10, 255, 200, 200, 200, 255,
  200, 200, 200, 255, 200, 200, 200, 255, 10, 10, 10, 255,
]);
self.onmessage({ data: { pixels: pixels.buffer, width: 3, height: 3, x: 0, y: 0, tolerance: 2 } });
assert.deepEqual([...response.spans], [0, 0, 2, 1, 0, 2], "four-connected matching pixels only");
assert.equal(transfer.length, 1, "spans have one transfer buffer");
assert.equal(transfer[0], response.spans.buffer, "spans remain transferred rather than copied");

// Start in the middle of a horizontal run so both left and right expansion
// paths are exercised before they hit their image boundaries.
const horizontal = new Uint8ClampedArray([
  20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255,
]);
self.onmessage({ data: { pixels: horizontal.buffer, width: 3, height: 1, x: 1, y: 0, tolerance: 0 } });
assert.deepEqual([...response.spans], [0, 0, 3], "a centered seed expands in both directions across its row");

const transparentGap = new Uint8ClampedArray([
  50, 60, 70, 255, 50, 60, 70, 1, 50, 60, 70, 0, 50, 60, 70, 255, 50, 60, 70, 255,
]);
self.onmessage({ data: { pixels: transparentGap.buffer, width: 5, height: 1, x: 0, y: 0, tolerance: 0 } });
assert.deepEqual([...response.spans], [0, 0, 2], "transparent pixels do not join visible pixels with the same retained RGB values");

const transparentSeed = new Uint8ClampedArray([50, 60, 70, 0]);
self.onmessage({ data: { pixels: transparentSeed.buffer, width: 1, height: 1, x: 0, y: 0, tolerance: 0 } });
assert.deepEqual([...response.spans], [], "a transparent seed does not create a fill span");
console.log("test_flood_fill_worker: passed");
