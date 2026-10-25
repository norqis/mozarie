const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { startFixtureServer, closeServer } = require("../test_import_picker_e2e.cjs");

test("overview scrolling, native drag suppression, reorder drafts and numbering controls", async () => {
  const fixture = await startFixtureServer();
  const records = Array.from({ length: 104 }, (_, index) => ({
    id: "page-" + index, relativePath: "page-" + index + ".png", sourceKind: "filesystem",
    width: 100, height: 80, candidateCount: 0, reviewed: index === 0 || index === 3, hidden: false,
  }));
  fixture.setCatalog(records);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    const imports = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/import/file") imports.push(request.url()); });
    let applyRequests = 0; let failApply = false; let staleApply = false;
    await page.route("**/api/catalog/reorder", async (route) => {
      applyRequests++;
      if (staleApply) return route.fulfill({ status: 409, json: { error_code: "stale_catalog", params: {} } });
      if (failApply) return route.fulfill({ status: 500, json: { error_code: "internal_error", params: {} } });
      const ids = route.request().postDataJSON().imageIds;
      const byId = new Map(records.map((record) => [record.id, record]));
      const data = await (await context.request.get(fixture.url + "/api/images")).json();
      data.images = ids.map((id) => byId.get(id)); fixture.setCatalog(data.images);
      await route.fulfill({ json: data });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 104);
    const nativeDrag = await page.locator(".gallery-item img").first().evaluate((image) => ({
      draggable: image.draggable, allowed: image.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true })),
    }));
    assert.deepEqual(nativeDrag, { draggable: false, allowed: false });
    await page.locator("#overviewButton").click();
    await page.locator("#overviewGrid").hover();
    await page.mouse.wheel(0, 900);
    await page.waitForFunction(() => document.querySelector("#overviewGrid").scrollTop > 300);
    const footer = await page.locator(".overview-item").first().evaluate((item) => {
      const card = item.getBoundingClientRect(), name = item.querySelector(".overview-item-name"), dimensions = item.querySelector(".overview-item-dimensions");
      return { name: name.textContent, dimensions: dimensions.textContent,
        visible: name.getBoundingClientRect().bottom <= card.bottom && dimensions.getBoundingClientRect().bottom <= card.bottom };
    });
    assert.ok(footer.name.endsWith(".png")); assert.equal(footer.dimensions, "100 × 80"); assert.equal(footer.visible, true);
    assert.ok(await page.locator(".overview-item").count() < records.length);
    await page.locator("#overviewGrid").evaluate((grid) => { grid.scrollTop = 0; });
    await page.locator(".overview-item").first().waitFor();

    const original = await page.evaluate(() => state.images.map((image) => image.id));
    await page.locator("#reorderImagesButton").click();
    await page.waitForFunction(() => state.reorder !== null);
    assert.equal(await page.locator("#overviewQuery").isDisabled(), true);
    await page.locator('.overview-item[data-id="page-0"]').click();
    assert.equal(await page.locator("#reorderPrevious").isDisabled(), true);
    await page.locator("#reorderNext").click();
    assert.deepEqual(await page.evaluate(() => state.reorder.ids.slice(0, 2)), ["page-1", "page-0"]);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), original);
    await page.locator("#reorderLast").click();
    assert.equal(await page.locator("#reorderNext").isDisabled(), true);
    await page.locator("#reorderFirst").click();
    await page.locator("#reorderNext").click();
    await page.locator("#reorderPrevious").click();

    const source = page.locator('.overview-item[data-id="page-0"]');
    const target = page.locator('.overview-item[data-id="page-3"]');
    const from = await source.boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + 30); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 8 });
    await page.waitForFunction(() => state.reorder.ids[3] === "page-0");
    const preview = await page.evaluate(() => {
      const ghost = document.querySelector(".reorder-ghost");
      const bounds = ghost.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width,
        pointerEvents: getComputedStyle(ghost).pointerEvents,
        placeholder: document.querySelector('.overview-item[data-id="page-0"]').classList.contains("reorder-placeholder"),
        original: state.images[0].id,
        animations: [...state.reorder.drag.animations.values()].length };
    });
    assert.ok(Math.abs(preview.x - to.x) < 2);
    assert.ok(Math.abs(preview.y - to.y) < 2);
    assert.ok(Math.abs(preview.width - from.width) < 2);
    assert.equal(preview.pointerEvents, "none"); assert.equal(preview.placeholder, true);
    assert.equal(preview.original, "page-0"); assert.ok(preview.animations > 0);
    await page.mouse.up();
    await page.waitForFunction(() => state.reorder.ids[3] === "page-0");
    await page.waitForFunction(() => !document.querySelector(".reorder-ghost, .reorder-placeholder"));
    assert.equal(imports.length, 0);
    await page.locator("#reorderCancel").click();
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), original);
    assert.equal(applyRequests, 0);

    await page.locator("#reorderImagesButton").click();
    await page.locator('.overview-item[data-id="page-0"]').click();
    await page.locator('.overview-item[data-id="page-0"]').press("Alt+ArrowRight");
    assert.equal(await page.evaluate(() => state.reorder.ids[1]), "page-0");
    failApply = true;
    await page.locator("#reorderApply").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open && !state.reorder.pending);
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), original);
    await page.locator("#errorDialogClose").click();
    failApply = false;
    await page.locator("#reorderApply").click();
    await page.waitForFunction(() => state.reorder === null);
    assert.deepEqual(await page.evaluate(() => state.images.slice(0, 2).map((image) => image.id)), ["page-1", "page-0"]);
    await page.locator("#overviewFilterButton").click();
    await page.locator('[data-overview-filter="reviewed"]').check();
    await page.locator("#reorderImagesButton").click();
    await page.locator('.overview-item[data-id="page-3"]').click();
    await page.locator("#reorderPrevious").click();
    assert.deepEqual(await page.evaluate(() => overviewImages().map((image) => image.id)), ["page-3", "page-0"]);
    await page.locator("#reorderNext").click();
    assert.deepEqual(await page.evaluate(() => overviewImages().map((image) => image.id)), ["page-0", "page-3"]);
    await page.locator('.overview-item[data-id="page-3"]').press("Alt+ArrowLeft");
    assert.deepEqual(await page.evaluate(() => overviewImages().map((image) => image.id)), ["page-3", "page-0"]);
    await page.locator("#reorderCancel").click();
    await page.locator("#overviewFilterButton").click();
    await page.locator('[data-overview-filter="reviewed"]').uncheck();
    await page.locator("#reorderImagesButton").click();
    await page.locator("#overviewGrid").evaluate((grid) => { grid.scrollTop = 0; });
    const dragSource = await page.locator('.overview-item[data-id="page-0"]').boundingBox();
    const viewport = await page.locator("#overviewGrid").boundingBox();
    await page.mouse.move(dragSource.x + dragSource.width / 2, dragSource.y + 30); await page.mouse.down();
    await page.mouse.move(dragSource.x + dragSource.width / 2, viewport.y + viewport.height - 15, { steps: 5 });
    await page.waitForFunction(() => document.querySelector("#overviewGrid").scrollTop > 250);
    await page.mouse.up();
    await page.waitForFunction(() => state.reorder.ids.indexOf("page-0") > 8);
    await page.locator("#reorderCancel").click();
    assert.equal(imports.length, 0);
    await page.locator("#reorderImagesButton").click();
    await page.locator('.overview-item[data-id="page-0"]').click();
    await page.locator("#reorderNext").click();
    staleApply = true;
    await page.route("**/api/images", (route) => route.abort());
    await page.locator("#reorderApply").click();
    await page.waitForFunction(() => state.reorder === null && document.querySelector("#errorDialog").open);
    assert.equal(await page.locator("#reorderImagesButton").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => overviewImages().map((image) => image.id)), ["page-1", "page-0", ...original.slice(2)]);
    assert.deepEqual(pageErrors, []);
    await page.locator("#errorDialogClose").click();
    await page.unroute("**/api/images");
    staleApply = false;
    await page.locator("#closeOverviewButton").click();
    const galleryOrder = await page.locator(".gallery-item").evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
    assert.deepEqual(galleryOrder, ["page-1", "page-0", ...original.slice(2)].slice(0, galleryOrder.length));

    await page.locator("#saveAllButton").click();
    assert.equal(await page.locator("#applyNumberingDigits").isDisabled(), true);
    assert.equal(await page.locator("#applyNumberingPlacement").isDisabled(), true);
    await page.locator("#applyNumbering").check();
    assert.equal(await page.locator("#applyNumberingDigits").isEnabled(), true);
    assert.equal(await page.locator("#applyNumberingPlacement").isEnabled(), true);
    assert.equal(await page.locator("#applySuffix").isDisabled(), true);
    for (const placement of ["only", "prefix", "suffix"]) await page.locator("#applyNumberingPlacement").selectOption(placement);
    await page.locator("#applyNumberingDigits").fill("3");
    await page.locator("#applyNumberingDigits").fill("2");
    let saveRequests = 0;
    page.on("request", (request) => { if (/\/api\/save\/(prepare|reserve|render)/.test(request.url())) saveRequests++; });
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.match(await page.locator("#errorDialogCause").textContent(), /104/);
    assert.match(await page.locator("#errorDialogAction").textContent(), /3/);
    assert.equal(saveRequests, 0);
    await page.locator("#errorDialogClose").click();
    await page.locator("#applyNumbering").uncheck();
    assert.equal(await page.locator("#applyNumberingDigits").isDisabled(), true);
    assert.equal(await page.locator("#applySuffix").isEnabled(), true);
    await page.locator("#applyCloseButton").click();
    await page.route("**/api/import/file", async (route) => {
      const record = { ...records[0], id: "external", relativePath: "external.png" };
      const byId = new Map(records.map((item) => [item.id, item]));
      fixture.setCatalog([...fixture.catalogImageIds().map((id) => byId.get(id)), record]);
      await route.fulfill({ json: { imported: [{ imageId: record.id,
        clientKey: decodeURIComponent(route.request().headers()["x-mozarie-client-key"]) }] } });
    });
    await page.locator("#gallery").evaluate(async (gallery) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], "external.png", { type: "image/png" }));
      gallery.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => !state.importing && state.images.some((image) => image.relativePath === "external.png"));
    assert.equal(imports.length, 1);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});

test("reorder drag follows across rows, rolls back cancellation and respects filtered reduced motion", async () => {
  const fixture = await startFixtureServer();
  const records = Array.from({ length: 160 }, (_, index) => ({
    id: `drag-${index}`, relativePath: `folder-${index}/image.png`, sourceKind: "filesystem",
    width: 100, height: 80, candidateCount: 0, reviewed: index % 2 === 0, hidden: false,
  }));
  fixture.setCatalog(records);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 160);
    await page.locator("#overviewButton").click();
    await page.locator("#reorderImagesButton").click();
    const begin = async (id) => {
      const box = await page.locator(`.overview-item[data-id="${id}"]`).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 30); await page.mouse.down();
      return box;
    };
    const move = async (id) => {
      const box = await page.locator(`.overview-item[data-id="${id}"]`).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 6 });
      return box;
    };
    await begin("drag-0");
    await page.evaluate(() => { window.folderOption = document.querySelector("#overviewFolder option"); });
    const destination = await move("drag-9");
    await page.waitForFunction(() => state.reorder.ids[9] === "drag-0");
    assert.equal(await page.evaluate(() => window.folderOption === document.querySelector("#overviewFolder option")), true,
      "slot changes retain folder controls instead of rebuilding all folder options");
    assert.equal(await page.locator(".reorder-placeholder").count(), 1);
    const ghostBefore = await page.locator(".reorder-ghost").boundingBox();
    await page.mouse.move(destination.x + destination.width / 2 + 8, destination.y + 34);
    await page.waitForFunction((x) => Math.abs(document.querySelector(".reorder-ghost").getBoundingClientRect().x - x) < 1, ghostBefore.x + 8);
    await page.locator("#overviewGrid").evaluate((grid) => grid.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 99 })));
    assert.equal(await page.locator(".reorder-ghost").count(), 1, "unrelated pointer does not cancel drag");
    await page.locator("#overviewGrid").evaluate((grid) => grid.dispatchEvent(new PointerEvent("pointercancel", { pointerId: state.reorder.drag.pointerId })));
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => state.reorder.ids), records.map((record) => record.id));
    assert.equal(await page.locator(".reorder-ghost, .reorder-placeholder").count(), 0);
    await begin("drag-0"); await move("drag-2");
    await page.waitForFunction(() => state.reorder.ids[2] === "drag-0");
    await page.locator("#overviewGrid").evaluate((grid) => grid.releasePointerCapture(state.reorder.drag.pointerId));
    await page.waitForFunction(() => !state.reorder.drag); await page.mouse.up();
    assert.equal(await page.evaluate(() => state.reorder.ids[0]), "drag-0");
    await begin("drag-0"); await move("drag-9");
    await page.waitForFunction(() => state.reorder.ids[9] === "drag-0");
    await page.mouse.up();
    await page.waitForFunction(() => !state.reorder.settle);
    assert.equal(await page.locator(".reorder-ghost, .reorder-placeholder").count(), 0);
    assert.equal(await page.evaluate(() => state.reorder.ids[9]), "drag-0");
    await page.locator("#reorderCancel").click();
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), records.map((record) => record.id));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#overviewFilterButton").click();
    await page.locator('[data-overview-filter="reviewed"]').check();
    await page.locator("#reorderImagesButton").click();
    await begin("drag-0"); await move("drag-6");
    await page.waitForFunction(() => overviewImages()[3].id === "drag-0");
    assert.equal(await page.evaluate(() => state.reorder.drag.animations.size), 0);
    assert.equal(await page.evaluate(() => state.reorder.ids.indexOf("drag-1") < state.reorder.ids.indexOf("drag-3")), true);
    await page.mouse.up();
    assert.equal(await page.locator(".reorder-ghost, .reorder-placeholder").count(), 0);
    await page.locator("#reorderCancel").click();
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), records.map((record) => record.id));
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await closeServer(fixture.server); }
});

for (const outcome of ["success", "failure", "stale"]) {
  test(`reorder apply ${outcome} restores visible cards after an idle poll without scrolling`, { timeout: 60000 }, async () => {
    const fixture = await startFixtureServer();
    const records = Array.from({ length: 104 }, (_, index) => ({ id: `lock-${index}`,
      relativePath: `lock-${index}.png`, sourceKind: "filesystem", width: 1, height: 1,
      candidateCount: 0, candidateRevision: 0, reviewed: false, hidden: false }));
    fixture.setCatalog(records);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let held; let reached;
      const requested = new Promise((resolve) => { reached = resolve; });
      await page.route("**/api/catalog/reorder", (route) => { held = route; reached(); });
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.images.length === 104);
      await page.evaluate(() => appStartup);
      await page.evaluate(async () => {
        clearTimeout(state.jobPollTimer);
        await state.pollInFlight;
        clearTimeout(state.jobPollTimer);
      });
      const snapshot = await (await context.request.get(fixture.url + "/api/images")).json();
      await page.locator("#overviewButton").click();
      await page.locator("#reorderImagesButton").click();
      const from = await page.locator('.overview-item[data-id="lock-0"]').boundingBox();
      const to = await page.locator('.overview-item[data-id="lock-3"]').boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + 30);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 8 });
      await page.waitForFunction(() => state.reorder.ids[3] === "lock-0");
      await page.mouse.up();
      await page.waitForFunction(() => !state.reorder.drag && !state.reorder.settle);
      await page.locator("#reorderApply").click();
      await requested;
      // Drive the real idle job response while the reorder request is held.
      await page.evaluate(() => pollJob());
      const cards = page.locator("#overviewGrid .overview-item");
      assert.ok(await cards.count() > 0);
      assert.equal(await cards.evaluateAll((items) => items.every((item) => item.disabled && getComputedStyle(item).opacity === "0.45")), true);
      if (outcome === "success") {
        const byId = new Map(records.map((image) => [image.id, image]));
        snapshot.images = held.request().postDataJSON().imageIds.map((id) => byId.get(id));
        fixture.setCatalog(snapshot.images);
        await held.fulfill({ json: snapshot });
        await page.waitForFunction(() => state.reorder === null);
        assert.deepEqual(await page.evaluate(() => state.images.slice(0, 4).map((image) => image.id)), ["lock-1", "lock-2", "lock-3", "lock-0"]);
      } else {
        await held.fulfill({ status: outcome === "stale" ? 409 : 500, json: { error_code: outcome === "stale" ? "stale_catalog" : "internal_error" } });
        await page.locator("#errorDialog").waitFor({ state: "visible" });
        await page.waitForFunction(() => !state.reorder?.pending);
        assert.equal(await page.evaluate(() => Boolean(state.reorder)), outcome === "failure");
        await page.locator("#errorDialogClose").click();
      }
      assert.equal(await page.locator("#overviewGrid").evaluate((grid) => grid.scrollTop), 0);
      assert.equal(await cards.evaluateAll((items) => items.every((item) => !item.disabled && getComputedStyle(item).opacity === "1" && !item.hasAttribute("data-disabled-by-lock"))), true,
        "existing visible cards recover immediately without scrolling");
      if (outcome === "failure") await page.locator("#reorderCancel").click();
      await page.locator('.overview-item[data-id="lock-0"]').click();
      await page.waitForFunction(() => state.currentId === "lock-0" && state.currentImage && !state.pendingImageId);
      assert.deepEqual(errors, []);
    } finally {
      await context.close(); await browser.close();
      fixture.server.closeAllConnections(); await closeServer(fixture.server);
    }
  });
}
