import { parseSchedulerStatus } from './outbox-operations.service';

/** Lane A: Admin queue health reports a bullmq scheduler only from a well-formed, live (TTL) status hash. */
describe('queueHealth scheduler status', () => {
  it('absent / interval mode → null', () => {
    expect(parseSchedulerStatus({})).toBeNull();
    expect(parseSchedulerStatus(null)).toBeNull();
    expect(parseSchedulerStatus({ mode: 'interval', prefix: 'x' })).toBeNull();
  });

  it('a bullmq status is reported with numeric fields only', () => {
    expect(parseSchedulerStatus({ mode: 'bullmq', prefix: 'crewflow:development:bull', reconciledAt: '1761300000000', schedulers: '19', instance: 'abc:1' })).toEqual({
      mode: 'bullmq',
      prefix: 'crewflow:development:bull',
      reconciledAt: 1761300000000,
      schedulers: 19,
    });
  });

  it('malformed values are not echoed', () => {
    expect(parseSchedulerStatus({ mode: 'bullmq', prefix: '<script>' })).toBeNull();
    expect(parseSchedulerStatus({ mode: 'bullmq', prefix: 'p', reconciledAt: 'soon', schedulers: '-1' })).toEqual({ mode: 'bullmq', prefix: 'p', reconciledAt: null, schedulers: null });
  });
});
