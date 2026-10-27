import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceDesktop, IconDeviceMobile, IconDeviceTablet, IconDots, IconLogout } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { timeAgo } from '../../../shared/lib/timeAgo';
import { ListSkeleton } from '../../../shared/components/LoadingState';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Popover from '../../../shared/components/Popover';
import { describeDevice, type DeviceKind } from './device-label';
import './devices.css';

interface Session {
  familyId: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  /** `private`: a loopback/private address (e.g. the local Docker gateway) — the real client IP could not be verified. */
  ipScope: 'public' | 'private' | null;
  createdAt: string;
  lastActiveAt: string;
  isCurrentDevice: boolean;
}

const SESSIONS_KEY = ['profile', 'sessions'] as const;
const KIND_ICON: Record<DeviceKind, typeof IconDeviceDesktop> = { desktop: IconDeviceDesktop, mobile: IconDeviceMobile, tablet: IconDeviceTablet };

function sessionMeta(session: Session): string {
  const parts = [`Last active ${timeAgo(session.lastActiveAt)}`];
  if (session.ip) parts.push(session.ipScope === 'private' ? `Private network (${session.ip})` : session.ip);
  return parts.join(' · ');
}

/** One remote session's "More options" menu: currently a single "Log out" action. */
function SessionMenu({ session, label, onLogOut, busy }: { session: Session; label: string; onLogOut: (id: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="device-menu-trigger"
        aria-label={`More options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconDots size={16} aria-hidden="true" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="end" minWidth={160} role="presentation">
        <div role="menu" aria-label={`Options for ${label}`} className="device-menu">
          <button
            type="button"
            role="menuitem"
            className="device-menu-item device-menu-item-danger"
            disabled={busy}
            autoFocus
            onClick={() => { setOpen(false); onLogOut(session.familyId); }}
          >
            <IconLogout size={14} aria-hidden="true" />
            Log out
          </button>
        </div>
      </Popover>
    </>
  );
}

/**
 * Settings → Profile → Devices. Lists exactly the sessions the server would still accept (`GET /profile/sessions` applies the
 * same liveness rule as authentication: not revoked, not absolutely or idle-expired, refresh family live). The current session
 * is identified by the server from the authenticated session — never by the client. Each other session can be logged out on
 * its own; genuinely distinct sessions are never merged, even when they share a browser label or IP.
 */
export default function DevicesList() {
  const qc = useQueryClient();
  const [confirmOthers, setConfirmOthers] = useState(false);
  const sessionsQuery = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: async () => (await api.get<Session[]>('/profile/sessions')).data,
  });

  // DELETE /profile/sessions/:familyId → 204 once the server has revoked that session. A 404 means it had already ended
  // (expired, or logged out elsewhere); the list is refreshed either way so it never shows a session that is gone.
  const revoke = useFeedbackMutation<unknown, string>({
    mutationFn: (familyId) => api.delete(`/profile/sessions/${familyId}`),
    successMessage: 'Device logged out.',
    errorFeedback: {
      fallback: 'Could not log out this device. Please try again.',
      messages: { server: 'Could not log out this device. Please try again.', not_found: 'That session had already ended.' },
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });

  // Keeps this device signed in — only every OTHER session is ended. Answers `{ revokedCount }`.
  const revokeOthers = useFeedbackMutation<{ revokedCount: number }>({
    mutationFn: async () => (await api.delete<{ revokedCount: number }>('/profile/sessions')).data,
    successMessage: (data) => {
      const n = typeof data?.revokedCount === 'number' ? data.revokedCount : null;
      if (n === null) return 'Logged out all other devices.';
      return n === 1 ? 'Logged out 1 other device.' : `Logged out ${n} other devices.`;
    },
    errorFeedback: { fallback: 'Could not log out your other devices. Please try again.', messages: { server: 'Could not log out your other devices. Please try again.' } },
    onSettled: () => {
      setConfirmOthers(false);
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  if (sessionsQuery.isLoading) return <ListSkeleton rows={3} />;
  if (sessionsQuery.isError) {
    // A failed request is never presented as "no active sessions" — it says what failed and offers Retry.
    const status = (sessionsQuery.error as { response?: { status?: number } } | null)?.response?.status;
    const message = status === 401
      ? 'Your session has ended, so your devices could not be loaded. Sign in again.'
      : status && status >= 500
        ? 'The session service is unavailable right now, so your devices could not be loaded.'
        : 'Your devices could not be loaded. Check your connection.';
    return (
      <p role="alert" className="device-error feedback-error">
        {message}{' '}
        <button type="button" className="btn btn-outline" onClick={() => void sessionsQuery.refetch()}>Retry</button>
      </p>
    );
  }

  // This device first, then the server's most-recent-activity order (stable sort; nothing merged or hidden).
  const sessions = [...(sessionsQuery.data ?? [])].sort((a, b) => Number(b.isCurrentDevice) - Number(a.isCurrentDevice));
  const hasCurrent = sessions.some((s) => s.isCurrentDevice);
  const hasOthers = sessions.some((s) => !s.isCurrentDevice);

  return (
    <div className="devices-list">
      {sessions.length === 0 ? (
        // Only a successful, genuinely empty response reaches this (errors return above).
        <p className="device-empty">No active sessions were returned for your account.</p>
      ) : (
        <ul className="device-rows" aria-label="Active sessions">
          {sessions.map((s) => {
            const { label, kind } = describeDevice(s.userAgent);
            const Icon = KIND_ICON[kind];
            return (
              <li key={s.familyId} className="device-row">
                <span className="device-icon" aria-hidden="true"><Icon size={18} stroke={1.6} /></span>
                <span className="device-info">
                  <span className="device-name">{label}</span>
                  <span className="device-meta">{sessionMeta(s)}</span>
                </span>
                {s.isCurrentDevice ? (
                  <span className="device-current-badge">This device</span>
                ) : revoke.busy && revoke.variables === s.familyId ? (
                  <span className="device-meta" role="status">Logging out…</span>
                ) : (
                  <SessionMenu session={s} label={label} onLogOut={(id) => revoke.submit(id)} busy={revoke.busy} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasCurrent && hasOthers && (
        <div className="device-list-actions">
          <button type="button" className="btn btn-outline" onClick={() => setConfirmOthers(true)}>
            Log out all other devices
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmOthers}
        title="Log out all other devices?"
        description="This device stays signed in. Every other session is ended immediately."
        confirmLabel="Log out other devices"
        destructive
        loading={revokeOthers.busy}
        onConfirm={() => revokeOthers.submit()}
        onCancel={() => setConfirmOthers(false)}
      />
    </div>
  );
}
