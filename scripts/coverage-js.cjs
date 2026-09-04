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

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static", "js");
const requestedCoverageRoot = process.env.MOZARIE_JS_COVERAGE_DIR;
const coverageRoot = requestedCoverageRoot ? path.resolve(requestedCoverageRoot) : fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-js-coverage-"));
const nodeCoverageRoot = path.join(coverageRoot, "node");
const nodeCoverageTemp = path.join(coverageRoot, "v8");
const browserCoverageFile = path.join(coverageRoot, "browser-v8.json");
const testFiles = [
  "tests/test_app_core_detection_coverage.cjs",
  "tests/test_browser_save_runtime.cjs",
  "tests/test_coverage_js.cjs",
  "tests/test_candidate_bundle.cjs",
  "tests/test_detection_refresh_runtime.cjs",
  "tests/test_editor_canvas_completion_runtime.cjs",
  "tests/test_editor_canvas_geometry_runtime.cjs",
  "tests/test_editor_masks_behavior.cjs",
  "tests/test_editor_runtime.cjs",
  "tests/test_gallery_save_coverage.cjs",
  "tests/test_interaction_coverage.cjs",
  "tests/test_import_picker_e2e.cjs",
  "tests/test_padding_splitter_e2e.cjs",
  "tests/test_flood_fill_worker.cjs",
  "tests/test_masked_mosaic_worker.cjs",
  "tests/test_mosaic_preview_runtime.cjs",
  "tests/test_project_browser_lifecycle_e2e.cjs",
  "tests/test_project_history_browser_e2e.cjs",
  "tests/test_project_ui_runtime.cjs",
  "tests/test_same_source_project_select_runtime.cjs",
  "tests/test_quiet_runner.cjs",
  "tests/test_resources.cjs",
  "tests/test_settings_runtime.cjs",
  "tests/test_workspace_runtime.cjs",
  "tests/test_workspace_flush_runtime.cjs",
  "tests/test_workspace_flags_runtime.cjs",
  "tests/test_workspace_idb_runtime.cjs",
  "tests/test_ui_control_manifest.cjs",
  "tests/test_workspace_recovery_e2e.cjs",
];

function staticFiles(directory = staticRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return staticFiles(file);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}

function runNodeCoverage() {
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
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=4",
    ...testFiles,
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
  assert.equal(result.status, 0, "the existing frontend and browser tests must pass before coverage is evaluated");
}

function sourceFileForCoverageEntry(entry) {
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (url.protocol === "file:") return path.resolve(fileURLToPath(url));
  if (!url.pathname.startsWith("/js/") || !url.pathname.endsWith(".js")) return null;
  return path.resolve(root, "static", url.pathname.slice(1).split("/").join(path.sep));
}

function nodeCoverageMap() {
  const nodeCoverageFile = path.join(nodeCoverageRoot, "coverage-final.json");
  assert.ok(fs.existsSync(nodeCoverageFile), "c8 did not create a Node/VM coverage report");
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
  const browserEntries = JSON.parse(fs.readFileSync(browserCoverageFile, "utf8"));
  nodeMap.merge(await browserCoverageMap(browserEntries));
  return nodeMap;
}

function verifyCoverage(map) {
  const missing = [];
  const belowTarget = [];
  for (const file of staticFiles()) {
    if (!map.data[file]) {
      missing.push(path.relative(root, file).replaceAll("\\", "/"));
      continue;
    }
    const summary = map.fileCoverageFor(file).toSummary().data;
    const incomplete = Object.entries(summary)
      .filter(([, value]) => value.pct !== 100)
      .map(([metric, value]) => `${metric}=${value.pct}% (${value.covered}/${value.total})`);
    if (incomplete.length) belowTarget.push(`${path.relative(root, file).replaceAll("\\", "/")}: ${incomplete.join(", ")}`);
  }
  assert.deepEqual(missing, [], `unmeasured static JavaScript files:\n${missing.join("\n")}`);
  assert.deepEqual(belowTarget, [], `static JavaScript must have 100% statement, line, branch, and function coverage:\n${belowTarget.join("\n")}`);
}

async function main() {
  fs.rmSync(coverageRoot, { recursive: true, force: true });
  fs.mkdirSync(coverageRoot, { recursive: true });
  runNodeCoverage();
  const combined = await combinedCoverageMap();
  const reportDirectory = path.join(coverageRoot, "report");
  const context = libReport.createContext({ dir: reportDirectory, coverageMap: combined });
  reports.create("json").execute(context);
  reports.create("text", { maxCols: Infinity }).execute(context);
  verifyCoverage(combined);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  }).finally(() => {
    if (!requestedCoverageRoot) fs.rmSync(coverageRoot, { recursive: true, force: true });
  });
}

module.exports = { browserCoverageMap };
