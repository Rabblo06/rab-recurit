import { useEffect, useState } from 'react';
import NewOrganisationDrawer from './NewOrganisationDrawer';
import OrganisationDetailDrawer from './OrganisationDetailDrawer';

const OPEN_NEW = 'open-admin-new-organisation';
const OPEN_DETAIL = 'open-admin-organisation';

/** Opens the global "New Organisation" drawer (Admin Panel → Organisations). */
export function openNewOrganisationDrawer(): void {
  document.dispatchEvent(new CustomEvent(OPEN_NEW));
}

/** Opens the global organisation detail drawer for `organisationId`. */
export function openOrganisationDetailDrawer(organisationId: string): void {
  document.dispatchEvent(new CustomEvent(OPEN_DETAIL, { detail: { id: organisationId } }));
}

/**
 * W6-E2E-01 — the Admin Panel's organisation drawers, mounted ONCE in `shell/Layout.tsx` as direct flex children of
 * `.app-layout`, and opened by event (same pattern as `CreateVenueDrawer`, `ShiftDrawers`, `OfferDecisionDrawers`).
 *
 * Root cause of "+ New Organisation does nothing": `OrganisationsTab` rendered both drawers inline, inside the block
 * `.settings-page` of the Settings shell. `RightSidePanel` is a push-layout dock (`.side-panel-dock { height: 100%;
 * overflow: hidden }` whose card is absolutely positioned): it only has a size when it is a flex child of the
 * `.app-layout` row. Nested in a block container its height resolved to 0 with overflow hidden, so the drawer opened
 * (state, focus, Escape all live) but was invisible and could not be clicked.
 */
export default function AdminOrganisationDrawers() {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    const onNew = () => {
      setDetailId(null);
      setCreateOpen(true);
    };
    const onDetail = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setCreateOpen(false);
      setDetailId(id);
    };
    document.addEventListener(OPEN_NEW, onNew);
    document.addEventListener(OPEN_DETAIL, onDetail);
    return () => {
      document.removeEventListener(OPEN_NEW, onNew);
      document.removeEventListener(OPEN_DETAIL, onDetail);
    };
  }, []);

  return (
    <>
      <NewOrganisationDrawer open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setDetailId(id)} />
      <OrganisationDetailDrawer open={detailId !== null} onClose={() => setDetailId(null)} organisationId={detailId} />
    </>
  );
}
