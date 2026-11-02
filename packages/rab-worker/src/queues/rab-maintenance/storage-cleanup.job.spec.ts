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
    // Like the real command (it is also the `storage:reconcile` CLI), the fake reports through process.exitCode too:
    // 1 = integrity problems, 3 = lock held elsewhere.
    const fakeCommand = (behaviour: { skipped?: boolean; throws?: boolean }) => {
      const command = {
        lastReport: undefined as unknown,
        lastSkipped: undefined as unknown,
        run: jest.fn(async () => {
          command.lastReport = undefined;
          command.lastSkipped = undefined;
          process.exitCode = behaviour.skipped ? 3 : 1;
          if (behaviour.throws) throw new Error('simulated storage outage');
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
      expect(command.run).toHaveBeenCalledWith([], {
        failStalePending: true,
        purgeDeletedImagesOlderThanDays: 30,
        lockWaitSeconds: 0,
        runtimeIdentity: { process: 'worker', claimMode: 'per_scope' },
      });
    });

    it("asserts the command's connections as the Worker identity of WORKER_CLAIM_MODE (global ⇒ crewflow_worker only)", async () => {
      const saved = process.env.WORKER_CLAIM_MODE;
      try {
        for (const [mode, claimMode] of [[undefined, 'per_scope'], ['per_scope', 'per_scope'], ['global', 'global']] as const) {
          if (mode === undefined) delete process.env.WORKER_CLAIM_MODE;
          else process.env.WORKER_CLAIM_MODE = mode;
          const command = fakeCommand({});
          await runStorageCleanupCycle(command as never, 30);
          expect(command.run.mock.calls[0]).toEqual([[], expect.objectContaining({ runtimeIdentity: { process: 'worker', claimMode } })]);
        }
      } finally {
        if (saved === undefined) delete process.env.WORKER_CLAIM_MODE;
        else process.env.WORKER_CLAIM_MODE = saved;
        process.exitCode = undefined;
      }
    });

    it('lock held elsewhere → ran: false (the processor returns false, so it is never stamped)', async () => {
      await expect(runStorageCleanupCycle(fakeCommand({ skipped: true }) as never, 30)).resolves.toEqual({ ran: false, skipped: 'locked' });
    });

    describe("never changes the Worker process's exit code (the CLI's exit code means nothing in a long-running process)", () => {
      let saved: typeof process.exitCode;
      beforeEach(() => {
        saved = process.exitCode;
      });
      afterEach(() => {
        process.exitCode = saved;
      });

      it.each([
        ['integrity problems (CLI exit 1)', {}],
        ['lock held elsewhere (CLI exit 3)', { skipped: true }],
      ])('%s → exit code unchanged', async (_name, behaviour) => {
        for (const before of [undefined, 0, 7]) {
          process.exitCode = before;
          await runStorageCleanupCycle(fakeCommand(behaviour) as never, 30);
          expect(process.exitCode).toBe(before);
        }
      });

      it('a run that throws still propagates the error and leaves the exit code unchanged', async () => {
        process.exitCode = undefined;
        await expect(runStorageCleanupCycle(fakeCommand({ throws: true }) as never, 30)).rejects.toThrow('simulated storage outage');
        expect(process.exitCode).toBeUndefined();
      });
    });
  });
});
