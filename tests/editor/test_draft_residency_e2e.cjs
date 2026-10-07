"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { appendBrowserCoverage, closeServer, startFixtureServer } = require("../test_import_picker_e2e.cjs");

async function withDrafts(run, { count = 3, durable = true } = {}) {
  const fixture = await startFixtureServer();
  let browser, context, page, releaseWrite;
  const covered = process.env.MOZARIE_JS_COVERAGE === "1";
  const errors = [], reads = new Map(), saved = new Map(), uploads = new Map();
  const control = { reads, saved, nextWrite: null };
  control.holdWrite = () => {
    let received;
    const pending = new Promise((resolve) => { received = resolve; });
    control.nextWrite = async (payload) => {
      const released = new Promise((resolve) => { releaseWrite = resolve; });
      received(payload);
      return released;
    };
    return { received: pending, release: (success = true) => releaseWrite(success) };
  };
  try {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    if (covered) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const assets = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 80;
      const context = canvas.getContext("2d");
      context.fillStyle = "#888"; context.fillRect(0, 0, 100, 80);
      const image = canvas.toDataURL();
      context.clearRect(0, 0, 100, 80); context.fillStyle = "white"; context.fillRect(3, 3, 5, 5);
      return { image, mask: canvas.toDataURL() };
    });
    const images = Array.from({ length: count }, (_, index) => ({
      id: `draft-${index}`, relativePath: `${index}.png`, sourceKind: "filesystem", width: 100, height: 80,
      candidateCount: 0, enabledCandidateCount: 0, reviewed: false, hidden: false, hasEffectiveMask: true, flipH: false, flipV: false,
    }));
    for (const image of images) saved.set(image.id, { add: assets.mask, exclusion: "", exclusionErase: "", candidateRevision: 0, hasEffectiveMask: true });
    await page.route("**/api/images", (route) => route.fulfill({ json: {
      images, root: "G:/fixture", catalogGeneration: 1, workspaceId: durable ? "draft-workspace" : null,
      historyDurable: durable, project: null, readOnly: false, sources: [],
    } }));
    await page.route("**/api/image/**", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(assets.image.split(",")[1], "base64") }));
    await page.route("**/api/workspace/manual/**", async (route) => {
      const request = route.request();
      const [imageId, action, sessionId, layer] = new URL(request.url()).pathname.slice("/api/workspace/manual/".length).split("/");
      // The fixture owns the HTTP storage boundary; browser draft/encoder code is unchanged.
      if (request.method() === "GET") {
        reads.set(imageId, (reads.get(imageId) || 0) + 1);
        await route.fulfill({ json: { draft: saved.get(imageId) } }); return;
      }
      if (action === "layer") {
        uploads.get(sessionId)[layer] = `data:image/png;base64,${request.postDataBuffer().toString("base64")}`;
        await route.fulfill({ json: {} }); return;
      }
      const payload = request.postDataJSON();
      if (action === "begin") { uploads.set(payload.sessionId, {}); await route.fulfill({ json: {} }); return; }
      if (action === "cancel") { uploads.delete(payload.sessionId); await route.fulfill({ json: {} }); return; }
      const wait = control.nextWrite; control.nextWrite = null;
      if (wait && !await wait(payload)) { await route.fulfill({ status: 500, json: { error: { code: "internal_error" } } }); return; }
      if (request.method() === "DELETE") { saved.delete(imageId); await route.fulfill({ json: {} }); return; }
      const next = { ...saved.get(imageId), ...payload, ...uploads.get(payload.sessionId) };
      for (const empty of payload.emptyLayers || []) next[empty] = "";
      for (const field of ["dirtyLayers", "dirtyRois", "emptyLayers", "sessionId"]) delete next[field];
      saved.set(imageId, next); uploads.delete(payload.sessionId);
      await route.fulfill({ json: {} });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => state.settings && state.images.length === expected, count);
    await select(page, "draft-0");
    await run(page, control);
    assert.deepEqual(errors, []);
  } finally {
    releaseWrite?.(false);
    try {
      if (covered && page && process.env.MOZARIE_BROWSER_COVERAGE_FILE) {
        await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, await page.coverage.stopJSCoverage());
      }
    } finally {
      try { await context?.close(); }
      finally { await Promise.all([browser?.close(), closeServer(fixture.server)]); }
    }
  }
}

async function select(page, imageId) {
  await page.evaluate((id) => selectImage(id), imageId);
  await page.waitForFunction((id) => state.currentId === id && !state.pendingImageId, imageId);
}

async function settled(page) {
  await page.waitForFunction(() => !state.draftDirty && !state.draftSaveChains.size && !state.workspaceDraftTimers.size && !state.workspaceDraftChains.size);
}

async function toggleManual(page) {
  await page.locator('.candidate-row-manual-apply .candidate-toggle').click();
}

test("cold durable draft visits release inactive PNGs and reload identical pixels", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  for (let index = 1; index < 30; index += 1) await select(page, `draft-${index}`);
  assert.deepEqual(await page.evaluate(() => ({ drafts: [...state.drafts.keys()], revisions: [...state.workspaceDraftRevisions.keys()], statuses: state.maskStatus.size, masked: state.images.filter(imageHasMask).length })),
    { drafts: ["draft-29"], revisions: ["draft-29"], statuses: 1, masked: 30 }, "visiting images does not retain every stored PNG or lose gallery mask flags");
  await select(page, "draft-0");
  assert.equal(control.reads.get("draft-0"), 2, "a released draft is read again from durable storage");
  assert.equal(await page.evaluate(() => addCtx.getImageData(5, 5, 1, 1).data[3]), 255);
  assert.deepEqual(await page.evaluate(() => [...state.drafts.keys()]), ["draft-0"]);
}, { count: 30 }));

test("a draft saved while active is released on departure and retains saved metadata", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  await toggleManual(page);
  await settled(page);
  assert.equal(control.saved.get("draft-0").manualEnabled, false);
  assert.equal(await page.evaluate(() => state.drafts.has("draft-0")), true, "the selected canvas keeps its active draft");
  await select(page, "draft-1");
  assert.equal(await page.evaluate(() => state.drafts.has("draft-0")), false, "leaving after an earlier successful save releases its PNGs");
  assert.equal(await page.evaluate(() => imageHasMask(state.images[0])), false, "eviction preserves the saved disabled-mask flag");
  await select(page, "draft-0");
  assert.equal(await page.evaluate(() => state.manualEnabled), false);
  assert.equal(await page.evaluate(() => addCtx.getImageData(5, 5, 1, 1).data[3]), 255, "disabled stored pixels remain intact");
}));

test("pending and failed metadata-only drafts survive image switches until their own save succeeds", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  const write = control.holdWrite();
  await toggleManual(page);
  const payload = await write.received;
  assert.deepEqual(payload.dirtyLayers, [], "the edit changes only enabled state, not PNG layers");
  await select(page, "draft-1");
  assert.equal(await page.evaluate(() => state.drafts.get("draft-0")?.manualEnabled), false, "a blocked write retains its only unsaved state");
  write.release(false);
  await page.locator("#errorDialog").waitFor({ state: "visible" });
  await page.locator("#errorDialog button").last().click();
  await select(page, "draft-0");
  assert.equal(await page.evaluate(() => state.manualEnabled), false);
  assert.equal(control.reads.get("draft-0"), 1, "a failed metadata save must not reload the older enabled server copy");
  control.nextWrite = async () => false;
  assert.equal(await page.evaluate(async () => {
    try { await flushWorkspaceDraft("draft-0"); return "saved"; }
    catch { return "failed"; }
  }), "failed", "a failed retry prevents the dependent action");
  assert.equal(await page.evaluate(() => state.workspaceMutationErrors.size), 1, "the failed metadata edit remains pending for the next action");
  await select(page, "draft-2");
  assert.equal(await page.evaluate(() => state.drafts.get("draft-0")?.manualEnabled), false);
  await page.evaluate(() => flushWorkspaceDraft("draft-0"));
  assert.equal(await page.evaluate(() => state.drafts.has("draft-0")), false, "successful inactive retry releases the now durable draft");
  await select(page, "draft-0");
  assert.equal(await page.evaluate(() => state.manualEnabled), false);
}));

test("failed empty draft deletion keeps the cleared canvas until retry succeeds", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  const write = control.holdWrite();
  await page.locator(".candidate-row-manual-apply .candidate-delete").click();
  await write.received;
  await page.evaluate(() => { window.pendingDraftSwitch = selectImage("draft-1"); });
  await page.waitForFunction(() => state.pendingImageId === "draft-1");
  assert.equal(await page.evaluate(() => state.currentId), "draft-0", "empty draft deletion is still pending");
  write.release(false);
  await page.evaluate(() => window.pendingDraftSwitch);
  await page.locator("#errorDialog").waitFor({ state: "visible" });
  await page.locator("#errorDialog button").last().click();
  assert.deepEqual(await page.evaluate(() => [state.currentId, addCtx.getImageData(5, 5, 1, 1).data[3], state.draftDirty]), ["draft-0", 0, true]);
  assert.ok(control.saved.get("draft-0").add, "failed DELETE leaves the older server copy intact");
  await select(page, "draft-1");
  assert.equal(control.saved.has("draft-0"), false, "retry commits the cleared draft before departure");
  assert.equal(await page.evaluate(() => state.drafts.has("draft-0")), false);
  await select(page, "draft-0");
  assert.equal(await page.evaluate(() => addCtx.getImageData(5, 5, 1, 1).data[3]), 0, "revisit cannot resurrect the older pixels");
}));

test("project creation retries failed metadata saves before discarding the previous editor", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  let created = 0;
  await page.route("**/api/projects", async (route) => {
    assert.equal(control.saved.get("draft-0").manualEnabled, false, "the old editor is durable before project creation");
    created += 1;
    await route.fulfill({ json: { project: { id: "new-project", name: "New" }, catalogGeneration: 2 } });
  });
  control.nextWrite = async () => false;
  await toggleManual(page);
  await page.locator("#errorDialog").waitFor({ state: "visible" });
  await page.locator("#errorDialog button").last().click();
  await page.locator("#projectButton").click();
  await page.locator("#projectNew").click();
  await page.locator("#projectNameInput").fill("New");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    control.nextWrite = async () => false;
    await page.locator("#projectNameConfirm").click();
    await page.locator("#errorDialog").waitFor({ state: "visible" });
    assert.equal(created, 0);
    assert.deepEqual(await page.evaluate(() => [state.currentId, state.manualEnabled, state.workspaceMutationErrors.size]), ["draft-0", false, 1]);
    await page.locator("#errorDialog button").last().click();
  }
  await page.locator("#projectNameConfirm").click();
  await page.waitForFunction(() => state.project?.id === "new-project" && !state.projectOperationPending);
  assert.equal(created, 1);
  assert.equal(control.saved.get("draft-0").manualEnabled, false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => state.images.length === 3);
  await select(page, "draft-0");
  assert.equal(await page.evaluate(() => state.manualEnabled), false, "the saved setting survives a complete browser reload");
}));

test("legacy non-durable drafts keep local history when leaving after a save", { timeout: 30000 }, () => withDrafts(async (page, control) => {
  await page.locator("#brushTool").click();
  await page.locator("#brushSize").fill("8");
  await page.locator("#brushSize").dispatchEvent("input");
  const point = await page.evaluate(() => {
    const box = canvas.getBoundingClientRect();
    return { x: box.left + state.view.x + 20 * state.view.scale, y: box.top + state.view.y + 20 * state.view.scale };
  });
  await page.mouse.click(point.x, point.y);
  await settled(page);
  await select(page, "draft-1");
  await select(page, "draft-2");
  assert.equal(await page.evaluate(() => state.drafts.size), 3);
  await select(page, "draft-0");
  assert.equal(control.reads.get("draft-0"), 1);
  assert.equal(await page.evaluate(() => addCtx.getImageData(20, 20, 1, 1).data[3]), 255);
  await page.locator("#undoButton").click();
  await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy);
  assert.deepEqual(await page.evaluate(() => [5, 20].map((value) => addCtx.getImageData(value, value, 1, 1).data[3])), [255, 0], "local undo state and its original pixels survive navigation when the server does not own history");
}, { durable: false }));
