import { CLAIM_COUNT_ALERT_THROTTLE_MS, ClaimCountAlerter } from './claim-count-alert';

/**
 * Phase D wave 2 — OD-1 (owner decision 2026-11-01, accepted temporarily): a pointer claimed more than 20 times without
 * its subject reaching a state its trigger handles is made VISIBLE — a throttled warning with the queue label, subject id,
 * organisation id and claim count only (routing ids; never an email address, payload or other personal data). No new SQL,
 * no automatic purge: the operator follows the supervised cleanup runbook.
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const subject = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claim = (n: number, claimCount: number) => ({
  subjectId: subject(n),
  organisationId: ORG,
  workspaceId: null,
  claimToken: '10000000-0000-4000-8000-000000000001',
  claimCount,
});

describe('ClaimCountAlerter (OD-1)', () => {
  it('warns once per (queue, subject) per throttle window with exactly queue, subject, organisation and claim count', () => {
    let now = 0;
    const logger = { warn: jest.fn(), log: jest.fn() };
    const alerter = new ClaimCountAlerter({ logger, now: () => now });
    alerter.beginRun();
    alerter.note('email', claim(1, 21));
    alerter.note('email', claim(1, 22)); // same subject, same window → throttled
    alerter.endRun('email');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0]![0] as string;
    expect(line).toBe(`dispatch claim-count alert: queue=email subject=${subject(1)} organisation=${ORG} claimCount=21 (> 20)`);
    // No token, no workspace, nothing else.
    expect(line).not.toContain('10000000-0000-4000-8000-000000000001');

    now = CLAIM_COUNT_ALERT_THROTTLE_MS - 1;
    alerter.beginRun();
    alerter.note('email', claim(1, 30));
    alerter.endRun('email');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    now = CLAIM_COUNT_ALERT_THROTTLE_MS;
    alerter.beginRun();
    alerter.note('email', claim(1, 31));
    alerter.endRun('email');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1]![0]).toContain('claimCount=31');
  });

  it('the same subject id on another queue is a separate alert', () => {
    const logger = { warn: jest.fn(), log: jest.fn() };
    const alerter = new ClaimCountAlerter({ logger, now: () => 0 });
    alerter.beginRun();
    alerter.note('email', claim(1, 21));
    alerter.note('push', claim(1, 21));
    alerter.endRun('push');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('at most maxLinesPerRun alert lines per run; the rest are summarised in one line (counts only)', () => {
    const logger = { warn: jest.fn(), log: jest.fn() };
    const alerter = new ClaimCountAlerter({ logger, now: () => 0, maxLinesPerRun: 3 });
    alerter.beginRun();
    for (let i = 0; i < 8; i += 1) alerter.note('realtime', claim(i, 25));
    alerter.endRun('realtime');
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn.mock.calls[3]![0]).toBe('dispatch claim-count alert: queue=realtime 5 more pointer(s) with claimCount > 20 this run (lines suppressed)');
  });

  it('a claim at or below the threshold is never an alert', () => {
    const logger = { warn: jest.fn(), log: jest.fn() };
    const alerter = new ClaimCountAlerter({ logger, now: () => 0 });
    alerter.beginRun();
    alerter.note('statement', claim(1, 20));
    alerter.endRun('statement');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the throttle memory is bounded (expired entries are pruned; a full map is cleared rather than growing)', () => {
    let now = 0;
    const logger = { warn: jest.fn(), log: jest.fn() };
    const alerter = new ClaimCountAlerter({ logger, now: () => now, maxTracked: 5, maxLinesPerRun: 1000 });
    alerter.beginRun();
    for (let i = 0; i < 12; i += 1) alerter.note('email', claim(i, 21));
    alerter.endRun('email');
    expect(alerter.trackedCount).toBeLessThanOrEqual(5);
    now = CLAIM_COUNT_ALERT_THROTTLE_MS + 1;
    alerter.beginRun();
    alerter.note('email', claim(99, 21));
    alerter.endRun('email');
    expect(alerter.trackedCount).toBe(1);
  });
});
