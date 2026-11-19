const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

async function harness(run) {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const state = { images: [], project: null, workspaceId: null, generation: 1, failures: [], requests: [], failCreate: false, empty: false };
  const snapshot = () => ({ images: state.images, project: state.project, workspaceId: state.workspaceId,
    workspace: !!state.workspaceId, historyDurable: false, root: "G:\\Pictures\\Selected", sources: [], readOnly: false,
    catalogGeneration: state.generation });
  const add = (name = "sample.png") => {
    state.workspaceId ||= "imported-workspace";
    state.images.push({ id: `imported-${state.images.length}`, relativePath: name, width: 2, height: 2,
      sourceKind: state.sourceKind || "native", reviewed: false, hidden: false, candidateCount: 0 });
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === "/api/images") return json(snapshot());
    if (url.pathname === "/api/folder") {
      state.requests.push({ path: url.pathname, body: request.postDataJSON() });
      if (!state.empty) add();
      return json({ ...snapshot(), importFailures: state.failures });
    }
    if (url.pathname === "/api/import/file") {
      const name = decodeURIComponent(request.headers()["x-mozarie-name"]);
      if (state.failures.length) return json({ error_code: "image_read_failed" }, 400);
      if (name === state.uploadFailure?.name) {
        await state.uploadFailure.ready();
        return json({ error_code: "workspace_write_failed" }, 500);
      }
      add(name);
      return json({ catalogId: state.workspaceId, imageId: state.images.at(-1).id, catalogGeneration: state.generation });
    }
    if (url.pathname === "/api/project/name") {
      const body = request.postDataJSON(); state.requests.push({ path: url.pathname, body });
      if (state.failCreate) { state.failCreate = false; return json({ error_code: "workspace_write_failed" }, 500); }
      assert.equal(body.projectId, state.workspaceId, "promotes the loaded workspace rather than creating an empty one");
      state.project = { id: body.projectId, name: body.name, status: "working", imageCount: state.images.length };
      return json({ project: state.project, catalogGeneration: state.generation });
    }
    return route.fallback();
  });
  try {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.job);
    await run({ page, state, add });
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
}
async function loadPath(page, path = "G:\\Pictures\\Selected") {
  await page.locator("#pickFolder").click();
  await page.locator("#folderPath").fill(path);
  await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/folder"), page.locator("#loadFolderButton").click()]);
  await page.waitForFunction(() => !state.catalogTransition);
}
async function noPrompt(page) {
  await page.waitForFunction(() => !state.importing && !state.catalogTransition);
  assert.equal(await page.locator("#projectNameDialog").evaluate((dialog) => dialog.open), false);
}

test("first path import offers project creation and preserves the imported workspace through retry and reload", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    await loadPath(page);
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectNameTitle").textContent(), "新規プロジェクトを作成しますか？");
    assert.equal(await page.locator("#projectNameInput").inputValue(), "Selected");
    assert.equal(await page.locator("#projectNameCancel").textContent(), "作成しない");
    assert.equal(await page.locator("#projectNameConfirm").textContent(), "作成する");
    const ids = await page.evaluate(() => state.images.map((image) => image.id));
    await page.locator("#projectNameInput").fill("");
    await page.locator("#projectNameConfirm").click();
    assert.equal(state.requests.filter((request) => request.path === "/api/project/name").length, 0, "empty names use native form validation");
    state.failCreate = true;
    await page.locator("#projectNameInput").fill("Edited project name");
    await page.locator("#projectNameConfirm").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#projectNameInput").inputValue(), "Edited project name");
    assert.equal(await page.locator("#projectNameConfirm").textContent(), "作成する");
    await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.name === "Edited project name" && !state.projectOperationPending);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ids);
    assert.equal(await page.locator("#projectNameTitle").textContent(), "名前を付けて保存");
    await page.reload();
    await page.waitForFunction(() => state.project?.name === "Edited project name");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ids);
    await loadPath(page); await noPrompt(page);
  });
});

test("first import cancel and Escape keep images while later additions and empty loads do not prompt", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    state.empty = true; await loadPath(page); await noPrompt(page);
    state.empty = false; await loadPath(page, "G:\\Pictures\\Other");
    await page.locator("#projectNameCancel").click(); await noPrompt(page);
    assert.equal(await page.evaluate(() => state.images.length), 1);
    assert.equal(await page.evaluate(() => state.project), null);
    await loadPath(page, "G:\\Pictures\\Additional"); await noPrompt(page);
  });
  await harness(async ({ page }) => {
    await loadPath(page); await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape"); await noPrompt(page);
    assert.equal(await page.evaluate(() => state.images.length), 1);
  });
});

test("partial import failures precede the project prompt and stale catalogs discard it", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    state.failures = [{ relativePath: "broken.png", reason: "image_read_failed" }];
    await loadPath(page);
    await page.locator("#importFailuresDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectNameDialog").evaluate((dialog) => dialog.open), false);
    await page.locator("#importFailuresClose").click();
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectNameInput").inputValue(), "Selected");
  });
  await harness(async ({ page, state }) => {
    state.failures = [{ relativePath: "broken.png", reason: "image_read_failed" }];
    await loadPath(page); await page.locator("#importFailuresDialog").waitFor({ state: "visible" });
    // An external catalog replacement while the failure report is open invalidates its deferred prompt.
    await page.evaluate(() => { beginCatalogEpoch(); resetCatalog([], ""); });
    await page.locator("#importFailuresClose").click(); await noPrompt(page);
  });
});

test("picker and drop entrypoints offer one prompt with only genuine folder names", { timeout: 60000 }, async () => {
  for (const kind of ["file", "folder", "drop"]) await harness(async ({ page, state }) => {
    if (kind === "drop") state.sourceKind = "session";
    await page.evaluate((kind) => {
      const file = new File([new Uint8Array([1, 2, 3])], "picked.png", { type: "image/png" });
      const handle = { kind: "file", name: file.name, getFile: async () => file, queryPermission: async () => "granted" };
      window.showOpenFilePicker = async () => [handle];
      window.showDirectoryPicker = async () => ({ kind: "directory", name: "ChosenFolder", values: async function* () { yield handle; }, queryPermission: async () => "granted" });
      if (kind === "drop") {
        const transfer = new DataTransfer(); transfer.items.add(file);
        document.querySelector("#gallery").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    }, kind);
    if (kind !== "drop") {
      await page.locator("#pickFolder").click();
      await page.locator(kind === "folder" ? "#pickFolderFiles" : "#pickImages").click();
    }
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectNameInput").inputValue(), kind === "folder" ? "ChosenFolder" : "");
    if (kind === "drop") {
      await page.locator("#projectNameInput").fill("Dropped project");
      await page.locator("#projectNameConfirm").click();
      await page.locator("#errorDialog").waitFor({ state: "visible" });
      await page.locator("#errorDialogClose").click();
      assert.equal(await page.locator("#projectNameInput").inputValue(), "Dropped project");
      assert.equal(state.requests.some((request) => request.path === "/api/project/name"), false, "file-only drop cannot falsely promise durable source access");
    }
    await page.locator("#projectNameCancel").click(); await noPrompt(page);
    assert.equal(await page.evaluate(() => state.images.length), 1);
  });
});


test("existing empty projects, cancelled pickers and wholly failed imports never offer a new project", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    state.project = { id: "existing-empty", name: "Existing", status: "working", imageCount: 0 };
    await page.reload(); await page.waitForFunction(() => state.project?.id === "existing-empty");
    await loadPath(page); await noPrompt(page);
    assert.equal(await page.evaluate(() => state.project.id), "existing-empty");
  });
  for (const failure of ["cancel", "unreadable"]) await harness(async ({ page, state }) => {
    if (failure === "unreadable") state.failures = [{ relativePath: "bad.png", reason: "image_read_failed" }];
    await page.evaluate((failure) => {
      window.showOpenFilePicker = async () => {
        if (failure === "cancel") throw new DOMException("Cancelled", "AbortError");
        return [{ kind: "file", name: "bad.png", getFile: async () => new File(["bad"], "bad.png", { type: "image/png" }) }];
      };
    }, failure);
    await page.locator("#pickFolder").click();
    await page.locator("#pickImages").click();
    if (failure === "unreadable") {
      await page.locator("#importFailuresDialog").waitFor({ state: "visible" });
      await page.locator("#importFailuresClose").click();
    }
    await noPrompt(page);
    assert.equal(await page.evaluate(() => state.images.length), 0);
  });
});


test("project suggestion survives same-catalog visibility refresh but rejects replaced images", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    await loadPath(page);
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    const before = await page.evaluate(async () => {
      const images = state.images;
      await syncCatalogOnReturn();
      return { replaced: images !== state.images, ids: state.images.map((image) => image.id) };
    });
    assert.equal(before.replaced, true, "exercise the actual catalog snapshot array replacement");
    await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.id === "imported-workspace" && !state.projectOperationPending);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), before.ids);
    assert.equal(state.requests.filter((request) => request.path === "/api/project/name").length, 1);
  });
  await harness(async ({ page, state }) => {
    await loadPath(page);
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    state.images = [{ ...state.images[0], id: "replacement-image" }];
    await page.evaluate(() => syncCatalogOnReturn());
    await page.locator("#projectNameConfirm").click();
    await noPrompt(page);
    assert.equal(state.requests.some((request) => request.path === "/api/project/name"), false);
    assert.equal(await page.evaluate(() => state.project), null);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["replacement-image"]);
  });
});


test("a successful upload followed by a batch failure offers project creation after the error closes", { timeout: 60000 }, async () => {
  await harness(async ({ page, state }) => {
    state.uploadFailure = { name: "second.png", ready: () => page.waitForFunction(() => state.importSession?.successes === 1) };
    await page.evaluate(() => {
      window.showOpenFilePicker = async () => ["first.png", "second.png"].map((name) => ({
        kind: "file", name, getFile: async () => new File(["image"], name, { type: "image/png" }),
      }));
    });
    await page.locator("#pickFolder").click();
    await page.locator("#pickImages").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    await page.waitForFunction(() => !state.importing);
    assert.equal(await page.locator("#projectNameDialog").evaluate((dialog) => dialog.open), false);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.relativePath)), ["first.png"]);
    await page.locator("#errorDialogClose").click();
    await page.locator("#projectNameDialog").waitFor({ state: "visible" });
    await page.locator("#projectNameInput").fill("Partially imported project");
    state.failCreate = true;
    await page.locator("#projectNameConfirm").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    await page.locator("#errorDialogClose").click();
    assert.equal(await page.locator("#projectNameInput").inputValue(), "Partially imported project");
    await page.locator("#projectNameConfirm").click();
    await page.waitForFunction(() => state.project?.name === "Partially imported project" && !state.projectOperationPending);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.relativePath)), ["first.png"]);
    assert.equal(state.requests.filter((request) => request.path === "/api/project/name").length, 2);
    assert.equal(await page.locator("#projectNameDialog").evaluate((dialog) => dialog.open), false);
  });
});
