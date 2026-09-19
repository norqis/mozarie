"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

const paths = ["same.png", "one/same.png", "one/deep/same.png"];
const canonicalBrowserSourceId = "22222222-2222-4222-8222-222222222222";
const sourceMtimeMs = 1_789_570_600_682;
const sourceMtimeNs = sourceMtimeMs * 1_000_000;

function snapshot(sourceId = null) {
  return {
    images: paths.map((relativePath, index) => ({
      id: `folder-${index}`, relativePath, sourceId: sourceId ? canonicalBrowserSourceId : null, sourceKind: "session", width: 2, height: 2,
      sizeBytes: 3, mtimeNs: sourceMtimeNs, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false,
    })),
    root: "", catalogGeneration: 7, workspace: false, workspaceId: null, historyDurable: false,
    project: { id: "folder-project", name: "Folder project", status: "working", imageCount: paths.length }, readOnly: false,
    sources: sourceId ? [{ id: canonicalBrowserSourceId, kind: "browser-directory", identity: `browser:${sourceId}` }] : [], needsSource: false,
  };
}

async function freshPage(browser, fixture) {
  let sourceId = null;
  let responseSnapshot = () => snapshot(sourceId);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__folderPicker = { calls: [], mode: "success" };
    window.__folderPermission = { mode: "granted", queries: [], requests: [] };
    window.__folderFile = { lastModified: 1_789_570_600_682 };
    const directoryPrototype = FileSystemDirectoryHandle.prototype;
    directoryPrototype.queryPermission = async function queryPermission({ mode }) {
      if (this.name === "mozarie-folder-permission-e2e") window.__folderPermission.queries.push(mode);
      return window.__folderPermission.mode === "granted" ? "granted" : "prompt";
    };
    directoryPrototype.requestPermission = async function requestPermission({ mode }) {
      if (this.name === "mozarie-folder-permission-e2e") window.__folderPermission.requests.push(mode);
      return window.__folderPermission.mode === "denied" ? "denied" : "granted";
    };
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function getFileWithStableMtime() {
      const file = await getFile.call(this);
      return new File([file], file.name, { type: file.type, lastModified: window.__folderFile.lastModified });
    };
    window.__openFilePicker = { calls: [], handles: [] };
    window.showOpenFilePicker = async (options) => {
      window.__openFilePicker.calls.push({ ...options, active: navigator.userActivation?.isActive === true });
      return window.__openFilePicker.handles;
    };
    window.showDirectoryPicker = async (options) => {
      window.__folderPicker.calls.push({ ...options, active: navigator.userActivation?.isActive === true });
      if (window.__folderPicker.mode === "cancel") throw new DOMException("cancelled", "AbortError");
      if (window.__folderPicker.mode === "denied") throw new DOMException("denied", "NotAllowedError");
      return (await navigator.storage.getDirectory()).getDirectoryHandle("mozarie-folder-permission-e2e");
    };
  });
  await context.route("**/api/images", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responseSnapshot()) }));
  await context.route("**/api/import/file", async (route) => {
    const headers = route.request().headers();
    sourceId = decodeURIComponent(headers["x-mozarie-source-id"] || "");
    const relativePath = decodeURIComponent(headers["x-mozarie-relative-path"] || "");
    const index = paths.indexOf(relativePath);
    const imageId = relativePath === "picked-file.png" ? "browser-file" : (index < 0 ? null : `folder-${index}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      catalogId: "folder-project", catalogGeneration: 7,
      imported: imageId ? [{ imageId, clientKey: decodeURIComponent(headers["x-mozarie-client-key"] || "") }] : [],
    }) });
  });
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.project?.id === "folder-project" && state.images.length === 3 && state.settings && !state.importing);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("mozarie-folder-permission-e2e", { recursive: true }).catch(() => {});
    const source = await root.getDirectoryHandle("mozarie-folder-permission-e2e", { create: true });
    const one = await source.getDirectoryHandle("one", { create: true });
    const deep = await one.getDirectoryHandle("deep", { create: true });
    for (const directory of [source, one, deep]) {
      const handle = await directory.getFileHandle("same.png", { create: true });
      const writable = await handle.createWritable(); await writable.write(new Uint8Array([1, 2, 3])); await writable.close();
    }
  });
  return { context, page, sourceId: () => sourceId, setSnapshot: (value) => { responseSnapshot = value; } };
}

test("project folder restore retains each nested file's direct parent", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page; let savedSourceId;
  try {
    ({ context, page, sourceId: savedSourceId } = await freshPage(browser, fixture));
    await page.locator("#projectButton").click();
    await page.locator("#projectSourceAdd").click();
    await page.waitForFunction(() => !state.importing && state.sourceAccess.size === 3 && !state.projectOperationPending);
    assert.deepEqual(await page.evaluate(() => window.__folderPicker.calls), [{ mode: "readwrite", id: "mozarie-project-source", active: true }], "the project-folder picker asks for write access inside the click");
    assert.match(savedSourceId(), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "the saved browser handle keeps its original request UUID");
    assert.notEqual(savedSourceId(), canonicalBrowserSourceId, "the API's canonical source ID differs from the remembered request UUID");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.project?.id === "folder-project" && state.images.length === 3 && state.sourceAccess.size === 3 && !state.importing);
    assert.deepEqual(await page.evaluate(() => window.__folderPermission), { mode: "granted", queries: ["read"], requests: [] }, "passive project restore only queries read permission and does not prompt");
    assert.deepEqual(await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("mozarie-folder-permission-e2e");
      const one = await root.getDirectoryHandle("one"); const deep = await one.getDirectoryHandle("deep");
      const expected = new Map([["same.png", root], ["one/same.png", one], ["one/deep/same.png", deep]]);
      return Promise.all(state.images.map(async (image) => ({ path: image.relativePath, directParent: await expected.get(image.relativePath).isSameEntry(state.sourceAccess.get(image.id).parentHandle) })));
    }), [
      { path: "same.png", directParent: true }, { path: "one/same.png", directParent: true }, { path: "one/deep/same.png", directParent: true },
    ], "a reload restores source access from IndexedDB with the directory that directly contains each file");
    assert.deepEqual(await page.evaluate(() => [...state.sourceAccess.values()].map((access) => access.sourceId)), [canonicalBrowserSourceId, canonicalBrowserSourceId, canonicalBrowserSourceId], "a browser-directory source restores the API's canonical source ID rather than the remembered request UUID");
    assert.equal(await page.evaluate(async () => {
      await Promise.all([...state.sourceAccess.values()].map((access) => ensureHandlePermission(access, false)));
      return true;
    }), true, "the restored source metadata accepts the unchanged real file before saving");
    assert.equal(await page.evaluate(async () => {
      window.__folderFile.lastModified += 1;
      try { await ensureHandlePermission(state.sourceAccess.get("folder-0"), false); }
      catch (error) { return error.code; }
      finally { window.__folderFile.lastModified = 1_789_570_600_682; }
      return null;
    }), "stale_asset", "a changed restored source remains stale");

    assert.deepEqual(await page.evaluate(async () => {
      const requested = [];
      await requestProjectSourcePermission({ async requestPermission({ mode }) { requested.push(mode); return "granted"; } });
      await requestProjectSourcePermission({ async requestPermission({ mode }) { requested.push(mode); return "granted"; } }, "readwrite");
      return requested;
    }), ["read", "readwrite"], "individual files retain read permission while directory restore can request readwrite");

    await page.evaluate(async () => {
      window.__folderPermission.mode = "denied"; window.__folderPermission.queries = []; window.__folderPermission.requests = [];
      state.sourceAccess.clear(); await resyncCatalog();
    });
    await page.waitForFunction(() => pendingBrowserProjectSources.some((source) => source.kind === "directory"));
    await page.locator("#projectButton").click();
    await page.locator("#projectBrowserRestore button").click();
    await page.waitForFunction(() => !state.projectOperationPending);
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id), sourceAccess: state.sourceAccess.size,
      pendingDirectories: pendingBrowserProjectSources.filter((source) => source.kind === "directory").length,
      permission: window.__folderPermission,
    })), {
      ids: ["folder-0", "folder-1", "folder-2"], sourceAccess: 0, pendingDirectories: 1,
      permission: { mode: "denied", queries: ["read"], requests: ["readwrite"] },
    }, "a denied visible directory restore preserves the catalog and unlocks the project");

    await page.evaluate(() => { window.__folderPermission.mode = "granted"; });
    await page.locator("#projectBrowserRestore button").click();
    await page.waitForFunction(() => !state.projectOperationPending && state.sourceAccess.size === 3);
    assert.deepEqual(await page.evaluate(() => window.__folderPermission.requests), ["readwrite", "readwrite"], "a granted visible directory restore requests write permission before restoring access");

    const before = await page.evaluate(() => ({ ids: state.images.map((image) => image.id), importing: state.importing, access: state.sourceAccess.size }));
    await page.evaluate(() => { window.__folderPicker.mode = "cancel"; });
    await page.locator("#projectClose").click(); await page.locator("#pickFolder").click(); await page.locator("#pickFolderFiles").click();
    await page.waitForFunction(() => !state.importing);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), importing: state.importing, access: state.sourceAccess.size, picker: window.__folderPicker.calls.at(-1) })), {
      ...before, picker: { mode: "readwrite", id: "mozarie-source", active: true },
    }, "a cancelled initial folder picker keeps the catalog and releases the import lock");
    await page.evaluate(() => { window.__folderPicker.mode = "denied"; });
    await page.locator("#pickFolder").click(); await page.locator("#pickFolderFiles").click();
    await page.waitForFunction(() => !state.importing && document.querySelector("#errorDialog")?.open);
    assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), importing: state.importing, access: state.sourceAccess.size })), before, "a denied initial folder picker keeps the catalog and releases the import lock");
    await page.locator("#errorDialogClose").click();
    await page.evaluate(() => { window.__folderPicker.mode = "success"; });
    await page.locator("#pickFolder").click(); await page.locator("#pickFolderFiles").click();
    await page.waitForFunction(() => !state.importing && state.sourceAccess.size === 3);
    assert.deepEqual(await page.evaluate(() => window.__folderPicker.calls.at(-1)), { mode: "readwrite", id: "mozarie-source", active: true }, "the initial folder picker also obtains write access inside the click");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});

test("reload-restored grandchild handle writes and deletes only its direct same-name entry", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true }); let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator("#projectButton").click(); await page.locator("#projectSourceAdd").click();
    await page.waitForFunction(() => !state.importing && state.sourceAccess.size === 3 && !state.projectOperationPending);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.project?.id === "folder-project" && state.sourceAccess.size === 3 && !state.importing);
    assert.deepEqual(await page.evaluate(async () => {
      const access = state.sourceAccess.get("folder-2");
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("mozarie-folder-permission-e2e");
      const one = await root.getDirectoryHandle("one"); const deep = await one.getDirectoryHandle("deep");
      const direct = await deep.getFileHandle("same.png");
      const restoredIdentity = {
        file: await access.fileHandle.isSameEntry(direct), parent: await access.parentHandle.isSameEntry(deep),
        sourceId: access.sourceId, relativePath: access.relativePath,
      };
      await writeSourceHandle(access, new Response(new Uint8Array([7, 8, 9])));
      const saved = [...new Uint8Array(await (await direct.getFile()).arrayBuffer())];
      await browserDeleteHandle({ parentHandle: access.parentHandle, fileHandle: access.fileHandle, name: access.fileHandle.name }, {
        sizeBytes: access.size, mtimeNs: access.lastModified * 1_000_000,
      });
      const rootFile = await root.getFileHandle("same.png"); const childFile = await one.getFileHandle("same.png");
      let grandchildMissing = false;
      try { await deep.getFileHandle("same.png"); }
      catch (error) { if (error.name !== "NotFoundError") throw error; grandchildMissing = true; }
      return {
        restoredIdentity, saved, grandchildMissing,
        rootBytes: [...new Uint8Array(await (await rootFile.getFile()).arrayBuffer())],
        childBytes: [...new Uint8Array(await (await childFile.getFile()).arrayBuffer())],
      };
    }), {
      restoredIdentity: { file: true, parent: true, sourceId: canonicalBrowserSourceId, relativePath: "one/deep/same.png" },
      saved: [7, 8, 9], grandchildMissing: true, rootBytes: [1, 2, 3], childBytes: [1, 2, 3],
    }, "the handle restored by reload immediately writes and deletes only the grandchild while both same-name ancestors retain their bytes");
  } finally { await context?.close(); await browser.close(); await closeServer(fixture.server); }
});

test("unnamed browser workspace promotion keeps its actual directory and browser-file handles under the same workspace id", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer(); const browser = await chromium.launch({ headless: true }); let context; let page; let setSnapshot;
  try {
    ({ context, page, setSnapshot } = await freshPage(browser, fixture));
    const workspaceId = "unnamed-browser-workspace-id";
    await page.route("**/api/project/close", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/project/name", async (route) => {
      const body = route.request().postDataJSON();
      assert.equal(body.name, "Promoted"); assert.equal(body.projectId, workspaceId, "the real promotion API keeps the unnamed workspace id");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: { id: workspaceId, name: "Promoted", status: "working", imageCount: paths.length + 1 } }) });
    });
    await page.locator("#projectButton").click(); await page.locator("#projectCloseWorkspace").click();
    await page.waitForFunction(() => state.project === null && state.images.length === 0 && !state.projectOperationPending);
    setSnapshot(() => ({ ...snapshot(), project: null, workspace: true, workspaceId, historyDurable: true, sources: [], needsSource: false }));
    await page.locator("#pickFolder").click(); await page.locator("#pickFolderFiles").click();
    await page.waitForFunction((id) => state.project === null && state.workspaceId === id && state.images.length === 3 && !state.importing, workspaceId);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("picked-file.png", { create: true });
      const writable = await handle.createWritable(); await writable.write(new Uint8Array([9, 8, 7])); await writable.close();
      window.__promotionFileHandle = handle; window.__openFilePicker.handles = [handle];
    });
    setSnapshot(() => ({
      ...snapshot(), project: null, workspace: true, workspaceId, historyDurable: true, sources: [], needsSource: false,
      images: [...snapshot().images, {
        id: "browser-file", relativePath: "picked-file.png", sourceId: null, sourceKind: "session", width: 2, height: 2,
        sizeBytes: 3, mtimeNs: sourceMtimeNs, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false,
      }],
    }));
    await page.locator("#pickFolder").click(); await page.locator("#pickImages").click();
    await page.waitForFunction(() => !state.importing && state.images.some((image) => image.id === "browser-file") && state.sourceAccess.has("browser-file"));
    assert.deepEqual(await page.evaluate(() => window.__openFilePicker.calls), [{
      multiple: true, types: [{ description: "Images", accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] } }], active: true,
    }], "the visible browser-file picker requests multiple supported image files inside the click");
    const before = await page.evaluate(async (id) => {
      const remembered = await rememberedProjectSources(id);
      const access = state.sourceAccess.get("browser-file");
      return {
        rememberedDirectories: remembered.directories.length, rememberedFiles: remembered.files.length,
        projectlessSources: state.projectlessDirectorySources.size, sourceKind: access.sourceKind,
        sameFile: await access.fileHandle.isSameEntry(window.__promotionFileHandle), relativePath: access.relativePath,
      };
    }, workspaceId);
    assert.deepEqual(before, {
      rememberedDirectories: 0, rememberedFiles: 0, projectlessSources: 1,
      sourceKind: "browser-files", sameFile: true, relativePath: "picked-file.png",
    }, "directory and browser-file handles remain in the real unnamed workspace until promotion");
    await page.locator("#projectButton").click(); await page.locator("#projectName").click(); await page.locator("#projectNameInput").fill("Promoted"); await page.locator("#projectNameConfirm").click();
    await page.waitForFunction((id) => state.project?.id === id && !state.projectOperationPending, workspaceId);
    assert.deepEqual(await page.evaluate(async ({ id }) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("mozarie-folder-permission-e2e");
      const remembered = await rememberedProjectSources(id);
      const file = remembered.files[0];
      return {
        directoryCount: remembered.directories.length, fileCount: remembered.files.length,
        sameDirectory: await remembered.directories[0].handle.isSameEntry(root), sameFile: await file.handle.isSameEntry(window.__promotionFileHandle),
        fileImageId: file.imageId, fileSourceId: file.sourceId, fileClientKey: file.clientKey, fileRelativePath: file.relativePath,
        liveSourceId: state.sourceAccess.get("browser-file").sourceId, liveClientKey: state.sourceAccess.get("browser-file").clientKey,
        projectlessSources: state.projectlessDirectorySources.size, projectId: state.project.id, workspaceId: state.workspaceId,
      };
    }, { id: workspaceId }), {
      directoryCount: 1, fileCount: 1, sameDirectory: true, sameFile: true,
      fileImageId: "browser-file", fileSourceId: await page.evaluate(() => state.sourceAccess.get("browser-file").sourceId),
      fileClientKey: await page.evaluate(() => state.sourceAccess.get("browser-file").clientKey), fileRelativePath: "picked-file.png",
      liveSourceId: await page.evaluate(() => state.sourceAccess.get("browser-file").sourceId), liveClientKey: await page.evaluate(() => state.sourceAccess.get("browser-file").clientKey),
      projectlessSources: 0, projectId: workspaceId, workspaceId,
    }, "the promotion UI persists both actual handles and browser-file identity under the unchanged workspace id");
  } finally { await context?.close(); await browser.close(); await closeServer(fixture.server); }
});

test("browser directory restore keeps canonical source paths separate", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page; let setSnapshot;
  try {
    ({ context, page, setSnapshot } = await freshPage(browser, fixture));
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const source = await root.getDirectoryHandle("mozarie-folder-permission-scope", { create: true });
      const handle = await source.getFileHandle("same.png", { create: true });
      const writable = await handle.createWritable(); await writable.write(new Uint8Array([1, 2, 3])); await writable.close();
      await rememberProjectSources("folder-project", [
        { sourceId: "legacy-request", handle: source },
        { sourceId: "browser-file-source", imageId: "file-source", relativePath: "same.png", handle },
      ]);
    });
    setSnapshot(() => ({
      images: [
        { id: "legacy", sourceId: "canonical-legacy", relativePath: "same.png", sourceKind: "session", sizeBytes: 3, mtimeNs: sourceMtimeNs, width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
        { id: "prefixed", sourceId: "canonical-prefixed", relativePath: "same.png", sourceKind: "session", sizeBytes: 3, mtimeNs: sourceMtimeNs, width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
        { id: "file-source", sourceId: "browser-file-source", relativePath: "same.png", sourceKind: "session", sizeBytes: 3, mtimeNs: sourceMtimeNs, width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
        { id: "unrelated", sourceId: "canonical-unrelated", relativePath: "same.png", sourceKind: "session", sizeBytes: 3, mtimeNs: sourceMtimeNs, width: 2, height: 2, candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false },
      ],
      root: "", catalogGeneration: 8, workspace: false, workspaceId: null, historyDurable: false,
      project: { id: "folder-project", name: "Folder project", status: "working", imageCount: 4 }, readOnly: false, needsSource: false,
      sources: [
        { id: "canonical-legacy", kind: "browser-directory", identity: "legacy-request" },
        { id: "canonical-prefixed", kind: "browser-directory", identity: "browser:legacy-request" },
        { id: "browser-file-source", kind: "browser-files", identity: "browser:legacy-request" },
        { id: "canonical-unrelated", kind: "browser-directory", identity: "browser:someone-else" },
      ],
    }));
    await page.evaluate(() => resyncCatalog());
    await page.waitForFunction(() => state.sourceAccess.size === 3);
    const restored = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const source = await root.getDirectoryHandle("mozarie-folder-permission-scope");
      const file = await source.getFileHandle("same.png");
      return Promise.all([...state.sourceAccess.entries()].map(async ([imageId, access]) => ({ imageId, sourceId: access.sourceId, sourceKind: access.sourceKind, lastModified: access.lastModified, sameFile: await access.fileHandle.isSameEntry(file) }))).then((entries) => entries.sort((left, right) => left.imageId.localeCompare(right.imageId)));
    });
    assert.deepEqual(restored, [
      { imageId: "file-source", sourceId: "browser-file-source", sourceKind: "browser-files", lastModified: sourceMtimeMs, sameFile: true },
      { imageId: "legacy", sourceId: "canonical-legacy", sourceKind: "browser-directory", lastModified: sourceMtimeMs, sameFile: true },
      { imageId: "prefixed", sourceId: "canonical-prefixed", sourceKind: "browser-directory", lastModified: sourceMtimeMs, sameFile: true },
    ], "one remembered raw source maps both legacy and browser-prefixed canonical directory IDs without mixing browser-file or unrelated sources");
    assert.equal(await page.evaluate(async () => {
      await ensureHandlePermission(state.sourceAccess.get("file-source"), false);
      return true;
    }), true, "a restored browser-file source accepts the unchanged real file before saving");
  } finally {
    await context?.close(); await browser.close(); await closeServer(fixture.server);
  }
});
