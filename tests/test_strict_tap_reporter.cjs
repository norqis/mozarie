const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-strict-tap-"));

function runFixture(source) {
  const fixture = path.join(temporaryRoot, "test_fixture.cjs");
  fs.writeFileSync(fixture, source);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.MOZARIE_NODE_TEST_MANIFEST;
  return childProcess.spawnSync(process.execPath, ["--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", fixture], { cwd: root, encoding: "utf8", env: environment });
}

try {
  const passing = runFixture('const test = require("node:test"); test("pass", () => {});');
  assert.equal(passing.status, 0, "a complete suite remains successful");

  const diagnostic = runFixture('const test = require("node:test"); test("diagnostic", () => console.log("not ok 99 - diagnostic # SKIP text only"));');
  assert.equal(diagnostic.status, 0, "diagnostic text that resembles TAP does not become a skipped test");

  const skipped = runFixture('const test = require("node:test"); test("skip", { skip: "fixture" }, () => {});');
  assert.notEqual(skipped.status, 0, "a skipped test fails the otherwise-successful suite");
  assert.match(`${skipped.stdout}${skipped.stderr}`, /deferred tests are not allowed: skip \(skip: fixture\)/, "the failure names the skipped structured result");

  const todo = runFixture('const test = require("node:test"); test("todo", { todo: "fixture" }, () => {});');
  assert.notEqual(todo.status, 0, "a TODO test fails the otherwise-successful suite");
  assert.match(`${todo.stdout}${todo.stderr}`, /deferred tests are not allowed: todo \(todo: fixture\)/, "the failure names the TODO structured result");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("test_strict_tap_reporter: passed");
