const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function parseArguments(argv) {
  const [suite = "all", ...rest] = argv;
  let artifacts = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--artifacts" || !rest[index + 1]) throw new Error("usage: node scripts/test-quiet.cjs [backend|frontend|all] [--artifacts DIRECTORY]");
    artifacts = path.resolve(rest[index + 1]);
    index += 1;
  }
  if (!["backend", "frontend", "all"].includes(suite)) throw new Error("usage: node scripts/test-quiet.cjs [backend|frontend|all] [--artifacts DIRECTORY]");
  return { suite, artifacts };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { cwd: root, env: options.env || process.env, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ command, args, output, status: status ?? 1 }));
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
  const useful = lines
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
      if (/\b(?:error|code|name|message|stack)\s*:|(?:Assertion|Error|Exception)\b/i.test(line)) {
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
  const result = await runCommand(command, args, options);
  if (result.status === 0) return result.output;
  const error = new Error(`${label} failed (exit ${result.status})\n${diagnostic(result.output)}`);
  error.output = result.output;
  throw error;
}

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-")); }

function pythonExecutable() {
  if (process.env.MOZARIE_PYTHON) return process.env.MOZARIE_PYTHON;
  const virtualEnvironment = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
  return fs.existsSync(virtualEnvironment) ? virtualEnvironment : "python";
}

function backendEnvironment(temporaryRoot, coverageFile) {
  const env = { ...process.env, COVERAGE_FILE: coverageFile, PYTHONPYCACHEPREFIX: path.join(temporaryRoot, "pycache") };
  delete env.MOZARIE_PYTHON;
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
  const incomplete = [...classes].filter(([filename, rates]) => filename && (rates[0] !== 1 || rates[1] !== 1));
  if (missing.length || incomplete.length) throw new Error(`backend coverage below 100%: missing ${missing.join(", ") || "none"}; incomplete ${incomplete.map(([filename]) => filename).join(", ") || "none"}`);
}

function testCount(output) { return output.match(/Ran (\d+) tests? in/)?.[1] || output.match(/# tests (\d+)/)?.[1] || "?"; }

function artifactDirectory(temporaryRoot, artifacts, suite) {
  const directory = artifacts ? path.join(artifacts, suite) : path.join(temporaryRoot, suite);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

async function runBackend(temporaryRoot, artifacts) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "backend");
  const coverageFile = path.join(directory, ".coverage");
  const coverageXml = path.join(directory, "coverage.xml");
  const env = backendEnvironment(temporaryRoot, coverageFile);
  const python = pythonExecutable();
  const tests = await requiredCommand("backend tests", python, ["-m", "coverage", "run", "-m", "unittest", "discover", "-s", "tests", "-t", "."], { env });
  await requiredCommand("backend coverage", python, ["-m", "coverage", "report", "--fail-under=100"], { env });
  await requiredCommand("backend coverage XML", python, ["-m", "coverage", "xml", "-o", coverageXml], { env });
  const xml = fs.readFileSync(coverageXml, "utf8");
  const rates = coverageRates(xml);
  verifyBackendCoverage(xml);
  fs.rmSync(coverageFile, { force: true });
  return `backend: passed (${testCount(tests)} tests, line ${rates.line}%, branch ${rates.branch}%)`;
}

async function runFrontend(temporaryRoot, artifacts) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "frontend");
  await requiredCommand("frontend syntax", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"], { env: process.env });
  const output = await requiredCommand("frontend coverage", process.execPath, [path.join("scripts", "coverage-js.cjs")], {
    env: { ...process.env, MOZARIE_JS_COVERAGE_DIR: directory },
  });
  if (!fs.existsSync(path.join(directory, "report", "coverage-final.json"))) throw new Error("frontend coverage JSON was not created");
  return `frontend: passed (${testCount(output)} tests, JavaScript 100%)`;
}

async function runSuites({ suite, artifacts }, dependencies = {}) {
  const makeTemporaryDirectory = dependencies.temporaryDirectory || temporaryDirectory;
  const removeDirectory = dependencies.removeDirectory || ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  const temporaryRoot = makeTemporaryDirectory();
  const beforeArtifacts = workspaceArtifacts(dependencies.workspaceDirectory || root);
  try {
    const summaries = [];
    if (suite === "backend" || suite === "all") summaries.push(await (dependencies.runBackend || runBackend)(temporaryRoot, artifacts));
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

module.exports = { artifactDirectory, backendEnvironment, coverageRates, diagnostic, parseArguments, requiredCommand, runCommand, runSuites, temporaryDirectory, testCount, verifyBackendCoverage, workspaceArtifacts };
