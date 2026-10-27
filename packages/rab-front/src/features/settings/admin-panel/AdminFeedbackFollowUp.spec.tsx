import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { TOAST_EVENT, type ToastDetail } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { renderWithQuery, routeGet, user } from './adminPanelTestKit';
import OrganisationDetailDrawer from './OrganisationDetailDrawer';
import OrganisationSettingsSection, { SLUG_HINT, type OrganisationSettingsView } from './OrganisationSettingsSection';
import UserResultCard from './UserResultCard';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('./OrganisationDetailHost', () => ({ openOrganisationDetailDrawer: jest.fn() }));

/**
 * Feedback follow-up (FEEDBACK_REPORT §6, Admin panel items 2, 3, 7-11) on the real components. Owner rule: busy label +
 * synchronous duplicate guard, success only from the server's answer (and not held back by a refetch), field errors
 * under the field with focus, one announcement per error, "Sign in again" for an expired session, typed values kept.
 */
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;
const del = api.delete as jest.Mock;
const axiosError = (status: number, data: Record<string, unknown>) => ({ isAxiosError: true, response: { status, data } });

let toasts: ToastDetail[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);
beforeEach(() => {
  toasts = [];
  document.addEventListener(TOAST_EVENT, onToast);
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});
afterEach(() => document.removeEventListener(TOAST_EVENT, onToast));

describe('AdminActionDialog (item 2)', () => {
  const renderDialog = (onConfirm: jest.Mock) =>
    render(<AdminActionDialog title="Sign Sam out everywhere" confirmLabel="Sign out everywhere" failureText="Could not sign Sam out." onConfirm={onConfirm} onClose={jest.fn()} />);

  it('a server field refusal moves focus to that field (and links it); a client one already did', async () => {
    renderDialog(jest.fn().mockRejectedValue(axiosError(400, { code: 'ADMIN_REASON_REQUIRED', message: 'x' })));
    const reason = screen.getByLabelText('Reason (saved to the audit log)');
    fireEvent.change(reason, { target: { value: 'Lost laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const alert = await screen.findByRole('alert');
    expect(reason).toHaveAttribute('aria-describedby', alert.id);
    await waitFor(() => expect(reason).toHaveFocus());
  });

  it('an expired session (401) is ONE persistent "Sign in again" toast, no alert in the dialog; what was typed is kept', async () => {
    renderDialog(jest.fn().mockRejectedValue(axiosError(401, { message: 'Unauthorized' })));
    fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Lost laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ variant: 'error', persistent: true });
    expect(toasts[0]!.action?.label).toBe('Sign in again');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Reason (saved to the audit log)')).toHaveValue('Lost laptop');
  });

  it('after a general failure focus returns to the confirm button (it was disabled while busy)', async () => {
    renderDialog(jest.fn().mockRejectedValue(axiosError(409, { code: 'LAST_PLATFORM_ADMIN', message: 'x' })));
    fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Lost laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toHaveFocus());
  });
});

describe('slow success (item 3)', () => {
  it('Sign out everywhere: the success toast and the closed dialog come from the server answer, not after the card refetch', async () => {
    const summary = { ...user(), sessions: { total: 2, managerWeb: 2, venueManagerApp: 0, staffApp: 0 }, lastSignInProvider: 'password', failedSignIns24h: 0 };
    routeGet(get, { [`/admin/users/${user().id}/summary`]: summary });
    post.mockResolvedValue({ data: { revokedSessions: 2 } });
    renderWithQuery(<UserResultCard user={user() as never} meId="me" onReset={jest.fn()} />);
    await screen.findByText(/2 web · 2 sessions/);
    get.mockImplementation(() => new Promise(() => undefined)); // the refetch never answers
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Lost laptop' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'All sessions revoked (2).' })]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Members drawer: revoke the CEO invitation (item 11)', () => {
  it('a double click on "Revoke invitation" sends ONE request; "Revoking…" while it runs; success only after the server', async () => {
    routeGet(get, {
      '/admin/organisations/org-1': {
        id: 'org-1', name: 'Example Agency Ltd', slug: 'example-agency', suspended: false, createdAt: '2026-10-01T00:00:00Z',
        ceo: { id: 'c1', email: 'ceo@x.test', firstName: 'Chris', lastName: 'Doyle', accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1 } },
      },
    });
    let answer: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderWithQuery(<OrganisationDetailDrawer open organisationId="org-1" onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke invitation/ }));
    const confirm = screen.getAllByRole('button', { name: 'Revoke invitation' }).at(-1)!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByRole('button', { name: 'Revoking…' })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
    answer({ data: {} });
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Invitation revoked.' })]));
  });
});

describe('OrganisationSettingsSection (items 7-11)', () => {
  const base = '/admin/organisations/org-1/settings';
  const view = (over: Partial<OrganisationSettingsView['organisation']> = {}, google = false): OrganisationSettingsView => ({
    organisation: { id: 'org-1', name: 'Example Agency Ltd', slug: 'example-agency', logoKey: 'logos/org-1.png', timezone: 'Europe/London', ...over },
    authProviders: {
      password: { organisationEnabled: true, systemEnabled: true },
      google: { organisationEnabled: google, systemEnabled: true },
      microsoft: { organisationEnabled: false, systemEnabled: true },
    },
  });
  const mount = () => {
    routeGet(get, { [base]: view() });
    return renderWithQuery(<OrganisationSettingsSection organisationId="org-1" />);
  };

  it('item 7: a background change (a sign-in method saved) never wipes a name being edited; an untouched field follows the server', async () => {
    mount();
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Example Agency (renamed)' } });
    patch.mockResolvedValueOnce({ data: view({ timezone: 'Europe/Dublin' }, true) });
    fireEvent.click(screen.getByLabelText('Google sign-in'));
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Sign-in methods updated.' })]));
    expect(screen.getByLabelText('Name')).toHaveValue('Example Agency (renamed)'); // the unsaved edit survives
    expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/Dublin'); // the untouched field shows the server value
  });

  it('item 8 + 11: Save sends once however fast the clicks; a server 400 for the name goes UNDER the field (linked, focused), no toast', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Timezone'), { target: { value: 'Mars/Olympus' } });
    let answer: (v: unknown) => void = () => undefined;
    patch.mockReturnValueOnce(new Promise((_resolve, reject) => (answer = reject)));
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(base, { name: 'Example Agency Ltd', timezone: 'Mars/Olympus' });
    answer(axiosError(400, { message: ['timezone must be a valid IANA timezone'] }));
    const timezone = screen.getByLabelText('Timezone');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Enter a valid timezone, for example Europe/London.');
    expect(timezone).toHaveAttribute('aria-invalid', 'true');
    expect(timezone).toHaveAttribute('aria-describedby', alert.id);
    expect(timezone).toHaveValue('Mars/Olympus');
    await waitFor(() => expect(timezone).toHaveFocus());
    expect(toasts).toEqual([]);
  });

  it('item 8: an empty name is caught before sending (same rule as the server), under the field', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name for the organisation.');
    expect(patch).not.toHaveBeenCalled();
  });

  it('item 8: the identifier states its format (linked hint); a bad format is refused before sending; "already taken" (409) goes under the field', async () => {
    mount();
    const slug = await screen.findByLabelText('Identifier');
    expect(document.getElementById('admin-org-slug-hint')).toHaveTextContent(SLUG_HINT);
    expect(slug.getAttribute('aria-describedby')).toContain('admin-org-slug-hint');
    fireEvent.change(slug, { target: { value: '-bad-' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('lowercase letters, numbers or hyphens');
    expect(patch).not.toHaveBeenCalled();
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    patch.mockRejectedValueOnce(axiosError(409, { message: 'This subdomain is already taken.' }));
    fireEvent.change(slug, { target: { value: 'northwind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already used by another organisation'));
    expect(patch).toHaveBeenCalledWith(`${base}/domain`, { slug: 'northwind' });
    expect(slug).toHaveValue('northwind');
    expect(toasts).toEqual([]);
  });

  it('item 9: a logo of the wrong type or too large is refused before any upload (the real server limits); a valid one reports progress', async () => {
    mount();
    const input = (await screen.findByLabelText('Choose an organisation logo')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['GIF89a'], 'logo.gif', { type: 'image/gif' })] } });
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ variant: 'error' });
    expect(toasts[0]!.message).toMatch(/isn't supported. Please choose a PNG, JPG or WebP image smaller than 10 MB./);
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    await waitFor(() => expect(toasts).toHaveLength(2));
    expect(toasts[1]!.message).toMatch(/larger than 10 MB/);
    expect(post).not.toHaveBeenCalled();

    let progress: ((e: { loaded: number; total: number }) => void) | undefined;
    let answer: (v: unknown) => void = () => undefined;
    post.mockImplementationOnce((_url: string, _form: FormData, config: { onUploadProgress: typeof progress; timeout: number }) => {
      progress = config.onUploadProgress;
      expect(config.timeout).toBeGreaterThan(0);
      return new Promise((resolve) => (answer = resolve));
    });
    fireEvent.change(input, { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } });
    expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled();
    progress!({ loaded: 42, total: 100 });
    expect(await screen.findByRole('button', { name: 'Uploading 42%…' })).toBeDisabled();
    progress!({ loaded: 100, total: 100 });
    expect(await screen.findByRole('button', { name: 'Processing…' })).toBeDisabled(); // sent is not saved
    expect(toasts.filter((t) => t.variant === 'success')).toEqual([]);
    answer({ data: view({ logoKey: 'logos/org-1-v2.png' }) });
    await waitFor(() => expect(toasts.at(-1)).toMatchObject({ variant: 'success', message: 'Logo updated.' }));
  });

  it('item 9: a 413 from the server explains the size limit (not generic text)', async () => {
    mount();
    post.mockRejectedValueOnce(axiosError(413, { message: 'File too large' }));
    fireEvent.change(await screen.findByLabelText('Choose an organisation logo'), { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]!.message).toMatch(/larger than 10 MB/);
  });

  it('item 10: Remove asks first, then "Please wait…" until the server answers; success only after it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText('Remove Example Agency Ltd’s logo?')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    let answer: (v: unknown) => void = () => undefined;
    del.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove logo' }));
    expect(await within(confirm).findByRole('button', { name: 'Please wait…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(toasts).toEqual([]);
    answer({ data: view({ logoKey: null }) });
    await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Logo removed.' })]));
    expect(del).toHaveBeenCalledTimes(1);
  });
});
