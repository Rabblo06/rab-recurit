import { fireEvent, screen, waitFor } from '@testing-library/react';

import { api } from '../../../shared/api';
import { renderWithQuery } from './adminPanelTestKit';
import ResetTwoFactorDialog from './ResetTwoFactorDialog';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const post = api.post as jest.Mock;

beforeEach(() => post.mockReset());

function open(onDone = jest.fn(), onClose = jest.fn()) {
  renderWithQuery(<ResetTwoFactorDialog userId="u1" userLabel="Alex Morgan" onDone={onDone} onClose={onClose} />);
  return { onDone, onClose };
}

it('matches the design: title, warning notice, own-code hint, reason field, danger button', () => {
  open();
  expect(screen.getByText('Reset 2FA for Alex Morgan?')).toBeTruthy();
  expect(screen.getByText('This removes their authenticator and recovery codes, and signs them out on all devices.')).toBeTruthy();
  expect(screen.getByLabelText('Your current password')).toBeTruthy();
  expect(screen.getByLabelText('Your 2FA code')).toBeTruthy();
  expect(screen.getByText('Enter your own authenticator code if 2FA is enabled on your account.')).toBeTruthy();
  expect(screen.getByLabelText('Reason for reset')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reset two-factor authentication' })).toBeTruthy();
});

it('sends the proof INLINE when the password is typed (contract a), the code only when given', async () => {
  post.mockResolvedValue({ data: { reset: true, revokedSessions: 2 } });
  const { onDone } = open();
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'my-password' } });
  fireEvent.change(screen.getByLabelText('Your 2FA code'), { target: { value: '482913' } });
  fireEvent.change(screen.getByLabelText('Reason for reset'), { target: { value: 'User lost access' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset two-factor authentication' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ revokedSessions: 2 }));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/users/u1/mfa/reset', { reason: 'User lost access', currentPassword: 'my-password', code: '482913' });
});

it('sends { reason } alone when no password is typed (contract b: the shared StepUpHost answers STEP_UP_REQUIRED)', async () => {
  post.mockResolvedValue({ data: { reset: true, revokedSessions: 0 } });
  open();
  fireEvent.change(screen.getByLabelText('Reason for reset'), { target: { value: 'User lost access' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset two-factor authentication' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/users/u1/mfa/reset', { reason: 'User lost access' }));
});

it.each([
  ['MFA_RESET_REQUIRES_SECOND_ADMIN', 409, /second administrator/],
  ['MFA_NOT_ENABLED', 409, /hasn’t turned on two-factor/],
  ['MFA_RESET_SELF', 400, /your own two-factor/],
  ['STEP_UP_MFA_INVALID', 403, /code didn’t work/],
  ['MFA_RESET_RATE_LIMITED', 429, /limit of 5 resets an hour/],
])('shows a clear message for %s and never reports success', async (code, status, text) => {
  post.mockRejectedValue({ isAxiosError: true, response: { status, data: { code, message: 'x' } } });
  const { onDone } = open();
  fireEvent.change(screen.getByLabelText('Reason for reset'), { target: { value: 'User lost access' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset two-factor authentication' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(text);
  expect(onDone).not.toHaveBeenCalled();
});
