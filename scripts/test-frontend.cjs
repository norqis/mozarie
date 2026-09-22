"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { frontendPerformanceTestFiles, frontendTestArguments, frontendTestFiles } = require("./test-discovery.cjs");
const { readManifest, validateAutomatedExecution } = require("./verification-contracts.cjs");
const { frontendContracts } = require("./frontend-verification-contracts.cjs");

const root = path.resolve(__dirname, "..");
function run(files = frontendTestFiles(), environment = process.env) {
  if (!files.length) throw new Error("no frontend CJS tests were found");
  const result = childProcess.spawnSync(process.execPath, frontendTestArguments(files), { cwd: root, encoding: "utf8", env: environment });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exitCode = result.status || 0;
}

if (require.main === module) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-frontend-manifest-"));
  try {
    const coverageManifest = path.join(directory, "frontend-node-manifest.json");
    const performanceManifest = path.join(directory, "frontend-performance-manifest.json");
    run(frontendTestFiles(), { ...process.env, MOZARIE_NODE_TEST_MANIFEST: coverageManifest });
    if (!process.exitCode) run(frontendPerformanceTestFiles(), { ...process.env, MOZARIE_NODE_TEST_MANIFEST: performanceManifest });
    if (!process.exitCode) validateAutomatedExecution(frontendContracts(), {
      languages: ["node"],
      nodeManifests: [readManifest(coverageManifest), readManifest(performanceManifest)],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { frontendTestFiles, run };
