"use strict";

// Owned by data_integrity/test_source_state_and_project_restart.py so every request crosses the real
// HTTP server, filesystem catalogue, and SQLite workspace.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const [origin, activeId, emptyId, completedId, imageA, imageB, imageC, imageD] = process.argv.slice(2);

async function waitForCatalog(page, projectId, count) {
  await page.waitForFunction(
    ({ projectId, count }) => state.project?.id === projectId && state.images.length === count && !state.projectOperationPending && !state.catalogTransition,
    { projectId, count },
  );
}

async function setChecked(locator, checked = true) {
  await locator.evaluate((input, value) => {
    input.checked = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, checked);
}

async function main() {
  assert.ok(origin && activeId && emptyId && completedId && imageA && imageB && imageC && imageD);
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.__nativePickerCalls = 0;
      window.showDirectoryPicker = async () => { window.__nativePickerCalls += 1; throw new DOMException("cancelled", "AbortError"); };
      window.showOpenFilePicker = async () => { window.__nativePickerCalls += 1; return []; };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const detectRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/detect") detectRequests.push(request.postDataJSON());
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await waitForCatalog(page, activeId, 8);

    // DI-054: the selected two-image snapshot reaches the dialog, and opening
    // the settings performs no detection request.
    await page.evaluate(({ imageA, imageB }) => {
      state.batchMode = true;
      state.selectedImageIds = new Set([imageA, imageB]);
      updateSelectionActionBar();
      runSelectionAction("detect");
    }, { imageA, imageB });
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.deepEqual(await page.evaluate(() => [...state.pendingDetectionTargetIds]), [imageA, imageB], "detection dialog contains exactly selected A and B");
    assert.deepEqual(await page.evaluate(({ imageA, imageB }) => state.images.filter((image) => ![imageA, imageB].includes(image.id)).map((image) => image.id), { imageA, imageB }),
      await page.evaluate(() => state.images.slice(2).map((image) => image.id)), "C through H are all outside the selected detection target snapshot");
    assert.equal(await page.evaluate(() => state.images.length - state.pendingDetectionTargetIds.length), 6, "all six C-H fixture images are excluded");
    assert.match(await page.locator("#detectTargetCount").textContent(), /2/, "dialog visibly reports two targets");
    assert.equal(detectRequests.length, 0, "opening detection settings does not start detection");
    await page.locator("#detectCancelButton").click();

    // DI-063: closing an unsaved settings form restores persisted values and
    // never mutates the project catalogue or edit scalars.
    const catalogBeforeSettings = await page.evaluate(() => state.images.map((image) => ({
      id: image.id, hidden: image.hidden, reviewed: image.reviewed,
      candidateRevision: image.candidateRevision, hasEffectiveMask: image.hasEffectiveMask,
    })));
    const durableBeforeSettings = await page.evaluate(async () => Promise.all(state.images.map(async (image) => ({
      id: image.id,
      candidates: await api(`/api/candidates/${encodeURIComponent(image.id)}`),
      manual: await api(`/api/workspace/manual/${encodeURIComponent(image.id)}`),
      history: await api(`/api/project/history/${encodeURIComponent(image.id)}`),
    }))));
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
    const persistedParallelism = await page.locator("#settingsSaveParallelism").inputValue();
    await page.locator("#settingsSaveParallelism").fill(String(Number(persistedParallelism) + 3));
    await page.locator("#settingsCloseButton").click();
    await page.locator("#settingsButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
    assert.equal(await page.locator("#settingsSaveParallelism").inputValue(), persistedParallelism, "unsaved settings are discarded on reopen");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => ({
      id: image.id, hidden: image.hidden, reviewed: image.reviewed,
      candidateRevision: image.candidateRevision, hasEffectiveMask: image.hasEffectiveMask,
    }))), catalogBeforeSettings, "unsaved settings do not alter project images or edits");
    assert.deepEqual(await page.evaluate(async () => Promise.all(state.images.map(async (image) => ({
      id: image.id,
      candidates: await api(`/api/candidates/${encodeURIComponent(image.id)}`),
      manual: await api(`/api/workspace/manual/${encodeURIComponent(image.id)}`),
      history: await api(`/api/project/history/${encodeURIComponent(image.id)}`),
    })))), durableBeforeSettings, "unsaved settings preserve complete candidate, manual and history API content");
    await page.locator("#settingsCloseButton").click();

    // DI-064: zero-result search affects only rendered visibility; clearing it
    // restores all cards and the authoritative catalogue remains unchanged.
    await page.locator("#overviewButton").click();
    await page.locator("#overviewQuery").fill("no-such-data-integrity-image");
    await page.waitForFunction(() => !document.querySelector("#overviewEmptyState").hidden && document.querySelectorAll(".overview-item").length === 0);
    const countWhileEmpty = await page.evaluate(async () => (await api("/api/images")).images.length);
    assert.equal(countWhileEmpty, 8, "zero-result search never deletes project images");
    await page.locator("#overviewQuery").fill("");
    await page.waitForFunction(() => document.querySelectorAll(".overview-item").length === 8 && document.querySelector("#overviewEmptyState").hidden);
    await page.locator("#closeOverviewButton").click();

    // DI-065/066: masked-save targets use effective pixels, not candidate row
    // existence. A is fully excluded and B has only disabled candidate rows.
    const effectiveFixture = await page.evaluate(({ imageA, imageB }) => [imageA, imageB].map((id) => {
      const image = state.images.find((item) => item.id === id);
      return { id, candidateCount: image.candidateCount, enabledCandidateCount: image.enabledCandidateCount, effective: image.hasEffectiveMask };
    }), { imageA, imageB });
    assert.ok(effectiveFixture.every((item) => item.candidateCount > 0), "A and B retain candidate records");
    assert.ok(effectiveFixture.every((item) => item.effective === false), "A full exclusion and B disabled candidates both have zero effective area");
    const positiveMaskId = await page.evaluate(() => state.images.find((image) => image.relativePath === "E.png")?.id);
    assert.ok(positiveMaskId, "E is the positive effective-mask control");
    assert.equal(await page.evaluate((id) => state.images.find((image) => image.id === id).hasEffectiveMask, positiveMaskId), true, "E has a real effective mask");
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await setChecked(page.locator('[data-apply-image-filter="masked"]'));
    await page.waitForFunction((positiveMaskId) => state.applyTargetIds.length === 1 && state.applyTargetIds[0] === positiveMaskId, positiveMaskId);
    assert.deepEqual(await page.evaluate(() => [...state.applyTargetIds]), [positiveMaskId], "masked save keeps positive E while excluding fully-excluded A and candidate-only disabled B");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "positive target still cannot copy while destination is unset");
    await page.locator("#applyCloseButton").click();

    // DI-069: an unset single-copy destination is visible and disables save;
    // merely opening the dialog never invokes a native chooser.
    await page.locator(`.gallery-item[data-id="${imageC}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, imageC);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.querySelector("#singleSaveDialog").open);
    assert.equal(await page.locator("#singleSaveOutputDirectoryStatus").inputValue(), "");
    assert.equal(await page.locator("#singleSaveOutputDirectoryStatus").getAttribute("placeholder"), await page.evaluate(() => t("apply.outputDirectoryUnset")), "single save shows the exact unset-destination guidance");
    assert.equal(await page.locator("#singleSaveStartButton").isDisabled(), true, "single copy save cannot start without a destination");
    assert.equal(await page.evaluate(() => window.__nativePickerCalls), 0, "single-save open does not invoke a native picker");
    await page.locator("#singleSaveCloseButton").click();

    // DI-070: batch copy has the same explicit disabled state, while filesystem
    // images can switch to overwrite without choosing a copy destination.
    await page.locator("#saveAllButton").click();
    await page.waitForFunction(() => document.querySelector("#applyDialog").open);
    await setChecked(page.locator('[data-apply-image-filter="masked"]'), false);
    await page.waitForFunction(() => state.applyTargetIds.length === 8);
    assert.equal(await page.locator("#applyOutputDirectoryStatus").inputValue(), "");
    assert.equal(await page.locator("#applyOutputDirectoryStatus").getAttribute("placeholder"), await page.evaluate(() => t("apply.outputDirectoryUnset")), "batch save shows the exact unset-destination guidance");
    assert.equal(await page.locator("#applyStartButton").isDisabled(), true, "batch copy save cannot start without a destination");
    assert.equal(await page.locator("#applyOverwriteMode").isDisabled(), false, "filesystem batch can switch to overwrite");
    await setChecked(page.locator("#applyOverwriteMode"));
    assert.equal(await page.locator("#applyStartButton").isDisabled(), false, "overwrite is allowed without a copy destination");
    assert.equal(await page.evaluate(() => window.__nativePickerCalls), 0, "batch-save open does not invoke a native picker");
    await page.locator("#applyCloseButton").click();

    // DI-057/058: the real project table renders durable empty/completed rows,
    // their dates/count/status, and each row's own export/delete controls.
    await page.evaluate(() => showProjectList());
    await page.waitForFunction(() => document.querySelector("#projectListDialog").open);
    const emptyRow = page.locator(`#projectListBody tr[data-project-id="${emptyId}"]`);
    const completedRow = page.locator(`#projectListBody tr[data-project-id="${completedId}"]`);
    assert.match(await emptyRow.textContent(), /empty-live/);
    assert.match(await emptyRow.textContent(), /0/);
    assert.equal(await emptyRow.locator('[data-project-action="delete"]').isDisabled(), false, "empty project remains deletable");
    assert.match(await completedRow.textContent(), /completed-live/);
    const completedProject = await page.evaluate((id) => projectListProjects.get(id), completedId);
    assert.equal(completedProject.status, "completed");
    assert.equal(completedProject.imageCount, 1);
    assert.ok(completedProject.createdAt > 0);
    const completedCells = await completedRow.locator(":scope > *").allTextContents();
    const expectedCompletedCells = await page.evaluate((project) => [
      projectTitle(project), t("project.completed"), t("project.imageCount", { count: 1 }), projectSource(project),
      projectDate(project.createdAt), projectDate(project.updatedAt),
    ], completedProject);
    assert.deepEqual(completedCells.slice(0, 6).map((value) => value.trim()), expectedCompletedCells, "completed row displays exact status, count, source, createdAt and updatedAt values");
    assert.equal(await completedRow.locator('[data-project-action="mosaic"]').isDisabled(), false, "completed row retains mosaic ZIP action");
    assert.equal(await completedRow.locator('[data-project-action="exclude"]').isDisabled(), false, "completed row retains exclusion ZIP action");
    assert.equal(await completedRow.locator('[data-project-action="delete"]').isDisabled(), false, "completed row retains delete action");
    assert.equal(await completedRow.locator('[data-project-action="mosaic"], [data-project-action="exclude"], [data-project-action="delete"]').count(), 3, "completed row keeps both ZIP controls and delete");

    await emptyRow.locator('[data-project-action="open"]').click();
    await waitForCatalog(page, emptyId, 0);
    assert.deepEqual(await page.evaluate(() => ["saveButton", "detectCurrentButton", "clearCurrentMasksButton", "undoButton", "redoButton"].map((id) => document.getElementById(id).disabled)), [true, true, true, true, true], "empty project disables image edit and save actions");
    assert.equal(await page.locator("#pickFolder").isDisabled(), false, "empty project still permits image import");
    await page.locator("#projectButton").click();
    assert.equal(await page.locator("#projectName").isDisabled(), false, "empty named project remains renameable");
    await page.locator("#projectClose").click();

    // DI-059: resume the same completed project and compare its displayed row.
    await page.evaluate(() => showProjectList());
    await page.waitForFunction(() => document.querySelector("#projectListDialog").open);
    const beforeResume = await page.evaluate((id) => {
      const project = projectListProjects.get(id);
      return { createdAt: project.createdAt, updatedAt: project.updatedAt };
    }, completedId);
    await page.locator(`#projectListBody tr[data-project-id="${completedId}"] [data-project-action="open"]`).click();
    await waitForCatalog(page, completedId, 1);
    await page.locator("#projectButton").click();
    await page.waitForFunction(() => document.querySelector("#projectDialog").open && !document.querySelector("#projectResume").hidden);
    await page.locator("#projectResume").click();
    await page.waitForFunction((id) => state.project?.id === id && state.project.status === "working" && !state.projectReadOnly, completedId);
    await page.evaluate(() => showProjectList());
    await page.waitForFunction(() => document.querySelector("#projectListDialog").open);
    const afterResume = await page.evaluate((id) => {
      const project = projectListProjects.get(id);
      return { status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt };
    }, completedId);
    assert.equal(afterResume.status, "working");
    assert.equal(afterResume.createdAt, beforeResume.createdAt, "resume preserves created timestamp");
    assert.ok(afterResume.updatedAt > beforeResume.updatedAt, "resume advances updated timestamp");
    const resumedRow = page.locator(`#projectListBody tr[data-project-id="${completedId}"]`);
    assert.equal((await resumedRow.locator(":scope > *").nth(1).textContent()).trim(), await page.evaluate(() => t("project.working")), "table displays exact resumed status");
    assert.equal((await resumedRow.locator(".project-date-cell").nth(0).textContent()).trim(), await page.evaluate((value) => projectDate(value), afterResume.createdAt), "table preserves exact createdAt display");
    assert.equal((await resumedRow.locator(".project-date-cell").nth(1).textContent()).trim(), await page.evaluate((value) => projectDate(value), afterResume.updatedAt), "table displays exact advanced updatedAt value");
  } finally {
    await context?.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
