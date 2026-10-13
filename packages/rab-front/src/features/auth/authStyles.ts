import type { CSSProperties } from 'react';
export const ease = { ease: 'linear', duration: 0.2 };
export const fadeIn = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: ease };
export const stepVariants = { initial: { opacity: 0 }, animate: { opacity: 1, transition: ease }, exit: { opacity: 0, transition: { ...ease, duration: 0.12 } } };

/** Shared form geometry; AuthLayout owns the desktop/mobile composition. */
export const s: Record<string, CSSProperties> = {
  page: { minHeight: '100dvh', background: 'var(--bg-primary)', color: 'var(--font-primary)' },
  modal: { width: '100%', maxWidth: 440, margin: '0 auto', background: 'var(--bg-primary)' },
  logoWrap: { display: 'flex', justifyContent: 'center', marginBottom: 24 },
  logo: { width: 48, height: 48, borderRadius: 12, background: 'var(--walnut)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: 600, color: 'var(--font-primary)', lineHeight: '30px', textAlign: 'center', letterSpacing: 'normal', margin: '0 0 10px' },
  subtitle: { fontSize: 14, color: 'var(--font-secondary)', textAlign: 'center', margin: '0 0 24px', lineHeight: '21px' },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--font-secondary)', marginBottom: 8 },
  input: { display: 'block', width: '100%', height: 44, padding: '11px 14px', border: '1px solid var(--border-medium)', borderRadius: 6, fontSize: 13, color: 'var(--font-primary)', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 20, background: 'var(--bg-primary)', transition: 'border-color .15s' },
  submitBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 40, padding: '10px 16px', background: 'var(--walnut)', color: '#fff', border: '1px solid transparent', borderRadius: 6, fontSize: 13, lineHeight: '18px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'background .15s', boxSizing: 'border-box', textDecoration: 'none', marginTop: 4 },
  eyeBtn: { position: 'absolute', right: 12, top: 12, color: 'var(--font-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' },
  error: { color: '#a73c30', fontSize: 12, lineHeight: '18px', marginBottom: 12, padding: '9px 12px', background: '#fff6f3', borderRadius: 6, border: '1px solid #f0d9d1' },
  success: { color: '#53664f', fontSize: 12, marginBottom: 12, padding: '9px 12px', background: '#edf1e9', borderRadius: 6 },
  backBtn: { display: 'block', width: '100%', marginTop: 24, background: 'none', border: 'none', color: 'var(--font-tertiary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center', textDecoration: 'none' },
  strengthList: { margin: '-10px 0 16px', padding: '0 0 0 16px', fontSize: 11, color: '#a73c30' },
  providerBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: '100%', height: 44, padding: '10px 16px', background: 'var(--bg-primary)', color: 'var(--font-secondary)', border: '1px solid var(--border-medium)', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 },
  providerDivider: { display: 'flex', alignItems: 'center', gap: 14, margin: '22px 0', color: 'var(--font-tertiary)', fontSize: 12 },
  providerDividerLine: { flex: 1, height: 1, background: 'var(--border-light)' },
};
