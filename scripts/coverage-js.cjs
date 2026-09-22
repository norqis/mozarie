"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const v8ToIstanbul = require("v8-to-istanbul");
const { createCoverageMap } = require("istanbul-lib-coverage");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");
const { frontendTestArguments, frontendTestFiles, selectedFrontendTestFiles } = require("./test-discovery.cjs");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static", "js");
const requestedCoverageRoot = process.env.MOZARIE_JS_COVERAGE_DIR;
const coverageRoot = requestedCoverageRoot ? path.resolve(requestedCoverageRoot) : fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-js-coverage-"));
const nodeCoverageRoot = path.join(coverageRoot, "node");
const nodeCoverageTemp = path.join(coverageRoot, "v8");
const browserCoverageFile = path.join(coverageRoot, "browser-v8.json");
const testFiles = frontendTestFiles();

function parseArguments(argv) {
  if (!argv.length) return { shardIndex: null, shardTotal: null, manifest: null };
  let shardIndex = null;
  let shardTotal = null;
  let manifest = null;
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!value || !["--shard-index", "--shard-total", "--manifest"].includes(option)) throw new Error("usage: node scripts/coverage-js.cjs [--shard-index INDEX --shard-total TOTAL --manifest FILE]");
    if (option === "--shard-index") shardIndex = Number(value);
    if (option === "--shard-total") shardTotal = Number(value);
    if (option === "--manifest") manifest = path.resolve(value);
  }
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1 || shardIndex < 0 || shardIndex >= shardTotal || !manifest) {
    throw new Error("usage: node scripts/coverage-js.cjs [--shard-index INDEX --shard-total TOTAL --manifest FILE]");
  }
  return { shardIndex, shardTotal, manifest };
}

function staticFiles(directory = staticRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return staticFiles(file);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}

function runNodeCoverage(files = testFiles) {
  const c8 = require.resolve("c8/bin/c8.js");
  const result = childProcess.spawnSync(process.execPath, [
    c8,
    "--all",
    "--include", "static/js/**/*.js",
    "--reporter", "json",
    "--reports-dir", nodeCoverageRoot,
    "--temp-directory", nodeCoverageTemp,
    "--clean",
    process.execPath,
    ...frontendTestArguments(files),
  ], {
    cwd: root,
    env: {
      ...process.env,
      MOZARIE_JS_COVERAGE: "1",
      MOZARIE_BROWSER_COVERAGE_FILE: browserCoverageFile,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "the selected frontend and browser tests must pass before coverage is accepted");
}

function sourceFileForCoverageEntry(entry) {
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (url.protocol === "file:") return path.resolve(fileURLToPath(url));
  if (!url.pathname.startsWith("/js/") || !url.pathname.endsWith(".js")) return null;
  return path.resolve(root, "static", url.pathname.slice(1).split("/").join(path.sep));
}

function nodeCoverageMap(directory = nodeCoverageRoot) {
  const nodeCoverageFile = path.join(directory, "coverage-final.json");
  assert.ok(fs.existsSync(nodeCoverageFile), `Node coverage JSON was not created: ${nodeCoverageFile}`);
  return createCoverageMap(JSON.parse(fs.readFileSync(nodeCoverageFile, "utf8")));
}

async function browserCoverageMap(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0, "browser coverage output is empty");
  const map = createCoverageMap({});
  let measuredEntries = 0;
  for (const entry of entries) {
    const sourceFile = sourceFileForCoverageEntry(entry);
    if (!sourceFile || !sourceFile.startsWith(`${staticRoot}${path.sep}`)) continue;
    assert.ok(fs.existsSync(sourceFile), `coverage references an unknown file: ${entry.url}`);
    assert.equal(typeof entry.source, "string", `browser coverage did not include source for ${entry.url}`);
    assert.equal(Buffer.compare(Buffer.from(entry.source), fs.readFileSync(sourceFile)), 0, `browser coverage source changed during the run: ${entry.url}`);
    const converter = v8ToIstanbul(sourceFile, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    map.merge(converter.toIstanbul());
    measuredEntries += 1;
  }
  assert.ok(measuredEntries > 0, "browser coverage has no static JavaScript entries");
  assert.ok(map.files().length > 0, "browser coverage map has no static JavaScript files");
  return map;
}

async function combinedCoverageMap() {
  const nodeMap = nodeCoverageMap();
  assert.ok(fs.existsSync(browserCoverageFile), "browser coverage output was not written");
  nodeMap.merge(await browserCoverageMap(JSON.parse(fs.readFileSync(browserCoverageFile, "utf8"))));
  return nodeMap;
}

function verifyCoverage(map) {
  const missing = [];
  for (const file of staticFiles()) {
    if (!map.data[file]) missing.push(path.relative(root, file).replaceAll("\\", "/"));
  }
  assert.deepEqual(missing, [], `unmeasured static JavaScript files:\n${missing.join("\n")}`);
}

function writeCoverageReports(map, reportDirectory) {
  const context = libReport.createContext({ dir: reportDirectory, coverageMap: map });
  reports.create("json").execute(context);
  reports.create("text", { maxCols: Infinity }).execute(context);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or corrupt (${file}): ${error.message}`); }
}

async function mergeFrontendShardCoverage(shards, reportDirectory, dependencies = {}) {
  if (!shards.length) throw new Error("frontend shard coverage has no inputs");
  const convertBrowser = dependencies.browserCoverageMap || browserCoverageMap;
  const verify = dependencies.verifyCoverage || verifyCoverage;
  const write = dependencies.writeCoverageReports || writeCoverageReports;
  const combined = createCoverageMap({});
  if (!shards.some((shard) => shard.browserCoverageRequired)) throw new Error("frontend shard coverage has no browser V8 producer");
  for (const { directory, browserCoverageRequired } of shards) {
    combined.merge(createCoverageMap(readJson(path.join(directory, "node", "coverage-final.json"), "frontend shard Node coverage")));
    const browserFile = path.join(directory, "browser-v8.json");
    if (!fs.existsSync(browserFile)) {
      if (browserCoverageRequired) throw new Error(`frontend shard browser coverage is missing (${browserFile})`);
      continue;
    }
    if (!browserCoverageRequired) throw new Error(`frontend shard browser coverage is unexpected (${browserFile})`);
    combined.merge(await convertBrowser(readJson(browserFile, "frontend shard browser coverage")));
  }
  verify(combined);
  write(combined, reportDirectory);
  return combined;
}

function writeShardManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function runSerial() {
  fs.rmSync(coverageRoot, { recursive: true, force: true });
  fs.mkdirSync(coverageRoot, { recursive: true });
  runNodeCoverage();
  const combined = await combinedCoverageMap();
  writeCoverageReports(combined, path.join(coverageRoot, "report"));
  verifyCoverage(combined);
}

async function runShard({ shardIndex, shardTotal, manifest: manifestPath }) {
  const selected = selectedFrontendTestFiles(testFiles, shardIndex, shardTotal);
  const manifest = { schema: 1, shard: { index: shardIndex, total: shardTotal }, discovered: testFiles, selected, status: "error" };
  fs.rmSync(coverageRoot, { recursive: true, force: true });
  fs.mkdirSync(coverageRoot, { recursive: true });
  writeShardManifest(manifestPath, manifest);
  try {
    runNodeCoverage(selected);
    manifest.status = "passed";
  } catch (error) {
    manifest.status = "failed";
    throw error;
  } finally {
    writeShardManifest(manifestPath, manifest);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.shardIndex === null) await runSerial();
  else await runShard(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  }).finally(() => {
    if (!requestedCoverageRoot) fs.rmSync(coverageRoot, { recursive: true, force: true });
  });
}

module.exports = { browserCoverageMap, mergeFrontendShardCoverage, nodeCoverageMap, parseArguments, testFiles, verifyCoverage, writeCoverageReports };
