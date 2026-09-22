"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && state.images.length === 1 && Number.isSafeInteger(state.serverCatalogGeneration));
    const result = await page.evaluate(async () => {
      const image = state.images[0];
      const token = crypto.randomUUID();
      const payload = { imageId: image.id, candidateRevision: image.candidateRevision, clientSaveToken: token, copyToDefault: false, format: "original", keepMetadata: true, divisor: 100, draft: null };
      await api("/api/save/reserve", { method: "POST", body: JSON.stringify(payload) });
      const response = await renderSingleSave(payload);
      const reader = response.body.getReader();
      const chunks = [];
      const first = await reader.read();
      if (first.done || !first.value.byteLength) throw new Error("render stream ended without image bytes");
      chunks.push(first.value);
      await api(`/api/images/${image.id}/transform`, { method: "POST", body: JSON.stringify({ flipH: false, flipV: true }) });
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      reader.releaseLock();
      const blob = new Blob(chunks, { type: response.headers.get("Content-Type") });
      const bitmap = await createImageBitmap(blob);
      const dimensions = [bitmap.width, bitmap.height];
      bitmap.close();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      let mismatchCode;
      try { await renderSingleSave(payload); }
      catch (error) { mismatchCode = error.code; showUserError(error); }
      await api("/api/save/cancel", { method: "POST", body: JSON.stringify({ imageId: image.id, candidateRevision: payload.candidateRevision, saveToken: token }) });
      return { status: response.status, dimensions, digest, size: blob.size, mismatchCode };
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.dimensions, [1024, 1024]);
    assert.ok(result.size > 1024 * 1024, "the decoded response came from a multi-chunk image stream");
    assert.equal(result.mismatchCode, "save_state_changed");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#errorDialogCause").textContent(), await page.evaluate(() => t("errorDialog.save_state_changed.cause")));
    process.stdout.write(JSON.stringify(result));
  } finally {
    await context?.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
