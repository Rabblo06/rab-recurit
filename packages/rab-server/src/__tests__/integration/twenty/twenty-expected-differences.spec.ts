/**
 * T7: the behaviour-change catalogue is well-formed, and the gate for the final removal PR (#9) is computable.
 * Structural only (no database). The gate itself is enforced in PR #9's CI by `TWENTY_REMOVAL_GATE=enforce`.
 */
import catalogue from './twenty-expected-differences.json';

type Diff = { id: string; severity: string; acceptance: string; change: string; test: string };
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Everything that still blocks PR #9: unapproved differences and an incomplete migration of restricted-login tests. */
export function removalGateProblems(c: typeof catalogue = catalogue): string[] {
  const out: string[] = [];
  for (const d of c.differences as Diff[]) if (/NEEDS OWNER APPROVAL/.test(d.acceptance)) out.push(`${d.id}: ${d.acceptance}`);
  if (!c.migratedTests.entries.length) out.push('migratedTests is empty: the TW-D differential has not been classified');
  return out;
}

describe('twenty-expected-differences.json (behaviour-change catalogue)', () => {
  const diffs = catalogue.differences as Diff[];

  it('every difference has a unique id, a severity, an acceptance status, a change statement and a proving test', () => {
    expect(new Set(diffs.map((d) => d.id)).size).toBe(diffs.length);
    for (const d of diffs) {
      expect(SEVERITIES).toContain(d.severity);
      expect(d.acceptance).toMatch(/^(OWNER-ACCEPTED|NEEDS OWNER APPROVAL|doc fix)/);
      expect(d.change.length).toBeGreaterThan(20);
      expect(d.test).toMatch(/twenty-(behaviour-catalogue|injection-simulation|refusals)/);
    }
  });

  it('the five protections the owner did NOT list in §2 are present and marked NEEDS OWNER APPROVAL (never silently accepted)', () => {
    const needs = diffs.filter((d) => d.acceptance.startsWith('NEEDS OWNER APPROVAL')).map((d) => d.acceptance);
    for (const item of ['DBA-01', 'deployment identity', 'logical backup', 'column-level secret grants', 'worker_due_work']) {
      expect(needs.some((a) => a.includes(item))).toBe(true);
    }
  });

  it('the PR #9 removal gate reports what still blocks it (enforced only when TWENTY_REMOVAL_GATE=enforce)', () => {
    const problems = removalGateProblems();
    if (process.env.TWENTY_REMOVAL_GATE === 'enforce') expect(problems).toEqual([]);
    else expect(Array.isArray(problems)).toBe(true);
  });
});
