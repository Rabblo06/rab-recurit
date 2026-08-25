import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setLoading(true);
    try {
      // Deliberately identical outcome whether or not the account exists —
      // the backend never reveals which (CLAUDE.md: no enumeration).
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch {
      setSent(true);
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

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div key="sent" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <p style={s.title}>Check your email</p>
              <p style={s.subtitle}>
                If an account exists for {email}, you'll receive an email with a link to reset your password shortly.
              </p>
              <Link to="/login" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                Return to sign in
              </Link>
            </motion.div>
          ) : (
            <motion.div key="form" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <p style={s.title}>Reset your password</p>
              <p style={s.subtitle}>Enter your email and we'll send you a reset link.</p>

              <form onSubmit={handleSubmit}>
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

                {error && (
                  <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                    {error}
                  </motion.p>
                )}

                <button type="submit" style={{ ...s.submitBtn, opacity: loading ? 0.65 : 1 }} disabled={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>

              <Link to="/login" style={{ ...s.backBtn, display: 'block' }}>
                ← Back to sign in
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
