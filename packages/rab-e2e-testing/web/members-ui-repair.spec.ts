import { test, expect, type Page } from '@playwright/test';

// The real React app and router, with deterministic browser-local API fixtures. No live accounts or database writes.
const base = '/settings/workspace/members';
const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Test', lastName: 'Owner',
  email: 'owner@example.test', roles: ['ceo'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const role = {
  id: 'role-1', key: 'custom_supervisor', name: 'Supervisor', description: 'Coordinates the team.', icon: 'shield',
  isMemberRole: true, isSystem: false, assignableToMembers: true, readAllObjects: false,
  objects: [], permissionKeys: ['staff.view'], updatedAt: '2026-10-15T09:00:00Z', assignedUserCount: 1,
};
const metadata = {
  icons: ['shield', 'users', 'star'],
  objects: [{ key: 'staff', label: 'Staff', labelPlural: 'Staff', icon: 'users', description: 'Recruitment staff.',
    actions: { read: true, update: false, softDelete: false, destroy: false }, unsupportedReason: 'Read-only access.', grantable: true,
    fields: [{ key: 'name', label: 'Name', dataType: 'text', locked: true, defaultVisible: true, sensitive: false, grantable: true, filter: null }],
  }],
};
const grants = {
  // Organisation isolation (2026-10-15): a platform admin's Initial Manager Add is their OWN organisation — no 'select' scope.
  platform: { canCreateOrganisation: true, initialManagerScope: 'own' },
  ceo: { canCreateOrganisation: false, initialManagerScope: 'own' },
  manager: { canCreateOrganisation: false, initialManagerScope: 'none' },
};
type Kind = keyof typeof grants | 'missing' | 'malformed' | 'failed';
async function fixtures(page: Page, kind: Kind = 'ceo') {
  const state = {
    roles: [{ ...role }], calls: [] as Array<{ path: string; method: string; body: any }>,
    save: 'ok' as 'ok' | 'fail' | 'incomplete', releaseSave: undefined as undefined | (() => void), holdSave: false,
    invitations: [] as any[], organisation: { id: 'org-1', name: 'Example Agency', slug: 'example', initialManager: null, ceo: null },
  };
  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/rest/v1', '');
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.includes('realtime')) return route.abort();
    if (path === '/auth/me') return send({ ...identity, roles: kind === 'platform' ? [] : [kind === 'manager' ? 'manager' : 'ceo'], isPlatformAdmin: kind === 'platform' });
    if (path === '/leadership/capabilities') return send(kind === 'missing' || kind === 'failed' ? {} : {
      'staff.view': true, leadership: kind === 'malformed' ? { canCreateOrganisation: 'true' } : grants[kind],
    }, kind === 'failed' ? 503 : 200);
    if (path === '/manager-workspaces/me') return send({ id: 'workspace-1', name: 'Example Workspace', status: 'active', subdomain: 'example', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (path === '/roles/object-metadata') return send(metadata);
    if (path.endsWith('/definition')) return send(state.roles.find((item) => path.includes(item.id)) ?? {}, 200);
    if (path === '/roles' && method === 'GET') return send(state.roles);
    if ((path === '/roles' && method === 'POST') || (path.startsWith('/roles/') && method === 'PUT')) {
      if (state.holdSave) await new Promise<void>((resolve) => { state.releaseSave = resolve; });
      if (state.save === 'fail') return send({ message: 'This role name is already in use.' }, 409);
      if (state.save === 'incomplete') return send({ id: 'role-1', name: body.name });
      const saved = { ...role, ...body, id: method === 'POST' ? 'role-new' : 'role-1' };
      state.roles = method === 'POST' ? [...state.roles, saved] : state.roles.map((item) => item.id === saved.id ? saved : item);
      return send(saved);
    }
    if (path === '/member-invitations/assignable-roles') return send(state.roles.filter((item) => item.assignableToMembers));
    if (path === '/member-invitations' && method === 'POST') {
      state.invitations = body.emails.map((email: string, i: number) => ({ id: `inv-${i}`, email, role: state.roles.find((item) => item.id === body.roleId), status: 'queued', sendCount: 1, maxSends: 3, expiresAt: '2099-01-01T00:00:00Z' }));
      return send({ results: body.emails.map((email: string) => ({ email, outcome: 'invited' })) });
    }
    if (path === '/member-invitations') return send({ data: state.invitations, total: state.invitations.length });
    if (path.startsWith('/member-invitations/')) {
      if (path.endsWith('/revoke')) state.invitations = [];
      return send({});
    }
    if (path === '/members') return send({ data: [{ userId: 'member-1', firstName: 'Example', lastName: 'Member', email: 'member@example.test', roles: [role], status: 'active', isOwner: false, isSelf: false }], total: 1 });
    if (path === '/admin/organisation-invitations' && method === 'POST') return send({ email: body.email, outcome: 'invited' });
    if (path.startsWith('/admin/organisation-invitations')) return send({ data: [], total: 0 });
    if (path === '/admin/organisations') return send([state.organisation]);
    if (path === '/admin/organisations/org-1') return send(state.organisation);
    if (path.includes('initial-manager-invite')) return send({});
    if (path === '/managers') return send({ data: [], total: 0 });
    if (path === '/profile') return send({ ...identity, avatarKey: null });
    if (path === '/profile/preferences') return send({ theme: 'light' });
    if (path === '/notifications/unread-count') return send({ count: 0 });
    if (path === '/notifications' || path === '/job-roles') return send([]);
    if (path === '/auth/config') return send({ authProviders: { password: true } });
    return send({ data: [], total: 0 });
  });
  return state;
}

const tab = (page: Page, label: string) => page.getByRole('navigation', { name: 'Members sections' }).getByRole('button', { name: label, exact: true });
async function rename(page: Page, value: string) {
  await page.getByRole('button', { name: /Click to rename/ }).click();
  const input = page.getByRole('textbox', { name: 'Role name' });
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press('Enter');
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport, reducedMotion: 'reduce' });
    test('Team, compact Invite, Roles and editor have one surface and responsive controls', async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const state = await fixtures(page);
      await page.goto(`${base}?tab=team`);
      await expect(page.getByRole('table')).toHaveCount(1);
      await expect(page.getByRole('row').filter({ hasText: 'Example Member' })).toHaveCount(1);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('team.png'), fullPage: true });
      // 2ddda9fa (owner correction 2026-10-23): the Members tabs are Team | Add | Roles — the former Invite tab is Add.
      await tab(page, 'Add').click();
      await expect(page.getByLabel('Invite or add')).toHaveValue('invite');
      await expect(page.getByRole('heading', { name: 'Pending invitations' })).toBeVisible();
      await expect(page.getByLabel('Email address')).toBeVisible();
      await expect(page.getByLabel('Workspace role')).toBeVisible();
      await noOverflow(page);
      if (viewport.width === 390) expect((await page.getByLabel('Email address').boundingBox())!.x).toBeGreaterThanOrEqual(20);
      await page.screenshot({ path: info.outputPath('invite.png'), fullPage: true });
      await page.getByLabel('Invite or add').selectOption('add');
      // A CEO's single permitted leadership choice is shown fixed (read-only), not as a selector (2ddda9fa).
      await expect(page.getByLabel('Leadership role')).toHaveValue('Initial Manager');
      await expect(page.getByLabel('Leadership role')).toHaveAttribute('readonly', '');
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('add-own-initial-manager.png'), fullPage: true });
      await tab(page, 'Roles').click();
      await expect(page.locator('.role-card')).toHaveCount(1);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('roles.png'), fullPage: true });
      await page.locator('.role-card').click();
      const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(breadcrumb).toHaveCount(1);
      await expect(page.locator('.topbar').getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Workspace/Members/Roles/Supervisor');
      await expect(page.locator('.role-editor-topbar').getByRole('navigation')).toHaveCount(0);
      await expect(page.locator('.topbar-actions')).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Edit Records on All Objects (not available)' })).toBeDisabled();
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('role-permissions.png'), fullPage: true });
      await page.getByRole('navigation', { name: 'Role sections' }).getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByLabel('Description')).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('role-settings.png'), fullPage: true });
      await page.getByLabel('Name', { exact: true }).fill('A long role name that must stay readable without pushing header actions offscreen');
      state.save = 'fail';
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveCSS('color', 'rgb(198, 40, 40)');
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('role-error-long-name.png'), fullPage: true });
      expect(errors).toEqual([]);
    });

    test('Platform Add uses compact CEO and own-organisation Initial Manager forms (no organisation picker)', async ({ page }, info) => {
      const state = await fixtures(page, 'platform');
      await page.goto(`${base}?tab=add`);
      // A platform administrator with no workspace role has one permitted action, Add, so there is no Invite | Add
      // selector (2ddda9fa); Add opens on the email-only CEO invitation (owner correction, no organisation name field).
      await expect(page.getByLabel('Invite or add')).toHaveCount(0);
      await expect(page.getByLabel('Leadership role').locator('option')).toHaveText(['CEO (Organisation)', 'Initial Manager']);
      await expect(page.getByLabel('Leadership role')).toHaveValue('ceo');
      await expect(page.getByLabel('CEO email', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Organisation name', { exact: true })).toHaveCount(0);
      // An empty CEO invitation cannot be sent.
      await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Enter the CEO’s email address.');
      expect(state.calls.some((call) => call.path === '/admin/organisation-invitations' && call.method === 'POST')).toBe(false);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('add-ceo.png'), fullPage: true });
      await page.getByLabel('Leadership role').selectOption('initial-manager');
      await expect(page.getByLabel('Organisation', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('add-own-initial-manager.png'), fullPage: true });
      if (viewport.width === 390) {
        await page.getByRole('button', { name: 'Send Invitation', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('add-own-initial-manager-submit.png'), fullPage: true });
      }
    });
  });
}

test('save confirms first, refreshes list and cached assignable roles, and survives history/reload', async ({ page }, info) => {
  const state = await fixtures(page);
  await page.goto(`${base}?tab=add`);
  await expect(page.getByLabel('Workspace role')).toContainText('Supervisor');
  await tab(page, 'Roles').click();
  await page.locator('.role-card').click();
  await rename(page, 'Shift coordinator');
  state.holdSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(page).toHaveURL(/roles\/role-1$/);
  await expect.poll(() => !!state.releaseSave).toBe(true);
  state.releaseSave!();
  await expect(page).toHaveURL(`${base}?tab=roles`);
  await expect(page.locator('.role-card')).toHaveCount(1);
  await expect(page.locator('.role-card')).toContainText('Shift coordinator');
  await expect(tab(page, 'Roles')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.toast-success')).toBeVisible();
  await page.screenshot({ path: info.outputPath('saved-role.png'), fullPage: true });
  await tab(page, 'Add').click();
  await expect(page.getByLabel('Workspace role')).toContainText('Shift coordinator');
  await page.goBack();
  await expect(page).toHaveURL(`${base}?tab=roles`);
  await page.goForward();
  await expect(page).toHaveURL(`${base}?tab=add`);
  await page.reload();
  await expect(page.getByLabel('Workspace role')).toContainText('Shift coordinator');
  await tab(page, 'Roles').click();
  await page.locator('.role-card').click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shift coordinator');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('create, guarded Cancel, rejected save and incomplete HTTP 200 retain the right state', async ({ page }, info) => {
  const state = await fixtures(page);
  await page.goto(`${base}?tab=roles`);
  await page.getByRole('button', { name: '+ Create role' }).click();
  await rename(page, 'New coordinator');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(`${base}?tab=roles`);
  await expect(page.locator('.role-card')).toHaveCount(2);
  await page.locator('.role-card').filter({ hasText: 'Supervisor' }).click();
  await rename(page, 'Unsaved role');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unsaved role');
  for (const outcome of ['fail', 'incomplete'] as const) {
    state.save = outcome;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(outcome === 'fail' ? 'already in use' : 'did not return a complete saved role');
    await expect(page.getByRole('alert')).toHaveCSS('color', 'rgb(198, 40, 40)');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unsaved role');
    await expect(page).toHaveURL(/roles\/role-1$/);
    await page.screenshot({ path: info.outputPath(`save-${outcome}.png`), fullPage: true });
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(`${base}?tab=roles`);
  await expect(page.locator('.role-card').filter({ hasText: 'Unsaved role' })).toHaveCount(0);
});

for (const kind of ['manager', 'missing', 'malformed', 'failed'] as const) {
  test(`${kind} capability response cannot expose leadership Add, including a direct Add URL`, async ({ page }) => {
    const state = await fixtures(page, kind);
    await page.goto(`${base}?tab=add&mode=add`);
    await expect(page.getByRole('heading', { name: 'Invite your team' })).toBeVisible();
    await expect(page.getByLabel('Workspace role')).toContainText('Supervisor');
    await expect(page.getByLabel('Invite or add')).toHaveCount(0);
    await expect(page.getByLabel('Leadership role')).toHaveCount(0);
    await expect(page).toHaveURL(`${base}?tab=add`);
    expect(state.calls.some((call) => call.path.startsWith('/admin/organisations'))).toBe(false);
  });
}

test('Invite resets after tabs; explicit mode follows Back/Forward and reload; CEO scope is own only', async ({ page }) => {
  await fixtures(page);
  await page.goto(`${base}?tab=add`);
  await page.getByLabel('Invite or add').selectOption('add');
  // CEO scope is own only: Initial Manager is the single choice, shown fixed rather than as a selector (2ddda9fa).
  await expect(page.getByLabel('Leadership role')).toHaveValue('Initial Manager');
  await expect(page.getByLabel('Leadership role')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Leadership role').locator('option')).toHaveCount(0);
  await expect(page.getByLabel('Organisation', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Invite or add')).toHaveValue('invite');
  await page.goForward();
  await expect(page.getByLabel('Invite or add')).toHaveValue('add');
  await page.reload();
  await expect(page.getByLabel('Invite or add')).toHaveValue('add');
  await tab(page, 'Team').click();
  await tab(page, 'Add').click();
  await expect(page.getByLabel('Invite or add')).toHaveValue('invite');
  await expect(page).toHaveURL(`${base}?tab=add`);
});

test('custom role invitation, resend and revoke stay connected to the existing API', async ({ page }, info) => {
  const state = await fixtures(page);
  await page.goto(`${base}?tab=add`);
  await expect(page.getByLabel('Workspace role').locator('option')).toHaveText(['Supervisor']);
  await page.getByLabel('Email address').fill('invitee@example.test');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  // ca44a0f1 (unified toasts) replaced the inline .member-notice with a success toast; its icon carries the green ink.
  await expect(page.locator('.toast-success .toast-text')).toHaveText('1 invitation queued for delivery.');
  await expect(page.locator('.toast-success')).toHaveAttribute('role', 'status');
  await expect(page.locator('.toast-success .toast-icon')).toHaveCSS('color', 'rgb(24, 113, 59)');
  await expect(page.getByRole('row').filter({ hasText: 'invitee@example.test' })).toHaveCount(1);
  expect(state.calls.find((call) => call.path === '/member-invitations' && call.method === 'POST')?.body).toEqual({ emails: ['invitee@example.test'], roleId: 'role-1' });
  await page.screenshot({ path: info.outputPath('invitation-queued.png'), fullPage: true });
  // Toasts pause while hovered and can sit over the row actions; dismiss each outcome once it has been read.
  await page.locator('.toast-success').getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(page.locator('.toast-success')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resend invitation to invitee@example.test' }).click();
  await expect.poll(() => state.calls.some((call) => call.path === '/member-invitations/inv-0/resend')).toBe(true);
  await expect(page.locator('.toast-success .toast-text')).toHaveText('A new invitation link is queued for delivery. The previous link no longer works.');
  await page.locator('.toast-success').getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(page.locator('.toast-success')).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke invitation to invitee@example.test' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Revoke/ }).click();
  await expect(page.getByText('No invitations pending. Your next teammate is one invite away.')).toBeVisible();
});

test('owner correction: Add organisation takes the CEO email only and sends the invitation', async ({ page }) => {
  const state = await fixtures(page, 'platform');
  await page.goto(`${base}?tab=add&mode=add`);
  await expect(page.getByRole('heading', { name: 'Add organisation' })).toBeVisible();
  for (const label of ['Organisation name', 'CEO first name', 'CEO last name']) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await page.getByLabel('CEO email').fill('ceo@example.test');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect.poll(() => state.calls.find((call) => call.path === '/admin/organisation-invitations' && call.method === 'POST')?.body).toEqual({ email: 'ceo@example.test' });
  expect(state.calls.some((call) => call.path === '/admin/organisations' && call.method === 'POST')).toBe(false);
});

for (const kind of ['ceo', 'platform'] as const) {
  test(`${kind} Initial Manager form validates and submits the established endpoint`, async ({ page }) => {
    const state = await fixtures(page, kind);
    await page.goto(`${base}?tab=add&mode=add`);
    if (kind === 'platform') {
      await page.getByLabel('Leadership role').selectOption('initial-manager');
      await expect(page.getByLabel('Organisation', { exact: true })).toHaveCount(0);
    }
    const email = page.getByLabel('Email', { exact: true });
    await email.fill('invalid');
    await page.getByLabel('First name').fill('Example');
    await page.getByLabel('Last name').fill('Manager');
    await page.getByRole('button', { name: 'Send Invitation', exact: true }).click();
    expect(state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    await expect(email).toBeFocused();
    await email.fill('initial@example.test');
    await email.press('Enter');
    // Both actors use the same own-organisation endpoint; no organisation id is ever sent.
    const endpoint = '/managers/initial-manager-invite';
    await expect.poll(() => state.calls.find((call) => call.path === endpoint)?.body).toEqual({ email: 'initial@example.test', firstName: 'Example', lastName: 'Manager' });
    expect(state.calls.some((call) => call.path.startsWith('/admin/organisations/') && call.path.includes('initial-manager'))).toBe(false);
  });
}
