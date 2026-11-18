import { createHash } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  functionBodyOf,
  ORGANISATION_TIME_ZONE_ABSENT_STATE,
  ORGANISATION_TIME_ZONE_COLUMN_SQL,
  ORGANISATION_TIME_ZONE_DOWN_SQL,
  ORGANISATION_TIME_ZONE_EXPECTED_DEFAULT_EXPR,
  ORGANISATION_TIME_ZONE_FUNCTION_SQL,
  ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL,
  ORGANISATION_TIME_ZONE_STATE_SQL,
  ORGANISATION_TIME_ZONE_TZDATA_SQL,
  ORGANISATION_TIME_ZONE_UP_SQL,
  OrganisationTimeZoneState,
  organisationTimeZoneExpectedState,
  organisationTimeZoneStateProblems,
} from '../organisation-time-zone-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';

/**
 * Organisation time zone, phase 1 (owner decision 2026-11-18; SQL DRAFT, waiting for the owner's review; applied to
 * disposable InstaBox test databases only). Exact SQL and the reasoning: ../organisation-time-zone-sql.ts.
 *
 * core.organisation.timezone (text NOT NULL DEFAULT 'Europe/London', IdentitySchema1786665800000) already is the
 * organisation's zone, so no column is added. This migration adds the missing database-level validation: a BEFORE INSERT
 * OR UPDATE OF timezone trigger that refuses (22023) any value that is not an IANA zone name the server's tz database
 * knows. RLS, policies and grants of core.organisation are unchanged and re-checked.
 *
 * Identity: the CF-41 / owner-login migration identity (a superuser on a disposable cluster, or a login that can act as
 * rab_secure_owner and crewflow and SET ROLE rab_secure_owner). Everything runs as rab_secure_owner (SET LOCAL ROLE): it
 * owns core.organisation and schema core, and its owner-only policy is what lets the pre-check count every organisation.
 *
 * up(): column pre-check; refuse unless this server's tz database accepts 'Europe/London' and 'UTC' (DB review F1); refuse
 * if any distinct stored zone is invalid (count only); create the function, owner, revoke, trigger;
 * self-check (function owner / INVOKER / search_path / EXECUTE / exact body, trigger definition and enabled state, RLS
 * ENABLE + FORCE and the two policies unchanged) and secure-owner invariants. Any problem raises and rolls back.
 * down(): drops the trigger and the function; the column and its default stay; same self-check for the absent state.
 */
export class OrganisationTimeZoneGuard1786721610000 implements MigrationInterface {
  name = 'OrganisationTimeZoneGuard1786721610000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await this.assertState(queryRunner, 'before up', ORGANISATION_TIME_ZONE_ABSENT_STATE);

    const [column] = (await queryRunner.query(ORGANISATION_TIME_ZONE_COLUMN_SQL)) as Array<{ is_text: boolean; not_null: boolean; default_expr: string | null }>;
    if (!column || column.is_text !== true || column.not_null !== true || column.default_expr !== ORGANISATION_TIME_ZONE_EXPECTED_DEFAULT_EXPR) {
      throw new Error(`${this.name}: core.organisation.timezone is not text NOT NULL DEFAULT 'Europe/London' (rolled back): ${JSON.stringify(column ?? null)}`);
    }

    // DB review F1: on a server with no usable tz database the rule would refuse even the default; refuse instead.
    const [tz] = (await queryRunner.query(ORGANISATION_TIME_ZONE_TZDATA_SQL)) as Array<{ london: boolean; utc: boolean }>;
    if (tz?.london !== true || tz?.utc !== true) {
      throw new Error(
        `${this.name}: this server's tz database does not list 'Europe/London' and 'UTC' (pg_timezone_names; rolled back, nothing applied). ` +
          'Install the PostgreSQL time zone data first: without it every new organisation would be refused.',
      );
    }

    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    const [{ invalid }] = (await queryRunner.query(ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL)) as Array<{ invalid: number }>;
    if (invalid !== 0) {
      throw new Error(
        `${this.name}: ${invalid} distinct invalid zone(s) stored in core.organisation.timezone (not a valid IANA name on this server; ` +
          'rolled back, nothing applied). Correct those rows first, then re-run.',
      );
    }
    await queryRunner.query(ORGANISATION_TIME_ZONE_FUNCTION_SQL);
    for (const sql of ORGANISATION_TIME_ZONE_UP_SQL) await queryRunner.query(sql);
    await queryRunner.query('RESET ROLE');

    const bodyHash = createHash('md5').update(`${functionBodyOf(ORGANISATION_TIME_ZONE_FUNCTION_SQL)}|`).digest('hex');
    await this.assertState(queryRunner, 'after up', organisationTimeZoneExpectedState(bodyHash));
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    for (const sql of ORGANISATION_TIME_ZONE_DOWN_SQL) await queryRunner.query(sql);
    await queryRunner.query('RESET ROLE');
    await this.assertState(queryRunner, 'after down', ORGANISATION_TIME_ZONE_ABSENT_STATE);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (f && !f.su && !f.can_set_secure) problems.push('cannot SET ROLE rab_secure_owner (owner of core.organisation)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }

  private async assertState(queryRunner: QueryRunner, when: string, expected: OrganisationTimeZoneState): Promise<void> {
    const [state] = (await queryRunner.query(ORGANISATION_TIME_ZONE_STATE_SQL)) as OrganisationTimeZoneState[];
    const problems = organisationTimeZoneStateProblems(state, expected);
    if (problems.length) throw new Error(`${this.name}: unexpected state ${when} (rolled back):\n  ${problems.join('\n  ')}`);
  }
}

/** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
