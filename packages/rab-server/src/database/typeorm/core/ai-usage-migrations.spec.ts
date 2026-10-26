import type { QueryRunner } from 'typeorm';

import { AI_ERROR_CODES_1786720220000 } from './migrations/1786720220000-AiPhase1Schema';
import { AI_ERROR_CODES_M7_1, AI_USAGE_ERROR_CODES_M7_1, AiUsageCacheAccounting1786720700000 } from './migrations/1786720700000-AiUsageCacheAccounting';
import { AI_USAGE_LEDGER_INSERT_COLUMNS, AI_USAGE_RETENTION_FLOOR_DAYS, AiUsageLedger1786720710000 } from './migrations/1786720710000-AiUsageLedger';

/**
 * Phase 7a migrations, static half (the database half is `ai-usage-ledger.integration.spec.ts` plus the up → down → up
 * rehearsal on rab_p7 recorded in REQUEST.md): the code list, the down() refusal, the insert-only grant list.
 */
function recordingRunner(answers: (sql: string) => unknown): { runner: QueryRunner; sql: string[] } {
  const sql: string[] = [];
  const runner = { query: async (q: string) => (sql.push(q), answers(q)) } as unknown as QueryRunner;
  return { runner, sql };
}

describe('Phase 7a migrations', () => {
  it('M7-1 extends the Phase 1 turn codes with exactly the two usage codes (the shared contract values)', () => {
    expect(AI_USAGE_ERROR_CODES_M7_1).toEqual(['AI_USER_BUDGET_EXHAUSTED', 'AI_CONTEXT_FULL']);
    expect(AI_ERROR_CODES_M7_1).toEqual([...AI_ERROR_CODES_1786720220000, 'AI_USER_BUDGET_EXHAUSTED', 'AI_CONTEXT_FULL']);
  });

  it('M7-1 down() refuses while a turn row uses a new code, before any DDL', async () => {
    const { runner, sql } = recordingRunner(() => [{ n: 3 }]);
    await expect(new AiUsageCacheAccounting1786720700000().down(runner)).rejects.toThrow(/refused — 3 turn row\(s\) still use AI_USER_BUDGET_EXHAUSTED \/ AI_CONTEXT_FULL/);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^SELECT count\(\*\)::int AS n FROM core\.ai_message WHERE error_code = ANY/);
  });

  it('M7-2: the runtime role may insert data columns only (never id / created_at); 400-day floor in SQL; ENABLE + FORCE in the same migration', async () => {
    expect(AI_USAGE_LEDGER_INSERT_COLUMNS).not.toContain('id');
    expect(AI_USAGE_LEDGER_INSERT_COLUMNS).not.toContain('created_at');
    expect(AI_USAGE_LEDGER_INSERT_COLUMNS).toEqual(expect.arrayContaining(['context_used_tokens', 'context_limit_tokens', 'cost_usd_micros']));
    expect(AI_USAGE_RETENTION_FLOOR_DAYS).toBe(400);
    const { runner, sql } = recordingRunner((q) =>
      q.includes('AS forced')
        ? [{ forced: true, policies: 4, app_select: true, app_update: false, app_delete: false, app_truncate: false, app_id_insert: false, app_created_insert: false, app_cost_insert: true, app_context_insert: true, public_select: false, purge_definer_ok: true, purge_app_execute: true, purge_public_execute: false, app_bypass: false }]
        : [],
    );
    await new AiUsageLedger1786720710000().up(runner);
    const all = sql.join('\n');
    expect(all).toMatch(/ALTER TABLE core\.ai_usage ENABLE ROW LEVEL SECURITY/);
    expect(all).toMatch(/ALTER TABLE core\.ai_usage FORCE ROW LEVEL SECURITY/);
    expect(all).toMatch(/FOR INSERT WITH CHECK \(organisation_id = core\.current_org\(\) AND user_id = core\.current_uid\(\)\)/);
    expect(all).toMatch(/FOR SELECT USING \(organisation_id = core\.current_org\(\) AND \(user_id = core\.current_uid\(\) OR core\.ai_settings_writer\(\)\)\)/);
    expect(all).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*ON core\.ai_usage TO crewflow_app/);
    expect(all).toMatch(/interval '400 days'/);
    // A drifted grant refuses to record the migration.
    const drift = recordingRunner((q) => (q.includes('AS forced') ? [{ forced: true, policies: 4, app_select: true, app_update: true }] : []));
    await expect(new AiUsageLedger1786720710000().up(drift.runner)).rejects.toThrow(/post-condition failed/);
  });
});
