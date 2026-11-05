"use strict";
/**
 * O3 real-container tests (Agent 5), TEST-ONLY. Never part of a release: o3-tests/migration/Dockerfile copies it into a
 * throwaway image built FROM the image under test (no real migration file is edited). It plays a NEW release's migration
 * that creates a table the new release's jobs need, here core.shift_report (the pre-shift PDF report state), which the test hides beforehand by a
 * superuser rename (shift_report -> shift_report_o3t_hidden). Variant: the FIX: it re-creates the table (when hidden) and succeeds.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.O3tUpgradeProbe1786721999001 = void 0;
class O3tUpgradeProbe1786721999001 {
  constructor() {
    this.name = 'O3tUpgradeProbe1786721999001';
  }
  async up(queryRunner) {
    await queryRunner.query("DO $o3t$ BEGIN IF to_regclass('core.shift_report_o3t_hidden') IS NOT NULL THEN ALTER TABLE core.shift_report_o3t_hidden RENAME TO shift_report; END IF; END $o3t$");

  }
  async down() {}
}
exports.O3tUpgradeProbe1786721999001 = O3tUpgradeProbe1786721999001;
