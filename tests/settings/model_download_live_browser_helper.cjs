"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");

async function main() {
  const [origin, mode] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  let release; let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route("**/api/update/status", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ available: false, current: "0.5.36" }),
    }));
    if (mode === "pending") {
      await page.route("**/api/model-download/start", async (route) => {
        const response = await route.fetch();
        reached(); await gate;
        await route.fulfill({ response });
      });
    }
    if (mode === "lost-response") {
      let first = true;
      await page.route("**/api/model-download/start", async (route) => {
        if (!first) return route.continue();
        first = false;
        await route.fetch();
        await route.abort("failed");
      });
    }
    async function openDownload(variant = "vit_b") {
      await page.waitForFunction(() => state.settings && typeof state.serverCatalogGeneration === "number");
      await page.locator("#settingsButton").click();
      await page.locator("#settingsTabModels").click();
      if (!await page.locator("#settingsPrecisionToggle").isChecked()) await page.locator("#settingsPrecisionCard label.model-switch").click();
      await page.locator(`#settingsSamVariants input[value="${variant}"]`).check();
      await page.locator('[data-model-download="sam"]').click();
    }
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await openDownload();
    await page.locator("#modelDownloadStart").click();
    if (mode === "pending") {
      await started;
      assert.equal((await (await page.request.get(`${origin}/api/model-download`)).json()).state, "running");
      assert.equal(await page.locator("#modelDownloadClose").isDisabled(), true);
      await page.keyboard.press("Escape");
      await expect(page.locator("#modelDownloadDialog")).toBeVisible();
      release();
    }
    if (mode === "lost-response") {
      await page.waitForFunction(() => state.status?.connectionFailure);
      await expect(page.locator("#modelDownloadClose")).toBeEnabled();
      await expect(page.locator("#modelDownloadStart")).toBeVisible();
    } else await expect(page.locator("#modelDownloadCancel")).toBeVisible();
    if (mode !== "pending") {
      if (mode === "reload") {
        await page.reload({ waitUntil: "domcontentloaded" });
        await openDownload("vit_l");
      }
      const conflict = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/model-download/start");
      await page.locator("#modelDownloadStart").click();
      assert.equal((await conflict).status(), 400, "the real manager rejects a second download");
      await expect(page.locator("#modelDownloadCancel")).toBeVisible();
      await expect(page.locator("#modelDownloadItems")).toContainText("vit_b");
      await expect(page.locator("#modelDownloadItems")).not.toContainText("vit_l");
      await expect(page.locator("#errorDialog")).not.toBeVisible();
    }
    await page.locator("#modelDownloadCancel").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent === t("modelDownload.cancelled"));
    await expect(page.locator("#modelDownloadClose")).toBeEnabled();
    await expect(page.locator("#modelDownloadCancel")).not.toBeVisible();
    await expect(page.locator("#errorDialog")).not.toBeVisible();
    await page.locator("#modelDownloadClose").click();
    await expect(page.locator("#modelDownloadDialog")).not.toBeVisible();
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
