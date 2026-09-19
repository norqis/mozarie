"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64");
const replacementPng = fs.readFileSync(path.join(__dirname, "..", "static", "logo.png"));

function catalog(count, { longNames = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `catalog-${String(index).padStart(3, "0")}`,
    relativePath: longNames
      ? `folder-${index % 3}/very-long-image-name-${String(index).padStart(3, "0")}-日本語.png`
      : `folder-${index % 3}/image-${String(index).padStart(3, "0")}.png`,
    sourceKind: "fixture",
    width: 2,
    height: 2,
    candidateCount: 0,
    enabledCandidateCount: 0,
    candidateRevision: 0,
    reviewed: false,
    hidden: false,
    assetVersion: `asset-${index}`,
  }));
}

async function openFixture(images, body, contextOptions = {}) {
  const fixture = await startFixtureServer();
  fixture.setCatalog(images);
  let browser;
  let context;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", ...contextOptions });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    await body({ ...fixture, page, context });
  } finally {
    await context?.close();
    await browser?.close();
    await closeServer(fixture.server);
  }
}

async function gotoCatalog(page, url, expectedCount) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/images" && item.status() === 200);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await response;
  await page.waitForFunction((count) => state.images.length === count && document.querySelectorAll(".gallery-item").length > 0, expectedCount);
}

test("eight-image catalog keeps id, name, dimensions, thumbnail, and original-image correspondence", { timeout: 60000 }, async () => {
  const images = catalog(8);
  const colors = images.map((_, index) => [32 + index * 20, 48 + index * 10, 224 - index * 20]);
  await openFixture(images, async ({ page, context, url }) => {
    await context.route(/\/api\/(?:thumbnail|image)\/[^/?]+/, async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      const color = colors[images.findIndex((image) => image.id === id)];
      if (!color) { await route.fallback(); return; }
      const body = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="rgb(${color.join(",")})"/></svg>`;
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body });
    });
    await gotoCatalog(page, url, images.length);
    assert.deepEqual(await page.evaluate(() => state.images.map(({ id, relativePath, width, height }) => ({ id, relativePath, width, height }))),
      images.map(({ id, relativePath, width, height }) => ({ id, relativePath, width, height })), "the public catalog snapshot preserves every id/name/dimension tuple");

    const cards = await page.locator(".gallery-item").evaluateAll((nodes) => nodes.map((node) => ({
      id: node.dataset.id,
      name: node.querySelector(".gallery-name").textContent,
      dimensions: node.querySelector(".gallery-meta").textContent,
      thumbnailPath: new URL(node.querySelector("img").src).pathname,
    })));
    assert.deepEqual(cards, images.map((image) => ({
      id: image.id,
      name: image.relativePath.split("/").at(-1),
      dimensions: "2 × 2",
      thumbnailPath: `/api/thumbnail/${image.id}`,
    })), "all eight visible cards bind their own id to the expected basename, dimensions, and thumbnail URL");

    const decoded = await page.evaluate(async ({ records, expectedColors }) => Promise.all(records.map(async (record, index) => {
      const thumbnail = new Image();
      thumbnail.src = `/api/thumbnail/${encodeURIComponent(record.id)}?v=${encodeURIComponent(record.assetVersion)}`;
      await thumbnail.decode();
      const original = new Image();
      original.src = `/api/image/${encodeURIComponent(record.id)}?v=${encodeURIComponent(record.assetVersion)}`;
      await original.decode();
      const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2; const context = canvas.getContext("2d");
      context.drawImage(thumbnail, 0, 0); const thumbnailPixel = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      context.clearRect(0, 0, 2, 2); context.drawImage(original, 0, 0); const originalPixel = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      const result = { id: record.id, thumbnail: [thumbnail.naturalWidth, thumbnail.naturalHeight], original: [original.naturalWidth, original.naturalHeight], thumbnailPixel, originalPixel, expected: expectedColors[index] };
      return result;
    })), { records: images, expectedColors: colors });
    assert.deepEqual(decoded, images.map((image, index) => ({ id: image.id, thumbnail: [2, 2], original: [2, 2], thumbnailPixel: colors[index], originalPixel: colors[index], expected: colors[index] })),
      "every card decodes an id-specific thumbnail whose pixels match that id's full original");
    assert.equal(await page.locator(".gallery-item").evaluateAll((cards) => cards.every((card) => {
      const image = card.querySelector("img"); const error = card.querySelector(".thumbnail-error");
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && error.hidden;
    })), true, "all eight cards contain a decoded thumbnail with no blank, broken-image, or retry state");
  });
});

test("candidate ownership, manual-only loading, and asset-version cache replacement stay image-local", { timeout: 60000 }, async () => {
  const images = catalog(3);
  const originalRequests = [];
  const maskRequests = [];
  let candidateVersion = 1;
  await openFixture(images, async ({ page, context, url }) => {
    await context.route("**/api/candidates/**", async (route) => {
      const imageId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      const candidates = imageId === images[0].id
        ? [{ id: `owned-by-first-v${candidateVersion}`, role: "apply", enabled: true, forced: false, labelToken: "penis", source: "target", refinement: null, confidence: 0.9, color: "#ff3d4d" }]
        : [];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ candidates, candidateRevision: imageId === images[0].id ? candidateVersion : 0 }) });
    });
    await context.route("**/api/mask/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: route.request().url().includes("owned-by-first-v2") ? replacementPng : png }));
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/image/")) originalRequests.push(request.url());
      if (pathname.startsWith("/api/mask/")) maskRequests.push(request.url());
    });
    await gotoCatalog(page, url, images.length);

    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.candidateImages.size === 1, images[0].id);
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, candidates: state.candidates.map((item) => item.id), masks: [...state.candidateImages.keys()] })),
      { currentId: images[0].id, candidates: ["owned-by-first-v1"], masks: ["owned-by-first-v1"] }, "candidate metadata and decoded mask remain attached to the selected owner image");

    await page.evaluate((imageId) => {
      const layer = document.createElement("canvas"); layer.width = 2; layer.height = 2;
      const layerContext = layer.getContext("2d"); layerContext.fillStyle = "#fff"; layerContext.fillRect(0, 0, 1, 1);
      state.drafts.set(imageId, { add: layer.toDataURL(), exclusion: "", exclusionErase: "", manualEnabled: true, candidateRevision: 0, removedCandidateIds: [] });
    }, images[1].id);
    const masksBeforeManualOnly = maskRequests.length;
    await page.locator(`.gallery-item[data-id="${images[1].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage && state.candidates.length === 0, images[1].id);
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, candidates: state.candidates.length, masks: state.candidateImages.size, manual: state.manualMaskPresent, canvas: [originalCanvas.width, originalCanvas.height] })),
      { currentId: images[1].id, candidates: 0, masks: 0, manual: true, canvas: [2, 2] }, "an image with a real manual workspace layer opens without any candidate-mask request");
    assert.equal(maskRequests.length, masksBeforeManualOnly, "selecting the manual-only image sends no candidate-mask request");

    const cacheEvidence = await page.evaluate(async (imageId) => {
      const record = state.images.find((item) => item.id === imageId);
      const first = await cachedImage(record);
      const again = await cachedImage(record);
      const oldKey = imageCacheKey(record);
      record.assetVersion = "replacement-version";
      const replacement = await cachedImage(record);
      const replacementKey = imageCacheKey(record);
      releaseStaleImageVersions(imageId, replacementKey, candidateCacheKey(imageId, Number(record.candidateRevision || 0)));
      return { reused: first === again, replaced: replacement !== first, oldKey, replacementKey, keys: [...state.imageCache.items.keys()] };
    }, images[1].id);
    assert.equal(cacheEvidence.reused, true, "the app cache reuses a decoded image without issuing another fetch");
    assert.equal(cacheEvidence.replaced, true, "a changed asset version decodes a new image instead of returning the old bitmap");
    assert.equal(cacheEvidence.keys.includes(cacheEvidence.oldKey), false, "the old asset version is evicted after replacement");
    assert.equal(cacheEvidence.keys.includes(cacheEvidence.replacementKey), true, "the current asset version remains cached");
    const secondImageRequests = originalRequests.filter((requestUrl) => new URL(requestUrl).pathname.endsWith(`/${images[1].id}`));
    assert.equal(secondImageRequests.filter((requestUrl) => new URL(requestUrl).searchParams.get("v") === images[1].assetVersion).length, 1, "the original version is fetched once despite repeated cache reads");
    assert.equal(secondImageRequests.filter((requestUrl) => new URL(requestUrl).searchParams.get("v") === "replacement-version").length, 1, "the replacement version is fetched exactly once");

    const firstImageRequestCount = originalRequests.filter((requestUrl) => new URL(requestUrl).pathname.endsWith(`/${images[0].id}`)).length;
    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images[0].id);
    assert.equal(originalRequests.filter((requestUrl) => new URL(requestUrl).pathname.endsWith(`/${images[0].id}`)).length, firstImageRequestCount,
      "returning to a still-owned image displays the cached original without a duplicate request");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "cache reuse does not report that the source image changed");

    candidateVersion = 2;
    await page.locator(`.gallery-item[data-id="${images[1].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id, images[1].id);
    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.candidates[0]?.id === "owned-by-first-v2", images[0].id);
    assert.deepEqual(await page.evaluate((imageId) => ({
      revision: state.images.find((image) => image.id === imageId).candidateRevision,
      candidates: state.candidates.map((candidate) => candidate.id),
      masks: [...state.candidateImages].map(([id, image]) => [id, image.width, image.height]),
      cacheKeys: [...state.candidateBundleCache.items.keys()].filter((key) => key.startsWith(`${imageId}:`)),
    }), images[0].id), {
      revision: 2,
      candidates: ["owned-by-first-v2"],
      masks: [["owned-by-first-v2", 409, 401]],
      cacheKeys: [`${images[0].id}:2`],
    }, "candidate revision two replaces revision one metadata, mask pixels, and cache key without displaying the stale candidate");
    assert.equal(maskRequests.some((requestUrl) => requestUrl.includes("owned-by-first-v1")), true, "revision one mask was fetched before replacement");
    assert.equal(maskRequests.some((requestUrl) => requestUrl.includes("owned-by-first-v2")), true, "revision two fetches its distinct replacement mask");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((count) => state.images.length === count && document.querySelectorAll(".gallery-item").length > 0, images.length);
    await page.waitForFunction((id) => document.querySelector(`.gallery-item[data-id="${id}"] img`)?.naturalWidth > 0, images[0].id);
    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images[0].id);
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "after reload the thumbnail and original redisplay without a source-changed error");
  });
});

test("four-hundred-image traversal loads thumbnails lazily and does not review unseen images", { timeout: 90000 }, async () => {
  const images = catalog(400);
  const thumbnailIds = new Set();
  const originalIds = new Set();
  await openFixture(images, async ({ page, url }) => {
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/thumbnail/")) thumbnailIds.add(decodeURIComponent(pathname.split("/").at(-1)));
      if (pathname.startsWith("/api/image/")) originalIds.add(decodeURIComponent(pathname.split("/").at(-1)));
    });
    await gotoCatalog(page, url, images.length);
    for (const image of images) {
      await page.evaluate((id) => scrollCatalogImage("gallery", id), image.id);
      await page.waitForFunction((id) => document.querySelector(`.gallery-item[data-id="${id}"] img`)?.naturalWidth > 0, image.id);
    }
    assert.equal(thumbnailIds.size, 400, "traversing all 400 logical cards eventually decodes every thumbnail");
    assert.equal(originalIds.size, 0, "scrolling the catalog alone never fetches any full-resolution original");
    assert.equal(await page.locator(".gallery-item").count() < 80, true, "the 400-image catalog retains only the viewport window of cards");

    const filterWindows = await page.evaluate(() => {
      const sizes = [];
      for (let index = 0; index < 12; index += 1) {
        state.galleryFilter = index % 2 ? new Set(["unreviewed"]) : new Set();
        renderGallery(true); sizes.push(state.galleryNodes.size);
      }
      return sizes;
    });
    assert.equal(filterWindows.every((size) => size < 80), true, `repeated all/unreviewed switches return to a bounded DOM window (${filterWindows.join(",")})`);

    const cacheSizes = await page.evaluate(async (ids) => {
      const sizes = [];
      for (const id of ids) { await selectImage(id, true); sizes.push(state.imageCache.items.size); }
      await selectImage(ids[0], true); sizes.push(state.imageCache.items.size);
      return { sizes, currentId: state.currentId };
    }, images.slice(0, 20).map((image) => image.id));
    assert.equal(cacheSizes.sizes.every((size) => size <= 3), true, `twenty full-image selections and a return to the first stay within current/neighbor ownership (${cacheSizes.sizes.join(",")})`);
    assert.equal(cacheSizes.currentId, images[0].id, "the first image redisplays after twenty decoded originals without retaining all prior bitmaps");

    originalIds.clear();
    await page.evaluate((id) => scrollCatalogImage("gallery", id), images.at(-1).id);
    await page.waitForFunction((id) => Boolean(document.querySelector(`.gallery-item[data-id="${id}"]`)), images.at(-1).id);
    await page.locator(`.gallery-item[data-id="${images.at(-1).id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images.at(-1).id);
    assert.deepEqual(await page.evaluate(() => ({ reviewed: state.images.filter((item) => item.reviewed).map((item) => item.id), count: state.images.length })),
      { reviewed: [], count: 400 }, "reaching and selecting the last image does not mark any unseen image reviewed");
    assert.equal(await page.evaluate(() => state.imageCache.items.size <= 2), true, "decoded full-resolution images remain bounded to the selected image and its one existing neighbor");
    assert.equal(originalIds.size <= 2, true, `selection fetches only the selected/neighbor originals, not all 400 (actual ${originalIds.size})`);
    assert.equal(originalIds.has(images.at(-1).id), true, "the selected last image uses its original endpoint");
  });
});

test("missing originals and failed thumbnails stay local and recover only on explicit retry", { timeout: 60000 }, async () => {
  const images = catalog(4);
  const missingId = images[1].id;
  const failedThumbnailId = images[2].id;
  let missingOriginalRequests = 0;
  let failedThumbnailRequests = 0;
  await openFixture(images, async ({ page, context, url }) => {
    await context.route(`**/api/image/${missingId}*`, async (route) => {
      missingOriginalRequests += 1;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error_code: "image_not_found" }) });
    });
    await context.route(`**/api/thumbnail/${failedThumbnailId}*`, async (route) => {
      failedThumbnailRequests += 1;
      if (failedThumbnailRequests === 1) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error_code: "internal_error" }) });
      else await route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
    await gotoCatalog(page, url, images.length);
    await page.waitForFunction((id) => !document.querySelector(`.gallery-item[data-id="${id}"] .thumbnail-error`)?.hidden, failedThumbnailId);

    const retry = page.locator(`.gallery-item[data-id="${failedThumbnailId}"] .thumbnail-error`);
    await retry.click();
    await page.waitForFunction((id) => {
      const card = document.querySelector(`.gallery-item[data-id="${id}"]`);
      return card?.querySelector("img")?.naturalWidth > 0 && card.querySelector(".thumbnail-error")?.hidden;
    }, failedThumbnailId);
    assert.equal(failedThumbnailRequests, 2, "the failed card alone retries once and then displays its image");

    await page.locator(`.gallery-item[data-id="${images[0].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images[0].id);
    const beforeMissingSelection = missingOriginalRequests;
    await page.locator(`.gallery-item[data-id="${missingId}"]`).click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.match(await page.locator("#errorDialog").textContent(), /画像が見つかりません|移動または削除/, "the missing source is explained as a moved or deleted image");
    assert.deepEqual(await page.evaluate(() => ({ currentId: state.currentId, filename: document.querySelector("#currentFileName").textContent })),
      { currentId: images[0].id, filename: images[0].relativePath }, "a missing original reports an error while retaining the previously displayed image");
    await page.locator("#errorDialogClose").click();
    assert.equal(missingOriginalRequests, beforeMissingSelection + 1, "a failed selection produces one foreground request even when an earlier neighbor prefetch failed");
    await page.locator(`.gallery-item[data-id="${images[3].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images[3].id);
    assert.equal(missingOriginalRequests, beforeMissingSelection + 1, "a failed selection does not create a background retry loop while another image is selected");
    await page.locator(`.gallery-item[data-id="${missingId}"]`).click();
    await page.waitForFunction(() => document.querySelector("#errorDialog").open);
    assert.equal(missingOriginalRequests, beforeMissingSelection + 2, "one explicit retry produces exactly one additional original request");
    await page.locator("#errorDialogClose").click();

    await page.locator(`.gallery-item[data-id="${images[3].id}"]`).click();
    await page.waitForFunction((id) => state.currentId === id && state.currentImage, images[3].id);
    assert.equal(await page.locator(`.gallery-item[data-id="${images[0].id}"] img`).evaluate((image) => image.naturalWidth > 0), true, "a neighboring successful thumbnail stays visible and its original remains selectable after another card failed");
    assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, "thumbnail failure and recovery do not block normal image selection with a generic dialog");
  });
});

test("browser imports publish valid files around corrupt inputs and preserve the catalog when all fail", { timeout: 60000 }, async () => {
  const initial = catalog(1);
  await openFixture(initial, async ({ page, url, setCatalog }) => {
    const published = [...initial];
    const uploadedNames = [];
    await page.route("**/api/import/file", async (route) => {
      const headers = route.request().headers();
      const name = decodeURIComponent(headers["x-mozarie-name"] || "");
      uploadedNames.push(name);
      if (name.includes("broken")) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error_code: "image_read_failed" }) });
        return;
      }
      const imageId = `imported-${published.length}`;
      published.push({ ...catalog(1)[0], id: imageId, relativePath: name, assetVersion: imageId });
      setCatalog(published);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ catalogId: "fixture-import-catalog", imported: [{ clientKey: decodeURIComponent(headers["x-mozarie-client-key"] || ""), imageId }] }) });
    });
    await gotoCatalog(page, url, initial.length);
    await page.evaluate(async () => {
      state.settings.importing.parallelism = 1;
      await importFiles([
        new File(["valid"], "valid-first.png", { type: "image/png" }),
        new File(["broken"], "broken-middle.png", { type: "image/png" }),
        new File(["valid"], "valid-last.png", { type: "image/png" }),
      ]);
    });
    await page.waitForFunction(() => document.querySelector("#importFailuresDialog").open && !state.importing);
    assert.deepEqual(uploadedNames, ["valid-first.png", "broken-middle.png", "valid-last.png"], "the completed import accounts for all three selected files in order");
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id),
      status: document.querySelector("#connectionStatus").textContent,
      genericError: document.querySelector("#errorDialog").open,
      failures: [...document.querySelectorAll("#importFailuresList li")].map((item) => item.textContent),
    })), {
      ids: [initial[0].id, "imported-1", "imported-2"],
      status: "2件の画像を追加しました",
      genericError: false,
      failures: ["broken-middle.png: 画像を読み込めません"],
    }, "valid files on both sides are published while the corrupt relative name and reason use only the dedicated failure dialog");
    await page.locator("#importFailuresClose").click();
    for (const imageId of ["imported-1", "imported-2"]) {
      await page.waitForFunction((id) => {
        const thumbnail = document.querySelector(`.gallery-item[data-id="${id}"] img`);
        return thumbnail?.complete && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0;
      }, imageId);
      await page.locator(`.gallery-item[data-id="${imageId}"]`).click();
      await page.waitForFunction((id) => state.currentId === id && state.currentImage && originalCanvas.width > 0 && originalCanvas.height > 0, imageId);
      assert.equal(await page.locator("#errorDialog").evaluate((dialog) => dialog.open), false, `${imageId} continues from its decoded thumbnail into the editor`);
    }

    const beforeAllCorrupt = await page.evaluate(() => state.images.map((image) => image.id));
    await page.evaluate(async () => importFiles([new File(["broken"], "only-broken.png", { type: "image/png" })]));
    await page.waitForFunction(() => document.querySelector("#importFailuresDialog").open && !state.importing);
    assert.deepEqual(await page.evaluate(() => ({
      ids: state.images.map((image) => image.id),
      summary: document.querySelector("#importFailuresSummary").textContent,
      genericError: document.querySelector("#errorDialog").open,
      failures: [...document.querySelectorAll("#importFailuresList li")].map((item) => item.textContent),
    })), {
      ids: beforeAllCorrupt,
      summary: "0件を読み込み、1件を読み込めませんでした。",
      genericError: false,
      failures: ["only-broken.png: 画像を読み込めません"],
    }, "an all-corrupt selection preserves the published catalog and reports every failed name without a generic replacement error");
  });
});

test("gallery cards keep footer geometry across minimum, maximum, reload, and tail scroll", { timeout: 60000 }, async () => {
  const images = catalog(80, { longNames: true });
  await openFixture(images, async ({ page, url }) => {
    await page.addInitScript(() => { if (!localStorage.getItem("mozarie.galleryWidth")) localStorage.setItem("mozarie.galleryWidth", "144"); });
    await gotoCatalog(page, url, images.length);
    const assertGeometry = async (label) => {
      const geometry = await page.locator(".gallery-item").evaluateAll((cards) => cards.filter((card) => card.getBoundingClientRect().height > 0).map((card) => {
        const rect = (node) => { const value = node.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, height: value.height }; };
        const badge = card.querySelector(".gallery-review-badge");
        return { card: rect(card), image: rect(card.querySelector("img")), footer: rect(card.querySelector(".catalog-card-footer")), name: rect(card.querySelector(".gallery-name")), meta: rect(card.querySelector(".gallery-meta")), badgeVisible: getComputedStyle(badge).display !== "none" && rect(badge).height > 0 };
      }));
      assert.equal(geometry.length > 0, true, `${label}: mounted cards exist`);
      for (const item of geometry) {
        assert.equal(Math.round(item.card.height), 144, `${label}: card keeps the fixed 144px row height`);
        assert.equal(item.footer.top >= item.card.top && item.footer.bottom <= item.card.bottom, true, `${label}: footer remains within the card`);
        assert.equal(item.name.left >= item.footer.left && item.name.right <= item.meta.left, true, `${label}: filename remains in its footer column`);
        assert.equal(item.meta.right <= item.footer.right && item.name.bottom <= item.footer.bottom && item.meta.bottom <= item.footer.bottom, true, `${label}: dimensions and filename remain inside the footer`);
        assert.equal(item.image.bottom <= item.footer.top, true, `${label}: thumbnail does not push footer content out of the card`);
        assert.equal(item.badgeVisible, true, `${label}: the review-state badge remains visible in the card`);
      }
      for (let left = 0; left < geometry.length; left += 1) for (let right = left + 1; right < geometry.length; right += 1) {
        const first = geometry[left].card; const second = geometry[right].card;
        const overlaps = first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
        assert.equal(overlaps, false, `${label}: mounted cards do not overlap in rows or columns`);
      }
      return { columns: new Set(geometry.filter((item) => item.card.top === geometry[0].card.top).map((item) => Math.round(item.card.left))).size };
    };

    const reloadAtWidth = async (width) => {
      await page.evaluate((value) => localStorage.setItem("mozarie.galleryWidth", String(value)), width);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(([count, expectedWidth]) => state.images.length === count
        && document.querySelectorAll(".gallery-item").length > 0
        && Math.round(document.querySelector("#galleryPane").getBoundingClientRect().width) === expectedWidth, [images.length, width]);
    };

    const minimum = await assertGeometry("144px restored width");
    assert.equal(minimum.columns, 1, "the minimum gallery width uses one card column");
    assert.equal(Math.round(await page.locator("#galleryPane").evaluate((pane) => pane.getBoundingClientRect().width)), 144, "stored minimum gallery width is applied before user interaction");

    await reloadAtWidth(216);
    const widestSingle = await assertGeometry("216px widest single-column width");
    assert.equal(widestSingle.columns, 1, "216px keeps the widest intended one-column card without clipping its footer");
    assert.equal(Math.round(await page.locator("#galleryPane").evaluate((pane) => pane.getBoundingClientRect().width)), 216, "the saved 216px width is restored exactly on reload without another drag");

    await reloadAtWidth(260);
    const twoColumns = await assertGeometry("260px two-column boundary");
    assert.equal(twoColumns.columns, 2, "the wider boundary lays cards out in two non-overlapping columns");

    await reloadAtWidth(216);
    assert.equal((await assertGeometry("returned one-column width")).columns, 1, "returning from two columns restores the one-column geometry");

    const before = await page.locator("#gallery").evaluate((gallery) => { gallery.scrollTop = gallery.scrollHeight; gallery.dispatchEvent(new Event("scroll")); return gallery.scrollTop; });
    await page.waitForFunction((id) => Boolean(document.querySelector(`.gallery-item[data-id="${id}"]`)), images.at(-1).id);
    await page.waitForFunction((id) => document.querySelector(`.gallery-item[data-id="${id}"] img`)?.naturalWidth > 0, images.at(-1).id);
    const after = await page.locator("#gallery").evaluate((gallery) => gallery.scrollTop);
    assert.equal(after, before, "loading tail thumbnails does not move the gallery scroll position");
    await assertGeometry("tail scroll");
  });
});
