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
  ".xml": "application/xml; charset=utf-8",
};
const canonicalUrl = "https://norqis.github.io/mozarie/";

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
      assert.equal(await page.locator('[lang="en"] a[href="https://github.com/norqis/mozarie/blob/main/README.en.md"]').count(), 1);
      assert.equal(await page.getByText("Mozarieは、Windowsで画像を読み込み、モザイク範囲をローカルで検出・確認・編集・保存するアプリです。", { exact: true }).isVisible(), true);
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
    const sitemap = await get(`${site.url}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers["content-type"], /^application\/xml; charset=utf-8$/);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
    const englishLink = page.locator('[lang="en"] a');
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await englishLink.hover();
    const contrast = await englishLink.evaluate((link) => {
      const section = link.closest(".english");
      return { background: getComputedStyle(section).backgroundColor, color: getComputedStyle(link).color };
    });
    assert.notEqual(contrast.color, contrast.background, "the hovered English README link remains visible");
    await context.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});
