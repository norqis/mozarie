const assert = require("node:assert/strict");
const nodeTest = require("node:test");

const runner = require("../scripts/test-quiet.cjs");

function manifest(index, selected, total = 4, status = "passed", skipped = 0) {
  const discovered = [
    "tests.test_custom.CustomCase.test_alpha",
    "tests.test_custom.CustomCase.test_new_case",
    "tests.test_load.Generated.test_from_load_tests",
    "tests.test_load.Generated.test_second_case",
  ];
  return { schema: 1, shard: { index, total }, discovered, selected, testsRun: selected.length, skipped, status };
}

nodeTest("backend shard manifest accepts the exact deterministic four-way partition", () => {
  const discovered = manifest(0, []).discovered;
  const selected = Array.from({ length: 4 }, (_, index) => runner.selectedShardTestIds(discovered, index, 4));
  const result = runner.validateBackendShardManifests(selected.map((ids, index) => manifest(index, ids)));
  assert.deepEqual(result.discovered, discovered, "the aggregate retains every dynamically discovered ID");
  assert.deepEqual(selected.flat().sort(), discovered, "new test IDs are assigned exactly once by sorted position");
});

nodeTest("backend shard manifest rejects missing, mismatched, duplicate, skipped, and failed shards", () => {
  const discovered = manifest(0, []).discovered;
  const selected = Array.from({ length: 4 }, (_, index) => runner.selectedShardTestIds(discovered, index, 4));
  const shards = selected.map((ids, index) => manifest(index, ids));
  assert.throws(() => runner.validateBackendShardManifests(shards.slice(0, 3)), /incomplete/, "one missing shard fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([shards[0], manifest(1, selected[1], 2), ...shards.slice(2)]), /invalid shard metadata/, "a mismatched shard total fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([shards[0], manifest(1, selected[0]), ...shards.slice(2)]), /unexpected test set/, "a duplicate selection fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, selected[0], 4, "passed", 1), ...shards.slice(1)]), /skipped/, "a skipped test fails aggregation");
  assert.throws(() => runner.validateBackendShardManifests([manifest(0, selected[0], 4, "failed"), ...shards.slice(1)]), /did not pass/, "a failed shard cannot aggregate as success");
});
