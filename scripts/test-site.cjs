"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const siteRoot = path.join(root, "site");
const canonicalUrl = "https://norqis.github.io/mozarie/";
const googleTagId = "G-BLX3GDM1WQ";
const googleTagUrl = `https://www.googletagmanager.com/gtag/js?id=${googleTagId}`;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".xml": "application/xml; charset=utf-8",
};

function startSite() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(siteRoot, requested);
    if (!file.startsWith(`${siteRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" }).end(await fs.readFile(file));
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())) });
    });
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ headers: response.headers, status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

function localOnly(site) {
  return (route) => new URL(route.request().url()).origin === site.url ? route.continue() : route.abort();
}

function activeImage(page) {
  return page.locator('[data-gallery-slide][data-gallery-position="active"] img');
}

test("the editorial landing page works without JavaScript and fits every supported viewport", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 768, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 960 }]) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      const response = await page.goto(`${site.url}/`, { waitUntil: "load" });
      assert.equal(response.status(), 200);
      assert.equal(await page.title(), "Mozarie | Windowsで画像のモザイク範囲を検出・編集・保存");
      assert.equal(await page.locator("h1").innerText(), "画像のモザイク範囲を検出・編集・保存");
      assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Mozarieは、PNG・JPEG・WebP画像のモザイク範囲をWindows上でローカル検出、確認、編集、保存できるアプリです。");
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), canonicalUrl);
      assert.equal(await page.locator('meta[name="google-site-verification"]').getAttribute("content"), "UrWwBw6iDkiGPFlWk3S4jrSsP7YfkvctuNVveYOJd_o");
      assert.equal(await page.getByText("Mozarieは、PNG・JPEG・WebP画像のモザイク範囲をWindows上でローカル検出し、確認・編集・保存できるアプリです。", { exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("heading", { name: "検出から保存まで", exact: true }).isVisible(), true);
      assert.equal(await page.locator("#features .feature-list section").count(), 4);
      assert.equal(await page.locator("#faq dd").count(), 4);
      assert.equal(await page.locator("#features .feature-list p, #install p, #faq dd").evaluateAll((elements) => elements.every((element) => element.textContent.trim().length > 0)), true);
      assert.equal(await page.getByRole("heading", { name: "使い始めるまで", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("heading", { name: "よくある質問", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).count(), 1);
      assert.equal(await page.locator('footer a[lang="en"][href="https://github.com/norqis/mozarie/blob/main/README.en.md"]').count(), 1);
      assert.equal(await page.locator("[data-gallery-controls]").evaluateAll((controls) => controls.every((control) => control.hidden && getComputedStyle(control).display === "none")), true);
      assert.equal(await page.locator("[data-gallery-pause], [data-gallery-caption], [data-gallery-count]").count(), 0);
      assert.equal(await page.locator("[data-gallery-slide]:not([hidden])").count(), 1);
      assert.equal(await page.locator("[data-gallery-slide]:not([hidden]) img").getAttribute("src"), "assets/demo1.png");
      assert.equal(await page.locator("[data-gallery-slide] a").count(), 0);
      assert.equal(await page.locator("[data-gallery-open]").evaluateAll((buttons) => buttons.every((button) => button.disabled)), true);
      assert.deepEqual(await page.locator("[data-gallery-slide]:not([hidden]) img").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })), { width: 1920, height: 959, complete: true });
      assert.deepEqual(await page.locator(".brand-mark img").evaluate((image) => ({ src: image.getAttribute("src"), alt: image.getAttribute("alt"), width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })), { src: "assets/mozarie-logo.png", alt: "", width: 799, height: 547, complete: true });
      const stage = await page.locator("[data-gallery-viewport]").boundingBox();
      const image = await page.locator("[data-gallery-slide]:not([hidden]) img").boundingBox();
      const expectedWidth = viewport.width <= 700 ? viewport.width - 48 : Math.min(viewport.width * .82, 1480);
      assert.ok(image && Math.abs(image.width - expectedWidth) <= 1, `central demo image has the intended width at ${viewport.width}px`);
      assert.ok(image && Math.abs(image.width / image.height - 1920 / 959) < .002, `demo image is not cropped at ${viewport.width}px`);
      assert.equal(JSON.stringify(await page.locator(".gallery, .gallery-frame, .gallery-image, .gallery-slide img").evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, border: style.borderWidth, radius: style.borderRadius, shadow: style.boxShadow };
      }))), JSON.stringify(Array(8).fill({ background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px", shadow: "none" })));
      if (viewport.width === 1440) assert.ok(image && image.width >= 1180 && image.width <= 1182, "1440px viewport keeps the 1181px main image");
      if (viewport.width === 1920) assert.ok(image && image.width === 1480, "1920px viewport caps the main image at 1480px");
      if (viewport.width === 768) assert.ok(image && image.width >= 629 && image.width <= 631, "768px viewport keeps the 630px main image");
      if (viewport.width <= 390) {
        assert.ok(stage && stage.x === 0 && stage.width === viewport.width, `mobile stage remains full-width at ${viewport.width}px`);
        assert.ok(image && image.x >= 24 && viewport.width - image.x - image.width >= 24, `mobile image keeps 24px side margins at ${viewport.width}px`);
        const actions = await page.locator(".hero-action a").evaluateAll((links) => links.map((link) => {
          const bounds = link.getBoundingClientRect();
          return { height: bounds.height, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        }));
        assert.equal(actions.length, 2);
        assert.ok(actions.every((action) => action.height >= 48) && !(actions[0].left < actions[1].right && actions[0].right > actions[1].left && actions[0].top < actions[1].bottom && actions[0].bottom > actions[1].top), `mobile CTAs remain legible and separate at ${viewport.width}px`);
      }
      const download = await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).boundingBox();
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).getAttribute("href"), "https://github.com/norqis/mozarie/releases/latest");
      assert.ok(download && download.y >= 0 && download.y + download.height <= viewport.height, "download remains in the initial viewport");
      await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).focus();
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
      assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `no horizontal overflow at ${viewport.width}px`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the static assets and sitemap are published with the editorial source", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    for (const [file, type] of [["styles.css", /^text\/css/], ["gallery.js", /^application\/javascript/], ["sitemap.xml", /^application\/xml/]]) {
      const asset = await get(`${site.url}/${file}`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers["content-type"], type);
    }
    for (const image of ["demo1.png", "demo2.png", "demo3.png", "mozarie-logo.png"]) assert.equal((await get(`${site.url}/assets/${image}`)).status, 200);
    assert.deepEqual(await fs.readFile(path.join(root, "static", "images", "long_logo.png")), await fs.readFile(path.join(siteRoot, "assets", "mozarie-logo.png")));
    const sitemap = await get(`${site.url}/sitemap.xml`);
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const urls = await page.evaluate((xml) => [...new DOMParser().parseFromString(xml, "application/xml").querySelectorAll("loc")].map((element) => element.textContent), sitemap.text);
    assert.deepEqual(urls, [canonicalUrl]);
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the peek carousel rotates, keeps its focus and tab rules, and opens a modal preview", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", localOnly(site));
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete && image.naturalWidth === 1920));
    const gallery = page.locator("[data-gallery]");
    const viewport = page.locator("[data-gallery-viewport]");
    const previous = page.getByRole("button", { name: "前の画面" });
    const next = page.getByRole("button", { name: "次の画面" });
    const current = () => activeImage(page);

    assert.equal(await page.locator("[data-gallery-pause]").count(), 0);
    assert.equal(await page.locator("[data-gallery-slide] a").count(), 0);
    assert.deepEqual(await page.locator("[data-gallery-slide] img").evaluateAll((images) => images.map((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }))), [
      { src: "assets/demo1.png", width: 1920, height: 959, complete: true },
      { src: "assets/demo2.png", width: 1920, height: 959, complete: true },
      { src: "assets/demo3.png", width: 1920, height: 959, complete: true },
    ]);
    assert.deepEqual(await page.locator("[data-gallery-slide]").evaluateAll((slides) => slides.map((slide) => ({ hidden: slide.hidden, position: slide.dataset.galleryPosition, ariaHidden: slide.getAttribute("aria-hidden"), disabled: slide.querySelector("button").disabled }))), [
      { hidden: false, position: "active", ariaHidden: "false", disabled: false },
      { hidden: false, position: "next", ariaHidden: "true", disabled: true },
      { hidden: false, position: "previous", ariaHidden: "true", disabled: true },
    ]);
    const [previousBounds, viewportBounds, nextBounds, imageBounds] = await Promise.all([previous.boundingBox(), viewport.boundingBox(), next.boundingBox(), current().boundingBox()]);
    assert.ok(previousBounds && viewportBounds && nextBounds && imageBounds);
    assert.ok(previousBounds.width >= 44 && previousBounds.height >= 44 && previousBounds.x + previousBounds.width <= imageBounds.x, "previous arrow is outside the central image");
    assert.ok(nextBounds.width >= 44 && nextBounds.height >= 44 && nextBounds.x >= imageBounds.x + imageBounds.width, "next arrow is outside the central image");
    assert.ok(imageBounds.width >= 1180 && imageBounds.width <= 1182, "the central image is 1181px at 1440px");
    assert.equal(await page.locator("[data-gallery-slide][data-gallery-position='previous'], [data-gallery-slide][data-gallery-position='next']").evaluateAll((slides) => slides.every((slide) => {
      const bounds = slide.getBoundingClientRect();
      const viewportBounds = slide.parentElement.getBoundingClientRect();
      return getComputedStyle(slide).opacity === "0.24" && bounds.right > viewportBounds.left && bounds.left < viewportBounds.right;
    })), true, "both neighboring images remain visibly peeking into the clipped viewport");

    await previous.click();
    assert.equal(await current().getAttribute("src"), "assets/demo3.png");
    assert.equal(await page.getByRole("button", { name: "画面 3を表示" }).getAttribute("aria-current"), "true");
    for (const [index, source] of ["assets/demo1.png", "assets/demo2.png", "assets/demo3.png"].entries()) {
      await page.getByRole("button", { name: `画面 ${index + 1}を表示` }).click();
      assert.equal(await current().getAttribute("src"), source);
      assert.equal(await page.getByRole("button", { name: `画面 ${index + 1}を表示` }).getAttribute("aria-current"), "true");
    }
    await page.getByRole("button", { name: "画面 1を表示" }).click();

    for (const expected of ["assets/demo2.png", "assets/demo3.png", "assets/demo1.png"]) {
      await page.clock.fastForward(6000);
      assert.equal(await current().getAttribute("src"), expected);
    }
    assert.deepEqual(await page.locator("[data-gallery-slide]").evaluateAll((slides) => slides.map((slide) => ({ position: slide.dataset.galleryPosition, src: slide.querySelector("img").getAttribute("src") }))), [
      { position: "active", src: "assets/demo1.png" },
      { position: "next", src: "assets/demo2.png" },
      { position: "previous", src: "assets/demo3.png" },
    ]);
    await gallery.hover();
    await page.clock.fastForward(6000);
    assert.equal(await current().getAttribute("src"), "assets/demo2.png", "hover does not pause autoplay");
    await next.click();
    assert.equal(await current().getAttribute("src"), "assets/demo3.png");
    await page.clock.fastForward(6000);
    assert.equal(await current().getAttribute("src"), "assets/demo1.png", "pointer navigation schedules the next cycle");

    await previous.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]').evaluate((element) => document.activeElement === element), true, "Tab skips both neighboring images");
    await page.keyboard.press("Shift+Tab");
    await previous.press("ArrowRight");
    const focusSource = await current().getAttribute("src");
    await page.clock.fastForward(6000);
    assert.equal(await current().getAttribute("src"), focusSource, "keyboard focus suspends autoplay");
    await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).focus();
    await page.clock.fastForward(6000);
    assert.notEqual(await current().getAttribute("src"), focusSource, "leaving keyboard focus restores autoplay");

    const modal = page.locator("[data-gallery-modal]");
    const opener = page.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]');
    const modalSource = await current().getAttribute("src");
    await opener.click();
    assert.equal(await modal.getAttribute("open"), "");
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, true);
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, false);
    await page.clock.fastForward(6000);
    assert.equal(await current().getAttribute("src"), modalSource, "visibility changes do not restart autoplay behind a modal");
    await page.getByRole("button", { name: "拡大表示を閉じる" }).click();
    await modal.waitFor({ state: "hidden" });

    await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).focus();
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, true);
    const visibleSource = await current().getAttribute("src");
    await page.clock.fastForward(6000);
    assert.equal(await current().getAttribute("src"), visibleSource, "hidden pages do not advance");
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, false);
    await page.clock.fastForward(6000);
    assert.notEqual(await current().getAttribute("src"), visibleSource, "visible pages schedule a fresh cycle");
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the preview modal opens repeatedly and restores its opener without changing the page", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", localOnly(site));
    const page = await context.newPage();
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete));
    const opener = page.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]');
    const dialog = page.locator("[data-gallery-modal]");
    const close = page.getByRole("button", { name: "拡大表示を閉じる" });
    const url = page.url();
    const source = await activeImage(page).getAttribute("src");
    const alt = await activeImage(page).getAttribute("alt");

    await opener.click();
    assert.equal(await dialog.getAttribute("open"), "");
    assert.equal(await page.locator("[data-gallery-modal-image]").getAttribute("src"), new URL(source, `${site.url}/`).href);
    assert.equal(await page.locator("[data-gallery-modal-image]").getAttribute("alt"), alt);
    assert.equal(page.url(), url, "opening the preview does not navigate");
    assert.equal(await close.evaluate((element) => document.activeElement === element), true);
    await page.locator("[data-gallery-modal-image]").click();
    assert.equal(await dialog.getAttribute("open"), "", "clicking the image does not close the modal");
    await close.click();
    assert.equal(await opener.evaluate((element) => document.activeElement === element), true);
    await page.waitForFunction((initialSource) => document.querySelector('[data-gallery-slide][data-gallery-position="active"] img').getAttribute("src") !== initialSource, source);

    await opener.click();
    await page.mouse.click(2, 2);
    assert.equal(await dialog.getAttribute("open"), null, "clicking the backdrop closes the modal");
    assert.equal(await opener.evaluate((element) => document.activeElement === element), true);

    await opener.click();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.getAttribute("open"), null, "Escape closes the modal");
    assert.equal(await opener.evaluate((element) => document.activeElement === element), true);
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the enabled carousel keeps its visible geometry at every supported viewport", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 768, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 960 }]) {
      const context = await browser.newContext({ viewport });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete));
      const [previous, viewportBounds, next, image, dots] = await Promise.all([
        page.getByRole("button", { name: "前の画面" }).boundingBox(),
        page.locator("[data-gallery-viewport]").boundingBox(),
        page.getByRole("button", { name: "次の画面" }).boundingBox(),
        activeImage(page).boundingBox(),
        page.locator("[data-gallery-dot]").evaluateAll((buttons) => buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
        })),
      ]);
      assert.ok(previous && viewportBounds && next && image);
      const expectedWidth = viewport.width <= 700 ? viewport.width - 48 : Math.min(viewport.width * .82, 1480);
      assert.ok(Math.abs(image.width - expectedWidth) <= 1, `central image has the required width at ${viewport.width}px`);
      assert.ok(Math.abs(image.width / image.height - 1920 / 959) < .002, `central image keeps the source ratio at ${viewport.width}px`);
      if (viewport.width <= 900) {
        assert.ok(previous.width >= 44 && previous.height >= 44 && previous.y >= image.y + image.height, `previous arrow is below the image at ${viewport.width}px`);
        assert.ok(next.width >= 44 && next.height >= 44 && next.y >= image.y + image.height, `next arrow is below the image at ${viewport.width}px`);
        assert.ok(dots.every((dot) => dot.width >= 24 && dot.height >= 44), `mobile dots retain their control-row targets at ${viewport.width}px`);
      } else {
        assert.ok(previous.width >= 44 && previous.height >= 44 && previous.x + previous.width <= image.x, `previous arrow stays outside the image at ${viewport.width}px`);
        assert.ok(next.width >= 44 && next.height >= 44 && next.x >= image.x + image.width, `next arrow stays outside the image at ${viewport.width}px`);
        assert.ok(dots.every((dot) => dot.width >= 44 && dot.height >= 44), `desktop dots retain 44px targets at ${viewport.width}px`);
      }
      for (const arrow of [previous, next]) {
        for (const dot of dots) {
          assert.equal(arrow.x < dot.x + dot.width && arrow.x + arrow.width > dot.x && arrow.y < dot.y + dot.height && arrow.y + arrow.height > dot.y, false, `arrows and dots do not overlap at ${viewport.width}px`);
        }
      }
      assert.equal(await page.locator("[data-gallery-slide][data-gallery-position='previous'], [data-gallery-slide][data-gallery-position='next']").evaluateAll((slides) => slides.every((slide) => {
        const bounds = slide.getBoundingClientRect();
        const viewportBounds = slide.parentElement.getBoundingClientRect();
        return Number(getComputedStyle(slide).opacity) === .24 && bounds.right > viewportBounds.left && bounds.left < viewportBounds.right;
      })), true, `both neighboring images peek into view at ${viewport.width}px`);
      assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `no horizontal overflow at ${viewport.width}px`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("keyboard focus remains suspended after closing a modal preview", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", localOnly(site));
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete));
    const opener = page.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]');
    const dialog = page.locator("[data-gallery-modal]");
    const source = await activeImage(page).getAttribute("src");
    await opener.focus();
    await opener.press("Enter");
    assert.equal(await dialog.getAttribute("open"), "");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await opener.evaluate((element) => document.activeElement === element && element.matches(":focus-visible")), true);
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), source, "keyboard-opened modal keeps autoplay suspended after Escape");
    await context.close();
    const pointerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointerContext.route("**/*", localOnly(site));
    const pointerPage = await pointerContext.newPage();
    await pointerPage.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    await pointerPage.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await pointerPage.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete));
    const pointerOpener = pointerPage.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]');
    const pointerDialog = pointerPage.locator("[data-gallery-modal]");
    const pointerSource = await activeImage(pointerPage).getAttribute("src");
    await pointerOpener.click();
    await pointerPage.keyboard.press("Escape");
    await pointerDialog.waitFor({ state: "hidden" });
    assert.equal(await pointerOpener.evaluate((element) => document.activeElement === element && element.matches(":focus-visible")), true);
    await pointerPage.clock.fastForward(6000);
    assert.equal(await activeImage(pointerPage).getAttribute("src"), pointerSource, "pointer-opened modal also respects the restored visible focus");
    await pointerContext.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("reduced motion keeps autoplay off while retaining manual navigation and Google tag initialization", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    let loaderRequests = 0;
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.href === googleTagUrl) {
        loaderRequests += 1;
        return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
      }
      return url.origin === site.url ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    const loaderResponse = page.waitForResponse((response) => response.url() === googleTagUrl);
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete && image.naturalWidth === 1920));
    assert.equal((await loaderResponse).status(), 200);
    assert.equal(loaderRequests, 1);
    assert.equal(await page.locator("[data-gallery-pause]").count(), 0);
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo1.png");
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo1.png");
    await page.getByRole("button", { name: "次の画面" }).click();
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo2.png", "manual navigation remains available");
    assert.deepEqual(await page.evaluate((tagId) => ({
      initialized: window.dataLayer.filter(([command, value]) => command === "js" && value instanceof Date).length,
      configured: window.dataLayer.filter(([command, value]) => command === "config" && value === tagId).length,
    }), googleTagId), { initialized: 1, configured: 1 });
    assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});
