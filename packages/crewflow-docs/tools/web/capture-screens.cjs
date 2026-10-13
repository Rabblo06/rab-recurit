#!/usr/bin/env node
// Captures documentation screenshots of the REAL Crewflow web console (Vite dev server on
// :5173) with every API response answered by the synthetic fixture backend in fixtures.cjs.
//
//   node packages/crewflow-docs/tools/web/capture-screens.cjs            # everything
//   node packages/crewflow-docs/tools/web/capture-screens.cjs offers     # only jobs whose area/name contains "offers"
//
// Output: packages/crewflow-docs/images/web/<area>/<name>.png (1440×900 viewport, 2× DPR).
'use strict';

const { launch, openPage, settle, go, expandFor, shot, crop, unionBox, holdDetailHandOff, drawer } = require('./common.cjs');
const { generatedPng } = require('./fixtures.cjs');

const fld = (label, tag = 'input', scope = drawer) => `${scope} .field:has(> label:text-is("${label}")) ${tag}`;
const ddmmyyyy = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const ymd = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toLocaleDateString('sv-SE'); };
const STRONG_PASSWORD = 'Harbour-Lantern-42';

const jobs = [];
const job = (area, names, opts, run) => jobs.push({ area, names: [].concat(names), opts, run });

// ─── auth ─────────────────────────────────────────────────────────────────────────────────
job('auth', ['login-welcome', 'login-password'], { persona: 'anon' }, async (page) => {
  await go(page, '/login');
  await shot(page, 'auth', 'login-welcome');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.locator('#email').fill('jordan.hale@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#password').fill(STRONG_PASSWORD);
  await settle(page, 600);
  await shot(page, 'auth', 'login-password');
});
job('auth', ['forgot-password', 'forgot-password-sent'], { persona: 'anon' }, async (page) => {
  await go(page, '/forgot-password');
  await page.locator('#email').fill('jordan.hale@example.test');
  await settle(page, 400);
  await shot(page, 'auth', 'forgot-password');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await page.getByText('Check your inbox').waitFor();
  await settle(page, 600);
  await shot(page, 'auth', 'forgot-password-sent');
});
job('auth', ['activate-account'], { persona: 'anon' }, async (page) => {
  await go(page, '/activate-account?token=docs-example-token');
  await page.locator('#password').fill(STRONG_PASSWORD);
  await page.locator('#confirm').fill(STRONG_PASSWORD);
  await settle(page, 500);
  await shot(page, 'auth', 'activate-account');
});
job('auth', ['reset-password'], { persona: 'anon' }, async (page) => {
  await go(page, '/reset-password?token=docs-example-token');
  const inputs = page.locator('input[type=password]');
  await inputs.nth(0).fill(STRONG_PASSWORD);
  await inputs.nth(1).fill(STRONG_PASSWORD);
  await settle(page, 500);
  await shot(page, 'auth', 'reset-password');
});

// ─── getting started (new Manager onboarding) ─────────────────────────────────────────────
job('getting-started', ['create-workspace', 'create-profile', 'preparing-workspace', 'welcome-overlay'], { persona: 'newManager', reducedMotion: 'no-preference' }, async (page, { browser }) => {
  await go(page, '/');
  await page.waitForURL('**/onboarding/workspace');
  await page.locator('input[type=file]').setInputFiles({ name: 'northwind-logo.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'logo') });
  await page.locator('#ws-name').fill('Northwind Staffing');
  await page.getByText('is available').waitFor();
  await page.locator('#ws-subdomain').fill('northwind');
  await page.getByText('✓ northwind is available').waitFor();
  await settle(page, 800);
  await shot(page, 'getting-started', 'create-workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL('**/onboarding/profile');
  await page.locator('input[type=file]').setInputFiles({ name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'avatar', 'jordan') });
  await page.locator('#p-first').fill('Jordan');
  await page.locator('#p-last').fill('Hale');
  await page.locator('#p-title').fill('Operations manager');
  await settle(page, 800);
  await shot(page, 'getting-started', 'create-profile');
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await page.waitForURL('**/onboarding/preparing');
  await page.locator('.preparation-step[data-state="current"]', { hasText: 'Getting everything in place' }).waitFor({ timeout: 6000 });
  await page.waitForTimeout(900);
  await shot(page, 'getting-started', 'preparing-workspace');
  await page.locator('.welcome-overlay h1').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, 'getting-started', 'welcome-overlay');
});

// ─── dashboard ────────────────────────────────────────────────────────────────────────────
job('dashboard', ['dashboard'], {}, async (page) => { await go(page, '/'); await shot(page, 'dashboard', 'dashboard'); });
job('dashboard', ['dashboard-dark'], { theme: 'dark' }, async (page) => { await go(page, '/'); await shot(page, 'dashboard', 'dashboard-dark'); });

// ─── staff ────────────────────────────────────────────────────────────────────────────────
job('staff', ['users-staff-list', 'staff-row-actions'], {}, async (page) => {
  await go(page, '/users');
  await shot(page, 'staff', 'users-staff-list');
  const row = page.locator('tr', { hasText: 'Alex Morgan' });
  await row.hover();
  await row.locator('button[title="Reset password"]').hover();
  await page.waitForTimeout(500);
  const box = await row.boundingBox();
  await crop(page, 'staff', 'staff-row-actions', { x: box.x, y: box.y - 46, width: box.width, height: box.height + 46 + 60 }, 16);
});
job('staff', ['users-managers-list'], { persona: 'ceo' }, async (page) => {
  await go(page, '/users');
  await page.locator('button.tab-link', { hasText: 'Managers' }).click();
  await settle(page);
  await shot(page, 'staff', 'users-managers-list');
});
job('staff', ['create-staff-step1', 'create-staff-step2', 'create-staff-step3', 'create-staff-step4', 'create-staff-success'], {}, async (page, { browser }) => {
  await go(page, '/users');
  await page.getByRole('button', { name: 'New staff' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} input[type=file]`).setInputFiles({ name: 'rowan.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'avatar', 'rowan') });
  await page.locator(fld('First name *')).fill('Rowan');
  await page.locator(fld('Last name *')).fill('Price');
  await page.locator(fld('Preferred name')).fill('Ro');
  await page.locator(fld('Date of birth')).fill('14/03/1996');
  await page.locator(`${drawer} .wizard-step-title`).click();
  await page.locator(fld('Job role', 'select')).selectOption({ label: 'Bartender' });
  await page.locator(fld('Employment type', 'select')).selectOption('Part-time');
  await page.locator(fld('Start date')).fill(ddmmyyyy(7));
  await page.locator(`${drawer} .wizard-step-title`).click();
  await page.locator(fld('Default rate (£/hr)')).fill('14.50');
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 500);
  await crop(page, 'staff', 'create-staff-step1', drawer);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator(fld('Email *')).fill('rowan.price@example.test');
  await page.locator(`${drawer} input.PhoneInputInput`).fill('07700 900345');
  await page.locator(fld('Address')).fill('31 Example Road');
  await page.locator(fld('City')).fill('Bristol');
  await page.locator(fld('Postcode')).fill('EX4 4DD');
  await page.locator(`${drawer} .wizard-step-title`).click();
  await settle(page, 400);
  await crop(page, 'staff', 'create-staff-step2', drawer);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator(fld('Full name *')).fill('Charlie Price');
  await page.locator(fld('Relationship *')).fill('Sister');
  await page.locator(`${drawer} input.PhoneInputInput`).fill('07700 900388');
  await settle(page, 400);
  await crop(page, 'staff', 'create-staff-step3', drawer);
  await page.getByRole('button', { name: 'Next' }).click();
  for (const d of ['Mon', 'Wed', 'Fri', 'Sat']) await page.locator(`${drawer} label.weekday-picker-option`, { hasText: d }).click();
  await page.locator(fld('Preferred shift times', 'select')).selectOption('Evening');
  await page.locator(fld('Maximum hours per week')).fill('30');
  await settle(page, 400);
  await crop(page, 'staff', 'create-staff-step4', drawer);
  await holdDetailHandOff(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Account created. An invitation email has been queued').waitFor();
  await settle(page, 500);
  await crop(page, 'staff', 'create-staff-success', await unionBox(page, [`${drawer} .drawer-header`, `${drawer} .drawer-body > div`]));
});
job('staff', ['staff-detail-panel', 'staff-detail-timeline'], {}, async (page) => {
  await go(page, '/users');
  await page.locator('button.record-chip', { hasText: 'Alex Morgan' }).click();
  await page.locator(`${drawer} .detail-tabs`).waitFor();
  await expandFor(page, `${drawer} .detail-panel-body`, 1300);
  await settle(page, 600);
  await crop(page, 'staff', 'staff-detail-panel', drawer);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('button.detail-tab', { hasText: 'Timeline' }).click();
  await settle(page, 600);
  await crop(page, 'staff', 'staff-detail-timeline', drawer);
});
job('staff', ['bulk-email-panel'], {}, async (page) => {
  await go(page, '/users');
  for (const n of ['Alex Morgan', 'Priya Shah', 'Daniel Okafor']) await page.getByLabel(`Select ${n}`).check();
  await page.locator('.list-toolbar-actions button', { hasText: 'Send Email' }).click();
  await page.locator(`${drawer} textarea`).waitFor();
  await page.locator(fld('Subject')).fill('Rota for the week ahead');
  await page.locator(fld('Message', 'textarea')).fill('Hi all,\n\nNext week\'s rota is now live in the Crewflow app. Please accept or decline your offers by Thursday.\n\nThanks,\nJordan');
  await settle(page, 500);
  await shot(page, 'staff', 'bulk-email-panel');
});
job('staff', ['new-manager-form'], { persona: 'ceo' }, async (page) => {
  await go(page, '/users');
  await page.locator('button.tab-link', { hasText: 'Managers' }).click();
  await settle(page, 600);
  await page.getByRole('button', { name: 'New manager' }).click();
  await page.locator(fld('First name *')).fill('Jesse');
  await page.locator(fld('Last name *')).fill('Clarke');
  await page.locator(fld('Manager type', 'select')).selectOption('venue');
  await page.locator(fld('Job title')).fill('Venue supervisor');
  await page.locator(fld('Select Venue *', 'select')).selectOption({ label: 'Riverside House' });
  await page.locator(fld('Email *')).fill('jesse.clarke@example.test');
  await page.locator(`${drawer} input.PhoneInputInput`).fill('07700 900412');
  await page.locator(`${drawer} .detail-fields-title`).click();
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 500);
  await crop(page, 'staff', 'new-manager-form', drawer);
});

// ─── venues ───────────────────────────────────────────────────────────────────────────────
job('venues', ['venues-list'], {}, async (page) => { await go(page, '/venues'); await shot(page, 'venues', 'venues-list'); });
job('venues', ['create-venue-drawer'], {}, async (page) => {
  await go(page, '/venues');
  await page.getByRole('button', { name: 'New venue' }).click();
  await page.locator(fld('Venue name')).fill('Lakeside Pavilion');
  await page.locator(fld('Client name')).fill('Lakeside Leisure Ltd');
  await page.locator(fld('Type', 'select')).selectOption('event');
  await page.locator(fld('Address')).fill('5 Example Parade');
  await page.locator(fld('City')).fill('Leeds');
  await page.locator(fld('Postcode')).fill('LS1 9XX');
  await page.locator(fld('Note', 'textarea')).fill('Use the service entrance on the lake side. Sign in with security.');
  await page.locator('#venue-lat').fill('53.7965');
  await page.locator('#venue-lng').fill('-1.5478');
  await page.locator('#venue-radius').fill('150');
  await page.locator(`${drawer} input[role=switch]`).check();
  await page.locator(fld('Default break minutes')).fill('30');
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 500);
  await crop(page, 'venues', 'create-venue-drawer', drawer);
});
job('venues', ['venue-role-rates'], {}, async (page) => {
  await go(page, '/venues');
  await page.locator('tr', { hasText: 'The Grand Hall' }).locator('button[title="Edit"]').click();
  await page.getByText('+ Add another role rate').waitFor();
  await page.locator(fld('Role', 'select')).selectOption({ label: 'Chef de partie' });
  await page.locator(fld('Hourly rate (£)')).fill('17.50');
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 600);
  await crop(page, 'venues', 'venue-role-rates', drawer);
});

// ─── shifts ───────────────────────────────────────────────────────────────────────────────
async function fillNewShift(page) {
  await page.getByRole('button', { name: 'New shift' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} .field:has(> label:text-is("Venue")) button`).click();
  await page.locator('.dropdown-menu .dropdown-item', { hasText: 'Riverside House' }).click();
  await page.locator(`${drawer} .field:has(> label:text-is("Role")) button`).click();
  await page.locator('.dropdown-menu .dropdown-item', { hasText: 'Waiting staff' }).click();
  await page.locator(fld('Date')).fill(ymd(1));
  await page.locator(fld('Start time')).fill('12:00');
  await page.locator(fld('End time')).fill('18:00');
  await page.locator(fld('Break (minutes)')).fill('30');
  await page.locator(fld('Notes', 'textarea')).fill('Afternoon tea service. Black uniform.');
  for (const n of ['Alex Morgan', 'Priya Shah', 'Sam Reed']) await page.locator(`${drawer} .dropdown-item`, { hasText: n }).click();
}
job('shifts', ['shifts-list', 'shift-row-actions'], {}, async (page) => {
  await go(page, '/shifts');
  await shot(page, 'shifts', 'shifts-list');
  const row = page.locator('tr', { hasText: 'Bartender' }).filter({ hasText: 'offered' }).first();
  await row.hover();
  await row.locator('button[title="Send offer"]').hover();
  await page.waitForTimeout(400);
  const box = await row.boundingBox();
  await crop(page, 'shifts', 'shift-row-actions', { x: box.x, y: box.y - 46, width: box.width, height: box.height + 46 + 60 }, 16);
});
job('shifts', ['new-shift-drawer', 'new-shift-result'], {}, async (page) => {
  await go(page, '/shifts');
  await fillNewShift(page);
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 500);
  await crop(page, 'shifts', 'new-shift-drawer', drawer);
  await page.getByRole('button', { name: /Send Offer/ }).click();
  await page.getByText(/Shift created ✓/).waitFor();
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 500);
  await crop(page, 'shifts', 'new-shift-result', drawer);
});
job('shifts', ['send-offers-drawer'], {}, async (page) => {
  await go(page, '/shifts');
  await page.locator('tr', { hasText: 'Waiting staff' }).filter({ hasText: 'partially filled' }).first().locator('button[title="Send offer"]').click();
  for (const n of ['Isla Moore', 'Grace Kim']) await page.locator(`${drawer} .dropdown-item`, { hasText: n }).click();
  await settle(page, 500);
  await crop(page, 'shifts', 'send-offers-drawer', drawer);
});
job('shifts', ['cancel-shift-drawer'], {}, async (page) => {
  await go(page, '/shifts');
  await page.locator('tr', { hasText: 'Chef de partie' }).filter({ hasText: 'offered' }).first().locator('button[title="Cancel shift"]').click();
  await page.locator(`${drawer} textarea`).fill('Harbour Kitchen has closed for a private refurbishment.');
  await settle(page, 500);
  await crop(page, 'shifts', 'cancel-shift-drawer', drawer);
});

// ─── offers ───────────────────────────────────────────────────────────────────────────────
job('offers', ['offers-list'], {}, async (page) => { await go(page, '/offers'); await shot(page, 'offers', 'offers-list'); });
job('offers', ['offers-awaiting-confirmation', 'confirm-offer-drawer'], {}, async (page) => {
  await go(page, '/offers?status=staff_accepted');
  await shot(page, 'offers', 'offers-awaiting-confirmation');
  await page.locator('tr', { hasText: 'Priya Shah' }).locator('button[title="Confirm shift"]').click();
  await settle(page, 500);
  await crop(page, 'offers', 'confirm-offer-drawer', drawer);
});
job('offers', ['reject-offer-drawer'], {}, async (page) => {
  await go(page, '/offers?status=staff_accepted');
  await page.locator('tr', { hasText: 'Grace Kim' }).locator('button[title="Reject"]').click();
  await page.locator(`${drawer} textarea`).fill('Venue reduced headcount for this service.');
  await settle(page, 500);
  await crop(page, 'offers', 'reject-offer-drawer', drawer);
});
job('offers', ['batch-drawer'], {}, async (page) => {
  await go(page, '/offers');
  await page.locator('tr', { hasText: 'Daniel Okafor' }).filter({ hasText: 'Harbour Kitchen' }).locator('button[title^="View batch"]').click();
  await page.getByText('Recipients (').waitFor();
  await settle(page, 500);
  await crop(page, 'offers', 'batch-drawer', drawer);
});
job('offers', ['venue-offers-list', 'shift-approval-drawer', 'select-staff-page'], {}, async (page) => {
  await go(page, '/venue-offers');
  await shot(page, 'offers', 'venue-offers-list');
  await page.locator('tr', { hasText: 'Pending approval' }).first().click();
  await page.getByText('Selected staff').waitFor();
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 600);
  await crop(page, 'offers', 'shift-approval-drawer', drawer);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /^Select \d+ Staff$/ }).click();
  await page.locator('.staff-selection-page table').waitFor();
  for (const n of ['Leah Fischer', 'Isla Moore']) await page.locator('.staff-selection-page tr', { hasText: n }).click();
  await settle(page, 500);
  await shot(page, 'offers', 'select-staff-page');
});
job('offers', ['venue-pipeline'], {}, async (page) => {
  await go(page, '/venue-offers/vr-grand-live');
  await page.locator('.pipeline-board').waitFor();
  await expandFor(page, null, 1300);
  await settle(page, 800);
  await shot(page, 'offers', 'venue-pipeline');
});
job('offers', ['timesheet-report-drawer'], {}, async (page) => {
  await go(page, '/venue-offers/vr-harbour-done');
  await page.getByRole('button', { name: 'Timesheet Report' }).click();
  await page.locator(`${drawer} .pipeline-report-files`).waitFor();
  await expandFor(page, `${drawer} .drawer-body`);
  await settle(page, 600);
  await crop(page, 'offers', 'timesheet-report-drawer', await unionBox(page, [`${drawer} .drawer-header`, `${drawer} .pipeline-report-table`]));
});

// ─── calendar ─────────────────────────────────────────────────────────────────────────────
job('calendar', ['calendar-month', 'calendar-empty-day'], {}, async (page) => {
  await go(page, '/calendar');
  await expandFor(page, '.calendar-detail', 1300);
  await settle(page, 600);
  await shot(page, 'calendar', 'calendar-month');
  await page.setViewportSize({ width: 1440, height: 900 });
  const label = (() => { const d = new Date(); d.setDate(d.getDate() + 8); return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); })();
  await page.locator(`button.calendar-cell[aria-label^="${label}"]`).click();
  await settle(page, 600);
  await shot(page, 'calendar', 'calendar-empty-day');
});

// ─── payroll ──────────────────────────────────────────────────────────────────────────────
job('payroll', ['payroll-list', 'payroll-completed-tab'], {}, async (page) => {
  await go(page, '/payroll');
  await shot(page, 'payroll', 'payroll-list');
  await page.locator('button.tab-link', { hasText: 'Completed' }).click();
  await settle(page);
  await shot(page, 'payroll', 'payroll-completed-tab');
});

// ─── settings & shell ─────────────────────────────────────────────────────────────────────
for (const [name, route, persona] of [
  ['settings-profile', '/settings/profile', 'manager'],
  ['settings-experience', '/settings/experience', 'manager'],
  ['settings-account', '/settings/account', 'manager'],
  ['members-team', '/settings/workspace/members?tab=team', 'ceo'],
  ['members-roles', '/settings/workspace/members?tab=roles', 'ceo'],
  ['my-workspace-general', '/settings/my-workspace', 'manager'],
  ['my-workspace-domains', '/settings/my-workspace/domains', 'manager'],
]) {
  job('settings', [name], { persona }, async (page) => {
    await go(page, route);
    await expandFor(page, null, 1500);
    await settle(page, 600);
    await shot(page, 'settings', name);
  });
}
job('settings', ['members-invite'], { persona: 'ceo' }, async (page) => {
  await go(page, '/settings/workspace/members?tab=invite');
  await page.locator('#member-email').fill('harper.wells@example.test');
  await page.locator('#member-role').selectOption('venue');
  await page.locator('#member-first').fill('Harper');
  await page.locator('#member-last').fill('Wells');
  await expandFor(page, null, 1500);
  await settle(page, 600);
  await shot(page, 'settings', 'members-invite');
});
job('settings', ['admin-panel-organisations'], { persona: 'platformAdmin' }, async (page) => {
  await go(page, '/settings/admin');
  await page.getByRole('button', { name: 'Organisations' }).click();
  await settle(page);
  await shot(page, 'settings', 'admin-panel-organisations');
});
job('settings', ['audit-log'], {}, async (page) => { await go(page, '/audit'); await shot(page, 'settings', 'audit-log'); });
job('settings', ['notifications-dropdown'], {}, async (page) => {
  await go(page, '/');
  await page.locator('button[aria-label="Notifications"]').click();
  await page.getByText('Mark all read').waitFor();
  await settle(page, 500);
  const menu = await page.locator('.dropdown-menu', { hasText: 'Mark all read' }).boundingBox();
  const bell = await page.locator('button[aria-label="Notifications"]').boundingBox();
  const x = Math.min(menu.x, bell.x); const y = Math.min(menu.y, bell.y);
  await crop(page, 'settings', 'notifications-dropdown', { x, y, width: Math.max(menu.x + menu.width, bell.x + bell.width) - x, height: Math.max(menu.y + menu.height, bell.y + bell.height) - y }, 24);
});
job('settings', ['command-palette'], {}, async (page) => {
  await go(page, '/');
  await page.keyboard.press('Control+K');
  await page.locator('.side-panel-dock').first().waitFor();
  await settle(page, 600);
  await shot(page, 'settings', 'command-palette');
});
job('settings', ['global-search'], {}, async (page) => {
  await go(page, '/');
  await page.keyboard.press('/');
  await page.locator('.side-panel-dock input').first().waitFor();
  await page.keyboard.type('Al', { delay: 80 });
  await page.locator('.search-result-type').first().waitFor();
  await settle(page, 600);
  await shot(page, 'settings', 'global-search');
});

// ─── runner ───────────────────────────────────────────────────────────────────────────────
(async () => {
  const filter = (process.argv[2] || '').toLowerCase();
  const selected = jobs.filter((j) => !filter || j.area.includes(filter) || j.names.some((n) => n.includes(filter)));
  const browser = await launch();
  const report = [];
  for (const j of selected) {
    const { context, page, errors, fx } = await openPage(browser, j.opts);
    const started = Date.now();
    let failure = null;
    try { await j.run(page, { browser }); } catch (err) { failure = err.message.split('\n')[0]; }
    report.push({ area: j.area, shots: j.names, ok: !failure && errors.length === 0, failure, pageErrors: errors, unhandled: fx.unhandled, ms: Date.now() - started });
    process.stdout.write(`${failure ? '✗' : '✓'} ${j.area}/${j.names.join(', ')}${failure ? ` — ${failure}` : ''}${errors.length ? ` [pageerror: ${errors.join(' | ')}]` : ''}${fx.unhandled.length ? ` [unhandled: ${fx.unhandled.join(', ')}]` : ''}\n`);
    await context.close();
  }
  await browser.close();
  const failed = report.filter((r) => !r.ok);
  console.log(`\n${report.length - failed.length}/${report.length} jobs succeeded.`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
