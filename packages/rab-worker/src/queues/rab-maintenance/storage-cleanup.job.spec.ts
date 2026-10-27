import { checkRecentStorageCleanup, runStorageCleanupCycle } from './storage-cleanup.job';

/** Phase A (storage) — pure logic of the storage-cleanup job: the recent-run check and the lock-skip result. */
describe('storage-cleanup job (Phase A)', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  const SPACING = 720 * MIN;
  const read = (value: string | null | undefined) => async () => value;

  describe('checkRecentStorageCleanup', () => {
    it('recent success inside the spacing → recent (skip)', async () => {
      await expect(checkRecentStorageCleanup(read(String(NOW - 60 * MIN)), SPACING, NOW)).resolves.toEqual({
        recent: true,
        lastRunAt: NOW - 60 * MIN,
        ageMs: 60 * MIN,
      });
    });

    it('a run exactly at / beyond the spacing is NOT recent (the 24 h cadence is never skipped)', async () => {
      await expect(checkRecentStorageCleanup(read(String(NOW - SPACING)), SPACING, NOW)).resolves.toMatchObject({ recent: false, reason: 'stale' });
      // The regular next tick: 24 h after the previous start, minus a long (2 h) run → still runs.
      await expect(checkRecentStorageCleanup(read(String(NOW - 22 * 60 * MIN)), SPACING, NOW)).resolves.toMatchObject({ recent: false });
    });

    it('fails toward running: no stamp, empty, garbage, non-positive, Redis error', async () => {
      for (const value of [null, undefined, '']) {
        await expect(checkRecentStorageCleanup(read(value), SPACING, NOW)).resolves.toMatchObject({ recent: false, reason: 'no-stamp' });
      }
      for (const value of ['garbage', '0', '-5', 'NaN', 'Infinity']) {
        await expect(checkRecentStorageCleanup(read(value), SPACING, NOW)).resolves.toMatchObject({ recent: false, reason: 'unreadable' });
      }
      await expect(
        checkRecentStorageCleanup(() => Promise.reject(new Error('redis down')), SPACING, NOW),
      ).resolves.toMatchObject({ recent: false, reason: 'unreadable' });
    });

    it('a stamp from the future (beyond 5 min of skew) is ignored; small skew still counts as recent', async () => {
      await expect(checkRecentStorageCleanup(read(String(NOW + 48 * 60 * MIN)), SPACING, NOW)).resolves.toMatchObject({
        recent: false,
        reason: 'future-stamp',
      });
      await expect(checkRecentStorageCleanup(read(String(NOW + 2 * MIN)), SPACING, NOW)).resolves.toMatchObject({ recent: true, ageMs: 0 });
    });

    it('spacing 0 (rollback) never skips and never even reads the stamp', async () => {
      const reader = jest.fn(read(String(NOW)));
      await expect(checkRecentStorageCleanup(reader, 0, NOW)).resolves.toEqual({ recent: false, reason: 'disabled' });
      expect(reader).not.toHaveBeenCalled();
    });
  });

  describe('runStorageCleanupCycle', () => {
    const fakeCommand = (behaviour: { skipped?: boolean }) => {
      const command = {
        lastReport: undefined as unknown,
        lastSkipped: undefined as unknown,
        run: jest.fn(async () => {
          command.lastReport = undefined;
          command.lastSkipped = undefined;
          if (behaviour.skipped) command.lastSkipped = 'locked';
          else
            command.lastReport = {
              checkedRows: 7,
              actions: ['a'],
              summary: { integrityProblems: 1, orphans: 2, stalePending: 0 },
            };
        }),
      };
      return command;
    };

    it('always takes the lock non-blocking (wait 0) with exactly the two historical flags', async () => {
      const command = fakeCommand({});
      await expect(runStorageCleanupCycle(command as never, 30)).resolves.toEqual({
        ran: true,
        checkedRows: 7,
        integrityProblems: 1,
        orphans: 2,
        actionsTaken: 1,
      });
      expect(command.run).toHaveBeenCalledWith([], { failStalePending: true, purgeDeletedImagesOlderThanDays: 30, lockWaitSeconds: 0 });
    });

    it('lock held elsewhere → ran: false (the processor returns false, so it is never stamped)', async () => {
      await expect(runStorageCleanupCycle(fakeCommand({ skipped: true }) as never, 30)).resolves.toEqual({ ran: false, skipped: 'locked' });
    });
  });
});
