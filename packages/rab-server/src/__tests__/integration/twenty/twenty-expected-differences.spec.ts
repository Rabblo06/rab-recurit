/**
 * T7: the behaviour-change catalogue is well-formed, and the gate for the final removal PR (#9) is computable.
 * Structural only (no database). The gate itself is enforced in PR #9's CI by `TWENTY_REMOVAL_GATE=enforce`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import catalogue from './twenty-expected-differences.json';

type Diff = { id: string; severity: string; acceptance: string; change: string; test: string };
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Everything that still blocks PR #9: unapproved differences and an incomplete migration of restricted-login tests. */
export function removalGateProblems(c: typeof catalogue = catalogue): string[] {
  const out: string[] = [];
  for (const d of c.differences as Diff[]) if (/NEEDS OWNER APPROVAL/.test(d.acceptance)) out.push(`${d.id}: ${d.acceptance}`);
  if (!c.migratedTests.entries.length) out.push('migratedTests is empty: the TW-D differential has not been classified');
  // Accepted differences the owner still wants revisited before PR #9 (HL-1, owner decision 2026-11-05).
  for (const id of (c as { removalGateKeep?: { ids: string[] } }).removalGateKeep?.ids ?? []) out.push(`KEEP-ON-GATE: ${id} (accepted, revisit in PR #9)`);
  // Suites skipped BY NAME ("remove in PR #9"): the gate passes only once each file is gone.
  const repoRoot = join(__dirname, '../../../../../..');
  for (const f of (c as { removeInPr9?: { files: Array<{ file: string; reason: string }> } }).removeInPr9?.files ?? []) {
    if (existsSync(join(repoRoot, f.file))) out.push(`REMOVE-IN-PR9: ${f.file} still exists (${f.reason})`);
  }
  return out;
}

describe('twenty-expected-differences.json (behaviour-change catalogue)', () => {
  const diffs = catalogue.differences as Diff[];

  it('every difference has a unique id, a severity, an acceptance status, a change statement and a proving test', () => {
    expect(new Set(diffs.map((d) => d.id)).size).toBe(diffs.length);
    for (const d of diffs) {
      expect(SEVERITIES).toContain(d.severity);
      expect(d.acceptance).toMatch(/^(OWNER-ACCEPTED|NEEDS OWNER APPROVAL|MITIGATED|doc fix)/);
      expect(d.change.length).toBeGreaterThan(20);
      expect(d.test).toMatch(/twenty-(behaviour-catalogue|injection-simulation|refusals)/);
    }
  });

  it('every difference is reconciled with the BC catalogue (owner-login-behaviour-catalogue.ts): a bc list, empty only when listed in reconciliation.missingFromBc or a doc fix', () => {
    const missing = new Set((catalogue as unknown as { reconciliation: { missingFromBc: Array<{ id: string }> } }).reconciliation.missingFromBc.map((m) => m.id));
    for (const d of diffs as Array<Diff & { bc?: string[] }>) {
      expect(Array.isArray(d.bc)).toBe(true);
      if (d.bc!.length === 0) expect(missing.has(d.id) || d.acceptance.startsWith('doc fix')).toBe(true);
      for (const id of d.bc!) expect(id).toMatch(/^BC-\d{2}$/);
    }
  });

  it('the five protections the owner did NOT list in §2 are present and either NEEDS OWNER APPROVAL or accepted by a DATED owner decision (never silently accepted)', () => {
    const decided = diffs
      .filter((d) => d.acceptance.startsWith('NEEDS OWNER APPROVAL') || /^OWNER-ACCEPTED \(owner decision \d{4}-\d{2}-\d{2}/.test(d.acceptance))
      .map((d) => d.acceptance);
    for (const item of ['DBA-01', 'deployment identity', 'logical backup', 'column-level secret grants', 'worker_due_work']) {
      expect({ item, present: decided.some((a) => a.includes(item)) }).toEqual({ item, present: true });
    }
  });

  it('the PR #9 removal gate reports what still blocks it (enforced only when TWENTY_REMOVAL_GATE=enforce)', () => {
    const problems = removalGateProblems();
    // The suites skipped by name are on the gate: every listed file is reported while it still exists.
    for (const f of (catalogue as { removeInPr9?: { files: Array<{ file: string }> } }).removeInPr9?.files ?? []) {
      if (existsSync(join(__dirname, '../../../../../..', f.file))) expect(problems.some((l) => l.includes(f.file))).toBe(true);
    }
    if (process.env.TWENTY_REMOVAL_GATE === 'enforce') expect(problems).toEqual([]);
    else expect(Array.isArray(problems)).toBe(true);
  });
});
