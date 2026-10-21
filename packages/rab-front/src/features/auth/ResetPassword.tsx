import AuthLayout from './AuthLayout';
import AuthSuccess from './AuthSuccess';
import { loginDestination, safeApplicationTarget, postAuthSuccessCopy, ApplicationTarget } from './authErrors';
import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence } from 'framer-motion';
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';
import { getApiErrorMessage } from '../../shared/lib/apiError';

/**
 * Consumes a one-time password-reset token — the same endpoint services
 * every token purpose (initial account setup, self-service forgot-password,
 * and an admin-triggered reset), since the backend treats them identically
 * once issued: valid, unexpired, unused, or rejected.
 */
export default function ResetPassword() {
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
      const { data } = await api.post('/auth/reset-password', { token, newPassword: password });
      setReturnTarget(safeApplicationTarget(data?.applicationTarget));
      setManagerLoginUrl(typeof data?.managerLoginUrl === 'string' ? data.managerLoginUrl : undefined);
      setDone(true);

    } catch (err: any) {
      const fallback = 'This link is invalid or has expired. Please request a new one.';
      setError(getApiErrorMessage(err, { fallback, messages: { unauthorized: fallback, not_found: fallback } }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>

        {!token ? (
          <div>
            <h1 style={s.title}>This link has expired</h1>
            <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Request a fresh password reset link to continue.</p>
            <Link to="/forgot-password" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Request a new link
            </Link>
            <Link to="/login" style={s.backBtn}>← Back to sign in</Link>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {done ? (
              <motion.div key="done" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <AuthSuccess {...(returnTarget ? postAuthSuccessCopy(returnTarget, managerLoginUrl) : {})} />
              </motion.div>
            ) : (
              <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <h1 style={s.title}>Reset your password</h1>
                <p style={s.subtitle}>Choose a new password for your account.</p>

                <form onSubmit={handleSubmit}>
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

                  {password && strength && !strength.valid && (
                    <ul style={s.strengthList}>
                      {strength.reasons.map(r => <li key={r}>{r}</li>)}
                    </ul>
                  )}

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
                  <p className="auth-password-hint" title={`At least ${MIN_PASSWORD_LENGTH} characters, uppercase and lowercase letters, and a number.`}>Use a long, unique password for this account.</p>
                  {mismatch && <p style={{ ...s.error, marginTop: -6 }}>Passwords don't match.</p>}

                  {error && (
                    <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                      {error}
                    </motion.p>
                  )}

                  <button type="submit" style={{ ...s.submitBtn, opacity: loading || !canSubmit ? 0.65 : 1 }} disabled={loading || !canSubmit}>
                    {loading ? 'Updating…' : 'Reset password'}
                  </button>
                </form>
                <a href={loginDestination(safeApplicationTarget(params.get("applicationTarget")) ?? "manager_web")} style={s.backBtn}>← Back to sign in</a>
              </motion.div>
            )}
          </AnimatePresence>
        )}
    </AuthLayout>
  );
}
