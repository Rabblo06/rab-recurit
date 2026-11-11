"use strict";
/**
 * Deploy-order real-container tests, TEST-ONLY (probe/build-probe-images.cjs). A `transaction = false` upgrade migration that fails
 * HALF-WAY, like an interrupted CREATE INDEX CONCURRENTLY migration: its first step (an extra index, built as the table
 * owner the chain runs it as) commits, then it throws, so partial DDL is left WITHOUT a ledger row. Expected under C3
 * continue: exit 70, the API serves, the index exists, the probe is not recorded.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DotProbePartial1786799990002 = void 0;
class DotProbePartial1786799990002 {
  constructor() {
    this.name = 'DotProbePartial1786799990002';
    this.transaction = false;
  }
  async up(queryRunner) {
    await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS dot_probe_partial_idx ON core.email_outbox (created_at)');
    throw new Error('DotProbePartial1786799990002: deliberately failed after its first, committed step');
  }
  async down() {}
}
exports.DotProbePartial1786799990002 = DotProbePartial1786799990002;
