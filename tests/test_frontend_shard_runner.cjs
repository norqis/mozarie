"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const runner = require("../scripts/test-quiet.cjs");
const { frontendPerformanceTestFiles, frontendTestFiles, selectedFrontendTestFiles } = require("../scripts/test-discovery.cjs");
const { frontendContracts } = require("../scripts/frontend-verification-contracts.cjs");

const discovered = ["tests/a.cjs", "tests/b.cjs", "tests/c.cjs", "tests/d.cjs"];

function record(index, options = {}) {
  const selected = options.selected || discovered.filter((_, position) => position % 2 === index);
  return {
    directory: `shard-${index}`,
    manifest: {
      schema: 1,
      shard: { index, total: 2 },
      discovered: options.discovered || discovered,
      selected,
      status: options.status || "passed",
    },
    nodeManifest: {
      schema: 1,
      tests: selected.map((file) => ({ id: `node:${file}::<file>`, status: "pass" })),
    },
  };
}

test("frontend shard manifests accept the exact alternating partition", () => {
  const records = runner.validateFrontendShardManifests([record(1), record(0)], 2, discovered);
  assert.deepEqual(records.map((entry) => entry.manifest.shard.index), [0, 1]);
  assert.deepEqual(records.flatMap((entry) => entry.manifest.selected).sort(), discovered);
});

test("frontend shard manifests reject missing, duplicate, failed, skipped, and mismatched shards", () => {
  assert.throws(() => runner.validateFrontendShardManifests([record(0)], 2, discovered), /incomplete/);
  assert.throws(() => runner.validateFrontendShardManifests([record(0), record(0)], 2, discovered), /duplicate shard/);
  assert.throws(() => runner.validateFrontendShardManifests([record(0, { status: "failed" }), record(1)], 2, discovered), /did not pass/);

  const skipped = record(0);
  skipped.nodeManifest.tests[0].status = "skip";
  assert.throws(() => runner.validateFrontendShardManifests([skipped, record(1)], 2, discovered), /has skip test/);

  assert.throws(() => runner.validateFrontendShardManifests([
    record(0, { discovered: [...discovered, "tests/new.cjs"] }), record(1),
  ], 2, discovered), /mismatched discovery/);
  assert.throws(() => runner.validateFrontendShardManifests([
    record(0, { selected: ["tests/b.cjs", "tests/c.cjs"] }), record(1),
  ], 2, discovered), /unexpected test set/);
});

test("frontend performance manifest requires every discovered performance file and passing results", () => {
  const files = frontendPerformanceTestFiles();
  const valid = {
    manifest: { schema: 1, kind: "performance", discovered: files, selected: files, status: "passed" },
    nodeManifest: { schema: 1, tests: files.map((file) => ({ id: `node:${file}::<file>`, status: "pass" })) },
  };
  assert.equal(runner.validateFrontendPerformanceRecord(valid, files), valid);
  assert.throws(() => runner.validateFrontendPerformanceRecord({ ...valid, manifest: { ...valid.manifest, status: "failed" } }, files), /did not pass/);
  assert.throws(() => runner.validateFrontendPerformanceRecord({ ...valid, manifest: { ...valid.manifest, selected: [] } }, files), /unexpected test set/);
  assert.throws(() => runner.validateFrontendPerformanceRecord({ ...valid, nodeManifest: { schema: 1, tests: valid.nodeManifest.tests.slice(0, 1) } }, files), /did not execute selected file/);
});

test("frontend aggregate enforces the control-evidence contract", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-frontend-contract-"));
  try {
    const shardArtifacts = path.join(temporaryRoot, "shards");
    const performanceArtifacts = path.join(temporaryRoot, "performance");
    const discoveredFiles = frontendTestFiles();
    const performanceFiles = frontendPerformanceTestFiles();
    const contracts = frontendContracts();
    assert.equal(contracts.filter((contract) => contract.domain === "ui-control-evidence").length, 1);
    const missingObservation = contracts[0].observations[0];
    const missingId = missingObservation.testIds[0];
    const requiredIds = new Set(contracts.flatMap((contract) => contract.observations
      .filter((observation) => observation.status === "automated")
      .flatMap((observation) => observation.testIds)));
    requiredIds.delete(missingId);

    for (let index = 0; index < 2; index += 1) {
      const selected = selectedFrontendTestFiles(discoveredFiles, index, 2);
      const directory = path.join(shardArtifacts, `frontend-shard-${index}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "frontend-shard-manifest.json"), JSON.stringify({
        schema: 1, shard: { index, total: 2 }, discovered: discoveredFiles, selected, status: "passed",
      }));
      const tests = [...requiredIds].filter((id) => selected.includes(runner.frontendResultFile(id)))
        .map((id) => ({ id, status: "pass" }));
      for (const file of selected) {
        if (!tests.some((entry) => runner.frontendResultFile(entry.id) === file)) tests.push({ id: `node:${file}::<file>`, status: "pass" });
      }
      fs.writeFileSync(path.join(directory, "frontend-node-manifest.json"), JSON.stringify({ schema: 1, tests }));
    }

    fs.mkdirSync(performanceArtifacts, { recursive: true });
    fs.writeFileSync(path.join(performanceArtifacts, "frontend-performance-manifest.json"), JSON.stringify({
      schema: 1, kind: "performance", discovered: performanceFiles, selected: performanceFiles, status: "passed",
    }));
    const performanceTests = [...requiredIds].filter((id) => performanceFiles.includes(runner.frontendResultFile(id)))
      .map((id) => ({ id, status: "pass" }));
    for (const file of performanceFiles) {
      if (!performanceTests.some((entry) => runner.frontendResultFile(entry.id) === file)) performanceTests.push({ id: `node:${file}::<file>`, status: "pass" });
    }
    fs.writeFileSync(path.join(performanceArtifacts, "frontend-node-manifest.json"), JSON.stringify({ schema: 1, tests: performanceTests }));

    await assert.rejects(runner.aggregateFrontendShards(temporaryRoot, null, shardArtifacts, performanceArtifacts, 2, {
      async mergeCoverage(_directories, reportDirectory) {
        fs.mkdirSync(reportDirectory, { recursive: true });
        fs.writeFileSync(path.join(reportDirectory, "coverage-final.json"), "{}");
      },
    }), new RegExp(`${missingObservation.key} references an uncollected or renamed test`));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
