"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const runner = require("../scripts/test-quiet.cjs");

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

test("frontend performance manifest requires the one discovered performance file and passing results", () => {
  const file = "tests/test_gallery_performance_e2e.cjs";
  const valid = {
    manifest: { schema: 1, kind: "performance", discovered: [file], selected: [file], status: "passed" },
    nodeManifest: { schema: 1, tests: [{ id: `node:${file}::<file>`, status: "pass" }] },
  };
  assert.equal(runner.validateFrontendPerformanceRecord(valid, [file]), valid);
  assert.throws(() => runner.validateFrontendPerformanceRecord({ ...valid, manifest: { ...valid.manifest, status: "failed" } }, [file]), /did not pass/);
  assert.throws(() => runner.validateFrontendPerformanceRecord({ ...valid, manifest: { ...valid.manifest, selected: [] } }, [file]), /unexpected test set/);
});
