"use strict";
/**
 * Deploy-order real-container tests, TEST-ONLY (probe/build-probe-images.cjs copies it into a throwaway image built FROM the image under
 * test). A TRANSACTIONAL upgrade migration that fails: it writes nothing that survives (its transaction rolls back with
 * its ledger row). Expected under CREWFLOW_UPGRADE_FAILURE=continue (C3): exit 70, the API serves, the Worker starts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DotProbeFail1786799990001 = void 0;
class DotProbeFail1786799990001 {
  constructor() {
    this.name = 'DotProbeFail1786799990001';
  }
  async up(queryRunner) {
    await queryRunner.query('SELECT 1 / 0 AS dot_probe_deliberately_failed_upgrade');
  }
  async down() {}
}
exports.DotProbeFail1786799990001 = DotProbeFail1786799990001;
