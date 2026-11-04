import { validate } from '../core-modules/environment/env.validation';
import {
  parseTimerTriggerKinds,
  parseTimerTriggerMode,
  parseTimerTriggerPayload,
  resolveTimerTriggerSettings,
  TIMER_TRIGGER_KINDS,
  TimerTriggerConfigError,
  timerTriggerJobId,
  timerTriggerKindOfJobName,
} from './timer-trigger.contract';

/**
 * Phase D-Q4b: WORKER_TIMER_TRIGGERS / WORKER_TIMER_TRIGGER_KINDS are strictly parsed (a mistyped value refuses to boot
 * instead of silently leaving triggers off — or on — while the operator believes otherwise), the jobId is deterministic,
 * and the consumer-side payload check accepts ids only.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const SUBJECT = '44444444-4444-4444-8444-444444444444';

describe('Phase D-Q4b timer-trigger configuration', () => {
  it('default (unset or empty) is off, all four kinds listed (but none enabled while off)', () => {
    expect(validate({ ...base }).WORKER_TIMER_TRIGGERS).toBe('off');
    expect(validate({ ...base, WORKER_TIMER_TRIGGERS: '' }).WORKER_TIMER_TRIGGERS).toBe('off');
    const settings = resolveTimerTriggerSettings({ get: () => undefined });
    expect(settings).toMatchObject({ mode: 'off', kinds: [...TIMER_TRIGGER_KINDS] });
    for (const kind of TIMER_TRIGGER_KINDS) expect(settings.enabled(kind)).toBe(false);
  });

  it.each(['off', 'shadow', 'on'])('%j is accepted', (value) => {
    expect(validate({ ...base, WORKER_TIMER_TRIGGERS: value }).WORKER_TIMER_TRIGGERS).toBe(value);
    expect(parseTimerTriggerMode(value)).toBe(value);
  });

  it.each(['OFF', 'On', 'SHADOW', ' on', 'on ', 'true', 'false', '1', '0', 'yes', 'enabled', 'shadow,on'])('%j refuses to boot (never silently off or on)', (value) => {
    expect(() => validate({ ...base, WORKER_TIMER_TRIGGERS: value })).toThrow(/WORKER_TIMER_TRIGGERS/);
    expect(() => parseTimerTriggerMode(value)).toThrow(TimerTriggerConfigError);
  });

  it('kinds: any non-empty subset, comma-separated, no spaces (OD-3: on one kind at a time)', () => {
    expect(validate({ ...base, WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry' }).WORKER_TIMER_TRIGGER_KINDS).toBe('offer-expiry');
    expect(validate({ ...base, WORKER_TIMER_TRIGGER_KINDS: 'no-show,late-clock-in' }).WORKER_TIMER_TRIGGER_KINDS).toBe('no-show,late-clock-in');
    expect(parseTimerTriggerKinds('manager-confirmation,offer-expiry')).toEqual(['manager-confirmation', 'offer-expiry']);
    const settings = resolveTimerTriggerSettings({ get: (k) => ({ WORKER_TIMER_TRIGGERS: 'on', WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry' })[k] });
    expect(TIMER_TRIGGER_KINDS.filter((k) => settings.enabled(k))).toEqual(['offer-expiry']);
  });

  it.each(['offer_expiry', 'Offer-expiry', 'offer-expiry, no-show', 'offer-expiry,', ',no-show', 'no-show,no-show', 'payroll', 'all'])(
    'kinds %j refuse to boot',
    (value) => {
      expect(() => validate({ ...base, WORKER_TIMER_TRIGGER_KINDS: value })).toThrow(/WORKER_TIMER_TRIGGER_KINDS/);
      expect(() => parseTimerTriggerKinds(value)).toThrow(TimerTriggerConfigError);
    },
  );

  it('jobId is `<kind>.<subjectId>.<dueAtEpochMs>` (no `:`; deterministic; a moved due time is a new id)', () => {
    expect(timerTriggerJobId('no-show', SUBJECT, 1_800_000_000_000)).toBe(`no-show.${SUBJECT}.1800000000000`);
    expect(timerTriggerJobId('no-show', SUBJECT, 1_800_000_000_000)).toBe(timerTriggerJobId('no-show', SUBJECT, 1_800_000_000_000));
    expect(timerTriggerJobId('no-show', SUBJECT, 1_800_000_060_000)).not.toBe(timerTriggerJobId('no-show', SUBJECT, 1_800_000_000_000));
    expect(timerTriggerJobId('manager-confirmation', SUBJECT, 4_102_444_800_000)).not.toContain(':');
    expect(timerTriggerJobId('manager-confirmation', SUBJECT, 4_102_444_800_000).length).toBeLessThanOrEqual(200);
  });

  it('job names map to kinds; anything else is unknown', () => {
    expect(timerTriggerKindOfJobName('late-clock-in-trigger')).toBe('late-clock-in');
    expect(timerTriggerKindOfJobName('late-clock-in')).toBeNull();
    expect(timerTriggerKindOfJobName('send-email')).toBeNull();
  });

  describe('consumer payload check (fail closed, before any database access)', () => {
    const ok = { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: 1_800_000_000_000 };
    it('accepts exactly the four keys', () => {
      expect(parseTimerTriggerPayload(ok)).toEqual(ok);
    });
    it.each<[string, unknown]>([
      ['null', null],
      ['an array', [ok]],
      ['an extra key', { ...ok, role: 'admin' }],
      ['a missing key', { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT }],
      ['a null workspace', { ...ok, workspaceId: null }],
      ['a non-UUID organisation', { ...ok, organisationId: 'org' }],
      ['a SQL-ish subject', { ...ok, subjectId: `${SUBJECT}' OR '1'='1` }],
      ['a string epoch', { ...ok, dueAtEpochMs: '1800000000000' }],
      ['a fractional epoch', { ...ok, dueAtEpochMs: 1.5 }],
      ['a negative epoch', { ...ok, dueAtEpochMs: -1 }],
      ['an epoch after 2100', { ...ok, dueAtEpochMs: 5_000_000_000_000 }],
    ])('refuses %s', (_label, data) => {
      expect(parseTimerTriggerPayload(data)).toBeNull();
    });
  });
});
