import { markAuthenticated, markUnauthenticated, getGeneration } from '../../../shared/lib/auth-session';
import { clearProfileDraft, getProfileDraft, setProfileDraft } from './profile-draft';

function fakeJwt(sub: string, sid = `sid-${sub}`): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, sid })).toString('base64url');
  return `${header}.${payload}.`;
}

describe('profile-draft — identity-scoped, module-level (survives a component remount; never crosses an identity transition)', () => {
  beforeEach(() => {
    clearProfileDraft();
    markUnauthenticated();
  });

  it('returns null when nothing has ever been written', () => {
    markAuthenticated(fakeJwt('user-a'));
    expect(getProfileDraft()).toBeNull();
  });

  it('returns exactly what was written, for the SAME identity', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'A', lastName: 'B', jobTitle: 'C' });
    expect(getProfileDraft()).toEqual({ firstName: 'A', lastName: 'B', jobTitle: 'C' });
  });

  it('is NOT cleared by a mere remount simulation (re-reading after "unmount" with no identity change)', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'SURVIVES', lastName: '', jobTitle: '' });
    // Nothing else happens — no markAuthenticated/markUnauthenticated call — modelling a pure
    // component remount with the browser's identity completely unchanged.
    expect(getProfileDraft()?.firstName).toBe('SURVIVES');
  });

  it('is cleared the instant a NEW login happens (even as the exact same user — generation always bumps)', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'BEFORE', lastName: '', jobTitle: '' });
    const before = getGeneration();

    markAuthenticated(fakeJwt('user-a')); // re-login as self — generation bumps regardless (auth-session.ts's own rule)
    expect(getGeneration()).toBeGreaterThan(before);
    expect(getProfileDraft()).toBeNull();
  });

  it('is cleared on logout', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'BEFORE-LOGOUT', lastName: '', jobTitle: '' });
    markUnauthenticated();
    expect(getProfileDraft()).toBeNull();
  });

  it('never leaks across an identity transition to a DIFFERENT user', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'ONLY-A', lastName: '', jobTitle: '' });
    markAuthenticated(fakeJwt('user-c'));
    expect(getProfileDraft()).toBeNull();
  });

  it('clearProfileDraft() removes it outright, for any identity', () => {
    markAuthenticated(fakeJwt('user-a'));
    setProfileDraft({ firstName: 'X', lastName: '', jobTitle: '' });
    clearProfileDraft();
    expect(getProfileDraft()).toBeNull();
  });

  it('setProfileDraft is a no-op with no current identity (never attributes a draft to "nobody")', () => {
    setProfileDraft({ firstName: 'ORPHAN', lastName: '', jobTitle: '' });
    markAuthenticated(fakeJwt('user-a'));
    expect(getProfileDraft()).toBeNull();
  });
});
