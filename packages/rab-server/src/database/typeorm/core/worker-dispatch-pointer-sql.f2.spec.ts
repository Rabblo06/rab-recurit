import { createHash } from 'node:crypto';

import {
  CLAIM_IMPL_SQL,
  F2_CLAIM_IMPL_SQL,
  F2_CUTOVER_SWEEP_SQL,
  F2_FUNCTIONS,
  F2_OUTBOX_TRIGGER_FUNCTION_SQL,
  F2_STATEMENT_TRIGGER_FUNCTION_SQL,
  F2_TABLE_DOWN_SQL,
  F2_TABLE_UP_SQL,
  functionBody,
  orReplace,
  OUTBOX_TRIGGER_FUNCTION_SQL,
  STATEMENT_TRIGGER_FUNCTION_SQL,
  WORKER_DISPATCH_POINTER_UP_SQL,
} from './worker-dispatch-pointer-sql';

/**
 * Phase D F2 (StatementPointerPhysicalIdentity1786721350000): offline checks of the F2 builders. The catalog-level checks
 * are the migration's own post-conditions and phase-d-f2-pointer-identity.integration.spec.ts.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const QUEUES = ['email', 'push', 'realtime'] as const;
const NEW_BODIES = F2_FUNCTIONS.map((f) => functionBody(f.up));

describe('F2: the approved Phase D SQL stays byte-identical', () => {
  // 1786721300000 / 1310000 / 1320000 import these constants; F2 must never edit them (owner-approved text).
  it.each([
    ['CLAIM_IMPL_SQL', () => CLAIM_IMPL_SQL, '5b8cb1177a4f8b1cc18e3c718285e86d72b2f344b4b69a6df7e20ac1e0423592'],
    ['OUTBOX_TRIGGER_FUNCTION_SQL', () => QUEUES.map((q) => OUTBOX_TRIGGER_FUNCTION_SQL[q]).join('\n'), 'fd6b3ad72344caee56477558494037490cc8999fd289472fac2dd2ad1b93c26c'],
    ['STATEMENT_TRIGGER_FUNCTION_SQL', () => STATEMENT_TRIGGER_FUNCTION_SQL, 'a5325df41eed6bee7ad208a3c3e921b9a26d43be2a5c7918b0681d8d59a97f7c'],
    ['WORKER_DISPATCH_POINTER_UP_SQL', () => WORKER_DISPATCH_POINTER_UP_SQL.join('\n'), '36622f3e6727e17fb7eb98b1b73f7c4eefa9ac17311ac7d26cd6a2b0e04ee54c'],
  ])('%s is frozen', (_name, sql, hash) => {
    expect(sha(sql())).toBe(hash);
  });
});

describe('F2 builders', () => {
  it('replace exactly the five reviewed functions, and down() restores the approved bodies', () => {
    expect(F2_FUNCTIONS.map((f) => f.signature)).toEqual([
      'core.worker_dispatch_claim_impl(text, integer, integer, integer)',
      'core.worker_dispatch_pointer_email_trg()',
      'core.worker_dispatch_pointer_push_trg()',
      'core.worker_dispatch_pointer_realtime_trg()',
      'core.worker_dispatch_pointer_statement_trg()',
    ]);
    for (const f of F2_FUNCTIONS) {
      expect(f.up).toMatch(/^CREATE OR REPLACE FUNCTION /);
      expect(orReplace(f.down)).toMatch(/^CREATE OR REPLACE FUNCTION /);
      expect(functionBody(orReplace(f.down))).toBe(functionBody(f.down));
    }
  });

  it('new bodies: no comments (Phase 0b R4 scans prosrc word by word), no dynamic SQL, pinned search_path, still SECURITY DEFINER where they were', () => {
    for (const b of NEW_BODIES) {
      expect(b).not.toMatch(/--|\/\*/);
      expect(b).not.toMatch(/\bEXECUTE\b|\bformat\s*\(/i);
    }
    for (const f of F2_FUNCTIONS) expect(f.up).toContain('SET search_path = pg_catalog, pg_temp');
    expect(F2_CLAIM_IMPL_SQL).toContain('SECURITY INVOKER');
    expect(F2_STATEMENT_TRIGGER_FUNCTION_SQL).toContain('SECURITY DEFINER');
    for (const q of QUEUES) expect(F2_OUTBOX_TRIGGER_FUNCTION_SQL[q]).toContain('SECURITY DEFINER');
  });

  it('new bodies name no other table than the approved bodies do (R4 table set unchanged)', () => {
    const tables = /\b(?:core\.)?(email_outbox|push_delivery|realtime_event|payroll_record|manager_workspace|worker_dispatch_pointer|worker_event|shift|organisation|user)\b/g;
    const names = (s: string) => [...new Set(functionBody(s).match(tables) ?? [])].map((x) => x.replace(/^core\./, '')).sort();
    for (const f of F2_FUNCTIONS) expect(names(f.up)).toEqual(names(f.down));
  });

  it('claim: rows are addressed by (subject_id, source_schema) and every claimed row gets its own token', () => {
    expect(F2_CLAIM_IMPL_SQL).toContain('JOIN cand c ON c.sid = p.subject_id AND c.src = p.source_schema');
    expect(F2_CLAIM_IMPL_SQL).toContain('WHERE w.queue = p_queue AND w.subject_id = k.sid AND w.source_schema = k.src');
    expect(F2_CLAIM_IMPL_SQL).toContain('claim_token = pg_catalog.gen_random_uuid(),');
    expect(F2_CLAIM_IMPL_SQL).not.toContain('v_token');
    expect(F2_CLAIM_IMPL_SQL).toContain('FOR UPDATE OF p SKIP LOCKED');
  });

  it('outbox upserts: conflict on the physical identity, source always core; deletes keep the key prefix', () => {
    for (const q of QUEUES) {
      const s = F2_OUTBOX_TRIGGER_FUNCTION_SQL[q];
      expect(s).toContain(`VALUES ('${q}', NEW.id, 'core', NEW.organisation_id,`);
      expect(s).toContain('ON CONFLICT (queue, subject_id, source_schema) DO UPDATE');
      expect(s).not.toContain('ON CONFLICT (queue, subject_id) DO UPDATE');
    }
  });

  it('statement: every pointer write/delete is scoped to the firing copy; only generation retires same-workspace siblings', () => {
    const s = F2_STATEMENT_TRIGGER_FUNCTION_SQL;
    expect(s).toContain('v_src := TG_TABLE_SCHEMA;');
    const deletes = s.match(/DELETE FROM core\.worker_dispatch_pointer w[\s\S]*?;/g) ?? [];
    expect(deletes).toHaveLength(5); // truncate core, truncate workspace, row delete, sibling retirement, no longer due
    for (const d of deletes) expect(d).toMatch(/source_schema/);
    expect(s).toContain("w.queue = 'statement' AND w.source_schema = 'core';");
    expect(s).toMatch(/IF OLD\.statement_file_id IS NULL AND NEW\.statement_file_id IS NOT NULL THEN\s+DELETE FROM core\.worker_dispatch_pointer w\s+WHERE w\.queue = 'statement' AND w\.subject_id = NEW\.id AND w\.workspace_id = NEW\.workspace_id\s+AND w\.source_schema <> v_src;/);
    expect(s).toContain("VALUES ('statement', NEW.id, v_src, NEW.organisation_id, NEW.workspace_id, v_due)");
    expect(s).toContain('ON CONFLICT (queue, subject_id, source_schema) DO UPDATE');
    // The E-2 place / type / scope guards are carried over unchanged.
    for (const guard of ["TG_TABLE_NAME IS DISTINCT FROM 'payroll_record'", "'rab_secure_owner'::pg_catalog.regrole", 'OLD.workspace_id IS DISTINCT FROM NEW.workspace_id']) {
      expect(s).toContain(guard);
    }
  });

  it('table: key = physical identity, CHECK binds the source to core or the pointer\'s own workspace, down() restores the approved key', () => {
    expect(F2_TABLE_UP_SQL.join('\n')).toContain('PRIMARY KEY (queue, subject_id, source_schema)');
    expect(F2_TABLE_UP_SQL.join('\n')).toContain("source_schema = 'workspace_' || pg_catalog.replace(workspace_id::text, '-', '')");
    expect(F2_TABLE_DOWN_SQL.join('\n')).toContain('PRIMARY KEY (queue, subject_id)');
    expect(F2_TABLE_DOWN_SQL[0]).toBe(`DELETE FROM core.worker_dispatch_pointer WHERE queue = 'statement'`);
    expect(F2_CUTOVER_SWEEP_SQL).toContain("queue = 'statement' AND workspace_id = $1::uuid");
  });
});
