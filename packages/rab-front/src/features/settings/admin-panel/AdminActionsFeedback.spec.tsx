import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { TOAST_EVENT, type ToastDetail } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { renderWithQuery, routeGet, user } from './adminPanelTestKit';
import ConfigTab from './ConfigTab';
import OrganisationDetailDrawer from './OrganisationDetailDrawer';
import OrganisationResultCard from './OrganisationResultCard';
import PlatformAdminsTable from './PlatformAdminsTable';
import UserResultCard from './UserResultCard';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('./OrganisationDetailHost', () => ({ openOrganisationDetailDrawer: jest.fn() }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const del = api.delete as jest.Mock;

/**
 * Admin panel follow-up — the owner's feedback rule for every admin mutation (loading + no double submit, success only
 * after the server confirmed, a red toast with a plain message and a next action, the dialog keeps what was typed, field
 * errors under the field, announcements) and the new contracts (B3 `{reason}` + step-up, suspension without a password,
 * the drawer's CEO-invite resend with a reason).
 */
let toasts: ToastDetail[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);
beforeEach(() => {
  toasts = [];
  document.addEventListener(TOAST_EVENT, onToast);
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
afterEach(() => document.removeEventListener(TOAST_EVENT, onToast));

const axiosError = (status: number, data: Record<string, unknown>) => ({ isAxiosError: true, response: { status, data } });

describe('AdminActionDialog feedback', () => {
  const renderDialog = (onConfirm: jest.Mock) =>
    render(<AdminActionDialog title="Sign Sam out everywhere" confirmLabel="Sign out everywhere" failureText="Could not sign Sam out." onConfirm={onConfirm} onClose={jest.fn()} />);

  it('a server reason refusal is shown UNDER the reason field (aria-invalid + described); no toast; input kept', async () => {
    const onConfirm = jest.fn().mockRejectedValue(axiosError(400, { code: 'ADMIN_REASON_REQUIRED', message: 'Give a reason' }));
    renderDialog(onConfirm);
    const reason = screen.getByLabelText('Reason (saved to the audit log)') as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'Lost laptop' } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Give a reason of 3 to 500 characters/);
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-describedby')).toBe(alert.id);
    expect(reason.value).toBe('Lost laptop');
    expect((screen.getByLabelText('Your password') as HTMLInputElement).value).toBe('pw');
    expect(toasts).toEqual([]);
  });

  it('a rejected 2FA code is shown under the code field and only the code is cleared', async () => {
    const onConfirm = jest.fn().mockRejectedValue(axiosError(403, { code: 'STEP_UP_MFA_INVALID', message: 'x' }));
    renderDialog(onConfirm);
    fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Lost laptop' } });
    fireEvent.change(screen.getByLabelText('Your 2FA code (only if you use 2FA)'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/code didn’t work/);
    expect((screen.getByLabelText('Your 2FA code (only if you use 2FA)') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Reason (saved to the audit log)') as HTMLTextAreaElement).value).toBe('Lost laptop');
  });

  it('any other failure: a red toast with safe text (never the raw server message) + "Try again" that resubmits the SAME input; the dialog stays open', async () => {
    const onConfirm = jest.fn().mockRejectedValueOnce(axiosError(503, { message: 'QueryFailedError: relation "core.user" does not exist' })).mockResolvedValueOnce(undefined);
    renderDialog(onConfirm);
    fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: '  Lost laptop ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ variant: 'error' });
    expect(toasts[0]!.message).not.toMatch(/QueryFailedError|relation/);
    expect(toasts[0]!.action?.label).toBe('Try again');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toMatch(/QueryFailedError/);
    toasts[0]!.action!.onClick();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual(onConfirm.mock.calls[0][0]);
    expect(onConfirm.mock.calls[1][0]).toMatchObject({ reason: 'Lost laptop' });
  });

  it('while pending: "Please wait…", disabled, aria-busy, and a polite status announcement', async () => {
    let resolve!: () => void;
    renderDialog(jest.fn(() => new Promise<void>((r) => (resolve = r))));
    fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Lost laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect((await screen.findByRole('button', { name: 'Please wait…' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/please wait/i);
    expect(screen.getByRole('dialog').querySelector('form')!.getAttribute('aria-busy')).toBe('true');
    resolve();
  });
});

describe('B3 platform-admin grant / remove', () => {
  it('Remove: reason required; the typed password earns the step-up first, then DELETE { reason }; success only after the 200', async () => {
    del.mockResolvedValue({ data: { revoked: true } });
    post.mockResolvedValue({ data: { validUntil: 'x', mfa: false } });
    const admins = [
      { userId: 'me', firstName: 'Me', lastName: 'Admin', email: 'me@x.test', organisationName: 'A', twoFactorEnabled: true, grantedAt: '2026-10-01T00:00:00Z', grantedBy: null, isYou: true },
      { userId: 'u2', firstName: 'Sam', lastName: 'Lee', email: 'sam@x.test', organisationName: 'B', twoFactorEnabled: false, grantedAt: '2026-10-02T00:00:00Z', grantedBy: null, isYou: false },
    ];
    renderWithQuery(<PlatformAdminsTable admins={admins} loading={false} error={false} onAdd={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Give a reason/);
    expect(del).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Left the company' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/admin/platform-admins/u2', { data: { reason: 'Left the company' } }));
    expect(post).toHaveBeenCalledWith('/auth/step-up', { currentPassword: 'pw' });
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Platform admin removed' })]));
  });

  it('Remove refused by the server (LAST_PLATFORM_ADMIN): plain text, red toast, never a success toast, dialog keeps the reason', async () => {
    del.mockRejectedValue(axiosError(409, { code: 'LAST_PLATFORM_ADMIN', message: 'x' }));
    const admins = [
      { userId: 'me', firstName: 'Me', lastName: 'A', email: 'me@x.test', organisationName: 'A', twoFactorEnabled: true, grantedAt: '2026-10-01T00:00:00Z', grantedBy: null, isYou: true },
      { userId: 'u2', firstName: 'Sam', lastName: 'Lee', email: 'sam@x.test', organisationName: 'B', twoFactorEnabled: false, grantedAt: '2026-10-02T00:00:00Z', grantedBy: null, isYou: false },
    ];
    renderWithQuery(<PlatformAdminsTable admins={admins} loading={false} error={false} onAdd={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Left the company' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This is the last platform admin. Add another platform admin first.');
    expect(toasts.map((t) => t.variant)).toEqual(['error']);
    expect((within(dialog).getByLabelText('Reason (saved to the audit log)') as HTMLTextAreaElement).value).toBe('Left the company');
  });

  it('Make platform admin: POST { reason } (no password in the body); the toast reports the server’s real session count', async () => {
    routeGet(get, { [`/admin/users/${user().id}/summary`]: { ...user(), sessions: { total: 1, managerWeb: 1, venueManagerApp: 0, staffApp: 0 }, lastSignInProvider: 'password', failedSignIns24h: 0 } });
    post.mockResolvedValue({ data: { granted: true, revokedSessions: 2 } });
    renderWithQuery(<UserResultCard user={user() as never} meId="me" onReset={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make platform admin' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'New on-call engineer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add platform admin' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/admin/platform-admins/${user().id}`, { reason: 'New on-call engineer' }));
    expect(post).toHaveBeenCalledTimes(1); // no password typed → no step-up call (the shared StepUpHost asks if needed)
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Alex Morgan is now a platform admin. 2 sessions were ended.' })]));
  });
});

describe('organisation actions', () => {
  const org = { id: 'org-1', name: 'Example Agency Ltd', slug: 'example-agency', suspended: false, suspendedAt: null, createdAt: '2026-10-01T00:00:00Z', ceo: null };

  it('Suspend sends { reason, confirmSlug } (no inline password) and shows the CONFIRMED status', async () => {
    routeGet(get, {
      '/admin/lookup/organisations/org-1/summary': { ...org, members: { active: 3 }, workspaces: { total: 1, ready: 1, creating: 0, failed: 0 } },
      '/admin/organisations/org-1': { ceo: null },
    });
    post.mockResolvedValue({ data: { organisationId: 'org-1', suspended: true, suspendedAt: '2026-10-25T10:00:00Z' } });
    renderWithQuery(<OrganisationResultCard org={org} />);
    await screen.findByText('3 active');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type the organisation slug (example-agency) to confirm'), { target: { value: 'example-agency' } });
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Unpaid invoices' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend organisation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisations/org-1/suspend', { reason: 'Unpaid invoices', confirmSlug: 'example-agency' }));
    await waitFor(() => expect(toasts.some((t) => t.variant === 'success' && /is suspended/.test(t.message))).toBe(true));
  });

  it('the Members drawer: "Resend invitation" asks for a reason and sends it; the toast carries the real send number', async () => {
    routeGet(get, {
      '/admin/organisations/org-1': {
        id: 'org-1',
        name: 'Example Agency Ltd',
        slug: 'example-agency',
        suspended: false,
        createdAt: '2026-10-01T00:00:00Z',
        ceo: { id: 'c1', email: 'ceo@x.test', firstName: 'Chris', lastName: 'Doyle', accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1 } },
      },
    });
    post.mockResolvedValue({ data: { sendNumber: 2, expiresAt: '2026-10-27T00:00:00Z', queued: true } });
    renderWithQuery(<OrganisationDetailDrawer open organisationId="org-1" onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Resend invitation/ }));
    const dialog = screen.getByRole('dialog', { name: 'Resend the CEO invitation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resend invitation' }));
    expect(post).not.toHaveBeenCalled(); // no reason yet → field error, nothing sent
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'CEO lost the email' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resend invitation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisations/org-1/ceo-invite/resend', { reason: 'CEO lost the email' }));
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Invitation queued for delivery (send 2 of 3).' })]));
  });
});

describe('Config: test email', () => {
  it('a test email the server did not send is a failure: red toast, dialog stays open, never a success toast', async () => {
    routeGet(get, {
      '/admin/config': { maintenanceMode: { enabled: false, message: null } },
      '/admin/config/email': { driver: 'SMTP', fromAddress: 'noreply@x.test', replyToSet: false, deliveryEnabled: true, credential: 'set' },
      '/admin/config/environment': [],
    });
    post.mockResolvedValue({ data: { sent: false, to: 'me@x.test', driver: 'SMTP' } });
    renderWithQuery(<ConfigTab />);
    const open = await screen.findByRole('button', { name: 'Send test email to me' });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(toasts.map((t) => t.variant)).toEqual(['error']));
    expect(toasts[0]!.message).toMatch(/could not be sent/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
