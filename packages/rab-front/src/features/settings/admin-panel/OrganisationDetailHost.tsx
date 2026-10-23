import { useEffect, useState } from 'react';
import OrganisationDetailDrawer from './OrganisationDetailDrawer';

const OPEN_DETAIL = 'open-admin-organisation';

/** Opens the global organisation detail drawer (platform administrators: settings, CEO invitation, two-factor reset). */
export function openOrganisationDetailDrawer(organisationId: string): void {
  document.dispatchEvent(new CustomEvent(OPEN_DETAIL, { detail: { id: organisationId } }));
}

/**
 * The organisation detail drawer, mounted ONCE in `shell/Layout.tsx` as a direct flex child of `.app-layout`, opened by
 * event — the same pattern as `CreateVenueDrawer`, `ShiftDrawers` and `OfferDecisionDrawers`. `RightSidePanel` is a
 * push-layout dock that only has a size as a flex child of the `.app-layout` row; rendered inside a Settings page (a
 * block container) its height resolved to 0 with overflow hidden — invisible and unclickable (W6-E2E-01's root cause).
 *
 * Owner correction 2026-10-23: there is no organisation-creation drawer any more (a new organisation starts only from
 * Settings → Members → Add as an email-only CEO invitation); this hosts the management drawer alone.
 */
export default function OrganisationDetailHost() {
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    const onDetail = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setDetailId(id);
    };
    document.addEventListener(OPEN_DETAIL, onDetail);
    return () => document.removeEventListener(OPEN_DETAIL, onDetail);
  }, []);

  return <OrganisationDetailDrawer open={detailId !== null} onClose={() => setDetailId(null)} organisationId={detailId} />;
}
