import { loginDestination, loginError, postAuthSuccessCopy, retryAfterSeconds, safeApplicationTarget, SessionNotEstablishedError, WRONG_WORKSPACE_SIGN_IN_MESSAGE } from './authErrors';

describe('authentication error and return routing', () => {
  it.each([
    [401, 'Invalid email or password.'],
    [403, 'This account does not have access to the Manager system.'],
    [503, 'Unable to sign in right now. Please try again.'],
  ])('maps HTTP %s distinctly', (status, message) => {
    expect(loginError({ response: { status } }).message).toBe(message);
  });
  it('W6-E2E-02: a sign-in refused on another workspace host says so (never "Unable to reach the server") and carries the server URL', () => {
    const failure = loginError({ response: { status: 404, data: { code: 'WORKSPACE_HOST_SIGN_IN_REFUSED', message: 'Not found.', canonicalUrl: 'https://app.example.com' } } });
    expect(failure).toEqual({ message: WRONG_WORKSPACE_SIGN_IN_MESSAGE, cooldown: 0, signInUrl: 'https://app.example.com' });
    expect(failure.message).not.toMatch(/reach the server/);
    // An ordinary 404 is not that.
    expect(loginError({ response: { status: 404, data: {} } }).message).toBe('Unable to sign in right now. Please try again.');
  });
  it('W6-E2E-02: credentials accepted but the session could not be read back is not a network failure', () => {
    expect(loginError(new SessionNotEstablishedError()).message).toMatch(/finish signing you in/);
    expect(loginError(new SessionNotEstablishedError()).message).not.toMatch(/reach the server/);
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

  // Required once activation/reset pages move to the separate accounts
  // domain — a relative '/login' there would open the accounts site's own
  // page instead of the Manager app, so the backend-supplied absolute URL
  // must be used for the manager case, while Staff/Venue Manager must never
  // be routed into the Manager web app regardless of what's passed in.
  it('uses the backend-supplied absolute URL for manager_web once the account pages are on a separate domain', () => {
    expect(loginDestination('manager_web', 'https://app.rabworkspaceteams.co.uk/login')).toBe('https://app.rabworkspaceteams.co.uk/login');
    expect(loginDestination('manager_web')).toBe('/login'); // falls back when no absolute URL was supplied
  });

  it('never routes Staff or Venue Manager into the Manager web app, even if an absolute URL is supplied', () => {
    expect(loginDestination('staff_app', 'https://app.rabworkspaceteams.co.uk/login')).toBe('rab://login');
    expect(loginDestination('venue_manager_app', 'https://app.rabworkspaceteams.co.uk/login')).toBe('rab://login');
  });

  it('post-auth success copy: Manager gets a "Continue to Manager Portal" action to the absolute Manager app URL', () => {
    expect(postAuthSuccessCopy('manager_web', 'https://app.rabworkspaceteams.co.uk/login')).toEqual({
      actionLabel: 'Continue to Manager Portal',
      loginHref: 'https://app.rabworkspaceteams.co.uk/login',
    });
  });

  it('post-auth success copy: Staff and Venue Manager are told to use the mobile app, never the Manager dashboard', () => {
    expect(postAuthSuccessCopy('staff_app')).toEqual({
      description: 'You can now sign in using the ADOLPHUS mobile app.',
      actionLabel: 'Open the app',
      loginHref: 'rab://login',
    });
    expect(postAuthSuccessCopy('venue_manager_app')).toEqual({
      description: 'You can now sign in using the ADOLPHUS mobile app.',
      actionLabel: 'Open the app',
      loginHref: 'rab://login',
    });
  });
});
