import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STANDARD_SYNC_SQL, type MetadataQuery } from './standard-object-sync';
import { syncStandardObjectsForNewWorkspace } from './standard-objects-new-workspace';

/**
 * Owner condition 3b (M1 SQL approval): while createFor's section runs as crewflow, ONLY the fixed, parameterised sync
 * statements are sent — no dynamic SQL, no caller-supplied text in any statement. Pinned two ways:
 *  1. runtime: the real helper + the real sync against a recording fake connection; every statement sent while the role is
 *     crewflow must be one of STANDARD_SYNC_SQL (or the one restore statement), and no bound value appears in any SQL text;
 *  2. static: the SQL constants of standard-object-sync.ts contain no `${…}` interpolation at all.
 */
const WS = { id: '33333333-3333-4333-8333-333333333333', organisationId: '44444444-4444-4444-8444-444444444444' };
const RESTORE_ROLE = `SELECT pg_catalog.set_config('role', $1, true)`;

describe('owner condition 3b: only the fixed, parameterised sync statements run while elevated', () => {
  it('runtime: every statement sent as crewflow is a STANDARD_SYNC_SQL constant (or the restore), values only as parameters', async () => {
    const s = { role: 'none', ws: 'prior', saved: [] as Array<{ role: string; ws: string }> };
    const sent: Array<{ sql: string; params: unknown[]; elevated: boolean }> = [];
    const allowed = new Set<string>(Object.values(STANDARD_SYNC_SQL));
    const query: MetadataQuery = async (sql, params = []) => {
      sent.push({ sql, params, elevated: s.role === 'crewflow' });
      if (sql === 'SAVEPOINT std_sync') return (s.saved.push({ role: s.role, ws: s.ws }), []);
      if (sql === 'RELEASE SAVEPOINT std_sync') return (s.saved.pop(), []);
      if (sql === 'ROLLBACK TO SAVEPOINT std_sync') return (Object.assign(s, s.saved[s.saved.length - 1]), []);
      if (sql.startsWith(`SELECT pg_catalog.current_setting('role') AS role, (current_user = session_user) AS plain`)) {
        return [{ role: s.role, plain: s.role === 'none', ws: s.ws, allowed: s.role === 'crewflow', can_set: true }];
      }
      if (sql === `SELECT pg_catalog.set_config('role', 'crewflow', true)`) return ((s.role = 'crewflow'), []);
      if (sql === RESTORE_ROLE) return ((s.role = String(params[0])), []);
      if (sql === `SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`) return ((s.ws = String(params[0])), []);
      if (sql === STANDARD_SYNC_SQL.BINDING_SQL) return [{ org: WS.organisationId, ws: s.ws }];
      if (sql === STANDARD_SYNC_SQL.TABLES_SQL) return [{ ok: true }];
      if (allowed.has(sql)) return [];
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
    };
    const report = await syncStandardObjectsForNewWorkspace(query, WS);
    expect(report.objectsInserted).toBe(27);
    expect(s).toMatchObject({ role: 'none', ws: 'prior' });

    const elevated = sent.filter((x) => x.elevated);
    expect(elevated.length).toBeGreaterThan(5);
    expect(elevated.filter((x) => !allowed.has(x.sql) && x.sql !== RESTORE_ROLE).map((x) => x.sql.slice(0, 60))).toEqual([]);
    // The write path was really exercised (empty workspace → the three INSERTs).
    for (const k of ['INSERT_OBJECTS_SQL', 'INSERT_FIELDS_SQL', 'INSERT_OPTIONS_SQL'] as const) expect(elevated.some((x) => x.sql === STANDARD_SYNC_SQL[k])).toBe(true);
    // Caller-supplied values (the workspace and organisation ids) reach the database only as bound parameters.
    for (const x of sent) for (const v of [WS.id, WS.organisationId]) expect(x.sql.includes(v)).toBe(false);
    expect(elevated.some((x) => x.params.includes(WS.id))).toBe(true);
  });

  it('static: no SQL constant of standard-object-sync.ts contains an interpolation', () => {
    const src = readFileSync(join(__dirname, 'standard-object-sync.ts'), 'utf8');
    const constants = [...src.matchAll(/^const ([A-Z_]+_SQL) = `([^`]*)`;/gm)];
    expect(constants.map((m) => m[1]).sort()).toEqual(Object.keys(STANDARD_SYNC_SQL).sort());
    for (const m of constants) expect([m[1], m[2]!.includes('${')]).toEqual([m[1], false]);
  });
});
