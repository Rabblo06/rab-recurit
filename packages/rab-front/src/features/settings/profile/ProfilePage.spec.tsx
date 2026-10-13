import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import { markAuthenticated, markUnauthenticated, getGeneration, getUserId } from '../../../shared/lib/auth-session';
import ProfilePage from './ProfilePage';
import { clearProfileDraft } from './profile-draft';

/**
 * P1B.2 — root cause: `ProfilePage` can genuinely unmount and remount (a real React Router/
 * browser-level event, reproduced directly in the P1B.2 investigation — a second browser tab
 * existing in the same context is enough to trigger it, independent of any identity change)
 * while the server data and the user's own identity are completely unchanged. A plain
 * `useEffect(() => setFirstName(profile.firstName), [profile])` cannot protect an in-progress
 * edit against that, because the component's OWN local state is wiped by the remount itself
 * before the effect ever runs. `profile-draft.ts` lifts the draft to a module-level store keyed
 * by the EXISTING P0 identity epoch (`auth-session.ts`'s `userId`/`generation` — never a second,
 * competing generation system) so it survives a same-identity remount but can never leak across
 * a real identity transition. These tests exercise the real `ProfilePage` component and the real
 * `auth-session.ts` store — never a mock of either — only `../../../shared/api` is mocked, the
 * same constraint every other component spec in this project already works under (`api.ts`'s
 * `import.meta.env` access doesn't parse under this project's CommonJS `tsconfig.spec.json`).
 */
jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), patch: jest.fn(), post: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; patch: jest.Mock; post: jest.Mock };

function fakeJwt(sub: string, sid = `sid-${sub}`): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, sid })).toString('base64url');
  return `${header}.${payload}.`;
}

function profileFor(userId: string, firstName: string) {
  return { id: userId, email: `${userId}@example.test`, firstName, lastName: 'Zed', jobTitle: null, avatarKey: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Matches every other sub-widget `ProfilePage` renders (DevicesList's `/profile/sessions`) so
 * they never resolve and never interfere with the assertions below — the same "leave everything
 * else pending" convention `Dashboard.spec.tsx` already uses for its own ignored widgets. */
function mockApiFor(profile: unknown): void {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/profile') return Promise.resolve({ data: profile });
    return new Promise(() => {});
  });
}

function mount(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ProfilePage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProfilePage — identity-scoped draft survives a same-identity remount, never an identity transition', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.patch.mockReset();
    mockApi.post.mockReset();
    clearProfileDraft();
    markUnauthenticated();
  });

  it('1: the initial server profile seeds the form', async () => {
    markAuthenticated(fakeJwt('user-a'));
    mockApiFor(profileFor('user-a', 'Alice'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(qc);

    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());
  });

  it('2: a same-user background refetch updates the form while it is still pristine', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());

    // A background refetch (e.g. another tab/admin changed the name) lands while pristine.
    mockApiFor(profileFor('user-a', 'Alicia'));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['profile'], exact: true });
    });

    await waitFor(() => expect(screen.getByDisplayValue('Alicia')).toBeInTheDocument());
  });

  it('3: a same-user background refetch does NOT overwrite a dirty (unsaved) draft', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'UNSAVED-EDIT' } });
    expect(screen.getByDisplayValue('UNSAVED-EDIT')).toBeInTheDocument();

    // A background refetch of the SAME user's (unrelated) data must never clobber this.
    mockApiFor(profileFor('user-a', 'Alice')); // server value unchanged
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['profile'], exact: true });
    });

    expect(screen.getByDisplayValue('UNSAVED-EDIT')).toBeInTheDocument();
  });

  it('4/5: a same-identity REMOUNT restores the dirty draft; an identity TRANSITION discards it and seeds only the new identity\'s own profile', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const genA = getGeneration();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    const first = mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'STALE-DRAFT-FROM-A' } });
    expect(screen.getByDisplayValue('STALE-DRAFT-FROM-A')).toBeInTheDocument();

    // 4a: a REMOUNT under the SAME identity (genA unchanged) restores the draft — simulates the
    // real React Router/browser-level remount this whole checkpoint exists to survive.
    first.unmount();
    mockApiFor(profileFor('user-a', 'Alice')); // cache already has this; query not re-fetched
    const remounted = mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('STALE-DRAFT-FROM-A')).toBeInTheDocument());
    expect(getGeneration()).toBe(genA); // confirms this really was a same-identity remount, not a transition
    remounted.unmount();

    // 4b: a genuine IDENTITY TRANSITION (A -> C) must discard A's draft entirely. `qc.clear()`
    // mirrors Login.tsx's own real post-login call (defense-in-depth alongside LogoutDialog's) —
    // the query-cache hygiene that keeps a NEW identity from ever seeing a previous one's cached
    // ['profile'] data is that file's job, not ProfilePage's; this test exercises ProfilePage's
    // own guarantee (the draft) against exactly the same real-app sequence, not a substitute for it.
    qc.clear();
    markAuthenticated(fakeJwt('user-c'));
    expect(getGeneration()).toBeGreaterThan(genA);
    mockApiFor(profileFor('user-c', 'Carla'));
    const asC = mount(qc);

    // 5: C's form is seeded ONLY from C's own server profile — never A's leftover draft text.
    await waitFor(() => expect(screen.getByDisplayValue('Carla')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('STALE-DRAFT-FROM-A')).not.toBeInTheDocument();
  });

  it('6: a stale mutation success from a previous identity/generation cannot mutate the current form', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    const patchDeferred = deferred<{ data: unknown }>();
    mockApi.patch.mockReturnValue(patchDeferred.promise);
    const asA = mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'A-EDIT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));

    // Identity moves to C before A's save ever resolves — in the real app this is exactly when
    // `api.ts`'s response interceptor would reject the eventual late response outright (see
    // identity-guard.spec.ts's own `shouldAcceptResponse` tests); here it's modelled by A's own
    // component instance being torn down, the same way a real identity transition always tears
    // down the authenticated route tree.
    asA.unmount();
    qc.clear(); // Login.tsx's own real post-login hygiene — see test 4/5's identical comment
    markAuthenticated(fakeJwt('user-c'));
    mockApiFor(profileFor('user-c', 'Carla'));
    mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Carla')).toBeInTheDocument());

    // A's stale save now resolves. Its onSuccess (clearProfileDraft + invalidateQueries) running
    // late must never repaint C's already-rendered form with A's data.
    patchDeferred.resolve({ data: {} });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByDisplayValue('Carla')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A-EDIT')).not.toBeInTheDocument();
  });

  it('7: logout clears the profile draft state', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    const first = mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'DRAFT-BEFORE-LOGOUT' } });
    first.unmount();

    markUnauthenticated(); // LogoutDialog's own real qc.clear() happens here in the actual app
    qc.clear();
    markAuthenticated(fakeJwt('user-a')); // logs back in as the SAME user after an explicit logout
    mockApiFor(profileFor('user-a', 'Alice'));
    mount(qc);

    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('DRAFT-BEFORE-LOGOUT')).not.toBeInTheDocument();
  });

  it('8: switching accounts cannot preserve the previous user\'s unsaved values', async () => {
    markAuthenticated(fakeJwt('user-a'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApiFor(profileFor('user-a', 'Alice'));
    const first = mount(qc);
    await waitFor(() => expect(screen.getByDisplayValue('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'ONLY-FOR-A' } });
    first.unmount();

    qc.clear(); // Login.tsx's own real post-login hygiene
    markAuthenticated(fakeJwt('user-b'));
    mockApiFor(profileFor('user-b', 'Bianca'));
    mount(qc);

    await waitFor(() => expect(screen.getByDisplayValue('Bianca')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('ONLY-FOR-A')).not.toBeInTheDocument();
    expect(getUserId()).toBe('user-b');
  });
});
