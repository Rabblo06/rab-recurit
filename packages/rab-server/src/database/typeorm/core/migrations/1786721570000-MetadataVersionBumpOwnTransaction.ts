import { createHash } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  functionBodyOf,
  METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL,
  METADATA_VERSION_BUMP_PROSRC_MD5_SQL,
  METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL,
} from '../metadata-version-bump-own-xact-sql';
import { METADATA_VERSION_PREFLIGHT_SQL, METADATA_VERSION_STATE_SQL, metadataVersionStateProblems } from '../metadata-version-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Metadata version bump: a concurrent first change can no longer lose its version step (SQL owner-approved 2026-11-18,
 * "fix first, then build"). Replaces core.metadata_version_bump() of MetadataVersionState1786721560000 in place; the only
 * change is the "already bumped?" short-circuit, which now matches a bump by THIS transaction only
 * (`AND s.last_bump_xact = v_xact`). Root cause, reasoning and the exact SQL: ../metadata-version-bump-own-xact-sql.ts;
 * THREAT-MODEL "Metadata version bump: lost step on concurrent first changes".
 *
 * Identity: like 1786721560000 (whose plain CREATE FUNCTION also ran outside the scoped crewflow create window) — the
 * migrator must be a superuser or able to act as rab_secure_owner (CREATE on schema core, which CREATE OR REPLACE checks)
 * and as crewflow (the function's owner, required to replace it). No object changes owner, so withCrewflowCoreCreate
 * (which exists only for an `OWNER TO crewflow` hand-over) is not needed and not used.
 *
 * Self-check before commit, both directions: the exact body installed (md5 of pg_proc.prosrc), the whole
 * METADATA_VERSION_EXPECTED_STATE (owner crewflow, SECURITY INVOKER, pinned search_path, no EXECUTE for crewflow_app or
 * PUBLIC, the five AFTER ROW bump triggers still attached, table owner / RLS / ACL / policy / guard trigger unchanged),
 * and secureOwnerInvariantViolations() empty; anything else raises and rolls back.
 */
export class MetadataVersionBumpOwnTransaction1786721570000 implements MigrationInterface {
  name = 'MetadataVersionBumpOwnTransaction1786721570000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, 'up', METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, 'down', METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL);
  }

  private async replace(queryRunner: QueryRunner, direction: 'up' | 'down', sql: string): Promise<void> {
    // Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified.
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    await this.preflight(queryRunner, direction);
    await queryRunner.query(sql);

    const [installed] = (await queryRunner.query(METADATA_VERSION_BUMP_PROSRC_MD5_SQL)) as Array<{ body_md5: string | null }>;
    const want = createHash('md5').update(functionBodyOf(sql)).digest('hex');
    if (installed?.body_md5 !== want) {
      throw new Error(`${this.name}: core.metadata_version_bump() body after ${direction} is not the expected one (rolled back).`);
    }
    const [state] = (await queryRunner.query(METADATA_VERSION_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = metadataVersionStateProblems(state);
    if (problems.length) throw new Error(`${this.name}: unexpected state after ${direction} (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((q) => queryRunner.query(q));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(METADATA_VERSION_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act_secure: boolean;
      can_act_crewflow: boolean;
      pg16_or_later: boolean;
      state_present: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !(f.can_act_secure && f.can_act_crewflow)) problems.push('it cannot act as rab_secure_owner and crewflow (migration identity required)');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
      if (!f.state_present) problems.push('core.workspace_metadata_state does not exist (MetadataVersionState1786721560000 first)');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    // Before the replace, too: the state 1786721560000 left (owner, ACL, five triggers) is what this migration preserves.
    const [state] = (await queryRunner.query(METADATA_VERSION_STATE_SQL)) as Array<Record<string, unknown>>;
    const before = metadataVersionStateProblems(state);
    if (before.length) throw new Error(`${this.name}: refusing to run ${direction}: unexpected state before the replace:\n  ${before.join('\n  ')}`);
  }
}
