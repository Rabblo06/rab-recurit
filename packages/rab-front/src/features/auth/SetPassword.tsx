import AuthLayout from './AuthLayout';
import AuthSuccess from './AuthSuccess';
import { useRef, useState } from 'react';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, useReducedMotion } from 'framer-motion';
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { api } from '../../shared/api';
import { s, ease, fadeIn } from './authStyles';
import { staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced } from '../onboarding/onboardingMotion';
import { getApiErrorMessage, getApiErrorStatus } from '../../shared/lib/apiError';
import { notifyApiError } from '../../shared/lib/mutationFeedback';

/**
 * The forced first-login step — reached only when `/auth/login` reports
 * `mustResetPassword: true`. The server's `MustResetPasswordGuard` is the
 * real control (every other route 403s until this completes); this screen
 * is just the UX for it, via the already-authenticated `/auth/set-password`.
 */
export default function SetPassword() {
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;
  const [done, setDone] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const strength = password ? checkPasswordStrength(password) : null;
  const mismatch = confirm.length > 0 && password !== confirm;
  const weak = Boolean(password && strength && !strength.valid);
  const inFlight = useRef(false);
  const canSubmit = Boolean(strength?.valid) && !mismatch;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Synchronous guard: `loading` re-renders a tick late, so a fast double click / double Enter would send twice.
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/set-password', { newPassword: password });
      setDone(true);
    } catch (err: any) {
      const fallback = 'Failed to update your password. Please try again.';
      // This step runs on the signed-in session: an expired one gets the persistent "Sign in again" toast (and only
      // that, one announcement); every other failure is the inline alert, with the typed passwords kept.
      if (getApiErrorStatus(err) === 401) notifyApiError(err, { fallback });
      else setError(getApiErrorMessage(err, fallback));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthLayout>

        {done ? <AuthSuccess loginHref="/login" /> : <>
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
                aria-invalid={weak || undefined}
                aria-describedby={weak ? 'setpw-strength' : undefined}
              />
              <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} style={s.eyeBtn} onClick={() => setShowPassword(v => !v)}>
                {showPassword ? <IconEyeOff size={15} color="#aaa" /> : <IconEye size={15} color="#aaa" />}
              </button>
            </div>
          </motion.div>

          {password && strength && !strength.valid && (
            <ul id="setpw-strength" aria-label="Password requirements" style={s.strengthList}>
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
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? 'setpw-mismatch' : undefined}
            /><button type="button" aria-label={showPassword ? "Hide confirmation password" : "Show confirmation password"} style={s.eyeBtn} onClick={() => setShowPassword(v => !v)}>{showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}</button></div>
          </motion.div>
          <p className="auth-password-hint" title={`At least ${MIN_PASSWORD_LENGTH} characters, uppercase and lowercase letters, and a number.`}>Use a long, unique password for this account.</p>
          <div aria-live="polite">{mismatch && <p id="setpw-mismatch" style={{ ...s.error, marginTop: -6 }}>Passwords don't match.</p>}</div>

          {error && (
            <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
              {error}
            </motion.p>
          )}

          <motion.button type="submit" variants={item} style={{ ...s.submitBtn, opacity: loading || !canSubmit ? 0.65 : 1 }} disabled={loading || !canSubmit}>
            {loading ? 'Updating…' : 'Set password'}
          </motion.button>
        </motion.form>
        </>}
    </AuthLayout>
  );
}
