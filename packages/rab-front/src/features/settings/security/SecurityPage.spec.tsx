import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import type { MfaStatus } from '../../auth/mfa/mfaApi';
import SecurityPage from './SecurityPage';

jest.mock('../../../shared/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
    defaults: { baseURL: 'http://api.test/rest/v1' },
  },
}));
jest.mock('../../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const toastSuccess = toast.success as jest.Mock;
const toastError = toast.error as jest.Mock;
const httpError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

const OFF: MfaStatus = {
  enabled: false,
  enabledAt: null,
  recoveryCodesRemaining: 0,
  recoveryCodesTotal: 0,
  enforced: false,
  enrolmentAvailable: true,
  mobileChallenged: false,
  hasPassword: true,
  linkedProviders: [],
  ssoReauthProviders: [],
};
const ON: MfaStatus = {
  ...OFF,
  enabled: true,
  enabledAt: '2026-10-24T10:00:00.000Z',
  recoveryCodesRemaining: 8,
  recoveryCodesTotal: 10,
  mobileChallenged: true,
};
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MATERIAL = {
  otpauthUri:
    'otpauth://totp/Crewflow:me%40example.test?secret=JBSW&issuer=Crewflow',
  qrDataUrl: 'data:image/png;base64,QQ==',
  manualKey: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
};
const CODES = Array.from(
  { length: 10 },
  (_, i) => `ZZZZ-YYYY-XXXX-00${String(i).padStart(2, '0')}`,
);

let status: MfaStatus;
let sessions: Array<{
  familyId: string;
  userAgent: string | null;
  isCurrentDevice: boolean;
}>;

function mount(path = '/settings/security') {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/security" element={<SecurityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = async () =>
  screen.findByRole('region', { name: 'Two-factor authentication' });
const dialog = () => screen.getByRole('dialog');

beforeEach(() => {
  status = OFF;
  sessions = [
    { familyId: 'f1', userAgent: CHROME_WINDOWS, isCurrentDevice: true },
    { familyId: 'f2', userAgent: 'Dart/3.5 (dart:io)', isCurrentDevice: false },
  ];
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/auth/mfa') return { data: status };
    if (url === '/auth/me') return { data: { email: 'me@example.test' } };
    if (url === '/profile/sessions') return { data: sessions };
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  sessionStorage.clear();
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

describe('page states (server values only)', () => {
  it('off: Off badge, optional copy, Turn on 2FA, password card with Reset password, current session without a location, aside', async () => {
    mount();
    const c = await card();
    expect(within(c).getByText('Off')).toBeInTheDocument();
    expect(
      within(c).getByText(
        /It’s optional, and you can turn it off at any time\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(c).getByRole('button', { name: 'Turn on 2FA' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('link', { name: 'Reset password' }),
    ).toHaveAttribute('href', '/forgot-password?email=me%40example.test');
    expect(screen.queryByText(/Last updated/)).not.toBeInTheDocument();
    const session = await screen.findByRole('region', {
      name: 'Current session',
    });
    expect(within(session).getByText('Chrome on Windows')).toBeInTheDocument();
    expect(within(session).getByText('Active now')).toBeInTheDocument();
    expect(within(session).getByText('This device')).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', {
        name: 'How two-factor authentication works',
      }),
    ).toHaveTextContent('Sign in with your password');
    expect(
      screen.getByText(
        'Optional for every role. Required at each sign-in once enabled.',
      ),
    ).toBeInTheDocument();
  });

  it('on: Enabled on (en-GB) and "8 of 10 remaining"; no low warning at 4, a warning at 3 (LOW_RECOVERY_CODES)', async () => {
    status = { ...ON, recoveryCodesRemaining: 4 };
    mount();
    const c = await card();
    expect(within(c).getByText('On')).toBeInTheDocument();
    expect(within(c).getByText('24 Oct 2026')).toBeInTheDocument();
    expect(within(c).getByText('Connected')).toBeInTheDocument();
    expect(within(c).getByText('4 of 10')).toBeInTheDocument();
    expect(
      within(c).queryByText(/recovery codes? left/),
    ).not.toBeInTheDocument();
  });

  it('low: "Only 3 recovery codes left" from the real count', async () => {
    status = { ...ON, recoveryCodesRemaining: 3 };
    mount();
    expect(
      await screen.findByText(/^Only 3 recovery codes left\./),
    ).toBeInTheDocument();
  });

  it('no recoveryCodesTotal from the server → "8 remaining" with no invented total', async () => {
    status = { ...ON, recoveryCodesTotal: undefined };
    mount();
    const c = await card();
    expect(within(c).getByText('8')).toBeInTheDocument();
    expect(within(c).queryByText(/of 10/)).not.toBeInTheDocument();
  });

  it('enforced account: no Turn off; enrolment unavailable: Turn on disabled with the reason', async () => {
    status = { ...ON, enforced: true };
    mount();
    const c = await card();
    expect(
      within(c).getByText(/Your organisation requires it for your account\./),
    ).toBeInTheDocument();
    expect(
      within(c).queryByRole('button', { name: /Turn off/ }),
    ).not.toBeInTheDocument();
  });

  it('enrolment unavailable: Turn on 2FA is disabled and says why', async () => {
    status = { ...OFF, enrolmentAvailable: false };
    mount();
    const button = within(await card()).getByRole('button', {
      name: 'Turn on 2FA',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      'Two-factor setup isn’t available right now. Try again later.',
    );
  });

  it('no current session row → no current-session card; status failure → an announced error with a retry', async () => {
    sessions = [{ familyId: 'f2', userAgent: null, isCurrentDevice: false }];
    get.mockImplementation(async (url: string) => {
      if (url === '/auth/mfa') throw httpError(500);
      if (url === '/profile/sessions') return { data: sessions };
      return { data: {} };
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Two-factor status couldn’t be loaded.',
    );
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Current session' }),
    ).not.toBeInTheDocument();
  });
});

describe('turn on (confirm password → connect authenticator → save codes)', () => {
  it('wrong password stays on step 1 (error under the field, password kept, red toast); a wrong code keeps the step; success only after the server; Done gated', async () => {
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', { name: 'Turn on 2FA' }),
    );
    expect(dialog()).toHaveAccessibleName('Confirm it’s you');
    expect(
      within(dialog()).getByRole('list', { name: 'Setup progress' }),
    ).toBeInTheDocument();
    expect(
      within(dialog()).getByText('Confirm identity').closest('li'),
    ).toHaveAttribute('aria-current', 'step');
    const continueBtn = within(dialog()).getByRole('button', {
      name: 'Continue',
    });
    expect(continueBtn).toBeDisabled();

    post.mockRejectedValueOnce(
      httpError(403, {
        statusCode: 403,
        message: 'Re-enter your current password to continue.',
      }),
    );
    fireEvent.change(within(dialog()).getByLabelText('Current password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(continueBtn);
    expect(
      await within(dialog()).findByText(
        'That password didn’t work. Check it and try again.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(within(dialog()).getByLabelText('Current password')).toHaveValue(
      'wrong',
    );
    expect(within(dialog()).getByLabelText('Current password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(toastError).toHaveBeenCalledWith(
      'That password didn’t work. Check it and try again.',
    );
    expect(dialog()).toHaveAccessibleName('Confirm it’s you');

    post.mockResolvedValueOnce({ data: MATERIAL });
    fireEvent.change(within(dialog()).getByLabelText('Current password'), {
      target: { value: 'pw' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(dialog()).toHaveAccessibleName('Connect your authenticator'),
    );
    expect(post).toHaveBeenLastCalledWith(
      '/auth/mfa/enrolment',
      { currentPassword: 'pw' },
      { _stepUpRetried: true },
    );
    expect(within(dialog()).getByAltText(/QR code/)).toHaveAttribute(
      'src',
      MATERIAL.qrDataUrl,
    );
    expect(
      within(dialog()).getByRole('group', { name: 'Setup key' }),
    ).toHaveTextContent(MATERIAL.manualKey);
    expect(within(dialog()).getByText('me@example.test')).toBeInTheDocument();
    const confirmBtn = within(dialog()).getByRole('button', {
      name: 'Confirm code',
    });
    expect(confirmBtn).toBeDisabled();

    post.mockRejectedValueOnce(httpError(400, { code: 'MFA_CODE_INVALID' }));
    fireEvent.change(
      within(dialog()).getByLabelText('6-digit authentication code'),
      { target: { value: '000000' } },
    );
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Confirm code' }),
    );
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'That code didn’t work.',
    );
    expect(
      within(dialog()).getByLabelText('6-digit authentication code'),
    ).toHaveValue('000000');
    expect(toastSuccess).not.toHaveBeenCalled();

    status = { ...ON, recoveryCodesRemaining: 10 };
    post.mockResolvedValueOnce({ status: 200, data: { recoveryCodes: CODES } });
    fireEvent.change(
      within(dialog()).getByLabelText('6-digit authentication code'),
      { target: { value: '123456' } },
    );
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Confirm code' }),
    );
    await waitFor(() =>
      expect(dialog()).toHaveAccessibleName('Save your recovery codes'),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'Two-factor authentication is on.',
    );
    expect(
      within(dialog()).getByRole('list', { name: 'Recovery codes' }),
    ).toHaveTextContent(CODES[9]!);

    // Codes are shown once: no close button, Escape does nothing, Done waits for the acknowledgement.
    expect(
      within(dialog()).queryByRole('button', { name: 'Close' }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).toHaveAccessibleName('Save your recovery codes');
    const done = within(dialog()).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(
      within(dialog()).getByLabelText(
        'I’ve saved my recovery codes somewhere safe.',
      ),
    );
    expect(done).toBeEnabled();
    fireEvent.click(done);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    // The card shows the server's re-read state, and focus lands on its heading (the Turn on button no longer exists).
    expect(within(await card()).getByText('10 of 10')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Two-factor authentication' }),
      ).toHaveFocus(),
    );
  });

  it('Escape on step 1 closes the dialog and focus returns to "Turn on 2FA"', async () => {
    mount();
    const open = within(await card()).getByRole('button', {
      name: 'Turn on 2FA',
    });
    open.focus();
    fireEvent.click(open);
    await waitFor(() =>
      expect(within(dialog()).getByLabelText('Current password')).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(open).toHaveFocus());
    expect(post).not.toHaveBeenCalled();
  });
});

describe('accounts without a password (SSO-only confirm)', () => {
  it('Microsoft: no password field and no Password card; "Continue with Microsoft" POSTs to the re-auth route with the fixed return path', async () => {
    status = {
      ...OFF,
      hasPassword: false,
      linkedProviders: ['microsoft'],
      ssoReauthProviders: ['microsoft'],
    };
    const submit = jest
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', { name: 'Turn on 2FA' }),
    );
    expect(
      within(dialog()).queryByLabelText('Current password'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Password' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('complementary', {
        name: 'How two-factor authentication works',
      }),
    ).toHaveTextContent('Sign in with Microsoft');
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Continue with Microsoft' }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    const form = submit.mock.instances[0] as unknown as HTMLFormElement;
    expect(form.method).toBe('post');
    expect(form.action).toBe(
      'http://api.test/rest/v1/auth/microsoft/reauthenticate',
    );
    expect(
      (form.elements.namedItem('returnTo') as HTMLInputElement).value,
    ).toBe('/settings/security');
    expect(
      JSON.parse(sessionStorage.getItem('cf-security-reauth-intent')!),
    ).toMatchObject({ intent: 'enrol' });
    submit.mockRestore();
  });

  it('back from Microsoft (?reauth=ok, forwarded by Account) the dialog reopens confirmed, and Continue sends no password', async () => {
    status = {
      ...OFF,
      hasPassword: false,
      linkedProviders: ['microsoft'],
      ssoReauthProviders: ['microsoft'],
    };
    sessionStorage.setItem(
      'cf-security-reauth-intent',
      JSON.stringify({ intent: 'enrol', at: Date.now() }),
    );
    mount('/settings/security?reauth=ok');
    await waitFor(() =>
      expect(dialog()).toHaveAccessibleName('Confirm it’s you'),
    );
    expect(
      within(dialog()).getByText(
        'Confirmed with Microsoft. Continue to finish.',
      ),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem('cf-security-reauth-intent')).toBeNull();
    post.mockResolvedValueOnce({ data: MATERIAL });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(dialog()).toHaveAccessibleName('Connect your authenticator'),
    );
    expect(post).toHaveBeenCalledWith(
      '/auth/mfa/enrolment',
      {},
      { _stepUpRetried: true },
    );
  });

  it('Google-only: Continue relies on the recent sign-in; once the server says STEP_UP_REQUIRED the user is told to sign out and back in', async () => {
    status = {
      ...OFF,
      hasPassword: false,
      linkedProviders: ['google'],
      ssoReauthProviders: [],
    };
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', { name: 'Turn on 2FA' }),
    );
    expect(
      within(dialog()).queryByRole('button', { name: /Continue with/ }),
    ).not.toBeInTheDocument();
    post.mockRejectedValueOnce(
      httpError(403, { code: 'STEP_UP_REQUIRED', mfa: false }),
    );
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(
      await within(dialog()).findByText(
        'For your security, sign out and sign back in with Google, then try again straight away.',
      ),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(
      '/auth/mfa/enrolment',
      {},
      { _stepUpRetried: true },
    );
    expect(toastError).toHaveBeenCalled();
  });
});

describe('get new recovery codes', () => {
  it('needs password AND a code; the new set replaces the old one (shown once, gated) and the count is re-read from the server', async () => {
    status = { ...ON, recoveryCodesRemaining: 2 };
    mount();
    const c = await card();
    expect(within(c).getByText('2 of 10')).toBeInTheDocument();
    fireEvent.click(
      within(c).getByRole('button', { name: 'Get new recovery codes' }),
    );
    expect(dialog()).toHaveAccessibleName('Get new recovery codes');
    const generate = within(dialog()).getByRole('button', {
      name: 'Generate new codes',
    });
    fireEvent.change(within(dialog()).getByLabelText('Current password'), {
      target: { value: 'pw' },
    });
    expect(generate).toBeDisabled(); // no code yet

    post.mockRejectedValueOnce(httpError(403, { code: 'STEP_UP_MFA_INVALID' }));
    fireEvent.change(
      within(dialog()).getByLabelText('6-digit authentication code'),
      { target: { value: '999999' } },
    );
    fireEvent.click(generate);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'That code didn’t work.',
    );
    expect(within(dialog()).getByLabelText('Current password')).toHaveValue(
      'pw',
    );

    status = { ...ON, recoveryCodesRemaining: 10 };
    post.mockResolvedValueOnce({ data: { recoveryCodes: CODES } });
    fireEvent.change(
      within(dialog()).getByLabelText('6-digit authentication code'),
      { target: { value: '123456' } },
    );
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Generate new codes' }),
    );
    await waitFor(() =>
      expect(dialog()).toHaveAccessibleName('Save your new recovery codes'),
    );
    expect(post).toHaveBeenLastCalledWith(
      '/auth/mfa/recovery-codes',
      { currentPassword: 'pw', code: '123456' },
      { _stepUpRetried: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'New recovery codes created. Your previous codes no longer work.',
    );
    expect(
      within(dialog()).getByRole('list', { name: 'Recovery codes' }),
    ).toHaveTextContent(CODES[0]!);
    expect(
      within(dialog()).getByRole('button', { name: 'Done' }),
    ).toBeDisabled();
    await waitFor(() =>
      expect(within(c).getByText('10 of 10')).toBeInTheDocument(),
    );
  });
});

describe('turn off', () => {
  it('with an authenticator code: success only after the server, the card shows Off from the re-read status', async () => {
    status = ON;
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', {
        name: 'Turn off two-factor authentication',
      }),
    );
    expect(dialog()).toHaveAccessibleName(
      'Turn off two-factor authentication?',
    );
    const submit = within(dialog()).getByRole('button', {
      name: 'Turn off 2FA',
    });
    fireEvent.change(within(dialog()).getByLabelText('Current password'), {
      target: { value: 'pw' },
    });
    expect(submit).toBeDisabled();
    let finish: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fireEvent.change(
      within(dialog()).getByLabelText('6-digit authentication code'),
      { target: { value: '123456' } },
    );
    fireEvent.click(submit);
    expect(
      await within(dialog()).findByRole('button', { name: 'Turning off…' }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Turning off…' }),
    ); // a duplicate submit does nothing
    expect(post).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    status = OFF;
    finish({ data: undefined });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(post).toHaveBeenCalledWith(
      '/auth/mfa/disable',
      { currentPassword: 'pw', code: '123456' },
      { _stepUpRetried: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'Two-factor authentication is off.',
    );
    expect(within(await card()).getByText('Off')).toBeInTheDocument();
  });

  it('with a recovery code instead', async () => {
    status = ON;
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', {
        name: 'Turn off two-factor authentication',
      }),
    );
    fireEvent.click(
      within(dialog()).getByRole('button', {
        name: 'Use a recovery code instead',
      }),
    );
    expect(
      within(dialog()).queryByLabelText('6-digit authentication code'),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog()).getByLabelText('Current password'), {
      target: { value: 'pw' },
    });
    post.mockRejectedValueOnce(httpError(403, { code: 'STEP_UP_MFA_INVALID' }));
    fireEvent.change(within(dialog()).getByLabelText('Recovery code'), {
      target: { value: 'ABCD-EFGH-JKMN-PQRS' },
    });
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Turn off 2FA' }),
    );
    expect(
      await within(dialog()).findByText(
        'That recovery code didn’t work. Check it and try again.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(within(dialog()).getByLabelText('Recovery code')).toHaveValue(
      'ABCD-EFGH-JKMN-PQRS',
    );
    status = OFF;
    post.mockResolvedValueOnce({ data: undefined });
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Turn off 2FA' }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        '/auth/mfa/disable',
        { currentPassword: 'pw', code: 'ABCD-EFGH-JKMN-PQRS' },
        { _stepUpRetried: true },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('Keep 2FA on closes without a request', async () => {
    status = ON;
    mount();
    fireEvent.click(
      within(await card()).getByRole('button', {
        name: 'Turn off two-factor authentication',
      }),
    );
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Keep 2FA on' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(post).not.toHaveBeenCalled();
  });
});
