const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { controls, anonymousStaticControls, dynamicControls, dynamicSurfaceContracts, scenarioContracts, controlEvidenceContract } = require("./ui-control-manifest.cjs");

const html = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const resultKinds = new Set(["api", "canvas", "dialog", "disabled", "dom", "download", "history", "navigation", "value"]);
const scenarios = new Set(["candidate", "confirmation", "detection", "editor", "gallery", "import", "overview", "processing", "save", "settings", "workspace"]);
const fixtures = new Set(["import", "detect", "editor", "overview", "settings", "save", "processing", "confirmation", "workspace"]);
const actual = [...html.matchAll(/<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => match[2]);
assert.equal(new Set(actual).size, actual.length, "static controls must not reuse ids");
assert.equal(new Set(controls.map((control) => control.id)).size, controls.length, "manifest control ids must be unique");
assert.deepEqual([...new Set(controls.map((control) => control.id))].sort(), [...new Set(actual)].sort(), "every static id-addressable control needs an interaction contract");
const anonymous = [...html.matchAll(/<(button|input|select|textarea)\b(?![^>]*\bid=)[^>]*>/g)].map((match) => {
  const tag = match[0];
  for (const attribute of ["data-project-sort", "data-gallery-filter", "data-candidate-batch", "data-candidate-display-toggle", "data-candidate-effective-toggle", "data-candidate-padding-batch", "data-overview-filter", "data-selection-action", "data-model-download", "data-model-help", "data-model-picker"]) {
    const value = tag.match(new RegExp(`${attribute}="([^"]+)"`))?.[1];
    if (value) return `[${attribute}="${value}"]`;
  }
  const sam = tag.match(/name="settingsSamVariant"[^>]*value="([^"]+)"/);
  if (sam) return `input[name="settingsSamVariant"][value="${sam[1]}"]`;
  if (/class="[^"]*gallery-item/.test(tag)) return ".gallery-item";
  if (/class="[^"]*overview-item/.test(tag)) return ".overview-item";
  throw new Error(`anonymous interactive control needs a stable exact selector: ${tag}`);
});
assert.equal(new Set(anonymousStaticControls).size, anonymousStaticControls.length, "anonymous static control selectors must be unique");
assert.deepEqual([...new Set(anonymous)].sort(), [...anonymousStaticControls].sort(), "every anonymous static control variant needs an exact contract");
for (const control of controls) {
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(resultKinds.has(control.resultKind), `unknown result kind for ${control.id}`);
  assert.ok(scenarios.has(control.scenario), `unknown scenario for ${control.id}`);
  assert.ok(fixtures.has(control.fixture), `unknown fixture for ${control.id}`);
  assert.match(control.assertionId, new RegExp(`^${control.scenario}:`), `${control.id} needs a stable browser-ledger assertion id`);
  assert.equal(control.predicateId, control.assertionId, `${control.id} must bind its manifest assertion to one predicate registry id`);
  assert.ok(control.expected);
  if (control.exemptReason !== undefined) {
    assert.match(control.exemptReason, /\S/, `${control.id} exemption needs a concrete reason`);
    assert.ok(Array.isArray(control.testIds) && control.testIds.length, `${control.id} exemption needs executed test evidence`);
    control.testIds.forEach((testId) => assert.match(testId, /^node:tests\/test_[^:]+\.cjs::\S.+$/, `${control.id} needs a complete Node test ID`));
  } else {
    assert.equal(control.testIds, undefined, `${control.id} active ledger control must not carry exemption evidence`);
  }
}
assert.equal(new Set(dynamicControls.map((control) => control.selector)).size, dynamicControls.length, "dynamic control selectors must be unique");
for (const control of dynamicControls) {
  assert.ok(control.selector, "dynamic controls need an explicit selector contract");
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(resultKinds.has(control.resultKind), `unknown result kind for ${control.selector}`);
  assert.ok(scenarios.has(control.scenario), `unknown scenario for ${control.selector}`);
  assert.ok(fixtures.has(control.fixture), `unknown fixture for ${control.selector}`);
  assert.match(control.assertionId, new RegExp(`^${control.scenario}:`), `${control.selector} needs a stable browser-ledger assertion id`);
  assert.equal(control.predicateId, control.assertionId, `${control.selector} must bind its manifest assertion to one predicate registry id`);
  assert.ok(control.expected, "dynamic controls need an expected result");
}
for (const surface of dynamicSurfaceContracts) {
  assert.ok(dynamicControls.some((control) => control.selector === surface.selector), `${surface.selector} needs an interaction contract`);
  const source = fs.readFileSync(path.join(__dirname, "..", surface.source), "utf8");
  for (const marker of surface.markers) {
    assert.ok(source.includes(marker), `${surface.selector} is missing its product surface marker: ${marker}`);
  }
}
for (const [scenario, contract] of Object.entries(scenarioContracts)) {
  assert.ok(scenarios.has(scenario), `unknown scenario contract ${scenario}`);
  assert.ok(contract.controls.length, `${scenario} needs controls`);
  assert.ok(contract.assertions.length, `${scenario} needs concrete assertions`);
}
for (const control of [...controls, ...dynamicControls]) {
  const key = control.id || control.selector;
  assert.ok(scenarioContracts[control.scenario]?.controls.includes(key), `${key} must be registered in its scenario`);
}
const assertionIds = [...controls, ...dynamicControls].map((control) => control.assertionId);
assert.equal(new Set(assertionIds).size, assertionIds.length, "every manifest entry maps to exactly one browser-ledger assertion id");
const evidence = controlEvidenceContract();
assert.deepEqual(evidence.observations.map((item) => item.key).sort(), controls.filter((control) => control.exemptReason).map((control) => `CONTROL-${control.id}`).sort(), "every exemption and only exemptions enter strict execution evidence");
assert.equal(evidence.observations.every((item) => item.status === "automated" && item.testIds.length > 0), true, "strict evidence entries reference executable tests");
console.log(`test_ui_control_manifest: ${controls.length} id controls and ${dynamicControls.length} dynamic contracts`);
