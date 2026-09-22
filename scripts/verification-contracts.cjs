"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const CONTRACT_PATTERN = /^verification-contracts\.[a-z0-9-]+\.json$/;
const SOURCE_ID_PATTERN = /^[A-Z]{2}-\d{3}[a-z]?$/;
const OBSERVATION_KEY_PATTERN = /^[A-Z]{2}-\d{3}[a-z]?\.[A-Za-z0-9_-]+$/;
const MANUAL_REFERENCE_PATTERN = /^[A-Z]{2}-\d{3}[a-z]?(?:\.[A-Za-z0-9_-]+)*(?:・[A-Z]{2}-\d{3}[a-z]?(?:\.[A-Za-z0-9_-]+)*)*$/;
const NODE_ID_PATTERN = /^node:([^:]+\.cjs)::(.+)$/;
const PYTHON_ID_PATTERN = /^python:tests(?:\.[A-Za-z0-9_]+){3,}$/;
const ALLOWED_STATUSES = new Set(["automated", "manual", "retired"]);
const ABSTRACT_MANUAL_TEXT = new Set([
  "実機", "手動", "目視", "確認", "環境依存", "CIで無理", "自動化できない", "その他",
  "real environment", "manual", "visual check", "not automated", "other",
]);

function contractFiles(directory = path.join(root, "tests")) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CONTRACT_PATTERN.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function markdownCells(line) {
  const cells = [];
  let value = "";
  let escaped = false;
  let inCode = false;
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      value += character;
      escaped = true;
    } else if (character === "`") {
      value += character;
      inCode = !inCode;
    } else if (character === "|" && !inCode) {
      cells.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value.trim());
  return cells;
}

function manualRows(text, label = "manual document") {
  const rows = [];
  const byId = new Map();
  const byKey = new Map();
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!/^\|\s*[A-Z]{2}-\d{3}/.test(line) || !line.trimEnd().endsWith("|")) continue;
    const cells = markdownCells(line);
    const references = cells[0]?.split("・") || [];
    if (cells.length < 2 || !MANUAL_REFERENCE_PATTERN.test(cells[0]) || references.length === 0) {
      throw new Error(`${label} has an invalid verification row: ${line}`);
    }
    if (cells.slice(1).some((cell) => !cell)) throw new Error(`${label} has an empty manual cell for ${cells[0]}`);
    const isKey = references.some((reference) => !SOURCE_ID_PATTERN.test(reference));
    if (isKey && references.length !== 1) throw new Error(`${label} cannot combine observation keys in one row: ${cells[0]}`);
    const ids = isKey ? [] : references;
    const row = { reference: cells[0], ids, key: isKey ? references[0] : null, cells: cells.slice(1), action: cells[1], observation: cells[2] };
    rows.push(row);
    if (row.key) {
      if (byKey.has(row.key)) throw new Error(`${label} duplicates ${row.key}`);
      byKey.set(row.key, row);
    } else {
      for (const sourceId of ids) {
        if (byId.has(sourceId)) throw new Error(`${label} duplicates ${sourceId}`);
        byId.set(sourceId, row);
      }
    }
  }
  return { rows, byId, byKey };
}

function sourceAtCommit(commit, sourcePath, repositoryRoot = root) {
  try {
    return childProcess.execFileSync("git", ["show", `${commit}:${sourcePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim();
    throw new Error(`cannot read ${sourcePath} at ${commit}: ${detail}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function rejectUnknownFields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unexpected.length) throw new Error(`${label} has unknown fields: ${unexpected.join(", ")}`);
}

function validateManualDetail(manual, label) {
  requireObject(manual, `${label}.manual`);
  for (const field of ["environment", "reason"]) {
    const value = requireNonEmptyString(manual[field], `${label}.manual.${field}`);
    if (value.length < 6 || ABSTRACT_MANUAL_TEXT.has(value.toLowerCase())) {
      throw new Error(`${label}.manual.${field} must name the concrete external environment or unautomated observation`);
    }
  }
  const unexpected = Object.keys(manual).filter((field) => !["environment", "reason"].includes(field));
  if (unexpected.length) throw new Error(`${label}.manual has unknown fields: ${unexpected.join(", ")}`);
}

function validateTestId(testId, label) {
  const value = requireNonEmptyString(testId, label);
  const node = value.match(NODE_ID_PATTERN);
  if (node) {
    if (node[1].includes("\\") || path.posix.isAbsolute(node[1]) || !node[1].startsWith("tests/")) {
      throw new Error(`${label} must use a repository-relative POSIX path below tests/`);
    }
    return;
  }
  if (PYTHON_ID_PATTERN.test(value)) return;
  throw new Error(`${label} must be node:<repo path>::<suite and test name> or python:<fully qualified unittest ID>`);
}

function validateContract(contract, options = {}) {
  const label = options.label || "verification contract";
  requireObject(contract, label);
  rejectUnknownFields(contract, ["version", "domain", "source", "baseline", "observations"], label);
  if (contract.version !== 1) throw new Error(`${label}.version must be 1`);
  requireNonEmptyString(contract.domain, `${label}.domain`);
  const source = requireObject(contract.source, `${label}.source`);
  rejectUnknownFields(source, ["path", "commit"], `${label}.source`);
  const sourcePath = requireNonEmptyString(source.path, `${label}.source.path`).replaceAll("\\", "/");
  if (!sourcePath.startsWith("docs/manual-verification/") || !sourcePath.endsWith(".md") || path.posix.isAbsolute(sourcePath)) {
    throw new Error(`${label}.source.path must be a repository-relative file below docs/manual-verification/`);
  }
  if (source.commit !== "264f70d") throw new Error(`${label}.source.commit must be 264f70d`);
  const baseline = requireObject(contract.baseline, `${label}.baseline`);
  rejectUnknownFields(baseline, ["rows", "observations"], `${label}.baseline`);
  if (!Number.isInteger(baseline.rows) || baseline.rows < 0) throw new Error(`${label}.baseline.rows must be a non-negative integer`);
  if (!Number.isInteger(baseline.observations) || baseline.observations < 0) throw new Error(`${label}.baseline.observations must be a non-negative integer`);
  if (!Array.isArray(contract.observations)) throw new Error(`${label}.observations must be an array`);
  if (baseline.observations !== contract.observations.length) {
    throw new Error(`${label}.baseline.observations must equal observations.length`);
  }

  const keys = new Set();
  const sourceIds = new Set();
  for (const [index, observation] of contract.observations.entries()) {
    const itemLabel = `${label}.observations[${index}]`;
    requireObject(observation, itemLabel);
    rejectUnknownFields(observation, ["key", "sourceIds", "observation", "status", "testIds", "manual", "retirementReason"], itemLabel);
    const key = requireNonEmptyString(observation.key, `${itemLabel}.key`);
    if (!OBSERVATION_KEY_PATTERN.test(key)) throw new Error(`${itemLabel}.key must be <source ID>.<observation suffix>`);
    if (keys.has(key)) throw new Error(`${label} duplicates observation key ${key}`);
    keys.add(key);
    if (!Array.isArray(observation.sourceIds) || observation.sourceIds.length === 0) throw new Error(`${itemLabel}.sourceIds must be a non-empty array`);
    for (const [sourceIndex, sourceId] of observation.sourceIds.entries()) {
      if (!SOURCE_ID_PATTERN.test(sourceId)) throw new Error(`${itemLabel}.sourceIds[${sourceIndex}] has an invalid source ID`);
      sourceIds.add(sourceId);
    }
    requireNonEmptyString(observation.observation, `${itemLabel}.observation`);
    if (!ALLOWED_STATUSES.has(observation.status)) throw new Error(`${itemLabel}.status must be automated, manual, or retired`);
    if (observation.status !== "retired" && observation.retirementReason !== undefined) throw new Error(`${itemLabel}.retirementReason is only allowed for retired observations`);
    if (observation.status === "automated") {
      if (!Array.isArray(observation.testIds) || observation.testIds.length === 0) throw new Error(`${itemLabel}.testIds must be non-empty for automated observations`);
      observation.testIds.forEach((testId, testIndex) => validateTestId(testId, `${itemLabel}.testIds[${testIndex}]`));
      if (observation.manual !== undefined) throw new Error(`${itemLabel}.manual is only allowed for manual observations`);
    } else if (observation.status === "manual") {
      if (observation.testIds !== undefined) throw new Error(`${itemLabel}.testIds is not allowed for manual observations`);
      validateManualDetail(observation.manual, itemLabel);
    } else {
      if (observation.testIds !== undefined || observation.manual !== undefined) throw new Error(`${itemLabel} retired observations cannot carry testIds or manual details`);
      requireNonEmptyString(observation.retirementReason, `${itemLabel}.retirementReason`);
    }
  }

  const repositoryRoot = options.repositoryRoot || root;
  const readBaseline = options.sourceAtCommit || ((commit, relativePath) => sourceAtCommit(commit, relativePath, repositoryRoot));
  const readCurrent = options.currentSource || ((relativePath) => {
    const absolute = path.join(repositoryRoot, ...relativePath.split("/"));
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
  });
  const baselineRows = manualRows(readBaseline(source.commit, sourcePath), `${sourcePath}@${source.commit}`);
  if (baseline.rows !== baselineRows.rows.length) throw new Error(`${label}.baseline.rows is ${baseline.rows}, expected ${baselineRows.rows.length} from ${source.commit}`);
  const missingBaseline = [...baselineRows.byId.keys()].filter((sourceId) => !sourceIds.has(sourceId));
  const unknownBaseline = [...sourceIds].filter((sourceId) => !baselineRows.byId.has(sourceId));
  if (missingBaseline.length || unknownBaseline.length) {
    throw new Error(`${label} source ID coverage differs from the baseline (missing: ${missingBaseline.join(", ") || "none"}; unknown: ${unknownBaseline.join(", ") || "none"})`);
  }

  const currentRows = manualRows(readCurrent(sourcePath), sourcePath);
  const manualObservations = contract.observations.filter((item) => item.status === "manual");
  const manualByKey = new Map(manualObservations.map((observation) => [observation.key, observation]));
  const extraKeys = [...currentRows.byKey.keys()].filter((key) => !manualByKey.has(key));
  if (currentRows.byId.size) {
    throw new Error(`${label} manual rows must use observation keys, not source IDs: ${[...currentRows.byId.keys()].join(", ")}`);
  }
  if (extraKeys.length) throw new Error(`${label} keeps automated or retired manual rows: ${extraKeys.join(", ")}`);
  const matchedKeys = new Set();
  for (const [key, row] of currentRows.byKey) {
    const observation = manualByKey.get(key);
    if (!row.cells.includes(observation.observation)) throw new Error(`${label} manual observation text differs for ${key}`);
    matchedKeys.add(key);
  }
  const missingManual = manualObservations.filter((observation) => !matchedKeys.has(observation.key)).map((observation) => observation.key);
  if (missingManual.length) throw new Error(`${label} is missing manual observations: ${missingManual.join(", ")}`);
  return contract;
}

function loadContracts(options = {}) {
  const files = options.files || contractFiles(options.directory);
  const domains = new Set();
  const keys = new Set();
  const sourceDomains = new Map();
  const loaded = [];
  for (const file of files) {
    let contract;
    try { contract = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { throw new Error(`${path.relative(root, file)} is not valid JSON: ${error.message}`); }
    validateContract(contract, { ...options, label: path.relative(root, file).replaceAll("\\", "/") });
    const expectedName = `verification-contracts.${contract.domain}.json`;
    if (path.basename(file) !== expectedName) throw new Error(`${path.basename(file)} must be named ${expectedName}`);
    if (domains.has(contract.domain)) throw new Error(`verification contract domain is duplicated: ${contract.domain}`);
    domains.add(contract.domain);
    for (const observation of contract.observations) {
      if (keys.has(observation.key)) throw new Error(`verification observation key is duplicated across domains: ${observation.key}`);
      keys.add(observation.key);
      for (const sourceId of observation.sourceIds) {
        const owner = sourceDomains.get(sourceId);
        if (owner && owner !== contract.domain) throw new Error(`verification source ID is duplicated across domains: ${sourceId}`);
        sourceDomains.set(sourceId, contract.domain);
      }
    }
    loaded.push(contract);
  }
  return loaded;
}

function nodeResults(manifests) {
  const results = new Map();
  for (const manifest of manifests) {
    if (manifest.schema !== 1 || !Array.isArray(manifest.tests)) throw new Error("frontend execution manifest has an invalid schema");
    for (const test of manifest.tests) {
      if (!test || typeof test.id !== "string" || !["pass", "fail", "skip", "todo"].includes(test.status)) throw new Error("frontend execution manifest has an invalid test result");
      if (results.has(test.id)) throw new Error(`frontend execution manifest duplicates ${test.id}`);
      results.set(test.id, test.status);
    }
  }
  return results;
}

function pythonResults(manifests) {
  const collected = new Set();
  const results = new Map();
  for (const manifest of manifests) {
    if (manifest.schema !== 1 || !Array.isArray(manifest.discovered) || !Array.isArray(manifest.selected)) throw new Error("backend execution manifest has an invalid schema");
    manifest.discovered.forEach((testId) => collected.add(`python:${testId}`));
    const status = manifest.status === "passed" && manifest.skipped === 0 && manifest.testsRun === manifest.selected.length ? "pass" : (manifest.skipped ? "skip" : "fail");
    manifest.selected.forEach((testId) => {
      const id = `python:${testId}`;
      if (results.has(id)) throw new Error(`backend execution manifests execute ${id} more than once`);
      results.set(id, status);
    });
  }
  return { collected, results };
}

function validateAutomatedExecution(contracts, options = {}) {
  const languages = new Set(options.languages || ["node", "python"]);
  const node = nodeResults(options.nodeManifests || []);
  const python = pythonResults(options.pythonManifests || []);
  for (const contract of contracts) {
    for (const observation of contract.observations.filter((item) => item.status === "automated")) {
      for (const testId of observation.testIds) {
        const language = testId.startsWith("node:") ? "node" : "python";
        if (!languages.has(language)) continue;
        const collected = language === "node" ? node.has(testId) : python.collected.has(testId);
        if (!collected) throw new Error(`${observation.key} references an uncollected or renamed test: ${testId}`);
        const status = language === "node" ? node.get(testId) : python.results.get(testId);
        if (status === undefined && options.requireAllExecuted !== false) throw new Error(`${observation.key} references a test that was not executed: ${testId}`);
        if (status !== undefined && status !== "pass") throw new Error(`${observation.key} references a test with status ${status}: ${testId}`);
      }
    }
  }
}

function readManifest(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

module.exports = {
  contractFiles,
  loadContracts,
  manualRows,
  nodeResults,
  pythonResults,
  readManifest,
  sourceAtCommit,
  validateAutomatedExecution,
  validateContract,
};
