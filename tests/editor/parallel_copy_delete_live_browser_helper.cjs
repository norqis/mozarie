"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
    const kind = process.argv[3] || "native";
    if (kind !== "native") {
      await page.waitForFunction(() => state.settings && !state.importing);
      await page.evaluate(async (kind) => {
        const parent = await navigator.storage.getDirectory();
        const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
        canvas.getContext("2d").fillRect(0, 0, 64, 48);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const entries = [];
        for (const name of kind.startsWith("recovery") ? ["browser1.png"] : ["browser1.png", "browser2.png"]) {
          const fileHandle = await parent.getFileHandle(name, { create: true });
          const stream = await fileHandle.createWritable(); await stream.write(blob); await stream.close();
          entries.push({ file: await fileHandle.getFile(), relativePath: name, fileHandle, parentHandle: parent });
        }
        await importFiles(entries);
      }, kind);
    }
    if (kind.startsWith("recovery")) {
      await page.waitForFunction(() => state.images.length === 1 && !state.importing);
      const prepares = [];
      await page.route("**/api/catalog/delete-source/prepare", async (route) => {
        prepares.push(route.request().postDataJSON());
        if (prepares.length === 1) await route.abort("failed"); else await route.continue();
      });
      await page.evaluate(async () => { await runBrowserSave(state.images.map((image) => image.id), "_recovery", true, "copy"); });
      const savedEdits = await page.evaluate(async () => (await pendingSourceDeletes())[0].savedEdits);
      assert.equal(savedEdits.transformRevision, 0);
      assert.deepEqual(savedEdits, prepares[0].savedEdits, "IndexedDB owns the exact copy's edit version before prepare");
      await page.evaluate(async (kind) => {
        const image = state.images[0];
        await api(kind === "recovery-flip" ? `/api/images/${image.id}/transform` : `/api/workspace/manual/${image.id}`, {
          method: "POST", body: JSON.stringify(kind === "recovery-flip" ? { flipH: true, flipV: false } : { manualEnabled: false, hasEffectiveMask: false }),
        });
        await resumePendingSourceDeletes();
      }, kind);
      assert.deepEqual(prepares[1].savedEdits, savedEdits, "retry uses the saved copy version after a new edit");
      assert.equal(await page.evaluate(async () => (await (await navigator.storage.getDirectory()).getFileHandle("browser1.png")).kind), "file");
      assert.equal(await page.evaluate(async () => (await api("/api/images")).images.length), 1);
      console.log("copy delete recovery retained the source and new peer edit");
      return;
    }
    await page.waitForFunction(() => state.settings && state.images.length === 2);
    let release;
    const bothCommits = new Promise((resolve) => { release = resolve; });
    const requests = [], statuses = [];
    const firstBrowserDelete = kind === "browser"
      ? page.waitForResponse((response) => response.url().endsWith("/api/catalog/delete-source") && response.status() === 200)
      : null;
    // Network boundary barrier: both real renders must finish before either
    // commit reaches the real server. A serial implementation cannot pass.
    await page.route("**/api/save/commit", async (route) => {
      requests.push(route.request().postDataJSON());
      const position = requests.length;
      if (requests.length === 2) release();
      await bothCommits;
      if (position === 2 && firstBrowserDelete) await firstBrowserDelete;
      await route.continue();
    });
    page.on("response", (response) => { if (response.url().endsWith("/api/save/commit")) statuses.push(response.status()); });
    await page.evaluate(async () => {
      state.settings.saving.parallelism = 2;
      await runBrowserSave(state.images.map((image) => image.id), "_parallel", true, "copy");
    });
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map((request) => request.imageId)).size, 2);
    assert.deepEqual(statuses, [200, 200], "deleting one source does not invalidate the other prepared save");
    assert.equal(await page.evaluate(() => state.images.length), 0);
    if (kind === "browser") assert.deepEqual(await page.evaluate(async () => {
      const names = []; for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name); return names;
    }), [], "browser file handles and their cached server images are both removed");
    console.log("parallel copy/delete completed both original files");
  } finally { await context.close(); await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
