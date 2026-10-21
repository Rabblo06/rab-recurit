import AuthLayout from './AuthLayout';
import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, stepVariants } from './authStyles';
import { getApiErrorMessage } from '../../shared/lib/apiError';

/**
 * CF-04: the page behind the link mailed to a NEW sign-in address. Confirming proves control of that address; only then
 * does the account's email change (and every existing session ends). Nothing happens until the person presses the
 * button, so a mail scanner that merely opens the link cannot confirm the change.
 */
export default function ConfirmEmailChange() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    setError('');
    setLoading(true);
    try {
      await api.post('/email-change/confirm', { token });
      setDone(true);
    } catch (err: any) {
      const fallback = 'This confirmation link is invalid or has expired.';
      setError(getApiErrorMessage(err, { fallback, messages: { unauthorized: fallback, not_found: fallback } }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      {!token ? (
        <div>
          <h1 style={s.title}>This link is incomplete</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Open the confirmation link from your email again, or ask your administrator to send a new one.</p>
          <Link to="/login" style={s.backBtn}>← Back to sign in</Link>
        </div>
      ) : (
        <AnimatePresence mode="wait">
          {done ? (
            <motion.div key="done" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>Email confirmed</h1>
              <p style={s.subtitle}>This address is now your sign-in email. You have been signed out everywhere, so sign in again with it.</p>
              <Link to="/login" style={{ ...s.submitBtn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                Go to sign in
              </Link>
            </motion.div>
          ) : (
            <motion.div key="confirm" variants={stepVariants} initial="initial" animate="animate" exit="exit">
              <h1 style={s.title}>Confirm your new sign-in email</h1>
              <p style={s.subtitle}>Your administrator asked to make this address the sign-in email for your account. Confirm it to finish the change.</p>
              {error && (
                <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>
                  {error}
                </motion.p>
              )}
              <button type="button" style={{ ...s.submitBtn, opacity: loading ? 0.65 : 1 }} disabled={loading} onClick={handleConfirm}>
                {loading ? 'Confirming…' : 'Confirm this email'}
              </button>
              <Link to="/login" style={s.backBtn}>← Back to sign in</Link>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </AuthLayout>
  );
}
