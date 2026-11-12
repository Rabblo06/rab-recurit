import { decodeCursor as decodeAdminCursor } from '../../engine/core-modules/platform-admin/admin-actor';
import { decodeKeysetCursor } from '../../engine/dto/keyset-cursor';
import { toIlikePattern } from '../../engine/utils/ilike-pattern.util';
import { usableUserSessionSql } from '../../engine/core-modules/auth/services/session-validity.service';
import { workspaceSchemaNameOf } from '../../database/typeorm/workspace-schema/workspace-schema-migrator';
import { compileRecordFilter, validateRecordFilter } from '../../modules/identity/member-access/record-filter';
import { buildSearchQuery } from '../../modules/search/services/search-query';
import { decodeCursor as decodeTimelineCursor } from '../../modules/timeline/services/timeline.service';

/**
 * Adversarial SQL-injection tests (owner-login architecture: one injected statement runs with the schema owner's
 * privileges — catalogue BC-01; M0 §6.4 control 10). Each attacker-controlled input path that ends up near SQL text is fed
 * classic payloads and must either be REFUSED before any SQL is built, or reach SQL only as a BOUND VALUE (never in the
 * SQL text). The real-database counterpart (payloads executed as crewflow_owner against the owner-login schema, with a
 * canary proving nothing ran) is src/__tests__/integration/owner-login-guards.integration.spec.ts ("injection payloads").
 *
 * Paths covered: search (global search query builder), filter (member-access record filters: field / operator / value /
 * relation ids), list (keyset cursors of the list endpoints, the admin and timeline cursors, ILIKE patterns), workspace
 * routing (workspace id → schema name), admin (admin list cursors), SQL helpers that take an alias. AI proposals: their
 * arguments are validated by the action catalogue and written as bound parameters (ai-proposal.service.ts); the stored
 * proposal is re-read by id — covered by the lint and the integration spec, not repeated here.
 */
const PAYLOADS = [
  "'; DROP SCHEMA core CASCADE; --",
  "' OR '1'='1",
  "x' UNION SELECT password_hash FROM core.\"user\" --",
  "1; SET ROLE rab_secure_owner; --",
  "$$; ALTER POLICY user_select ON core.\"user\" USING (true); $$",
  "\\'; SELECT pg_sleep(10); --",
  "admin'/*",
  "%' AND set_config('role','rab_secure_owner',false) IS NOT NULL AND '%'='",
  '") OR TRUE --',
  '\u0000\'; DELETE FROM core.audit_log; --',
];

describe('SQL-injection adversarial: search', () => {
  it.each(PAYLOADS)('buildSearchQuery keeps %p out of any SQL text: tsquery has only letters/digits, LIKE metacharacters are escaped', (payload) => {
    const q = buildSearchQuery(payload);
    // The tsquery is passed as a bound value to to_tsquery; it can only contain word characters, ':*' and ' & '.
    if (q.tsquery !== null) expect(q.tsquery).toMatch(/^[\p{L}\p{N}]+:\*( & [\p{L}\p{N}]+:\*)*$/u);
    expect(q.text).not.toMatch(/[\u0000-\u001f]/);
    // Every % and _ coming from the input is escaped; only the two wrapping wildcards remain.
    expect(q.likePattern.slice(1, -1)).not.toMatch(/(^|[^\\])[%_]/);
    expect(q.text.length).toBeLessThanOrEqual(200);
  });

  it.each(PAYLOADS)('toIlikePattern escapes wildcards and backslashes of %p (value is bound, never spliced)', (payload) => {
    const p = toIlikePattern(payload);
    expect(p.startsWith('%') && p.endsWith('%')).toBe(true);
    expect(p.slice(1, -1)).not.toMatch(/(^|[^\\])[%_]/);
  });
});

describe('SQL-injection adversarial: record filters (member access)', () => {
  const base = (cond: Record<string, unknown>) => ({ op: 'and', conditions: [cond] });

  it.each(PAYLOADS)('a payload as FIELD name is refused before compile: %p', (payload) => {
    expect(() => validateRecordFilter('staff', base({ field: payload, operator: 'eq', value: 'active' }))).toThrow();
  });

  it.each(PAYLOADS)('a payload as OPERATOR is refused: %p', (payload) => {
    expect(() => validateRecordFilter('staff', base({ field: 'employmentStatus', operator: payload, value: 'active' }))).toThrow();
  });

  it.each(PAYLOADS)('a payload as enum VALUE is refused (closed option list): %p', (payload) => {
    expect(() => validateRecordFilter('staff', base({ field: 'employmentStatus', operator: 'eq', value: payload }))).toThrow();
  });

  it.each(PAYLOADS)('a payload as relation id is refused (uuid only): %p', (payload) => {
    expect(() => validateRecordFilter('staff', base({ field: 'jobRole', operator: 'in', value: [payload] }))).toThrow();
  });

  it('extra keys (an injected "sql" property) are refused; an unknown object is refused', () => {
    expect(() => validateRecordFilter('staff', base({ field: 'employmentStatus', operator: 'eq', value: 'active', sql: 'TRUE' }))).toThrow(/Unexpected condition property/);
    expect(() => validateRecordFilter("staff'; --", base({ field: 'employmentStatus', operator: 'eq', value: 'active' }))).toThrow(/Unknown object/);
  });

  it('a tampered STORED filter compiles to FALSE (deny everything), never to attacker SQL', () => {
    for (const payload of PAYLOADS) {
      const compiled = compileRecordFilter('staff', base({ field: payload, operator: 'eq', value: payload }), { mode: 'raw', alias: 'sp', firstParam: 1 });
      expect(compiled).toEqual({ sql: 'FALSE', named: {}, positional: [] });
    }
  });

  it('a valid filter compiles to fixed column SQL with the value only as a positional parameter', () => {
    const compiled = compileRecordFilter('staff', base({ field: 'employmentStatus', operator: 'eq', value: 'active' }), { mode: 'raw', alias: 'sp', firstParam: 4 });
    expect(compiled.sql).toBe('(sp.employment_status = $4)');
    expect(compiled.positional).toEqual(['active']);
  });
});

describe('SQL-injection adversarial: list cursors, admin cursors, workspace routing, SQL aliases', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

  it.each(PAYLOADS)('keyset cursors carrying %p are refused with a 400 (never decoded into SQL)', (payload) => {
    expect(() => decodeKeysetCursor(b64(JSON.stringify({ v: 1, t: payload, i: '11111111-1111-4111-8111-111111111111' })))).toThrow();
    expect(() => decodeKeysetCursor(b64(JSON.stringify({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: payload })))).toThrow();
    expect(() => decodeKeysetCursor(payload)).toThrow();
  });

  it.each(PAYLOADS)('admin list cursors and timeline cursors carrying %p are refused', (payload) => {
    expect(() => decodeAdminCursor(b64(`2026-01-01T00:00:00.000Z|${payload}`))).toThrow();
    expect(() => decodeAdminCursor(payload)).toThrow();
    expect(() => decodeTimelineCursor(b64(`${payload}|11111111-1111-4111-8111-111111111111`))).toThrow();
  });

  it.each(PAYLOADS)('workspace routing: a workspace id %p never becomes a schema name', (payload) => {
    expect(() => workspaceSchemaNameOf(payload)).toThrow(/canonical uuid/);
    expect(() => workspaceSchemaNameOf(`11111111-1111-4111-8111-111111111111${payload}`)).toThrow(/canonical uuid/);
  });

  it('a valid workspace id maps to exactly workspace_<32 hex>', () => {
    expect(workspaceSchemaNameOf('11111111-1111-4111-8111-111111111111')).toBe('workspace_11111111111141118111111111111111');
  });

  it.each(PAYLOADS)('SQL helpers that take an alias refuse %p', (payload) => {
    expect(() => usableUserSessionSql(payload)).toThrow(/Invalid SQL alias/);
  });
});
