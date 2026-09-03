const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const recoveryPage = fs.readFileSync(path.join(root, "mozarie", "workspace_recovery.html"));
const translations = new Map([
  ["/i18n/ja.json", fs.readFileSync(path.join(root, "static", "i18n", "ja.json"))],
  ["/i18n/en.json", fs.readFileSync(path.join(root, "static", "i18n", "en.json"))],
]);

function startRecoveryFixture() {
  let recreated = false;
  let recreateRequests = 0;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(recreated ? '<!doctype html><meta name="mozarie-token" content="ready">' : recoveryPage);
      return;
    }
    const translation = translations.get(pathname);
    if (translation) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(translation);
      return;
    }
    if (pathname === "/api/workspace/recreate" && request.method === "POST") {
      recreateRequests += 1;
      recreated = true;
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(pathname.startsWith("/api") ? 409 : 404, { "Content-Type": "application/json; charset=utf-8" });
    response.end('{"error_code":"workspace_recreate_required"}');
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    recreateRequests: () => recreateRequests,
  })));
}

test("workspace recovery page loads translations once and recreates once before reload", async (t) => {
  const fixture = await startRecoveryFixture();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => { window.confirm = () => true; });

  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#recreate")?.textContent?.trim());
  assert.equal(pageErrors.length, 0, `recovery page must not throw: ${pageErrors.join("\n")}`);
  assert.equal(requests.filter((pathname) => /^\/i18n\/(?:ja|en)\.json$/.test(pathname)).length, 1, "translations are requested once");

  const englishPage = await browser.newPage();
  await englishPage.addInitScript(() => localStorage.setItem("mozarie-language", "en"));
  await englishPage.goto(`${fixture.origin}/index.html`, { waitUntil: "networkidle" });
  assert.match(await englishPage.locator("#recreate").innerText(), /recreate/i, "the canonical English recovery page is translated");
  await englishPage.close();

  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    document.querySelector("#recreate").click();
    document.querySelector("#recreate").click();
  });
  await navigation;
  await page.waitForFunction(() => document.querySelector('meta[name="mozarie-token"]'));
  assert.equal(fixture.recreateRequests(), 1, "recreate POST is sent once");
  assert.equal(pageErrors.length, 0, `reload must not throw: ${pageErrors.join("\n")}`);
});
