import axios from 'axios';

/**
 * Wave 4 lane MFA — the browser side of the second factor. Nothing here stores a secret, a code or a recovery code:
 * the provisioning material and the recovery codes are shown once from the server's response and live only in
 * component state until the user leaves the screen.
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

/** The second-factor challenge carried by a 409 SECOND_FACTOR_REQUIRED error, or null for any other error. */
export function secondFactorChallengeOf(error: unknown): SecondFactorChallenge | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const body = error.response.data as Partial<SecondFactorChallenge> & { code?: string };
  if (body?.code !== 'SECOND_FACTOR_REQUIRED' || typeof body.challengeToken !== 'string') return null;
  return { challengeToken: body.challengeToken, requirement: body.requirement === 'enroll' ? 'enroll' : 'verify', challengeExpiresAt: body.challengeExpiresAt };
}

/** The server's stable error code (`MFA_CODE_INVALID`, `MFA_CHALLENGE_EXPIRED`, …), if any. */
export function mfaErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

/** Human copy for the second-factor errors (uniform: never says whether a code was "close"). */
export function mfaErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'Something went wrong. Please try again.';
  if (!error.response) return 'Unable to reach the server. Check your connection and try again.';
  const status = error.response.status;
  const data = error.response.data as { code?: string; message?: string; retryAfter?: number } | undefined;
  switch (data?.code) {
    case 'MFA_CODE_INVALID':
    case 'STEP_UP_MFA_INVALID':
      return 'That code didn’t work. Check your authenticator app and try again.';
    case 'MFA_CHALLENGE_EXPIRED':
      return 'Your sign-in expired. Please sign in again.';
    case 'MFA_CHALLENGE_EXHAUSTED':
      return 'Too many incorrect codes. Please sign in again.';
    case 'MFA_RATE_LIMITED': {
      const minutes = Math.max(1, Math.ceil(Number(data.retryAfter ?? 60) / 60));
      return `Too many attempts. Please try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    }
    default:
      break;
  }
  if (status === 403 && data?.message) return data.message;
  if (status >= 500) return 'This is temporarily unavailable. Try again in a moment.';
  return data?.message ?? 'Something went wrong. Please try again.';
}

/** Codes that mean the pending sign-in is gone: the only way forward is signing in again. */
export function isChallengeGone(error: unknown): boolean {
  const code = mfaErrorCode(error);
  return code === 'MFA_CHALLENGE_EXPIRED' || code === 'MFA_CHALLENGE_EXHAUSTED' || code === 'MFA_ALREADY_ENABLED';
}

/** Recovery codes as a plain-text file, saved locally by the browser (never uploaded or cached). */
export function downloadRecoveryCodes(codes: readonly string[], accountLabel = 'your account'): void {
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
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crewflow-recovery-codes.txt';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
