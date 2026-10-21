import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import {
  API_ERROR_MESSAGES,
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  isSafeServerMessage,
  normalizeApiError,
} from './apiError';

function httpError(status: number, data?: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response = { status, statusText: '', headers: {}, config, data } as AxiosResponse;
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, {}, response);
}

describe('normalizeApiError — status mapping', () => {
  it('401 → session expired, never the server text', () => {
    const n = normalizeApiError(httpError(401, { statusCode: 401, message: 'Invalid session.' }));
    expect(n).toMatchObject({ kind: 'unauthorized', status: 401, message: 'Your session has expired. Please sign in again.' });
  });

  it('403 → permission message for the Nest default, the safe domain message when the server gives one', () => {
    expect(getApiErrorMessage(httpError(403, { message: 'Forbidden resource' }))).toBe("You don't have permission to perform this action.");
    expect(getApiErrorMessage(httpError(403, {}))).toBe("You don't have permission to perform this action.");
    expect(getApiErrorMessage(httpError(403, { message: 'You cannot approve your own hours.' }))).toBe('You cannot approve your own hours.');
  });

  it('404 → fixed text, never echoing what the server said', () => {
    expect(getApiErrorMessage(httpError(404, { message: 'Venue manager not found in workspace.' }))).toBe('The requested item could not be found.');
  });

  it('409 → the server domain message when safe, generic "record has changed" otherwise', () => {
    expect(getApiErrorMessage(httpError(409, { message: 'This subdomain is already taken.' }))).toBe('This subdomain is already taken.');
    expect(getApiErrorMessage(httpError(409, { message: 'Invalid transition: pending -> approved' }))).toBe('This record has changed. Refresh and try again.');
    expect(getApiErrorMessage(httpError(409, { message: 'Conflict' }))).toBe('This record has changed. Refresh and try again.');
  });

  it('413 and Multer "File too large" → file too large; caller can supply the limit', () => {
    expect(getApiErrorMessage(httpError(413))).toBe(API_ERROR_MESSAGES.payload_too_large);
    expect(normalizeApiError(httpError(400, { message: 'File too large' })).kind).toBe('payload_too_large');
    expect(getApiErrorMessage(httpError(413), { messages: { payload_too_large: 'Photos must be 5 MB or smaller.' } })).toBe('Photos must be 5 MB or smaller.');
  });

  it('429 → try again shortly (or the safe domain message), retryable', () => {
    const n = normalizeApiError(httpError(429, { message: 'ThrottlerException: Too Many Requests' }));
    expect(n).toMatchObject({ kind: 'rate_limited', retryable: true, message: 'Too many requests. Please try again shortly.' });
    // a written, domain-specific 429 is kept
    expect(getApiErrorMessage(httpError(429, { message: 'Too many invitations have been sent recently. Please try again later.' }))).toBe('Too many invitations have been sent recently. Please try again later.');
  });

  it.each([500, 502, 503, 504])('%s → generic, even when the body leaks internals', (status) => {
    const n = normalizeApiError(httpError(status, { message: 'QueryFailedError: relation "workspace_ab12".shift does not exist' }));
    expect(n).toMatchObject({ kind: 'server', retryable: true, message: 'Something went wrong. Please try again.', serverMessage: null });
  });

  it('no response (offline / CORS / DNS) → connection lost', () => {
    const n = normalizeApiError(new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders() }));
    expect(n).toMatchObject({ kind: 'offline', status: null, retryable: true, message: 'Connection lost. Check your internet connection.' });
  });

  it('timeout → took too long', () => {
    expect(normalizeApiError(new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED')).kind).toBe('timeout');
  });

  it('400 → safe server message, else the caller fallback, else the generic validation text', () => {
    expect(getApiErrorMessage(httpError(400, { message: 'Subdomain must be 3–30 characters.' }), 'Could not save.')).toBe('Subdomain must be 3–30 characters.');
    expect(getApiErrorMessage(httpError(400, { message: ['property organisationId should not exist'] }), 'Could not save.')).toBe('Could not save.');
    expect(getApiErrorMessage(httpError(400, { message: ['email must be an email'] }))).toBe('Please check the details and try again.');
    // first SAFE entry of a class-validator array wins
    expect(getApiErrorMessage(httpError(400, { message: ['name should not be empty', 'Reason must be 3–500 characters.'] }))).toBe('Reason must be 3–500 characters.');
  });

  it('non-HTTP errors never show error.message', () => {
    expect(getApiErrorMessage(new Error('Cannot read properties of undefined (reading "id")'), 'Could not load.')).toBe('Could not load.');
    expect(getApiErrorMessage(new Error('Stale response: browser identity changed'))).toBe('Something went wrong. Please try again.');
    expect(getApiErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });

  it('accepts axios-shaped objects (re-thrown errors, test doubles) the same way', () => {
    expect(getApiErrorMessage({ response: { data: { message: 'Member not found.' } } }, 'Try again.')).toBe('Member not found.');
    expect(getApiErrorMessage({ response: { status: 500, data: { message: 'boom at x.ts:1' } } })).toBe('Something went wrong. Please try again.');
    expect(getApiErrorMessage({ response: {} }, 'Try again.')).toBe('Try again.');
  });

  it('preserves the server code and status for callers that branch on them', () => {
    const e = httpError(409, { statusCode: 409, code: 'EMAIL_UNAVAILABLE', message: 'This email address cannot be used.' });
    expect(normalizeApiError(e)).toMatchObject({ code: 'EMAIL_UNAVAILABLE', status: 409, message: 'This email address cannot be used.' });
    expect(getApiErrorCode(e)).toBe('EMAIL_UNAVAILABLE');
    expect(getApiErrorStatus(e)).toBe(409);
    expect(getApiErrorCode(new Error('x'))).toBeNull();
  });
});

describe('isSafeServerMessage', () => {
  it.each([
    'This subdomain is already taken.',
    'Select a venue from the list.',
    'Delete this role before removing its members.',
    'Only managers can approve payroll.',
  ])('accepts plain domain text: %s', (m) => expect(isSafeServerMessage(m)).toBe(true));

  it.each([
    'SELECT * FROM "user" WHERE id = $1',
    'duplicate key value violates unique constraint "uq_user_email"',
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    '    at UserService.find (/app/dist/modules/user/user.service.js:42:11)',
    'Failed at C:\\Rab-recruit\\packages\\rab-server\\src\\main.ts',
    'Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc rejected',
    'Shift 3f0e2b1c-9a7d-4c3e-8f21-0d6a5b4c3e2f not found',
    'TypeError: Cannot read properties of undefined',
    'Internal server error',
    '<html><body>502 Bad Gateway</body></html>',
    'x'.repeat(301),
    42,
    null,
  ])('rejects technical or framework text: %s', (m) => expect(isSafeServerMessage(m)).toBe(false));
});
