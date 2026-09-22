"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testDirectory = path.join(root, "tests");

function frontendTestFiles(directory = testDirectory, prefix = "tests") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...frontendTestFiles(path.join(directory, entry.name), relativePath));
    else if (entry.isFile() && /^test_.*\.cjs$/.test(entry.name)) files.push(relativePath);
  }
  return files
    .filter((file) => file !== "tests/test_gallery_performance_e2e.cjs")
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function frontendPerformanceTestFiles() {
  const file = "tests/test_gallery_performance_e2e.cjs";
  if (!fs.existsSync(path.join(root, file))) throw new Error(`missing frontend performance test: ${file}`);
  return [file];
}

function frontendTestArguments(files = frontendTestFiles()) {
  // Browser fixtures start real Chromium instances. One fixture process at a
  // time keeps the shared runner from turning UI-state waits into CPU races.
  return ["--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", "--test-concurrency=1", ...files];
}

function selectedFrontendTestFiles(files, shardIndex, shardTotal) {
  if (!Array.isArray(files) || !Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1 || shardIndex < 0 || shardIndex >= shardTotal) {
    throw new Error("frontend shard index must be within shard total");
  }
  return files.filter((_, position) => position % shardTotal === shardIndex);
}

module.exports = { frontendPerformanceTestFiles, frontendTestArguments, frontendTestFiles, selectedFrontendTestFiles };
