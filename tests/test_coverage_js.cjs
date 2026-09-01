const assert = require("node:assert/strict");
const { normalizeV8FunctionRanges } = require("../scripts/coverage-js.cjs");

const source = "body \nreturn";
const ranges = [
  { startOffset: 0, endOffset: source.length, count: 0 },
  { startOffset: 4, endOffset: 6, count: 0 },
  { startOffset: 6, endOffset: source.length, count: 0 },
  { startOffset: 4, endOffset: 6, count: 1 },
];
const normalized = normalizeV8FunctionRanges([{ functionName: "fixture", ranges }], source)[0].ranges;

assert.deepEqual(normalized.map((range) => [range.startOffset, range.endOffset, range.count]), [
  [0, source.length, 0],
  [6, source.length, 0],
], "only whitespace-only subranges are removed");

const whitespaceFunction = normalizeV8FunctionRanges([{ functionName: "fixture", ranges: [{ startOffset: 0, endOffset: 1, count: 0 }] }], " ");
assert.equal(whitespaceFunction[0].ranges.length, 1, "the full function range is never removed");

console.log("test_coverage_js: passed");
