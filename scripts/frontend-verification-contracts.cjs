"use strict";

const { loadContracts } = require("./verification-contracts.cjs");
const { controlEvidenceContract } = require("../tests/ui-control-manifest.cjs");

function frontendContracts() {
  return [controlEvidenceContract(), ...loadContracts()];
}

module.exports = { frontendContracts };
