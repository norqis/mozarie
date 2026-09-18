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

test("the editorial landing page works without JavaScript and fits every supported viewport", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      const response = await page.goto(`${site.url}/`, { waitUntil: "load" });
      assert.equal(response.status(), 200);
      assert.equal(await page.title(), "Mozarie | Windowsで画像のモザイク範囲を検出・編集・保存");
      assert.equal(await page.locator("h1").innerText(), "Mozarie");
      assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Mozarieは、PNG・JPEG・WebP画像のモザイク範囲をWindows上でローカル検出、確認、編集、保存できるアプリです。");
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), canonicalUrl);
      assert.equal(await page.locator('meta[name="google-site-verification"]').getAttribute("content"), "UrWwBw6iDkiGPFlWk3S4jrSsP7YfkvctuNVveYOJd_o");
      assert.equal(await page.getByText("Mozarieは、画像のモザイク範囲をローカルで検出し、確認・編集・保存できるWindowsアプリです。", { exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).count(), 1);
      assert.equal(await page.locator('footer a[lang="en"][href="https://github.com/norqis/mozarie/blob/main/README.en.md"]').count(), 1);
      assert.equal(await page.locator("[data-gallery-controls]").isHidden(), true);
      assert.equal(await page.locator("[data-gallery-caption], [data-gallery-count]").count(), 0);
      assert.equal(await page.getByText("前の画面", { exact: true }).count(), 0);
      assert.equal(await page.locator("[data-gallery-slide]:not([hidden]) img").getAttribute("src"), "assets/demo1.png");
      assert.deepEqual(await page.locator("[data-gallery-slide]:not([hidden]) img").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })), { width: 1920, height: 959, complete: true });
      const download = await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).boundingBox();
      assert.ok(download && download.y >= 0 && download.y + download.height <= viewport.height, "download remains in the initial viewport");
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: false }).getAttribute("href"), "https://github.com/norqis/mozarie/releases/latest");
      await page.keyboard.press("Tab");
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
    for (const image of ["demo1.png", "demo2.png", "demo3.png"]) assert.equal((await get(`${site.url}/assets/${image}`)).status, 200);
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

test("the gallery continuously rotates, preserves explicit pause, and respects keyboard and tab visibility", { timeout: 30_000 }, async () => {
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
    const image = page.locator("[data-gallery-slide]:not([hidden]) img");
    const gallery = page.locator("[data-gallery]");
    const pause = page.getByRole("button", { name: "自動再生を一時停止" });
    const next = page.getByRole("button", { name: "次の画面" });
    const previous = page.getByRole("button", { name: "前の画面" });
    assert.equal(await page.locator("[data-gallery-controls] button").evaluateAll((buttons) => buttons.every((button) => button.textContent.trim() === "")), true);
    assert.deepEqual(await page.locator("[data-gallery-slide] a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))), ["assets/demo1.png", "assets/demo2.png", "assets/demo3.png"]);
    assert.deepEqual(await page.locator("[data-gallery-slide] img").evaluateAll((images) => images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }))), Array(3).fill({ width: 1920, height: 959, complete: true }));
    const imageBounds = await image.boundingBox();
    for (const control of [previous, next]) {
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
      assert.ok(imageBounds && bounds.x >= imageBounds.x && bounds.x + bounds.width <= imageBounds.x + imageBounds.width);
      assert.ok(imageBounds && Math.abs(bounds.y + bounds.height / 2 - (imageBounds.y + imageBounds.height / 2)) <= 1);
    }
    const dotBounds = await page.getByRole("button", { name: "画面 1を表示" }).boundingBox();
    assert.ok(imageBounds && dotBounds && dotBounds.y - (imageBounds.y + imageBounds.height) >= 14 && dotBounds.y - (imageBounds.y + imageBounds.height) <= 18);
    for (const control of [page.getByRole("button", { name: "画面 1を表示" }), page.getByRole("button", { name: "画面 2を表示" }), page.getByRole("button", { name: "画面 3を表示" }), pause]) {
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.width >= 24 && bounds.height >= 24);
    }
    assert.equal(await page.locator("[data-gallery-dot][aria-current='true']").count(), 1);

    for (const expected of ["assets/demo2.png", "assets/demo3.png", "assets/demo1.png"]) {
      await page.clock.fastForward(6000);
      assert.equal(await image.getAttribute("src"), expected);
    }
    await gallery.hover();
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "hover does not pause autoplay");
    await next.click();
    assert.equal(await image.getAttribute("src"), "assets/demo3.png");
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo1.png", "pointer focus and manual navigation reset instead of pausing autoplay");
    await page.getByRole("button", { name: "画面 1を表示" }).click();
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "dot navigation resets instead of pausing autoplay");
    assert.equal(await page.getByRole("button", { name: "画面 2を表示" }).getAttribute("aria-current"), "true");

    const download = page.getByRole("link", { name: "最新版をダウンロード", exact: false });
    await download.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("[data-gallery-prev]").evaluate((element) => document.activeElement === element && element.matches(":focus-visible")), true);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "keyboard focus temporarily suspends autoplay");
    await page.keyboard.press("Tab");
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "moving within the gallery retains keyboard suspension");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await download.evaluate((element) => document.activeElement === element), true);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo3.png", "leaving keyboard focus restores autoplay");

    await pause.click();
    assert.equal(await page.getByRole("button", { name: "自動再生を再開" }).count(), 1);
    await page.getByRole("button", { name: "画面 3を表示" }).click();
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo3.png", "manual navigation retains explicit pause");

    await download.focus();
    for (let index = 0; index < 2; index += 1) await page.keyboard.press("Tab");
    assert.equal(await page.locator("[data-gallery-prev]").evaluate((element) => document.activeElement === element && element.matches(":focus-visible")), true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("[data-gallery-dot='0']").evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await download.evaluate((element) => document.activeElement === element), true);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo3.png", "leaving keyboard focus retains explicit pause");
    assert.equal(await page.getByRole("button", { name: "自動再生を再開" }).count(), 1);
    await page.getByRole("button", { name: "自動再生を再開" }).click();
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo1.png", "explicit play restarts from the next six-second boundary");

    await pause.click();
    await download.focus();
    for (let index = 0; index < 7; index += 1) {
      await page.keyboard.press("Tab");
      if (await page.locator("[data-gallery-pause]").evaluate((element) => document.activeElement === element)) break;
    }
    assert.equal(await page.locator("[data-gallery-pause]").evaluate((element) => document.activeElement === element && element.matches(":focus-visible")), true);
    await page.keyboard.press("Space");
    assert.equal(await page.getByRole("button", { name: "自動再生を一時停止" }).count(), 1);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "keyboard play resumes while the button stays focused");

    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, true);
    assert.equal(await page.evaluate(() => document.hidden), true);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png", "hidden pages do not advance");
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, false);
    assert.equal(await page.evaluate(() => document.hidden), false);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo3.png", "visible pages schedule a fresh cycle");
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("reduced motion starts paused and Google tag initialization keeps tracking traffic blocked", { timeout: 30_000 }, async () => {
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
    const image = page.locator("[data-gallery-slide]:not([hidden]) img");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete && image.naturalWidth === 1920));
    assert.equal((await loaderResponse).status(), 200);
    assert.equal(loaderRequests, 1);
    assert.equal(await page.getByRole("button", { name: "自動再生を再開" }).isVisible(), true);
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo1.png");
    await page.getByRole("button", { name: "自動再生を再開" }).click();
    await page.clock.fastForward(6000);
    assert.equal(await image.getAttribute("src"), "assets/demo2.png");
    assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    const imageBounds = await image.boundingBox();
    for (const control of [page.getByRole("button", { name: "前の画面" }), page.getByRole("button", { name: "次の画面" })]) {
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
      assert.ok(imageBounds && bounds.x >= imageBounds.x && bounds.x + bounds.width <= imageBounds.x + imageBounds.width);
      assert.ok(imageBounds && Math.abs(bounds.y + bounds.height / 2 - (imageBounds.y + imageBounds.height / 2)) <= 1);
    }
    const dotBounds = await page.getByRole("button", { name: "画面 2を表示" }).boundingBox();
    assert.ok(imageBounds && dotBounds && dotBounds.y - (imageBounds.y + imageBounds.height) >= 14 && dotBounds.y - (imageBounds.y + imageBounds.height) <= 18);
    assert.deepEqual(await page.evaluate((tagId) => ({
      initialized: window.dataLayer.filter(([command, value]) => command === "js" && value instanceof Date).length,
      configured: window.dataLayer.filter(([command, value]) => command === "config" && value === tagId).length,
    }), googleTagId), { initialized: 1, configured: 1 });
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});
