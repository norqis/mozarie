const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { frontendPerformanceTestFiles, frontendTestArguments, frontendTestFiles } = require("../scripts/test-discovery.cjs");
const frontend = require("../scripts/test-frontend.cjs");
const coverage = require("../scripts/coverage-js.cjs");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-discovery-"));
try {
  fs.mkdirSync(path.join(temporaryRoot, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, "test_root.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "test_second.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "deeper", "test_first.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "helper.cjs"), "");
  assert.deepEqual(frontendTestFiles(temporaryRoot), [
    "tests/nested/deeper/test_first.cjs",
    "tests/nested/test_second.cjs",
    "tests/test_root.cjs",
  ], "recursive discovery keeps every nested test in deterministic repository-relative order");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

assert.strictEqual(frontend.frontendTestFiles, frontendTestFiles, "the ordinary frontend runner uses the shared discovery policy");
assert.deepEqual(coverage.testFiles, frontend.frontendTestFiles(), "coverage runs exactly the frontend runner's deterministic test list");
assert.deepEqual(frontendPerformanceTestFiles(), ["tests/test_gallery_performance_e2e.cjs"], "the 20k gallery test is discovered as the single non-coverage performance suite");
assert.equal(frontendTestFiles().includes("tests/test_gallery_performance_e2e.cjs"), false, "coverage discovery excludes the uninstrumented performance suite");
assert.deepEqual(frontendTestArguments(["tests/nested/test_fixture.cjs"]), ["--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", "--test-concurrency=1", "tests/nested/test_fixture.cjs"], "ordinary and coverage execution share the strict reporter, stable browser concurrency, and nested paths");
for (const file of [...frontendTestFiles(), ...frontendPerformanceTestFiles()]) {
  const contents = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.equal(/^\s*\(async\s*\(\)\s*=>/m.test(contents), false, `${file} must register asynchronous work with node:test instead of a top-level async IIFE`);
  assert.equal(/^\s*Promise\.(?:resolve|all|race|any)\s*\(/m.test(contents), false, `${file} must register top-level Promise chains with node:test`);
}
console.log("test_test_discovery: passed");
