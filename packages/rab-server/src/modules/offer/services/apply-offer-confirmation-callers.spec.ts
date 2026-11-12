import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * T-Z2 (owner rule 2026-11-06: the system NEVER confirms an offer). Static pin, production code only (specs excluded):
 *  - `applyOfferConfirmation` — the one writer of `manager_confirmed` / assignment `confirmed` — is imported by exactly one
 *    file, `offer.service.ts` (the manual confirm), and by nothing under rab-worker;
 *  - no other production file writes `status = 'manager_confirmed'` in SQL;
 *  - `MANAGER_CONFIRMATION_TIMEOUT_MINUTES` (the removed auto-confirm timeout) is read nowhere.
 */
const PACKAGES = join(__dirname, '..', '..', '..', '..', '..');
const roots = [join(PACKAGES, 'rab-server', 'src'), join(PACKAGES, 'rab-worker', 'src')];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (['__tests__', 'node_modules', 'dist', 'migrations'].includes(name)) continue;
      out.push(...productionFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = roots.flatMap(productionFiles);
const rel = (f: string) => relative(PACKAGES, f).split(sep).join('/');

describe('no automatic confirmation — static pins', () => {
  it('scans both packages', () => {
    expect(files.some((f) => rel(f).startsWith('rab-worker/'))).toBe(true);
    expect(files.some((f) => rel(f).endsWith('offer/services/offer.service.ts'))).toBe(true);
  });

  it('only offer.service.ts imports apply-offer-confirmation', () => {
    const importers = files.filter((f) => /from\s+['"][^'"]*apply-offer-confirmation['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(importers).toEqual(['rab-server/src/modules/offer/services/offer.service.ts']);
  });

  it("only apply-offer-confirmation.ts writes status = 'manager_confirmed'", () => {
    const writers = files
      .filter((f) => /SET\s+status\s*=\s*'manager_confirmed'/i.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(writers).toEqual(['rab-server/src/modules/offer/services/apply-offer-confirmation.ts']);
  });

  it('the removed auto-confirm timeout variable is read nowhere', () => {
    const readers = files.filter((f) => /get\(\s*['"]MANAGER_CONFIRMATION_TIMEOUT_MINUTES['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(readers).toEqual([]);
  });
});
