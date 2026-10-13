import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InitialManagerPage from './InitialManagerPage';
import { api } from '../../../shared/api';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><InitialManagerPage /></QueryClientProvider>);
}

function mockManagers(data: any[]) {
  get.mockImplementation((url: string) => {
    if (url === '/managers') return Promise.resolve({ data: { data, total: data.length } });
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('no Initial Manager yet — the invite form', () => {
  beforeEach(() => mockManagers([]));

  it('has no workspace fields — the recipient chooses their own workspace after activating', async () => {
    mount();
    await screen.findByText('Invite your Initial Manager');
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
    expect(screen.queryByLabelText('Subdomain')).toBeNull();
  });

  it('sends the invite with the fixed Initial-Manager contract (identity only) and shows honest, non-fake delivery copy', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/managers/initial-manager-invite') return Promise.resolve({ data: {} });
      throw new Error(`unexpected POST ${url}`);
    });
    mount();
    await screen.findByText('Invite your Initial Manager');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'manager@northside.test' } });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite', {
      email: 'manager@northside.test', firstName: 'Pat', lastName: 'Ng',
    }));
    expect(await screen.findByText('Invitation created for manager@northside.test.')).toBeInTheDocument();
    expect(screen.queryByText(/has been received/i)).toBeNull();
  });
});

describe('an Initial Manager already exists — status only, never a second invite form', () => {
  it('a pending invitation offers resend and revoke', async () => {
    mockManagers([{ id: 'mp-1', email: 'pending@northside.test', firstName: 'Pat', lastName: 'Ng', accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1, maxSendAttempts: 3 } }]);
    post.mockResolvedValue({ data: { sendNumber: 2, expiresAt: '2026-03-01', queued: true } });
    mount();

    expect(await screen.findByText('pending@northside.test')).toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace name')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Resend invitation/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite/resend'));
    expect(await screen.findByText('Invitation queued for delivery.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Revoke invitation/i }));
    const confirm = document.querySelector('.drawer-discard-confirm') as HTMLElement;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite/revoke'));
  });

  it('a maxed-out, non-accepted invitation offers Replace Invitation instead of a resend button that would 409', async () => {
    mockManagers([{ id: 'mp-1', email: 'stuck@northside.test', firstName: 'Pat', lastName: 'Ng', accountStatus: 'invite_expired', invitationStatus: 'expired', pendingInvite: { sendNumber: 3, maxSendAttempts: 3 } }]);
    mount();
    expect(await screen.findByRole('button', { name: /Replace Invitation/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-invite/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Resend/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revoke/i })).toBeNull();
  });

  it('replacing a maxed-out invitation sends the real contract (identity only) and surfaces the server\'s own error codes honestly', async () => {
    mockManagers([{ id: 'mp-1', email: 'stuck@northside.test', firstName: 'Pat', lastName: 'Ng', accountStatus: 'invite_expired', invitationStatus: 'expired', pendingInvite: { sendNumber: 3, maxSendAttempts: 3 } }]);
    post.mockImplementation((url: string) => {
      if (url === '/managers/initial-manager-invite/replace') return Promise.reject({ response: { data: { code: 'REPLACE_COOLDOWN_ACTIVE' } } });
      throw new Error(`unexpected POST ${url}`);
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Replace Invitation/i }));

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@northside.test' } });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jo' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lee' } });

    fireEvent.click(screen.getByRole('button', { name: 'Replace Invitation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite/replace', {
      expectedProfileId: 'mp-1', email: 'new@northside.test', firstName: 'Jo', lastName: 'Lee',
    }));
    // Exactly one rendering of this message — a real bug caught here during development: the
    // page's own top-level error paragraph and the shared form's own `error` prop both showed
    // the SAME string while the replace form was open, until the page learned to suppress its
    // own copy whenever the form (which displays this error itself) is the one open.
    expect(await screen.findAllByText(/24 hours after cancellation/i)).toHaveLength(1);
  });

  it('an already-active Initial Manager shows status with no resend/revoke actions and no invite form', async () => {
    mockManagers([{ id: 'mp-1', email: 'active@northside.test', firstName: 'Pat', lastName: 'Ng', accountStatus: 'active', invitationStatus: null, pendingInvite: null }]);
    mount();
    expect(await screen.findByText('active@northside.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resend/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revoke/i })).toBeNull();
    expect(screen.queryByText('Invite your Initial Manager')).toBeNull();
  });
});
