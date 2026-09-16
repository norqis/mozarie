const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeTest = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "interaction.js"), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must exist`);
  return source.slice(start, end);
}

async function callsFrom(name, nextName, argument, failure = null) {
  const calls = [];
  const catalogApi = async (...args) => {
    calls.push(args);
    if (failure && calls.length === 1) throw failure;
    return { ok: true };
  };
  const fn = new Function("catalogApi", `${functionSource(name, nextName)}; return ${name};`)(catalogApi);
  await fn(argument);
  return calls;
}

nodeTest("source delete POST contracts", async () => {
  const payload = { imageIds: ["image-1"], deleteToken: "token-1" };
  for (const calls of [
    await callsFrom("commitSourceDeleteWithRetry", "claimSourceDelete", payload),
    await callsFrom("commitSourceDeleteWithRetry", "claimSourceDelete", payload, Object.assign(new Error("lost"), { code: "connection_lost" })),
    await callsFrom("claimSourceDelete", "releaseSourceDeleteClaim", "token-1"),
    await callsFrom("releaseSourceDeleteClaim", "acknowledgeSourceDelete", "token-1"),
  ]) {
    for (const [, , options] of calls) assert.deepEqual(options, { method: "POST" });
  }

  const prepare = source.match(/catalogApi\(\"\/api\/catalog\/delete-source\/prepare\",[^\n]*\{ method: \"POST\" \}\)/);
  assert.ok(prepare, "source-delete prepare must be POST");
});
