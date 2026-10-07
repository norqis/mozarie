"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

async function withRenameFixture(run, clientKey = null) {
  const fixture = await startFixtureServer();
  let browser; let context;
  try {
    browser = await chromium.launch();
    context = await browser.newContext();
    const project = { id: "rename-project", name: "Rename", status: "working" };
    const sources = [{ id: "database-source", kind: "browser-files", identity: "browser:client-source" }];
    let images = [{ id: "image-1", relativePath: "source.png", editedFilename: "renamed.png", sourceKind: "session", sourceId: sources[0].id, width: 1, height: 1, candidateRevision: 0, hasEffectiveMask: true }];
    const publish = (value) => { images = value; fixture.setCatalog(value); };
    publish(images);
    const snapshot = () => ({ images, project, sources, root: "", catalogGeneration: 1, historyDurable: false, readOnly: false });
    await context.route("**/api/images", (route) => route.fulfill({ json: snapshot() }));
    await context.addInitScript(() => {
      window.showDirectoryPicker = async () => { throw new Error("rename recovery must not open a picker"); };
    });
    const open = async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.settings && state.project?.id === "rename-project");
      return page;
    };
    const page = await open();
    const metadata = await page.evaluate(async (clientKey) => {
      const parent = await navigator.storage.getDirectory();
      const handle = await parent.getFileHandle("source.png", { create: true });
      const output = await handle.createWritable();
      await output.write(await (await fetch("/api/image/image-1")).blob()); await output.close();
      const file = await handle.getFile();
      const access = { fileHandle: handle, parentHandle: parent, sourceId: "client-source", clientKey, relativePath: "source.png", sourceKind: "browser-files", name: "source.png", size: file.size, lastModified: file.lastModified };
      state.sourceAccess.set("image-1", access);
      await rememberProjectSource(state.project.id, handle, "image-1", access.sourceId, clientKey, access.relativePath, parent);
      state.settings.confirmations.overwriteSource = false;
      document.querySelector("#applyOutputFormat").value = "original";
      const metadata = { sizeBytes: file.size, mtimeNs: file.lastModified * 1000000 };
      Object.assign(state.images[0], metadata);
      return metadata;
    }, clientKey);
    Object.assign(images[0], metadata); publish(images);
    await run({ page, context, open, project, snapshot, publish, image: images[0] });
  } finally {
    await context?.close();
    await browser?.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
}

async function startOverwrite(page, mode, format = "original") {
  if (mode === "single") {
    await page.evaluate(async () => { await selectImage("image-1"); await openSingleSaveDialog(); });
    await page.locator("#singleSaveOverwriteMode").check();
    await page.locator("#singleSaveOutputFormat").selectOption(format);
    await page.locator("#singleSaveStartButton").click();
  } else {
    await page.evaluate((format) => { document.querySelector("#applyOutputFormat").value = format; }, format);
    await page.evaluate(() => { window.saveResult = runBrowserSave(["image-1"], "", false, "overwrite").catch((error) => { window.saveError = error.code; }); });
  }
}

function renameRecoveryScenario(mode, format) {
  return async () => {
    await withRenameFixture(async ({ page, context, open, project, snapshot, publish, image }) => {
      const targetName = format === "jpg" ? "renamed.jpg" : "renamed.png";
      let notifyAck; const receivedAck = new Promise((resolve) => { notifyAck = resolve; });
      let holdAck = true;
      await context.route("**/api/save/commit", async (route) => {
        publish([{ ...image, relativePath: targetName, editedFilename: null }]);
        await route.fulfill({ json: { cleared: true, stale: false, sourceAction: "overwrite", relativePath: targetName, editedFilename: null } });
      });
      await context.route("**/api/save/ack", async (route) => {
        if (holdAck) { notifyAck(); return; }
        await route.fulfill({ json: { acknowledged: true } });
      });
      await context.route("**/api/save/status", (route) => route.fulfill({ json: { state: "committed", sourceAction: "overwrite" } }));
      await startOverwrite(page, mode, format);
      await receivedAck;
      const pending = await page.evaluate(async () => (await rememberedProjectSources(state.project.id)).files.map((source) => ({ path: source.relativePath, pending: !source.imageId, parent: source.parentHandle?.kind, clientKey: source.clientKey })));
      assert.ok(pending.some((row) => row.path === targetName && !row.pending && row.parent === "directory" && row.clientKey), "new handle is finalized before commit acknowledgement, including legacy rows without clientKey");
      const committedImage = { ...image, relativePath: targetName, editedFilename: null };
      await page.close(); holdAck = false;
      if (mode === "single") publish([]);
      page = await open();
      if (mode === "batch") {
        await page.waitForFunction((name) => state.sourceAccess.get("image-1")?.fileHandle?.name === name, targetName);
      } else {
        // A restarted backend needs the bytes imported again. Its restore API
        // accepts only the relative path already committed in the workspace.
        await context.route("**/api/project/open", (route) => route.fulfill({ json: { ...snapshot(), images: [], needsSource: true } }));
        await context.route("**/api/import/start", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
        await context.route("**/api/import/finish", (route) => route.fulfill({ json: { catalogGeneration: 1 } }));
        await context.route("**/api/import/file", async (route) => {
          const headers = route.request().headers();
          const path = decodeURIComponent(headers["x-mozarie-relative-path"]);
          assert.equal(headers["x-mozarie-import-intent"], "restore");
          const imported = path === targetName ? [{ imageId: "image-1", clientKey: decodeURIComponent(headers["x-mozarie-client-key"]) }] : [];
          if (path === "source.png") {
            const staged = await page.evaluate(async () => (await rememberedProjectSources(state.project.id)).files.filter((row) => !row.imageId).map((row) => row.relativePath));
            assert.deepEqual(staged, [targetName], "restoring the old row cannot overwrite the committed replacement pending handle");
          }
          if (imported.length) publish([committedImage]);
          await route.fulfill({ json: { ...snapshot(), imported } });
        });
        await page.evaluate((project) => openProject(project), project);
      }
      assert.deepEqual(await page.evaluate(async () => {
        const access = state.sourceAccess.get("image-1");
        const file = await access.fileHandle.getFile();
        return { path: access.relativePath, name: file.name, parent: access.parentHandle?.kind, size: file.size > 0, rows: (await rememberedProjectSources(state.project.id)).files.filter((source) => source.imageId === "image-1").map((source) => source.relativePath) };
      }), { path: targetName, name: targetName, parent: "directory", size: true, rows: [targetName] });
    }, mode === "single" ? "existing-client-key" : null);
  };
}

test("single renamed overwrite survives closing the tab after server commit", { timeout: 60000 }, renameRecoveryScenario("single", "original"));
test("batch renamed overwrite survives closing the tab after server commit", { timeout: 60000 }, renameRecoveryScenario("batch", "original"));
test("single renamed overwrite survives closing the tab after server commit using JPG", { timeout: 60000 }, renameRecoveryScenario("single", "jpg"));
test("batch renamed overwrite survives closing the tab after server commit using JPG", { timeout: 60000 }, renameRecoveryScenario("batch", "jpg"));

test("rejected renamed overwrite removes pending access and preserves the original handle", { timeout: 60000 }, async () => {
  await withRenameFixture(async ({ page, context }) => {
    await context.route("**/api/save/commit", (route) => route.fulfill({ status: 400, json: { error_code: "stale_asset" } }));
    await startOverwrite(page, "batch");
    await page.evaluate(() => window.saveResult);
    const result = await page.evaluate(async () => {
      const parent = await navigator.storage.getDirectory();
      const names = []; for await (const handle of parent.values()) names.push(handle.name);
      return { names, rows: (await rememberedProjectSources(state.project.id)).files.map((row) => ({ imageId: row.imageId, path: row.relativePath })), error: window.saveError, saving: state.saving };
    });
    assert.deepEqual(result, { names: ["source.png"], rows: [{ imageId: "image-1", path: "source.png" }], error: "stale_asset", saving: false });
  });
});

test("renamed overwrite does not commit when storing the replacement handle fails", { timeout: 60000 }, async () => {
  await withRenameFixture(async ({ page, context }) => {
    let commits = 0;
    await context.route("**/api/save/commit", (route) => { commits += 1; return route.fulfill({ json: { cleared: true } }); });
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
        if (stores === "projectSources" && mode === "readwrite") {
          IDBDatabase.prototype.transaction = transaction;
          throw new DOMException("fixture storage failure", "QuotaExceededError");
        }
        return transaction.call(this, stores, mode, ...rest);
      };
    });
    await startOverwrite(page, "batch"); await page.evaluate(() => window.saveResult);
    assert.equal(commits, 0);
    assert.deepEqual(await page.evaluate(async () => {
      const parent = await navigator.storage.getDirectory(); const names = [];
      for await (const handle of parent.values()) names.push(handle.name);
      return { names, error: window.saveError, saving: state.saving };
    }), { names: ["source.png"], error: "project_source_unavailable", saving: false });
  });
});

function restoreDuringOverwriteScenario(format, { sameName = false, denied = false } = {}) {
  return async () => {
    await withRenameFixture(async ({ page, context, snapshot, publish, image }) => {
      const targetName = sameName ? "source.png" : format === "jpg" ? "renamed.jpg" : "renamed.png";
      if (sameName) {
        image.editedFilename = null;
        await page.evaluate(() => { state.images[0].editedFilename = null; });
      }
      const other = await page.evaluate(async () => {
        const parent = await navigator.storage.getDirectory();
        const handle = await parent.getFileHandle("untouched.png", { create: true });
        const output = await handle.createWritable();
        await output.write(await (await fetch("/api/image/image-1")).blob()); await output.close();
        const file = await handle.getFile();
        await rememberProjectSource(state.project.id, handle, "image-2", "client-source", "unrelated", "untouched.png", parent);
        const other = { ...state.images[0], id: "image-2", relativePath: "untouched.png", editedFilename: null, sizeBytes: file.size, mtimeNs: file.lastModified * 1000000 };
        state.images.push(other); return other;
      });
      publish([image, other]);
      await context.route("**/api/save/commit", async (route) => {
        publish([{ ...image, relativePath: targetName, editedFilename: null }, other]);
        await route.fulfill({ json: { cleared: true, stale: false, sourceAction: "overwrite", relativePath: targetName, editedFilename: null } });
      });
      await context.route("**/api/save/ack", (route) => route.fulfill({ json: { acknowledged: true } }));
      await page.evaluate(async ({ sources, denied }) => {
        await restoreBrowserProjectSourcesForCurrentCatalog(sources);
        state.sourceAccess.delete("image-2");
        const query = FileSystemFileHandle.prototype.queryPermission;
        FileSystemFileHandle.prototype.queryPermission = async function (...args) {
          FileSystemFileHandle.prototype.queryPermission = query;
          await new Promise((resolve) => { window.releaseOldRestore = resolve; });
          return denied ? "denied" : query.apply(this, args);
        };
        window.oldSourceRestore = restoreBrowserProjectSourcesForCurrentCatalog(sources);
      }, { sources: snapshot().sources, denied });
      await page.waitForFunction(() => typeof window.releaseOldRestore === "function");
      await startOverwrite(page, "batch", format);
      await page.evaluate(() => window.saveResult);
      assert.equal(await page.evaluate(() => state.sourceAccess.get("image-1")?.fileHandle.name), targetName);
      await page.evaluate(async () => { window.releaseOldRestore(); await window.oldSourceRestore; });
      assert.deepEqual(await page.evaluate(async () => {
        const access = state.sourceAccess.get("image-1");
        let readError = null; let size = 0;
        try { size = (await access.fileHandle.getFile()).size; } catch (error) { readError = error.name; }
        const file = readError ? null : await access.fileHandle.getFile();
        const names = []; for await (const handle of (await navigator.storage.getDirectory()).values()) names.push(handle.name);
        return { image: state.images[0].relativePath, path: access.relativePath, handle: access.fileHandle.name, readable: size > 0, readError,
          metadataCurrent: file && access.size === file.size && access.lastModified === file.lastModified,
          stored: (await rememberedProjectSources(state.project.id)).files.filter((row) => row.imageId === "image-1").map((row) => row.relativePath), saving: state.saving,
          unrelated: state.sourceAccess.get("image-2")?.fileHandle.name, pending: pendingBrowserProjectSources.length, names: names.sort() };
      }), { image: targetName, path: targetName, handle: targetName, readable: true, readError: null, metadataCurrent: true, stored: [targetName], saving: false,
        unrelated: "untouched.png", pending: 0, names: [targetName, "untouched.png"].sort() });
    }, "restore-race");
  };
}

test("background source restore preserves a concurrent renamed overwrite", { timeout: 60000 }, restoreDuringOverwriteScenario("original"));
test("background source restore preserves a concurrent JPG overwrite", { timeout: 60000 }, restoreDuringOverwriteScenario("jpg"));
test("background source restore preserves same-name overwrite metadata and unrelated handles", { timeout: 60000 }, restoreDuringOverwriteScenario("original", { sameName: true }));
test("background source restore drops an obsolete permission prompt after overwrite", { timeout: 60000 }, restoreDuringOverwriteScenario("original", { denied: true }));
