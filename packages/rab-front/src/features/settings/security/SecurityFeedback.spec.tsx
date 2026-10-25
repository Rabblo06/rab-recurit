import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import type { MfaStatus } from '../../auth/mfa/mfaApi';
import { startProviderReauth } from './reauthReturn';
import SecurityPage from './SecurityPage';

jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } },
}));
jest.mock('../../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

/**
 * Feedback follow-up (FEEDBACK_REPORT §6, Security items 1-4) on the real Security page. The visual design is unchanged
 * (docs/design/crewflow-account-security.html); these are behaviour fixes only: the in-flight guard spans the status
 * re-read, one announcement per error, busy toggles, a single SSO form POST, and "Sign in again" for an expired session.
 */
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const toastSuccess = toast.success as jest.Mock;
const toastError = toast.error as jest.Mock;
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });

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
const ON: MfaStatus = { ...OFF, enabled: true, enabledAt: '2026-10-24T10:00:00.000Z', recoveryCodesRemaining: 8, recoveryCodesTotal: 10, mobileChallenged: true };

let status: MfaStatus;
/** When set, the next GET /auth/mfa waits for this promise (models a slow status re-read after a change). */
let statusGate: Promise<void> | null;

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/settings/security']}>
        <Routes>
          <Route path="/settings/security" element={<SecurityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const card = () => screen.findByRole('region', { name: 'Two-factor authentication' });
const dialog = () => screen.getByRole('dialog');

beforeEach(() => {
  status = OFF;
  statusGate = null;
  get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/auth/mfa') {
      if (statusGate) await statusGate;
      return { data: status };
    }
    if (url === '/auth/me') return { data: { email: 'me@example.test' } };
    if (url === '/profile/sessions') return { data: [] };
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  sessionStorage.clear();
});
afterEach(() => document.querySelectorAll('form[data-acs-reauth]').forEach((f) => f.remove()));

async function openTurnOff() {
  status = ON;
  mount();
  fireEvent.click(within(await card()).getByRole('button', { name: 'Turn off two-factor authentication' }));
  fireEvent.change(within(dialog()).getByLabelText('Current password'), { target: { value: 'pw' } });
  fireEvent.change(within(dialog()).getByLabelText('6-digit authentication code'), { target: { value: '123456' } });
}

it('item 1: "Turn off 2FA" stays busy and disabled through the status re-read; a second press sends nothing; success only once it is done', async () => {
  await openTurnOff();
  let releaseStatus: () => void = () => undefined;
  post.mockResolvedValueOnce({ data: undefined });
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  // The server answered 204; the page now re-reads its status, which is slow.
  status = OFF;
  statusGate = new Promise<void>((resolve) => (releaseStatus = resolve));
  const busy = await within(dialog()).findByRole('button', { name: 'Turning off…' });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  fireEvent.click(busy);
  fireEvent.submit(busy.closest('form')!);
  expect(post).toHaveBeenCalledTimes(1); // never a second /auth/mfa/disable (which would answer MFA_NOT_ENABLED)
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(dialog()).toBeInTheDocument();
  statusGate = null;
  releaseStatus();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(toastSuccess).toHaveBeenCalledWith('Two-factor authentication is off.');
  expect(within(await card()).getByText('Off')).toBeInTheDocument();
});

it('item 2: a wrong code is ONE announcement (the alert under the field), never a toast as well; the code is kept', async () => {
  await openTurnOff();
  post.mockRejectedValueOnce(httpError(403, { code: 'STEP_UP_MFA_INVALID' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  const alert = await within(dialog()).findByRole('alert');
  expect(alert).toHaveTextContent('That code didn’t work.');
  expect(within(dialog()).getAllByRole('alert')).toHaveLength(1);
  expect(within(dialog()).getByLabelText('6-digit authentication code')).toHaveAttribute('aria-describedby', alert.id);
  expect(within(dialog()).getByLabelText('6-digit authentication code')).toHaveValue('123456');
  expect(toastError).not.toHaveBeenCalled();
});

it('item 2: an outage is the dialog’s one alert (no toast); an expired session is the persistent "Sign in again" toast only', async () => {
  await openTurnOff();
  post.mockRejectedValueOnce(httpError(503, { message: 'Internal server error' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Couldn’t turn off two-factor authentication. Try again.');
  expect(toastError).not.toHaveBeenCalled();

  post.mockRejectedValueOnce(httpError(401, { message: 'Unauthorized' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  expect(toastError).toHaveBeenCalledWith(
    'Your session has expired. Please sign in again.',
    expect.objectContaining({ persistent: true, action: expect.objectContaining({ label: 'Sign in again' }) }),
  );
  await waitFor(() => expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument());
});

it('item 2 (setup): a wrong code while connecting the authenticator is one alert, no toast', async () => {
  mount();
  fireEvent.click(within(await card()).getByRole('button', { name: 'Turn on 2FA' }));
  fireEvent.change(within(dialog()).getByLabelText('Current password'), { target: { value: 'pw' } });
  post.mockResolvedValueOnce({ data: { otpauthUri: 'otpauth://totp/Crewflow:me?secret=A', qrDataUrl: 'data:image/png;base64,QQ==', manualKey: 'AAAA' } });
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(dialog()).toHaveAccessibleName('Connect your authenticator'));
  post.mockRejectedValueOnce(httpError(400, { code: 'MFA_CODE_INVALID' }));
  fireEvent.change(within(dialog()).getByLabelText('6-digit authentication code'), { target: { value: '000000' } });
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Confirm code' }));
  expect(await within(dialog()).findByRole('alert')).toHaveTextContent('That code didn’t work.');
  expect(within(dialog()).getAllByRole('alert')).toHaveLength(1);
  expect(toastError).not.toHaveBeenCalled();
});

it('setup step 1: a double submit sends ONE enrolment request', async () => {
  mount();
  fireEvent.click(within(await card()).getByRole('button', { name: 'Turn on 2FA' }));
  fireEvent.change(within(dialog()).getByLabelText('Current password'), { target: { value: 'pw' } });
  post.mockReturnValue(new Promise(() => undefined));
  const form = within(dialog()).getByRole('button', { name: 'Continue' }).closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(await within(dialog()).findByRole('button', { name: 'Checking…' })).toBeDisabled();
  expect(post).toHaveBeenCalledTimes(1);
});

it('item 3: "Use a recovery code instead" is disabled while the request runs', async () => {
  await openTurnOff();
  post.mockReturnValueOnce(new Promise(() => undefined));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  await within(dialog()).findByRole('button', { name: 'Turning off…' });
  expect(within(dialog()).getByRole('button', { name: 'Use a recovery code instead' })).toBeDisabled();
});

it('item 4: "Continue with Microsoft" posts the re-auth form once; the button says "Opening Microsoft…" and is disabled', async () => {
  status = { ...OFF, hasPassword: false, linkedProviders: ['microsoft'], ssoReauthProviders: ['microsoft'] };
  const submit = jest.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  mount();
  fireEvent.click(within(await card()).getByRole('button', { name: 'Turn on 2FA' }));
  const button = within(dialog()).getByRole('button', { name: 'Continue with Microsoft' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(within(dialog()).getByRole('button', { name: 'Opening Microsoft…' })).toBeDisabled();
  // The helper itself refuses a second POST while the page is leaving (another dialog / a second click).
  expect(startProviderReauth('microsoft', 'enrol')).toBe(false);
  expect(submit).toHaveBeenCalledTimes(1);
  submit.mockRestore();
});
