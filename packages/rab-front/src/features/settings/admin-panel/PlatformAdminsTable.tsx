import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { adminApi, formatDate, type AdminPlatformAdmin } from './adminPanelApi';

/**
 * Platform admins (mockup v2). Rows from `GET /admin/platform-admins` (admin_list_platform_admins). "Remove" is hidden for
 * yourself and disabled for the last admin — UX only: the server-side guards (can't remove yourself, can't remove the
 * last admin, a required reason) are PENDING (B3, `platform-admin.service.ts` is another lane's file), so the dialog
 * sends exactly the current DTO `{ currentPassword }`.
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
          body="Their platform-admin sessions end straight away. Their normal account is kept."
          confirmLabel="Remove"
          tone="danger"
          reason={false}
          passwordRequired
          onConfirm={async ({ currentPassword, code }) => {
            if (code) await adminApi.stepUpIfGiven({ currentPassword, code });
            await adminApi.revokePlatformAdmin(removing.userId, currentPassword);
            await qc.invalidateQueries({ queryKey: ['admin'] });
            toast.success('Platform admin removed');
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
