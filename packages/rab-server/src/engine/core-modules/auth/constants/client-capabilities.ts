/**
 * Account security step 1 (P3): a mobile client declares which sign-in steps it can complete with
 * `X-Client-Capabilities: mfa-verify[,mfa-enrol,…]` (comma-separated tokens, case-insensitive, whitespace ignored).
 *
 * Client-ASSERTED and never a credential: the header can only ENABLE the challenge path for a client that says it can
 * finish it. It can never skip, weaken or replace a check — a client that omits it (an old build) gets
 * 409 CLIENT_UPDATE_REQUIRED instead of a challenge it cannot complete, and a client that lies about it simply receives
 * a challenge it then cannot finish (no session either way).
 */
export const CLIENT_CAPABILITIES_HEADER = 'x-client-capabilities';

/** The mobile client can show the second-factor code step and finish a `verify` challenge. */
export const CAPABILITY_MFA_VERIFY = 'mfa-verify';

const MAX_HEADER_LENGTH = 512;
const MAX_TOKENS = 16;

/** Parses the raw header value(s). Malformed / oversized input yields no capabilities (fail closed). */
export function parseClientCapabilities(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof joined !== 'string' || joined.length > MAX_HEADER_LENGTH) return [];
  const tokens = joined
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(token));
  return [...new Set(tokens)].slice(0, MAX_TOKENS);
}

export function hasClientCapability(capabilities: readonly string[] | undefined, capability: string): boolean {
  return (capabilities ?? []).includes(capability.toLowerCase());
}

/** The answer an old mobile client gets instead of a challenge (its pre-MFA builds display `message` as-is). */
export const CLIENT_UPDATE_REQUIRED_BODY = {
  code: 'CLIENT_UPDATE_REQUIRED',
  message: 'Update Crewflow to sign in. Your account uses two-factor authentication, and this version of the app can’t ask for your code.',
} as const;
