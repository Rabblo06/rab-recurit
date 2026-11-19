/**
 * Owner decision M1 (docs point a): db-harden removes CREATEROLE from crewflow_owner right after the first migrate, while the
 * API and the Worker already run. That ONE expected change (crewflow_owner createrole=true -> false; the mark is a COMMENT the
 * posture does not hold) must not turn readiness false (no 503, no restart needed): the monitor re-takes its baseline. Any
 * other role or object change is still drift. No database: a fake session answers the posture and role-rule queries.
 */
import type { SecurityAuditSink } from '../../engine/core-modules/audit-sink/security-audit-sink';
import { ownerLoginPostureAnswer } from '../../__tests__/helpers/owner-login-posture-fake';
import { SemanticPostureMonitor } from './semantic-posture-monitor';
import { isCreateRoleHardeningOnly, readSemanticPosture, SEMANTIC_OBJECT_SQL, SEMANTIC_ROLE_SQL, SemanticDrift } from './semantic-posture';

const ownerLine = (createrole: boolean) =>
  `role|crewflow_owner|login=true|super=false|bypassrls=false|createrole=${createrole}|createdb=false|replication=false|inherit=true|validuntil=-`;
const otherLine = (createrole: boolean) =>
  `role|crewflow_app|login=false|super=false|bypassrls=false|createrole=${createrole}|createdb=false|replication=false|inherit=true|validuntil=-`;
const CORE = ['policy|core.organisation|org_isolation|PERMISSIVE|ALL|-|USING:x|CHECK:x'];

/** A fake database: `state` can be changed between checks. */
function fakeDb(initial: { roles: string[]; core?: string[] }) {
  const state = { roles: [...initial.roles], core: [...(initial.core ?? CORE)] };
  const query = async (sql: string) => {
    if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return [];
    if (sql.includes("current_setting('server_version_num')")) return [{ v: 160016 }];
    if (sql === SEMANTIC_OBJECT_SQL) return state.core.map((line) => ({ schema: 'core', line }));
    if (sql === SEMANTIC_ROLE_SQL) return state.roles.map((line) => ({ line }));
    const posture = ownerLoginPostureAnswer(sql);
    if (posture) return posture;
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  };
  return { state, query };
}

async function monitorOn(db: ReturnType<typeof fakeDb>) {
  const baseline = await readSemanticPosture(db.query);
  const lines: string[] = [];
  const events: unknown[] = [];
  const sink = { mode: 'stdout', emit: async (e: unknown) => void events.push(e) } as unknown as SecurityAuditSink;
  const monitor = new SemanticPostureMonitor({
    session: async () => ({ query: db.query, release: async () => undefined }),
    baseline,
    sink,
    log: (l) => lines.push(l),
    processLabel: 'api process',
  });
  return { monitor, lines, events };
}

describe('isCreateRoleHardeningOnly (pure)', () => {
  const roles = (missing: string[], unexpected: string[]): SemanticDrift => ({ section: 'roles', missing, unexpected });

  it('true ONLY for crewflow_owner createrole=true -> false, the one line, nothing else', () => {
    expect(isCreateRoleHardeningOnly([roles([ownerLine(true)], [ownerLine(false)])])).toBe(true);
  });

  it.each<[string, SemanticDrift[]]>([
    ['no drift at all', []],
    ['CREATEROLE coming BACK (false -> true)', [roles([ownerLine(false)], [ownerLine(true)])]],
    ['the same change on another role', [roles([otherLine(true)], [otherLine(false)])]],
    ['an extra unexpected line beside it', [roles([ownerLine(true)], [ownerLine(false), otherLine(false)])]],
    ['an extra missing line beside it', [roles([ownerLine(true), otherLine(true)], [ownerLine(false)])]],
    ['the change plus any other section', [roles([ownerLine(true)], [ownerLine(false)]), { section: 'core', missing: ['x'], unexpected: [] }]],
    ['another attribute changed in the same line', [roles([ownerLine(true)], [ownerLine(false).replace('super=false', 'super=true')])]],
    ['a core section with the same shape', [{ section: 'core', missing: [ownerLine(true)], unexpected: [ownerLine(false)] }]],
  ])('false: %s', (_label, drifts) => {
    expect(isCreateRoleHardeningOnly(drifts)).toBe(false);
  });
});

describe('SemanticPostureMonitor: the expected CREATEROLE removal is not drift (owner decision M1, docs point a)', () => {
  it('crewflow_owner createrole=true -> false while running: re-baselined, readiness stays true, no alert, no sink event; later checks compare to the NEW baseline', async () => {
    const db = fakeDb({ roles: [ownerLine(true), otherLine(false)] });
    const { monitor, lines, events } = await monitorOn(db);
    db.state.roles = [ownerLine(false), otherLine(false)];
    let state = await monitor.checkOnce();
    expect(state.ready).toBe(true);
    expect(state.lastDrift).toEqual([]);
    expect(events).toEqual([]);
    expect(lines.some((l) => l.includes('SECURITY ALERT'))).toBe(false);
    expect(lines.filter((l) => l.includes('the expected hardening after the schema bootstrap'))).toHaveLength(1);
    // The next check against the new baseline: no drift, no second re-baseline line.
    state = await monitor.checkOnce();
    expect(state.ready).toBe(true);
    expect(lines.filter((l) => l.includes('the expected hardening'))).toHaveLength(1);
    // CREATEROLE coming BACK afterwards is drift against the NEW baseline.
    db.state.roles = [ownerLine(true), otherLine(false)];
    state = await monitor.checkOnce();
    expect(state.ready).toBe(false);
    expect(lines.some((l) => l.includes('SECURITY ALERT'))).toBe(true);
    expect(events).toHaveLength(1);
  });

  it.each<[string, string[], string[], string[] | undefined]>([
    ['createrole false -> true on crewflow_owner', [ownerLine(false)], [ownerLine(true)], undefined],
    ['the same change on another role', [ownerLine(true), otherLine(true)], [ownerLine(true), otherLine(false)], undefined],
    ['an extra role line appears', [ownerLine(true)], [ownerLine(true), otherLine(false)], undefined],
    ['the hardening plus another role change', [ownerLine(true), otherLine(true)], [ownerLine(false), otherLine(false)], undefined],
    ['the hardening plus a core object change', [ownerLine(true)], [ownerLine(false)], [...CORE, 'policy|core.organisation|backdoor|PERMISSIVE|ALL|-|USING:true|CHECK:true']],
  ])('still DRIFT: %s -> readiness false, one alert, one sink event', async (_label, before, after, coreAfter) => {
    const db = fakeDb({ roles: before });
    const { monitor, lines, events } = await monitorOn(db);
    db.state.roles = after;
    if (coreAfter) db.state.core = coreAfter;
    const state = await monitor.checkOnce();
    expect(state.ready).toBe(false);
    expect(lines.filter((l) => l.includes('SECURITY ALERT'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('the expected hardening'))).toBe(false);
    expect(events).toHaveLength(1);
  });
});
