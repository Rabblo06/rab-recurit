import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

import { EVIDENCE_DIR } from './env';

export async function shot(page: Page, name: string, fullPage = false): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

export interface OnboardingResult {
  suggestions: string[];
  createStatus: number;
  createBody: any;
  stagesSeen: Record<string, string>[];
  preparingMs: number;
}

/**
 * The real first-run onboarding: Create your workspace (name, "Suggest an address", chosen label) → profile →
 * preparation screen (six server-derived stages) → welcome → the app. Records the stage states it observed.
 */
export async function uiOnboard(page: Page, o: { name: string; label: string; first: string; last: string; shotPrefix?: string }): Promise<OnboardingResult> {
  await page.waitForURL(/\/onboarding\/workspace/, { timeout: 30_000 });
  await page.locator('#ws-name').fill(o.name);
  await page.getByRole('button', { name: 'Suggest an address' }).click();
  const sugg = page.locator('[aria-label="Suggested addresses"] button');
  await sugg.first().waitFor({ state: 'visible', timeout: 20_000 });
  const suggestions = await sugg.allInnerTexts();
  if (o.shotPrefix) await shot(page, `${o.shotPrefix}-subdomain-suggestions`);
  await page.locator('#ws-subdomain').fill(o.label);
  await page.waitForTimeout(1200); // debounced availability check
  if (o.shotPrefix) await shot(page, `${o.shotPrefix}-subdomain-chosen`);
  const createdP = page.waitForResponse((r) => /\/rest\/v1\/manager-workspaces$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 60_000 });
  const t0 = Date.now();
  await page.locator('button[type=submit]').click();
  const created = await createdP;
  const createBody = await created.json().catch(() => null);
  const stagesSeen: Record<string, string>[] = [];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = new URL(page.url());
    if (url.pathname.startsWith('/onboarding/profile')) {
      if (await page.locator('#p-first').isVisible()) {
        await page.locator('#p-first').fill(o.first);
        await page.locator('#p-last').fill(o.last);
        await page.locator('button[type=submit]').click();
        await page.waitForTimeout(500);
      }
    } else if (url.pathname.startsWith('/onboarding/preparing')) {
      const st = await page.locator('.preparation-steps [data-stage]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-stage'), e.getAttribute('data-state')])));
      if (Object.keys(st).length && JSON.stringify(st) !== JSON.stringify(stagesSeen[stagesSeen.length - 1])) {
        stagesSeen.push(st as Record<string, string>);
        if (o.shotPrefix && stagesSeen.length <= 3) await shot(page, `${o.shotPrefix}-preparing-${stagesSeen.length}`);
      }
    } else if (!url.pathname.startsWith('/onboarding')) {
      break;
    }
    await page.waitForTimeout(250);
  }
  return { suggestions, createStatus: created.status(), createBody, stagesSeen, preparingMs: Date.now() - t0 };
}

/** The real sign-in UI: welcome → "Continue with email" → email → Continue → password → Sign in. */
export async function uiLogin(page: Page, origin: string, email: string, password: string): Promise<void> {
  await page.goto(`${origin}/login`);
  const start = page.locator('button.auth-email-start');
  await start.waitFor({ state: 'visible', timeout: 30_000 });
  await start.click();
  await page.locator('#email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#password').fill(password);
  for (let attempt = 0; attempt < 5; attempt++) {
    const resP = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login' && r.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).click();
    const res = await resP;
    if (res.status() !== 429) break;
    // Shared-IP per-IP login throttle (5/min): wait it out like a person would, then press Try again.
    const wait = Number((await res.allHeaders())['retry-after'] ?? 30);
    await page.waitForTimeout((Number.isFinite(wait) ? wait : 30) * 1000 + 1000);
    await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).waitFor({ state: 'visible', timeout: 90_000 });
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  await settle(page);
}

/**
 * The workspace-host landing of the login handoff (lane D, M10-3, 2026-10-24): it peeks the token and asks
 * "Continue as j***@…?"; only an explicit Continue exchanges it. Asserts the masked address the user is shown, presses
 * Continue and waits until the page has left /auth/handoff.
 */
export async function confirmHandoff(page: Page, email: string): Promise<void> {
  await page.waitForURL((u) => u.pathname.startsWith('/auth/handoff'), { timeout: 60_000 });
  const masked = page.getByTestId('handoff-masked-email');
  await expect(masked).toBeVisible({ timeout: 30_000 });
  // Exactly the server's mask (core.login_handoff peek: first character + '***@' + domain), compared as a plain string.
  const [local, domain] = email.split('@');
  await expect(masked).toHaveText(`${local[0]}***@${domain}`);
  await page.getByRole('button', { name: /^Continue as / }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/handoff'), { timeout: 60_000 });
}

/** Lets client-side redirects (OnboardingGate, handoff) finish before the caller inspects the URL. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}
