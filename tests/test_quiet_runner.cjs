const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeTest = require("node:test");

const runner = require("../scripts/test-quiet.cjs");
const policy = require("../scripts/test-result-policy.cjs");

async function runCommandCases() {
  const success = await runner.runCommand(process.execPath, ["-e", "console.log('ok')"]);
  assert.equal(success.status, 0, "a successful child keeps its zero exit status");
  assert.equal(success.output.trim(), "ok", "a successful child output is captured instead of streamed");

  await assert.rejects(runner.requiredCommand("fixture", process.execPath, ["-e", "console.error('useful failure'); process.exit(7)"], {}), (error) => {
    assert.match(error.message, /fixture failed \(exit 7; elapsed /, "a failed child reports its exit status and elapsed time");
    assert.match(error.message, /useful failure/, "a failed child includes its diagnostic output");
    return true;
  });

  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-failure-"));
  try {
    await assert.rejects(runner.requiredCommand("failure evidence", process.execPath, ["-e", "console.error('raw expected: one\\nraw actual: two\\nraw operator: strictEqual\\nraw message: marker'); process.exit(3)"], { artifactDirectory: artifacts }), (error) => {
      assert.match(error.message, /raw output: .*failure-evidence\.failure\.log/, "a failed suite names its retained raw log");
      assert.equal(fs.readFileSync(error.rawLog, "utf8").includes("raw expected: one"), true, "the raw artifact keeps the complete child output");
      return true;
    });
    const evidence = JSON.parse(fs.readFileSync(path.join(artifacts, "failure-evidence.failure.json"), "utf8"));
    assert.deepEqual(Object.keys(evidence).sort(), ["args", "command", "elapsedMs", "rawLog", "status", "timedOut"], "failure metadata identifies the command, elapsed time, and raw log");
  } finally {
    fs.rmSync(artifacts, { recursive: true, force: true });
  }

  const timedOut = await runner.runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 40 });
  assert.equal(timedOut.timedOut, true, "a command exceeding its explicit suite timeout is terminated");
  assert.equal(timedOut.status, 124, "a terminated command has a stable timeout status");
}

function diagnosticCases() {
  const pythonFailures = Array.from({ length: 13 }, (_, index) => [
    "======================================================================",
    `FAIL: test_failure_${index} (tests.test_fixture.Case.test_failure_${index})`,
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    `  File \"tests/test_fixture.py\", line ${index + 1}, in test_failure_${index}`,
    `AssertionError: marker-${index}`,
  ].join("\r\n")).join("\r\n") + [
    "======================================================================",
    "\u001b[31mERROR: test_subtest (tests.test_fixture.Case.test_subtest) (case=import)\u001b[0m",
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    "  File \"tests/test_fixture.py\", line 99, in test_subtest",
    "RuntimeError: import-marker",
    "----------------------------------------------------------------------",
    "Ran 14 tests in 0.012s",
    "FAILED (failures=13, errors=1)",
    "unrelated child output after the unittest summary",
    "misleading-tail-marker",
  ].join("\r\n");
  const pythonDiagnostic = runner.diagnostic(pythonFailures);
  assert.match(pythonDiagnostic, /Ran 14 tests/, "Python diagnostics preserve the run summary");
  assert.match(pythonDiagnostic, /FAILED \(failures=13, errors=1\)/, "Python diagnostics preserve failure counts");
  for (let index = 0; index < 13; index += 1) {
    assert.match(pythonDiagnostic, new RegExp(`test_failure_${index}`), `Python failure ${index} is not lost beyond the old tail window`);
    assert.match(pythonDiagnostic, new RegExp(`marker-${index}`), `Python failure ${index} keeps its assertion summary`);
  }
  assert.match(pythonDiagnostic, /test_subtest/, "Python subtests are named");
  assert.match(pythonDiagnostic, /import-marker/, "Python errors retain their useful exception");
  assert.doesNotMatch(pythonDiagnostic, /misleading-tail-marker/, "output after the unittest summary cannot replace the failure detail");

  const tapFailures = [
    "TAP version 13",
    "    not ok 1 - nested failure",
    "      ---",
    "      error: nested-marker",
    "      stack: |-",
    "        Error: nested-stack-marker",
    "      ...",
    "not ok 2 - outer failure",
    "  ---",
    "  message: outer-marker",
    "  expected: expected-marker",
    "  actual: actual-marker",
    "  operator: strictEqual",
    "  ...",
    "not ok 3 - deferred # TODO planned later",
    "not ok 4 - skipped # SKIP unavailable",
    ...Array.from({ length: 70 }, (_, index) => `# filler ${index}`),
    "# tests 4",
    "# pass 2",
    "# fail 2",
  ].join("\n");
  const tapDiagnostic = runner.diagnostic(tapFailures);
  assert.match(tapDiagnostic, /nested failure/, "nested TAP failures are retained");
  assert.match(tapDiagnostic, /outer failure/, "later TAP failures are retained");
  assert.match(tapDiagnostic, /nested-marker/, "TAP error details are retained");
  assert.match(tapDiagnostic, /outer-marker/, "TAP message details are retained");
  assert.match(tapDiagnostic, /expected-marker/, "TAP expected values are retained");
  assert.match(tapDiagnostic, /actual-marker/, "TAP actual values are retained");
  assert.match(tapDiagnostic, /strictEqual/, "TAP assertion operators are retained");
  assert.doesNotMatch(tapDiagnostic, /deferred # TODO|skipped # SKIP/, "TAP TODO and SKIP entries are not reported as failures");
  assert.match(tapDiagnostic, /# fail 2/, "TAP failure counts are retained");

  const genericDiagnostic = runner.diagnostic(`${Array.from({ length: 80 }, (_, index) => `noise ${index}`).join("\n")}\nSyntaxError: generic-marker`);
  assert.match(genericDiagnostic, /SyntaxError: generic-marker/, "non-test failures use the useful generic tail fallback");
  const huge = runner.diagnostic(`FAIL: ${"x".repeat(1000)}\n${"line\n".repeat(20000)}`);
  assert.ok(huge.length <= 32 * 1024, "diagnostics have a bounded maximum size");
}

function deferredTestPolicyCases() {
  assert.equal(policy.unittestSkippedCount("Ran 3 tests in 0.001s\n\nOK\n"), 0, "a complete unittest suite has no skipped cases");
  assert.throws(() => policy.assertNoSkippedUnittestTests("Ran 3 tests in 0.001s\n\nOK (skipped=1)\n"), /skipped=1/, "a successful unittest suite with a skipped case fails CI");
}

async function runTemporaryDirectoryCases() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-runner-test-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-workspace-"));
  let removed = null;
  const summaries = await runner.runSuites({ suite: "all", artifacts: null }, {
    temporaryDirectory() { return temporaryRoot; },
    removeDirectory(directory) { removed = directory; fs.rmSync(directory, { recursive: true, force: true }); },
    async runBackend(directory) { fs.writeFileSync(path.join(directory, "backend.txt"), "ok"); return "backend: passed"; },
    async runFrontend(directory) { fs.writeFileSync(path.join(directory, "frontend.txt"), "ok"); return "frontend: passed"; },
    workspaceDirectory: workspaceRoot,
  });
  assert.deepEqual(summaries, ["backend: passed", "frontend: passed"], "successful suites return one compact line each");
  assert.equal(removed, temporaryRoot, "normal test output is cleaned up from the OS temporary directory");
  assert.equal(fs.existsSync(temporaryRoot), false, "normal test output leaves no files behind");
  assert.deepEqual(runner.workspaceArtifacts(workspaceRoot), [], "a successful runner leaves no coverage, fixed logs, or bytecode in the workspace");
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function runArtifactCases() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-runner-test-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-artifacts-"));
  try {
    await runner.runSuites({ suite: "backend", artifacts }, {
      temporaryDirectory() { return temporaryRoot; },
      async runBackend(directory, artifactRoot) {
        const output = runner.artifactDirectory(directory, artifactRoot, "backend");
        fs.writeFileSync(path.join(output, "coverage.xml"), "<coverage line-rate=\"1\" branch-rate=\"1\"/>");
        return "backend: passed";
      },
    });
    assert.equal(fs.existsSync(path.join(artifacts, "backend", "coverage.xml")), true, "an explicit artifact directory keeps coverage output");
    assert.equal(fs.existsSync(temporaryRoot), false, "the temporary staging directory is cleaned after an artifact run");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(artifacts, { recursive: true, force: true });
  }
}

async function runFrontendCases() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-frontend-"));
  const calls = [];
  try {
    const summary = await runner.runFrontend(temporaryRoot, null, {
      async requiredCommand(label, command, args, options) {
        calls.push({ label, command, args, options });
        if (label === "frontend coverage") {
          const report = path.join(options.env.MOZARIE_JS_COVERAGE_DIR, "report");
          fs.mkdirSync(report, { recursive: true });
          fs.writeFileSync(path.join(report, "coverage-final.json"), "{}");
          return "# tests 44";
        }
        if (label === "frontend performance") return "# tests 1";
        return "";
      },
    });
    assert.deepEqual(calls.map(({ label }) => label), ["frontend syntax", "frontend coverage", "frontend performance"], "performance runs once only after successful syntax and coverage checks");
    assert.equal(calls[2].args.includes("tests/test_gallery_performance_e2e.cjs"), true, "the 20k gallery scenario is the only quiet-runner performance target");
    assert.equal(calls[2].options.env.MOZARIE_JS_COVERAGE, undefined, "the performance run is not instrumented for JavaScript coverage");
    assert.match(summary, /44 coverage tests; 1 performance tests/, "the compact result distinguishes coverage and performance runs");
    assert.deepEqual(runner.performanceEnvironment({ MOZARIE_JS_COVERAGE: "1", MOZARIE_BROWSER_COVERAGE_FILE: "browser.json", NODE_V8_COVERAGE: "v8", KEEP: "value" }), { KEEP: "value" }, "the performance environment removes all coverage instrumentation");

    await assert.rejects(runner.runFrontend(temporaryRoot, null, {
      async requiredCommand(label, command, args, options) {
        if (label === "frontend coverage") {
          const report = path.join(options.env.MOZARIE_JS_COVERAGE_DIR, "report");
          fs.mkdirSync(report, { recursive: true });
          fs.writeFileSync(path.join(report, "coverage-final.json"), "{}");
          return "# tests 44";
        }
        if (label === "frontend performance") throw new Error("performance failure marker");
        return "";
      },
    }), /performance failure marker/, "a failed performance scenario fails the quiet frontend suite");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

assert.deepEqual(runner.parseArguments(["frontend", "--artifacts", "coverage-artifacts"]).suite, "frontend", "the requested suite is parsed");
assert.deepEqual(runner.parseArguments(["backend", "--shard-index", "1", "--shard-total", "2"]).shardIndex, 1, "a backend shard has a stable zero-based index");
assert.throws(() => runner.parseArguments(["backend", "--shard-index", "2", "--shard-total", "2"]), /usage/, "an out-of-range backend shard is rejected before execution");
assert.equal(runner.parseArguments(["backend-aggregate", "--shard-artifacts", "coverage-artifacts"]).suite, "backend-aggregate", "the aggregate runner requires downloaded shard artifacts");
assert.throws(() => runner.parseArguments(["backend-aggregate"]), /usage/, "aggregate cannot run without shard artifacts");
assert.deepEqual(runner.coverageRates('<coverage line-rate="1" branch-rate="1"/>'), { line: 100, branch: 100 }, "coverage rates are summarized as percentages");
assert.doesNotThrow(() => runner.verifyBackendCoverage('<coverage><class filename="server.py" line-rate="0" branch-rate="0"/><class filename="updater.py" line-rate="0" branch-rate="0"/><class filename="setup_gpu_check.py" line-rate="0" branch-rate="0"/></coverage>'), "required files are reported without a numeric coverage gate");
assert.throws(() => runner.verifyBackendCoverage('<coverage><class filename="server.py" line-rate="1" branch-rate="1"/></coverage>'), /missing required files: updater.py/, "missing required coverage is rejected");
diagnosticCases();
deferredTestPolicyCases();
const backendEnvironment = runner.backendEnvironment(path.join(os.tmpdir(), "mozarie-quiet-env"), "coverage-data");
assert.equal(backendEnvironment.PYTHONPYCACHEPREFIX, path.join(os.tmpdir(), "mozarie-quiet-env", "pycache"), "backend bytecode is directed to the temporary directory");
assert.equal(backendEnvironment.MOZARIE_RUNTIME, undefined, "ambient runtime selection cannot change test behavior");
const testPythonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-python-"));
const testPython = path.join(testPythonRoot, process.platform === "win32" ? "python.exe" : "python");
fs.writeFileSync(testPython, "fixture");
assert.equal(runner.testPythonExecutable({ MOZARIE_TEST_PYTHON: testPython }), path.resolve(testPython), "the test runner uses only its explicit dedicated interpreter");
assert.throws(() => runner.testPythonExecutable({ MOZARIE_TEST_PYTHON: path.join(__dirname, "..", ".venv", "Scripts", "python.exe") }), /must not point into the product .venv/, "the test runner rejects the product interpreter");
fs.rmSync(testPythonRoot, { recursive: true, force: true });
assert.equal(backendEnvironment.MOZARIE_TEST_PYTHON, undefined, "the explicit test interpreter selects the child executable without changing test state");
assert.equal(backendEnvironment.MOZARIE_TEST_APP_DIR, path.join(os.tmpdir(), "mozarie-quiet-env", "app"), "a timed-out backend suite leaves its app fixture under the runner-owned temporary root");
const artifactFixture = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-artifact-check-"));
fs.mkdirSync(path.join(artifactFixture, "mozarie", "__pycache__"), { recursive: true });
fs.writeFileSync(path.join(artifactFixture, ".http-coverage.stderr.log"), "fixture");
assert.deepEqual(runner.workspaceArtifacts(artifactFixture), [".http-coverage.stderr.log", path.join("mozarie", "__pycache__")], "the runner detects only generated root logs and bytecode directories");
fs.rmSync(artifactFixture, { recursive: true, force: true });

nodeTest("quiet runner contracts", async () => {
  await runCommandCases();
  await runTemporaryDirectoryCases();
  await runArtifactCases();
  await runFrontendCases();
});
