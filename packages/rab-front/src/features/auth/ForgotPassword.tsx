import AuthLayout from './AuthLayout';
import { safeApplicationTarget, loginDestination } from './authErrors';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';
import { getApiErrorMessage, getApiErrorStatus } from '../../shared/lib/apiError';

const SEND_FAILED = 'We couldn’t send the request. Check your connection and try again.';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const applicationTarget = safeApplicationTarget(params.get('applicationTarget')) ?? 'manager_web';
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  /** Only a 400 (the address itself was refused) is about the field; a 429 / outage / lost connection is not. */
  const [emailInvalid, setEmailInvalid] = useState(false);
  const inFlight = useRef(false);

  async function sendReset() {
    // Synchronous guard: `loading` re-renders a tick late, so a fast double click / double Enter would send twice.
    if (!email.trim() || inFlight.current) return;
    inFlight.current = true;
    setError('');
    setEmailInvalid(false);
    setLoading(true);
    try {
      // Deliberately identical outcome whether or not the account exists —
      // the backend never reveals which (CLAUDE.md: no enumeration).
      await api.post('/auth/forgot-password', { email: email.trim(), applicationTarget });
      setSent(true);
    } catch (err) {
      // The server answers 204 for every address (known or not), so a failure is only ever throttling (429), a malformed
      // address (400), an outage (5xx) or no connection — none of which says whether an account exists.
      const status = getApiErrorStatus(err);
      setEmailInvalid(status === 400 || status === 422);
      setError(
        getApiErrorMessage(err, {
          fallback: SEND_FAILED,
          messages: {
            validation: 'Enter a valid email address, then try again.',
            rate_limited: 'Too many requests. Please wait a few minutes, then try again.',
            server: 'We couldn’t send the request right now. Please try again in a moment.',
            offline: SEND_FAILED,
            timeout: SEND_FAILED,
          },
        }),
      );
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthLayout>

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div key="sent" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>Check your inbox</h1>
              <p role="status" style={{ ...s.subtitle, ...s.successText }}>
                If there’s an account for {email}, we’ll send a password reset link. Check your spam folder, too.
              </p>
              {error && <p role="alert" style={s.error}>{error}</p>}
              <button type="button" style={s.submitBtn} disabled={loading} aria-busy={loading || undefined} onClick={sendReset}>{loading ? 'Sending…' : 'Resend email'}</button>
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
                  aria-invalid={emailInvalid || undefined}
                  aria-describedby={error ? 'forgot-error' : undefined}
                />

                {error && (
                  <motion.p id="forgot-error" role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                    {error}
                  </motion.p>
                )}

                <button type="submit" style={{ ...s.submitBtn, opacity: loading ? 0.65 : 1 }} disabled={loading} aria-busy={loading || undefined}>
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
