import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * AI Phase 1 — the owner brief's milestone 7 demonstration, end to end on a REAL stack (run-ai-e2e.sh):
 *   API from source (:3998) + rab-worker from source + Vite (:5176), crewflow-test-db (15436), crewflow-test-redis
 *   (16391, own db index), AI_ENABLED=true with the deterministic mock provider. Synthetic organisations only.
 *
 *  1. A platform admin turns AI ON for organisation A in the Admin Panel (reason + step-up, audited).
 *  2. A's CEO signs in, opens the chat, asks "Which shifts this weekend are unfilled?" and sees a streamed answer
 *     built from the real tool data; then reopens it from the history.
 *  3. Organisation B's records never appear, and B cannot open A's conversation.
 *  4. The payroll comparison answers for the CEO (payroll.view) and is refused for A's Initial Manager without it.
 *  5. The admin turns A's switch OFF: further use is blocked in the open chat and the entry points disappear.
 *  6. Admin Health shows the usage.
 * Screenshots go to docs/ai/screenshots/. Evidence (non-secret) to AI_E2E_EVIDENCE.
 */
const WEB = process.env.AI_E2E_WEB ?? 'http://localhost:5176';
const API = process.env.AI_E2E_API ?? 'http://localhost:3998/rest/v1';
const SHOTS = path.resolve(__dirname, '../../../docs/ai/screenshots');
const EVIDENCE = process.env.AI_E2E_EVIDENCE ?? path.resolve(__dirname, '.evidence.json');
const ids = JSON.parse(readFileSync(process.env.AI_E2E_IDENTITIES ?? '', 'utf8')) as {
  run: string;
  weekend: { saturday: string; sunday: string };
  orgA: { id: string; name: string; slug: string };
  orgB: { id: string; name: string };
  ceoA: Who;
  imA: Who;
  ceoB: Who;
  admin: Who;
};
interface Who { email: string; password: string; userId: string }

const evidence: Record<string, unknown> = { run: ids.run, startedAt: new Date().toISOString(), steps: [] as unknown[] };
const step = (name: string, detail: Record<string, unknown> = {}) => (evidence.steps as unknown[]).push({ name, at: new Date().toISOString(), ...detail });

test.describe.configure({ mode: 'serial' });
test.setTimeout(8 * 60_000);

// Auth endpoints are limited to 5/min each: every login and every full page load (which refreshes) is paced.
const stamps: Record<string, number[]> = { login: [], load: [] };
async function pace(kind: 'login' | 'load') {
  const now = () => Date.now();
  stamps[kind] = stamps[kind]!.filter((t) => now() - t < 61_000);
  if (stamps[kind]!.length >= 4) await new Promise((r) => setTimeout(r, 61_500 - (now() - stamps[kind]![0]!)));
  stamps[kind]!.push(now());
}
async function goto(page: Page, url: string) {
  await pace('load');
  await page.goto(url);
}
async function uiLogin(page: Page, who: Who) {
  await goto(page, '/login');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(who.email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await pace('login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}
async function apiLogin(req: APIRequestContext, who: Who) {
  await pace('login');
  const res = await req.post(`${API}/auth/login`, { headers: { Origin: WEB }, data: { email: who.email, password: who.password, applicationTarget: 'manager_web' } });
  expect(res.status()).toBe(200);
}
const apiGet = (req: APIRequestContext, url: string) => req.get(`${API}${url}`, { headers: { Origin: WEB, 'X-Application-Target': 'manager_web' } });
const shot = async (page: Page, name: string, opts: { fullPage?: boolean } = {}) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(600); // let entrance animations (≤ 0.2 s) settle so the capture shows the final state
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: opts.fullPage ?? false });
};
const sectionShot = async (page: Page, label: string, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  const section = page.getByRole('region', { name: label });
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await section.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

interface SseEvent { id?: string; event?: string; data: Record<string, unknown> }
function parseSse(body: string): SseEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) return null;
      return { id: lines.find((l) => l.startsWith('id:'))?.slice(3).trim(), event: lines.find((l) => l.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(data) };
    })
    .filter((e): e is SseEvent => e !== null);
}

/**
 * The stream is read by the app with fetch + a ReadableStream reader; DevTools cannot return a streamed body, so the
 * page's own fetch is wrapped (test-only init script) to tee each AI stream's raw SSE text into `window.__aiStreams`.
 * The app's copy of the stream is untouched.
 */
const TEE_SSE = () => {
  const w = window as unknown as { __aiStreams: Array<{ url: string; text: string; done: boolean }>; fetch: typeof fetch };
  w.__aiStreams = [];
  const original = w.fetch.bind(window);
  w.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
    if (url.includes('/stream?turnId=') && res.body) {
      const entry = { url, text: '', done: false };
      w.__aiStreams.push(entry);
      const reader = res.clone().body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.text += decoder.decode(value, { stream: true });
          }
        } finally {
          entry.done = true;
        }
      })();
    }
    return res;
  };
};

/** Asks a question in the open chat and returns the stream evidence (URL, headers, events) and the final answer text. */
async function askInChat(page: Page, question: string): Promise<{ url: string; events: SseEvent[]; answer: string; requestHeaders: Record<string, string> }> {
  const composer = page.getByRole('textbox', { name: 'Message Crewflow AI' });
  await composer.fill(question);
  const streamResponse = page.waitForResponse((r) => r.url().includes('/stream?turnId='), { timeout: 60_000 });
  const before = await page.getByRole('article', { name: 'Assistant answer' }).count();
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await streamResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  const requestHeaders = await response.request().allHeaders();
  const answers = page.getByRole('article', { name: 'Assistant answer' });
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.nth(before);
  await expect(answer).toHaveAttribute('data-status', /completed|failed|cancelled/, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __aiStreams: Array<{ text: string }> }).__aiStreams.at(-1)?.text ?? ''), { timeout: 30_000 }).toContain('event: done');
  const events = parseSse(await page.evaluate(() => (window as unknown as { __aiStreams: Array<{ text: string }> }).__aiStreams.at(-1)!.text));
  return { url: response.url(), events, answer: (await answer.innerText()).trim(), requestHeaders };
}

let browser: Browser;
let adminCtx: BrowserContext;
let admin: Page;
let ceoCtx: BrowserContext;
let ceo: Page;
let firstConversationTitle = 'Which shifts this weekend are unfilled?';
let conversationIdA = '';

test.beforeAll(async ({ browser: b }) => {
  browser = b;
});
test.afterAll(async () => {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  await adminCtx?.close();
  await ceoCtx?.close();
});

test('0. before the switch: A’s CEO is not eligible, so no AI chrome is shown', async () => {
  ceoCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: WEB, colorScheme: 'light' });
  await ceoCtx.addInitScript(TEE_SSE);
  ceo = await ceoCtx.newPage();
  await uiLogin(ceo, ids.ceoA);
  const availability = await (await apiGet(ceoCtx.request, '/ai/availability')).json();
  expect(availability).toMatchObject({ available: false, reason: 'organisation_disabled', usage: null });
  await expect(ceo.getByRole('button', { name: 'Workspace menu' })).toBeVisible();
  await expect(ceo.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  await expect(ceo.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'AI' })).toHaveCount(0);
  // The API itself answers the uniform 404 while the switch is off.
  expect((await apiGet(ceoCtx.request, '/ai/conversations')).status()).toBe(404);
  step('ceo-not-eligible-before-switch', { availability, askAiButtons: 0, conversationsStatus: 404 });
});

test('1. the platform admin turns AI on for organisation A (reason + step-up, audited)', async () => {
  adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: WEB, colorScheme: 'light' });
  admin = await adminCtx.newPage();
  await uiLogin(admin, ids.admin);
  await goto(admin, '/settings/admin');
  await admin.getByRole('tab', { name: 'General' }).click();
  await admin.getByRole('group', { name: 'Look up type' }).getByRole('button', { name: 'Organisation' }).click();
  await admin.getByRole('searchbox', { name: 'Search' }).fill(ids.orgA.slug);
  await admin.getByRole('button', { name: 'Search', exact: true }).click();
  await admin.getByRole('button', { name: `Show ${ids.orgA.name}` }).click();
  const toggle = admin.getByRole('checkbox', { name: `AI assistant for ${ids.orgA.name}` });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked(); // default OFF
  await toggle.click({ force: true });
  const dialog = admin.getByRole('dialog');
  await expect(dialog.getByText(`Turn on the AI assistant for ${ids.orgA.name}`)).toBeVisible();
  await dialog.getByLabel('Reason (saved to the audit log)').fill('E2E pilot: synthetic organisation A');
  await dialog.getByLabel('Your password').fill(ids.admin.password);
  const put = admin.waitForResponse((r) => r.url().includes(`/admin/ai/organisations/${ids.orgA.id}/setting`) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Turn on AI' }).click();
  const saved = await put;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ organisationId: ids.orgA.id, enabled: true });
  await expect(admin.getByText(`AI assistant is on for ${ids.orgA.name}`)).toBeVisible();
  await expect(toggle).toBeChecked();
  await admin.getByRole('checkbox', { name: `AI assistant for ${ids.orgA.name}` }).scrollIntoViewIfNeeded();
  await shot(admin, 'admin-org-card-ai-switch-1440');
  step('admin-enabled-ai-for-org-a', { status: saved.status() });
});

test('2. A’s CEO opens the chat, asks about unfilled weekend shifts and gets a streamed answer from real tool data', async () => {
  await goto(ceo, '/');
  await expect(ceo.getByRole('button', { name: 'Ask AI' })).toBeVisible({ timeout: 30_000 });
  await ceo.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'AI' }).click();
  await expect(ceo).toHaveURL(/\/chat$/);
  await expect(ceo.getByText('AI answers can be inaccurate. Check important figures; decisions stay with authorised people.')).toBeVisible();
  await shot(ceo, 'chat-empty-1440-light');

  const result = await askInChat(ceo, 'Which shifts this weekend are unfilled?');
  // Authenticated SSE: the cookie session, the session fence header, no token anywhere in the URL.
  expect(new URL(result.url).search).toMatch(/^\?turnId=[0-9a-f-]{36}$/);
  expect(result.requestHeaders.cookie ?? '').toMatch(/crewflow_session=/);
  expect(result.requestHeaders.authorization).toBeUndefined();
  expect(result.requestHeaders['x-crewflow-expected-session-id']).toBeTruthy();
  const types = result.events.map((e) => e.data.type);
  expect(types).toContain('tool');
  expect(types).toContain('delta');
  expect(types[types.length - 1]).toBe('done');
  const tool = result.events.find((e) => e.data.type === 'tool');
  expect(tool?.data).toMatchObject({ name: 'list_unfilled_shifts' });
  const done = result.events[result.events.length - 1]!.data as { status: string; content: string };
  expect(done.status).toBe('completed');
  const streamed = result.events.filter((e) => e.data.type === 'delta').map((e) => String(e.data.text)).join('');
  expect(streamed.trim()).toBe(done.content.trim()); // the deltas ARE the answer
  // Real data from organisation A's seeded shifts: 2 shifts still need staff (bartender 1 of 3, waiter 0 of 2).
  expect(done.content).toMatch(/^2 shift\(s\) still need staff/);
  expect(done.content).toContain('Bartender at Riverside Hall');
  expect(done.content).toContain('2 of 3 still needed');
  expect(done.content).toContain('Waiter at Riverside Hall');
  expect(done.content).toContain('2 of 2 still needed');
  // Organisation B's records never appear.
  expect(result.answer).not.toMatch(/Sommelier|Harbour Lights|B-ONLY/);
  expect(result.answer).toContain('Bartender at Riverside Hall');
  expect(result.answer).toContain('Checking unfilled shifts');
  await shot(ceo, 'chat-answer-1440-light');
  conversationIdA = (await (await apiGet(ceoCtx.request, '/ai/conversations')).json()).data[0].id;
  step('ceo-unfilled-weekend-question', { eventTypes: types, eventCount: result.events.length, answer: done.content, streamUrlQuery: new URL(result.url).search.replace(/[0-9a-f-]{36}/, '<turnId>') });
});

test('3. the payroll comparison answers with aggregate totals for the CEO (payroll.view)', async () => {
  const result = await askInChat(ceo, 'How does this payroll period compare with the previous one?');
  const done = result.events[result.events.length - 1]!.data as { status: string; content: string };
  expect(result.events.find((e) => e.data.type === 'tool')?.data).toMatchObject({ name: 'compare_payroll_runs' });
  expect(done.status).toBe('completed');
  expect(done.content).toMatch(/Payroll run .*gross £150(\.00)? vs £120(\.00)?/);
  expect(done.content).not.toMatch(/rate|NI|bank|payslip/i);
  step('ceo-payroll-comparison', { answer: done.content });
});

test('4. the history reopens the conversation from the server; mobile and dark screenshots', async () => {
  await goto(ceo, '/chat'); // a reload: the open conversation is per-tab state, the history is on the server
  const history = ceo.getByRole('navigation', { name: 'AI conversations' });
  await expect(history.getByRole('button', { name: firstConversationTitle, exact: true })).toBeVisible();
  await history.getByRole('button', { name: firstConversationTitle, exact: true }).click();
  await expect(ceo.getByRole('article', { name: 'Your question' })).toHaveCount(2);
  await expect(ceo.getByRole('article', { name: 'Assistant answer' }).first()).toContainText('Bartender at Riverside Hall');
  await expect(ceo.getByRole('article', { name: 'Assistant answer' }).nth(1)).toContainText('Payroll run');
  await shot(ceo, 'chat-history-1440-light');
  await ceo.emulateMedia({ colorScheme: 'dark' });
  await shot(ceo, 'chat-history-1440-dark');
  await ceo.setViewportSize({ width: 390, height: 844 });
  await ceo.waitForTimeout(400);
  await shot(ceo, 'chat-history-390-dark');
  await ceo.emulateMedia({ colorScheme: 'light' });
  await shot(ceo, 'chat-history-390-light');
  await ceo.setViewportSize({ width: 1440, height: 900 });
  // The Ask AI side panel on a workspace page (the existing entry point).
  await ceo.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'Home' }).click();
  await ceo.getByRole('button', { name: 'Ask AI' }).click();
  await expect(ceo.getByRole('complementary', { name: 'Ask AI' })).toBeVisible();
  await ceo.waitForTimeout(400);
  await shot(ceo, 'ask-ai-panel-1440-light');
  await ceo.getByRole('button', { name: 'Close Ask AI' }).click();
  step('history-reopened', { questions: 2, answers: 2 });
});

test('5. organisation B never sees A’s data; B cannot open A’s conversation', async () => {
  const bCtx = await browser.newContext({ baseURL: WEB });
  await apiLogin(bCtx.request, ids.ceoB);
  const foreign = await apiGet(bCtx.request, `/ai/conversations/${conversationIdA}`);
  expect(foreign.status()).toBe(404);
  const list = await (await apiGet(bCtx.request, '/ai/conversations')).json();
  expect(JSON.stringify(list)).not.toContain(conversationIdA);
  const stream = await apiGet(bCtx.request, `/ai/conversations/${conversationIdA}/stream?turnId=${conversationIdA}`);
  expect(stream.status()).toBe(404);
  step('org-b-isolation', { foreignConversation: foreign.status(), foreignStream: stream.status(), listContainsA: false });
  await bCtx.close();
});

test('6. A’s Initial Manager without payroll.view is refused the payroll comparison (the tool is never offered)', async () => {
  const imCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: WEB });
  await imCtx.addInitScript(TEE_SSE);
  const im = await imCtx.newPage();
  await uiLogin(im, ids.imA);
  await goto(im, '/chat');
  const result = await askInChat(im, 'How does this payroll period compare with the previous one?');
  const done = result.events[result.events.length - 1]!.data as { status: string; content: string };
  expect(result.events.some((e) => e.data.type === 'tool')).toBe(false);
  expect(done.content).toBe('I cannot access that information with your current permissions.');
  expect(done.content).not.toMatch(/£/);
  await shot(im, 'chat-payroll-not-permitted-1440-light');
  step('initial-manager-payroll-refused', { answer: done.content, toolEvents: 0 });
  await imCtx.close();
});

test('7. Admin Health shows the AI usage (counts only); Config and Security show the AI sections', async () => {
  await admin.getByRole('tab', { name: 'Health' }).click();
  const section = admin.getByRole('region', { name: 'AI assistant health' });
  await expect(section).toBeVisible();
  await expect(section.getByText('Enabled').first()).toBeVisible();
  const row = section.getByRole('row').filter({ hasText: ids.orgA.name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const cells = await row.getByRole('cell').allInnerTexts();
  const turns = Number(cells[2]!.replace(/,/g, ''));
  expect(turns).toBeGreaterThanOrEqual(2);
  expect(await section.innerText()).not.toMatch(/Riverside|Bartender|still need staff/);
  await expect(admin.getByRole('group', { name: 'Queues' }).getByRole('button', { name: /rab-ai/ })).toBeVisible();
  await sectionShot(admin, 'AI assistant health', 'admin-health-ai-1440');
  await admin.getByRole('group', { name: 'Queues' }).getByRole('button', { name: /rab-ai/ }).click();
  await expect(admin.getByText(/rab-ai: AI turns run once by design/)).toBeVisible();
  await expect(admin.getByText('Loading chart…')).toHaveCount(0, { timeout: 15_000 });
  await sectionShot(admin, 'Worker queues', 'admin-health-rab-ai-queue-1440');
  await admin.getByRole('tab', { name: 'Config' }).click();
  await expect(admin.getByRole('region', { name: 'AI configuration' }).getByText('crewflow-mock-1')).toBeVisible();
  await sectionShot(admin, 'AI configuration', 'admin-config-ai-1440');
  await admin.getByRole('tab', { name: 'Security' }).click();
  await expect(admin.getByRole('region', { name: 'AI privacy' }).getByText('Prompt and answer telemetry')).toBeVisible();
  await sectionShot(admin, 'AI privacy', 'admin-security-ai-1440');
  await admin.emulateMedia({ colorScheme: 'dark' });
  await admin.getByRole('tab', { name: 'Health' }).click();
  await sectionShot(admin, 'AI assistant health', 'admin-health-ai-1440-dark');
  await admin.emulateMedia({ colorScheme: 'light' });
  step('admin-health-usage', { orgARowCells: cells });
});

test('8. turning A’s switch OFF blocks further use in the open chat, and the AI chrome disappears', async () => {
  await goto(ceo, '/chat');
  // The CEO has the earlier conversation open (so the next question goes to POST …/messages of that conversation).
  await ceo.getByRole('navigation', { name: 'AI conversations' }).getByRole('button', { name: firstConversationTitle, exact: true }).click();
  await expect(ceo.getByRole('article', { name: 'Assistant answer' }).first()).toContainText('Bartender at Riverside Hall');
  await admin.getByRole('tab', { name: 'General' }).click();
  await admin.getByRole('group', { name: 'Look up type' }).getByRole('button', { name: 'Organisation' }).click();
  await admin.getByRole('searchbox', { name: 'Search' }).fill(ids.orgA.slug);
  await admin.getByRole('button', { name: 'Search', exact: true }).click();
  await admin.getByRole('button', { name: `Show ${ids.orgA.name}` }).click();
  const toggle = admin.getByRole('checkbox', { name: `AI assistant for ${ids.orgA.name}` });
  await expect(toggle).toBeChecked();
  await toggle.click({ force: true });
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Reason (saved to the audit log)').fill('E2E: pilot finished');
  await dialog.getByLabel('Your password').fill(ids.admin.password); // the step-up window may have passed since step 1
  await dialog.getByRole('button', { name: 'Turn off AI' }).click();
  await expect(admin.getByText(`AI assistant is off for ${ids.orgA.name}`)).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // The CEO's open chat: the next question is refused (404 AI_NOT_AVAILABLE) and the page shows the disabled state.
  const composer = ceo.getByRole('textbox', { name: 'Message Crewflow AI' });
  await composer.fill('What is our fill rate this week?');
  const refused = ceo.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/conversations(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname), { timeout: 30_000 });
  await ceo.getByRole('button', { name: 'Send message' }).click();
  const res = await refused;
  expect(res.status()).toBe(404);
  expect((await res.json()).code).toBe('AI_NOT_AVAILABLE');
  await expect(ceo.getByText('The AI assistant is off for your organisation')).toBeVisible();
  await expect(ceo.getByRole('textbox', { name: 'Message Crewflow AI' })).toHaveCount(0);
  await shot(ceo, 'chat-disabled-1440-light');
  await goto(ceo, '/');
  await expect(ceo.getByRole('button', { name: 'Workspace menu' })).toBeVisible();
  await expect(ceo.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  await expect(ceo.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'AI' })).toHaveCount(0);
  expect((await apiGet(ceoCtx.request, '/ai/conversations')).status()).toBe(404);
  // Erasing one's own data never depends on the switch.
  const del = await ceoCtx.request.delete(`${API}/ai/conversations/${conversationIdA}`, { headers: { Origin: WEB, 'X-Application-Target': 'manager_web' } });
  expect(del.status()).toBe(204);
  step('switch-off-blocks-use', { submitStatus: res.status(), code: 'AI_NOT_AVAILABLE', askAiButtons: 0, deleteWhileOff: del.status() });
});
