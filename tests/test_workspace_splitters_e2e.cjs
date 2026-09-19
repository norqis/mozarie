const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function pointer(page, target, startFraction, deltaX) {
  const box = await target.boundingBox();
  assert.ok(box, "splitter is visible");
  const x = box.x + box.width * startFraction;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (deltaX) await page.mouse.move(x + deltaX, y);
  await page.mouse.up();
}

nodeTest("workspace pane splitters preserve content and use gesture deltas", { timeout: 45000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2 && document.querySelectorAll(".gallery-item").length === 2);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);

    const contentState = async () => page.evaluate(() => ({
      currentId: state.currentId,
      imageIds: state.images.map((image) => image.id),
      selected: [...state.selectedImageIds],
      candidateCount: state.candidates.length,
    }));
    const before = await contentState();

    for (const contract of [
      { selector: "#gallerySplitter", delta: 100, expectedChange: 100, defaultWidth: 260 },
      { selector: "#candidateSplitter", delta: -100, expectedChange: 100, defaultWidth: 320 },
    ]) {
      const splitter = page.locator(contract.selector);
      const initial = Number(await splitter.getAttribute("aria-valuenow"));
      await pointer(page, splitter, 0.5, 0);
      assert.equal(Number(await splitter.getAttribute("aria-valuenow")), initial, `${contract.selector} click does not resize the pane`);
      assert.equal((await contentState()).currentId, before.currentId, `${contract.selector} click preserves the current image`);

      for (const fraction of [0.15, 0.5, 0.85]) {
        await splitter.dblclick();
        assert.equal(Number(await splitter.getAttribute("aria-valuenow")), contract.defaultWidth, `${contract.selector} double-click restores the 1920px default`);
        await pointer(page, splitter, fraction, contract.delta);
        assert.equal(Number(await splitter.getAttribute("aria-valuenow")), contract.defaultWidth + contract.expectedChange, `${contract.selector} drag uses the pointer delta regardless of the grab point`);
        assert.equal((await contentState()).currentId, before.currentId, `${contract.selector} drag from ${fraction} preserves the current image`);
      }

      await splitter.focus();
      const beforeKey = Number(await splitter.getAttribute("aria-valuenow"));
      await page.keyboard.press("ArrowLeft");
      const afterLeft = Number(await splitter.getAttribute("aria-valuenow"));
      await page.keyboard.press("ArrowRight");
      const afterRight = Number(await splitter.getAttribute("aria-valuenow"));
      assert.notEqual(afterLeft, beforeKey, `${contract.selector} ArrowLeft changes the width`);
      assert.equal(afterRight, beforeKey, `${contract.selector} opposite arrow restores the prior width`);
      assert.equal((await contentState()).currentId, before.currentId, `${contract.selector} arrow keys do not navigate the catalog`);
    }

    assert.deepEqual(await contentState(), before, "pane resizing never changes the current image, selection, candidates, or catalog");
  } finally {
    await context.close();
    await browser.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
  }
});
