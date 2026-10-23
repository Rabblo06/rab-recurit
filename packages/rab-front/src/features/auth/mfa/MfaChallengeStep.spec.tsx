import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { api } from '../../../shared/api';
import MfaChallengeStep from './MfaChallengeStep';

jest.mock('../../../shared/api', () => ({
  api: { post: jest.fn() },
  withAuthLock: jest.fn((run: () => unknown) => run()),
}));

const post = api.post as jest.Mock;
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });
const token = `mfc_${'b'.repeat(43)}`;

beforeEach(() => post.mockReset());

it('verify: sends the code with the challenge token and finishes only on success; errors are uniform', async () => {
  const onSignedIn = jest.fn();
  render(<MfaChallengeStep challenge={{ challengeToken: token, requirement: 'verify' }} onSignedIn={onSignedIn} onRestart={jest.fn()} />);
  post.mockRejectedValueOnce(httpError(401, { code: 'MFA_CODE_INVALID' }));
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '12a3 456' } });
  expect(screen.getByLabelText('Six-digit code')).toHaveValue('123 456'); // digits and a space only
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That code didn’t work');
  expect(onSignedIn).not.toHaveBeenCalled();
  post.mockResolvedValueOnce({ data: { mustResetPassword: false } });
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ mustResetPassword: false }));
  expect(post).toHaveBeenLastCalledWith('/auth/mfa/challenge/verify', { challengeToken: token, code: '654321' });
});

it('a recovery code can be used instead', async () => {
  render(<MfaChallengeStep challenge={{ challengeToken: token, requirement: 'verify' }} onSignedIn={jest.fn()} onRestart={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
  post.mockResolvedValueOnce({ data: { mustResetPassword: false } });
  fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-EFGH-JKMN-PQRS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/verify', { challengeToken: token, code: 'ABCD-EFGH-JKMN-PQRS' }));
});

it('an exhausted or expired challenge sends the user back to sign in (no retry on a dead challenge)', async () => {
  const onRestart = jest.fn();
  render(<MfaChallengeStep challenge={{ challengeToken: token, requirement: 'verify' }} onSignedIn={jest.fn()} onRestart={onRestart} />);
  post.mockRejectedValueOnce(httpError(401, { code: 'MFA_CHALLENGE_EXHAUSTED' }));
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  expect(onRestart).toHaveBeenCalled();
});

it('enrol-required: QR + manual key from the server, confirm, recovery codes shown once and must be acknowledged', async () => {
  const onSignedIn = jest.fn();
  render(<MfaChallengeStep challenge={{ challengeToken: token, requirement: 'enroll' }} email="ceo@example.test" onSignedIn={onSignedIn} onRestart={jest.fn()} />);
  expect(screen.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
  post.mockResolvedValueOnce({ data: { otpauthUri: 'otpauth://totp/x?secret=ABC', qrDataUrl: 'data:image/png;base64,AAAA', manualKey: 'ABCD EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up now' }));
  expect(await screen.findByAltText(/QR code/)).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  fireEvent.click(screen.getByRole('button', { name: /setup key/ }));
  expect(screen.getByLabelText('Setup key')).toHaveTextContent('ABCD EFGH');
  const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-000${i}`);
  post.mockResolvedValueOnce({ data: { mustResetPassword: false, recoveryCodes: codes } });
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on and sign in' }));
  expect(await screen.findByRole('list', { name: 'Recovery codes' })).toHaveTextContent(codes[9]!);
  const cont = screen.getByRole('button', { name: 'Continue' });
  expect(cont).toBeDisabled();
  expect(onSignedIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/saved these codes/));
  fireEvent.click(cont);
  expect(onSignedIn).toHaveBeenCalledWith({ mustResetPassword: false });
  expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/enrolment', { challengeToken: token });
  expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/enrolment/confirm', { challengeToken: token, code: '123456' });
});
