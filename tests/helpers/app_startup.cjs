"use strict";
const assert = require("node:assert/strict");

// Observe the real startup promises without replacing application work or
// adding test-only readiness flags to the product.
async function observeAppStartup(page) {
  await page.route("**/js/app.js", async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    assert.match(source, /\binitialise\(\);\s*$/);
    assert.ok(source.includes('  void api("/api/projects?sort=updated_desc")'));
    source = source.replace(/\binitialise\(\);\s*$/, "window.__fixtureStartup = initialise();\n")
      .replace('  void api("/api/projects?sort=updated_desc")', '  window.__fixtureSourceCleanup = api("/api/projects?sort=updated_desc")');
    await route.fulfill({ response, body: source });
  });
}

async function waitForAppStartup(page) {
  await page.waitForFunction(() => Boolean(window.__fixtureStartup && window.__fixtureSourceCleanup));
  await page.evaluate(() => Promise.all([window.__fixtureStartup, window.__fixtureSourceCleanup]));
}

module.exports = { observeAppStartup, waitForAppStartup };
