import {
  compareWithBaseline,
  ForeignKeyRow,
  foreignKeyKey,
  indexHygieneProblems,
  IndexHygieneFindings,
  indexNameProblems,
  IndexRow,
  indexServesForeignKey,
  predicateOnlyNotNull,
  proposedBaseline,
  readIndexHygieneBaseline,
  redundantIndexes,
  unindexedForeignKeys,
} from './index-hygiene';

/** Index-fix tooling 1 and 3: the pure rules of core/index-hygiene.ts (the catalogue reads run in the integration spec). */
const WS = 'workspace_0123456789abcdef0123456789abcdef';

const fk = (over: Partial<ForeignKeyRow> = {}): ForeignKeyRow => ({
  schema: 'core',
  table: 'attendance',
  constraint: 'attendance_clock_in_by_fkey',
  columns: ['clock_in_by'],
  parent_schema: 'core',
  parent_table: 'user',
  on_delete: 'NO ACTION',
  ...over,
});

const idx = (over: Partial<IndexRow> = {}): IndexRow => ({
  schema: 'core',
  table: 'attendance',
  name: 'attendance_clock_in_by_idx',
  method: 'btree',
  unique: false,
  primary: false,
  valid: true,
  keys: ['clock_in_by'],
  predicate: null,
  constraint_type: null,
  ...over,
});

const findings = (over: Partial<IndexHygieneFindings> = {}): IndexHygieneFindings => ({
  schemas: ['core'],
  foreignKeys: 0,
  indexes: 0,
  unindexed: [],
  invalid: [],
  names: [],
  redundant: [],
  ...over,
});

describe('index hygiene: foreign key coverage', () => {
  it('an index whose first k columns are the key columns, in any order, serves the key', () => {
    const composite = fk({ columns: ['organisation_id', 'user_id'] });
    expect(indexServesForeignKey(idx({ keys: ['user_id', 'organisation_id', 'created_at'] }), composite)).toBe(true);
    expect(indexServesForeignKey(idx({ keys: ['organisation_id', 'user_id'] }), composite)).toBe(true);
  });

  it("an index leading with the key's first column serves it (the reviewed evidence's rule); one leading elsewhere does not", () => {
    const composite = fk({ columns: ['conversation_id', 'organisation_id'] });
    expect(indexServesForeignKey(idx({ keys: ['conversation_id', 'created_at'] }), composite)).toBe(true);
    expect(indexServesForeignKey(idx({ keys: ['organisation_id', 'created_at'] }), composite)).toBe(false);
    expect(indexServesForeignKey(idx({ keys: ['created_at', 'clock_in_by'] }), fk())).toBe(false);
  });

  it('a partial index counts only when its predicate is just <key column> IS NOT NULL', () => {
    expect(indexServesForeignKey(idx({ predicate: '(clock_in_by IS NOT NULL)' }), fk())).toBe(true);
    expect(indexServesForeignKey(idx({ predicate: "(status = 'open'::text)" }), fk())).toBe(false);
    expect(indexServesForeignKey(idx({ predicate: '((clock_in_by IS NOT NULL) AND (deleted_at IS NULL))' }), fk())).toBe(false);
    expect(predicateOnlyNotNull('((a IS NOT NULL) AND ("b c" IS NOT NULL))', ['a', 'b c'])).toBe(true);
    expect(predicateOnlyNotNull('(other IS NOT NULL)', ['a'])).toBe(false);
  });

  it('an invalid index, an index on another table or schema, an expression and a gin index never serve a key', () => {
    expect(indexServesForeignKey(idx({ valid: false }), fk())).toBe(false);
    expect(indexServesForeignKey(idx({ table: 'shift' }), fk())).toBe(false);
    expect(indexServesForeignKey(idx({ schema: WS }), fk())).toBe(false);
    expect(indexServesForeignKey(idx({ keys: [null] }), fk())).toBe(false);
    expect(indexServesForeignKey(idx({ method: 'gin' }), fk())).toBe(false);
  });

  it('lists the keys no index serves; workspace schemas are canonicalised to WS', () => {
    const keys = [fk(), fk({ schema: WS, columns: ['clock_out_by'], constraint: 'x' })];
    const missing = unindexedForeignKeys(keys, [idx()]);
    expect(missing.map(foreignKeyKey)).toEqual(['WS.attendance(clock_out_by) -> core.user']);
  });
});

describe('index hygiene: names', () => {
  it('flags a name without a conventional suffix and a 63-byte (probably truncated) name', () => {
    const long = `${'a'.repeat(59)}_idx`;
    expect(Buffer.byteLength(long)).toBe(63);
    expect(indexNameProblems([idx(), idx({ name: 'attendance_one_active_per_staff' }), idx({ name: long })])).toEqual([
      `core.attendance.${long}: length`,
      'core.attendance.attendance_one_active_per_staff: suffix',
    ]);
  });

  it('accepts every conventional suffix', () => {
    for (const s of ['idx', 'key', 'pkey', 'uq', 'uniq', 'unique', 'uidx', 'excl']) expect(indexNameProblems([idx({ name: `t_${s}` })])).toEqual([]);
  });
});

describe('index hygiene: redundancy (report only)', () => {
  it('a plain index that is a leading prefix of another with the same predicate is a candidate; constraints are never', () => {
    const narrow = idx({ name: 'a_idx', keys: ['org_id'] });
    const wide = idx({ name: 'b_idx', keys: ['org_id', 'created_at'] });
    const uniqueNarrow = idx({ name: 'c_key', keys: ['org_id'], unique: true, constraint_type: 'u' });
    const partial = idx({ name: 'd_idx', keys: ['org_id'], predicate: '(x IS NULL)' });
    expect(redundantIndexes([narrow, wide, uniqueNarrow, partial])).toEqual([{ index: 'core.attendance.a_idx', coveredBy: 'core.attendance.b_idx' }]);
  });
});

describe('index hygiene: the baseline comparison is exact', () => {
  it('a new finding is unexpected; an entry that matches nothing is stale', () => {
    expect(compareWithBaseline(['a', 'b'], [{ key: 'b', reason: 'reason long enough' }, { key: 'c', reason: 'reason long enough' }])).toEqual({ unexpected: ['a'], stale: ['c'] });
  });

  it('only the scanned schemas are compared: a database without a workspace schema says nothing about WS entries', () => {
    const baseline = {
      unindexedForeignKeys: [{ key: 'WS.attendance(clock_in_by) -> core.user', reason: 'reason long enough' }],
      indexNames: [{ key: 'WS.attendance.attendance_one_active_per_staff: suffix', reason: 'reason long enough' }],
    };
    expect(indexHygieneProblems(findings(), baseline)).toEqual([]);
    expect(indexHygieneProblems(findings({ schemas: ['core', WS] }), baseline)).toHaveLength(2);
  });

  it('an invalid index always fails, and a new unindexed key fails until it is indexed or given a reasoned entry', () => {
    const problems = indexHygieneProblems(findings({ invalid: [idx({ valid: false })], unindexed: [fk()] }), { unindexedForeignKeys: [], indexNames: [] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/invalid index core\.attendance_clock_in_by_idx/);
    expect(problems[1]).toMatch(/unindexed foreign key core\.attendance\(clock_in_by\) -> core\.user/);
  });

  it('a regenerated baseline keeps the reasons already written and the entries of schemas that were not scanned', () => {
    const current = {
      unindexedForeignKeys: [
        { key: 'core.attendance(clock_in_by) -> core.user', reason: 'a reviewed reason' },
        { key: 'WS.attendance(clock_in_by) -> core.user', reason: 'a workspace reason' },
      ],
      indexNames: [],
    };
    const next = proposedBaseline(findings({ unindexed: [fk(), fk({ columns: ['clock_out_by'] })] }), current);
    expect(next.unindexedForeignKeys).toEqual([
      { key: 'WS.attendance(clock_in_by) -> core.user', reason: 'a workspace reason' },
      { key: 'core.attendance(clock_in_by) -> core.user', reason: 'a reviewed reason' },
      { key: 'core.attendance(clock_out_by) -> core.user', reason: expect.stringMatching(/IDX-C/) },
    ]);
  });

  it('the committed baseline parses: every entry has a key and a reason, no key twice', () => {
    const baseline = readIndexHygieneBaseline();
    expect(baseline.unindexedForeignKeys.length).toBeGreaterThan(0);
    for (const e of [...baseline.unindexedForeignKeys, ...baseline.indexNames]) expect(e.reason.length).toBeGreaterThanOrEqual(10);
  });
});
