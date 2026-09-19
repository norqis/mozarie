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
const viewports = [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 700, height: 800 }, { width: 701, height: 800 }, { width: 720, height: 800 }, { width: 768, height: 800 }, { width: 900, height: 900 }, { width: 1440, height: 900 }, { width: 1920, height: 960 }];
const contentTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".xml": "application/xml; charset=utf-8" };

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

test("the rebuilt product page is complete without JavaScript and has no horizontal overflow", { timeout: 60_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    let boundaryTypography;
    for (const viewport of viewports) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      assert.equal((await page.goto(`${site.url}/`, { waitUntil: "load" })).status(), 200);
      assert.equal(await page.title(), "Mozarie | 自動検出・ブラシ編集・一括保存に対応したモザイク加工ソフト");
      assert.equal(await page.locator("h1").textContent(), "検出から保存まで、ひとつの画面で。");
      assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Mozarieは、モザイク自動検出、ブラシツール、複数画像の一括保存、プロジェクトごとの履歴保持に対応したWindowsアプリです。");
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), canonicalUrl);
      assert.equal(await page.locator('meta[name="google-site-verification"]').getAttribute("content"), "UrWwBw6iDkiGPFlWk3S4jrSsP7YfkvctuNVveYOJd_o");
      assert.equal(await page.locator('.site-header a[href="https://github.com/norqis/mozarie"]').getAttribute("href"), "https://github.com/norqis/mozarie");
      assert.deepEqual(await page.locator(".story").evaluateAll((stories) => stories.map((story) => ({
        name: story.querySelector(".feature-name")?.textContent.trim(),
        heading: story.querySelector("h2")?.textContent.trim(),
        copy: story.querySelector("p:last-of-type")?.textContent.trim(),
        image: story.querySelector("img")?.getAttribute("src") || null,
      }))), [
        { name: "モザイク自動検出", heading: "モザイク候補を、自動検出。", copy: "現在の画像またはプロジェクト内の全画像から、モザイク候補を自動検出。候補ごとに適用範囲を確認できます。", image: "assets/demo3.png" },
        { name: "ブラシツール", heading: "ブラシで、直接描く。", copy: "モザイクをかける範囲も、除外する範囲も、画像の上でそのまま編集できます。", image: "assets/demo1.png" },
        { name: "複数画像をまとめて保存", heading: "複数画像を、まとめて保存。", copy: "プロジェクト内の画像をまとめて保存。コピー保存と元画像への上書きを選べます。", image: "assets/demo1.png" },
        { name: "プロジェクトごとの履歴保持", heading: "作業は、プロジェクトごとに残る。", copy: "候補、手描き範囲、確認状態、非表示状態、元に戻す・やり直すの履歴をプロジェクトごとに保持します。", image: null },
      ]);
      assert.deepEqual(await page.locator(".story h2").evaluateAll((headings) => headings.map((heading) => [...heading.querySelectorAll("span")].map((span) => span.textContent))), [
        ["モザイク候補を、", "自動検出。"],
        ["ブラシで、", "直接描く。"],
        ["複数画像を、", "まとめて保存。"],
        ["作業は、", "プロジェクト", "ごとに残る。"],
      ]);
      assert.equal(await page.locator("h1 span, .story h2 span, .final-cta h2 span").evaluateAll((chunks) => chunks.every((chunk) => {
        const style = getComputedStyle(chunk);
        const lineHeight = Number.parseFloat(style.lineHeight);
        return style.whiteSpace === "nowrap" && chunk.getBoundingClientRect().height <= lineHeight + 1;
      })), true, `display headings only wrap at semantic boundaries at ${viewport.width}px`);
      const typography = await page.evaluate(() => ({
        hero: Number.parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
        feature: Number.parseFloat(getComputedStyle(document.querySelector(".story h2")).fontSize),
      }));
      if (viewport.width === 390) {
        assert.ok(typography.hero <= 35 && typography.feature <= 33, `mobile display type stays compact (${typography.hero}/${typography.feature})`);
      }
      if (viewport.width >= 1440) {
        assert.ok(typography.hero <= 76 && typography.feature <= 60, `desktop display type stays subordinate to product imagery (${typography.hero}/${typography.feature})`);
      }
      if (viewport.width === 700) boundaryTypography = typography;
      if (viewport.width === 701) {
        assert.ok(boundaryTypography, "700px typography was measured before 701px");
        assert.ok(Math.abs(typography.hero - boundaryTypography.hero) <= 1, `hero type remains continuous across 700/701px (${boundaryTypography.hero}/${typography.hero})`);
        assert.ok(Math.abs(typography.feature - boundaryTypography.feature) <= 1, `feature type remains continuous across 700/701px (${boundaryTypography.feature}/${typography.feature})`);
      }
      assert.equal(await page.locator(".feature-index, .sequence, .retained-items").count(), 0);
      assert.equal(await page.locator(".resume-flow").count(), 0);
      for (const forbidden of ["Undo", "Redo", "範囲を調整", "Mozarieを閉じる", "プロジェクトを再開", "保存した範囲と履歴から続ける"]) assert.equal(await page.locator("body").innerText().then((text) => text.includes(forbidden)), false, `${forbidden} is not product-page copy`);
      assert.equal(await page.getByRole("heading", { name: "画像の加工は、PC上で", exact: true }).count(), 0);
      assert.equal(await page.locator("body").innerText().then((text) => text.includes("画像の加工は、PC上で")), false);
      assert.equal(await page.locator("#install, #faq, .feature-list, .feature-lead").count(), 0);
      assert.equal(await page.locator("[data-gallery-slide]").count(), 2);
      assert.equal(await page.locator('[src="assets/demo2.png"]').count(), 0);
      assert.equal(await page.locator("[data-gallery-slide]:not([hidden]) img").getAttribute("src"), "assets/demo3.png");
      assert.equal(await page.locator("[data-gallery-open]").evaluateAll((buttons) => buttons.every((button) => button.disabled)), true);
      assert.equal(await page.locator("[data-gallery-controls]").evaluateAll((controls) => controls.every((control) => control.hidden && getComputedStyle(control).display === "none")), true);
      assert.equal(await page.locator("[data-gallery-caption]").innerText(), "自動検出した候補を、処理結果と適用範囲で確認できます。");
      assert.equal(await page.locator("#final-cta-title").textContent(), "Mozarieで、画像をまとめて仕上げる。");
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: true }).count(), 2);
      assert.equal(await page.getByRole("link", { name: "GitHubを見る", exact: true }).count(), 0);
      assert.equal(await page.getByRole("link", { name: "最新版をダウンロード", exact: true }).first().getAttribute("href"), "https://github.com/norqis/mozarie/releases/latest");
      assert.equal(await page.getByRole("link", { name: "English README", exact: true }).getAttribute("href"), "https://github.com/norqis/mozarie/blob/main/README.en.md");
      const heroDownload = page.getByRole("link", { name: "最新版をダウンロード", exact: true }).first();
      await heroDownload.focus();
      assert.equal(await heroDownload.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
      const heroDownloadBounds = await heroDownload.boundingBox();
      assert.ok(heroDownloadBounds && heroDownloadBounds.height >= 44 && heroDownloadBounds.y + heroDownloadBounds.height <= viewport.height, `initial download CTA is usable at ${viewport.width}px`);
      assert.equal(await heroDownload.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(114, 214, 173)");
      const image = await page.locator("[data-gallery-slide]:not([hidden]) img").boundingBox();
      const expectedWidth = viewport.width <= 700 ? viewport.width - 40 : Math.min(viewport.width * .88, 1520);
      assert.ok(image && Math.abs(image.width - expectedWidth) <= 1, `central image width at ${viewport.width}px`);
      assert.ok(image && Math.abs(image.width / image.height - 1920 / 959) < .002, `central image ratio at ${viewport.width}px`);
      if (viewport.width <= 390) assert.ok(image && image.x >= 20 && viewport.width - image.x - image.width >= 20, `mobile margins at ${viewport.width}px`);
      assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `no horizontal overflow at ${viewport.width}px`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("the published assets preserve the source logo and sitemap", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    const styles = await fs.readFile(path.join(siteRoot, "styles.css"), "utf8");
    assert.match(styles, /--ink: #171b19;[\s\S]*--paper: #f4f1e9;[\s\S]*--night: #111815;[\s\S]*--mint: #72d6ad;/);
    assert.match(styles, /\.primary-action \{ background: var\(--mint\); color: var\(--night\); \}/);
    assert.match(styles, /\.story-history \{ background: var\(--mint-pale\); \}/);
    assert.equal(styles.includes(".feature-index"), false);
    assert.equal(styles.includes(".retained-items"), false);
    assert.equal(styles.includes("gradient"), false);
    for (const [file, type] of [["styles.css", /^text\/css/], ["gallery.js", /^application\/javascript/], ["sitemap.xml", /^application\/xml/]]) {
      const asset = await get(`${site.url}/${file}`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers["content-type"], type);
    }
    for (const image of ["demo1.png", "demo3.png", "mozarie-logo.png"]) assert.equal((await get(`${site.url}/assets/${image}`)).status, 200);
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

test("the two-screen carousel rotates every six seconds and stops for focus, modal, visibility, and reduced motion", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", localOnly(site));
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-19T00:00:00Z") });
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete && image.naturalWidth === 1920));
    const gallery = page.locator("[data-gallery]");
    const previous = page.getByRole("button", { name: "前の画面" });
    const next = page.getByRole("button", { name: "次の画面" });
    const modal = page.locator("[data-gallery-modal]");
    assert.equal(await page.locator("[data-gallery-pause]").count(), 0);
    assert.equal(await page.locator("[data-gallery-slide]").count(), 2);
    assert.equal(await page.locator('[src="assets/demo2.png"]').count(), 0);
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo3.png");
    assert.equal(await page.locator("[data-gallery-caption]").innerText(), "自動検出した候補を、処理結果と適用範囲で確認できます。");
    const [previousBounds, nextBounds, imageBounds] = await Promise.all([previous.boundingBox(), next.boundingBox(), activeImage(page).boundingBox()]);
    assert.ok(previousBounds && nextBounds && imageBounds);
    assert.ok(previousBounds.x + previousBounds.width <= imageBounds.x && nextBounds.x >= imageBounds.x + imageBounds.width, "desktop arrows are outside the image");
    assert.equal(await page.locator("[data-gallery-peek-previous], [data-gallery-peek-next]").evaluateAll((peeks) => peeks.every((peek) => {
      const bounds = peek.getBoundingClientRect();
      const viewport = peek.parentElement.getBoundingClientRect();
      return Number(getComputedStyle(peek).opacity) === .16 && bounds.right > viewport.left && bounds.left < viewport.right;
    })), true, "both neighboring previews peek into the viewport");

    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo1.png");
    assert.equal(await page.locator("[data-gallery-caption]").innerText(), "画像一覧、ブラシ、自動検出、一括保存を同じ画面から操作できます。");
    await previous.click();
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo3.png");
    await page.getByRole("button", { name: "画面 2を表示" }).click();
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo1.png");
    assert.equal(await page.getByRole("button", { name: "画面 2を表示" }).getAttribute("aria-current"), "true");
    await page.getByRole("button", { name: "画面 1を表示" }).click();
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo3.png");
    await next.click();
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo1.png");
    await gallery.hover();
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), "assets/demo3.png", "hover and manual navigation keep autoplay active");

    await next.focus();
    await next.press("ArrowRight");
    const focusedSource = await activeImage(page).getAttribute("src");
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), focusedSource, "keyboard focus suspends autoplay");
    await page.getByRole("link", { name: "最新版をダウンロード", exact: true }).first().focus();
    await page.clock.fastForward(6000);
    assert.notEqual(await activeImage(page).getAttribute("src"), focusedSource, "leaving keyboard focus resumes autoplay");

    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, true);
    const hiddenSource = await activeImage(page).getAttribute("src");
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), hiddenSource, "hidden pages do not rotate");
    await page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, false);
    await page.clock.fastForward(6000);
    assert.notEqual(await activeImage(page).getAttribute("src"), hiddenSource, "visible pages resume rotation");

    const opener = page.locator('[data-gallery-slide][data-gallery-position="active"] [data-gallery-open]');
    const source = await activeImage(page).getAttribute("src");
    await opener.click();
    assert.equal(await modal.getAttribute("open"), "");
    assert.equal(await page.locator("[data-gallery-modal-image]").getAttribute("src"), new URL(source, `${site.url}/`).href);
    assert.equal(await page.locator("[data-gallery-modal-image]").getAttribute("alt"), await activeImage(page).getAttribute("alt"));
    assert.equal(await page.getByRole("button", { name: "拡大表示を閉じる" }).evaluate((element) => document.activeElement === element), true);
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), source, "modal suspends autoplay");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), source, "visibility changes do not restart autoplay behind a modal");
    await page.locator("[data-gallery-modal-image]").click();
    assert.equal(await modal.getAttribute("open"), "", "image click does not close the modal");
    await page.keyboard.press("Escape");
    assert.equal(await modal.getAttribute("open"), null);
    assert.equal(await opener.evaluate((element) => document.activeElement === element), true, "modal restores opener focus");

    await opener.click();
    await page.mouse.click(2, 2);
    assert.equal(await modal.getAttribute("open"), null, "backdrop click closes the modal");
    assert.equal(await opener.evaluate((element) => document.activeElement === element), true, "backdrop close restores opener focus");

    await opener.focus();
    await opener.press("Enter");
    await page.keyboard.press("Escape");
    const keyboardSource = await activeImage(page).getAttribute("src");
    await page.clock.fastForward(6000);
    assert.equal(await activeImage(page).getAttribute("src"), keyboardSource, "keyboard-opened modal keeps autoplay suspended after close");

    await context.close();

    const reducedContext = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    await reducedContext.route("**/*", localOnly(site));
    const reducedPage = await reducedContext.newPage();
    await reducedPage.clock.install({ time: new Date("2026-09-19T00:00:00Z") });
    await reducedPage.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    const reducedSource = await activeImage(reducedPage).getAttribute("src");
    await reducedPage.clock.fastForward(6000);
    assert.equal(await activeImage(reducedPage).getAttribute("src"), reducedSource, "reduced motion stops autoplay");
    await reducedPage.getByRole("button", { name: "次の画面" }).click();
    assert.notEqual(await activeImage(reducedPage).getAttribute("src"), reducedSource, "reduced motion keeps manual navigation");
    await reducedContext.close();
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("preview buttons and carousel geometry work across supported viewports", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => [...document.querySelectorAll("[data-gallery-slide] img")].every((image) => image.complete));
      if (viewport.width <= 700) await page.locator("html").evaluate((element) => { element.style.scrollbarGutter = "stable"; });
      const [previous, next, image] = await Promise.all([page.getByRole("button", { name: "前の画面" }).boundingBox(), page.getByRole("button", { name: "次の画面" }).boundingBox(), activeImage(page).boundingBox()]);
      assert.ok(previous && next && image);
      const layoutWidth = await page.locator("body").evaluate((element) => element.getBoundingClientRect().width);
      const expectedWidth = viewport.width <= 700 ? layoutWidth - 40 : Math.min(viewport.width * .88, 1520);
      assert.ok(Math.abs(image.width - expectedWidth) <= 1, `central image has the intended width at ${viewport.width}px (actual ${image.width}, expected ${expectedWidth}, layout ${layoutWidth})`);
      assert.ok(Math.abs(image.width / image.height - 1920 / 959) < .002, `central image keeps its source ratio at ${viewport.width}px`);
      if (viewport.width <= 900) {
        assert.ok(previous.width >= 44 && previous.height >= 44 && previous.y + 1 >= image.y + image.height, `previous arrow is below the image at ${viewport.width}px (arrow ${previous.y}, image end ${image.y + image.height})`);
        assert.ok(next.width >= 44 && next.height >= 44 && next.y + 1 >= image.y + image.height, `next arrow is below the image at ${viewport.width}px (arrow ${next.y}, image end ${image.y + image.height})`);
        const caption = await page.locator("[data-gallery-caption]").boundingBox();
        assert.ok(caption, `caption is visible at ${viewport.width}px`);
        for (const arrow of [previous, next]) assert.equal(arrow.x < caption.x + caption.width && arrow.x + arrow.width > caption.x && arrow.y < caption.y + caption.height && arrow.y + arrow.height > caption.y, false, `arrows do not overlap the caption at ${viewport.width}px`);
      } else {
        assert.ok(previous.width >= 44 && previous.height >= 44 && previous.x + previous.width <= image.x, `previous arrow is outside the image at ${viewport.width}px`);
        assert.ok(next.width >= 44 && next.height >= 44 && next.x >= image.x + image.width, `next arrow is outside the image at ${viewport.width}px`);
      }
      const dots = await page.locator("[data-gallery-dot]").evaluateAll((buttons) => buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
      }));
      assert.equal(dots.length, 2);
      assert.ok(dots.every((dot) => dot.height >= 44 && dot.width >= (viewport.width <= 900 ? 24 : 44)), `dots retain usable targets at ${viewport.width}px`);
      for (const arrow of [previous, next]) {
        for (const dot of dots) assert.equal(arrow.x < dot.x + dot.width && arrow.x + arrow.width > dot.x && arrow.y < dot.y + dot.height && arrow.y + arrow.height > dot.y, false, `arrows and dots do not overlap at ${viewport.width}px`);
      }
      assert.equal(await page.locator("[data-gallery-peek-previous], [data-gallery-peek-next]").evaluateAll((peeks) => peeks.every((peek) => {
        const bounds = peek.getBoundingClientRect();
        const galleryViewport = peek.parentElement.getBoundingClientRect();
        return Number(getComputedStyle(peek).opacity) === .16 && bounds.right > galleryViewport.left && bounds.left < galleryViewport.right;
      })), true, `both neighbor previews peek at ${viewport.width}px`);
      const opener = page.locator("[data-feature-open]").first();
      const dialog = page.locator("[data-gallery-modal]");
      const url = page.url();
      await opener.click();
      assert.equal(await dialog.getAttribute("open"), "");
      assert.equal(page.url(), url, "preview does not navigate");
      await page.getByRole("button", { name: "拡大表示を閉じる" }).click();
      assert.equal(await opener.evaluate((element) => document.activeElement === element), true);
      if (viewport.width === 1440) {
        const previews = page.locator("[data-feature-open]");
        await page.bringToFront();
        const reachWithTab = async (target) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            await page.keyboard.press("Tab");
            const state = await target.evaluate((element) => ({
              reached: document.activeElement === element && element.matches(":focus-visible"),
              outlineColor: getComputedStyle(element).outlineColor,
            }));
            if (state.reached) return state;
          }
          return null;
        };
        const darkFocus = await reachWithTab(previews.nth(1));
        assert.ok(darkFocus, "keyboard reaches the dark feature");
        assert.equal(darkFocus.outlineColor, "rgb(114, 214, 173)", "dark feature uses the light focus color");
        const firstLightFocus = await reachWithTab(previews.nth(0));
        assert.ok(firstLightFocus, "keyboard returns to the first light feature");
        assert.equal(firstLightFocus.outlineColor, "rgb(36, 92, 72)", "first light feature uses the dark focus color");
        const secondLightFocus = await reachWithTab(previews.nth(2));
        assert.ok(secondLightFocus, "keyboard reaches the second light feature");
        assert.equal(secondLightFocus.outlineColor, "rgb(36, 92, 72)", "second light feature uses the dark focus color");
      }
      if (viewport.width >= 1440) {
        assert.equal(await page.locator(".intro").evaluate((element) => element.scrollHeight <= Number.parseFloat(getComputedStyle(element).lineHeight) * 1.2), true, `hero introduction does not leave an orphan line at ${viewport.width}px`);
      }
      assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `no horizontal overflow at ${viewport.width}px`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("each feature preview opens its original image, keeps the gallery stopped, and restores focus", { timeout: 30_000 }, async () => {
  const site = await startSite();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route("**/*", localOnly(site));
      const page = await context.newPage();
      await page.clock.install({ time: new Date("2026-09-19T00:00:00Z") });
      await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => [...document.querySelectorAll("[data-feature-open] img")].every((image) => image.complete && image.naturalWidth === 1920));
      const dialog = page.locator("[data-gallery-modal]");
      const modalImage = page.locator("[data-gallery-modal-image]");
      const previews = page.locator("[data-feature-open]");
      const expectedSources = ["assets/demo3.png", "assets/demo1.png", "assets/demo1.png"];
      assert.equal(await previews.count(), 3);
      for (const [index, source] of expectedSources.entries()) {
        const opener = previews.nth(index);
        await opener.click();
        assert.equal(await dialog.getAttribute("open"), "");
        assert.equal(await modalImage.getAttribute("src"), new URL(source, `${site.url}/`).href);
        assert.equal(await modalImage.getAttribute("alt"), await opener.locator("img").getAttribute("alt"));
        const activeWhileOpen = await activeImage(page).getAttribute("src");
        await page.clock.fastForward(6000);
        assert.equal(await activeImage(page).getAttribute("src"), activeWhileOpen, `feature preview ${index + 1} stops the gallery`);
        const closeEvent = page.evaluate(() => new Promise((resolve) => document.querySelector("[data-gallery-modal]").addEventListener("close", resolve, { once: true })));
        await page.getByRole("button", { name: "拡大表示を閉じる" }).click();
        await dialog.waitFor({ state: "hidden" });
        await closeEvent;
        assert.equal(await opener.evaluate((element) => document.activeElement === element), true);
        await page.getByRole("link", { name: "GitHub", exact: true }).focus();
        await page.clock.runFor(6000);
        assert.notEqual(await activeImage(page).getAttribute("src"), activeWhileOpen, `feature preview ${index + 1} restores autoplay after close`);
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    await site.close();
  }
});

test("Google tag initialization remains present without changing the product page", { timeout: 30_000 }, async () => {
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
    await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
    assert.equal(loaderRequests, 1);
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
