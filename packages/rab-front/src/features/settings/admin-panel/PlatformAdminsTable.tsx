import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { ADMIN_ERROR_TEXT, adminApi, formatDate, type AdminPlatformAdmin } from './adminPanelApi';

/**
 * Platform admins (mockup v2). Rows from `GET /admin/platform-admins` (admin_list_platform_admins). "Remove" is hidden for
 * yourself and disabled for the last admin — UX only: the server refuses both (409 PLATFORM_ADMIN_SELF_REMOVAL /
 * LAST_PLATFORM_ADMIN, race-safe), requires a reason and a recent step-up ('platform.admin.revoke'; B3).
 */
export default function PlatformAdminsTable({ admins, total, loading, error, onAdd }: { admins: AdminPlatformAdmin[] | undefined; total?: number; loading: boolean; error: boolean; onAdd: () => void }) {
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<AdminPlatformAdmin | null>(null);
  const activeCount = Array.isArray(admins) ? admins.length : 0;
  return (
    <section className="ap-block" aria-label="Platform admins">
      <div className="ap-block-head">
        <h2 className="ap-h2">Platform admins</h2>
        <button type="button" className="ap-btn" onClick={onAdd}>Add platform admin</button>
      </div>
      <div className="ap-tablewrap">
        <table className="ap-table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Two-factor</th><th>Added</th><th>Added by</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="ap-empty">Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={6} className="ap-empty">Platform admins could not be loaded.</td></tr>
            ) : activeCount === 0 ? (
              <tr><td colSpan={6} className="ap-empty">No active platform admins.</td></tr>
            ) : (
              admins!.map((a) => (
                <tr key={a.userId}>
                  <td>{`${a.firstName} ${a.lastName}`.trim() || a.email}{a.isYou ? ' (you)' : ''}</td>
                  <td>{a.email}</td>
                  <td>{a.twoFactorEnabled ? <span className="ap-pill ap-ok">On</span> : <span className="ap-pill">Off</span>}</td>
                  <td>{formatDate(a.grantedAt)}</td>
                  <td className={a.grantedBy ? undefined : 'ap-muted'}>{a.grantedBy ? a.grantedBy.name || 'Unknown' : 'bootstrap-admin'}</td>
                  <td>
                    {!a.isYou && (
                      <button
                        type="button"
                        className="ap-btn ap-sm ap-danger"
                        disabled={activeCount <= 1}
                        title={activeCount <= 1 ? 'The last platform admin cannot be removed.' : undefined}
                        onClick={() => setRemoving(a)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {typeof total === 'number' && total > activeCount && (
          <div className="ap-table-foot"><span>Showing {activeCount} of {total} platform admins (you first, then the most recently added).</span></div>
        )}
      </div>
      {removing && (
        <AdminActionDialog
          title={`Remove ${`${removing.firstName} ${removing.lastName}`.trim() || removing.email} as platform admin`}
          body="They lose platform-admin access on their next request. Their normal account is kept. Confirm with your password (and your code if you use 2FA), or leave it empty to be asked."
          confirmLabel="Remove"
          tone="danger"
          errorText={ADMIN_ERROR_TEXT}
          failureText="Could not remove this platform admin. Please try again."
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const result = await adminApi.revokePlatformAdmin(removing.userId, reason);
            if (result.revoked) toast.success('Platform admin removed');
            else toast.info('They were no longer a platform admin. The list is refreshed.');
            setRemoving(null);
            void qc.invalidateQueries({ queryKey: ['admin', 'platform-admins'] });
            void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
            void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
