// Account security capture fixtures (2026-10-25) — answers the self-service 2FA routes and the sign-in second-factor
// routes for design-parity screenshots only. Same rules as fixtures.cjs (which this file does not modify): the UI is the
// real rab-front dev server; every response here is synthetic and fictional (`@example.test`, a made-up TOTP secret that
// belongs to no account) and is intercepted inside the browser with `page.route`. Nothing reaches a real API. Shapes
// mirror rab-server `MfaManagementService.status` / `MfaLoginService` failure bodies (STEP1_REPORT.md).
'use strict';

const path = require('path');
const QRCode = require(path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'qrcode'));

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Fictional, non-secret sample: a fixed base32 string that is not any account's key.
const SAMPLE_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const sampleKey = SAMPLE_SECRET.match(/.{1,4}/g).join(' ');
// Crockford-style XXXX-XXXX-XXXX-XXXX, the real format and length (fictional values).
const SAMPLE_CODES = [
  'K7MP-2XQ9-4TZR-8HWE', 'Q2NC-6VLA-P9DY-3JKU', 'M5SA-7RGX-W8BE-1FTO', 'C3HU-9ZNE-V6LQ-5MYD', 'R1XW-4PAK-J2GT-8CVS',
  'B4DN-6QWE-T7ZK-2MRA', 'H8FJ-3LXC-N5PV-9GSE', 'D2KR-7YMB-A4WQ-6TNH', 'G9VE-1CZP-X3JL-5RKM', 'S6TA-8HNF-E2BX-4QDW',
].map((c) => c.replace(/[ILOU]/g, 'Z'));

function status(kind, email) {
  const base = {
    enabled: false, enabledAt: null, recoveryCodesRemaining: 0, recoveryCodesTotal: 0, enforced: false, enrolmentAvailable: true,
    mobileChallenged: false, hasPassword: true, linkedProviders: [], ssoReauthProviders: [],
  };
  if (kind === 'off') return base;
  const remaining = kind === 'low' ? 2 : 8;
  return { ...base, enabled: true, enabledAt: ago(1 * DAY), recoveryCodesRemaining: remaining, recoveryCodesTotal: 10, mobileChallenged: true };
}

/**
 * @param {import('playwright').Page} page
 * @param {{ origin: string, email: string, mfa?: 'off'|'on'|'low', challengeFailure?: 'invalid'|'expired'|'locked'|null }} opts
 */
async function installAccountSecurity(page, opts) {
  const state = { mfa: opts.mfa || 'off', challengeFailure: opts.challengeFailure || null };
  const otpauthUri = `otpauth://totp/Crewflow:${encodeURIComponent(opts.email)}?secret=${SAMPLE_SECRET}&issuer=Crewflow&algorithm=SHA1&digits=6&period=30`;
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  const json = (status, body) => ({ status, body });

  function handle(method, p) {
    if (method === 'GET' && p === '/auth/mfa') return json(200, status(state.mfa, opts.email));
    if (method === 'POST' && p === '/auth/mfa/enrolment') return json(200, { otpauthUri, qrDataUrl, manualKey: sampleKey });
    if (method === 'POST' && p === '/auth/mfa/enrolment/confirm') {
      state.mfa = 'on';
      return json(200, { recoveryCodes: SAMPLE_CODES });
    }
    if (method === 'POST' && p === '/auth/mfa/recovery-codes') return json(200, { recoveryCodes: SAMPLE_CODES });
    if (method === 'POST' && p === '/auth/mfa/disable') {
      state.mfa = 'off';
      return { status: 204, body: null };
    }
    // Sign-in: the password was right, the second factor is next.
    if (method === 'POST' && p === '/auth/login')
      return json(409, { statusCode: 409, code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify', challengeToken: `mfc_${'s'.repeat(43)}`, challengeExpiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (method === 'POST' && p === '/auth/mfa/challenge/verify') {
      if (state.challengeFailure === 'expired') return json(401, { statusCode: 401, code: 'MFA_CHALLENGE_EXPIRED', state: 'expired', message: 'Your sign-in expired. Please sign in again.' });
      if (state.challengeFailure === 'locked') return json(401, { statusCode: 401, code: 'MFA_CHALLENGE_EXHAUSTED', state: 'locked', message: 'Too many incorrect codes. Please sign in again.' });
      return json(401, { statusCode: 401, code: 'MFA_CODE_INVALID', state: 'invalid_code', message: 'That code didn’t work. Check your authenticator app and try again.', attemptsRemaining: 3 });
    }
    if (method === 'POST' && p === '/auth/mfa/challenge/cancel') return { status: 204, body: null };
    return null;
  }

  await page.route('**/rest/v1/auth/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^.*\/rest\/v1/, '');
    if (req.method() === 'OPTIONS') return r.fallback();
    const res = handle(req.method(), p);
    if (!res) return r.fallback();
    const headers = { 'access-control-allow-origin': opts.origin, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' };
    return r.fulfill({ status: res.status, headers, body: res.body === null ? '' : JSON.stringify(res.body) });
  });
  return state;
}

module.exports = { installAccountSecurity, SAMPLE_CODES };
