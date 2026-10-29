import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  migrationSourceViolations,
  PHASE_0B_MIGRATION_TIMESTAMP,
  PRE_PHASE_0B_HELD_TO_POST_0B_RULES,
  PRE_PHASE_0B_MIGRATIONS,
  prePhase0bMigrationFingerprint,
} from './migration-source-rules';

/** M2 early-warning scan. The catalog drift check in the restricted-migrator CI job is the authoritative gate. */
describe('core migrations after Phase 0b follow the scoped-CREATE and runtime-privilege rules (source scan)', () => {
  const dir = join(__dirname, 'migrations');
  const later = readdirSync(dir).filter(
    (f) =>
      /^\d{13}-.*\.ts$/.test(f) &&
      (Number(f.slice(0, 13)) > PHASE_0B_MIGRATION_TIMESTAMP || PRE_PHASE_0B_HELD_TO_POST_0B_RULES.has(f.replace(/\.ts$/, ''))),
  );

  it('every pre-0b migration held to the post-0b rules exists (a typo would silently exempt it)', () => {
    const files = new Set(readdirSync(dir).map((f) => f.replace(/\.ts$/, '')));
    expect([...PRE_PHASE_0B_HELD_TO_POST_0B_RULES].filter((n) => !files.has(n))).toEqual([]);
  });

  it('the chain up to Phase 0b is frozen: no new migration is back-dated before it (it would skip every post-0b check)', () => {
    const names = readdirSync(dir).filter((f) => /^\d{13}-[^.]+\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ''));
    expect(prePhase0bMigrationFingerprint(names)).toEqual(PRE_PHASE_0B_MIGRATIONS);
  });

  it('no migration written after Phase 0b breaks a rule', () => {
    const problems = later.flatMap((f) => migrationSourceViolations(readFileSync(join(dir, f), 'utf8')).map((p) => `${f}: ${p}`));
    expect(problems).toEqual([]);
  });

  describe('the rules themselves', () => {
    const ok = (sql: string) => expect(migrationSourceViolations(sql)).toEqual([]);
    const bad = (sql: string, reason: string) => expect(migrationSourceViolations(sql)).toContainEqual(expect.stringContaining(reason));

    it('a direct CREATE grant on core is refused, whoever receives it', () => {
      bad('await q.query(`GRANT CREATE ON SCHEMA core TO crewflow`)', 'grants CREATE on schema core');
      bad('await q.query(`GRANT USAGE, CREATE ON SCHEMA "core" TO someone`)', 'grants CREATE on schema core');
      ok('await q.query(`GRANT USAGE ON SCHEMA core TO crewflow_app`)');
    });

    it('OWNER TO crewflow needs withCrewflowCoreCreate in the same file', () => {
      bad('await q.query(`ALTER TABLE core.x OWNER TO crewflow`)', 'without withCrewflowCoreCreate');
      ok('await withCrewflowCoreCreate(q, () => q.query(`ALTER TABLE core.x OWNER TO crewflow`))');
      ok('await q.query(`ALTER TABLE core.x OWNER TO rab_secure_owner`)');
      bad('await q.query(`ALTER TABLE core.x OWNER TO "crewflow"`)', 'without withCrewflowCoreCreate');
    });

    it('commented-out statements neither trigger nor hide a rule', () => {
      ok('// await q.query(`GRANT CREATE ON SCHEMA core TO crewflow`)\n/* ALTER TABLE core.x OWNER TO crewflow */');
      bad('// withCrewflowCoreCreate(q, ...)\nawait q.query(`ALTER TABLE core.x OWNER TO crewflow`)', 'without withCrewflowCoreCreate');
    });

    it('schema-owner changes, owner-role memberships and elevated runtime attributes are refused', () => {
      bad('`ALTER SCHEMA core OWNER TO crewflow`', 'changes the owner of schema core');
      bad('`GRANT rab_secure_owner TO crewflow`', 'owner-role membership');
      bad('`GRANT crewflow, rab_secure_owner TO crewflow_app`', 'owner-role membership');
      bad('`ALTER ROLE crewflow_app WITH BYPASSRLS`', 'BYPASSRLS');
      bad('`ALTER ROLE crewflow CREATEROLE`', 'CREATEROLE');
      ok('`ALTER ROLE crewflow_app NOBYPASSRLS`');
    });
  });
});
