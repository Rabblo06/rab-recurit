import { api } from '../../../shared/api';
import {
  challengeFailureOf,
  confirmSettingsEnrolment,
  disableTwoFactor,
  mfaErrorMessage,
  otpauthLabel,
  proofFailureOf,
  regenerateRecoveryCodes,
  startSettingsEnrolment,
  triesLeftLabel,
} from './mfaApi';

jest.mock('../../../shared/api', () => ({ api: { post: jest.fn() } }));

const post = api.post as jest.Mock;
const httpError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

beforeEach(() => post.mockReset());

describe('challengeFailureOf (the server’s failure states, never a client count)', () => {
  it('maps every documented code', () => {
    expect(
      challengeFailureOf(
        httpError(401, { code: 'MFA_CODE_INVALID', attemptsRemaining: 4 }),
      ),
    ).toEqual({ kind: 'invalid', attemptsRemaining: 4 });
    expect(
      challengeFailureOf(httpError(401, { code: 'MFA_CODE_INVALID' })),
    ).toEqual({ kind: 'invalid' });
    expect(
      challengeFailureOf(
        httpError(401, { code: 'MFA_CODE_INVALID', attemptsRemaining: 'x' }),
      ),
    ).toEqual({ kind: 'invalid' });
    expect(
      challengeFailureOf(httpError(401, { code: 'MFA_CHALLENGE_EXPIRED' })),
    ).toEqual({ kind: 'expired' });
    expect(
      challengeFailureOf(httpError(401, { code: 'MFA_CHALLENGE_EXHAUSTED' })),
    ).toEqual({ kind: 'locked' });
    expect(
      challengeFailureOf(
        httpError(429, { code: 'MFA_RATE_LIMITED', retryAfter: 61 }),
      ),
    ).toEqual({ kind: 'rate-limited', minutes: 2 });
    expect(challengeFailureOf(httpError(500, {})).kind).toBe('other');
  });

  it('tries-left copy', () => {
    expect(triesLeftLabel(3)).toBe('3 tries left.');
    expect(triesLeftLabel(1)).toBe('1 try left.');
    expect(triesLeftLabel(0)).toBe('No tries left.');
  });
});

it('mfaErrorMessage never shows a raw server message for an unknown code (the app normaliser decides)', () => {
  const technical = httpError(400, {
    message: 'QueryFailedError: relation "core.user" does not exist',
  });
  expect(
    mfaErrorMessage(technical, 'Couldn’t start the setup. Try again.'),
  ).toBe('Couldn’t start the setup. Try again.');
});

it('proofFailureOf: STEP_UP_REQUIRED → re-auth; wrong password; bad code (TOTP or recovery)', () => {
  expect(
    proofFailureOf(httpError(403, { code: 'STEP_UP_REQUIRED', mfa: true })),
  ).toEqual({ kind: 'needs-reauth' });
  expect(
    proofFailureOf(
      httpError(403, {
        statusCode: 403,
        message: 'Re-enter your current password to continue.',
      }),
    ),
  ).toEqual({ kind: 'wrong-password' });
  expect(
    proofFailureOf(httpError(403, { code: 'STEP_UP_MFA_INVALID' })),
  ).toMatchObject({
    kind: 'bad-code',
    message: expect.stringContaining('authenticator'),
  });
  expect(
    proofFailureOf(httpError(403, { code: 'STEP_UP_MFA_INVALID' }), true),
  ).toMatchObject({
    kind: 'bad-code',
    message: expect.stringContaining('recovery code'),
  });
});

it('the three self-service calls opt out of the global step-up prompt (the dialog collects its own proof) and send only the proof given', async () => {
  post.mockResolvedValue({ data: { recoveryCodes: ['A'] } });
  await startSettingsEnrolment({ currentPassword: 'pw' });
  await startSettingsEnrolment({});
  await regenerateRecoveryCodes({ currentPassword: 'pw', code: '123456' });
  await disableTwoFactor({ code: 'ABCD-EFGH-JKMN-PQRS' });
  expect(post.mock.calls[0]).toEqual([
    '/auth/mfa/enrolment',
    { currentPassword: 'pw' },
    { _stepUpRetried: true },
  ]);
  expect(post.mock.calls[1]).toEqual([
    '/auth/mfa/enrolment',
    {},
    { _stepUpRetried: true },
  ]);
  expect(post.mock.calls[2]).toEqual([
    '/auth/mfa/recovery-codes',
    { currentPassword: 'pw', code: '123456' },
    { _stepUpRetried: true },
  ]);
  expect(post.mock.calls[3]).toEqual([
    '/auth/mfa/disable',
    { code: 'ABCD-EFGH-JKMN-PQRS' },
    { _stepUpRetried: true },
  ]);
});

describe('confirmSettingsEnrolment', () => {
  it('a wrong code (400 MFA_CODE_INVALID) rejects once, through the normal error path, with no retry', async () => {
    post.mockRejectedValueOnce(httpError(400, { code: 'MFA_CODE_INVALID' }));
    await expect(confirmSettingsEnrolment('000000')).rejects.toMatchObject({
      response: { status: 400, data: { code: 'MFA_CODE_INVALID' } },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([
      '/auth/mfa/enrolment/confirm',
      { code: '000000' },
    ]);
  });

  it('success returns the server’s codes', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { recoveryCodes: ['A', 'B'] },
    });
    await expect(confirmSettingsEnrolment('123456')).resolves.toEqual({
      recoveryCodes: ['A', 'B'],
    });
  });
});

it('otpauthLabel reads the issuer and account from the server URI', () => {
  expect(
    otpauthLabel(
      'otpauth://totp/Crewflow:issac%40example-agency.test?secret=AB&issuer=Crewflow',
    ),
  ).toEqual({ issuer: 'Crewflow', account: 'issac@example-agency.test' });
  expect(
    otpauthLabel('otpauth://totp/me%40x.test?secret=AB&issuer=Acme'),
  ).toEqual({ issuer: 'Acme', account: 'me@x.test' });
  expect(otpauthLabel('nonsense')).toEqual({ issuer: 'Crewflow', account: '' });
});

it('feedback follow-up: a 5xx says what failed (the caller’s fallback), not the generic text', () => {
  expect(mfaErrorMessage(httpError(503, { message: 'Internal server error' }), 'Couldn’t turn off two-factor authentication. Try again.')).toBe(
    'Couldn’t turn off two-factor authentication. Try again.',
  );
});
