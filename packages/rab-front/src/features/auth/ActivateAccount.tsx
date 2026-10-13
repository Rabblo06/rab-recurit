import AuthLayout from './AuthLayout';
import AuthSuccess from './AuthSuccess';
import { loginDestination, safeApplicationTarget, postAuthSuccessCopy, ApplicationTarget } from './authErrors';
import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';
import { staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced, markPendingWelcome } from '../onboarding/onboardingMotion';

/**
 * Consumes a one-time account-activation token (`account_invite`, distinct
 * from `password_reset_token` — see `AccountInviteService`). Mirrors
 * `ResetPassword.tsx` closely on purpose — same token-in-URL shape, same
 * password-strength UI — but hits `/auth/activate-account`, which creates
 * the FIRST password for a pending account rather than replacing one.
 *
 * Deliberate, documented deviation from a literal VALID/INVALID/EXPIRED/
 * USED/CANCELLED state machine: the backend returns one uniform "invalid or
 * expired" message for every failure reason (same non-enumeration
 * discipline already used by `/auth/reset-password` — see
 * `AuthService.activateAccount`'s own doc comment). Distinguishing
 * expired/used/cancelled/unknown to the browser would mean the backend
 * leaking which one it is, which is exactly the oracle that convention
 * exists to avoid. This page has three real states instead: the form
 * (token present, not yet submitted), a single non-leaky failure message
 * covering all four reasons, and success.
 */
export default function ActivateAccount() {
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;
  const [returnTarget, setReturnTarget] = useState<ApplicationTarget | null>(null);
  const [managerLoginUrl, setManagerLoginUrl] = useState<string | undefined>(undefined);
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const strength = password ? checkPasswordStrength(password) : null;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = Boolean(token) && Boolean(strength?.valid) && !mismatch;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/activate-account', { token, newPassword: password });
      setReturnTarget(safeApplicationTarget(data?.applicationTarget));
      setManagerLoginUrl(typeof data?.managerLoginUrl === 'string' ? data.managerLoginUrl : undefined);
      setDone(true);
      // Consumed once by `Layout.tsx` (CEO/Super Admin) or cleared by `CreateProfileScreen.tsx`
      // (Manager, which gets its own welcome from `WorkspacePreparationScreen` instead).
      markPendingWelcome();
    } catch (err: any) {
      setError(
        err.response?.data?.message ??
          'Unable to activate your account right now. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>

        {!token ? (
          <div>
            <h1 style={s.title}>This link has expired</h1>
            <p style={s.subtitle}>This activation link is missing or malformed. Ask whoever invited you for a new one.</p>
            <Link to="/login" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Go to sign in
            </Link>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {done ? (
              <motion.div key="done" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <AuthSuccess setup {...(returnTarget ? postAuthSuccessCopy(returnTarget, managerLoginUrl) : {})} />
              </motion.div>
            ) : (
              <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <h1 style={s.title}>Set your password</h1>
                <p style={s.subtitle}>Finish setting up your invited account.</p>

                <motion.form onSubmit={handleSubmit} variants={container} initial="initial" animate="animate">
                  <motion.div variants={item}>
                    <label style={s.label} htmlFor="password">New password</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        id="password"
                        style={{ ...s.input, paddingRight: 38 }}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Create a password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        autoComplete="new-password"
                        autoFocus
                        required
                      />
                      <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} style={s.eyeBtn} onClick={() => setShowPassword(v => !v)}>
                        {showPassword ? <IconEyeOff size={15} color="#aaa" /> : <IconEye size={15} color="#aaa" />}
                      </button>
                    </div>
                  </motion.div>

                  {password && strength && !strength.valid && (
                    <ul style={s.strengthList}>
                      {strength.reasons.map(r => <li key={r}>{r}</li>)}
                    </ul>
                  )}

                  <motion.div variants={item}>
                    <label style={s.label} htmlFor="confirm">Confirm password</label>
                    <div style={{position:"relative"}}><input
                      id="confirm"
                      style={s.input}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Repeat your password"
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      autoComplete="new-password"
                      required
                    /><button type="button" aria-label={showPassword ? "Hide confirmation password" : "Show confirmation password"} style={s.eyeBtn} onClick={() => setShowPassword(v => !v)}>{showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}</button></div>
                  </motion.div>
                  <p className="auth-password-hint" title={`At least ${MIN_PASSWORD_LENGTH} characters, uppercase and lowercase letters, and a number.`}>Use a long, unique password for this account.</p>
                  {mismatch && <p style={{ ...s.error, marginTop: -6 }}>Passwords don't match.</p>}

                  {error && (
                    <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                      {error}
                    </motion.p>
                  )}

                  <motion.button type="submit" variants={item} style={{ ...s.submitBtn, opacity: loading || !canSubmit ? 0.65 : 1 }} disabled={loading || !canSubmit}>
                    {loading ? 'Activating…' : 'Set password'}
                  </motion.button>
                </motion.form>
                <a href={loginDestination(safeApplicationTarget(params.get("applicationTarget")) ?? "manager_web")} style={s.backBtn}>← Back to sign in</a>
              </motion.div>
            )}
          </AnimatePresence>
        )}
    </AuthLayout>
  );
}
