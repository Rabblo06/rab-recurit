import AuthLayout from './AuthLayout';
import { loginError, SessionNotEstablishedError } from './authErrors';
import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandGoogle, IconBrandWindows, IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, getLastMeSnapshot, resolveIdentityViaCookie, withAuthLock } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';
import { isSafeWorkspaceUrl, useWorkspaceHost } from '../../shared/lib/workspace-host';
import MfaChallengeStep from './mfa/MfaChallengeStep';
import { SecondFactorChallenge, secondFactorChallengeOf } from './mfa/mfaApi';
import { continueOnWorkspaceHost } from './workspaceHandoff';

/**
 * Legacy (non-handoff) Google/Microsoft sign-in hands a pending second factor back as `/login#mfa=<token>&requirement=…`
 * (fragment only: never sent to a server, never in a Referer). Read once and stripped from the address bar immediately.
 */
function takeChallengeFromFragment(): SecondFactorChallenge | null {
  if (!window.location.hash.startsWith('#mfa=')) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const token = params.get('mfa');
  if (!token || !/^mfc_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { challengeToken: token, requirement: params.get('requirement') === 'enroll' ? 'enroll' : 'verify' };
}

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.8) — the server owns provider availability.
 * Fetched fresh on every mount, never compiled into a Vite env var: changing server ENV +
 * restart is enough for button availability to change, no frontend rebuild required.
 */
interface AuthProvidersConfig {
  authProviders: { password: boolean; google: boolean; microsoft: boolean };
}

export default function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [challenge, setChallenge] = useState<SecondFactorChallenge | null>(() => takeChallengeFromFragment());
  const [step, setStep] = useState<'welcome' | 'email' | 'password'>('welcome');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  /** W6-E2E-02: where to sign in instead when this host is not the account's workspace (the server's default URL, validated). */
  const [signInElsewhere, setSignInElsewhere] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const coolingDown = cooldownUntil > now;

  // System-level view only (no organisation is known yet on this screen) — the server's own
  // AND-gate with the resolved organisation's flags is re-checked at the actual sign-in attempt
  // regardless of what this screen shows; hiding a button here is presentation only, never
  // the authority (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.8, P1C.1B brief §7).
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: async () => (await api.get<AuthProvidersConfig>('/auth/config')).data,
    staleTime: 60_000,
    // P1G (confirmed live via the waterfall audit): this screen is still mounted for one more
    // tick after a successful sign-in's qc.clear() below wipes the whole cache, including this
    // harmless entry — an enabled hook sees that and immediately refetches it, a real network
    // call whose result is thrown away the instant this component unmounts on the nav() right
    // after. Disabling for the duration of a sign-in attempt (same flag the submit button
    // already uses) stops that refetch without narrowing qc.clear()'s own blast radius.
    enabled: !loading,
  });
  const providers = config?.authProviders ?? { password: true, google: false, microsoft: false };
  // Wave 3 lane H: on a workspace host, name the workspace (public label / display name only — branding, never an
  // authority: the server still refuses this sign-in's session on this host if it belongs to another workspace).
  const host = useWorkspaceHost();
  const workspaceLabel = host.state === 'workspace' ? host.workspace.displayName ?? host.workspace.subdomain : null;
  const oauthError = searchParams.get('oauthError') === '1';

  function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setStep('password');
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current || Date.now() < cooldownUntil) return;
    pending.current = true;
    setError('');
    setSignInElsewhere(null);
    setLoading(true);
    try {
      // P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): serialized with refresh/logout across
      // every tab sharing this browser profile — a login racing a concurrent refresh/logout in
      // another tab must not be allowed to interleave at the Set-Cookie level.
      let data: { mustResetPassword: boolean };
      try {
        ({ data } = await withAuthLock(() => api.post('/auth/login', { email, password, applicationTarget: 'manager_web' })));
      } catch (err) {
        // Wave 4 lane MFA: the password was right, the second factor is next. Nothing was issued yet.
        const pendingFactor = secondFactorChallengeOf(err);
        if (!pendingFactor) throw err;
        setPassword('');
        setChallenge(pendingFactor);
        pending.current = false;
        setLoading(false);
        return;
      }
      await finishSignIn(data);
    } catch (err: any) {
      const failure = loginError(err);
      setError(failure.message);
      setSignInElsewhere(failure.signInUrl && isSafeWorkspaceUrl(failure.signInUrl, host) ? `${failure.signInUrl.replace(/\/+$/, '')}/login` : null);
      if (failure.cooldown) setCooldownUntil(Date.now() + failure.cooldown * 1000);
      pending.current = false;
      setLoading(false);
    }
  }

  /** Shared by the password step and the second-factor step: the session cookies are already set by the server. */
  async function finishSignIn(data: { mustResetPassword: boolean }): Promise<void> {
    // P1C.1C-F: neither the refresh token nor the new web session credential ever reaches this
    // JS — both are HttpOnly cookies the server just set (rab-server's AuthController). Identity
    // (userId/sessionId/generation, broadcast to other tabs) is derived the SAME way the
    // cookie-first bootstrap derives it: a cookie-authenticated `GET /auth/me`, never a decoded
    // JWT. Called directly (not through `bootstrapSession()`'s single-flight dedup) — this is a
    // ONE-TIME call guaranteed to run after a just-completed, genuinely new login, never a
    // candidate for deduping against some unrelated concurrent resolution. It updates the
    // identity store and broadcasts to other tabs internally — nothing further to do here.
    const ok = await resolveIdentityViaCookie();
    if (!ok) throw new SessionNotEstablishedError();
    // Defense-in-depth alongside LogoutDialog's own qc.clear() — any cached
    // query from a previous session on this tab (e.g. one that ended by
    // token expiry rather than an explicit logout) must not be shown to
    // whoever just authenticated.
    qc.clear();
    // P1G: `resolveIdentityViaCookie()` just fetched this exact user's `/auth/me` body — seed
    // it into the FRESHLY-cleared cache so OnboardingGate's own `['me']` query (about to mount
    // on the navigate below) gets a hit instead of re-fetching the same data a second time.
    const snapshot = getLastMeSnapshot();
    if (snapshot) qc.setQueryData(['me'], snapshot);
    // Wave 3+4: signed in on the default host but the account has its own workspace host → move there (single-use,
    // audience-bound handoff; the server picks the target). Stays here when there is none.
    if (!data.mustResetPassword && (await continueOnWorkspaceHost(host))) return;
    nav(data.mustResetPassword ? '/set-password' : '/');
    // Deliberately no `setLoading(false)` on this path (see the `enabled: !loading` comment on
    // the auth-config query above): this component is unmounting on the navigate just above,
    // not staying on screen, so there's nothing to re-enable it FOR — flipping `loading` back
    // to false here (the original code did, unconditionally, in `finally`) re-enables that
    // query while Login is still mounted for one more tick, which immediately refetches it
    // against the cache `qc.clear()` just emptied. Confirmed live via the waterfall audit: this
    // was the actual cause of the duplicate /auth/config call, not a missing `enabled` flag.
    pending.current = false;
  }

  /**
   * Server-initiated redirect (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9) — a full browser
   * navigation, never an XHR/fetch. The callback sets the SAME `rab_rt` cookie login already
   * sets and redirects to `/oauth/callback-complete`, which reuses the EXISTING
   * `bootstrapSession()` to finish — no new frontend session mechanism.
   */
  function startOAuth(provider: 'google' | 'microsoft'): void {
    const base = (api.defaults.baseURL ?? '').replace(/\/$/, '');
    // A same-origin return path (validated again by the server) brings the user back where they were going.
    const returnTo = searchParams.get('returnTo');
    const safeReturnTo = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\') ? returnTo : null;
    window.location.href = `${base}/auth/${provider}${safeReturnTo ? `?returnTo=${encodeURIComponent(safeReturnTo)}` : ''}`;
  }

  if (challenge) {
    return (
      <AuthLayout>
        <MfaChallengeStep
          challenge={challenge}
          email={email || undefined}
          onSignedIn={async (body) => {
            setLoading(true);
            await finishSignIn(body);
          }}
          onRestart={() => {
            setChallenge(null);
            setLoading(false);
            setStep(email ? 'password' : 'welcome');
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AnimatePresence mode="wait">
        {step === 'welcome' ? <motion.div className="auth-welcome" key="welcome" variants={stepVariants} initial="initial" animate="animate" exit="exit">
          <h1 style={s.title}>{oauthError ? 'Try signing in again' : workspaceLabel ? `Sign in to ${workspaceLabel}` : 'Welcome to your workspace'}</h1>
          {oauthError && <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Something didn’t go as planned. Let’s give it another try.</p>}
          {providers.google && <button type="button" style={s.providerBtn} onClick={() => startOAuth('google')}><IconBrandGoogle size={18} /> Continue with Google</button>}
          {providers.microsoft && <button type="button" style={s.providerBtn} onClick={() => startOAuth('microsoft')}><IconBrandWindows size={18} /> Continue with Microsoft</button>}
          {providers.password && <button className="auth-email-start" type="button" style={s.providerBtn} onClick={() => setStep('email')}>Continue with email</button>}
          {!providers.password && !providers.google && !providers.microsoft && <p role="status" style={s.error}>Sign-in is not available. Please contact your workspace administrator.</p>}
        </motion.div> : step === 'email' ? <motion.div key="email" variants={stepVariants} initial="initial" animate="animate" exit="exit">
          <h1 style={s.title}>Sign in with email</h1>
          <p style={s.subtitle}>Use the email linked to your workspace.</p>
          <form onSubmit={handleEmailContinue}>
            <label style={s.label} htmlFor="email">Work email</label>
            <input id="email" style={s.input} type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" autoFocus required />
            <button type="submit" style={s.submitBtn}>Continue</button>
          </form>
          <button type="button" style={s.backBtn} onClick={() => setStep('welcome')}>← Back to sign in</button>
        </motion.div> : <motion.div key="password" variants={stepVariants} initial="initial" animate="animate" exit="exit">
          <h1 style={s.title}>{error ? 'Try signing in again' : 'Welcome back'}</h1>
          <p style={{ ...s.subtitle, ...(error ? s.errorText : {}) }} role={error ? 'alert' : undefined}>{error === 'Invalid email or password.' ? 'The email or password is incorrect. Check your details and try again.' : error || 'Enter your password to continue.'}</p>
          {signInElsewhere && <p style={s.subtitle}><a className="auth-forgot-link" href={signInElsewhere}>Go to the main sign-in page</a></p>}
          <form onSubmit={handleSignIn}>
            <label style={s.label} htmlFor="login-email">Work email</label>
            <input id="login-email" style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
            <label style={s.label} htmlFor="password">Password</label>
            <div style={{position:'relative'}}><input id="password" style={{...s.input,paddingRight:42}} type={showPassword ? 'text' : 'password'} placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
              <button type="button" style={s.eyeBtn} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(v => !v)}>{showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}</button>
            </div>
            <Link className="auth-forgot-link" to={`/forgot-password?email=${encodeURIComponent(email)}`}>Forgot password?</Link>
            <button type="submit" style={{...s.submitBtn,opacity:loading || coolingDown ? .65 : 1}} disabled={loading || coolingDown}>{loading ? 'Signing in…' : coolingDown ? 'Please wait before trying again' : error ? 'Try again' : 'Sign in'}</button>
          </form>
          <button type="button" style={s.backBtn} onClick={() => {setStep('email');setError('');setPassword('');}}>← Back to sign in</button>
        </motion.div>}
      </AnimatePresence>
    </AuthLayout>
  );
}
