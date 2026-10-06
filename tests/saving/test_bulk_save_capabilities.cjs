"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

nodeTest("bulk save capabilities preserve filesystem browser handle missing and empty targets", (t) => {
  const requestPermission = t.mock.fn(async () => "denied");
  const queryPermission = t.mock.fn(async () => "denied");
  const state = {
    images: [
      { id: "local", sourceKind: "filesystem" },
      { id: "browser", sourceKind: "browser-files" },
      { id: "temporary", sourceKind: "session" },
      { id: "parent-only", sourceKind: "browser-files" },
    ],
    applyTargetIds: [],
    sourceAccess: new Map([
      ["browser", { fileHandle: { requestPermission, queryPermission } }],
      ["parent-only", { parentHandle: {} }],
      ["missing", { fileHandle: {} }],
    ]),
  };
  const runtime = vm.createContext({ state, window: new EventTarget(), localStorage: { length: 0, getItem: t.mock.fn(() => null) } });
  const filename = path.resolve(__dirname, "../../static/js/save.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), runtime, { filename });
  for (const capability of ["overwrite", "delete"]) {
    for (const format of ["original", "png", "jpg", "webp"]) {
      for (const [targets, expected] of [
        [[], true], [["local"], true], [["browser"], true], [["local", "browser"], true],
        [["local", "temporary"], false], [["parent-only"], false], [["missing"], false],
      ]) {
        state.applyTargetIds = targets;
        assert.equal(runtime.applyTargetsSupport(capability, format), expected, `${capability}/${format}: ${targets}`);
      }
    }
  }
  assert.equal(requestPermission.mock.callCount(), 0, "capability display does not request browser permission");
  assert.equal(queryPermission.mock.callCount(), 0, "a present handle remains eligible before permission is requested at save time");
  state.applyTargetIds = ["browser"];
  state.sourceAccess.delete("browser");
  assert.equal(runtime.applyTargetsSupport("overwrite"), false, "removed source access is reflected immediately");
  state.images = [{ id: "browser", sourceKind: "filesystem" }];
  assert.equal(runtime.applyTargetsSupport("overwrite"), true, "a replaced catalog is reflected without a stale index");
});

nodeTest("20k bulk save dialog and action locks keep capability lookup linear", { timeout: 180000 }, async (t) => {
  const count = 20000;
  const fixture = await startFixtureServer();
  let browser;
  let context;
  try {
    fixture.setCatalog(Array.from({ length: count }, (_, index) => ({
      id: `bulk-${index}`, relativePath: `image-${String(index).padStart(5, "0")}.png`,
      sourceKind: "filesystem", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0,
      reviewed: false, hidden: false,
    })));
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => state.settings && state.images.length === expected
      && state.serverCatalogGeneration !== null && !document.querySelector("#saveAllButton").disabled, count);
    await page.evaluate(() => {
      window.__bulkCapabilityIdReads = 0;
      for (const image of state.images) {
        const id = image.id;
        Object.defineProperty(image, "id", { configurable: true, enumerable: true, get() {
          window.__bulkCapabilityIdReads += 1;
          return id;
        } });
      }
    });

    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open && currentOutputDirectoryStatus() === "ready");
    const opened = await page.evaluate(() => ({ reads: window.__bulkCapabilityIdReads, targets: state.applyTargetIds.length }));
    assert.equal(opened.targets, count, "the visible save dialog includes every catalog image");
    assert.match(await page.locator("#applyTargetCount").textContent(), /20,?000/);
    assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), false);
    assert.equal(await page.locator("#applyStartButton").isDisabled(), false);
    assert.ok(opened.reads <= count * 50, `opening the dialog reads catalog IDs linearly: ${opened.reads} for ${count} images`);
    t.diagnostic(`20k save dialog ID reads: ${opened.reads}`);
    await page.locator("#applyOverwriteMode").check();

    for (const saving of [true, false]) {
      const reads = await page.evaluate((busy) => {
        state.saveStarting = busy;
        window.__bulkCapabilityIdReads = 0;
        syncApplyMode();
        updateActionButtons();
        return window.__bulkCapabilityIdReads;
      }, saving);
      assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), saving, "overwrite tracks the save-start lock");
      assert.equal(await page.locator("#applyStartButton").isDisabled(), saving, "save start tracks the save-start lock");
      assert.ok(reads <= count * 30, `action lock refresh reads catalog IDs linearly: ${reads} for ${count} images`);
      t.diagnostic(`20k save lock=${saving} ID reads: ${reads}`);
    }
    await page.evaluate(() => {
      state.images[state.images.length - 1].sourceKind = "browser-files";
      syncApplyMode();
      updateActionButtons();
    });
    assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), true, "one browser source without a handle blocks overwrite");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "selected overwrite cannot start with an unavailable source");
    await page.evaluate(async () => {
      const directory = await navigator.storage.getDirectory();
      const fileHandle = await directory.getFileHandle("bulk-source.png", { create: true });
      state.sourceAccess.set(state.images[state.images.length - 1].id, { fileHandle });
      syncApplyMode();
      updateActionButtons();
    });
    try {
      assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), false, "a browser handle restores eligibility in a mixed catalog");
      assert.equal(await page.locator("#applyStartButton").isDisabled(), false);
    } finally {
      await page.evaluate(async () => {
        const directory = await navigator.storage.getDirectory();
        await directory.removeEntry("bulk-source.png");
      });
    }
    await page.evaluate(async () => {
      state.sourceAccess.clear();
      syncApplyMode();
      updateActionButtons();
    });
    assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), true, "removing source access immediately disables overwrite again");
    await page.locator("#applyCloseButton").click();
    assert.equal(await page.locator("#applyDialog").evaluate((dialog) => dialog.open), false);
    assert.deepEqual(fixture.saveRequests, [], "display and lock changes do not save files");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    fixture.resetScenario();
    await closeServer(fixture.server);
  }
});
