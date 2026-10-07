"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

async function cancelNestedScan(mode) {
  const fixture = await startFixtureServer(); fixture.setCatalog([]);
  const browser = await chromium.launch(); const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const uploads = []; const errors = [];
  page.on("request", (request) => { if (/\/api\/import\/(start|file)$/.test(new URL(request.url()).pathname)) uploads.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && !state.importing && state.images.length === 0);
    await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      const root = await storage.getDirectoryHandle("scan-root", { create: true });
      const nested = await root.getDirectoryHandle("nested", { create: true });
      const file = await nested.getFileHandle("image.png", { create: true });
      const scan = window.scan = { rootReads: 0, childReads: 0, rootClosed: 0, childClosed: 0, held: false };
      const gate = new Promise((resolve) => { scan.release = resolve; });
      const values = FileSystemDirectoryHandle.prototype.values;
      FileSystemDirectoryHandle.prototype.values = async function* () {
        if (this.name === root.name) {
          try { scan.rootReads++; yield nested; scan.rootReads++; yield file; }
          finally { scan.rootClosed++; }
        } else if (this.name === nested.name) {
          try {
            for (let index = 0; index < 1000; index++) {
              scan.childReads++;
              if (!index) { scan.held = true; await gate; }
              yield file;
            }
          } finally { scan.childClosed++; }
        } else yield* values.call(this);
      };
      window.scanRoot = root;
      window.showDirectoryPicker = async () => root;
    });
    if (mode === "picker") {
      await page.locator("#pickFolder").click();
      await page.locator("#pickFolderFiles").click();
    } else if (mode === "drop") {
      await page.evaluate(() => {
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], items: [{ kind: "file", getAsFile: () => null, getAsFileSystemHandle: () => Promise.resolve(window.scanRoot) }] } });
        document.querySelector("#gallery").dispatchEvent(event);
      });
    } else {
      await page.evaluate(() => { void importProjectDirectoryHandle(window.scanRoot, "scan-project", "scan-source"); });
    }
    await page.waitForFunction(() => window.scan.held);
    assert.equal(await page.locator("#processingDialog").isVisible(), true, "scanning exposes progress and cancellation");
    assert.equal(await page.locator("#processingCancelButton").isVisible(), true);
    await page.locator("#processingCancelButton").click();
    assert.equal(await page.evaluate(() => state.importSession.cancelled), true);
    await page.evaluate(() => window.scan.release());
    await page.waitForFunction(() => !state.importing && state.importSession === null);
    assert.deepEqual(await page.evaluate(() => ({ root: scan.rootReads, child: scan.childReads, rootClosed: scan.rootClosed, childClosed: scan.childClosed })),
      { root: 1, child: 1, rootClosed: 1, childClosed: 1 }, "cancellation unwinds every directory without fetching siblings");
    assert.deepEqual(uploads, [], "a cancelled scan never starts or uploads an import");
    assert.equal(await page.locator("#pickFolder").isEnabled(), true);
    assert.equal(await page.locator("#processingDialog").isVisible(), false);
    assert.equal(await page.locator("#errorDialog").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(() => { if (state.importSession) state.importSession.cancelled = true; window.scan?.release(); }).catch(() => {});
    await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
}

test("folder picker cancellation stops nested enumeration before reading more siblings", { timeout: 30000 }, async () => cancelNestedScan("picker"));
test("dropped folder scanning exposes progress and cancels without uploading partial entries", { timeout: 30000 }, async () => cancelNestedScan("drop"));
test("project directory reconnect cancellation releases every active iterator", { timeout: 30000 }, async () => cancelNestedScan("project"));


async function controlPendingImportStart(action) {
  const fixture = await startFixtureServer(); fixture.setCatalog([]);
  const browser = await chromium.launch(); const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  let release; let started; const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { started = resolve; });
  let uploads = 0; const finishes = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/import/finish") finishes.push(request.postDataJSON()); });
  await page.route("**/api/import/start", async (route) => { started(); await gate; await route.fulfill({ json: { catalogGeneration: route.request().postDataJSON().expectedCatalogGeneration } }); });
  await page.route("**/api/import/file", async (route) => { uploads++; await route.fulfill({ json: { imported: [] } }); });
  try {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && !state.importing && state.images.length === 0);
    await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      const root = await storage.getDirectoryHandle("start-race", { create: true });
      const handle = await root.getFileHandle("image.png", { create: true });
      const blob = await (await fetch("/api/image/fixture")).blob();
      const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
      window.showDirectoryPicker = async () => root;
    });
    await page.locator("#pickFolder").click(); await page.locator("#pickFolderFiles").click();
    await reached;
    if (action === "pause") {
      await page.locator("#processingPauseButton").click();
      release();
      await page.waitForFunction(() => state.importSession?.total === 1 || !state.importing);
      assert.deepEqual(await page.evaluate(() => ({ paused: state.importSession?.paused, display: state.processing?.state })),
        { paused: true, display: "paused" }, "server preparation preserves pause state and its visible controls");
      assert.equal(uploads, 0);
      await page.locator("#processingPauseButton").click();
    } else {
      await page.locator("#processingCancelButton").click();
      assert.equal(await page.evaluate(() => state.importSession.cancelled), true);
      release();
    }
    await page.waitForFunction(() => !state.importing && state.importSession === null);
    assert.equal(uploads, action === "pause" ? 1 : 0, "server preparation retains cancellation and permits uploads only after resume");
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].cancelled, action === "cancel");
    assert.equal(await page.locator("#errorDialog").isVisible(), false);
    assert.equal(await page.locator("#pickFolder").isEnabled(), true);
    assert.equal(await page.locator("#processingDialog").isVisible(), false);
  } finally {
    release(); await context.close(); await browser.close(); fixture.server.closeAllConnections(); await closeServer(fixture.server);
  }
}

test("cancelling folder import while its server session starts prevents file uploads", { timeout: 30000 }, async () => controlPendingImportStart("cancel"));
test("pausing folder import while its server session starts preserves the paused controls", { timeout: 30000 }, async () => controlPendingImportStart("pause"));
