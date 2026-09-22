"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");

const [origin, expectedPath] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

async function main() {
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.settings && Number.isSafeInteger(state.serverCatalogGeneration));
    await page.evaluate(() => showProjectList());
    await page.waitForFunction((count) => document.querySelector("#projectListDialog").open && document.querySelectorAll("#projectListBody tr").length >= count, expected.length);
    const actual = await page.evaluate((projectIds) => projectIds.map((id) => {
      const project = projectListProjects.get(id);
      const row = document.querySelector(`#projectListBody tr[data-project-id="${id}"]`);
      return {
        project,
        cells: [...row.children].slice(0, 6).map((cell) => cell.innerText.trim()),
      };
    }), expected.map((project) => project.id));
    for (let index = 0; index < expected.length; index += 1) {
      const project = expected[index];
      const row = actual[index];
      for (const field of ["name", "status", "imageCount", "sourceRoot", "createdAt", "updatedAt"]) {
        assert.equal(row.project[field], project[field], `restart table response preserves ${field} for ${project.name}`);
      }
      const expectedCells = await page.evaluate((project) => [
        projectTitle(project), t(`project.${project.status}`), t("project.imageCount", { count: project.imageCount || 0 }),
        projectSource(project), projectDate(project.createdAt), projectDate(project.updatedAt),
      ], project);
      assert.deepEqual(row.cells, expectedCells, `restart project table displays every persisted value for ${project.name}`);
    }
  } finally {
    await context?.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
