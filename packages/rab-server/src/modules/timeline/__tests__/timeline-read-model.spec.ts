import { BadRequestException } from '@nestjs/common';

import { decodeCursor, encodeCursor, sanitiseTimelineMetadata } from '../services/timeline.service';

describe('timeline cursor', () => {
  const id = '0b0f6c1e-3c2a-4b1a-9a55-6d1f2e3a4b5c';

  it('round-trips a microsecond timestamp and id', () => {
    const cursor = encodeCursor('2026-10-23T05:06:07.123456Z', id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ createdAt: '2026-10-23T05:06:07.123456Z', id });
  });

  it('refuses anything that is not exactly <iso-us>|<uuid> (400, never "first page")', () => {
    const bad = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    for (const c of [
      bad('2026-10-23T05:06:07.123Z|' + id), // millisecond precision would skip rows
      bad(`2026-10-23T05:06:07.123456Z|${id}|x`),
      bad(`2026-10-23T05:06:07.123456Z|not-a-uuid`),
      bad(`'; DROP TABLE core.audit_log; --|${id}`),
      bad('garbage'),
      '',
    ]) {
      expect(() => decodeCursor(c)).toThrow(BadRequestException);
    }
  });
});

describe('sanitiseTimelineMetadata', () => {
  it('keeps only allowlisted primitive keys; drops emails, hashes, file ids, nested objects', () => {
    const out = sanitiseTimelineMetadata(
      {
        reason: 'Staff forgot to clock in',
        method: 'staff',
        email: 'ava@example.test',
        sha256: 'ab'.repeat(32),
        fileId: 'f',
        before: { clockInAt: null },
        inspectedTargetUserId: 'u',
        staffProfileId: 's1',
      },
      false,
    );
    expect(out).toEqual({ reason: 'Staff forgot to clock in', method: 'staff', staffProfileId: 's1' });
  });

  it('money keys only for a payroll-capable caller', () => {
    const meta = { amountPence: 4800, workedMinutes: 240, bulk: false };
    expect(sanitiseTimelineMetadata(meta, false)).toEqual({ workedMinutes: 240, bulk: false });
    expect(sanitiseTimelineMetadata(meta, true)).toEqual(meta);
  });

  it('non-object metadata becomes {}', () => {
    for (const m of [null, undefined, 'x', 42, ['a']]) expect(sanitiseTimelineMetadata(m, true)).toEqual({});
  });
});
