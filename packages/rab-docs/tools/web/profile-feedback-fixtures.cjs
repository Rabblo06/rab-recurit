// Settings → Profile feedback fixtures (2026-10-25). Answers the Profile endpoints with the success AND failure responses
// the real rab-server returns, for the before/after feedback screenshots only. Same rules as fixtures.cjs: the UI is the
// real rab-front build; every response is synthetic and fictional and is intercepted inside the browser with
// `page.route`. Nothing reaches a real API.
//
// Response shapes mirror the server exactly:
//  - PATCH /profile, POST/DELETE /profile/avatar → ProfileService.toProfileResponse ({ id, email, firstName, lastName,
//    jobTitle, avatarKey }).
//  - class-validator 400 → Nest's default ValidationPipe body ({ statusCode, message: string[], error }).
//  - 413 → FileInterceptor's PayloadTooLargeException for Multer LIMIT_FILE_SIZE ("File too large"), 10 MB (AVATAR_MAX_BYTES).
//  - 400 type → FileService.validateContent's byte-sniff rejection text.
//  - storage failure → StorageError, which AllExceptionsFilter turns into the generic 500 body.
//  - 429 → the Nest throttler's default body.
'use strict';

const NEST_500 = { statusCode: 500, message: 'Internal server error' };

/** One scenario = overrides keyed by `METHOD path` (path relative to /rest/v1). `abort` simulates a dropped connection. */
const SCENARIOS = {
  'save-500': { 'PATCH /profile': { status: 500, body: NEST_500 } },
  'save-400': { 'PATCH /profile': { status: 400, body: { statusCode: 400, message: ['firstName must be longer than or equal to 1 characters'], error: 'Bad Request' } } },
  'save-403': { 'PATCH /profile': { status: 403, body: { statusCode: 403, message: 'Admin Inspect is read-only.', error: 'Forbidden' } } },
  'save-offline': { 'PATCH /profile': { abort: 'internetdisconnected' } },
  'save-slow': { 'PATCH /profile': { delayMs: 2500 } },
  'upload-slow': { 'POST /profile/avatar': { delayMs: 3000 } },
  'upload-type': { 'POST /profile/avatar': { status: 400, body: { statusCode: 400, message: 'Unsupported file type. Only PNG, JPG and WEBP images are accepted.', error: 'Bad Request' } } },
  'upload-large': { 'POST /profile/avatar': { status: 413, body: { statusCode: 413, message: 'File too large', error: 'Payload Too Large' } } },
  'upload-storage': { 'POST /profile/avatar': { status: 500, body: NEST_500 } },
  'upload-offline': { 'POST /profile/avatar': { abort: 'internetdisconnected' } },
  'remove-500': { 'DELETE /profile/avatar': { status: 500, body: NEST_500 } },
  'password-429': { 'POST /auth/forgot-password': { status: 429, body: { statusCode: 429, message: 'ThrottlerException: Too Many Requests' } } },
  'device-500': { 'DELETE /profile/sessions/sess-mac': { status: 500, body: NEST_500 } },
  'devices-403': { 'DELETE /profile/sessions': { status: 403, body: { statusCode: 403, message: 'Admin Inspect is read-only.', error: 'Forbidden' } } },
};

/**
 * Registers the overrides AFTER fixtures.install (Playwright: the most recently added matching route wins). Requests the
 * scenario does not name fall back to fixtures.cjs (its own success responses). Returns `{ calls }`: every intercepted
 * mutation, so a capture can prove a duplicate click sent one request.
 */
async function installProfileFeedback(page, { origin, scenario }) {
  const overrides = SCENARIOS[scenario] || {};
  const calls = [];
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/(profile|auth\/forgot-password)/, async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fallback();
    const p = new URL(req.url()).pathname.replace(/^.*\/rest\/v1/, '');
    const key = `${req.method()} ${p}`;
    if (req.method() !== 'GET') calls.push(key);
    const o = overrides[key];
    if (!o) return r.fallback();
    if (o.delayMs) await new Promise((resolve) => setTimeout(resolve, o.delayMs));
    if (o.abort) return r.abort(o.abort);
    if (!o.status) return r.fallback();
    return r.fulfill({ status: o.status, headers: cors, body: JSON.stringify(o.body) });
  });
  return { calls };
}

module.exports = { installProfileFeedback, SCENARIOS };
