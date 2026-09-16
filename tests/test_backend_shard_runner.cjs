const assert = require("node:assert/strict");
const nodeTest = require("node:test");

const runner = require("../scripts/test-quiet.cjs");

function manifest(index, selected, status = "passed", skipped = 0) {
  const discovered = [
    "tests.test_custom.CustomCase.test_alpha",
    "tests.test_custom.CustomCase.test_new_case",
    "tests.test_load.Generated.test_from_load_tests",
  ];
  return { schema: 1, shard: { index, total: 2 }, discovered, selected, testsRun: selected.length, skipped, status };
}

nodeTest("backend shard manifest accepts the exact deterministic two-way partition", () => {
  const discovered = manifest(0, []).discovered;
  const first = runner.selectedShardTestIds(discovered, 0, 2);
  const second = runner.selectedShardTestIds(discovered, 1, 2);
  const result = runner.validateBackendShardManifests([manifest(0, first), manifest(1, second)], 2);
  assert.deepEqual(result.discovered, discovered, "the aggregate retains every dynamically discovered ID");
  assert.deepEqual([...first, ...second].sort(), discovered, "new test IDs are assigned exactly once by sorted position");
});

nodeTest("backend shard manifest rejects missing, duplicate, skipped, and failed shards", () => {
  const discovered = manifest(0, []).discovered;
  const first = runner.selectedShardTestIds(discovered, 0, 2);
  const second = runner.selectedShardTestIds(discovered, 1, 2);
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, first)], 2), /incomplete/, "a missing shard fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, first), manifest(1, first)], 2), /unexpected test set/, "a duplicate selection fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, first, "passed", 1), manifest(1, second)], 2), /skipped/, "a skipped test fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, first, "failed"), manifest(1, second)], 2), /did not pass/, "a failed shard cannot aggregate as success");
});