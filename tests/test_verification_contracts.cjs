"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const {
  loadContracts,
  manualRows,
  readManifest,
  validateAutomatedExecution,
  validateContract,
} = require("../scripts/verification-contracts.cjs");

const root = path.resolve(__dirname, "..");
const baseline = [
  "# Fixture",
  "",
  "| ID | 手順 | 期待値 |",
  "| --- | --- | --- |",
  "| VC-001 | 自動操作 | 自動の結果になる |",
  "| VC-002 | 実機操作 | 実機の結果になる |",
  "",
].join("\n");
const current = [
  "# Fixture",
  "",
  "| ID | 手順 | 期待値 |",
  "| --- | --- | --- |",
  "| VC-002.1 | 実機操作 | 実機の結果になる |",
  "",
].join("\n");
const nodeId = "node:tests/test_fixture.cjs::outer suite > does the work";
const pythonId = "python:tests.test_fixture.FixtureTests.test_does_the_work";

function fixture(overrides = {}) {
  return {
    version: 1,
    domain: "fixture",
    source: { path: "docs/manual-verification/fixture.md", commit: "264f70d" },
    baseline: { rows: 2, observations: 2 },
    observations: [
      { key: "VC-001.1", sourceIds: ["VC-001"], observation: "自動の結果になる", status: "automated", testIds: [nodeId, pythonId] },
      {
        key: "VC-002.1",
        sourceIds: ["VC-002"],
        observation: "実機の結果になる",
        status: "manual",
        manual: {
          environment: "Windows 11のExplorer形式ファイル選択画面",
          reason: "OSが所有する選択画面の表示とキーボードフォーカスを観測するため",
        },
      },
    ],
    ...overrides,
  };
}

function validationOptions() {
  return {
    sourceAtCommit: () => baseline,
    currentSource: () => current,
  };
}

describe("verification contract schema and manual ledger", () => {
  test("repository verification contracts preserve the baseline without remaining manual checks", () => {
    const contracts = loadContracts();
    assert.ok(contracts.length > 0);
    for (const contract of contracts) {
      assert.equal(contract.observations.some((item) => item.status === "manual"), false, contract.domain);
      assert.equal(fs.existsSync(path.join(root, contract.source.path)), false, contract.source.path);
    }
    assert.equal(fs.existsSync(path.join(root, "docs/manual-verification.md")), false);
  });

  test("deleted source documents retain baseline coverage and require individual retirement reasons", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-retired-contract-"));
    try {
      const contract = fixture();
      const retired = contract.observations[1];
      retired.status = "retired";
      retired.retirementReason = "OS所有の許可画面自体は自動回帰検証の対象外とする。";
      delete retired.manual;
      const options = { repositoryRoot: directory, sourceAtCommit: () => baseline };
      assert.doesNotThrow(() => validateContract(contract, options));
      assert.throws(() => validateContract(fixture(), options), /missing manual observations/);
      delete retired.retirementReason;
      assert.throws(() => validateContract(contract, options), /retirementReason must be a non-empty string/);
      retired.retirementReason = "OS所有の許可画面自体は対象外とする。";
      contract.observations.pop();
      contract.baseline.observations = 1;
      assert.throws(() => validateContract(contract, options), /source ID coverage differs from the baseline/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts a complete baseline and keeps only concrete manual observations in the source document", () => {
    assert.equal(validateContract(fixture(), validationOptions()).domain, "fixture");
  });

  test("rejects abstract manual reasons and automated rows left in the manual document", () => {
    const abstract = fixture();
    abstract.observations[1].manual.reason = "環境依存";
    assert.throws(() => validateContract(abstract, validationOptions()), /must name the concrete external environment/);
    assert.throws(() => validateContract(fixture(), { ...validationOptions(), currentSource: () => baseline }), /must use observation keys, not source IDs/);
  });

  test("loads domain files and rejects baseline omissions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-contract-fixture-"));
    try {
      const file = path.join(directory, "verification-contracts.fixture.json");
      fs.writeFileSync(file, `${JSON.stringify(fixture(), null, 2)}\n`, "utf8");
      assert.equal(loadContracts({ files: [file], ...validationOptions() }).length, 1);
      const incomplete = fixture({ observations: [fixture().observations[0]], baseline: { rows: 2, observations: 1 } });
      fs.writeFileSync(file, `${JSON.stringify(incomplete, null, 2)}\n`, "utf8");
      assert.throws(() => loadContracts({ files: [file], ...validationOptions() }), /source ID coverage differs from the baseline/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("splits compound IDs, accepts suffix IDs, and permits one source row to be split into observations", () => {
    const parsed = manualRows("| DI-009a・WS-141 | 操作 | 結果 |\n", "compound fixture");
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual([...parsed.byId.keys()], ["DI-009a", "WS-141"]);

    const split = fixture({
      baseline: { rows: 2, observations: 3 },
      observations: [
        fixture().observations[0],
        {
          key: "VC-001.2",
          sourceIds: ["VC-001"],
          observation: "実機で残す観測",
          status: "manual",
          manual: {
            environment: "Windows 11のOS所有フォーカス表示",
            reason: "実ウィンドウ間を移動したときのフォーカス描画を観測するため",
          },
        },
        fixture().observations[1],
      ],
    });
    const splitCurrent = current.replace("| VC-002.1", "| VC-001.2 | 実機操作 | 実機で残す観測 |\n| VC-002.1");
    assert.doesNotThrow(() => validateContract(split, { ...validationOptions(), currentSource: () => splitCurrent }));
  });
});

describe("verification contract execution evidence", () => {
  test("requires every referenced Node and Python test to be collected, executed, and passed", () => {
    const contracts = [fixture()];
    const nodeManifests = [{ schema: 1, tests: [{ id: nodeId, status: "pass" }] }];
    const pythonManifests = [{
      schema: 1,
      discovered: [pythonId.slice("python:".length)],
      selected: [pythonId.slice("python:".length)],
      testsRun: 1,
      skipped: 0,
      status: "passed",
    }];
    assert.doesNotThrow(() => validateAutomatedExecution(contracts, { nodeManifests, pythonManifests }));
    assert.throws(() => validateAutomatedExecution(contracts, { nodeManifests: [], pythonManifests }), /uncollected or renamed test/);
    assert.throws(() => validateAutomatedExecution(contracts, {
      nodeManifests: [{ schema: 1, tests: [{ id: nodeId, status: "skip" }] }],
      pythonManifests,
    }), /status skip/);
    assert.throws(() => validateAutomatedExecution(contracts, {
      nodeManifests: [{ schema: 1, tests: [{ id: nodeId, status: "todo" }] }],
      pythonManifests,
    }), /status todo/);
  });

  test("the strict reporter records repository path, parent suite, test name, and pass status", () => {
    const directory = fs.mkdtempSync(path.join(__dirname, ".verification-contract-reporter-"));
    const fixturePath = path.join(directory, "test_fixture.cjs");
    const manifestPath = path.join(directory, "manifest.json");
    try {
      fs.writeFileSync(fixturePath, [
        'const { describe, test } = require("node:test");',
        'describe("outer suite", () => { test("does the work", () => {}); });',
      ].join("\n"), "utf8");
      const environment = { ...process.env, MOZARIE_NODE_TEST_MANIFEST: manifestPath };
      delete environment.NODE_TEST_CONTEXT;
      const result = childProcess.spawnSync(process.execPath, [
        "--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", fixturePath,
      ], {
        cwd: root,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const manifest = readManifest(manifestPath);
      const child = manifest.tests.find((entry) => entry.id.endsWith("::outer suite > does the work"));
      assert.equal(child?.status, "pass");
      assert.match(child.id, /^node:tests\/\.verification-contract-reporter-/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
