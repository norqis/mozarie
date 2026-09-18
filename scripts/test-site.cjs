"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const siteRoot = path.join(root, "site");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".xml": "application/xml; charset=utf-8",
};
const canonicalUrl = "https://norqis.github.io/mozarie/";
const googleTagId = "G-BLX3GDM1WQ";
const googleTagUrl = `https://www.googletagmanager.com/gtag/js?id=${googleTagId}`;

function startSite() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(siteRoot, requested);
    if (!file.startsWith(`${siteRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" }).end(body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
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

test("the landing page works without JavaScript and fits desktop and mobile viewports", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport });
      const page = await context.newPage();
      const response = await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
      assert.equal(response.status(), 200);
      assert.equal(await page.title(), "Mozarie | Windowsで画像のモザイク範囲を検出・編集・保存");
      assert.equal(await page.locator("h1").innerText(), "Mozarie");
      assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Mozarieは、PNG・JPEG・WebP画像のモザイク範囲をWindows上でローカル検出、確認、編集、保存できるアプリです。");
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), canonicalUrl);
      assert.equal(await page.locator('a[href="https://github.com/norqis/mozarie/releases/latest"]').count(), 1);
      assert.equal(await page.locator('footer a[lang="en"][href="https://github.com/norqis/mozarie/blob/main/README.en.md"]').count(), 1);
      assert.equal(await page.getByText("Mozarieは、画像のモザイク範囲をローカルで検出し、確認・編集できるWindowsアプリです。", { exact: true }).isVisible(), true);
      assert.equal(await page.locator("[data-gallery-controls]").isHidden(), true);
      assert.equal(await page.locator("[data-gallery-caption], [data-gallery-count]").count(), 0);
      assert.equal(await page.getByText("前の画面", { exact: true }).count(), 0);
      assert.equal(await page.locator("[data-gallery-slide]").count(), 3);
      assert.equal(await page.locator("[data-gallery-slide]:not([hidden]) img").getAttribute("src"), "assets/demo1.png");
      assert.deepEqual(await page.locator("[data-gallery-slide]:not([hidden]) img").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })), { width: 1920, height: 959, complete: true });
      const downloadBounds = await page.getByRole("link", { name: "最新版をダウンロード", exact: true }).boundingBox();
      assert.ok(downloadBounds && downloadBounds.y >= 0 && downloadBounds.y + downloadBounds.height <= viewport.height, "the download link is visible in the initial viewport");
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { tag: document.activeElement.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
      });
      assert.equal(focus.tag, "A");
      assert.notEqual(focus.outlineStyle, "none");
      assert.notEqual(focus.outlineWidth, "0px");
      assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `no horizontal overflow at ${viewport.width}px`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the stylesheet and sitemap are published as valid static assets", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    const stylesheet = await get(`${site.url}/styles.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers["content-type"], /^text\/css; charset=utf-8$/);
    const script = await get(`${site.url}/gallery.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /^application\/javascript; charset=utf-8$/);
    for (const image of ["demo1.png", "demo2.png", "demo3.png"]) {
      const asset = await get(`${site.url}/assets/${image}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers["content-type"], "image/png");
    }
    const sitemap = await get(`${site.url}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers["content-type"], /^application\/xml; charset=utf-8$/);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === site.url ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const parsed = await page.evaluate((xml) => {
      const document = new DOMParser().parseFromString(xml, "application/xml");
      return {
        error: document.querySelector("parsererror")?.textContent || "",
        urls: [...document.querySelectorAll("loc")].map((element) => element.textContent),
      };
    }, sitemap.text);
    assert.equal(parsed.error, "");
    assert.deepEqual(parsed.urls, [canonicalUrl]);
    const englishLink = page.locator('footer a[lang="en"]');
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await englishLink.hover();
    const contrast = await englishLink.evaluate((link) => {
      return { background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(link).color };
    });
    assert.notEqual(contrast.color, contrast.background, "the hovered English README link remains visible");
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the demo gallery uses quiet icon controls and handles rotation accessibly", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === site.url ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    const visibleImage = page.locator("[data-gallery-slide]:not([hidden]) img");
    const gallery = page.locator("[data-gallery]");
    const pause = page.getByRole("button", { name: "自動再生を一時停止" });
    assert.equal(await page.locator("[data-gallery-caption], [data-gallery-count]").count(), 0);
    assert.deepEqual(await visibleImage.evaluate((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth, height: image.naturalHeight })), { src: "assets/demo1.png", width: 1920, height: 959 });
    assert.deepEqual(await page.locator("[data-gallery-slide] img").evaluateAll((images) => images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }))), Array(3).fill({ width: 1920, height: 959, complete: true }));
    assert.deepEqual(await page.locator("[data-gallery-slide] a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))), ["assets/demo1.png", "assets/demo2.png", "assets/demo3.png"]);
    assert.equal(await page.locator("[data-gallery-controls] button").evaluateAll((buttons) => buttons.every((button) => button.textContent.trim() === "")), true);

    const imageBounds = await visibleImage.boundingBox();
    const arrows = [page.getByRole("button", { name: "前の画面" }), page.getByRole("button", { name: "次の画面" })];
    for (const button of arrows) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
      assert.ok(imageBounds && bounds.x >= imageBounds.x && bounds.x + bounds.width <= imageBounds.x + imageBounds.width);
      assert.ok(imageBounds && Math.abs(bounds.y + bounds.height / 2 - (imageBounds.y + imageBounds.height / 2)) <= 1);
    }
    for (const button of [page.getByRole("button", { name: "画面 1を表示" }), page.getByRole("button", { name: "画面 2を表示" }), page.getByRole("button", { name: "画面 3を表示" }), pause]) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width >= 24 && bounds.height >= 24);
    }
    const dotBounds = await page.getByRole("button", { name: "画面 1を表示" }).boundingBox();
    assert.ok(imageBounds && dotBounds && dotBounds.y - (imageBounds.y + imageBounds.height) >= 14 && dotBounds.y - (imageBounds.y + imageBounds.height) <= 18);
    assert.equal(await gallery.locator("[data-gallery-dot][aria-current='true']").count(), 1);

    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo2.png");
    await page.getByRole("button", { name: "前の画面" }).click();
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo1.png");
    await page.getByRole("button", { name: "次の画面" }).click();
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo2.png");
    await page.getByRole("button", { name: "画面 3を表示" }).click();
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo3.png");
    assert.equal(await page.getByRole("button", { name: "画面 3を表示" }).getAttribute("aria-current"), "true");

    await page.getByRole("button", { name: "自動再生を再開" }).click();
    await page.locator(".hero").hover();
    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo1.png");
    await page.getByRole("button", { name: "自動再生を一時停止" }).click();
    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo1.png");
    await page.getByRole("button", { name: "自動再生を再開" }).click();
    await page.locator("[data-gallery]").hover();
    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo1.png");
    await page.locator(".hero").hover();
    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo2.png");
    await page.getByRole("button", { name: "次の画面" }).focus();
    await page.locator('nav a[href="https://github.com/norqis/mozarie"]').focus();
    await page.clock.fastForward(6000);
    assert.equal(await visibleImage.getAttribute("src"), "assets/demo2.png");
    await context.close();

    const reducedContext = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    await reducedContext.route("**/*", (route) => new URL(route.request().url()).origin === site.url ? route.continue() : route.abort());
    const reducedPage = await reducedContext.newPage();
    await reducedPage.clock.install({ time: new Date("2026-09-18T00:00:00Z") });
    await reducedPage.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    assert.equal(await reducedPage.getByRole("button", { name: "自動再生を再開" }).isVisible(), true);
    await reducedPage.clock.fastForward(6000);
    assert.equal(await reducedPage.locator("[data-gallery-slide]:not([hidden]) img").getAttribute("src"), "assets/demo1.png");
    assert.equal(await reducedPage.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    const reducedImageBounds = await reducedPage.locator("[data-gallery-slide]:not([hidden]) img").boundingBox();
    for (const button of [reducedPage.getByRole("button", { name: "前の画面" }), reducedPage.getByRole("button", { name: "次の画面" })]) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
      assert.ok(reducedImageBounds && bounds.x >= reducedImageBounds.x && bounds.x + bounds.width <= reducedImageBounds.x + reducedImageBounds.width);
      assert.ok(reducedImageBounds && Math.abs(bounds.y + bounds.height / 2 - (reducedImageBounds.y + reducedImageBounds.height / 2)) <= 1);
    }
    const reducedDotBounds = await reducedPage.getByRole("button", { name: "画面 1を表示" }).boundingBox();
    assert.ok(reducedImageBounds && reducedDotBounds && reducedDotBounds.y - (reducedImageBounds.y + reducedImageBounds.height) >= 14 && reducedDotBounds.y - (reducedImageBounds.y + reducedImageBounds.height) <= 18);
    await reducedContext.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the landing page initializes the Google tag without external tracking traffic", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const loaderResponse = page.waitForResponse((response) => response.url() === googleTagUrl);
    const response = await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    assert.equal((await loaderResponse).status(), 200);
    assert.equal(loaderRequests, 1);
    const loader = page.locator(`script[src="${googleTagUrl}"]`);
    assert.equal(await loader.count(), 1);
    assert.equal(await loader.evaluate((element) => element.async), true);
    assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: true }).isVisible(), true);
    const dataLayer = await page.evaluate((tagId) => {
      const entries = window.dataLayer;
      return {
        entries: entries.length,
        initialized: entries.filter(([command, value]) => command === "js" && value instanceof Date).length,
        configured: entries.filter(([command, value]) => command === "config" && value === tagId).length,
      };
    }, googleTagId);
    assert.deepEqual(dataLayer, { entries: 2, initialized: 1, configured: 1 });
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});
