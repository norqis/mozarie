"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { tap } = require("node:test/reporters");

const root = path.resolve(__dirname, "..");

function testId(data, parents) {
  const absoluteFile = path.resolve(data.file || "");
  const relativeFile = path.relative(root, absoluteFile).replaceAll("\\", "/");
  if (!relativeFile || relativeFile.startsWith("../") || path.isAbsolute(relativeFile)) {
    throw new Error(`test file is outside the repository: ${data.file || "unknown"}`);
  }
  const names = parents.slice(0, data.nesting).map((parent) => parent?.name).filter(Boolean);
  const ownName = path.resolve(String(data.name)) === absoluteFile ? "<file>" : String(data.name);
  names.push(ownName);
  return `node:${relativeFile}::${names.join(" > ")}`;
}

function writeManifest(file, tests) {
  if (!file) return;
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, tests }, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, absolute);
}

module.exports = async function* strictTapReporter(source) {
  const deferred = [];
  const parents = [];
  const results = [];
  const resultIds = new Set();
  async function* observed() {
    for await (const event of source) {
      if (process.env.MOZARIE_NODE_TEST_MANIFEST && event.type === "test:start" && event.data) {
        parents[event.data.nesting] = { name: event.data.name, file: event.data.file };
        parents.length = event.data.nesting + 1;
      }
      if (event.data && (event.data.skip !== undefined || event.data.todo !== undefined)) {
        deferred.push({ name: event.data.name, skip: event.data.skip, todo: event.data.todo });
      }
      if (process.env.MOZARIE_NODE_TEST_MANIFEST && (event.type === "test:pass" || event.type === "test:fail") && event.data?.file) {
        const id = testId(event.data, parents);
        if (resultIds.has(id)) throw new Error(`duplicate node test ID: ${id}`);
        resultIds.add(id);
        results.push({
          id,
          status: event.data.skip !== undefined ? "skip" : event.data.todo !== undefined ? "todo" : event.type === "test:pass" ? "pass" : "fail",
        });
      }
      yield event;
    }
  }
  yield* tap(observed());
  writeManifest(process.env.MOZARIE_NODE_TEST_MANIFEST, results);
  if (deferred.length) {
    const names = deferred.map(({ name, skip, todo }) => `${name} (${skip !== undefined ? "skip" : "todo"}${typeof (skip ?? todo) === "string" ? `: ${skip ?? todo}` : ""})`);
    throw new Error(`deferred tests are not allowed: ${names.join(", ")}`);
  }
};

module.exports.testId = testId;
