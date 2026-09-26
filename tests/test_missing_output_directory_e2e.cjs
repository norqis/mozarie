const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("./test_import_picker_e2e.cjs");

async function withPage(run, outputDirectoryState = "missing", outputDirectory = "G:\\fixture-output") {
  const fixture = await startFixtureServer({ outputDirectoryState, outputDirectory });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.__outputRequests = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, options = {}) => {
        const url = String(input?.url || input);
        const method = options.method || input?.method || "GET";
        if (method === "POST" && /\/api\/(?:output-directory|save|settings)/.test(url)) window.__outputRequests.push(url);
        return originalFetch(input, options);
      };
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2 && state.serverCatalogGeneration !== null);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage && !state.pendingImageId);
    await run(page, fixture);
  } finally {
    await context.close();
    await browser.close();
    await closeServer(fixture.server);
  }
}

test("an unusable copy destination reports the existing error without offering creation", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), false);
    assert.equal(fixture.saveRequests.length, 0);
    assert.equal(await page.evaluate(() => window.__outputRequests.filter((url) => url.includes("/api/output-directory/create")).length), 0);
  }, "unusable");
});

test("an existing copy destination saves directly without a creation prompt", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && window.__outputRequests.some((url) => url.includes("/api/save/prepare")));
    assert.equal(await page.locator("#confirmDialog").evaluate((dialog) => dialog.open), false);
    assert.ok(fixture.saveRequests.some((request) => request.path === "/api/save/prepare"));
    assert.equal(await page.evaluate(() => window.__outputRequests.filter((url) => url.includes("/api/output-directory/create")).length), 0);
  }, "ready");
});

test("reopening save refreshes a folder that disappeared after the previous visit", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveCloseButton").click();
    await page.route("**/api/output-directory/status", async (route) => {
      const path = await page.evaluate(() => state.settings.saving.default_output_directory);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path, state: "missing" }) });
    });
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.equal(fixture.saveRequests.length, 0);
    await page.locator("#confirmCancel").click();
    await page.unroute("**/api/output-directory/status");
  }, "ready");
});

test("creation confirmation keeps a long absolute destination readable inside the modal", { timeout: 30000 }, async () => {
  const longPath = `G:\\${"nested-folder-".repeat(22)}\\output`;
  await withPage(async (page) => {
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    const layout = await page.locator("#confirmMessage").evaluate((message) => ({
      text: message.textContent,
      scrollWidth: message.scrollWidth,
      clientWidth: message.clientWidth,
      whiteSpace: getComputedStyle(message).whiteSpace,
    }));
    assert.ok(layout.text.includes(longPath), "the exact destination is shown");
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, "the path wraps without extending beyond the confirmation content");
    assert.equal(layout.whiteSpace, "pre-line", "the path starts on its own line");
    await page.locator("#confirmCancel").click();
  }, "missing", longPath);
});

test("Cancel never asks for browser source permission or opens a directory picker", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.evaluate(() => {
      window.__permissionCalls = 0;
      window.__pickerCalls = 0;
      window.showDirectoryPicker = async () => { window.__pickerCalls += 1; return {}; };
      state.sourceAccess.set("sample", {
        fileHandle: {
          queryPermission: async () => { window.__permissionCalls += 1; return "prompt"; },
          requestPermission: async () => { window.__permissionCalls += 1; return "granted"; },
        },
      });
    });
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveDeleteOriginal").check();
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    await page.locator("#confirmCancel").click();
    await page.waitForFunction(() => !document.querySelector("#confirmDialog").open && !state.saveStarting);
    assert.deepEqual(await page.evaluate(() => ({ permission: window.__permissionCalls, picker: window.__pickerCalls })), { permission: 0, picker: 0 });
    assert.equal(fixture.saveRequests.length, 0);
  });
});

test("typing a missing destination and pressing Save once reaches creation confirmation", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveOutputDirectoryStatus").fill("G:\\new-copy-destination\\nested");
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /new-copy-destination/);
    assert.equal(fixture.saveRequests.length, 0);
    await page.locator("#confirmCancel").click();
  });
});

test("new ready path with browser-source deletion waits for a fresh Save gesture", { timeout: 30000 }, async () => {
  await withPage(async (page, fixture) => {
    await page.evaluate(() => {
      window.__pickerCalls = 0;
      window.showDirectoryPicker = async () => { window.__pickerCalls += 1; throw new DOMException("cancelled", "AbortError"); };
      state.sourceAccess.set("sample", { fileHandle: { queryPermission: async () => "prompt" } });
    });
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open && !document.querySelector("#singleSaveStartButton").disabled);
    await page.locator("#singleSaveDeleteOriginal").check();
    await page.locator("#singleSaveOutputDirectoryStatus").fill("G:\\ready-other");
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveResult").textContent.includes(t("apply.outputDirectoryReadyRetry")));
    assert.equal(await page.evaluate(() => window.__pickerCalls), 0);
    assert.equal(fixture.saveRequests.length, 0);
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => window.__pickerCalls === 1);
  }, "ready");
});

for (const [label, openButton, dialog, saveButton, suffix] of [
  ["single", "#saveButton", "#singleSaveDialog", "#singleSaveStartButton", "#singleSaveSuffix"],
  ["batch", "#saveAllButton", "#applyDialog", "#applyStartButton", "#applySuffix"],
]) {
  test(`${label} copy save asks before creating a missing directory and Cancel keeps the save dialog intact`, { timeout: 30000 }, async () => {
    await withPage(async (page, fixture) => {
      await page.locator(openButton).click();
      await page.waitForFunction((selector) => document.querySelector(selector).open && !document.querySelector(selector === "#singleSaveDialog" ? "#singleSaveStartButton" : "#applyStartButton").disabled, dialog);
      await page.locator(suffix).fill("_keep");
      const before = await page.evaluate(() => window.__outputRequests.length);
      await page.locator(saveButton).click();
      await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
      assert.equal(await page.locator("#confirmAccept").textContent(), await page.evaluate(() => t("confirm.createOutputDirectory.accept")));
      assert.equal(await page.locator("#confirmNeverShow").locator("..").evaluate((row) => row.hidden), true);
      assert.equal(await page.locator("#confirmAccept").evaluate((button) => button.classList.contains("danger")), false);
      await page.locator("#confirmCancel").click();
      await page.waitForFunction(() => !document.querySelector("#confirmDialog").open && !state.saveStarting);
      assert.equal(await page.locator(dialog).evaluate((element) => element.open), true);
      assert.equal(await page.locator(suffix).inputValue(), "_keep");
      assert.equal(fixture.saveRequests.length, 0);
      assert.deepEqual(await page.evaluate((start) => window.__outputRequests.slice(start).filter((url) => /\/api\/(?:output-directory\/create|save\/|settings)/.test(url)), before), []);
      await page.locator(saveButton).click();
      await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
      await page.locator("#confirmAccept").click();
      await page.waitForFunction(() => !document.querySelector("#confirmDialog").open && !state.saveStarting && !state.saving, null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.__outputRequests.filter((url) => url.includes("/api/output-directory/create")).length), 1);
      assert.ok(fixture.saveRequests.some((request) => request.path === "/api/save/prepare"), "accepted save proceeds to preparation");
      assert.equal(await page.locator("#confirmAccept").textContent(), await page.evaluate(() => t("dialog.confirm")), "generic confirmation label is restored");
      assert.equal(await page.locator("#confirmNeverShow").locator("..").evaluate((row) => row.hidden), false, "generic confirmation choice is restored");
      assert.equal(await page.locator("#confirmAccept").evaluate((button) => button.classList.contains("danger")), true);
    });
  });
}
