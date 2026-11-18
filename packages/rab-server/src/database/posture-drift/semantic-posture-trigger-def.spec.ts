import { readSemanticPosture, SEMANTIC_OBJECT_SQL, SemanticQuery } from './semantic-posture';
import { SEMANTIC_GOLDEN_PG16 } from './semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from './semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from './semantic-golden.pg18';

/** Static review of the trigger definition hash (`def=`) and of the pinned search_path. Behaviour: semantic-posture-trigger-def.integration.spec.ts. */
describe('semantic posture: trigger def= hash and pinned search_path', () => {
  it('hashes the definition parts, never the table or schema name', () => {
    for (const part of [
      't.tgtype::text',
      't.tgattr::pg_catalog.int2[]',
      't.tgqual IS NULL',
      'pg_catalog.pg_get_triggerdef(t.oid)',
      't.tgdeferrable',
      't.tginitdeferred',
      "pg_catalog.encode(t.tgargs, 'hex')",
      't.tgoldtable',
      't.tgnewtable',
    ]) {
      expect(SEMANTIC_OBJECT_SQL).toContain(part);
    }
    // Only the WHEN text is cut out of pg_get_triggerdef (the rest of it names the table).
    expect(SEMANTIC_OBJECT_SQL).toContain(`pg_catalog.pg_get_triggerdef(t.oid), ' WHEN \\((.*)\\) EXECUTE (FUNCTION|PROCEDURE) '`);
  });

  it('strips only an anchored schema qualifier from the WHEN text, never a substring', () => {
    expect(SEMANTIC_OBJECT_SQL).toContain(`'(^|[^[:alnum:]_.$"])' || s.nspname::text || '\\.', '\\1', 'g'`);
    expect(SEMANTIC_OBJECT_SQL).not.toContain(`pg_catalog.replace(`);
  });

  it('every trigger line of every golden carries def=, and the trigger lines are identical across majors', () => {
    const triggers = (g: readonly string[]) => g.filter((l) => l.startsWith('trigger|'));
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(triggers(g).length).toBeGreaterThan(100);
      for (const l of triggers(g)) expect(l).toMatch(/\|enabled=[ODRA]\|[^|]+\(\)\|def=[0-9a-f]{32}$/);
    }
    expect(triggers(SEMANTIC_GOLDEN_PG17)).toEqual(triggers(SEMANTIC_GOLDEN_PG16));
    expect(triggers(SEMANTIC_GOLDEN_PG18)).toEqual(triggers(SEMANTIC_GOLDEN_PG16));
  });

  function recorder(): { calls: Array<{ sql: string; params?: unknown[] }>; query: SemanticQuery } {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query: SemanticQuery = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes(`current_setting('search_path')`)) return [{ sp: '"$user", core' }];
      if (sql.includes('server_version_num')) return [{ v: 160016 }];
      return [];
    };
    return { calls, query };
  }

  it('own transaction: pins search_path to pg_catalog, pg_temp right after BEGIN READ ONLY, before any catalog read', async () => {
    const { calls, query } = recorder();
    await readSemanticPosture(query);
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN READ ONLY');
    const pin = sqls.findIndex((s) => s.includes(`set_config('search_path', 'pg_catalog, pg_temp', true)`));
    expect(pin).toBeGreaterThan(0);
    expect(sqls.findIndex((s) => s === SEMANTIC_OBJECT_SQL)).toBeGreaterThan(pin);
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
  });

  it("caller's transaction: pins, then restores the caller's search_path", async () => {
    const { calls, query } = recorder();
    await readSemanticPosture(query, { ownTransaction: false });
    expect(calls[0]!.sql).not.toBe('BEGIN READ ONLY');
    const last = calls[calls.length - 1]!;
    expect(last.sql).toContain(`set_config('search_path', $1, true)`);
    expect(last.params).toEqual(['"$user", core']);
  });
});
