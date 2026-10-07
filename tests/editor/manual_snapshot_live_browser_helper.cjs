"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await page.locator(".gallery-item").first().click();
    await page.waitForFunction(() => state.currentImage && !state.pendingImageId);
    const brush = async () => {
      await page.locator("#brushTool").click();
      await page.locator("#brushSize").fill("3"); await page.locator("#brushSize").dispatchEvent("input");
      const point = await page.evaluate(() => {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + state.view.x + 40 * state.view.scale, y: rect.top + state.view.y + 30 * state.view.scale };
      });
      await page.mouse.click(point.x, point.y);
    };
    const mode = process.argv[3] || "selection";
    const target = await page.evaluate((mode) => mode === "selection"
      ? state.images.find((image) => image.id !== state.currentId).id : state.currentId, mode);
    const peer = await context.newPage();
    await peer.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await peer.waitForFunction(() => state.settings && state.images.length === 2);
    if (mode.endsWith("copy")) {
      await brush();
      await page.evaluate(() => flushWorkspaceDraft(state.currentId));
    }
    const peerSave = () => peer.evaluate(async (imageId) => {
      const image = (await api("/api/images")).images.find((image) => image.id === imageId);
      const mask = document.createElement("canvas"); mask.width = image.width; mask.height = image.height;
      const ctx = mask.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(10, 12, 1, 1);
      return api(`/api/workspace/manual/${imageId}`, { method: "POST", body: JSON.stringify({
        add: mask.toDataURL(), hasEffectiveMask: true, expectedManualRevision: image.manualRevision,
      }) });
    }, target);
    const peerResult = await peerSave();
    // The editor stays visible: selection itself must pair newly fetched pixels
    // with their revision, without depending on a focus/visibility refresh.
    if (mode === "selection") {
      await page.locator(".gallery-item").nth(1).click();
      await page.waitForFunction((id) => state.currentId === id && !state.pendingImageId, target);
      assert.equal(await page.evaluate(() => addCtx.getImageData(10, 12, 1, 1).data[3]), 255);
      assert.equal(await page.evaluate(() => currentRecord().manualRevision), peerResult.manualRevision);
    } else if (mode === "rename" || mode === "return" || mode.endsWith("copy")) {
      await page.keyboard.press("F2");
      await page.locator("#renameImageFilename").fill("renamed.png");
      await page.locator("#renameImageConfirm").click();
      await page.waitForFunction(() => !document.querySelector("#renameImageDialog").open);
      if (mode === "return") {
        await page.evaluate(() => syncCatalogOnReturn());
        assert.equal(await page.evaluate(() => addCtx.getImageData(10, 12, 1, 1).data[3]), 255);
      }
    } else if (mode === "resync") {
      await page.evaluate(() => resyncCatalog());
    } else if (mode === "remove") {
      await page.evaluate(async () => {
        state.settings.confirmations.removeImage = false;
        await removeImagesFromList([state.images.find((image) => image.id !== state.currentId).id]);
      });
    } else if (mode === "import") {
      await page.evaluate(async () => {
        const surface = document.createElement("canvas"); surface.width = 4; surface.height = 4;
        const blob = await new Promise((resolve) => surface.toBlob(resolve));
        await importFiles([new File([blob], "new.png", { type: "image/png" })]);
      });
    }
    if (mode.endsWith("copy")) {
      const request = page.waitForRequest((request) => request.url().endsWith("/api/save/render"));
      const response = page.waitForResponse((response) => response.url().endsWith("/api/save/render"));
      if (mode === "single-copy") {
        await page.evaluate(() => openSingleSaveDialog());
        await page.locator("#singleSaveStartButton").click();
      } else {
        await page.evaluate(() => runBrowserSave([state.currentId], "_stale", false, "copy").catch(() => {}));
      }
      const [renderRequest, renderResponse] = await Promise.all([request, response]);
      assert.equal(renderRequest.postDataJSON().expectedManualRevision, peerResult.manualRevision - 1);
      assert.equal(renderResponse.status(), 400);
      await page.waitForFunction(() => !state.saving && !state.saveStarting);
      console.log(`${mode} does not render stale pixels against a newer catalogue revision`);
      return;
    }
    await brush();
    if (mode !== "selection" && mode !== "return") {
      assert.equal(await page.evaluate(async () => {
        try { await flushWorkspaceDraft(state.currentId); return null; } catch (error) { return error.code; }
      }), "manual_revision_conflict", `${mode} must not attach a new catalog revision to the old canvas`);
      assert.deepEqual(await peer.evaluate(async (imageId) => {
        const { draft } = await api(`/api/workspace/manual/${imageId}`);
        const bitmap = await createImageBitmap(await fetch(draft.add).then((response) => response.blob()));
        const surface = document.createElement("canvas"); surface.width = bitmap.width; surface.height = bitmap.height;
        const ctx = surface.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return [ctx.getImageData(10, 12, 1, 1).data[3], ctx.getImageData(40, 30, 1, 1).data[3]];
      }, target), [255, 0]);
      console.log(`${mode} keeps peer pixels and the old canvas revision separate`);
      return;
    }
    await page.evaluate(() => flushWorkspaceDraft(state.currentId));
    const savedRevision = await page.evaluate(() => currentRecord().manualRevision);
    assert.equal(savedRevision, peerResult.manualRevision + 1);
    assert.deepEqual(await page.evaluate(async () => {
      const { draft } = await api(`/api/workspace/manual/${state.currentId}`);
      const bitmap = await createImageBitmap(await fetch(draft.add).then((response) => response.blob()));
      const surface = document.createElement("canvas"); surface.width = bitmap.width; surface.height = bitmap.height;
      const ctx = surface.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [ctx.getImageData(10, 12, 1, 1).data[3], ctx.getImageData(40, 30, 1, 1).data[3]];
    }), [255, 255]);

    const nextPeerResult = await peerSave();
    await page.route(`**/api/workspace/manual/${target}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, draft: { ...body.draft, add: "data:image/png;base64,bm90LXBuZw==" } } });
    });
    const failed = await page.evaluate(async () => {
      state.drafts.delete(state.currentId);
      return selectImage(state.currentId, true, { saveCurrentDraft: false, preserveOnFailure: true });
    });
    assert.equal(failed, false);
    assert.equal(await page.evaluate(() => currentRecord().manualRevision), savedRevision, "failed decode never blesses the old canvas with a new revision");
    assert.equal(await page.evaluate(() => addCtx.getImageData(40, 30, 1, 1).data[3]), 255);
    await page.unroute(`**/api/workspace/manual/${target}`);
    await page.evaluate(() => document.querySelector("#errorDialog")?.close());
    await page.evaluate(() => selectImage(state.currentId, true, { saveCurrentDraft: false, preserveOnFailure: true }));
    assert.equal(await page.evaluate(() => currentRecord().manualRevision), nextPeerResult.manualRevision);
    assert.equal(await page.evaluate(() => addCtx.getImageData(40, 30, 1, 1).data[3]), 0);
    console.log("image selection adopts the manual pixels and revision together; decode failure retains both");
  } finally { await context.close(); await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
