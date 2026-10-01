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

  // ---------------------------------------------------------------------------------------------- Phase 10 §26/§28: foreground deadline timer
  describe('foreground absolute-deadline timer (UX only — see SessionProvider\'s own doc comment)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('an actively-visible tab clears its session and redirects the MOMENT the deadline passes, with no user interaction', async () => {
      markAuthenticated('access-token-1', new Date(Date.now() + 5000));
      render(<SessionBootstrap>content</SessionBootstrap>);
      await act(async () => {
        jest.advanceTimersByTime(5001);
      });
      expect(mockClearSessionAndRedirect).toHaveBeenCalledTimes(1);
    });

    it('does nothing before the deadline arrives', async () => {
      markAuthenticated('access-token-1', new Date(Date.now() + 5000));
      render(<SessionBootstrap>content</SessionBootstrap>);
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      expect(mockClearSessionAndRedirect).not.toHaveBeenCalled();
    });

    it('a session with no known deadline schedules no timer at all (does not throw, does not redirect)', async () => {
      markAuthenticated('access-token-1'); // no expiresAt — matches every OTHER test in this file
      render(<SessionBootstrap>content</SessionBootstrap>);
      await act(async () => {
        jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      });
      expect(mockClearSessionAndRedirect).not.toHaveBeenCalled();
    });

    it('logging in again with a LATER deadline reschedules the timer to the new deadline, not the old one', async () => {
      markAuthenticated('access-token-1', new Date(Date.now() + 1000));
      render(<SessionBootstrap>content</SessionBootstrap>);
      act(() => {
        markAuthenticated('access-token-2', new Date(Date.now() + 10_000)); // fresh login before the old deadline hits
      });
      await act(async () => {
        jest.advanceTimersByTime(2000); // past the OLD deadline, well before the new one
      });
      expect(mockClearSessionAndRedirect).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(9000);
      });
      expect(mockClearSessionAndRedirect).toHaveBeenCalledTimes(1);
    });

    it('a deadline already in the past when the tab loads redirects immediately, without waiting for a timer tick', async () => {
      markAuthenticated('access-token-1', new Date(Date.now() - 1000));
      render(<SessionBootstrap>content</SessionBootstrap>);
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockClearSessionAndRedirect).toHaveBeenCalledTimes(1);
    });
  });
});
