import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import MfaChallengeStep from './MfaChallengeStep';

jest.mock('../../../shared/api', () => ({
  api: { post: jest.fn() },
  withAuthLock: jest.fn((run: () => unknown) => run()),
}));
jest.mock('../../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

const post = api.post as jest.Mock;
const toastError = toast.error as jest.Mock;
const httpError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
const token = `mfc_${'b'.repeat(43)}`;
const codeInput = () =>
  screen.getByLabelText('6-digit authentication code') as HTMLInputElement;

function mount(
  extra: {
    email?: string;
    onSignedIn?: jest.Mock;
    onRestart?: jest.Mock;
    requirement?: 'verify' | 'enroll';
  } = {},
) {
  const onSignedIn = extra.onSignedIn ?? jest.fn();
  const onRestart = extra.onRestart ?? jest.fn();
  render(
    <MfaChallengeStep
      challenge={{
        challengeToken: token,
        requirement: extra.requirement ?? 'verify',
      }}
      email={extra.email}
      onSignedIn={onSignedIn}
      onRestart={onRestart}
    />,
  );
  return { onSignedIn, onRestart };
}

beforeEach(() => {
  post.mockReset();
  toastError.mockReset();
});

it('code: the design state — emblem heading, account chip from the typed email, one autofocused one-time-code input', () => {
  mount({ email: 'issac@example-agency.test' });
  expect(
    screen.getByRole('heading', { level: 1, name: 'Verify your sign-in' }),
  ).toBeInTheDocument();
  expect(screen.getByText('issac@example-agency.test')).toBeInTheDocument();
  expect(codeInput()).toHaveFocus();
  expect(codeInput()).toHaveAttribute('autocomplete', 'one-time-code');
  expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
});

it('no email known (Google/Microsoft sign-in) → no account chip', () => {
  mount();
  expect(screen.queryByText(/Signing in as/)).not.toBeInTheDocument();
});

it('paste of a whole code submits it once; success finishes only after the server answered', async () => {
  const { onSignedIn } = mount();
  post.mockResolvedValueOnce({ data: { mustResetPassword: false } });
  fireEvent.paste(codeInput(), { clipboardData: { getData: () => '654 321' } });
  await waitFor(() =>
    expect(onSignedIn).toHaveBeenCalledWith({ mustResetPassword: false }),
  );
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenLastCalledWith('/auth/mfa/challenge/verify', {
    challengeToken: token,
    code: '654321',
  });
});

it('invalid: shows the server’s real attemptsRemaining ("3 tries left"), keeps and marks the code, ONE announcement (the inline alert, no toast), no sign-in', async () => {
  const { onSignedIn } = mount();
  post.mockRejectedValueOnce(
    httpError(401, {
      code: 'MFA_CODE_INVALID',
      state: 'invalid_code',
      attemptsRemaining: 3,
    }),
  );
  fireEvent.change(codeInput(), { target: { value: '123456' } });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(
    'That code didn’t work. Check your app and try again. 3 tries left.',
  );
  expect(codeInput()).toHaveValue('123456');
  expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
  expect(codeInput()).toHaveAttribute(
    'aria-describedby',
    'mfa-challenge-error',
  );
  // Owner rule: one screen-reader announcement per error, never an inline alert AND a toast for the same failure.
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(toastError).not.toHaveBeenCalled();
  expect(onSignedIn).not.toHaveBeenCalled();
});

it('invalid: one try left is singular; without attemptsRemaining no number is ever invented', async () => {
  mount();
  post.mockRejectedValueOnce(
    httpError(401, { code: 'MFA_CODE_INVALID', attemptsRemaining: 1 }),
  );
  fireEvent.change(codeInput(), { target: { value: '111111' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('1 try left.');
  post.mockRejectedValueOnce(httpError(401, { code: 'MFA_CODE_INVALID' }));
  fireEvent.change(codeInput(), { target: { value: '222222' } });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^That code didn’t work\. Check your app and try again\.$/,
    ),
  );
});

it('a recovery code can be used instead, and toggles back', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
  expect(
    screen.getByRole('heading', { level: 1, name: 'Use a recovery code' }),
  ).toBeInTheDocument();
  post.mockResolvedValueOnce({ data: { mustResetPassword: false } });
  fireEvent.change(screen.getByLabelText('Recovery code'), {
    target: { value: 'ABCD-EFGH-JKMN-PQRS' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify recovery code' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/verify', {
      challengeToken: token,
      code: 'ABCD-EFGH-JKMN-PQRS',
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Use an authenticator code instead' }),
  );
  expect(
    screen.getByRole('heading', { level: 1, name: 'Verify your sign-in' }),
  ).toBeInTheDocument();
});

it('a wrong recovery code keeps the typed value and says so', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
  post.mockRejectedValueOnce(
    httpError(401, { code: 'MFA_CODE_INVALID', attemptsRemaining: 2 }),
  );
  fireEvent.change(screen.getByLabelText('Recovery code'), {
    target: { value: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify recovery code' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'That recovery code didn’t work. Check it and try again. 2 tries left.',
  );
  expect(screen.getByLabelText('Recovery code')).toHaveValue(
    'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
  );
});

it('expired (MFA_CHALLENGE_EXPIRED) → "Your sign-in session expired", no number of minutes, support caption, back to sign in', async () => {
  const { onRestart } = mount();
  post.mockRejectedValueOnce(
    httpError(401, { code: 'MFA_CHALLENGE_EXPIRED', state: 'expired' }),
  );
  fireEvent.change(codeInput(), { target: { value: '111111' } });
  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: 'Your sign-in session expired',
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Verification sessions expire after a few minutes.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/5 minutes/)).not.toBeInTheDocument();
  expect(
    screen.getByText(/Contact your workspace admin or Crewflow support\./),
  ).toBeInTheDocument();
  // One announcement: focus moves to "Back to sign in", described by the explanation; no toast, no second live region.
  const back = screen.getByRole('button', { name: 'Back to sign in' });
  expect(back).toHaveFocus();
  expect(back).toHaveAccessibleDescription(
    'For your security, this verification session has ended. Sign in again to request a new session.',
  );
  expect(toastError).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  expect(onRestart).toHaveBeenCalled();
});

it('locked (MFA_CHALLENGE_EXHAUSTED) → "Let’s start again" (no retry on a dead challenge)', async () => {
  const { onRestart } = mount({ email: 'me@example.test' });
  post.mockRejectedValueOnce(
    httpError(401, { code: 'MFA_CHALLENGE_EXHAUSTED', state: 'locked' }),
  );
  fireEvent.change(codeInput(), { target: { value: '111111' } });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Let’s start again' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Too many incorrect codes were entered. Sign in with your password again to continue.',
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText('6-digit authentication code'),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  expect(onRestart).toHaveBeenCalled();
});

it('rate-limited (429 MFA_RATE_LIMITED) → too many attempts with the server’s retry time; back to sign in cancels the challenge', async () => {
  const { onRestart } = mount();
  post.mockRejectedValueOnce(
    httpError(429, {
      code: 'MFA_RATE_LIMITED',
      state: 'locked',
      retryAfter: 120,
    }),
  );
  fireEvent.change(codeInput(), { target: { value: '111111' } });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Too many attempts' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Too many verification attempts were made. Try again in 2 minutes.',
    ),
  ).toBeInTheDocument();
  post.mockResolvedValueOnce({ data: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  await waitFor(() => expect(onRestart).toHaveBeenCalled());
  expect(post).toHaveBeenLastCalledWith('/auth/mfa/challenge/cancel', {
    challengeToken: token,
  });
});

it('Back to sign in from the code step cancels the pending challenge', async () => {
  const { onRestart } = mount();
  post.mockResolvedValueOnce({ data: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  await waitFor(() => expect(onRestart).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/cancel', {
    challengeToken: token,
  });
});

it('enrol-required: QR + manual key from the server, confirm, recovery codes shown once and must be acknowledged', async () => {
  const onSignedIn = jest.fn();
  mount({ requirement: 'enroll', email: 'ceo@example.test', onSignedIn });
  expect(
    screen.getByRole('heading', { name: 'Set up two-factor authentication' }),
  ).toBeInTheDocument();
  post.mockResolvedValueOnce({
    data: {
      otpauthUri:
        'otpauth://totp/Crewflow:ceo%40example.test?secret=ABC&issuer=Crewflow',
      qrDataUrl: 'data:image/png;base64,AAAA',
      manualKey: 'ABCD EFGH',
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Set up now' }));
  expect(await screen.findByAltText(/QR code/)).toHaveAttribute(
    'src',
    'data:image/png;base64,AAAA',
  );
  expect(screen.getByRole('group', { name: 'Setup key' })).toHaveTextContent(
    'ABCD EFGH',
  );
  expect(screen.getByText('ceo@example.test')).toBeInTheDocument();
  const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-000${i}`);
  post.mockResolvedValueOnce({
    data: { mustResetPassword: false, recoveryCodes: codes },
  });
  fireEvent.change(codeInput(), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on and sign in' }));
  expect(
    await screen.findByRole('list', { name: 'Recovery codes' }),
  ).toHaveTextContent(codes[9]!);
  const cont = screen.getByRole('button', { name: 'Continue' });
  expect(cont).toBeDisabled();
  expect(onSignedIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/saved my recovery codes/));
  fireEvent.click(cont);
  expect(onSignedIn).toHaveBeenCalledWith({ mustResetPassword: false });
  expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/enrolment', {
    challengeToken: token,
  });
  expect(post).toHaveBeenCalledWith('/auth/mfa/challenge/enrolment/confirm', {
    challengeToken: token,
    code: '123456',
  });
});

describe('feedback follow-up (FEEDBACK_REPORT §6, Auth + MFA items 5-8)', () => {
  it('item 5: the code was accepted but finishing the sign-in failed → "We couldn’t finish signing you in" + Back to sign in (never a retry on the spent challenge)', async () => {
    const onSignedIn = jest.fn().mockRejectedValue(new Error('session not readable'));
    const { onRestart } = mount({ onSignedIn });
    post.mockResolvedValueOnce({ data: { mustResetPassword: false } });
    fireEvent.change(codeInput(), { target: { value: '123456' } });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'We couldn’t finish signing you in' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('6-digit authentication code')).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'Back to sign in' });
    expect(back).toHaveFocus();
    expect(back).toHaveAccessibleDescription(/Your code was accepted, but signing in didn’t complete/);
    expect(toastError).not.toHaveBeenCalled();
    fireEvent.click(back);
    expect(onRestart).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1); // no cancel / verify on the spent challenge
  });

  it('item 6: Continue after the enrolment codes runs once (busy label), and a failure is caught (finish-failed view)', async () => {
    let fail: (e: unknown) => void = () => undefined;
    const onSignedIn = jest.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    mount({ requirement: 'enroll', onSignedIn });
    post.mockResolvedValueOnce({ data: { otpauthUri: 'otpauth://totp/Crewflow:a?secret=A', qrDataUrl: 'data:image/png;base64,AA', manualKey: 'AAAA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up now' }));
    await screen.findByAltText(/QR code/);
    post.mockResolvedValueOnce({ data: { mustResetPassword: false, recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] } });
    fireEvent.change(codeInput(), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on and sign in' }));
    fireEvent.click(await screen.findByLabelText(/saved my recovery codes/));
    const cont = screen.getByRole('button', { name: 'Continue' });
    fireEvent.click(cont);
    fireEvent.click(cont);
    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    fail(new Error('identity read-back failed'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'We couldn’t finish signing you in' }),
    ).toBeInTheDocument();
  });

  it('item 7: "Set up now" double click posts once; the code field is disabled while it is being checked', async () => {
    mount({ requirement: 'enroll' });
    let deliver: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => (deliver = resolve)));
    const start = screen.getByRole('button', { name: 'Set up now' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(post).toHaveBeenCalledTimes(1);
    deliver({ data: { otpauthUri: 'otpauth://totp/Crewflow:a?secret=A', qrDataUrl: 'data:image/png;base64,AA', manualKey: 'AAAA' } });
    await screen.findByAltText(/QR code/);
    post.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.change(codeInput(), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on and sign in' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(codeInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeDisabled();
  });

  it('item 8: every failure is announced once: inline alert OR the new view, never a toast as well', async () => {
    mount();
    post.mockRejectedValueOnce(httpError(503, { message: 'Internal server error' }));
    fireEvent.change(codeInput(), { target: { value: '111111' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    post.mockRejectedValueOnce(httpError(429, { code: 'MFA_RATE_LIMITED', retryAfter: 60 }));
    fireEvent.change(codeInput(), { target: { value: '222222' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Too many attempts' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('while a code is being verified, "Use a recovery code" and "Back to sign in" are disabled; the code is kept', async () => {
    mount();
    post.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.change(codeInput(), { target: { value: '333333' } });
    expect(await screen.findByRole('button', { name: 'Verifying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use a recovery code' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeDisabled();
    expect(codeInput()).toHaveValue('333333');
  });
});
