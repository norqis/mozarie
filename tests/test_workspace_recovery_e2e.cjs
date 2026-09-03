const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const test = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const bundledPython = path.resolve(root, "..", "Mozarie", ".venv", "Scripts", "python.exe");
const python = process.env.MOZARIE_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : "python");

function startRecoveryServer() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-recovery-e2e-"));
  const script = [
    "import shutil, sys, tempfile",
    "from pathlib import Path",
    `root = Path(${JSON.stringify(root)})`,
    `temporary_root = Path(${JSON.stringify(temporaryRoot)})`,
    "sys.path.insert(0, str(root))",
    "import mozarie.core as core",
    "app_dir = temporary_root / 'app'",
    "shutil.copytree(root / 'config', app_dir / 'config')",
    "core.APP_DIR = app_dir",
    "core.CACHE_BASE_DIR = temporary_root / 'cache'",
    "core.SESSION_BASE_DIR = temporary_root / 'sessions'",
    "import mozarie.state as state_module",
    "from http.server import ThreadingHTTPServer",
    "import mozarie.http as http_module",
    "http_module.STATE = None",
    "http_module.state_module.recreate_workspace = lambda: state_module.STATE",
    "server = ThreadingHTTPServer(('127.0.0.1', 0), http_module.MosaicHandler)",
    "print(server.server_port, flush=True)",
    "server.serve_forever()",
  ].join("\n");
  const child = childProcess.spawn(python, ["-c", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const port = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`recovery server did not start: ${stderr.join("")}`)), 20_000);
    readline.createInterface({ input: child.stdout }).once("line", (line) => {
      clearTimeout(timeout);
      const value = Number(line);
      if (Number.isInteger(value) && value > 0) resolve(value);
      else reject(new Error(`recovery server returned an invalid port: ${line}`));
    });
    child.once("exit", (code) => reject(new Error(`recovery server exited early (${code}): ${stderr.join("")}`)));
  });
  return { child, port, temporaryRoot };
}

test("workspace recovery page loads translations once and recreates once before reload", async (t) => {
  const server = startRecoveryServer();
  t.after(() => {
    server.child.kill();
    fs.rmSync(server.temporaryRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${await server.port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => { window.confirm = () => true; });

  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#recreate")?.textContent?.trim());
  assert.equal(pageErrors.length, 0, `recovery page must not throw: ${pageErrors.join("\n")}`);
  assert.equal(requests.filter((pathname) => /^\/i18n\/(?:ja|en)\.json$/.test(pathname)).length, 1, "translations are requested once");

  const englishPage = await browser.newPage();
  await englishPage.addInitScript(() => localStorage.setItem("mozarie-language", "en"));
  await englishPage.goto(`${origin}/index.html`, { waitUntil: "networkidle" });
  assert.match(await englishPage.locator("#recreate").innerText(), /recreate/i, "the canonical English recovery page is translated");
  await englishPage.close();

  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    document.querySelector("#recreate").click();
    document.querySelector("#recreate").click();
  });
  await navigation;
  await page.waitForFunction(() => document.querySelector('meta[name="mozarie-token"]'));
  assert.equal(requests.filter((pathname) => pathname === "/api/workspace/recreate").length, 1, "recreate POST is sent once");
  assert.equal(pageErrors.length, 0, `reload must not throw: ${pageErrors.join("\n")}`);
});
