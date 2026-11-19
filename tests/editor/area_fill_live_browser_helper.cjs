"use strict";

const assert = require("node:assert/strict");
const {chromium} = require("playwright");
const [origin, mode, serialized] = process.argv.slice(2);
const specs = JSON.parse(serialized);

async function point(page, x, y) {
  return page.evaluate(({x, y}) => {
    const rect = canvas.getBoundingClientRect();
    return {x: rect.left + state.view.x + x * state.view.scale, y: rect.top + state.view.y + y * state.view.scale};
  }, {x, y});
}

async function clickAt(page, x, y) {
  const position = await point(page, x, y);
  await page.mouse.click(position.x, position.y);
}

async function displayedPixel(page, x, y) {
  return page.evaluate(({x, y}) => {
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    return [...ctx.getImageData(Math.floor((state.view.x + x * state.view.scale) * ratio),
      Math.floor((state.view.y + y * state.view.scale) * ratio), 1, 1).data];
  }, {x, y});
}

async function select(page, spec) {
  await page.locator(`.gallery-item[data-id="${spec.id}"]`).click();
  await page.waitForFunction(id => state.currentId === id && state.currentImage && !state.pendingImageId && hasDurableHistory(), spec.id);
  await page.waitForFunction(() => !isBusy() && !state.fillPending);
  assert.equal(await page.evaluate(() => isReviewed(currentRecord())), true, "editing and navigation preserve the reviewed flag");
}

async function idle(page) {
  await page.waitForFunction(() => !state.fillPending && !state.pendingImageId && !state.projectHistoryBusy && !state.historyRestoreBusy);
  await page.evaluate(async () => {await flushWorkspaceDraft(state.currentId); await refreshProjectHistory(state.currentId);});
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const data = await api(`/api/candidates/${state.currentId}`);
    const candidates = [];
    for (const candidate of data.candidates) {
      const response = await fetch(`/api/mask/${state.currentId}/${candidate.id}`);
      if (!response.ok) throw new Error(`candidate mask ${response.status}`);
      candidates.push({...candidate, digest: await digest(await response.arrayBuffer())});
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return {
      candidates,
      // Workspace masks deliberately persist binary coverage, not brush
      // anti-aliasing or the display-only white RGB channels.
      layers: await Promise.all([addCtx, exclusionCtx, exclusionEraseCtx, combinedCtx, effectiveExclusionCtx]
        .map(context => {
          const rgba = context.getImageData(0, 0, 128, 128).data;
          return digest(Uint8Array.from({length: 128 * 128}, (_, index) => rgba[index * 4 + 3] ? 255 : 0));
        })),
      reviewed: isReviewed(currentRecord()),
    };
  });
}

async function revisions(page) {
  return page.evaluate(async () => ({
    candidate: (await api(`/api/candidates/${state.currentId}`)).candidateRevision,
    manual: (await api(`/api/workspace/manual/${state.currentId}`)).manualRevision,
    history: await api(`/api/project/history/${state.currentId}`),
  }));
}

async function history(page, direction) {
  await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
  await idle(page);
}

async function checkOneStepHistory(page, before, after) {
  await history(page, "undo");
  const restored = await snapshot(page);
  assert.deepEqual(restored, before, `one undo restores exact candidate identities, candidate masks and every manual layer: ${JSON.stringify({before, restored})}`);
  await history(page, "redo");
  assert.deepEqual(await snapshot(page), after, "one redo restores the complete fill without changing reviewed status");
}

function tool(spec, action) {
  return `#${spec.role === "apply" ? "mosaic" : "exclude"}${action === "bucket" ? "AreaBucketTool" : "EncloseTool"}`;
}

async function polygon(page, spec, {finish = true} = {}) {
  await page.locator(tool(spec, "enclose")).click();
  const points = [[20, 20], [108, 20], [108, 108], [20, 108]];
  const start = await point(page, ...points[0]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const coordinates of points.slice(1)) {
    const next = await point(page, ...coordinates);
    await page.mouse.move(next.x, next.y, {steps: 4});
  }
  await page.waitForFunction(() => state.areaFill?.points?.length > 2);
  if (finish) await page.mouse.up();
}

async function rings(page) {
  for (const spec of specs) {
    await select(page, spec);
    await page.locator(tool(spec, "bucket")).click();
    await page.locator("#areaReplaceExisting").uncheck();
    const before = await snapshot(page);
    const revision = await revisions(page);
    await clickAt(page, 5, 5);
    await idle(page);
    assert.deepEqual(await snapshot(page), before, "open outer region changes no pixels");
    assert.deepEqual(await revisions(page), revision, "open region creates no revision or history entry");
    assert.match(await page.locator("#connectionStatus").textContent(), /閉じていません/);
    await clickAt(page, 60, 60);
    await idle(page);
    const after = await snapshot(page);
    assert.notDeepEqual(after.layers, before.layers, `${spec.role} ${spec.origin} ring is filled`);
    await checkOneStepHistory(page, before, after);
  }
}

async function enclosed(page) {
  for (const spec of specs) {
    await select(page, spec);
    const before = await snapshot(page);
    const revision = await revisions(page);
    const originalPixel = await displayedPixel(page, 60, 60);
    await polygon(page, spec, {finish: false});
    assert.notDeepEqual(await displayedPixel(page, 60, 60), originalPixel, "enclosure preview visibly shades its interior before release");
    assert.deepEqual(await snapshot(page), before, "preview paints no durable or manual pixels");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await idle(page);
    assert.deepEqual(await snapshot(page), before, "Escape cancels the whole preview");
    assert.deepEqual(await revisions(page), revision);
    await polygon(page, spec, {finish: false});
    await page.locator("#editorCanvas").dispatchEvent("pointercancel", {pointerId: 1, pointerType: "mouse"});
    await page.mouse.up();
    await idle(page);
    assert.deepEqual(await snapshot(page), before, "pointer cancellation never commits a partially drawn polygon");
    assert.deepEqual(await revisions(page), revision);
    await polygon(page, spec);
    await idle(page);
    const after = await snapshot(page);
    assert.notDeepEqual(after.layers, before.layers, "releasing an open freehand path closes and fills its interior");
    await checkOneStepHistory(page, before, after);
  }
}

async function replace(page) {
  for (const spec of specs) {
    await select(page, spec);
    await page.locator(tool(spec, "enclose")).click();
    await page.locator("#areaReplaceExisting").setChecked(spec.replace);
    const before = await snapshot(page);
    await polygon(page, spec);
    await idle(page);
    const after = await snapshot(page);
    await checkOneStepHistory(page, before, after);
    await page.reload({waitUntil: "domcontentloaded"});
    await select(page, spec);
    await page.locator(tool(spec, "enclose")).click();
    assert.equal(await page.locator("#areaReplaceExisting").isChecked(), spec.replace, "replacement preference persists across page reload");
    assert.deepEqual(await snapshot(page), after, "reload restores exact candidate and manual mask pixels");
  }
}

async function lifecycle(page) {
  const spec = specs[0];
  await select(page, spec);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let releaseManual;
  const manualGate = new Promise(resolve => {releaseManual = resolve;});
  let manualStarted;
  const firstManual = new Promise(resolve => {manualStarted = resolve;});
  let releaseArea;
  const areaGate = new Promise(resolve => {releaseArea = resolve;});
  let areaStarted;
  const firstArea = new Promise(resolve => {areaStarted = resolve;});
  let areas = 0;
  try {
    await page.route("**/api/workspace/manual/*/commit", async route => {
      const response = await route.fetch(); manualStarted(); await manualGate; await route.fulfill({response});
    });
    await page.route("**/api/images/*/area-fill", async route => {
      areas += 1;
      if (areas === 1) {areaStarted(); await areaGate; await route.fulfill({status: 500, json: {error_code: "workspace_write_failed"}});}
      else await route.continue();
    });
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("4");
    await page.locator("#brushSize").dispatchEvent("input");
    await clickAt(page, 12, 116);
    await firstManual;
    const brushOnly = await snapshot(page);
    const brushRevision = await revisions(page);
    await polygon(page, spec);
    await page.waitForFunction(() => state.fillPending);
    assert.equal(areas, 0, "area-fill waits for the pending durable manual save");
    releaseManual(); await firstArea;
    assert.ok(await page.locator("#mosaicAreaBucketTool").isDisabled(), "fill holds all editing controls while its commit is pending");
    assert.ok(await page.locator("#excludeEncloseTool").isDisabled());
    releaseArea();
    await page.locator("#errorDialog").waitFor({state: "visible"});
    await page.locator("#errorDialogClose").click();
    await idle(page);
    assert.deepEqual(await snapshot(page), brushOnly, "failed HTTP transaction changes neither existing masks nor candidate identities");
    assert.deepEqual(await revisions(page), brushRevision, "failed fill adds no revision or undo entry");
    assert.equal(await page.locator("#mosaicAreaBucketTool").isDisabled(), false, "failure unlocks editing");
    await page.unroute("**/api/workspace/manual/*/commit");
    await polygon(page, spec); await idle(page);
    const after = await snapshot(page);
    await checkOneStepHistory(page, brushOnly, after);
    await select(page, specs[1]); await select(page, spec);
    assert.deepEqual(await snapshot(page), after, "image navigation restores the filled masks");
    await page.reload({waitUntil: "domcontentloaded"}); await select(page, spec);
    assert.deepEqual(await snapshot(page), after, "browser restart restores the filled masks");
    const project = await page.evaluate(async () => {
      await flushAllImageMutations(); await flushAllWorkspaceMutations();
      const project = {...state.project};
      await catalogApi("/api/project/close", {}, {method: "POST"});
      resetCatalog([], ""); state.project = null; state.projectReadOnly = false; state.missingNativeSources = [];
      return project;
    });
    await page.evaluate(project => openProject(project), project);
    await page.waitForFunction(() => state.project?.name === "Area fill integration" && !state.projectOperationPending);
    await select(page, spec);
    assert.deepEqual(await snapshot(page), after, "project resume uses the same persisted fill and candidate identities");
    await page.locator("#divisor").fill("8");
    await page.locator("#divisor").dispatchEvent("input");
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog")?.open && !document.querySelector("#singleSaveStartButton")?.disabled);
    await page.locator("#singleSaveCopyMode").check();
    await page.locator("#singleSaveSuffix").fill("_area");
    await page.locator("#singleSaveOutputFormat").selectOption("png");
    await page.locator("#singleSaveRemoveSaved").uncheck();
    await page.locator("#singleSaveStartButton").click();
    await page.waitForFunction(() => !state.saving && !state.saveStarting && document.querySelector("#singleSaveResult")?.textContent.trim().length > 0);
    assert.equal(await page.locator("#errorDialog").evaluate(dialog => dialog.open), false);
    assert.deepEqual(errors, [], "real browser operation produces no JavaScript errors");
  } finally {
    releaseManual(); releaseArea();
  }
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin, {waitUntil: "domcontentloaded"});
    await page.waitForFunction(count => state.images.length === count && state.settings && !state.pendingImageId, specs.length);
    await ({rings, enclose: enclosed, replace, lifecycle})[mode](page);
    console.log(`area fill ${mode}: real pointer, HTTP, durable masks and history passed`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
