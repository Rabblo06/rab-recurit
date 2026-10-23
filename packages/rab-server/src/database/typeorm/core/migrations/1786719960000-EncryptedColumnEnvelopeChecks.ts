import { MigrationInterface, QueryRunner } from 'typeorm';

import { ENCRYPTED_COLUMNS, rab2EnvelopePredicate } from '../encrypted-column-envelope';

/**
 * Waves 4+5 lane DB5 — G7 step 2 (CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.17): every encrypted column must hold a
 * versioned RAB2 envelope or NULL, enforced by the database. Dev/test only: NOT in production-migration-approval.ts.
 * Contract: docs/evidence/w45-db5/CONTRACT.md §7. RAB3 / AAD is DEFERRED (not implemented). Layout and predicate:
 * ../encrypted-column-envelope.ts.
 *
 * Pre-check per column: refuses (no data changed) if any existing row violates — a pre-RAB2 legacy value must first be
 * re-encrypted with `secret:rotate`. Then ADD … NOT VALID (no scan under ACCESS EXCLUSIVE) + VALIDATE (SHARE UPDATE
 * EXCLUSIVE, concurrent reads and writes continue).
 */
export class EncryptedColumnEnvelopeChecks1786719960000 implements MigrationInterface {
  name = 'EncryptedColumnEnvelopeChecks1786719960000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    for (const c of ENCRYPTED_COLUMNS) {
      const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM ${c.table} WHERE NOT (${rab2EnvelopePredicate(c.column)})`);
      if (Number(n) !== 0) {
        throw new Error(
          `${this.name}: ${n} row(s) of ${c.table}.${c.column} are not RAB2 envelopes; refusing (no data is changed). Re-encrypt them with secret:rotate first.`,
        );
      }
    }
    for (const c of ENCRYPTED_COLUMNS) {
      await queryRunner.query(`ALTER TABLE ${c.table} ADD CONSTRAINT ${c.constraint} CHECK (${rab2EnvelopePredicate(c.column)}) NOT VALID`);
      await queryRunner.query(`ALTER TABLE ${c.table} VALIDATE CONSTRAINT ${c.constraint}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    for (const c of ENCRYPTED_COLUMNS) await queryRunner.query(`ALTER TABLE ${c.table} DROP CONSTRAINT IF EXISTS ${c.constraint}`);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(
      `SELECT pg_has_role(current_user, 'crewflow', 'USAGE') AND pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS ok`,
    );
    if (!ok) throw new Error(`${this.name} must run as the bootstrap identity (core."user" is owned by rab_secure_owner)`);
  }
}
