const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeTest = require("node:test");

const runner = require("../scripts/test-quiet.cjs");

const root = path.resolve(__dirname, "..");
const shardScript = path.join(root, "scripts", "unittest-shard.py");

function writeFixture(rootDirectory, includeFailure = false, includeSkip = false) {
  const tests = path.join(rootDirectory, "tests");
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, "__init__.py"), "");
  fs.writeFileSync(path.join(tests, "test_custom.py"), [
    "import unittest",
    "class CustomCase(unittest.TestCase):",
    "    def test_alpha(self): self.assertTrue(True)",
    "    def test_new_case(self): self.assertTrue(True)",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(tests, "test_load.py"), [
    "import unittest",
    "def load_tests(loader, tests, pattern):",
    "    class Generated(unittest.TestCase):",
    "        def test_from_load_tests(self): self.assertTrue(True)",
    "    return loader.loadTestsFromTestCase(Generated)",
    "",
  ].join("\n"));
  if (includeSkip) fs.writeFileSync(path.join(tests, "test_skip.py"), [
    "import unittest",
    "class SkipCase(unittest.TestCase):",
    "    @unittest.skip('fixture skip')",
    "    def test_skip(self): pass",
    "",
  ].join("\n"));
  if (includeFailure) fs.writeFileSync(path.join(tests, "test_failure.py"), [
    "import unittest",
    "class FailureCase(unittest.TestCase):",
    "    def test_failure(self): self.fail('fixture failure')",
    "",
  ].join("\n"));
}

function runShard(rootDirectory, index, total, manifest) {
  return childProcess.spawnSync(runner.testPythonExecutable(), [shardScript,
    "--shard-index", String(index),
    "--shard-total", String(total),
    "--manifest", manifest,
    "--start-directory", path.join(rootDirectory, "tests"),
    "--top-level-directory", rootDirectory,
  ], { cwd: root, encoding: "utf8", windowsHide: true });
}

nodeTest("backend shard discovery preserves custom loader tests and partitions new tests once", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-backend-shard-"));
  try {
    writeFixture(fixture);
    const manifests = [0, 1].map((index) => path.join(fixture, `manifest-${index}.json`));
    const results = manifests.map((manifest, index) => runShard(fixture, index, 2, manifest));
    for (const result of results) assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = manifests.map((manifest) => JSON.parse(fs.readFileSync(manifest, "utf8")));
    const validation = runner.validateBackendShardManifests(parsed, 2);
    assert.equal(validation.discovered.some((id) => id.endsWith("CustomCase.test_new_case")), true, "a newly discovered test joins one shard without editing a list");
    assert.equal(validation.discovered.some((id) => id.includes("Generated.test_from_load_tests")), true, "load_tests-provided cases remain in discovery");
    assert.equal(validation.discovered.some((id) => id.endsWith("CustomCase.test_alpha")), true, "ordinary unittest classes remain in discovery");
    assert.equal(parsed.reduce((count, manifest) => count + manifest.testsRun, 0), validation.discovered.length, "each discovered test runs in exactly one shard");
    assert.equal(parsed.reduce((count, manifest) => count + manifest.skipped, 0), 0, "a complete fixture has no skipped cases");

    assert.throws(() => runner.validateBackendShardManifests([parsed[0]], 2), /incomplete/, "a missing shard manifest fails aggregation");
    const duplicate = structuredClone(parsed);
    duplicate[1].selected = [...duplicate[0].selected];
    assert.throws(() => runner.validateBackendShardManifests(duplicate, 2), /unexpected test set/, "a duplicate or wrong selection fails aggregation");
    const skipped = structuredClone(parsed);
    skipped[0].skipped = 1;
    assert.throws(() => runner.validateBackendShardManifests(skipped, 2), /skipped/, "a skipped test fails aggregation");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

nodeTest("backend shard records skipped tests for aggregate rejection", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-backend-shard-skip-"));
  try {
    writeFixture(fixture, false, true);
    const manifestPath = path.join(fixture, "skip-manifest.json");
    const result = runShard(fixture, 0, 1, manifestPath);
    assert.equal(result.status, 0, "unittest completes a skipped fixture and records its result");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.skipped, 1, "the manifest retains the skipped count for CI policy");
    assert.throws(() => runner.validateBackendShardManifests([manifest], 1), /skipped/, "aggregate rejects a skipped backend shard");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

nodeTest("backend shard writes a failed manifest before propagating failure", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-backend-shard-failure-"));
  try {
    writeFixture(fixture, true);
    const manifestPath = path.join(fixture, "failure-manifest.json");
    const result = runShard(fixture, 0, 1, manifestPath);
    assert.notEqual(result.status, 0, "a failing unittest fails its shard process");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.status, "failed", "failure still leaves one manifest for artifact diagnosis");
    assert.equal(manifest.testsRun, manifest.selected.length, "the failure manifest counts every selected test");
    assert.throws(() => runner.validateBackendShardManifests([manifest], 1), /skipped|did not pass/, "a failed or skipped shard cannot aggregate as success");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});