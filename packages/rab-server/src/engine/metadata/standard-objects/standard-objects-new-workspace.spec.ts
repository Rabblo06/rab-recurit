import type { MetadataQuery } from './standard-object-sync';

/**
 * Security review #166 F1: createFor's privileged section (SET LOCAL ROLE crewflow → sync → restore) runs inside
 * SAVEPOINT std_sync, so a JS error, a SQL error that aborts the transaction, or a failed restore always ends with the role and
 * binding back to the caller's (or the error propagated with the savepoint rolled back). A fake connection models the
 * transaction-local settings, the savepoint and the aborted state; the sync itself is stubbed per case.
 */
const mockSync = jest.fn();
jest.mock('./standard-object-sync', () => ({ syncStandardObjects: (...a: unknown[]) => mockSync(...a) }));
import { STANDARD_SYNC_SAVEPOINT, syncStandardObjectsForNewWorkspace } from './standard-objects-new-workspace';

const WS = { id: '11111111-1111-4111-8111-111111111111', organisationId: '22222222-2222-4222-8222-222222222222' };
const REPORT = { objectsInserted: 25, objectsUpdated: 0, fieldsInserted: 344, fieldsUpdated: 0, optionsInserted: 0, optionsUpdated: 0 };

function fakeConnection(opts: { role?: string; canSet?: boolean; failRestore?: boolean } = {}) {
  const s = { role: opts.role ?? 'none', ws: 'prior-ws', aborted: false, saved: [] as Array<{ role: string; ws: string }>, log: [] as string[] };
  let failRestore = opts.failRestore ?? false;
  const done = (f: () => void): unknown[] => {
    f();
    return [];
  };
  const query: MetadataQuery = async (sql, p = []) => {
    s.log.push(sql.split('\n')[0]!.slice(0, 60));
    if (s.aborted && !sql.startsWith('ROLLBACK TO SAVEPOINT')) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    if (sql === `SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`) return done(() => s.saved.push({ role: s.role, ws: s.ws }));
    if (sql === `ROLLBACK TO SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`) {
      Object.assign(s, s.saved[s.saved.length - 1]!, { aborted: false });
      return [];
    }
    if (sql === `RELEASE SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`) return done(() => s.saved.pop());
    if (sql.startsWith(`SELECT pg_catalog.current_setting('role') AS role, (current_user = session_user) AS plain`)) {
      return [{ role: s.role, plain: s.role === 'none', ws: s.ws, allowed: s.role === 'crewflow', can_set: opts.canSet ?? true }];
    }
    if (sql.includes(`set_config('role', 'crewflow', true)`)) return done(() => (s.role = 'crewflow'));
    if (sql.includes(`set_config('role', $1, true)`)) {
      if (failRestore) {
        failRestore = false;
        throw new Error('restore failed');
      }
      s.role = String(p[0]);
      return [];
    }
    if (sql.includes(`set_config('rab.workspace_id', $1, true)`)) return done(() => (s.ws = String(p[0])));
    if (sql === 'SELECT 1/0') {
      s.aborted = true;
      throw Object.assign(new Error('division by zero'), { code: '22012' });
    }
    throw new Error(`unexpected SQL in the fake: ${sql.slice(0, 80)}`);
  };
  return { s, query };
}

describe('#166 F1: the createFor standard-object sync runs its privileged section inside a savepoint', () => {
  beforeEach(() => mockSync.mockReset());

  it('success: elevated only during the sync, then the role and binding are back and the savepoint released', async () => {
    const c = fakeConnection();
    mockSync.mockImplementation(async (q: MetadataQuery) => {
      expect(c.s).toMatchObject({ role: 'crewflow', ws: WS.id });
      void q;
      return REPORT;
    });
    await expect(syncStandardObjectsForNewWorkspace(c.query, WS)).resolves.toEqual(REPORT);
    expect(c.s).toMatchObject({ role: 'none', ws: 'prior-ws', aborted: false, saved: [] });
    expect(c.s.log).toContain(`RELEASE SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`);
  });

  it('a JS error in the sync: rolled back to the savepoint (role and binding back) and the error propagates', async () => {
    const c = fakeConnection();
    const boom = new Error('boom');
    mockSync.mockRejectedValue(boom);
    await expect(syncStandardObjectsForNewWorkspace(c.query, WS)).rejects.toBe(boom);
    expect(c.s).toMatchObject({ role: 'none', ws: 'prior-ws', aborted: false });
    expect(c.s.log).toContain(`ROLLBACK TO SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`);
  });

  it('a SQL error that aborted the transaction: ROLLBACK TO SAVEPOINT still runs and reverts the role; the SQL error propagates', async () => {
    const c = fakeConnection();
    mockSync.mockImplementation(async (q: MetadataQuery) => q('SELECT 1/0'));
    await expect(syncStandardObjectsForNewWorkspace(c.query, WS)).rejects.toMatchObject({ code: '22012' });
    expect(c.s).toMatchObject({ role: 'none', ws: 'prior-ws', aborted: false });
  });

  it('a failed restore: rolled back to the savepoint (role back to the caller) and the error propagates', async () => {
    const c = fakeConnection({ failRestore: true });
    mockSync.mockResolvedValue(REPORT);
    await expect(syncStandardObjectsForNewWorkspace(c.query, WS)).rejects.toThrow('restore failed');
    expect(c.s).toMatchObject({ role: 'none', ws: 'prior-ws' });
    expect(c.s.log).toContain(`ROLLBACK TO SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`);
  });

  it('refuses to start unless it is the plain runtime identity, or when the session cannot become crewflow (nothing run)', async () => {
    const elevated = fakeConnection({ role: 'crewflow' });
    await expect(syncStandardObjectsForNewWorkspace(elevated.query, WS)).rejects.toThrow(/plain runtime identity/);
    const cannot = fakeConnection({ canSet: false });
    await expect(syncStandardObjectsForNewWorkspace(cannot.query, WS)).rejects.toThrow(/SET ROLE crewflow/);
    expect(mockSync).not.toHaveBeenCalled();
    expect([...elevated.s.log, ...cannot.s.log].some((l) => l.startsWith('SAVEPOINT'))).toBe(false);
  });
});
