"use strict";
/**
 * O3 real-container tests (Agent 5), TEST-ONLY. Never part of a release: o3-tests/migration/slow/Dockerfile copies it into a
 * throwaway image built FROM the fixed probe image (no real migration file is edited). It plays a SLOW new migration so the
 * test can interrupt the migrate child mid-migration (T10: `compose stop rab-api`, then SIGKILL): first a visible, harmless
 * effect (a comment on core.shift_report), then a long sleep. Interrupted, the comment and the ledger row must both be absent
 * (rolled back); the next start must apply it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.O3tSlowProbe1786721999002 = void 0;
class O3tSlowProbe1786721999002 {
  constructor() {
    this.name = 'O3tSlowProbe1786721999002';
  }
  async up(queryRunner) {
    await queryRunner.query("COMMENT ON TABLE core.shift_report IS 'o3t-slow-probe'");
    await queryRunner.query('SELECT pg_sleep(90)');
  }
  async down() {}
}
exports.O3tSlowProbe1786721999002 = O3tSlowProbe1786721999002;
