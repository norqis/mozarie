const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { waitForAppStartup } = require("../helpers/app_startup.cjs");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    let page = await context.newPage();
    const errors = [];
    const startupFailures = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requestFailed = (request) => startupFailures.push(`${request.url()}: ${request.failure()?.errorText}`);
    const responseFailed = (response) => { if (response.status() >= 400) startupFailures.push(`${response.url()}: HTTP ${response.status()}`); };
    page.on("requestfailed", requestFailed);
    page.on("response", responseFailed);
    await page.addInitScript(() => { window.showDirectoryPicker = () => navigator.storage.getDirectory(); });
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    try { await waitForAppStartup(page); }
    catch (error) { throw new Error(`${error.message}\nStartup failures: ${JSON.stringify([...errors, ...startupFailures])}`, { cause: error }); }
    finally { page.off("requestfailed", requestFailed); page.off("response", responseFailed); }
    await page.waitForFunction(() => state.settings && state.images.length === 3);
    const browserSources = process.argv[3] ? JSON.parse(process.argv[3]) : null;
    const failure = process.argv[4];
    const progressTest = failure?.startsWith("progress");
    const writeFailure = failure === "progress-write-failure";
    const failed = failure && failure !== "chain" && (!progressTest || writeFailure);
    if (browserSources) {
      await page.evaluate(async ({ sources, mixed }) => {
        if (!mixed) await api("/api/catalog/remove", { method: "POST", body: JSON.stringify({ imageIds: state.images.map((image) => image.id) }) });
        await syncCatalogOnReturn();
        const root = await navigator.storage.getDirectory();
        const files = []; const items = [];
        for (const [name, base64] of Object.entries(sources)) {
          const handle = await root.getFileHandle(name, { create: true });
          const stream = await handle.createWritable();
          await stream.write(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
          await stream.close();
          const file = await handle.getFile(); files.push(file);
          items.push({ kind: "file", getAsFile: () => file, getAsFileSystemHandle: async () => handle });
        }
        const event = new DragEvent("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files, items } });
        document.querySelector("#gallery").dispatchEvent(event);
      }, { sources: browserSources, mixed: failure === "mixed-conflicts" });
      await page.waitForFunction((mixed) => !state.importing && state.images.length === (mixed ? 6 : 3)
        && state.images.filter((image) => image.sourceKind === "session").length === 3, failure === "mixed-conflicts");
    }
    if (failure === "mixed-conflicts") {
      let mutations = 0;
      page.on("request", (request) => { if (/\/api\/save\/(reserve|render|batch\/prepare)$/.test(new URL(request.url()).pathname)) mutations++; });
      const conflict = await page.evaluate(async () => {
        const ids = [state.images.find((image) => image.sourceKind === "filesystem" && image.relativePath === "03.png").id,
          state.images.find((image) => image.sourceKind === "session" && image.relativePath === "03.png").id];
        const prepared = await api("/api/save/prepare", { method: "POST", body: JSON.stringify({ imageIds: ids,
          divisor: 100, suffix: "", copyToDefault: false, numbering: { digits: 2, placement: "only" }, collectConflicts: true }) });
        const names = new Map(prepared.entries.map((entry) => [entry.imageId, entry.outputFilename]));
        const preparation = beginSaveSourcePreparation(ids, "overwrite", false, "original", names);
        await ensureSaveSources(ids, "overwrite", false, "original", preparation, names);
        try { await runBrowserSave(ids, "", false, "overwrite", false, prepared); }
        catch (error) { return { code: error.code, files: error.params.files }; }
      });
      assert.equal(conflict.code, "output_files_exist");
      assert.equal(conflict.files.split("\n").length, 2);
      assert.match(conflict.files, /01\.png/); assert.match(conflict.files, /02\.png/);
      assert.equal(mutations, 0); return;
    }
    const original = await page.evaluate(() => state.images.map((image) => ({ id: image.id, name: image.relativePath })));
    await page.locator("#overviewButton").click();
    await page.locator("#reorderImagesButton").click();
    await page.locator(".overview-item").first().click();
    await page.locator("#reorderLast").click();
    await page.locator("#reorderApply").click();
    await page.waitForFunction(() => !state.reorder);
    await page.locator("#closeOverviewButton").click();
    const order = [...original.slice(1), original[0]];
    if (["write", "restore-gap"].includes(failure)) {
      await page.evaluate(async () => {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle("02.png");
        const prototype = Object.getPrototypeOf(handle);
        const create = prototype.createWritable;
        let failed = false;
        prototype.createWritable = function (...args) {
          if (this.name === "02.png" && !failed) { failed = true; return Promise.reject(new DOMException("test write failure", "QuotaExceededError")); }
          return create.apply(this, args);
        };
      });
    }
    let pausedGap;
    if (["write-gap", "restore-gap", "create-gap"].includes(failure)) {
      const session = await context.newCDPSession(page);
      await session.send("Debugger.enable");
      pausedGap = new Promise((resolve) => session.once("Debugger.paused", resolve));
      await page.evaluate((mode) => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (value.saveToken?.startsWith("numbered-member:") && !window.__numberedGapStopped
            && ((mode === "write-gap" && value.written) || (mode === "restore-gap" && value.restored)
              || (mode === "create-gap" && value.creating && value.started && !value.existed))) {
            window.__numberedGapStopped = true;
            debugger;
          }
          return put.call(this, value, ...args);
        };
      }, failure);
    }
    let commitRoute;
    let requestedCommit;
    const commitRequested = new Promise((resolve) => { requestedCommit = resolve; });
    if (failure === "restart" || progressTest) {
      await page.route("**/api/save/batch/commit", async (route) => {
        commitRoute = route; requestedCommit();
      });
    }
    let prepareRoute; let prepared;
    const prepareRequested = new Promise((resolve) => { prepared = resolve; });
    const renderReady = [];
    const renderRequests = Array.from({ length: 3 }, () => new Promise((resolve) => renderReady.push(resolve)));
    let renderedRequests = 0;
    let ackRoute; let ackSeen;
    const cleanupRequested = new Promise((resolve) => { ackSeen = resolve; });
    if (progressTest) {
      await page.evaluate((parallelism) => { state.settings.saving.parallelism = parallelism; }, failure === "progress-serial" ? 1 : 2);
      await page.route("**/api/save/render", (route) => { renderReady[renderedRequests++](route); });
      await page.route("**/api/save/batch/prepare", (route) => { prepareRoute = route; prepared(); });
      await page.route("**/api/save/ack", (route) => { if (!ackRoute) { ackRoute = route; ackSeen(); } else return route.continue(); });
      if (browserSources) await page.evaluate(() => {
        const prototype = FileSystemFileHandle.prototype;
        const create = prototype.createWritable;
        window.__numberedWrites = { active: 0, peak: 0, starts: [], pending: [] };
        prototype.createWritable = async function (...args) {
          const writes = window.__numberedWrites;
          if (state.browserSave?.numberedProgress?.phase === "writing" && /^\d{2}\.png$/.test(this.name)) {
            writes.starts.push(this.name); writes.active++; writes.peak = Math.max(writes.peak, writes.active);
            try { await new Promise((resolve, reject) => writes.pending.push({ resolve, reject })); }
            finally { writes.active--; }
          }
          return create.apply(this, args);
        };
      });
    }
    await page.locator("#saveAllButton").click();
    await page.locator("#applyNumbering").check();
    await page.locator("#applyNumberingDigits").fill("2");
    await page.locator("#applyNumberingPlacement").selectOption("only");
    await page.locator("#applyOverwriteMode").check();
    await page.locator("#applyStartButton").click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    await page.locator("#confirmAccept").click();
    if (progressTest) {
      // Hold one rendered response at a time. Counts describe prepared images,
      // never durable saves, and advance without waiting for the final commit.
      for (let index = 0; index < 3; index++) {
        await page.waitForFunction((count) => state.browserSave?.numberedProgress?.completed === count, index);
        const snapshot = await page.evaluate(() => ({ completed: state.browserSave.completed,
          text: document.querySelector("#applyProgressText").textContent, value: document.querySelector("#applyProgress").value }));
        assert.equal(snapshot.completed, 0);
        assert.match(snapshot.text, new RegExp(`画像を準備中: ${index} / 3`));
        assert.equal(snapshot.value, index);
        const route = await renderRequests[index];
        await route.continue();
      }
      await prepareRequested;
      assert.match(await page.locator("#applyProgressText").textContent(), /保存先を準備中/);
      assert.equal(await page.locator("#applyProgress").getAttribute("value"), null);
      assert.equal(await page.locator("#applyPauseButton").isDisabled(), true);
      assert.equal(await page.locator("#applyCancelButton").isDisabled(), true);
      assert.deepEqual(await page.evaluate(async () => {
        await controlApply("pause"); await controlApply("cancel");
        return [state.browserSave.paused, state.browserSave.cancelled];
      }), [false, false]);
      await prepareRoute.continue();
      if (browserSources) {
        const parallelism = failure === "progress-serial" ? 1 : 2;
        await page.waitForFunction((count) => window.__numberedWrites.active === count, parallelism);
        assert.match(await page.locator("#applyProgressText").textContent(), /元画像へ書き込み中: 0 /);
        if (writeFailure) {
          await page.evaluate(() => window.__numberedWrites.pending.shift().reject(new DOMException("test disk full", "QuotaExceededError")));
          assert.equal(await page.evaluate(() => state.browserSave.numberedProgress.phase), "writing", "rollback waits for the other started write");
          assert.equal(await page.evaluate(() => window.__numberedWrites.active), 1);
          await page.evaluate(() => window.__numberedWrites.pending.shift().resolve());
        } else for (let index = 0; index < 3; index++) {
          await page.waitForFunction(() => window.__numberedWrites.pending.length > 0);
          await page.evaluate(() => window.__numberedWrites.pending.shift().resolve());
          if (index < 2) {
            await page.waitForFunction((count) => state.browserSave.numberedProgress.completed === count, index + 1);
            assert.match(await page.locator("#applyProgressText").textContent(), new RegExp(`元画像へ書き込み中: ${index + 1} / 3`));
          }
        }
        assert.equal(await page.evaluate(() => window.__numberedWrites.peak), parallelism);
      }
      if (!writeFailure) {
        await commitRequested;
        assert.match(await page.locator("#applyProgressText").textContent(), /保存を確定中/);
        assert.equal(await page.locator("#applyProgress").getAttribute("value"), null);
        assert.equal(await page.evaluate(() => state.browserSave.completed), 0);
        await commitRoute.continue();
        await cleanupRequested;
        assert.match(await page.locator("#applyProgressText").textContent(), /後処理中/);
        assert.equal(await page.locator("#applyProgress").getAttribute("value"), null);
        assert.equal(await page.evaluate(() => state.browserSave.completed), 0);
        await ackRoute.continue();
      }
    }
    if (failure === "restart" || pausedGap) {
      if (pausedGap) await pausedGap;
      else await commitRequested;
      // Freeze the renderer before dropping transport, so its catch handler
      // cannot roll back before this simulates the tab disappearing.
      if (!pausedGap) {
        const session = await context.newCDPSession(page);
        await session.send("Debugger.enable"); await session.send("Debugger.pause");
        await commitRoute.abort();
      }
      await page.close();
      page = await context.newPage();
      await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
      await waitForAppStartup(page);
      if (failure === "create-gap") {
        assert.equal(await page.evaluate(() => state.status?.key), "save.recoveryPending", JSON.stringify(await page.evaluate(() => ({ status: state.status, tokens: pendingSaveTokens() }))));
        const retained = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const batch = (await numberedSaveBatches())[0];
          const directory = await numberedSaveDirectory(batch.id);
          const originals = [];
          for (const member of batch.browser) originals.push((await (await directory.getFileHandle(`original-${member.entry.imageId}`)).getFile()).size);
          return { empty: (await (await root.getFileHandle("03.png")).getFile()).size, originals };
        });
        assert.equal(retained.empty, 0, "a slot with unrecorded ownership is retained for explicit recovery");
        assert.equal(retained.originals.length, 3);
        assert.ok(retained.originals.every((size) => size > 0));
        await page.evaluate(async () => {
          await (await navigator.storage.getDirectory()).removeEntry("03.png");
          await reconcilePendingBrowserSaves();
        });
      }
      await page.waitForFunction(() => state.settings && !Object.keys(pendingSaveTokens()).length);
    }
    await page.waitForFunction(() => !state.saveStarting && !state.applyRunning && !state.saving);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), failure === "write" || writeFailure,
      await page.locator("#errorDialogCause").textContent());
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => ({ id: image.id, name: image.relativePath }))),
      order.map((image, index) => ({ id: image.id, name: failed ? image.name : `${String(index + 1).padStart(2, "0")}.png` })));
    if (browserSources) {
      const actual = await page.evaluate(async (names) => {
        const root = await navigator.storage.getDirectory();
        const result = {};
        for (const name of names) {
          const file = await (await root.getFileHandle(name)).getFile();
          result[name] = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
        }
        return result;
      }, failed ? Object.keys(browserSources) : ["01.png", "02.png", "03.png"]);
      for (const [index, image] of order.entries()) assert.equal(actual[failed ? image.name : `${String(index + 1).padStart(2, "0")}.png`], browserSources[image.name]);
      assert.deepEqual(await page.evaluate(() => [...state.sourceAccess.values()].map((access) => access.fileHandle.name).sort()), (failed ? Object.keys(browserSources) : ["01.png", "02.png", "03.png"]).sort());
    }
    if (failure === "chain" && browserSources) assert.equal(await page.evaluate(async () => {
      try { await (await navigator.storage.getDirectory()).getFileHandle("05.png"); return true; }
      catch (error) { if (error.name === "NotFoundError") return false; throw error; }
    }), false);
    assert.deepEqual(await page.evaluate(() => Object.keys(pendingSaveTokens())), []);
    if (progressTest) {
      assert.equal(await page.locator("#applyProgress").getAttribute("value"), writeFailure ? "0" : "3");
      if (writeFailure) assert.equal(await page.evaluate(() => window.__numberedWrites.starts.length), 2, "a failed write starts no further member");
    }
    assert.deepEqual(errors, []);
    console.log("numbered overwrite complete");
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
