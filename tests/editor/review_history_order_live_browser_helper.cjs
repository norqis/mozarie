"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");

async function main() {
  const [origin, mode] = process.argv.slice(2);
  const contextReview = mode.startsWith("context");
  const initiallyReviewed = mode === "context-clear";
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    const ids = await page.evaluate(() => Object.fromEntries(state.images.map((image) => [image.relativePath, image.id])));
    const imageId = ids["gesture.png"];
    const select = async () => {
      await page.locator(`.gallery-item[data-id="${imageId}"]`).click();
      await page.waitForFunction((id) => state.currentId === id && state.currentImage && !state.pendingImageId && hasDurableHistory(), imageId);
    };
    await select();
    let flagPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `/api/workspace/image/${imageId}`) flagPosts++;
    });
    let fail = mode.endsWith("failure");
    if (fail) {
      const endpoint = mode === "manual-failure" ? `**/api/workspace/manual/${imageId}/commit` : `**/api/workspace/image/${imageId}`;
      await page.route(endpoint, (route) => fail
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary failure", error_code: "internal_error" }) })
        : route.continue());
    }
    await page.locator("#brushTool").click();
    await page.locator("#brushSize").fill("10");
    await page.locator("#brushSize").dispatchEvent("input");
    await page.evaluate(() => {
      const native = HTMLCanvasElement.prototype.toBlob;
      window.releaseReviewEncoder = () => { HTMLCanvasElement.prototype.toBlob = native; };
      let held = false;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...options) {
        if (this === addCanvas && !held) {
          held = true;
          return native.call(this, (blob) => {
            window.reviewEncoderReady = true;
            window.releaseReviewEncoder = () => { HTMLCanvasElement.prototype.toBlob = native; callback(blob); };
          }, ...options);
        }
        return native.call(this, callback, ...options);
      };
    });
    const point = await page.evaluate(() => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + state.view.x + 40 * state.view.scale, y: rect.top + state.view.y + 30 * state.view.scale };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.reviewEncoderReady);
    const review = async () => {
      if (contextReview) {
        await page.locator(`.gallery-item[data-id="${imageId}"]`).click({ button: "right" });
        await page.locator("#toggleReviewMenuItem").click();
      } else await page.locator("#reviewAndNextButton").click();
    };
    await review();
    await page.waitForFunction(({ id, initial }) => candidateControlLocked(id) || state.images.find((image) => image.id === id).reviewed !== initial, { id: imageId, initial: initiallyReviewed });
    assert.equal(flagPosts, 0, "review persistence must wait for the earlier stroke encoder");
    await page.evaluate(() => { window.releaseReviewEncoder(); delete window.releaseReviewEncoder; });
    const snapshot = () => page.evaluate(() => ({ reviewed: isReviewed(currentRecord()), alpha: addCtx.getImageData(40, 30, 1, 1).data[3] }));
    if (fail) {
      await expect(page.locator("#errorDialog")).toBeVisible();
      await page.waitForFunction((id) => !candidateControlLocked(id), imageId);
      assert.equal(await page.evaluate(() => state.currentId), imageId, "failed save must not navigate");
      assert.deepEqual(await snapshot(), { reviewed: initiallyReviewed, alpha: 255 }, "failure retains the stroke and previous review state");
      if (mode === "manual-failure") assert.equal(flagPosts, 0, "failed stroke never publishes review");
      fail = false;
      await page.locator("#errorDialogClose").click();
      await review();
    }
    await page.waitForFunction(({ id, reviewed }) => state.images.find((image) => image.id === id).reviewed === reviewed && !candidateControlLocked(id), { id: imageId, reviewed: !initiallyReviewed });
    if (!contextReview) {
      await page.waitForFunction((id) => state.currentId === id && !state.pendingImageId, ids["other.png"]);
      await select();
    }
    const history = async (direction, reviewed, alpha) => {
      await page.locator(direction === "undo" ? "#undoButton" : "#redoButton").click();
      await expect.poll(snapshot).toEqual({ reviewed, alpha });
      await page.waitForFunction(() => !state.projectHistoryBusy && !state.pendingImageId);
    };
    await expect.poll(snapshot).toEqual({ reviewed: !initiallyReviewed, alpha: 255 });
    await history("undo", initiallyReviewed, 255);
    await history("undo", initiallyReviewed, 0);
    await history("redo", initiallyReviewed, 255);
    await history("redo", !initiallyReviewed, 255);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    await select();
    assert.deepEqual(await snapshot(), { reviewed: !initiallyReviewed, alpha: 255 }, "reload preserves both committed operations");
    await history("undo", initiallyReviewed, 255);
    await history("redo", !initiallyReviewed, 255);
    assert.equal(await page.evaluate((id) => state.images.find((image) => image.id === id).reviewed, ids["other.png"]), false);
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(() => window.releaseReviewEncoder?.()).catch(() => {});
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
