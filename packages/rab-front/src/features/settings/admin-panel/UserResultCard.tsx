import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { ADMIN_ERROR_TEXT, adminApi, formatDateTime, fullName, initials, roleLabel, shortId, type AdminUser } from './adminPanelApi';
import ResetTwoFactorDialog from './ResetTwoFactorDialog';

export const INSPECT_OFF = 'Inspect is turned off in this release (organisation isolation policy, 15 Oct 2026).';
export const RESET_TOOLTIP = {
  off: 'This user has not turned on 2FA, so there is nothing to reset.',
  self: 'Use Settings → Account to change your own two-factor authentication.',
  admin: 'Resetting another platform admin needs a second administrator; this isn’t available yet.',
};

/** Why Reset 2FA is unavailable for this row (null = available). Same rules the server enforces, shown up front. */
export function resetBlockedReason(user: Pick<AdminUser, 'id' | 'isPlatformAdmin' | 'twoFactor'>, meId: string | undefined): string | null {
  if (meId && user.id === meId) return RESET_TOOLTIP.self;
  if (user.isPlatformAdmin) return RESET_TOOLTIP.admin;
  if (!user.twoFactor.enabled) return RESET_TOOLTIP.off;
  return null;
}

const STATUS_TONE: Record<string, string> = { active: 'ap-ok', invited: 'ap-info', suspended: 'ap-warn', deactivated: 'ap-bad', invite_expired: 'ap-bad' };
const STATUS_LABEL: Record<string, string> = { active: 'Active', invited: 'Invited', suspended: 'Suspended', deactivated: 'Deactivated', invite_expired: 'Invite expired', unknown: 'Unknown' };
const PROVIDER_LABEL = { password: 'Password', google: 'Google', microsoft: 'Microsoft' } as const;

/**
 * One user's admin card (mockup v2 `#userResult`). Every value comes from `GET /admin/users/:id/summary`; the actions call
 * the real routes through the shared reason + step-up dialog. Inspect stays OFF (owner decision D3).
 */
export default function UserResultCard({ user, meId, onReset }: { user: AdminUser; meId?: string; onReset: (r: { name: string; revokedSessions: number }) => void }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'revoke' | 'mfa' | 'grant' | null>(null);
  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ['admin', 'users', 'summary', user.id],
    queryFn: () => adminApi.userSummary(user.id),
    staleTime: 15_000,
  });
  const name = fullName(user);
  const isMe = meId === user.id;
  const blocked = resetBlockedReason(user, meId);
  const s = summary;

  return (
    <div className="ap-card" aria-label={`User ${name}`}>
      <div className="ap-result-head">
        <div className="ap-who">
          <div className="ap-avatar" aria-hidden="true">{initials(name)}</div>
          <div style={{ minWidth: 0 }}>
            <b>{name}{isMe ? ' (you)' : ''}</b>
            <span className="ap-muted">
              {user.email} · <span className="ap-mono" title={user.id}>{shortId(user.id)}</span>
            </span>
          </div>
        </div>
        <div className="ap-row">
          <button type="button" className="ap-btn ap-sm" disabled title={INSPECT_OFF}>Inspect (off)</button>
          <button type="button" className="ap-btn ap-sm" disabled={isMe} title={isMe ? 'To sign yourself out of other devices, use Settings → Profile → Devices.' : undefined} onClick={() => setDialog('revoke')}>
            Sign out everywhere
          </button>
          <button type="button" className="ap-btn ap-sm" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setDialog('mfa')}>Reset 2FA</button>
          {!user.isPlatformAdmin && (
            <button type="button" className="ap-btn ap-sm" onClick={() => setDialog('grant')}>Make platform admin</button>
          )}
        </div>
      </div>
      <div className="ap-grid-2" style={{ marginTop: 14 }}>
        <dl className="ap-kv">
          <dt>Organisation</dt><dd>{user.organisationName ?? '—'}</dd>
          <dt>Roles</dt><dd>{roleLabel(user)}</dd>
          <dt>Status</dt><dd><span className={`ap-pill ${STATUS_TONE[user.status] ?? ''}`}>{STATUS_LABEL[user.status] ?? user.status}</span></dd>
          <dt>Platform admin</dt><dd>{user.isPlatformAdmin ? 'Yes' : 'No'}</dd>
        </dl>
        <dl className="ap-kv">
          <dt>Two-factor</dt>
          <dd>
            {user.twoFactor.enabled ? <span className="ap-pill ap-ok">On</span> : <span className="ap-pill">Off</span>}{' '}
            <span className="ap-muted">
              {user.twoFactor.enabled
                ? `Turned on ${formatDateTime(user.twoFactor.enabledAt)}${user.twoFactor.recoveryCodesTotal ? ` · ${user.twoFactor.recoveryCodesRemaining ?? 0} of ${user.twoFactor.recoveryCodesTotal} recovery codes left` : ''}`
                : 'User’s choice. 2FA is optional for everyone.'}
            </span>
          </dd>
          <dt>App</dt>
          <dd>{isLoading ? 'Loading…' : isError || !s ? 'Not available' : sessionsText(s.sessions)}</dd>
          <dt>Last sign-in</dt>
          <dd>{user.lastLoginAt ? `${formatDateTime(user.lastLoginAt)}${s?.lastSignInProvider ? ` · ${PROVIDER_LABEL[s.lastSignInProvider]}` : ''}` : 'Never'}</dd>
          <dt>Failed sign-ins</dt>
          <dd>{isLoading ? 'Loading…' : isError || !s ? 'Not available' : `${s.failedSignIns24h} in the last 24 h`}</dd>
        </dl>
      </div>

      {dialog === 'revoke' && (
        <AdminActionDialog
          title={`Sign ${name} out everywhere`}
          body={`Ends ${s ? `all ${s.sessions.total} session${s.sessions.total === 1 ? '' : 's'}` : 'every session'} and refresh tokens. They will need to sign in again on every device.`}
          confirmLabel="Sign out everywhere"
          errorText={ADMIN_ERROR_TEXT}
          failureText={`Could not sign ${name} out. Please try again.`}
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const result = await adminApi.revokeSessions(user.id, reason);
            await qc.invalidateQueries({ queryKey: ['admin', 'users', 'summary', user.id] });
            toast.success(`All sessions revoked (${result.revokedSessions}).`);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'mfa' && (
        <ResetTwoFactorDialog userId={user.id} userLabel={name} onClose={() => setDialog(null)} onDone={(r) => onReset({ name, revokedSessions: r.revokedSessions })} />
      )}
      {dialog === 'grant' && (
        <AdminActionDialog
          title="Add a platform admin"
          body={`Platform admins can see every organisation, suspend organisations and reset 2FA. ${name} will be signed out everywhere and must sign in again. Confirm with your password (and your code if you use 2FA), or leave it empty to be asked.`}
          confirmLabel="Add platform admin"
          errorText={ADMIN_ERROR_TEXT}
          failureText={`Could not make ${name} a platform admin. Please try again.`}
          onConfirm={async ({ reason, currentPassword, code }) => {
            // B3: `{ reason }` only; the proof is a recent step-up of this session (POST /auth/step-up when typed here).
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const result = await adminApi.grantPlatformAdmin(user.id, reason);
            await qc.invalidateQueries({ queryKey: ['admin'] });
            if (result.granted) toast.success(`${name} is now a platform admin. ${result.revokedSessions} session${result.revokedSessions === 1 ? ' was' : 's were'} ended.`);
            else toast.info(`${name} is already a platform admin.`);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function sessionsText(s: { total: number; managerWeb: number; venueManagerApp: number; staffApp: number }): string {
  if (s.total === 0) return 'No active sessions';
  const parts = [
    s.managerWeb ? `${s.managerWeb} web` : null,
    s.venueManagerApp ? `${s.venueManagerApp} venue manager app` : null,
    s.staffApp ? `${s.staffApp} staff app` : null,
  ].filter(Boolean);
  return `${parts.join(' · ')} · ${s.total} session${s.total === 1 ? '' : 's'}`;
}
