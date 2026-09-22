const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeTest = require("node:test");
const { browserCoverageMap, mergeFrontendShardCoverage } = require("../scripts/coverage-js.cjs");

const appPath = path.join(__dirname, "..", "static", "js", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const validEntry = {
  url: "http://127.0.0.1:8188/js/app.js",
  source,
  functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
};

function fileCoverage(file, hits) {
  return {
    [file]: {
      path: file,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {}, branchMap: {}, s: { 0: hits }, f: {}, b: {},
    },
  };
}

nodeTest("browser coverage map contracts", async () => {
  await Promise.all([
    assert.rejects(browserCoverageMap([]), /browser coverage output is empty/),
    assert.rejects(browserCoverageMap([{ url: "http://127.0.0.1:8188/vendor.js", source: "", functions: [] }]), /browser coverage has no static JavaScript entries/),
    assert.rejects(browserCoverageMap([{ ...validEntry, source: "changed" }]), /browser coverage source changed/),
  ]);
  const map = await browserCoverageMap([validEntry]);
  assert.ok(map.files().includes(path.resolve(appPath)), "a matching static browser entry is converted into an Istanbul map");
});

nodeTest("frontend shard coverage merges every Node map and available browser V8 input", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-frontend-coverage-"));
  try {
    const shards = [path.join(temporaryRoot, "shard-0"), path.join(temporaryRoot, "shard-1")];
    const sharedFile = path.join(temporaryRoot, "shared.js");
    for (const [index, shard] of shards.entries()) {
      fs.mkdirSync(path.join(shard, "node"), { recursive: true });
      fs.writeFileSync(path.join(shard, "node", "coverage-final.json"), JSON.stringify(fileCoverage(sharedFile, index + 2)), "utf8");
      fs.writeFileSync(path.join(shard, "browser-v8.json"), JSON.stringify([validEntry]), "utf8");
    }
    let verified = false;
    let written = false;
    await mergeFrontendShardCoverage(shards, path.join(temporaryRoot, "report"), {
      async browserCoverageMap(entries) { return browserCoverageMap(entries); },
      verifyCoverage(map) {
        assert.equal(map.fileCoverageFor(sharedFile).toJSON().s[0], 5, "the same statement's counts are added across shards");
        assert.ok(map.files().includes(path.resolve(appPath)), "real browser V8 coverage is converted and merged");
        assert.ok(Object.keys(map.fileCoverageFor(path.resolve(appPath)).toJSON().b).length > 0, "browser branch coverage survives conversion");
        verified = true;
      },
      writeCoverageReports(map, directory) { assert.equal(typeof map.files, "function"); assert.match(directory, /report$/); written = true; },
    });
    assert.equal(verified, true, "the merged map is verified after all shard inputs");
    assert.equal(written, true, "the verified map is written once");

    fs.rmSync(path.join(shards[1], "browser-v8.json"));
    await assert.rejects(mergeFrontendShardCoverage(shards, path.join(temporaryRoot, "missing-browser"), {
      verifyCoverage() {}, writeCoverageReports() {},
    }), /browser coverage is missing/);

    fs.writeFileSync(path.join(shards[1], "browser-v8.json"), "{", "utf8");
    await assert.rejects(mergeFrontendShardCoverage(shards, path.join(temporaryRoot, "bad-report"), {
      verifyCoverage() {},
      writeCoverageReports() {},
    }), /browser coverage is missing or corrupt/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
