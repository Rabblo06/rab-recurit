/**
 * W6-E2E-04 — owner decision 2026-10-23: organisation settings are changed by a platform administrator only. The
 * organisation's own pages show them read-only with this notice; the server has no tenant route to change them.
 */
export default function ManagedByPlatformAdminNotice() {
  return (
    <p role="note" className="cell-muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
      Managed by your platform administrator. Contact them to change these settings.
    </p>
  );
}
