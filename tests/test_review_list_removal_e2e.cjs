"use strict";

const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

nodeTest("review choices survive editing and list-only removal preserves source access boundaries", { timeout: 60000 }, async (t) => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const catalogue = ["A", "B", "C", "D"].map((id) => ({ id, relativePath: `${id}.png`, sourceKind: "filesystem", width: 100, height: 80,
    candidateCount: 0, enabledCandidateCount: 0, reviewed: id !== "B", hidden: false }));
  async function reset(images = catalogue) {
    fixture.resetScenario(); fixture.setCatalog(images);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((count) => state.settings && state.images.length === count && !isBusy(), images.length);
    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage && !currentImageActionPending(), images[0].id);
  }
  try {
    await t.test("brush undo redo and hidden labels retain the explicit reviewed flag", async () => {
      await reset([{ ...catalogue[0], reviewed: false }]);
      await page.evaluate(() => {
        const source = document.createElement("canvas"); source.width = 100; source.height = 80;
        source.getContext("2d").fillRect(0, 0, 100, 80);
        state.currentImage = source; canvasSizeForImage(source); prepareOriginalImage(); fitImage(); render();
      });
      await page.locator('.gallery-item[data-id="A"]').click({ button: "right" });
      await page.locator("#toggleReviewMenuItem").click();
      await page.waitForFunction(() => currentRecord().reviewed && state.imageMutationChains.size === 0);
      await page.locator("#brushTool").click();
      const point = await page.evaluate(() => { const rect = canvas.getBoundingClientRect(); return { x: rect.left + state.view.x + state.currentImage.width * state.view.scale / 2, y: rect.top + state.view.y + state.currentImage.height * state.view.scale / 2 }; });
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => state.historyIndex > 0 && state.workspaceDraftChains.size === 0);
      assert.equal(await page.locator("#reviewStatus").textContent(), "確認済");
      await page.locator("#undoButton").click();
      await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
      assert.equal(await page.evaluate(() => currentRecord().reviewed), true);
      await page.locator("#redoButton").click();
      await page.waitForFunction(() => state.historyIndex === 2 && !state.historyRestoreBusy);
      assert.equal(await page.evaluate(() => currentRecord().reviewed), true);
      await page.locator("#undoButton").click();
      await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
      await page.locator("#undoButton").click();
      await page.waitForFunction(() => state.historyIndex === 0 && !state.historyRestoreBusy);
      assert.equal(await page.evaluate(() => currentRecord().reviewed), false, "undoing the explicit review operation changes the flag");
      await page.locator("#redoButton").click();
      await page.waitForFunction(() => state.historyIndex === 1 && !state.historyRestoreBusy);
      assert.equal(await page.evaluate(() => currentRecord().reviewed), true);
      await page.locator("#removeCurrentImageButton").click();
      await page.waitForFunction(() => currentRecord().hidden && state.imageMutationChains.size === 0);
      assert.equal(await page.locator("#reviewStatus").textContent(), "非表示");
      assert.equal(await page.locator(".gallery-review-badge").textContent(), "非表示");
      await page.locator("#overviewButton").click();
      assert.equal(await page.locator(".overview-review-badge").textContent(), "非表示");
      assert.equal(await page.evaluate(() => currentRecord().reviewed && state.reviewedImageIds.has("A")), true);
    });

    await t.test("orange footer removes from the filtered list and navigates next then previous", async () => {
      await reset();
      const placement = await page.locator("#removeFromListButton").evaluate((button) => ({ previous: button.previousElementSibling.id, label: button.textContent, color: getComputedStyle(button).backgroundColor }));
      assert.equal(placement.previous, "removeAndNextButton"); assert.equal(placement.label, "一覧から削除");
      assert.equal(placement.color, "rgb(88, 59, 32)");
      await page.locator("#galleryFilterButton").click();
      await page.locator('[data-gallery-filter="reviewed"]').check();
      await page.locator("#galleryFilterButton").click();
      await page.locator('.gallery-item[data-id="C"]').click();
      await page.waitForFunction(() => state.currentId === "C" && !currentImageActionPending());
      await page.locator("#removeFromListButton").click();
      await page.waitForFunction(() => state.currentId === "D" && !isBusy());
      await page.locator("#removeFromListButton").click();
      await page.waitForFunction(() => state.currentId === "A" && !isBusy());
      assert.deepEqual(fixture.catalogRemoveRequests, [["C"], ["D"]]);
      assert.deepEqual(fixture.catalogImageIds(), ["A", "B"]);
      assert.deepEqual(fixture.sourceDeleteRequests, []);
    });

    await t.test("gallery context and overview multiselection remove only their targets", async () => {
      await reset();
      await page.evaluate(() => { state.drafts.set("C", { marker: "removed" }); state.projectHistory.set("C", { canUndo: true }); state.sourceAccess.set("C", { marker: "source" }); });
      await page.locator('.gallery-item[data-id="C"]').click({ button: "right" });
      await page.locator("#removeFromListMenuItem").click();
      await page.waitForFunction(() => !state.images.some((image) => image.id === "C") && !isBusy());
      assert.deepEqual(await page.evaluate(() => ({ current: state.currentId, drafts: state.drafts.has("C"), history: state.projectHistory.has("C"), source: state.sourceAccess.has("C") })), { current: "A", drafts: false, history: false, source: false });
      await reset();
      await page.locator("#overviewButton").click(); await page.locator("#batchModeButton").click();
      await page.locator('.overview-item[data-id="C"]').click(); await page.locator('.overview-item[data-id="D"]').click();
      await page.locator('.overview-item[data-id="C"]').click({ button: "right" });
      await page.locator("#removeFromListMenuItem").click();
      await page.waitForFunction(() => state.images.length === 2 && !isBusy());
      assert.deepEqual(fixture.catalogRemoveRequests, [["C", "D"]]);
      assert.equal(await page.evaluate(() => state.currentId), "A");
      assert.deepEqual(await page.evaluate(() => [...state.selectedImageIds]), []);
      await page.locator('.overview-item[data-id="A"]').click(); await page.locator('.overview-item[data-id="B"]').click();
      await page.locator("#selectionActionsButton").click(); await page.locator('[data-selection-action="removeFromList"]').click();
      await page.waitForFunction(() => state.images.length === 0 && !isBusy());
      assert.equal(await page.evaluate(() => state.currentId), null);
      assert.deepEqual(fixture.sourceDeleteRequests, []);
    });

    await t.test("failed read-only and busy list removal leave the catalogue and editor intact", async () => {
      await reset();
      await page.route("**/api/catalog/remove", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error_code: "workspace_write_failed" }) }));
      await page.locator("#removeFromListButton").click();
      await page.waitForFunction(() => document.querySelector("#errorDialog").open && !isBusy());
      assert.deepEqual(await page.evaluate(() => ({ ids: state.images.map((image) => image.id), current: state.currentId, loaded: Boolean(state.currentImage) })), { ids: ["A", "B", "C", "D"], current: "A", loaded: true });
      await page.locator("#errorDialogClose").click(); await page.unroute("**/api/catalog/remove");
      await page.evaluate(async () => {
        state.projectReadOnly = true; updateActionButtons(); await removeImagesFromList([currentRecord()]);
      });
      assert.equal(await page.locator("#removeFromListButton").isDisabled(), true);
      await page.evaluate(async () => { state.projectReadOnly = false; state.catalogMutation = true; updateActionButtons(); await removeImagesFromList([currentRecord()]); state.catalogMutation = false; updateActionButtons(); });
      assert.deepEqual(fixture.catalogRemoveRequests, []);
      assert.deepEqual(fixture.sourceDeleteRequests, []);
    });
    await t.test("footer and context list removal accept unavailable and dimension-changed sources", async () => {
      for (const unavailable of [false, true]) {
        await reset();
        await page.evaluate((missing) => {
          if (missing) { currentRecord().sourceAvailable = false; state.currentImage = null; }
          else currentRecord().sourceDimensionsChanged = true;
          updateActionButtons();
        }, unavailable);
        assert.equal(await page.locator("#removeFromListButton").isDisabled(), false);
        assert.equal(await page.locator("#removeAndNextButton").isDisabled(), true);
        await page.locator('.gallery-item[data-id="A"]').click({ button: "right" });
        assert.equal(await page.locator("#removeFromListMenuItem").isDisabled(), false);
        if (unavailable) await page.locator("#removeFromListMenuItem").click();
        else { await page.keyboard.press("Escape"); await page.locator("#removeFromListButton").click(); }
        await page.waitForFunction(() => !state.images.some((image) => image.id === "A") && !isBusy());
        assert.deepEqual(fixture.catalogRemoveRequests, [["A"]]);
        assert.deepEqual(fixture.sourceDeleteRequests, []);
      }
      await page.evaluate(() => { clearCurrentImageSelection(); updateActionButtons(); });
      assert.equal(await page.locator("#removeFromListButton").isDisabled(), true);
    });
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});
