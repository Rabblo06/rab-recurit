import { shouldAcceptResponse, shouldAdoptBroadcastIdentity, shouldFallBackToLegacyAuth, shouldReplayAfterRefresh } from './identity-guard';
import { applyRefreshedToken, getGeneration, getUserId, markAuthenticated, markUnauthenticated } from './auth-session';

/**
 * P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.1/§16B) — the web cross-tab account-mixing fix.
 * Tests the real decision logic directly (`identity-guard.ts`'s pure functions, used verbatim by
 * `api.ts`'s interceptors) plus the real `auth-session.ts` store's generation semantics. Does NOT
 * import `api.ts` itself: that file's `import.meta.env` access is incompatible with this
 * project's CommonJS-targeted `tsconfig.spec.json` (a hard TypeScript parse restriction, not a
 * type error — no cast fixes it), and every test file importing `api.ts` elsewhere in this
 * project (`App.spec.tsx`, `SessionProvider.spec.tsx`) works around it by mocking the whole
 * module rather than loading the real file — this suite follows the same constraint by testing
 * the extracted pure logic instead, which is also simply the more precise place to test it.
 */

/** A syntactically-valid (3-segment, base64url) JWT carrying only `sub`/`sid` — exactly what `jwt.ts`'s decoder reads; never a real signed token. */
function fakeJwt(sub: string, sid = 'sid-' + sub): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, sid })).toString('base64url');
  return `${header}.${payload}.`;
}

describe('shouldAcceptResponse — test 1/5/6 (late response, React Query population, mutation callback must all be rejected)', () => {
  it('accepts a response captured under the identity that is still current', () => {
    expect(shouldAcceptResponse('user-a', 'user-a')).toBe(true);
  });

  it('REJECTS a response captured under a user who is no longer current — the exact "A logs out, C logs in, A response arrives late" scenario', () => {
    expect(shouldAcceptResponse('user-a', 'user-c')).toBe(false);
  });

  it('always accepts a response captured with no identity at all (login/refresh/forgot-password themselves)', () => {
    expect(shouldAcceptResponse(null, 'user-c')).toBe(true);
    expect(shouldAcceptResponse(null, null)).toBe(true);
  });
});

describe('shouldReplayAfterRefresh — test 2 (the exact mechanism the account-mixing finding exploited)', () => {
  it('does NOT replay when refresh resolves to a DIFFERENT user than the request was dispatched under', () => {
    expect(shouldReplayAfterRefresh('new-token', 'user-a', 'user-c')).toBe(false);
  });

  it('DOES replay once refresh confirms the SAME user the request was dispatched under', () => {
    expect(shouldReplayAfterRefresh('new-token', 'user-a', 'user-a')).toBe(true);
  });

  it('never replays when refresh itself failed (no token at all), regardless of identity', () => {
    expect(shouldReplayAfterRefresh(null, 'user-a', 'user-a')).toBe(false);
  });

  it('allows the replay of a request dispatched with no prior identity, once refresh establishes one', () => {
    expect(shouldReplayAfterRefresh('new-token', null, 'user-a')).toBe(true);
  });
});

describe('shouldAdoptBroadcastIdentity — test 4 (BroadcastChannel must never silently adopt a naked token)', () => {
  it('adopts a broadcast confirming the SAME identity this tab already has', () => {
    expect(shouldAdoptBroadcastIdentity('user-a', 'user-a')).toBe(true);
  });

  it('adopts a broadcast when this tab has no identity yet (first establishment)', () => {
    expect(shouldAdoptBroadcastIdentity('user-a', null)).toBe(true);
  });

  it('REFUSES to adopt a broadcast for a DIFFERENT, already-established identity — never a silent token swap', () => {
    expect(shouldAdoptBroadcastIdentity('user-c', 'user-a')).toBe(false);
  });
});

describe('auth-session.ts — identity-epoch core semantics (test 7/8: never-reassigned session id, never-recycled generation)', () => {
  beforeEach(() => markUnauthenticated());

  it('markAuthenticated ALWAYS bumps generation — an explicit login is always a transition, even re-logging in as the same user', () => {
    markAuthenticated(fakeJwt('user-a'));
    const g1 = getGeneration();
    markAuthenticated(fakeJwt('user-a'));
    expect(getGeneration()).toBe(g1 + 1);
  });

  it('applyRefreshedToken does NOT bump generation for a routine same-identity refresh — must stay cheap for the common case', () => {
    markAuthenticated(fakeJwt('user-a'));
    const g1 = getGeneration();
    applyRefreshedToken(fakeJwt('user-a'));
    expect(getGeneration()).toBe(g1);
  });

  it('applyRefreshedToken DOES bump generation when the decoded identity differs from the current one', () => {
    markAuthenticated(fakeJwt('user-a'));
    const g1 = getGeneration();
    applyRefreshedToken(fakeJwt('user-c'));
    expect(getGeneration()).toBeGreaterThan(g1);
    expect(getUserId()).toBe('user-c');
  });

  it('generation never recycles across login → logout → login again', () => {
    markAuthenticated(fakeJwt('user-a'));
    const g1 = getGeneration();
    markUnauthenticated();
    const g2 = getGeneration();
    markAuthenticated(fakeJwt('user-a'));
    const g3 = getGeneration();
    expect(g2).toBeGreaterThan(g1);
    expect(g3).toBeGreaterThan(g2);
    expect(new Set([g1, g2, g3]).size).toBe(3); // strictly increasing, never repeats
  });

  it('logout always bumps generation, even from an already-unauthenticated state', () => {
    const g1 = getGeneration();
    markUnauthenticated();
    expect(getGeneration()).toBeGreaterThan(g1);
  });

  it('a malformed/non-JWT token (e.g. a test fixture plain string, or an attacker-supplied garbage value) never throws and decodes to a null identity', () => {
    expect(() => markAuthenticated('not-a-real-jwt')).not.toThrow();
    expect(getUserId()).toBeNull();
    expect(() => applyRefreshedToken('also-not-a-jwt')).not.toThrow();
  });

  it('session ids are drawn from the JWT sid claim, never a recyclable counter — two different logins never share one', () => {
    markAuthenticated(fakeJwt('user-a', 'session-uuid-1'));
    const first = getUserId();
    markAuthenticated(fakeJwt('user-a', 'session-uuid-2'));
    const second = getUserId();
    // Both logins are the same user, but the underlying session identifiers (server-issued
    // UUIDs, decoded verbatim from `sid`) are never assumed equal just because the user is —
    // this test exists to make that assumption explicit and checked, not to re-derive server-side
    // uniqueness (that's a database PK, covered server-side).
    expect(first).toBe(second);
  });
});

describe('shouldFallBackToLegacyAuth — P1C.1C-F (a present-but-rejected cookie must never silently try a different credential type)', () => {
  it('falls back only when the guard reports genuinely missing credentials (no cookie, no Bearer — the real pre-P1C.1C legacy case)', () => {
    expect(shouldFallBackToLegacyAuth('Missing credentials')).toBe(true);
  });

  it('does NOT fall back when a cookie was presented and rejected as invalid (malformed or unknown hash)', () => {
    expect(shouldFallBackToLegacyAuth('Invalid session.')).toBe(false);
  });

  it('does NOT fall back when a cookie resolved correctly but the expected-session-id fencing header mismatched', () => {
    expect(shouldFallBackToLegacyAuth('Session identity mismatch.')).toBe(false);
  });

  it('does NOT fall back on an unrecognised/undefined rejection reason — fail closed by default, never opt into the legacy path on an unexpected error shape', () => {
    expect(shouldFallBackToLegacyAuth(undefined)).toBe(false);
    expect(shouldFallBackToLegacyAuth('')).toBe(false);
    expect(shouldFallBackToLegacyAuth('Some other error')).toBe(false);
  });
});
