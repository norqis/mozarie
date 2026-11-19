'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { enclosedAreaSpans, alphaSpans } = require('../../static/js/area-fill-worker.js');
function ring(width, height, left = 1, top = 1, right = width - 2, bottom = height - 2) {
  const mask = new Uint8Array(width * height);
  for (let x = left; x <= right; x++) mask[top * width + x] = mask[bottom * width + x] = 1;
  for (let y = top; y <= bottom; y++) mask[y * width + left] = mask[y * width + right] = 1;
  return mask;
}
test('enclosed bucket fills only the connected hole with four-neighbor boundaries', () => {
  const mask = ring(12, 10); mask[3 * 12 + 4] = 1;
  for (let y = 2; y < 8; y++) mask[y * 12 + 6] = 1;
  const { spans, open } = enclosedAreaSpans(mask, 12, 10, 3, 4);
  assert.equal(open, false); assert.ok(spans.length);
  const filled = new Set();
  for (let i = 0; i < spans.length; i += 3) for (let x = spans[i + 1]; x < spans[i + 2]; x++) filled.add(`${x},${spans[i]}`);
  assert.equal(filled.size, 23); assert.equal(filled.has('4,3'), false); assert.equal(filled.has('7,4'), false);
  assert.deepEqual([...enclosedAreaSpans(ring(12, 10), 12, 10, 1, 1).spans], []);
});
test('open gaps and the exterior never produce a fill', () => {
  const mask = ring(10, 10); mask[1 * 10 + 4] = 0;
  assert.equal(enclosedAreaSpans(mask, 10, 10, 4, 4).open, true);
  assert.equal(enclosedAreaSpans(ring(10, 10), 10, 10, 0, 0).spans.length, 0);
  const diagonal = new Uint8Array([0,1,1,1,0,1,1,1,0]);
  const result = enclosedAreaSpans(diagonal, 3, 3, 1, 1);
  assert.deepEqual([...result.spans], [1,1,2], 'diagonal contact does not connect regions');
});
test('4K area output stays scanline-sized and ignores color channels', () => {
  const width = 4096, height = 2160;
  const result = enclosedAreaSpans(ring(width, height), width, height, 2000, 1000);
  assert.equal(result.open, false); assert.equal(result.spans.length, (height - 4) * 3);
  assert.ok(result.spans.byteLength < 30000, 'one compact triple per row, not one coordinate per pixel');
  const rgba = new Uint8ClampedArray(5 * 2 * 4);
  for (let i=0; i<rgba.length; i+=4) { rgba[i]=255; rgba[i+1]=123; rgba[i+2]=44; }
  rgba[3]=255; rgba[7]=127; rgba[(8*4)+3]=255;
  assert.deepEqual([...alphaSpans(rgba,5,2)], [0,0,2,1,3,4]);
});
