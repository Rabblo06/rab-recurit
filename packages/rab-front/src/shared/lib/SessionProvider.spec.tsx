import { act, render, waitFor } from '@testing-library/react';

import { SessionBootstrap } from './SessionProvider';
import { markAuthenticated, markUnauthenticated } from './auth-session';
import { bootstrapSession, clearSessionAndRedirect } from '../api';

jest.mock('../api', () => ({
  bootstrapSession: jest.fn(),
  clearSessionAndRedirect: jest.fn(),
}));

const mockBootstrapSession = bootstrapSession as jest.Mock;
const mockClearSessionAndRedirect = clearSessionAndRedirect as jest.Mock;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

describe('SessionBootstrap', () => {
  beforeEach(() => {
    mockBootstrapSession.mockReset().mockResolvedValue(true);
    mockClearSessionAndRedirect.mockReset();
    markUnauthenticated();
  });

  it('runs bootstrapSession exactly once on mount', async () => {
    render(<SessionBootstrap>content</SessionBootstrap>);
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(1));
  });

  it('revalidates the session when the tab becomes visible again while authenticated — the fix for an idle tab never noticing an ended session', async () => {
    markAuthenticated('access-token-1');
    render(<SessionBootstrap>content</SessionBootstrap>);
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(1)); // the mount call

    setVisibility('visible');
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(2));
  });

  it('clears the session and redirects when a visibility-triggered revalidation finds the session has actually ended', async () => {
    markAuthenticated('access-token-1');
    render(<SessionBootstrap>content</SessionBootstrap>);
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(1));

    mockBootstrapSession.mockResolvedValueOnce(false); // the visibility-triggered call fails — session actually expired
    setVisibility('visible');
    await waitFor(() => expect(mockClearSessionAndRedirect).toHaveBeenCalledTimes(1));
  });

  it('does not revalidate on visibility change when the session is not currently authenticated — no point refreshing a token that was never there', async () => {
    render(<SessionBootstrap>content</SessionBootstrap>); // mount leaves status 'loading', mockBootstrapSession resolves true but nothing calls markAuthenticated here
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    setVisibility('visible');
    // Status is still not 'authenticated' (this mock never calls
    // markAuthenticated itself, matching how the real bootstrapSession only
    // does so on an actual successful token refresh) — no extra call.
    expect(mockBootstrapSession).toHaveBeenCalledTimes(1);
  });

  it('does not revalidate when the tab becomes hidden, only when it becomes visible', async () => {
    markAuthenticated('access-token-1');
    render(<SessionBootstrap>content</SessionBootstrap>);
    await waitFor(() => expect(mockBootstrapSession).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    expect(mockBootstrapSession).toHaveBeenCalledTimes(1);
  });
});
