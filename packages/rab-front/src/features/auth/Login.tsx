import { loginError } from './authErrors';
import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandGoogle, IconBrandWindows, IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, getLastMeSnapshot, resolveIdentityViaCookie, withAuthLock } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';

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
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
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
    setLoading(true);
    try {
      // P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): serialized with refresh/logout across
      // every tab sharing this browser profile — a login racing a concurrent refresh/logout in
      // another tab must not be allowed to interleave at the Set-Cookie level.
      const { data } = await withAuthLock(() => api.post('/auth/login', { email, password, applicationTarget: 'manager_web' }));
      // P1C.1C-F: neither the refresh token nor the new web session credential ever reaches this
      // JS — both are HttpOnly cookies the server just set (rab-server's AuthController). Identity
      // (userId/sessionId/generation, broadcast to other tabs) is derived the SAME way the
      // cookie-first bootstrap derives it: a cookie-authenticated `GET /auth/me`, never a decoded
      // JWT. Called directly (not through `bootstrapSession()`'s single-flight dedup) — this is a
      // ONE-TIME call guaranteed to run after a just-completed, genuinely new login, never a
      // candidate for deduping against some unrelated concurrent resolution. It updates the
      // identity store and broadcasts to other tabs internally — nothing further to do here.
      const ok = await resolveIdentityViaCookie();
      if (!ok) throw new Error('Login succeeded but the session could not be established.');
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
      nav(data.mustResetPassword ? '/set-password' : '/');
      // Deliberately no `setLoading(false)` on this path (see the `enabled: !loading` comment on
      // the auth-config query above): this component is unmounting on the navigate just above,
      // not staying on screen, so there's nothing to re-enable it FOR — flipping `loading` back
      // to false here (the original code did, unconditionally, in `finally`) re-enables that
      // query while Login is still mounted for one more tick, which immediately refetches it
      // against the cache `qc.clear()` just emptied. Confirmed live via the waterfall audit: this
      // was the actual cause of the duplicate /auth/config call, not a missing `enabled` flag.
      pending.current = false;
    } catch (err: any) {
      const failure = loginError(err);
      setError(failure.message);
      if (failure.cooldown) setCooldownUntil(Date.now() + failure.cooldown * 1000);
      pending.current = false;
      setLoading(false);
    }
  }

  /**
   * Server-initiated redirect (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9) — a full browser
   * navigation, never an XHR/fetch. The callback sets the SAME `rab_rt` cookie login already
   * sets and redirects to `/oauth/callback-complete`, which reuses the EXISTING
   * `bootstrapSession()` to finish — no new frontend session mechanism.
   */
  function startOAuth(provider: 'google' | 'microsoft'): void {
    const base = (api.defaults.baseURL ?? '').replace(/\/$/, '');
    window.location.href = `${base}/auth/${provider}`;
  }

  return (
    <div style={s.page}>
      {/* Blurred background table */}
      <div style={s.bg} aria-hidden>
        <div style={s.bgGrid}>
          {['Name','Domain','Created by','Account Owner','Created','Employees','City'].map(h => (
            <div key={h} style={s.bgTh}>{h}</div>
          ))}
          {Array.from({ length: 84 }).map((_, i) => (
            <div key={i} style={{ ...s.bgTd, opacity: 0.3 + (i % 4) * 0.07 }}>
              {'██████'.slice(0, 2 + (i % 5))}
            </div>
          ))}
        </div>
      </div>
      <div style={s.overlay}/>

      {/* Modal */}
      <motion.div style={s.modal} {...fadeIn}>
        {/* Logo */}
        <motion.div style={s.logoWrap} {...fadeIn}>
          <div style={s.logo}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3L21 19.5H3L12 3Z" fill="white"/>
            </svg>
          </div>
        </motion.div>

        {/* Animated step content */}
        <AnimatePresence mode="wait">
          {step === 'email' ? (
            <motion.div key="email" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <p style={s.title}>Sign in to rab</p>

              {oauthError && (
                <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                  We couldn't sign you in. Try again or use another sign-in method.
                </motion.p>
              )}

              {providers.password && (
                <form onSubmit={handleEmailContinue}>
                  <label style={s.label} htmlFor="email">Email</label>
                  <input
                    id="email"
                    style={s.input}
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoFocus
                    required
                  />
                  <button type="submit" style={s.submitBtn}>Continue</button>
                </form>
              )}

              {providers.password && (providers.google || providers.microsoft) && (
                <div style={s.providerDivider}>
                  <div style={s.providerDividerLine} /> or <div style={s.providerDividerLine} />
                </div>
              )}

              {providers.google && (
                <button type="button" style={s.providerBtn} onClick={() => startOAuth('google')}>
                  <IconBrandGoogle size={16} /> Continue with Google
                </button>
              )}
              {providers.microsoft && (
                <button type="button" style={s.providerBtn} onClick={() => startOAuth('microsoft')}>
                  <IconBrandWindows size={16} /> Continue with Microsoft
                </button>
              )}
            </motion.div>
          ) : (
            <motion.div key="password" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <p style={s.title}>Enter your password</p>

              {/* Email chip */}
              <div style={s.emailChip}>
                <div style={s.emailDot}/>
                {email}
              </div>

              <form onSubmit={handleSignIn}>
                <label style={s.label} htmlFor="password">Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="password"
                    style={{ ...s.input, paddingRight: 38 }}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoFocus
                    required
                  />
                  <button type="button" style={s.eyeBtn}
                    onClick={() => setShowPassword(v => !v)}>
                    {showPassword
                      ? <IconEyeOff size={15} color="#aaa"/>
                      : <IconEye size={15} color="#aaa"/>}
                  </button>
                </div>

                <div style={{ textAlign: 'right', marginTop: -4, marginBottom: 10 }}>
                  <Link
                    to={`/forgot-password?email=${encodeURIComponent(email)}`}
                    style={{ fontSize: 11.5, color: '#888', textDecoration: 'none' }}
                  >
                    Forgot password?
                  </Link>
                </div>

                {error && (
                  <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                    {error}
                  </motion.p>
                )}

                <button
                  type="submit"
                  style={{ ...s.submitBtn, opacity: loading ? 0.65 : 1 }}
                  disabled={loading || coolingDown}>
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>

              <button type="button" style={s.backBtn}
                onClick={() => { setStep('email'); setError(''); setPassword(''); }}>
                ← Back
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
