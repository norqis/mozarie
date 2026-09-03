const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function main() {
  const fixture = await startFixtureServer(); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const language of ["ja", "en"]) for (const width of [270, 292, 320]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(fixture.url); await page.waitForLoadState("domcontentloaded");
      await page.evaluate(({ language, width }) => {
        document.documentElement.lang = language;
        document.querySelector("#candidatePane").style.width = `${width}px`;
      }, { language, width });
      const result = await page.locator(".candidate-section-actions").evaluateAll((sections) => sections.map((section) => ({
        overflow: section.scrollWidth > section.clientWidth,
        order: [...section.querySelectorAll("button")].map((button) => button.dataset.candidatePaddingBatch || button.dataset.candidateBatch || button.dataset.candidateDisplayToggle || button.dataset.candidateEffectiveToggle),
      })));
      assert.equal(result.some((section) => section.overflow), false, `${language}/${width}: candidate section actions do not overflow`);
      assert.deepEqual(result.map((section) => section.order), [
        ["apply:toggle", "apply", "apply", "apply", "apply:delete"],
        ["exclude:toggle", "exclude", "exclude", "exclude", "exclude:delete"],
      ], `${language}/${width}: range controls retain ON/OFF, detection, applied, padding, delete order`);
      await page.close();
    }
  } finally { await browser?.close(); await closeServer(fixture.server); }
}

main().then(() => console.log("test_candidate_padding_layout_e2e: passed")).catch((error) => { console.error(error); process.exitCode = 1; });
