import { assessRuntimeIsolation, enforceRuntimeIsolation, IsolationFacts, RuntimeIsolationError } from './runtime-isolation';

/** H6 isolation self-check in the Worker (the retired launcher ran it): same rules and wording as api-prestart.sh. */
const DECLARED: IsolationFacts = {
  platform: 'linux',
  uid: 1000,
  capBnd: '0000000000000000',
  noNewPrivs: '1',
  rootOptions: 'ro,relatime',
  pidsMax: '256',
  memoryMax: '805306368',
};
const logs = () => {
  const lines: string[] = [];
  return { lines, log: { log: (l: string) => lines.push(`LOG ${l}`), warn: (l: string) => lines.push(`WARN ${l}`) } };
};

describe('worker runtime isolation (H6, no launcher)', () => {
  it('every declared control present -> "as declared", in warn and enforce', () => {
    for (const mode of [undefined, '', 'warn', 'enforce']) {
      const l = logs();
      expect(enforceRuntimeIsolation({ CREWFLOW_RUNTIME_ISOLATION: mode }, l.log, DECLARED).gaps).toEqual([]);
      expect(l.lines[0]).toMatch(/^LOG \[worker-isolation\] runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids\.max=256 memory\.max=805306368 mode=(warn|enforce)$/);
    }
  });

  it.each([
    ['root user', { uid: 0 }, /running as root/],
    ['another uid', { uid: 1234 }, /uid 1234, expected 1000/],
    ['capabilities kept', { capBnd: '00000000a80425fb' }, /capabilities in the bounding set \(CapBnd=00000000a80425fb\)/],
    ['no-new-privileges off', { noNewPrivs: '0' }, /no-new-privileges is off/],
    ['writable root', { rootOptions: 'rw,relatime' }, /root filesystem is writable/],
    ['unreadable mounts', { rootOptions: null }, /root filesystem is unknown/],
    ['no PID limit', { pidsMax: 'max' }, /no PID limit/],
    ['no memory limit', { memoryMax: 'max' }, /no memory limit/],
    ['unreadable memory limit', { memoryMax: null }, /memory limit unreadable/],
  ] as const)('%s: warn starts with a WARNING naming it; enforce refuses', (_label, change, pattern) => {
    const facts = { ...DECLARED, ...change } as IsolationFacts;
    const l = logs();
    enforceRuntimeIsolation({}, l.log, facts);
    expect(l.lines[0]).toMatch(/^WARN \[worker-isolation\] WARNING runtime isolation weaker than declared/);
    expect(l.lines[0]).toMatch(pattern);
    expect(() => enforceRuntimeIsolation({ CREWFLOW_RUNTIME_ISOLATION: 'enforce' }, logs().log, facts)).toThrow(RuntimeIsolationError);
    expect(() => enforceRuntimeIsolation({ CREWFLOW_RUNTIME_ISOLATION: 'enforce' }, logs().log, facts)).toThrow(pattern);
  });

  it('an invalid CREWFLOW_RUNTIME_ISOLATION refuses (strict values)', () => {
    for (const value of ['ENFORCE', 'Enforce', 'yes', 'true', 'strict']) {
      expect(() => assessRuntimeIsolation({ CREWFLOW_RUNTIME_ISOLATION: value }, DECLARED)).toThrow(/must be "warn" or "enforce"/);
    }
  });

  it('outside Linux (developer machine): warn says there is nothing to verify; enforce refuses', () => {
    const facts = { ...DECLARED, platform: 'win32' };
    const l = logs();
    enforceRuntimeIsolation({}, l.log, facts);
    expect(l.lines[0]).toMatch(/not a Linux container \(win32\)/);
    expect(() => enforceRuntimeIsolation({ CREWFLOW_RUNTIME_ISOLATION: 'enforce' }, logs().log, facts)).toThrow(RuntimeIsolationError);
  });

  it('the report never contains an environment value', () => {
    const l = logs();
    enforceRuntimeIsolation({ PG_DATABASE_URL: 'postgres://crewflow_owner:S3cret@db/rab' }, l.log, { ...DECLARED, uid: 0 });
    expect(l.lines.join(' ')).not.toContain('S3cret');
  });
});
