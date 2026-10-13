import AuthLayout from './AuthLayout';
import { safeApplicationTarget, loginDestination } from './authErrors';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const applicationTarget = safeApplicationTarget(params.get('applicationTarget')) ?? 'manager_web';
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function sendReset() {
    if (!email.trim()) return;
    setError('');
    setLoading(true);
    try {
      // Deliberately identical outcome whether or not the account exists —
      // the backend never reveals which (CLAUDE.md: no enumeration).
      await api.post('/auth/forgot-password', { email: email.trim(), applicationTarget });
      setSent(true);
    } catch {
      setError('We couldn’t send the request. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div key="sent" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>Check your inbox</h1>
              <p style={s.subtitle}>
                If there’s an account for {email}, we’ll send a password reset link. Check your spam folder, too.
              </p>
              {error && <p role="alert" style={s.error}>{error}</p>}
              <button type="button" style={s.submitBtn} disabled={loading} onClick={sendReset}>{loading ? 'Sending…' : 'Resend email'}</button>
              <a href={loginDestination(applicationTarget)} style={{ ...s.backBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                Return to sign in
              </a>
            </motion.div>
          ) : (
            <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>Forgot your password?</h1>
              <p style={s.subtitle}>No worries. We’ll send you a link to reset it.</p>

              <form onSubmit={e => { e.preventDefault(); void sendReset(); }}>
                <label style={s.label} htmlFor="email">Email</label>
                <input
                  id="email"
                  style={s.input}
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
                  required
                />

                {error && (
                  <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                    {error}
                  </motion.p>
                )}

                <button type="submit" style={{ ...s.submitBtn, opacity: loading ? 0.65 : 1 }} disabled={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>

              <a href={loginDestination(applicationTarget)} style={{ ...s.backBtn, display: 'block' }}>
                ← Back to sign in
              </a>
            </motion.div>
          )}
        </AnimatePresence>
    </AuthLayout>
  );
}
