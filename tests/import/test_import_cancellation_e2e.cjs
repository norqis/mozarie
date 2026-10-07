"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { appendBrowserCoverage, closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function withFixture(run) {
  const fixture = await startFixtureServer();
  let browser; let context; let page; let coverageStarted = false;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    if (process.env.MOZARIE_JS_COVERAGE === "1") {
      await page.coverage.startJSCoverage({ resetOnNavigation: false }); coverageStarted = true;
    }
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.job && state.images.length === 2);
    const initialImages = await page.evaluate(() => structuredClone(state.images));
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
      window.__importHandles = [];
      for (const name of ["first.png", "second.png", "unstarted.png"]) {
        const handle = await root.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes); await writable.close();
        window.__importHandles.push(handle);
      }
      window.__selectedImportHandles = window.__importHandles;
      window.showOpenFilePicker = async () => window.__selectedImportHandles;
      state.settings.importing.parallelism = 2;
    });
    await run({ fixture, page, initialImages });
  } finally {
    try {
      if (coverageStarted && process.env.MOZARIE_BROWSER_COVERAGE_FILE) {
        await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, await page.coverage.stopJSCoverage());
      }
      if (page && !page.isClosed()) await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        for (const handle of window.__importHandles || []) await root.removeEntry(handle.name);
      });
    } finally {
      await context?.close(); await browser?.close(); await closeServer(fixture.server);
    }
  }
}

async function holdUploads(page) {
  const uploads = [];
  const waiters = [];
  await page.route("**/api/import/file", (route) => {
    uploads.push(route);
    for (const waiter of waiters) if (uploads.length >= waiter.count) waiter.ready.resolve();
  });
  return {
    uploads,
    waitForCount(count) {
      if (uploads.length >= count) return Promise.resolve();
      const ready = deferred(); waiters.push({ count, ready }); return ready.promise;
    },
    async complete(index, imageId) {
      const route = uploads[index]; const headers = route.request().headers();
      await route.fulfill({ json: {
        imported: [{ imageId, clientKey: decodeURIComponent(headers["x-mozarie-client-key"]) }],
        catalogGeneration: Number(headers["x-mozarie-expected-catalog-generation"]),
      } });
    },
    async fail(index, errorCode = "image_read_failed", status = 400) {
      await uploads[index].fulfill({ status, json: { error_code: errorCode } });
    },
  };
}

async function chooseFiles(page) {
  await page.locator("#pickFolder").click();
  await page.locator("#pickImages").click();
}

async function assertReleased(page) {
  await page.waitForFunction(() => !state.importing && state.importSession === null);
  assert.equal(await page.locator("#processingDialog").isVisible(), false);
  assert.equal(await page.locator("#importFailuresDialog").isVisible(), false);
  assert.equal(await page.locator("#errorDialog").isVisible(), false);
  for (const selector of ["#pickFolder", "#detectAllButton", "#saveAllButton", "#settingsButton"]) {
    assert.equal(await page.locator(selector).isEnabled(), true, `${selector} becomes usable after cancellation`);
  }
}

function importedImage(id, relativePath) {
  return { id, relativePath, sourceKind: "session", width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false };
}

test("cancelled parallel import shows committed images, retains source handles and stops unstarted files", { timeout: 30000 }, async () => {
  await withFixture(async ({ fixture, page, initialImages }) => {
    const pending = await holdUploads(page);
    await chooseFiles(page); await pending.waitForCount(2);
    await page.locator("#processingPauseButton").click();
    const first = importedImage("added-first", "first.png");
    const second = importedImage("added-second", "second.png");
    fixture.setCatalog([...initialImages, first]);
    await pending.complete(0, first.id);
    await page.waitForFunction(() => state.sourceAccess.has("added-first") && state.importSession.completed === 1);
    await page.locator("#processingCancelButton").click();
    fixture.setCatalog([...initialImages, first, second]);
    await pending.complete(1, second.id);
    await assertReleased(page);

    assert.equal(pending.uploads.length, 2, "cancellation never starts the third file");
    assert.deepEqual(fixture.catalogImageIds(), ["sample", "sample-two", "added-first", "added-second"]);
    assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), fixture.catalogImageIds());
    const sourceAccess = await page.evaluate(async () => ({
      first: await state.sourceAccess.get("added-first").fileHandle.isSameEntry(window.__importHandles[0]),
      second: await state.sourceAccess.get("added-second").fileHandle.isSameEntry(window.__importHandles[1]),
      sourceIds: [...state.sourceAccess.keys()],
      cancelledStatus: document.querySelector("#connectionStatus").textContent === t("status.importCancelled", { completed: 2 }),
    }));
    assert.deepEqual(sourceAccess, { first: true, second: true, sourceIds: ["added-first", "added-second"], cancelledStatus: true });
  });
});

test("cancelling before any upload commits refreshes the catalog and releases import controls", { timeout: 30000 }, async () => {
  await withFixture(async ({ page, initialImages }) => {
    await page.evaluate(() => { state.settings.importing.parallelism = 1; });
    const pending = await holdUploads(page);
    let refreshes = 0;
    await page.route("**/api/images", async (route) => { refreshes += 1; await route.continue(); });
    await chooseFiles(page); await pending.waitForCount(1);
    await page.locator("#processingCancelButton").click();
    await pending.fail(0);
    await assertReleased(page);
    assert.equal(refreshes, 1, "even a zero-commit cancellation reconciles with the authoritative catalog");
    assert.equal(pending.uploads.length, 1);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), initialImages.map((image) => image.id));
    assert.deepEqual(await page.evaluate(() => [...state.sourceAccess.keys()]), []);
  });
});

async function replaceCatalog(page, replaceSession) {
  await page.evaluate((replaceSession) => {
    const oldSession = state.importSession;
    window.__supersededSession = oldSession;
    window.__supersededCompleted = oldSession.completed;
    if (replaceSession) finishImportSession(oldSession);
    else beginCatalogEpoch();
    const replacement = {
      images: [{ id: "replacement", relativePath: "replacement.png", sourceKind: "session", width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0 }],
      catalogGeneration: state.serverCatalogGeneration + 1,
      project: { id: "replacement-project", name: "Replacement", status: "working" }, readOnly: false,
    };
    catalogResponse(replacement);
    resetCatalog(replacement.images, "G:/replacement");
    window.__replacementGeneration = state.serverCatalogGeneration;
    window.__clearedOldSources = state.sourceAccess.size === 0;
    state.sourceAccess.set("replacement", { fileHandle: window.__importHandles[2] });
    closeProcessing();
    if (replaceSession) window.__replacementSession = beginImportSession();
    setStatus("replacement catalog ready");
  }, replaceSession);
}

async function assertReplacementPreserved(page) {
  assert.deepEqual(await page.evaluate(() => ({
    images: state.images.map((image) => image.id),
    projectId: state.project?.id,
    sources: [...state.sourceAccess.keys()],
    generationUnchanged: state.serverCatalogGeneration === window.__replacementGeneration,
    completedUnchanged: window.__supersededSession.completed === window.__supersededCompleted,
    clearedOldSources: window.__clearedOldSources,
    status: document.querySelector("#connectionStatus").textContent,
    errorOpen: document.querySelector("#errorDialog").open,
    processingOpen: document.querySelector("#processingDialog").open,
  })), {
    images: ["replacement"], projectId: "replacement-project", sources: ["replacement"],
    generationUnchanged: true, completedUnchanged: true, clearedOldSources: true,
    status: "replacement catalog ready", errorOpen: false, processingOpen: false,
  });
  assert.deepEqual(await page.locator(".gallery-item").evaluateAll((items) => items.map((item) => item.dataset.id)), ["replacement"]);
}

for (const failed of [false, true]) {
  test(`${failed ? "failed" : "completed"} import ignores a catalog response after ${failed ? "session replacement" : "epoch change"}`, { timeout: 30000 }, async () => {
    await withFixture(async ({ fixture, page, initialImages }) => {
      await page.evaluate(() => { window.__selectedImportHandles = window.__importHandles.slice(0, 2); state.settings.importing.parallelism = 1; });
      const pending = await holdUploads(page);
      const catalogReady = deferred();
      await page.route("**/api/images", async (route) => {
        const response = await route.fetch(); const snapshot = await response.json();
        // A complete response from a changed server catalog exercises the real
        // resetCatalog/sourceAccess cleanup if the stale response is applied.
        snapshot.catalogGeneration += 1;
        catalogReady.resolve({ route, snapshot });
      });
      await chooseFiles(page); await pending.waitForCount(1);
      fixture.setCatalog([...initialImages, importedImage("added-first", "first.png")]);
      await pending.complete(0, "added-first"); await pending.waitForCount(2);
      if (failed) await pending.fail(1, "internal_error", 500);
      else await pending.complete(1, "added-second");
      const stale = await catalogReady.promise;
      assert.equal(await page.evaluate(() => state.sourceAccess.has("added-first")), true);
      await replaceCatalog(page, failed);
      const finished = page.waitForRequest("**/api/import/finish");
      await stale.route.fulfill({ json: stale.snapshot }); await finished;
      await page.waitForFunction((hasReplacement) => hasReplacement ? state.importSession === window.__replacementSession : !state.importing, failed);
      await assertReplacementPreserved(page);
      if (failed) await page.evaluate(() => finishImportSession(window.__replacementSession));
    });
  });
}

test("successful upload from a replaced session cannot attach its source to the new project", { timeout: 30000 }, async () => {
  await withFixture(async ({ page }) => {
    await page.evaluate(() => { state.settings.importing.parallelism = 1; });
    const pending = await holdUploads(page);
    await chooseFiles(page); await pending.waitForCount(1);
    await replaceCatalog(page, true);
    const finished = page.waitForRequest("**/api/import/finish");
    await pending.complete(0, "stale-import"); await finished;
    await assertReplacementPreserved(page);
    assert.deepEqual(await page.evaluate(async () => {
      const db = await directoryCatalogStore();
      try { return (await projectSourceRows(db, "replacement-project")).map((source) => source.imageId); }
      finally { db.close(); }
    }), [], "the old source handle is not persisted against the replacement project");
    assert.equal(pending.uploads.length, 1);
    await page.evaluate(() => finishImportSession(window.__replacementSession));
  });
});

for (const errorCode of ["internal_error", "stale_catalog", "image_read_failed"]) {
  test(`${errorCode} upload from a replaced session does not request or apply a catalog resync`, { timeout: 30000 }, async () => {
    await withFixture(async ({ page }) => {
      await page.evaluate(() => { state.settings.importing.parallelism = 1; });
      const pending = await holdUploads(page);
      let refreshes = 0;
      await page.route("**/api/images", async (route) => { refreshes += 1; await route.continue(); });
      await chooseFiles(page); await pending.waitForCount(1);
      await replaceCatalog(page, true);
      const finished = page.waitForRequest("**/api/import/finish");
      await pending.fail(0, errorCode, errorCode === "stale_catalog" ? 409 : errorCode === "internal_error" ? 500 : 400); await finished;
      assert.equal(refreshes, 0);
      await assertReplacementPreserved(page);
      await page.evaluate(() => finishImportSession(window.__replacementSession));
    });
  });
}

test("source read failure from a replaced session leaves progress closed and the new catalog intact", { timeout: 30000 }, async () => {
  await withFixture(async ({ page }) => {
    await page.evaluate(() => {
      state.settings.importing.parallelism = 1;
      // File reads are a browser API boundary. Hold this real OPFS handle's
      // read until the original import no longer owns the catalog.
      Object.defineProperty(window.__importHandles[0], "getFile", { configurable: true, value: () => new Promise((resolve, reject) => {
        window.__rejectSourceRead = () => reject(new DOMException("source unavailable", "NotReadableError"));
      }) });
    });
    const pending = await holdUploads(page);
    await chooseFiles(page);
    await page.waitForFunction(() => typeof window.__rejectSourceRead === "function");
    await replaceCatalog(page, true);
    const finished = page.waitForRequest("**/api/import/finish");
    await page.evaluate(() => window.__rejectSourceRead()); await finished;
    await assertReplacementPreserved(page);
    assert.equal(pending.uploads.length, 0, "a superseded file-read failure never starts an upload");
    await page.evaluate(() => finishImportSession(window.__replacementSession));
  });
});
