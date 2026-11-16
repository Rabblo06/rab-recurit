/**
 * T7: the behaviour-change catalogue is well-formed, and the gate for the separated-mode retirement (the final removal,
 * formerly the placeholder "PR #9") is computable. Structural only (no database). The gate itself is enforced in that
 * retirement's CI by `TWENTY_REMOVAL_GATE=enforce`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import catalogue from './twenty-expected-differences.json';

type Diff = { id: string; severity: string; acceptance: string; change: string; test: string };
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Everything that still blocks the separated-mode retirement: unapproved differences and an incomplete migration of restricted-login tests. */
export function removalGateProblems(c: typeof catalogue = catalogue): string[] {
  const out: string[] = [];
  for (const d of c.differences as Diff[]) if (/NEEDS OWNER APPROVAL/.test(d.acceptance)) out.push(`${d.id}: ${d.acceptance}`);
  if (!c.migratedTests.entries.length) out.push('migratedTests is empty: the TW-D differential has not been classified');
  // Accepted differences kept on the removal gate by coordinator decision (Agent 3 review); owner accepted HL-1 2026-11-05.
  for (const id of (c as { removalGateKeep?: { ids: string[] } }).removalGateKeep?.ids ?? []) out.push(`KEEP-ON-GATE: ${id} (owner-accepted; kept on the removal gate by coordinator decision)`);
  // Suites that were skipped BY NAME (deleted in X5.1): the gate reports any of them that exists again.
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

  it('X5.1: the suites that were skipped by name are deleted and stay deleted (regression guard)', () => {
    const files = (catalogue as { removeInPr9?: { files: Array<{ file: string }> } }).removeInPr9?.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect({ file: f.file, exists: existsSync(join(__dirname, '../../../../../..', f.file)) }).toEqual({ file: f.file, exists: false });
    // The standalone provisioner process they exercised is gone too (the Worker provisions in-process, owner login).
    expect(existsSync(join(__dirname, '../../../../../..', 'packages/rab-worker/src/workspace-provisioner.main.ts'))).toBe(false);
    expect(removalGateProblems().filter((l) => l.startsWith('REMOVE-IN-PR9'))).toEqual([]);
  });

  it('the separated-mode removal gate reports what still blocks it (enforced only when TWENTY_REMOVAL_GATE=enforce)', () => {
    const problems = removalGateProblems();
    if (process.env.TWENTY_REMOVAL_GATE === 'enforce') expect(problems).toEqual([]);
    else expect(Array.isArray(problems)).toBe(true);
  });
});
