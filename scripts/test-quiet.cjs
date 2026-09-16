const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertNoSkippedUnittestTests } = require("./test-result-policy.cjs");
const { frontendPerformanceTestFiles, frontendTestArguments } = require("./test-discovery.cjs");

const root = path.resolve(__dirname, "..");
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUTS = {
  "backend tests": 9 * 60 * 1000,
  "backend coverage": 2 * 60 * 1000,
  "backend coverage XML": 2 * 60 * 1000,
  "frontend syntax": 2 * 60 * 1000,
  "frontend coverage": 8 * 60 * 1000,
  "frontend performance": 4 * 60 * 1000,
};

function parseArguments(argv) {
  const [suite = "all", ...rest] = argv;
  let artifacts = null;
  let shardIndex = null;
  let shardTotal = null;
  let shardArtifacts = null;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!value || !["--artifacts", "--shard-index", "--shard-total", "--shard-artifacts"].includes(option)) {
      throw new Error("usage: node scripts/test-quiet.cjs [backend|backend-aggregate|frontend|all] [--artifacts DIRECTORY] [--shard-index INDEX --shard-total TOTAL] [--shard-artifacts DIRECTORY]");
    }
    if (option === "--artifacts") artifacts = path.resolve(value);
    if (option === "--shard-artifacts") shardArtifacts = path.resolve(value);
    if (option === "--shard-index") shardIndex = Number(value);
    if (option === "--shard-total") shardTotal = Number(value);
    index += 1;
  }
  if (!["backend", "backend-aggregate", "frontend", "all"].includes(suite)
    || (shardIndex !== null && (!Number.isInteger(shardIndex) || shardIndex < 0))
    || (shardTotal !== null && (!Number.isInteger(shardTotal) || shardTotal < 1))
    || ((shardIndex === null) !== (shardTotal === null))
    || (shardIndex !== null && shardIndex >= shardTotal)
    || (suite !== "backend" && (shardIndex !== null || shardTotal !== null))
    || (suite !== "backend-aggregate" && shardArtifacts !== null)
    || (suite === "backend-aggregate" && !shardArtifacts)) {
    throw new Error("usage: node scripts/test-quiet.cjs [backend|backend-aggregate|frontend|all] [--artifacts DIRECTORY] [--shard-index INDEX --shard-total TOTAL] [--shard-artifacts DIRECTORY]");
  }
  return { suite, artifacts, shardIndex, shardTotal, shardArtifacts };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = childProcess.spawn(command, args, { cwd: root, env: options.env || process.env, shell: false, windowsHide: true });
    let output = "";
    let spawnError = null;
    let timedOut = false;
    let finished = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (spawnError) output += `${output ? "\n" : ""}${spawnError.message}`;
      resolve({ command, args, output, status: status ?? (timedOut ? 124 : 1), timedOut, elapsedMs: Date.now() - startedAt });
    };
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", finish);
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
  });
}

const MAX_DIAGNOSTIC_CHARACTERS = 32 * 1024;
const MAX_NAME_CHARACTERS = 240;
const MAX_DETAIL_LINES = 8;

function normalizeOutput(output) {
  return String(output || "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function shorten(value, maximum = MAX_NAME_CHARACTERS) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function cleanDetail(lines) {
  const summaryIndex = lines.findIndex((line) => /^Ran \d+ tests? in\b/.test(line.trim()) || /^FAILED \(.+\)$/.test(line.trim()));
  const useful = lines.slice(0, summaryIndex < 0 ? undefined : summaryIndex)
    .map((line) => line.trim())
    .filter((line) => line && !/^[=\-]{3,}$/.test(line))
    .filter((line) => !/^Traceback \(most recent call last\):$/.test(line));
  if (!useful.length) return [];
  const start = useful.findLastIndex((line) => /^File ["']/.test(line));
  return useful.slice(start >= 0 ? start : Math.max(0, useful.length - MAX_DETAIL_LINES), (start >= 0 ? undefined : useful.length))
    .slice(-MAX_DETAIL_LINES)
    .map((line) => shorten(line, 900));
}

function pythonDiagnostic(lines) {
  const entries = [];
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(FAIL|ERROR):\s+(.+)$/);
    if (match) headers.push({ index, kind: match[1], name: match[2] });
  }
  if (!headers.length) return null;
  for (let index = 0; index < headers.length; index += 1) {
    const current = headers[index];
    const next = headers[index + 1]?.index ?? lines.length;
    const body = lines.slice(current.index + 1, next);
    entries.push({ kind: current.kind, name: current.name, detail: cleanDetail(body) });
  }
  const summary = lines.filter((line) => /^Ran \d+ tests? in\b/.test(line) || /^FAILED \(.+\)$/.test(line));
  return { family: "python", entries, summary };
}

function tapDiagnostic(lines) {
  const entries = [];
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*not ok \d+ - (.+)$/);
    if (!match || /\s+#\s*(?:SKIP|TODO)\b/i.test(match[1])) continue;
    headers.push({ index, name: match[1].replace(/\s+#\s*(?:SKIP|TODO)\b.*$/i, "").trim() });
  }
  if (!headers.length) return null;
  for (let index = 0; index < headers.length; index += 1) {
    const current = headers[index];
    const next = headers[index + 1]?.index ?? lines.length;
    const body = lines.slice(current.index + 1, next);
    const yamlStart = body.findIndex((line) => line.trim() === "---");
    const yamlEnd = yamlStart < 0 ? -1 : body.findIndex((line, bodyIndex) => bodyIndex > yamlStart && line.trim() === "...");
    const candidate = yamlStart < 0 ? body : body.slice(yamlStart + 1, yamlEnd < 0 ? undefined : yamlEnd);
    const detailLines = [];
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
      const line = candidate[candidateIndex];
      if (/\b(?:error|code|name|message|stack|expected|actual|operator)\s*:|(?:Assertion|Error|Exception)\b/i.test(line)) {
        detailLines.push(line);
        if (/\bstack\s*:/i.test(line)) detailLines.push(...candidate.slice(candidateIndex + 1, candidateIndex + 5));
      }
    }
    entries.push({ kind: "FAIL", name: current.name, detail: cleanDetail(detailLines.length ? detailLines : candidate) });
  }
  const summary = lines.filter((line) => /^# (?:tests|pass|fail)\b/i.test(line.trim()));
  return { family: "tap", entries, summary };
}

function appendWithinLimit(parts, value) {
  const used = parts.join("\n").length;
  const remaining = MAX_DIAGNOSTIC_CHARACTERS - used - (parts.length ? 1 : 0);
  if (remaining <= 0) return false;
  parts.push(value.length <= remaining ? value : `${value.slice(0, Math.max(0, remaining - 1))}…`);
  return value.length <= remaining;
}

function structuredDiagnostic(parsed) {
  const parts = [];
  if (parsed.summary.length) appendWithinLimit(parts, parsed.summary.join("\n"));
  appendWithinLimit(parts, `Failures (${parsed.entries.length}):`);
  for (const entry of parsed.entries) appendWithinLimit(parts, `- ${entry.kind}: ${shorten(entry.name)}`);
  let detailed = 0;
  for (const entry of parsed.entries) {
    const detail = entry.detail.length ? `\n  ${entry.detail.join("\n  ")}` : "";
    if (!appendWithinLimit(parts, `\n${entry.kind}: ${shorten(entry.name)}${detail}`)) break;
    detailed += 1;
  }
  if (detailed < parsed.entries.length) appendWithinLimit(parts, `\ndetails truncated: ${parsed.entries.length - detailed} more`);
  return parts.join("\n").trim();
}

function diagnostic(output) {
  const normalized = normalizeOutput(output);
  const lines = normalized.split("\n");
  const parsed = pythonDiagnostic(lines) || tapDiagnostic(lines);
  if (parsed) return structuredDiagnostic(parsed);
  const fallback = lines.slice(-60).join("\n");
  return fallback.length <= MAX_DIAGNOSTIC_CHARACTERS ? fallback : `${fallback.slice(-MAX_DIAGNOSTIC_CHARACTERS + 1)}…`;
}

async function requiredCommand(label, command, args, options) {
  const result = await runCommand(command, args, { ...options, timeoutMs: options?.timeoutMs ?? COMMAND_TIMEOUTS[label] ?? DEFAULT_COMMAND_TIMEOUT_MS });
  if (result.status === 0) return result.output;
  const rawLog = writeFailureArtifact(options?.artifactDirectory, label, result);
  const timeout = result.timedOut ? ` timed out after ${(result.elapsedMs / 1000).toFixed(1)}s` : "";
  const artifact = rawLog ? `\nraw output: ${rawLog}` : "";
  const error = new Error(`${label}${timeout} failed (exit ${result.status}; elapsed ${(result.elapsedMs / 1000).toFixed(1)}s)${artifact}\n${diagnostic(result.output)}`);
  error.output = result.output;
  error.rawLog = rawLog;
  throw error;
}

function writeFailureArtifact(directory, label, result) {
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true });
  const basename = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rawLog = path.join(directory, `${basename}.failure.log`);
  fs.writeFileSync(rawLog, result.output, "utf8");
  fs.writeFileSync(path.join(directory, `${basename}.failure.json`), `${JSON.stringify({
    command: result.command,
    args: result.args,
    status: result.status,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    rawLog: path.basename(rawLog),
  }, null, 2)}\n`, "utf8");
  return rawLog;
}

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-")); }

function testPythonExecutable(environment = process.env) {
  const configured = environment.MOZARIE_TEST_PYTHON;
  const productEnvironment = path.resolve(root, ".venv");
  const executable = configured || (process.platform === "win32"
    ? path.join(root, ".venv-test", "Scripts", "python.exe")
    : path.join(root, ".venv-test", "bin", "python"));
  const resolved = path.resolve(executable);
  if (resolved === productEnvironment || resolved.startsWith(`${productEnvironment}${path.sep}`)) {
    throw new Error("MOZARIE_TEST_PYTHON must not point into the product .venv");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Dedicated test Python was not found: ${resolved}. Create .venv-test and install requirements-test.txt, or set MOZARIE_TEST_PYTHON.`);
  }
  return resolved;
}

function backendEnvironment(temporaryRoot, coverageFile) {
  const env = {
    ...process.env,
    COVERAGE_FILE: coverageFile,
    MOZARIE_TEST_APP_DIR: path.join(temporaryRoot, "app"),
    PYTHONPYCACHEPREFIX: path.join(temporaryRoot, "pycache"),
  };
  delete env.MOZARIE_PYTHON;
  delete env.MOZARIE_TEST_PYTHON;
  delete env.MOZARIE_RUNTIME;
  return env;
}

function workspaceArtifacts(directory = root) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if ([".git", ".venv", "node_modules"].includes(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") found.push(path.relative(directory, child));
        else visit(child);
      } else if ([".coverage", "coverage.xml"].includes(entry.name) || /^\.http-coverage.*\.log$/.test(entry.name)) {
        found.push(path.relative(directory, child));
      }
    }
  };
  visit(directory);
  return found.sort();
}

function coverageRates(xml) {
  const coverage = xml.match(/<coverage\b[^>]*\bline-rate="([^"]+)"[^>]*\bbranch-rate="([^"]+)"/);
  if (!coverage) throw new Error("coverage XML is missing its summary");
  return { line: Number(coverage[1]) * 100, branch: Number(coverage[2]) * 100 };
}

function verifyBackendCoverage(xml) {
  const classes = new Map([...xml.matchAll(/<class\b([^>]*)>/g)].map((match) => {
    const attribute = (name) => match[1].match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
    return [attribute("filename")?.replaceAll("\\\\", "/"), [Number(attribute("line-rate")), Number(attribute("branch-rate"))]];
  }));
  const required = ["server.py", "updater.py", "setup_gpu_check.py"];
  const missing = required.filter((filename) => !classes.has(filename));
  if (missing.length) throw new Error(`backend coverage is missing required files: ${missing.join(", ")}`);
}

function testCount(output) { return output.match(/Ran (\d+) tests? in/)?.[1] || output.match(/# tests (\d+)/)?.[1] || "?"; }

function artifactDirectory(temporaryRoot, artifacts, suite) {
  const directory = artifacts ? path.join(artifacts, suite) : path.join(temporaryRoot, suite);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

async function runBackend(temporaryRoot, artifacts, shard = {}) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "backend");
  const coverageFile = path.join(directory, ".coverage");
  const coverageXml = path.join(directory, "coverage.xml");
  const manifest = path.join(directory, "backend-manifest.json");
  const shardIndex = shard.index ?? 0;
  const shardTotal = shard.total ?? 1;
  const python = testPythonExecutable();
  const env = backendEnvironment(temporaryRoot, coverageFile);
  const tests = await requiredCommand("backend tests", python, ["-m", "coverage", "run", path.join("scripts", "unittest-shard.py"), "--shard-index", String(shardIndex), "--shard-total", String(shardTotal), "--manifest", manifest], { env, artifactDirectory: directory });
  assertNoSkippedUnittestTests(tests);
  await requiredCommand("backend coverage", python, ["-m", "coverage", "report"], { env, artifactDirectory: directory });
  await requiredCommand("backend coverage XML", python, ["-m", "coverage", "xml", "-o", coverageXml], { env, artifactDirectory: directory });
  const xml = fs.readFileSync(coverageXml, "utf8");
  const rates = coverageRates(xml);
  verifyBackendCoverage(xml);
  return `backend shard ${shardIndex + 1}/${shardTotal}: passed (${testCount(tests)} tests; coverage report line ${rates.line}%, branch ${rates.branch}%)`;
}

function recursiveFiles(directory, filename) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === filename) found.push(child);
    }
  };
  visit(directory);
  return found.sort();
}

function selectedShardTestIds(discovered, shardIndex, shardTotal) {
  return discovered.filter((_, position) => position % shardTotal === shardIndex);
}

function validateBackendShardManifests(manifests, expectedTotal = null) {
  if (!manifests.length) throw new Error("backend shard artifacts have no manifests");
  const discovered = manifests[0].discovered;
  if (!Array.isArray(discovered) || new Set(discovered).size !== discovered.length) throw new Error("backend shard manifest has invalid discovered test IDs");
  const total = expectedTotal ?? manifests[0].shard?.total;
  if (!Number.isInteger(total) || total < 1) throw new Error("backend shard manifest has invalid shard total");
  if (manifests.length !== total) throw new Error(`backend shard manifests are incomplete: expected ${total}, found ${manifests.length}`);
  const byIndex = new Map();
  for (const manifest of manifests) {
    const { index, total: manifestTotal } = manifest.shard || {};
    if (manifest.schema !== 1 || manifestTotal !== total || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("backend shard manifest has invalid shard metadata");
    if (byIndex.has(index)) throw new Error(`backend shard manifests duplicate shard ${index}`);
    if (JSON.stringify(manifest.discovered) !== JSON.stringify(discovered)) throw new Error("backend shard manifests disagree on discovered tests");
    const expected = selectedShardTestIds(discovered, index, total);
    if (JSON.stringify(manifest.selected) !== JSON.stringify(expected)) throw new Error(`backend shard ${index} selected an unexpected test set`);
    if (manifest.testsRun !== expected.length) throw new Error(`backend shard ${index} ran ${manifest.testsRun} tests but selected ${expected.length}`);
    if (manifest.skipped !== 0) throw new Error(`backend shard ${index} skipped ${manifest.skipped} tests`);
    if (manifest.status !== "passed") throw new Error(`backend shard ${index} did not pass (${manifest.status})`);
    byIndex.set(index, manifest);
  }
  for (let index = 0; index < total; index += 1) if (!byIndex.has(index)) throw new Error(`backend shard manifests are missing shard ${index}`);
  const union = [...byIndex.values()].flatMap((manifest) => manifest.selected);
  if (union.length !== discovered.length || new Set(union).size !== union.length || new Set(union).size !== new Set(discovered).size) {
    throw new Error("backend shard selected-test union is incomplete or duplicated");
  }
  return { discovered, manifests: [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, manifest]) => manifest) };
}

async function aggregateBackendShards(temporaryRoot, artifacts, shardArtifacts, expectedTotal = 2) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "backend");
  const manifestPaths = recursiveFiles(shardArtifacts, "backend-manifest.json");
  const entries = manifestPaths.map((manifestPath) => ({ path: manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) }));
  const { discovered, manifests } = validateBackendShardManifests(entries.map((entry) => entry.manifest), expectedTotal);
  const inputs = path.join(directory, "coverage-input");
  fs.mkdirSync(inputs, { recursive: true });
  for (const manifest of manifests) {
    const entry = entries.find((candidate) => candidate.manifest === manifest);
    const coverage = path.join(path.dirname(entry.path), ".coverage");
    if (!fs.existsSync(coverage)) throw new Error(`backend shard ${manifest.shard.index} is missing coverage data`);
    fs.copyFileSync(coverage, path.join(inputs, `.coverage.shard-${manifest.shard.index}`));
  }
  const coverageFile = path.join(directory, ".coverage");
  const coverageXml = path.join(directory, "coverage.xml");
  const python = testPythonExecutable();
  const env = { ...process.env, COVERAGE_FILE: coverageFile, PYTHONPYCACHEPREFIX: path.join(temporaryRoot, "pycache") };
  await requiredCommand("backend coverage combine", python, ["-m", "coverage", "combine", "--keep", inputs], { env, artifactDirectory: directory });
  await requiredCommand("backend coverage", python, ["-m", "coverage", "report"], { env, artifactDirectory: directory });
  await requiredCommand("backend coverage XML", python, ["-m", "coverage", "xml", "-o", coverageXml], { env, artifactDirectory: directory });
  const xml = fs.readFileSync(coverageXml, "utf8");
  const rates = coverageRates(xml);
  verifyBackendCoverage(xml);
  return `backend: passed (${discovered.length} tests across ${manifests.length} shards; coverage report line ${rates.line}%, branch ${rates.branch}%)`;
}

function performanceEnvironment(source = process.env) {
  const env = { ...source };
  delete env.MOZARIE_JS_COVERAGE;
  delete env.MOZARIE_BROWSER_COVERAGE_FILE;
  delete env.NODE_V8_COVERAGE;
  return env;
}

async function runFrontend(temporaryRoot, artifacts, dependencies = {}) {
  const run = dependencies.requiredCommand || requiredCommand;
  const directory = artifactDirectory(temporaryRoot, artifacts, "frontend");
  await run("frontend syntax", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"], { env: process.env, artifactDirectory: directory });
  const output = await run("frontend coverage", process.execPath, [path.join("scripts", "coverage-js.cjs")], {
    env: { ...process.env, MOZARIE_JS_COVERAGE_DIR: directory }, artifactDirectory: directory,
  });
  if (!fs.existsSync(path.join(directory, "report", "coverage-final.json"))) throw new Error("frontend coverage JSON was not created");
  const performance = await run("frontend performance", process.execPath, frontendTestArguments(frontendPerformanceTestFiles()), {
    env: performanceEnvironment(), artifactDirectory: directory,
  });
  return `frontend: passed (${testCount(output)} coverage tests; ${testCount(performance)} performance tests; JavaScript coverage report created)`;
}

async function runSuites({ suite, artifacts, shardIndex = null, shardTotal = null, shardArtifacts = null }, dependencies = {}) {
  const makeTemporaryDirectory = dependencies.temporaryDirectory || temporaryDirectory;
  const removeDirectory = dependencies.removeDirectory || ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  const temporaryRoot = makeTemporaryDirectory();
  const beforeArtifacts = workspaceArtifacts(dependencies.workspaceDirectory || root);
  try {
    const summaries = [];
    if (suite === "backend" || suite === "all") summaries.push(await (dependencies.runBackend || runBackend)(temporaryRoot, artifacts, { index: shardIndex ?? 0, total: shardTotal ?? 1 }));
    if (suite === "backend-aggregate") summaries.push(await (dependencies.aggregateBackendShards || aggregateBackendShards)(temporaryRoot, artifacts, shardArtifacts));
    if (suite === "frontend" || suite === "all") summaries.push(await (dependencies.runFrontend || runFrontend)(temporaryRoot, artifacts));
    const afterArtifacts = workspaceArtifacts(dependencies.workspaceDirectory || root);
    const createdArtifacts = afterArtifacts.filter((artifact) => !beforeArtifacts.includes(artifact));
    if (createdArtifacts.length) throw new Error(`test runner created workspace artifacts: ${createdArtifacts.join(", ")}`);
    return summaries;
  } finally { removeDirectory(temporaryRoot); }
}

async function main(argv = process.argv.slice(2)) {
  const summaries = await runSuites(parseArguments(argv));
  for (const summary of summaries) console.log(summary);
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { aggregateBackendShards, artifactDirectory, backendEnvironment, coverageRates, diagnostic, parseArguments, performanceEnvironment, recursiveFiles, requiredCommand, runCommand, runFrontend, runSuites, selectedShardTestIds, temporaryDirectory, testCount, testPythonExecutable, validateBackendShardManifests, verifyBackendCoverage, workspaceArtifacts, writeFailureArtifact };
