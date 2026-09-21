import { loginDestination, loginError, retryAfterSeconds, safeApplicationTarget } from './authErrors';

describe('authentication error and return routing', () => {
  it.each([
    [401, 'Invalid email or password.'],
    [403, 'This account does not have access to the Manager system.'],
    [503, 'Unable to sign in right now. Please try again.'],
  ])('maps HTTP %s distinctly', (status, message) => {
    expect(loginError({ response: { status } }).message).toBe(message);
  });
  it('maps network failures without blaming the password', () => {
    expect(loginError({}).message).toBe('Unable to reach the server. Check your connection and try again.');
  });
  it('respects Retry-After and does not call a 429 invalid credentials', () => {
    expect(loginError({ response: { status: 429, headers: { 'retry-after': '240' } } })).toEqual({
      message: 'Too many sign-in attempts. Please try again in 4 minutes.', cooldown: 240,
    });
    expect(retryAfterSeconds('Fri, 18 Sep 2026 12:04:00 GMT', Date.parse('2026-09-18T12:00:00Z'))).toBe(240);
  });
  it('only returns fixed internal application destinations', () => {
    expect(loginDestination('manager_web')).toBe('/login');
    expect(loginDestination('staff_app')).toBe('rab://login');
    expect(loginDestination('venue_manager_app')).toBe('rab://login');
    expect(safeApplicationTarget('//evil.example')).toBeNull();
    expect(safeApplicationTarget('https://evil.example')).toBeNull();
  });
});
