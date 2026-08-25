import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn, stepVariants } from './authStyles';

export default function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setStep('password');
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      // Defense-in-depth alongside LogoutDialog's own qc.clear() — any cached
      // query from a previous session on this tab (e.g. one that ended by
      // token expiry rather than an explicit logout) must not be shown to
      // whoever just authenticated.
      qc.clear();
      nav(data.mustResetPassword ? '/set-password' : '/');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
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
                  disabled={loading}>
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
