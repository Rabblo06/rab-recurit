import axios, { type AxiosInstance } from 'axios';

/**
 * Lane D (M10-2) — step-up ("confirm it's you"). A sensitive server operation answers 403 `STEP_UP_REQUIRED` (or, on the
 * legacy password-confirmed actions with AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS on, `STEP_UP_MFA_REQUIRED`) when THIS
 * session has not re-proved the password (+ authenticator code when enrolled) within the server's window. The handler
 * (features/auth/stepup — `shared/` never imports a feature, it registers itself here) asks for that proof, calls
 * `POST /auth/step-up`, and the original request is replayed ONCE. Concurrent refusals (a bulk action) share one
 * prompt. This is UX only: the server re-checks the grant on the replay and on every later call.
 */
export type StepUpHandler = (challenge: { mfa: boolean }) => Promise<boolean>;

const STEP_UP_CODES = new Set(['STEP_UP_REQUIRED', 'STEP_UP_MFA_REQUIRED']);

let stepUpHandler: StepUpHandler | null = null;
let stepUpInFlight: Promise<boolean> | null = null;

export function registerStepUpHandler(handler: StepUpHandler): () => void {
  stepUpHandler = handler;
  return () => {
    if (stepUpHandler === handler) stepUpHandler = null;
  };
}

export function stepUpChallengeOf(error: unknown): { mfa: boolean } | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 403) return null;
  const body = error.response.data as { code?: string; mfa?: boolean } | undefined;
  if (!body?.code || !STEP_UP_CODES.has(body.code)) return null;
  return { mfa: body.code === 'STEP_UP_MFA_REQUIRED' || body.mfa === true };
}

/** Installs the step-up replay as a response interceptor (registered BEFORE the 401/refresh interceptor). */
export function installStepUpRetry(instance: AxiosInstance): void {
  instance.interceptors.response.use(undefined, async (error) => {
    const original = error?.config as (Record<string, unknown> & { url?: string; _stepUpRetried?: boolean }) | undefined;
    const challenge = stepUpChallengeOf(error);
    if (!challenge || !original || original._stepUpRetried || !stepUpHandler || String(original.url ?? '').includes('/auth/step-up')) {
      return Promise.reject(error);
    }
    original._stepUpRetried = true;
    stepUpInFlight ??= stepUpHandler(challenge).finally(() => {
      stepUpInFlight = null;
    });
    if (await stepUpInFlight) return instance(original);
    return Promise.reject(error);
  });
}
