const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const contractPath = path.join(__dirname, "verification-contracts.editor.json");
const manualPath = path.join(repoRoot, "docs", "manual-verification", "editor.md");

function referencedTestExists(testId) {
  if (testId.startsWith("node:")) {
    const [relativePath, qualifiedName] = testId.slice("node:".length).split("::");
    assert.ok(relativePath && qualifiedName, `invalid Node test ID: ${testId}`);
    const sourcePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(sourcePath), `missing Node test file: ${relativePath}`);
    const source = fs.readFileSync(sourcePath, "utf8");
    for (const name of qualifiedName.split(" > ")) {
      assert.ok(source.includes(name), `Node test name is not declared in ${relativePath}: ${name}`);
    }
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

test("editor verification contract matches its residual manual checklist", () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(contract.version, 1);
  assert.equal(contract.domain, "editor");
  assert.deepEqual(contract.source, { path: "docs/manual-verification/editor.md", commit: "264f70d" });
  assert.equal(contract.baseline.rows, 129);
  assert.equal(contract.baseline.observations, 171, "baseline preserves the source observation count before deterministic splits");
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
    } else if (observation.status === "manual") {
      assert.equal(observation.testIds, undefined);
      assert.ok(observation.manual?.environment);
      assert.ok(observation.manual?.reason);
    } else {
      assert.equal(observation.status, "retired");
      assert.equal(observation.testIds, undefined);
      assert.equal(observation.manual, undefined);
      assert.ok(observation.retired?.reason);
    }
  }

  const markdownRows = fs.readFileSync(manualPath, "utf8").split(/\r?\n/)
    .filter((line) => /^\| ED-\d{3}\.\d+ \|/.test(line))
    .map((line) => {
      const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
      assert.equal(cells.length, 4, `manual row must have four cells: ${line}`);
      return { key: cells[0], observation: cells[1], environment: cells[2], reason: cells[3] };
    });
  const manualObservations = contract.observations.filter((observation) => observation.status === "manual")
    .map((observation) => ({
      key: observation.key,
      observation: observation.observation,
      environment: observation.manual.environment,
      reason: observation.manual.reason,
    }));
  assert.deepEqual(markdownRows, manualObservations, "manual checklist rows must match manual ledger observations one-to-one");
});
