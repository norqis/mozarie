const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeTest = require("node:test");
const { browserCoverageMap } = require("../scripts/coverage-js.cjs");

const appPath = path.join(__dirname, "..", "static", "js", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const validEntry = {
  url: "http://127.0.0.1:8188/js/app.js",
  source,
  functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
};

nodeTest("browser coverage map contracts", async () => {
  await Promise.all([
    assert.rejects(browserCoverageMap([]), /browser coverage output is empty/),
    assert.rejects(browserCoverageMap([{ url: "http://127.0.0.1:8188/vendor.js", source: "", functions: [] }]), /browser coverage has no static JavaScript entries/),
    assert.rejects(browserCoverageMap([{ ...validEntry, source: "changed" }]), /browser coverage source changed/),
  ]);
  const map = await browserCoverageMap([validEntry]);
  assert.ok(map.files().includes(path.resolve(appPath)), "a matching static browser entry is converted into an Istanbul map");
});
