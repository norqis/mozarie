"use strict";

async function waitForAppStartup(page) {
  await page.waitForFunction(() => typeof appStartup !== "undefined");
  await page.evaluate(() => appStartup);
}

module.exports = { waitForAppStartup };
