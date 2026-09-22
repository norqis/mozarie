"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function interaction() {
  const context = vm.createContext({
    window: new EventTarget(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/js/interaction.js"), "utf8"), context);
  return context;
}

test("drop snapshots every File and handle request before the transfer becomes protected", async () => {
  const context = interaction(); const calls = []; let readable = true;
  const files = [new File(["first"], "one.png"), new File(["second"], "two.png")];
  const transfer = { files, items: files.map((file, index) => ({ kind: "file",
    getAsFile() { assert.equal(readable, true); calls.push(`file${index}`); return file; },
    getAsFileSystemHandle() { assert.equal(readable, true); calls.push(`handle${index}`); return index ? Promise.reject(new Error("denied")) : Promise.resolve(null); },
  })) };
  const pending = context.directFilesFromDrop(transfer); readable = false;
  const dropped = await pending;
  assert.deepEqual(calls, ["file0", "handle0", "file1", "handle1"]);
  assert.deepEqual(Array.from(dropped.handleEntries, (entry) => entry.file), files);
  assert.ok(dropped.handleEntries.every((entry) => entry.fileHandle === null));
});

test("drop accepts unsupported handle APIs and FileList-only transfers", async () => {
  const context = interaction(); const file = new File(["image"], "plain.png");
  for (const transfer of [
    { files: [file] },
    { items: [{ kind: "file", getAsFile: () => file }] },
    { items: [{ kind: "file", getAsFile: () => file, getAsFileSystemHandle() { throw new Error("unavailable"); } }] },
  ]) {
    const result = await context.directFilesFromDrop(transfer);
    assert.equal(result.handleEntries.length, 1);
    assert.equal(result.handleEntries[0].file, file);
    assert.equal(result.handleEntries[0].relativePath, "plain.png");
  }
});

test("drop keeps native handles, nested relative paths, and each immediate parent", async () => {
  const context = interaction(); const file = new File(["image"], "root.png");
  const direct = { kind: "file", name: file.name };
  const nested = { kind: "file", name: "deep.png" };
  const directory = { kind: "directory", name: "folder", async *values() { yield nested; } };
  const result = await context.directFilesFromDrop({ items: [
    { kind: "file", getAsFile: () => file, getAsFileSystemHandle: () => Promise.resolve(direct) },
    { kind: "file", getAsFile: () => null, getAsFileSystemHandle: () => Promise.resolve(directory) },
  ] });
  assert.equal(result.handleEntries[0].handle, direct);
  assert.equal(result.handleEntries[0].file, file);
  assert.equal(result.handleEntries[1].handle, nested);
  assert.equal(result.handleEntries[1].relativePath, "folder/deep.png");
  assert.equal(result.handleEntries[1].parentHandle, directory);
});
