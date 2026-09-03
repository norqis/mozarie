const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("../scripts/test-quiet.cjs");

async function runCommandCases() {
  const success = await runner.runCommand(process.execPath, ["-e", "console.log('ok')"]);
  assert.equal(success.status, 0, "a successful child keeps its zero exit status");
  assert.equal(success.output.trim(), "ok", "a successful child output is captured instead of streamed");

  await assert.rejects(runner.requiredCommand("fixture", process.execPath, ["-e", "console.error('useful failure'); process.exit(7)"], {}), (error) => {
    assert.match(error.message, /fixture failed \(exit 7\)/, "a failed child reports its exit status");
    assert.match(error.message, /useful failure/, "a failed child includes its diagnostic output");
    return true;
  });
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
  assert.doesNotMatch(tapDiagnostic, /deferred # TODO|skipped # SKIP/, "TAP TODO and SKIP entries are not reported as failures");
  assert.match(tapDiagnostic, /# fail 2/, "TAP failure counts are retained");

  const genericDiagnostic = runner.diagnostic(`${Array.from({ length: 80 }, (_, index) => `noise ${index}`).join("\n")}\nSyntaxError: generic-marker`);
  assert.match(genericDiagnostic, /SyntaxError: generic-marker/, "non-test failures use the useful generic tail fallback");
  const huge = runner.diagnostic(`FAIL: ${"x".repeat(1000)}\n${"line\n".repeat(20000)}`);
  assert.ok(huge.length <= 32 * 1024, "diagnostics have a bounded maximum size");
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

assert.deepEqual(runner.parseArguments(["frontend", "--artifacts", "coverage-artifacts"]).suite, "frontend", "the requested suite is parsed");
assert.deepEqual(runner.coverageRates('<coverage line-rate="1" branch-rate="1"/>'), { line: 100, branch: 100 }, "coverage rates are summarized as percentages");
assert.doesNotThrow(() => runner.verifyBackendCoverage('<coverage><class filename="server.py" line-rate="1" branch-rate="1"/><class filename="updater.py" line-rate="1" branch-rate="1"/><class filename="setup_gpu_check.py" line-rate="1" branch-rate="1"/></coverage>'), "all required files at 100% pass the coverage gate");
assert.throws(() => runner.verifyBackendCoverage('<coverage><class filename="server.py" line-rate="1" branch-rate="1"/></coverage>'), /missing updater.py/, "missing required coverage is rejected");
diagnosticCases();
const backendEnvironment = runner.backendEnvironment(path.join(os.tmpdir(), "mozarie-quiet-env"), "coverage-data");
assert.equal(backendEnvironment.PYTHONPYCACHEPREFIX, path.join(os.tmpdir(), "mozarie-quiet-env", "pycache"), "backend bytecode is directed to the temporary directory");
assert.equal(backendEnvironment.MOZARIE_RUNTIME, undefined, "ambient runtime selection cannot change test behavior");
const artifactFixture = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-quiet-artifact-check-"));
fs.mkdirSync(path.join(artifactFixture, "mozarie", "__pycache__"), { recursive: true });
fs.writeFileSync(path.join(artifactFixture, ".http-coverage.stderr.log"), "fixture");
assert.deepEqual(runner.workspaceArtifacts(artifactFixture), [".http-coverage.stderr.log", path.join("mozarie", "__pycache__")], "the runner detects only generated root logs and bytecode directories");
fs.rmSync(artifactFixture, { recursive: true, force: true });

(async () => {
  await runCommandCases();
  await runTemporaryDirectoryCases();
  await runArtifactCases();
  console.log("test_quiet_runner: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
