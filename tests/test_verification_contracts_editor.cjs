const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { frontendPerformanceTestFiles, frontendTestFiles } = require("../scripts/test-discovery.cjs");

const repoRoot = path.join(__dirname, "..");
const contractPath = path.join(__dirname, "verification-contracts.editor.json");
const manualPath = path.join(repoRoot, "docs", "manual-verification", "editor.md");
const discoveredNodeFiles = new Set([...frontendTestFiles(), ...frontendPerformanceTestFiles()]);

function referencedTestExists(testId) {
  if (testId.startsWith("node:")) {
    const [relativePath, qualifiedName] = testId.slice("node:".length).split("::");
    assert.ok(relativePath && qualifiedName, `invalid Node test ID: ${testId}`);
    assert.ok(discoveredNodeFiles.has(relativePath), `Node test file is not in normal discovery: ${relativePath}`);
    // Generated subtest names and legacy <file> IDs are execution results.
    // The shared manifest validator requires their exact IDs to run and pass.
    return;
  }
  if (testId.startsWith("python:")) {
    const qualifiedName = testId.slice("python:".length);
    const parts = qualifiedName.split(".");
    assert.ok(parts.length >= 4, `invalid Python test ID: ${testId}`);
    const methodName = parts.at(-1);
    const className = parts.at(-2);
    const relativePath = `${parts.slice(0, -2).join("/")}.py`;
    const sourcePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(sourcePath), `missing Python test file: ${relativePath}`);
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.ok(source.includes(`class ${className}`), `Python test class is not declared: ${className}`);
    assert.ok(source.includes(`def ${methodName}(`), `Python test method is not declared: ${methodName}`);
    return;
  }
  assert.fail(`unsupported test ID: ${testId}`);
}

test("editor verification contract preserves its baseline with no manual checklist", () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(contract.version, 1);
  assert.equal(contract.domain, "editor");
  assert.deepEqual(contract.source, { path: "docs/manual-verification/editor.md", commit: "264f70d" });
  assert.equal(contract.baseline.rows, 129);
  assert.equal(contract.baseline.observations, contract.observations.length, "baseline records the complete split observation count");
  assert.equal(contract.observations.length, 174, "the ledger contains every split or retired observation");

  const keys = new Set();
  for (const observation of contract.observations) {
    assert.match(observation.key, /^ED-\d{3}\.\d+$/);
    assert.ok(!keys.has(observation.key), `duplicate observation key: ${observation.key}`);
    keys.add(observation.key);
    assert.ok(Array.isArray(observation.sourceIds) && observation.sourceIds.length > 0);
    assert.ok(observation.sourceIds.every((sourceId) => /^ED-\d{3}$/.test(sourceId)));
    assert.ok(typeof observation.observation === "string" && observation.observation.length > 0);
    if (observation.status === "automated") {
      assert.ok(Array.isArray(observation.testIds) && observation.testIds.length > 0, `${observation.key} has no executable evidence`);
      assert.equal(observation.manual, undefined);
      observation.testIds.forEach(referencedTestExists);
    } else {
      assert.equal(observation.status, "retired");
      assert.equal(observation.testIds, undefined);
      assert.equal(observation.manual, undefined);
      assert.ok(observation.retirementReason?.trim());
    }
  }

  assert.equal(fs.existsSync(manualPath), false, "the completed checklist is deleted");
});
