"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const origin = process.argv[2]; const mode = process.argv[3];
  const rename = mode.includes("rename"); const committed = mode.includes("committed");
  const browser = await chromium.launch(); const context = await browser.newContext();
  try {
    const open = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.settings && Number.isSafeInteger(state.serverCatalogGeneration) && !state.projectOperationPending);
      return page;
    };
    let page = await open();
    const original = await page.evaluate(async () => {
      const parent = await navigator.storage.getDirectory();
      const handle = await parent.getFileHandle("source.png", { create: true });
      const surface = document.createElement("canvas"); surface.width = 20; surface.height = 20;
      const draw = surface.getContext("2d"); draw.fillStyle = "red"; draw.fillRect(0, 0, 10, 20); draw.fillStyle = "blue"; draw.fillRect(10, 0, 10, 20);
      const blob = await new Promise((resolve) => surface.toBlob(resolve));
      const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
      await importFileHandles([{ handle, parentHandle: parent }]);
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.waitForFunction(() => state.images.length === 1 && !state.importing);
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    await page.evaluate(() => openProjectNameDialog("name"));
    await page.locator("#projectNameInput").fill("Source recovery"); await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.id && !state.projectOperationPending);
    const project = await page.evaluate(() => state.project);
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("300"); await page.locator("#brushSize").dispatchEvent("input");
    const point = await page.evaluate(() => { const rect = canvas.getBoundingClientRect(); return { x: rect.left + state.view.x + 10 * state.view.scale, y: rect.top + state.view.y + 10 * state.view.scale }; });
    await page.mouse.click(point.x, point.y);
    await page.evaluate(async () => { await flushWorkspaceDraft(state.currentId); state.settings.confirmations.overwriteSource = false; });
    if (rename) {
      await page.keyboard.press("F2"); await page.locator("#renameImageFilename").fill("renamed.png"); await page.locator("#renameImageConfirm").click();
      await page.waitForFunction(() => !document.querySelector("#renameImageDialog").open);
    }
    const edits = await page.evaluate(async () => ({
      manual: await api(`/api/workspace/manual/${state.currentId}`),
      history: await api(`/api/project/history/${state.currentId}`),
    }));
    const start = async () => {
      if (mode.startsWith("batch")) {
        await page.locator("#saveAllButton").click(); await page.locator("#applyOverwriteMode").check(); await page.locator("#applyStartButton").click();
      } else {
        await page.locator("#saveButton").click(); await page.locator("#singleSaveOverwriteMode").check(); await page.locator("#singleSaveStartButton").click();
      }
    };
    const bytes = (name = "source.png") => page.evaluate(async (name) => [...new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).arrayBuffer())], name);
    let heldRoute; let token; let resolveCommit; let externalBytes;
    const externalName = rename && !committed ? "renamed.png" : "source.png";
    const atCommit = new Promise((resolve) => { resolveCommit = resolve; });
    if (mode.includes("idb-failure") || mode.includes("write-failure") || mode.includes("unrecorded")) {
      await page.evaluate((mode) => {
        if (mode.includes("write-failure")) {
          const create = FileSystemFileHandle.prototype.createWritable;
          window.sourceWriteCalls = 0;
          FileSystemFileHandle.prototype.createWritable = function (...args) {
            window.sourceWriteCalls += 1;
            if (window.sourceWriteCalls === 1) throw new DOMException("fixture write denied", "NotAllowedError");
            return create.apply(this, args);
          };
          return;
        }
        let puts = 0;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = put.apply(this, args);
          if (this.name === "sourceOverwrites" && ++puts === (mode.includes("unrecorded") ? 2 : 1)) {
            IDBObjectStore.prototype.put = put;
            request.addEventListener("success", () => this.transaction.abort(), { once: true });
          }
          return request;
        };
      }, mode);
      await start(); await page.waitForFunction(() => !state.saving && !state.saveStarting && document.querySelector("#errorDialog").open);
      if (mode.includes("unrecorded")) {
        const writtenBytes = await bytes(); assert.notDeepEqual(writtenBytes, original);
        assert.equal(await page.evaluate(() => reconcilePendingBrowserSaves()), false);
        assert.deepEqual(await bytes(), writtenBytes, "an unrecorded write is not overwritten on an uncertain recovery");
        assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 1);
        assert.deepEqual(await page.evaluate(async () => [...new Uint8Array(await (await browserOverwriteStore(Object.keys(pendingSaveTokens())[0])).snapshot.arrayBuffer())]), original);
        return;
      }
      if (mode.includes("write-failure")) assert.equal(await page.evaluate(() => window.sourceWriteCalls), 1, "unchanged originals are not rewritten by rollback");
      assert.deepEqual(await bytes(), original);
      await page.locator("#errorDialogClose").click(); await page.locator("#singleSaveCloseButton").click();
    } else {
      await context.route("**/api/save/commit", async (route) => {
        heldRoute = route; token = route.request().postDataJSON();
        if (committed) { const response = await route.fetch(); assert.equal(response.status(), 200); }
        resolveCommit();
      });
      await start(); await atCommit;
      assert.notDeepEqual(await bytes(rename ? "renamed.png" : "source.png"), original);
      const crashed = page.waitForEvent("crash"); const cdp = await context.newCDPSession(page);
      void cdp.send("Page.crash").catch(() => {}); await crashed;
      await heldRoute.abort("connectionfailed").catch(() => {}); await page.close();
      await context.unroute("**/api/save/commit");
      if (mode.includes("missing")) {
        const editor = await context.newPage();
        await editor.goto(`${origin}/i18n/en.json`, { waitUntil: "domcontentloaded" });
        await editor.evaluate(async (name) => (await navigator.storage.getDirectory()).removeEntry(name), committed ? "source.png" : "renamed.png");
        await editor.close();
      }
      if (mode.includes("external")) {
        const editor = await context.newPage();
        await editor.goto(`${origin}/i18n/en.json`, { waitUntil: "domcontentloaded" });
        externalBytes = await editor.evaluate(async (name) => {
          const parent = await navigator.storage.getDirectory(); const handle = await parent.getFileHandle(name);
          const surface = document.createElement("canvas"); surface.width = 30; surface.height = 30;
          const draw = surface.getContext("2d"); draw.fillStyle = "green"; draw.fillRect(0, 0, 30, 30);
          const blob = await new Promise((resolve) => surface.toBlob(resolve));
          const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
          return [...new Uint8Array(await blob.arrayBuffer())];
        }, externalName);
        await editor.close();
      }
      if (mode.includes("restart")) await context.request.post(`${origin}/fixture/restart`);
      if (mode.includes("restore-failure")) await context.addInitScript(() => {
        const create = FileSystemFileHandle.prototype.createWritable;
        window.allowRestore = () => { FileSystemFileHandle.prototype.createWritable = create; };
        FileSystemFileHandle.prototype.createWritable = function () { throw new DOMException("fixture permission failure", "NotAllowedError"); };
      });
      if (mode.includes("read-failure")) await context.addInitScript(() => {
        if (localStorage.getItem("fixtureIDBReady")) return;
        const open = indexedDB.open.bind(indexedDB);
        window.allowRestore = () => { indexedDB.open = open; localStorage.setItem("fixtureIDBReady", "1"); };
        indexedDB.open = () => {
          const request = {};
          queueMicrotask(() => request.onerror?.(new DOMException("fixture database unavailable", "VersionError")));
          return request;
        };
      });
      if (mode.includes("metadata-failure")) await context.route("**/api/save/cancel", (route) => route.request().postDataJSON().restoredSource
        ? route.fulfill({ status: 503, json: { error_code: "workspace_database_error" } }) : route.continue());
      if (mode.includes("delete-failure")) await context.addInitScript(() => {
        const remove = IDBObjectStore.prototype.delete;
        window.allowRestore = () => { IDBObjectStore.prototype.delete = remove; };
        IDBObjectStore.prototype.delete = function (...args) {
          if (this.name === "sourceOverwrites") throw new DOMException("fixture deletion failure", "UnknownError");
          return remove.apply(this, args);
        };
      });
      page = await open();
      await page.waitForFunction(async () => !(await navigator.locks.query()).held.some((lock) => lock.name === "mozarie-browser-save-ownership"));
      if (mode.includes("external")) {
        assert.equal(await page.evaluate(() => reconcilePendingBrowserSaves()), false);
        assert.deepEqual(await bytes(externalName), externalBytes, "recovery preserves a later edit instead of overwriting or deleting it");
        assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 1);
        assert.ok(await page.evaluate((token) => browserOverwriteStore(token), token.saveToken));
        if (committed) assert.equal(await page.evaluate(async (token) => (await api("/api/save/status", { method: "POST", body: JSON.stringify(token) })).state, token), "committed");
        return;
      }
      if (mode.includes("restore-failure") || mode.includes("read-failure") || mode.includes("delete-failure")) {
        await page.evaluate(() => reconcilePendingBrowserSaves());
        assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 1);
        assert.notDeepEqual(await bytes(), original);
        if (mode.includes("delete-failure")) {
          assert.equal(await page.evaluate(async (token) => (await api("/api/save/status", { method: "POST", body: JSON.stringify(token) })).state, token), "committed", "receipt is not acknowledged before backup deletion succeeds");
          assert.ok(await page.evaluate((token) => browserOverwriteStore(token), token.saveToken));
        }
        await page.evaluate(() => window.allowRestore());
      }
      let restoredMtime;
      if (mode.includes("metadata-failure")) {
        await page.evaluate(() => reconcilePendingBrowserSaves());
        assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 1);
        assert.deepEqual(await bytes(), original);
        restoredMtime = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("source.png")).getFile()).lastModified);
        await context.unroute("**/api/save/cancel");
      }
      if (mode.includes("two-tabs")) {
        const peer = await open();
        await Promise.all([page.evaluate(() => reconcilePendingBrowserSaves()), peer.evaluate(() => reconcilePendingBrowserSaves())]);
        await peer.close();
      } else await page.evaluate(() => reconcilePendingBrowserSaves());
      assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 0, JSON.stringify(await page.evaluate(() => ({ status: state.status, pending: pendingSaveTokens() }))));
      assert.equal(await page.evaluate((token) => browserOverwriteStore(token), token.saveToken), null);
      const names = await page.evaluate(async () => { const names = []; for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name); return names; });
      assert.deepEqual(names, [rename && committed ? "renamed.png" : "source.png"]);
      if (!committed) assert.deepEqual(await bytes(), original);
      if (restoredMtime !== undefined) assert.equal(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("source.png")).getFile()).lastModified), restoredMtime);
      if (mode.includes("restart")) await page.evaluate((project) => openProject(project), project);
      if (mode.includes("read-failure")) { await page.close(); page = await open(); }
    }
    // A second real UI save checks restored file timestamps, handles and edits.
    await page.waitForFunction(() => state.images.length === 1 && !state.importing && !state.projectOperationPending);
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId && state.sourceAccess.get(state.currentId)?.fileHandle);
    await page.evaluate(() => { state.settings.confirmations.overwriteSource = false; });
    assert.equal(await page.evaluate(() => currentRecord().hasEffectiveMask), true);
    if (!committed) assert.deepEqual(await page.evaluate(async () => ({
      manual: await api(`/api/workspace/manual/${state.currentId}`),
      history: await api(`/api/project/history/${state.currentId}`),
    })), edits, "rollback preserves the exact manual masks, revisions and undo/redo history");
    await start();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && !state.applyRunning);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, await page.locator("#errorDialog").textContent());
    assert.notDeepEqual(await bytes(rename ? "renamed.png" : "source.png"), original);
    assert.equal(await page.evaluate(() => Object.keys(pendingSaveTokens()).length), 0);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
