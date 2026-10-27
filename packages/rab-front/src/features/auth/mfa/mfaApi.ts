import axios, { type AxiosRequestConfig } from 'axios';

import { api } from '../../../shared/api';
import { getApiErrorMessage } from '../../../shared/lib/apiError';

/**
 * Wave 4 lane MFA — the browser side of the second factor. Nothing here stores a secret, a code or a recovery code:
 * the provisioning material and the recovery codes are shown once from the server's response and live only in
 * component state until the user leaves the screen (never localStorage/sessionStorage, a URL, a log or analytics).
 */

/** The 409 body a sign-in returns while it waits for the second factor (`AuthService.completeLogin`). */
export interface SecondFactorChallenge {
  challengeToken: string;
  requirement: 'verify' | 'enroll';
  challengeExpiresAt?: string;
}

export interface EnrolmentMaterial {
  otpauthUri: string;
  qrDataUrl: string;
  manualKey: string;
}

export type SsoProvider = 'google' | 'microsoft';

/** `GET /auth/mfa` (rab-server `MfaManagementService.status`). Every visible value on the Security page comes from here. */
export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  /** Size of a recovery-code set ("8 of 10"); 0 while off. Optional so an older server still renders "8 remaining". */
  recoveryCodesTotal?: number;
  enforced: boolean;
  enrolmentAvailable: boolean;
  mobileChallenged: boolean;
  /** Absent on an older server → treated as a password account (the server decides anyway). */
  hasPassword?: boolean;
  linkedProviders?: SsoProvider[];
  /** Linked providers this account can re-authenticate with right now (Microsoft only today; Google is refused, TO-3). */
  ssoReauthProviders?: SsoProvider[];
}

export const MFA_STATUS_KEY = ['auth', 'mfa'] as const;

/** Client constant (UI_PLAN §2): at or below this many unused recovery codes the Security page warns. */
export const LOW_RECOVERY_CODES = 3;

export const PROVIDER_LABEL: Record<SsoProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

export function onlyProviders(list: unknown): SsoProvider[] {
  return Array.isArray(list)
    ? list.filter((p): p is SsoProvider => p === 'google' || p === 'microsoft')
    : [];
}

/** The second-factor challenge carried by a 409 SECOND_FACTOR_REQUIRED error, or null for any other error. */
export function secondFactorChallengeOf(
  error: unknown,
): SecondFactorChallenge | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const body = error.response.data as Partial<SecondFactorChallenge> & {
    code?: string;
  };
  if (
    body?.code !== 'SECOND_FACTOR_REQUIRED' ||
    typeof body.challengeToken !== 'string'
  )
    return null;
  return {
    challengeToken: body.challengeToken,
    requirement: body.requirement === 'enroll' ? 'enroll' : 'verify',
    challengeExpiresAt: body.challengeExpiresAt,
  };
}

/** The server's stable error code (`MFA_CODE_INVALID`, `MFA_CHALLENGE_EXPIRED`, …), if any. */
export function mfaErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

function retryMinutes(error: unknown): number {
  const data = axios.isAxiosError(error)
    ? (error.response?.data as { retryAfter?: unknown } | undefined)
    : undefined;
  const seconds = Number(data?.retryAfter);
  return Math.max(
    1,
    Math.ceil((Number.isFinite(seconds) && seconds > 0 ? seconds : 60) / 60),
  );
}

export function minutesLabel(minutes: number): string {
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Human copy for the second-factor errors (uniform: never says whether a code was "close"). Known codes get fixed copy;
 * everything else goes through the app's one error normaliser (`getApiErrorMessage`), so a raw server message is never
 * shown.
 */
export function mfaErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  switch (mfaErrorCode(error)) {
    case 'MFA_CODE_INVALID':
    case 'STEP_UP_MFA_INVALID':
      return 'That code didn’t work. Check your authenticator app and try again.';
    case 'STEP_UP_MFA_REQUIRED':
      return 'Enter the code from your authenticator app to continue.';
    case 'MFA_CHALLENGE_EXPIRED':
      return 'Your sign-in expired. Please sign in again.';
    case 'MFA_CHALLENGE_EXHAUSTED':
      return 'Too many incorrect codes. Please sign in again.';
    case 'MFA_RATE_LIMITED':
      return `Too many attempts. Please try again in ${minutesLabel(retryMinutes(error))}.`;
    case 'MFA_ENROLMENT_DISABLED':
      return 'Two-factor setup isn’t available right now. Try again later.';
    case 'MFA_ALREADY_ENABLED':
      return 'Two-factor authentication is already on for your account.';
    case 'MFA_NOT_ENABLED':
      return 'Two-factor authentication is already off for your account.';
    case 'MFA_REQUIRED_BY_POLICY':
      return 'Your organisation requires two-factor authentication for your account, so it can’t be turned off.';
    default:
      // A 5xx carries nothing safe to show, so "what failed" (the caller's fallback) says more than the generic text:
      // the same rule as the shared `notifyApiError`.
      return getApiErrorMessage(error, { fallback, messages: { server: fallback } });
  }
}

/** Codes that mean the pending sign-in is gone: the only way forward is signing in again. */
export function isChallengeGone(error: unknown): boolean {
  const code = mfaErrorCode(error);
  return (
    code === 'MFA_CHALLENGE_EXPIRED' ||
    code === 'MFA_CHALLENGE_EXHAUSTED' ||
    code === 'MFA_ALREADY_ENABLED'
  );
}

/**
 * What a failed `POST /auth/mfa/challenge/verify` means for the sign-in screen (rab-server `MfaLoginService` failure
 * states, STEP1_REPORT "Coordinator additions"). `attemptsRemaining` is passed through ONLY when the server sent it —
 * the client never counts attempts itself.
 */
export type ChallengeFailure =
  | { kind: 'invalid'; attemptsRemaining?: number }
  | { kind: 'expired' }
  | { kind: 'locked' }
  | { kind: 'rate-limited'; minutes: number }
  | { kind: 'other'; message: string };

export function challengeFailureOf(error: unknown): ChallengeFailure {
  const code = mfaErrorCode(error);
  if (code === 'MFA_CODE_INVALID') {
    const raw = (
      axios.isAxiosError(error)
        ? (error.response?.data as { attemptsRemaining?: unknown } | undefined)
        : undefined
    )?.attemptsRemaining;
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
      ? { kind: 'invalid', attemptsRemaining: raw }
      : { kind: 'invalid' };
  }
  if (code === 'MFA_CHALLENGE_EXPIRED' || code === 'MFA_ALREADY_ENABLED')
    return { kind: 'expired' };
  if (code === 'MFA_CHALLENGE_EXHAUSTED') return { kind: 'locked' };
  if (code === 'MFA_RATE_LIMITED')
    return { kind: 'rate-limited', minutes: retryMinutes(error) };
  return { kind: 'other', message: mfaErrorMessage(error) };
}

export function triesLeftLabel(attemptsRemaining: number): string {
  if (attemptsRemaining === 0) return 'No tries left.';
  return `${attemptsRemaining} ${attemptsRemaining === 1 ? 'try' : 'tries'} left.`;
}

/** The server's message for a wrong `currentPassword` (rab-server step-up-reauth.service.ts `PASSWORD_MESSAGE`). */
const WRONG_PASSWORD_MESSAGE = 'Re-enter your current password to continue.';

/**
 * What a failed self-service call (enrol start, regenerate, disable) means for its dialog. `needs-reauth` = the server
 * wants a fresh identity proof this dialog must collect itself (an account without a password whose sign-in grant has
 * passed, or that has not re-authenticated with its provider yet).
 */
export type ProofFailure =
  | { kind: 'needs-reauth' }
  | { kind: 'wrong-password' }
  | { kind: 'bad-code'; message: string }
  | { kind: 'other'; message: string };

export function proofFailureOf(
  error: unknown,
  usedRecoveryCode = false,
): ProofFailure {
  const code = mfaErrorCode(error);
  if (code === 'STEP_UP_REQUIRED') return { kind: 'needs-reauth' };
  if (code === 'STEP_UP_MFA_INVALID' || code === 'MFA_CODE_INVALID') {
    return {
      kind: 'bad-code',
      message: usedRecoveryCode
        ? 'That recovery code didn’t work. Check it and try again.'
        : 'That code didn’t work. Check your authenticator app and try again.',
    };
  }
  if (code === 'STEP_UP_MFA_REQUIRED')
    return {
      kind: 'bad-code',
      message: 'Enter the code from your authenticator app to continue.',
    };
  if (code === 'MFA_RATE_LIMITED')
    return { kind: 'bad-code', message: mfaErrorMessage(error) };
  if (
    axios.isAxiosError(error) &&
    error.response?.status === 403 &&
    (error.response.data as { message?: unknown } | undefined)?.message ===
      WRONG_PASSWORD_MESSAGE
  ) {
    return { kind: 'wrong-password' };
  }
  return { kind: 'other', message: mfaErrorMessage(error) };
}

/**
 * The Security dialogs collect the identity proof themselves (password, a code, or the SSO hand-off), so a
 * `403 STEP_UP_REQUIRED` from these three self-service routes must come back to the dialog instead of opening the
 * global "Confirm it's you" prompt on top of it. `_stepUpRetried` is the existing per-request opt-out of
 * `shared/lib/step-up-retry.ts` (the interceptor skips a request already marked as handled). Proof is still enforced
 * entirely by the server.
 */
const OWN_PROOF = { _stepUpRetried: true } as unknown as AxiosRequestConfig;

export interface OptionalProof {
  currentPassword?: string;
  code?: string;
}

function proofBody(proof: OptionalProof): OptionalProof {
  const body: OptionalProof = {};
  if (proof.currentPassword) body.currentPassword = proof.currentPassword;
  if (proof.code) body.code = proof.code;
  return body;
}

export async function startSettingsEnrolment(
  proof: OptionalProof,
): Promise<EnrolmentMaterial> {
  return (
    await api.post<EnrolmentMaterial>(
      '/auth/mfa/enrolment',
      proofBody({ currentPassword: proof.currentPassword }),
      OWN_PROOF,
    )
  ).data;
}

/**
 * `POST /auth/mfa/enrolment/confirm`. A wrong code is a 400 `MFA_CODE_INVALID` (the caller is signed in, so it is a
 * validation failure, never an expired session); it reaches the dialog through the normal error path.
 */
export async function confirmSettingsEnrolment(
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const response = await api.post<{ recoveryCodes: string[] }>(
    '/auth/mfa/enrolment/confirm',
    { code },
  );
  return { recoveryCodes: response.data.recoveryCodes };
}

export async function regenerateRecoveryCodes(
  proof: OptionalProof,
): Promise<string[]> {
  return (
    await api.post<{ recoveryCodes: string[] }>(
      '/auth/mfa/recovery-codes',
      proofBody(proof),
      OWN_PROOF,
    )
  ).data.recoveryCodes;
}

export async function disableTwoFactor(proof: OptionalProof): Promise<void> {
  await api.post('/auth/mfa/disable', proofBody(proof), OWN_PROOF);
}

/** Issuer and account name from the server's `otpauth://totp/<issuer>:<account>?…` URI (display only). */
export function otpauthLabel(uri: string): { issuer: string; account: string } {
  const match = /^otpauth:\/\/totp\/([^?]*)(?:\?(.*))?$/i.exec(uri);
  if (!match) return { issuer: 'Crewflow', account: '' };
  let label = '';
  try {
    label = decodeURIComponent(match[1] ?? '');
  } catch {
    label = match[1] ?? '';
  }
  const queryIssuer = new URLSearchParams(match[2] ?? '').get('issuer');
  const colon = label.indexOf(':');
  const issuer =
    (colon >= 0 ? label.slice(0, colon) : queryIssuer) ||
    queryIssuer ||
    'Crewflow';
  const account = colon >= 0 ? label.slice(colon + 1) : label;
  return { issuer: issuer.trim(), account: account.trim() };
}

/** Recovery codes as a plain-text file, saved locally by the browser (never uploaded or cached). */
export function downloadRecoveryCodes(
  codes: readonly string[],
  accountLabel = 'your account',
): void {
  const body = [
    'Crewflow two-factor recovery codes',
    `Account: ${accountLabel}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each code works once. Keep them somewhere safe and private.',
    '',
    ...codes,
    '',
  ].join('\n');
  const url = URL.createObjectURL(
    new Blob([body], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crewflow-recovery-codes.txt';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
