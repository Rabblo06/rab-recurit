import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, broadcastLogout, withAuthLock } from '../../shared/api';
import { markUnauthenticated } from '../../shared/lib/auth-session';
import ConfirmDialog from '../../shared/components/ConfirmDialog';

export default function LogoutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function confirmLogout() {
    setLoading(true);
    // Revokes the refresh token family server-side (rab-workforce-architecture.md
    // §8.1) and clears the HttpOnly cookie via Set-Cookie — the server reads
    // the token to revoke from that same cookie, no body needed. Clearing
    // just the in-memory access token below is not a logout on its own; it'd
    // just make this tab forget a session still valid everywhere else.
    // P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): serialized with login/refresh across every
    // tab sharing this browser profile, same reasoning as Login.tsx's own withAuthLock call.
    try {
      await withAuthLock(() => api.post('/auth/logout'));
    } catch {
      // Best-effort: still clear the local session even if the revoke call fails.
    }
    markUnauthenticated();
    // Tell every other tab sharing this browser immediately, rather than letting them discover
    // the ended session only on their own next request's 401 (§16B — cross-tab logout).
    broadcastLogout();
    // This is a client-side route change (useNavigate), not a full page
    // reload — the single app-wide QueryClient instance survives it. Without
    // this, a different account logging in on the same tab right after would
    // still see the previous user's cached ['me'], offers, notifications,
    // etc. until each query's own staleTime/gcTime happened to expire.
    qc.clear();
    setLoading(false);
    nav('/login');
  }

  return (
    <ConfirmDialog
      open={open}
      title="Log out?"
      description="Are you sure you want to log out of your account?"
      confirmLabel="Log out"
      destructive
      loading={loading}
      onConfirm={confirmLogout}
      onCancel={onClose}
    />
  );
}
