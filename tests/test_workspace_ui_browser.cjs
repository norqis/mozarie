"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const style = fs.readFileSync(path.join(root, "static", "style.css"), "utf8");

test("long Japanese gallery filename remains legible beside metadata", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  await page.setContent(`<!doctype html><style>${style}</style><button class="gallery-item" style="width:108px"><span class="catalog-card-footer"><span class="gallery-name">非常に長い日本語の画像ファイル名が隣の情報へ重ならないことを確認する.png</span><span class="gallery-meta">80×60</span></span></button>`);
  const layout = await page.locator(".catalog-card-footer").evaluate((footer) => {
    const name = footer.querySelector(".gallery-name"); const meta = footer.querySelector(".gallery-meta");
    const nameRect = name.getBoundingClientRect(); const metaRect = meta.getBoundingClientRect();
    return { text: name.textContent, nameRight: nameRect.right, metaLeft: metaRect.left, clipped: name.scrollWidth > name.clientWidth };
  });
  assert.match(layout.text, /非常に長い日本語/, "the filename keeps its Japanese text");
  assert.ok(layout.clipped, "the long filename is clipped within its own grid column");
  assert.ok(layout.nameRight <= layout.metaLeft, "the filename does not overlap the adjacent metadata");
});
