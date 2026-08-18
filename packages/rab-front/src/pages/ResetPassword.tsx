import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence } from 'framer-motion';
import { checkPasswordStrength } from '@rab/shared';
import { api } from '../api';
import { s, ease, fadeIn, stepVariants } from './authStyles';

/**
 * Consumes a one-time password-reset token — the same endpoint services
 * every token purpose (initial account setup, self-service forgot-password,
 * and an admin-triggered reset), since the backend treats them identically
 * once issued: valid, unexpired, unused, or rejected.
 */
export default function ResetPassword() {
  const nav = useNavigate();
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
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
      setTimeout(() => nav('/login'), 1800);
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'This link is invalid or has expired. Please request a new one.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.page}>
      <div style={s.bg} aria-hidden>
        <div style={s.bgGrid}>
          {['Name', 'Domain', 'Created by', 'Account Owner', 'Created', 'Employees', 'City'].map(h => (
            <div key={h} style={s.bgTh}>{h}</div>
          ))}
          {Array.from({ length: 84 }).map((_, i) => (
            <div key={i} style={{ ...s.bgTd, opacity: 0.3 + (i % 4) * 0.07 }}>
              {'██████'.slice(0, 2 + (i % 5))}
            </div>
          ))}
        </div>
      </div>
      <div style={s.overlay} />

      <motion.div style={s.modal} {...fadeIn}>
        <motion.div style={s.logoWrap} {...fadeIn}>
          <div style={s.logo}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3L21 19.5H3L12 3Z" fill="white" />
            </svg>
          </div>
        </motion.div>

        {!token ? (
          <div>
            <p style={s.title}>Invalid link</p>
            <p style={s.subtitle}>This password reset link is missing or malformed. Please request a new one.</p>
            <Link to="/forgot-password" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Request a new link
            </Link>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {done ? (
              <motion.div key="done" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <p style={s.title}>Password updated</p>
                <p style={s.subtitle}>Redirecting you to sign in…</p>
              </motion.div>
            ) : (
              <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
                <p style={s.title}>Create your new password</p>

                <form onSubmit={handleSubmit}>
                  <label style={s.label} htmlFor="password">New password</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="password"
                      style={{ ...s.input, paddingRight: 38 }}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="New password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoFocus
                      required
                    />
                    <button type="button" style={s.eyeBtn} onClick={() => setShowPassword(v => !v)}>
                      {showPassword ? <IconEyeOff size={15} color="#aaa" /> : <IconEye size={15} color="#aaa" />}
                    </button>
                  </div>

                  {password && strength && !strength.valid && (
                    <ul style={s.strengthList}>
                      {strength.reasons.map(r => <li key={r}>{r}</li>)}
                    </ul>
                  )}

                  <label style={s.label} htmlFor="confirm">Confirm password</label>
                  <input
                    id="confirm"
                    style={s.input}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Confirm new password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    required
                  />
                  {mismatch && <p style={{ ...s.error, marginTop: -6 }}>Passwords don't match.</p>}

                  {error && (
                    <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                      {error}
                    </motion.p>
                  )}

                  <button type="submit" style={{ ...s.submitBtn, opacity: loading || !canSubmit ? 0.65 : 1 }} disabled={loading || !canSubmit}>
                    {loading ? 'Updating…' : 'Update password'}
                  </button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </motion.div>
    </div>
  );
}
