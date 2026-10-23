import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import TwoFactorSection from './TwoFactorSection';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../../shared/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });
const off = { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, enforced: false, enrolmentAvailable: true, mobileChallenged: false };
const on = { ...off, enabled: true, enabledAt: '2026-10-23T00:00:00.000Z', recoveryCodesRemaining: 2 };

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TwoFactorSection email="me@example.test" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

it('shows the real server status, and enrolment needs the password, then a code, then shows the recovery codes once', async () => {
  get.mockResolvedValue({ data: off });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Set up' }));
  post.mockResolvedValueOnce({ data: { otpauthUri: 'otpauth://totp/x?secret=A', qrDataUrl: 'data:image/png;base64,QQ', manualKey: 'AAAA BBBB' } });
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByAltText(/QR code/)).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('/auth/mfa/enrolment', { currentPassword: 'pw' });
  post.mockRejectedValueOnce(httpError(401, { code: 'MFA_CODE_INVALID' }));
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('didn’t work');
  const codes = Array.from({ length: 10 }, (_, i) => `ZZZZ-YYYY-XXXX-000${i}`);
  post.mockResolvedValueOnce({ data: { recoveryCodes: codes } });
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  expect(await screen.findByRole('list', { name: 'Recovery codes' })).toHaveTextContent(codes[0]!);
  expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
});

it('turning it off asks for the password AND a code; a low recovery-code count is highlighted', async () => {
  get.mockResolvedValue({ data: on });
  mount();
  expect(await screen.findByText('2 left')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Turn off/ }));
  const submit = screen.getAllByRole('button', { name: 'Turn off' }).at(-1)!;
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
  expect(submit).toBeDisabled(); // no code yet
  post.mockResolvedValueOnce({ data: undefined });
  fireEvent.change(screen.getByLabelText('Authentication or recovery code'), { target: { value: '123456' } });
  fireEvent.click(submit);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/mfa/disable', { currentPassword: 'pw', code: '123456' }));
});

it('an enforced account cannot see a Turn off button', async () => {
  get.mockResolvedValue({ data: { ...on, enforced: true } });
  mount();
  expect(await screen.findByText(/Required for your account/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Turn off/ })).not.toBeInTheDocument();
});
