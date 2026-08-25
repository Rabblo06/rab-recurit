import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import ConfirmDialog from '../../shared/components/ConfirmDialog';

export default function LogoutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function confirmLogout() {
    setLoading(true);
    // Revokes the refresh token family server-side (rab-workforce-architecture.md
    // §8.1) — deleting the local tokens alone is not a logout, it just makes
    // this tab forget a session that's still valid everywhere else.
    const refreshToken = localStorage.getItem('refreshToken');
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken });
    } catch {
      // Best-effort: still clear the local session even if the revoke call fails.
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
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
