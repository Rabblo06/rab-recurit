import { assertSemanticPostureAtBoot, SemanticPostureError } from './semantic-posture-monitor';
import type { SemanticPosture } from './semantic-posture';

/**
 * C3 (owner decision 2026-11-05): the boot-time golden comparison is skipped, with a WARNING, only when gate 7 applied the
 * upgrade-incomplete relaxation. The posture is still read and returned as the runtime baseline. Everything else is
 * unchanged: drift refuses without it, and no golden for the major in production still refuses.
 */
jest.mock('./semantic-posture', () => {
  const actual = jest.requireActual('./semantic-posture');
  return { ...actual, readSemanticPosture: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readSemanticPosture } = require('./semantic-posture') as { readSemanticPosture: jest.Mock };

const posture = (core: string[]): SemanticPosture =>
  ({ core, workspaces: new Map(), roles: [], serverMajor: 16 }) as unknown as SemanticPosture;
const GOLDEN = { 16: ['policy|t|p|PERMISSIVE|public|r|using=abc|check=-'] } as Record<number, readonly string[]>;
const query = async () => [];

describe('C3: assertSemanticPostureAtBoot with upgradeIncomplete', () => {
  beforeEach(() => readSemanticPosture.mockReset());

  it('without the relaxation, a database that differs from the golden refuses (unchanged)', async () => {
    readSemanticPosture.mockResolvedValue(posture(['policy|t|other|PERMISSIVE|public|r|using=x|check=-']));
    await expect(assertSemanticPostureAtBoot(query, { production: true, label: 'api process', golden: GOLDEN })).rejects.toBeInstanceOf(SemanticPostureError);
    await expect(assertSemanticPostureAtBoot(query, { production: true, label: 'api process', golden: GOLDEN, upgradeIncomplete: null })).rejects.toBeInstanceOf(
      SemanticPostureError,
    );
  });

  it('relaxed: the comparison is skipped with a WARNING naming the failed migration; the posture is still the baseline', async () => {
    const p = posture(['policy|t|other|PERMISSIVE|public|r|using=x|check=-']);
    readSemanticPosture.mockResolvedValue(p);
    const r = await assertSemanticPostureAtBoot(query, { production: true, label: 'api process', golden: GOLDEN, upgradeIncomplete: 'Beta1786000000100' });
    expect(r.posture).toBe(p);
    expect(r.warnings).toEqual([expect.stringMatching(/NOT compared with the golden: UPGRADE INCOMPLETE \(owner decision C3, 2026-11-05\) — the database is behind this release \(first migration not applied: Beta1786000000100\)/)]);
    expect(readSemanticPosture).toHaveBeenCalledTimes(1);
  });

  it('relaxed: no golden for the PostgreSQL major in production still refuses', async () => {
    readSemanticPosture.mockResolvedValue({ ...posture([]), serverMajor: 17 });
    await expect(
      assertSemanticPostureAtBoot(query, { production: true, label: 'api process', golden: GOLDEN, upgradeIncomplete: 'Beta1786000000100' }),
    ).rejects.toThrow(/no reviewed semantic posture golden for PostgreSQL 17/);
  });
});
