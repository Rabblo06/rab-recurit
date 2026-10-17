import AuthLayout from './AuthLayout';
import AuthSuccess from './AuthSuccess';
import { postAuthSuccessCopy, safeApplicationTarget, ApplicationTarget } from './authErrors';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { api } from '../../shared/api';
import { s, ease, stepVariants } from './authStyles';
import { staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced, markPendingWelcome } from '../onboarding/onboardingMotion';

interface ResolvedInvitation { email: string; roleLabel: string; workspaceName: string | null }
interface InvitationProviders { google: boolean; microsoft: boolean }

const GENERIC = 'This invitation link is invalid or has expired. Ask whoever invited you to send a new one.';

/**
 * Accepts an email-first workspace invitation (`/rest/v1/invitations/*`). Unlike the older account-activation
 * link, no account exists yet: the RECIPIENT enters their own first name, last name and password here, and the
 * server creates their account, role and workspace membership in one step. Same look and the same non-leaky error
 * discipline as `ActivateAccount.tsx`: every invalid, expired, revoked or used link produces one message.
 * Nothing here signs the person in — they continue to the normal sign-in for their app.
 */
export default function AcceptInvitation() {
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [invitation, setInvitation] = useState<ResolvedInvitation | null>(null);
  const [resolveState, setResolveState] = useState<'loading' | 'ready' | 'invalid' | 'unavailable'>(token ? 'loading' : 'invalid');
  const [attempt, setAttempt] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [returnTarget, setReturnTarget] = useState<ApplicationTarget | null>(null);
  const [managerLoginUrl, setManagerLoginUrl] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [providers, setProviders] = useState<InvitationProviders>({ google: false, microsoft: false });
  const oauthError = params.get('oauthError') === '1';

  // "Accept with Google/Microsoft" is offered only when the server says so (one-time OAuth handoff enabled and the
  // provider switched on); the server re-checks everything regardless.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ invitationProviders?: InvitationProviders }>('/auth/config')
      .then(({ data }) => { if (!cancelled && data.invitationProviders) setProviders(data.invitationProviders); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setResolveState('loading');
    api
      .post<ResolvedInvitation>('/invitations/resolve', { token })
      .then(({ data }) => { if (!cancelled) { setInvitation(data); setResolveState('ready'); } })
      // Throttling (429), a rate-limit store outage (503) and network failures say nothing about the link — the server
      // applies those before it looks the token up — so they get a retry, never the "ask for a new link" message.
      .catch((err: any) => {
        if (cancelled) return;
        const status = err?.response?.status;
        setResolveState(status === undefined || status === 429 || status >= 500 ? 'unavailable' : 'invalid');
      });
    return () => { cancelled = true; };
  }, [token, attempt]);

  const strength = password ? checkPasswordStrength(password, invitation?.email) : null;
  const mismatch = confirm.length > 0 && password !== confirm;
  const namesValid = firstName.trim().length > 0 && lastName.trim().length > 0;
  const canSubmit = resolveState === 'ready' && namesValid && Boolean(strength?.valid) && !mismatch && confirm.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/invitations/accept', { token, firstName: firstName.trim(), lastName: lastName.trim(), newPassword: password });
      const target = safeApplicationTarget(data?.applicationTarget);
      setReturnTarget(target);
      setManagerLoginUrl(typeof data?.managerLoginUrl === 'string' ? data.managerLoginUrl : undefined);
      if (target === 'manager_web') markPendingWelcome();
      setDone(true);
    } catch (err: any) {
      const message = err?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(' ') : message ?? 'We couldn’t finish setting up your account. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      {oauthError && !token ? (
        <div>
          <h1 style={s.title}>We couldn’t accept your invitation</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>
            Open the link in your invitation email again, and choose the account that matches the invited email address.
          </p>
          <Link to="/login" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Go to sign in</Link>
        </div>
      ) : resolveState === 'invalid' ? (
        <div>
          <h1 style={s.title}>This invitation can’t be used</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>{GENERIC}</p>
          <Link to="/login" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Go to sign in</Link>
        </div>
      ) : resolveState === 'unavailable' ? (
        <div>
          <h1 style={s.title}>We couldn’t check your invitation</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Please wait a minute and try again. Your invitation link has not been used.</p>
          <button type="button" style={s.submitBtn} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : resolveState === 'loading' ? (
        <p role="status" style={s.subtitle}>Checking your invitation…</p>
      ) : (
        <AnimatePresence mode="wait">
          {done ? (
            <motion.div key="done" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <AuthSuccess setup {...(returnTarget ? postAuthSuccessCopy(returnTarget, managerLoginUrl) : {})} />
            </motion.div>
          ) : (
            <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>{invitation?.workspaceName ? `Join ${invitation.workspaceName}` : 'Join your team'}</h1>
              <p style={s.subtitle}>You’ve been invited as {invitation?.roleLabel ?? 'a member'}. Set up your account to accept.</p>
              {(providers.google || providers.microsoft) && (
                <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                  {(['google', 'microsoft'] as const).filter((p) => providers[p]).map((provider) => (
                    // A top-level form POST: the invitation token travels in the request body, never in a URL.
                    <form key={provider} method="post" action={`${api.defaults.baseURL}/auth/${provider}/invitation`}>
                      <input type="hidden" name="token" value={token} />
                      <button type="submit" style={{ ...s.submitBtn, background: 'transparent', color: 'inherit', border: '1px solid currentColor' }}>
                        Accept with {provider === 'google' ? 'Google' : 'Microsoft'}
                      </button>
                    </form>
                  ))}
                  <p style={{ ...s.subtitle, margin: 0, fontSize: 12 }}>Or set a password:</p>
                </div>
              )}
              <motion.form onSubmit={handleSubmit} variants={container} initial="initial" animate="animate" noValidate>
                <motion.div variants={item}>
                  <label style={s.label} htmlFor="invite-email">Email</label>
                  <input id="invite-email" style={{ ...s.input, opacity: 0.75 }} value={invitation?.email ?? ''} readOnly aria-readonly="true" />
                </motion.div>
                <motion.div variants={item} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={s.label} htmlFor="invite-first">First name</label>
                    <input id="invite-first" style={s.input} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" maxLength={100} autoFocus required />
                  </div>
                  <div>
                    <label style={s.label} htmlFor="invite-last">Last name</label>
                    <input id="invite-last" style={s.input} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" maxLength={100} required />
                  </div>
                </motion.div>
                <motion.div variants={item}>
                  <label style={s.label} htmlFor="invite-password">Password</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="invite-password"
                      style={{ ...s.input, paddingRight: 38 }}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Create a password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      required
                    />
                    <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} style={s.eyeBtn} onClick={() => setShowPassword((v) => !v)}>
                      {showPassword ? <IconEyeOff size={15} color="#aaa" /> : <IconEye size={15} color="#aaa" />}
                    </button>
                  </div>
                </motion.div>
                {password && strength && !strength.valid && (
                  <ul style={s.strengthList}>{strength.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                )}
                <motion.div variants={item}>
                  <label style={s.label} htmlFor="invite-confirm">Confirm password</label>
                  <input
                    id="invite-confirm"
                    style={s.input}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Repeat your password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </motion.div>
                <p className="auth-password-hint" title={`At least ${MIN_PASSWORD_LENGTH} characters, uppercase and lowercase letters, and a number.`}>Use a long, unique password for this account.</p>
                {mismatch && <p style={{ ...s.error, marginTop: -6 }}>Passwords don't match.</p>}
                {error && (
                  <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>{error}</motion.p>
                )}
                <motion.button type="submit" variants={item} style={{ ...s.submitBtn, opacity: loading || !canSubmit ? 0.65 : 1 }} disabled={loading || !canSubmit}>
                  {loading ? 'Setting up…' : 'Accept invitation'}
                </motion.button>
              </motion.form>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </AuthLayout>
  );
}
