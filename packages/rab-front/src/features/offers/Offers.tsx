import { motion as arcMotion } from 'framer-motion';
import { recordAvatarStyle } from '../../shared/lib/recordAvatarColor';
import RecordOpenAction from '../../shared/components/RecordOpenAction';
import { useRecordSelection } from '../../shared/table-toolbar/useRecordSelection';
import { useNavigate } from 'react-router-dom';
import { ListViewSelect, RecordFooter, ListError } from '../../shared/table-toolbar/ListPresentation';
import { Fragment, useMemo, useRef, useState } from 'react';
import Popover from '../../shared/components/Popover';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { duration, ease } from '../../shared/motion';
import './offer-groups.css';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconClock, IconBan, IconCheck, IconX, IconUsers, IconChevronDown, IconDots,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import { getApiErrorMessage } from '../../shared/lib/apiError';
import { confirmAllSummary } from './confirm-all-summary';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface VenueRequest {
  id: string; status: string; displayStatus: string; startsAt: string; endsAt: string;
  selectedCount: number | string; requiredCount: number; venueName: string; roleName: string;
}

interface Offer {
  id: string;
  status: string;
  sentAt: string;
  expiresAt: string;
  respondedAt: string | null;
  declineReason: string | null;
  staffAcceptedAt: string | null;
  managerConfirmedAt: string | null;
  managerRejectedAt: string | null;
  rejectionReason: string | null;
  estimatedPayPence: number;
  offerBatchId: string | null;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
}

function OfferActions({ offer, siblings }: { offer: Offer; siblings: number }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); anchorRef.current?.focus(); };
  const run = (action: () => void) => { close(); action(); };
  return <>
    <button ref={anchorRef} className="btn-icon" aria-label={`Actions for ${offer.staffName}`} aria-expanded={open} onClick={() => setOpen(!open)}><IconDots size={16} /></button>
    <Popover open={open} onClose={close} anchorRef={anchorRef} align="end" minWidth={190}>
      <div className="dropdown-menu" style={{ position: 'static', border: 0, boxShadow: 'none' }}>
        <button className="dropdown-item" onClick={() => run(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: offer.staffProfileId, type: 'staff' } })))}>View staff details</button>
        {offer.offerBatchId && siblings >= 2 && <button className="dropdown-item" onClick={() => run(() => openBatch(offer.offerBatchId!))}><IconUsers size={14} /> View batch</button>}
        {offer.status === 'pending' && <button className="dropdown-item danger" onClick={() => run(() => openWithdraw(offer.id))}><IconBan size={14} /> Withdraw offer</button>}
        {offer.status === 'staff_accepted' && <>
          <button className="dropdown-item" onClick={() => run(() => openConfirm(offer))}><IconCheck size={14} /> Confirm shift</button>
          <button className="dropdown-item danger" onClick={() => run(() => openReject(offer))}><IconX size={14} /> Reject</button>
        </>}
      </div>
    </Popover>
  </>;
}

function openBatch(batchId: string) {
  document.dispatchEvent(new CustomEvent('open-offer-batch', { detail: { batchId } }));
}

// Withdraw/Confirm/Reject render in `OfferDecisionDrawers` — a global
// drawer mounted in Layout.tsx, not inline here — so they dock to the
// right edge of `.app-layout` correctly. See that file's own doc comment
// for why rendering them nested inside this page's `.page` div (the old
// approach) put them on the left instead.
function openWithdraw(id: string) {
  document.dispatchEvent(new CustomEvent('open-offer-withdraw', { detail: { id } }));
}
function openConfirm(offer: Offer) {
  document.dispatchEvent(new CustomEvent('open-offer-confirm', { detail: { offer } }));
}
function openReject(offer: Offer) {
  document.dispatchEvent(new CustomEvent('open-offer-reject', { detail: { offer } }));
}


// Real OfferStatus values (@rab/shared) — never invented.
const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'venue:pending', label: 'Venue · Pending approval' },
  { key: 'venue:approved', label: 'Venue · Approved' },
  { key: 'venue:declined', label: 'Venue · Declined' },
  { key: 'pending', label: 'Pending Staff Response' },
  { key: 'staff_accepted', label: 'Awaiting Confirmation' },
  { key: 'manager_confirmed', label: 'Confirmed' },
  { key: 'declined', label: 'Declined' },
  { key: 'manager_rejected', label: 'Rejected' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'expired', label: 'Expired' },
];

// Real OfferStatus values (@rab/shared) — never invented. `status` is
// primarily driven by the tab row above (a better fit for a small set of
// mutually-exclusive states with counts), but still listed here too so
// `useTableQueryState` tracks/round-trips it via the URL like every other
// filter — the Filter popover offering it as a second, equally-valid way to
// set the exact same `status` param is harmless, not a conflict.
const OFFER_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'staff_accepted', label: 'Staff accepted' },
  { value: 'manager_confirmed', label: 'Manager confirmed' },
  { value: 'manager_rejected', label: 'Manager rejected' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const OFFERS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'offers',
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: [...OFFER_STATUS_OPTIONS, {value:'venue:pending',label:'Venue · Pending approval'}, {value:'venue:approved',label:'Venue · Approved'}, {value:'venue:declined',label:'Venue · Declined'}] },
    { key: 'shiftDate', label: 'Shift date', type: 'dateRange' },
    { key: 'sentAt', label: 'Sent date', type: 'dateRange' },
  ],
  sorts: [
    { key: 'sentAt', label: 'Sent date', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest', asc: 'Oldest' } },
    { key: 'shiftDate', label: 'Shift date', directions: ['asc', 'desc'] },
    { key: 'staff', label: 'Staff', directions: ['asc', 'desc'] },
    { key: 'venue', label: 'Venue', directions: ['asc', 'desc'] },
    { key: 'status', label: 'Status', directions: ['asc', 'desc'] },
  ],
  columns: [
    { key: 'staff', label: 'Staff', hideable: false },
    { key: 'venue', label: 'Venue', hideable: true },
    { key: 'role', label: 'Role', hideable: true },
    { key: 'shiftDate', label: 'Shift date', hideable: true },
    { key: 'time', label: 'Time', hideable: true },
    { key: 'pay', label: 'Est. pay', hideable: true },
    { key: 'status', label: 'Status', hideable: false },
  ],
  defaultSort: { key: 'sentAt', direction: 'desc' },
};

const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function Offers({ fixedStatus, title = "Staff & Venue Offers" }: { fixedStatus?: string; title?: string } = {}) {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const qc = useQueryClient();

  const config = fixedStatus ? { ...OFFERS_TABLE_CONFIG, storageKey: `offers-${fixedStatus}`, filters: OFFERS_TABLE_CONFIG.filters.filter(field => field.key !== 'status') } : OFFERS_TABLE_CONFIG;
  const { search, filters, sort, page, setPage, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);
  const activeStatus = fixedStatus ?? filters.status ?? '';

  const venueStatus = activeStatus.startsWith('venue:') ? activeStatus.slice(6) : '';
  const requestParams = { q: search || undefined, status: venueStatus || undefined };
  const requests = useQuery({
    queryKey: ['venue-offers', requestParams], refetchInterval: 10000, enabled: !fixedStatus,
    queryFn: async () => (await api.get<{ data: VenueRequest[]; total: number }>('/shifts/requests', { params: requestParams })).data,
  });
  const venueRequests = (fixedStatus ? [] : requests.data?.data ?? []).filter(request => {
    const day = request.startsAt.slice(0, 10);
    return (!filters.shiftDateFrom || day >= filters.shiftDateFrom) && (!filters.shiftDateTo || day <= filters.shiftDateTo);
  });
  const requestByShift = new Map(venueRequests.map(request => [request.id, request]));
  const openRequest = (request: VenueRequest) => {
    if (['pending_manager_approval', 'declined'].includes(request.status)) document.dispatchEvent(new CustomEvent('open-shift-approval', { detail: { shiftId: request.id } }));
    else navigate('/venue-offers/' + request.id);
  };
  const params = { page, q: search || undefined, ...filters, status: fixedStatus ?? (venueStatus ? undefined : filters.status), sort: sort.sort, direction: sort.direction };
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['offers', params],
    queryFn: async () => { const { data } = await api.get<{ data: Offer[]; total: number }>('/offers', { params }); return data; },
  });
  const offers = (data?.data ?? []).filter(offer => !venueStatus || requestByShift.has(offer.shiftId));
  const requestOnlyRows = venueRequests.filter(request => (!activeStatus || venueStatus) && !offers.some(offer => offer.shiftId === request.id));
  const selection = useRecordSelection(offers.map(row=>row.id));
  const [collapsedShifts, setCollapsedShifts] = useState<Set<string>>(new Set());
  const offerGroups = useMemo(() => {
    const groups = new Map<string, Offer[]>();
    for (const offer of offers) {
      const rows = groups.get(offer.shiftId) ?? [];
      rows.push(offer);
      groups.set(offer.shiftId, rows);
    }
    return [...groups.entries()];
  }, [offers]);
  const total = data?.total ?? 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['offers'] });
    qc.invalidateQueries({ queryKey: ['shifts'] });
  };

  // "Confirm All Accepted" fires one confirm-all call per distinct batch
  // present in the currently-visible (server-filtered) staff_accepted rows.
  const [confirmingAllBatches, setConfirmingAllBatches] = useState(false);
  const confirmAllBatch = useMutation({
    mutationFn: (batchId: string) => api.post(`/offers/batches/${batchId}/confirm-all`),
  });

  // Sibling count within the currently-fetched page — matches the general
  // "everything scoped to the current server-filtered view" behavior a
  // paginated list already has everywhere else in this app.
  const batchSiblingCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of offers) {
      if (!o.offerBatchId) continue;
      map[o.offerBatchId] = (map[o.offerBatchId] ?? 0) + 1;
    }
    return map;
  }, [offers]);

  const acceptedBatchIds = useMemo(
    () => [...new Set(offers.filter((o) => o.status === 'staff_accepted' && o.offerBatchId).map((o) => o.offerBatchId!))],
    [offers],
  );

  // One confirm-all per batch, in sequence. Every batch is attempted even if an earlier one fails, and the user is told
  // exactly how many offers were confirmed and how many batches failed: a partial result is never reported as success.
  async function handleConfirmAllAccepted() {
    if (confirmingAllBatches) return;
    setConfirmingAllBatches(true);
    const outcomes: Array<{ ok: boolean }> = [];
    let failedBatches = 0;
    let firstError: unknown = null;
    try {
      for (const batchId of acceptedBatchIds) {
        try {
          const res = await confirmAllBatch.mutateAsync(batchId);
          outcomes.push(...(((res as { data?: { results?: Array<{ ok: boolean }> } })?.data?.results) ?? []));
        } catch (error) {
          failedBatches += 1;
          firstError ??= error;
        }
      }
    } finally {
      invalidate();
      setConfirmingAllBatches(false);
    }
    const summary = confirmAllSummary(outcomes);
    if (failedBatches === 0) {
      if (summary.partial) toast.warning(summary.text, { persistent: true });
      else toast.success(summary.text);
      return;
    }
    const confirmed = outcomes.filter((o) => o.ok).length;
    const reason = getApiErrorMessage(firstError, 'Please try again.');
    toast.error(
      `${confirmed} offer${confirmed === 1 ? '' : 's'} confirmed, but ${failedBatches} of ${acceptedBatchIds.length} batch${acceptedBatchIds.length === 1 ? '' : 'es'} could not be confirmed. ${reason}`,
      { persistent: true },
    );
  }

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title={title} />

      <div className="list-toolbar-row">
        <ListViewSelect label="Offers view" value={activeStatus} options={fixedStatus ? [{value:fixedStatus, label:title}] : STATUS_TABS.map(t => ({value:t.key, label:t.key ? t.label : 'All offers'}))} onChange={status => setFilters({...filters, status})} />
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {selection.summary}
          {activeStatus === 'staff_accepted' && acceptedBatchIds.length > 0 && (
            <button className="btn btn-dark" disabled={confirmingAllBatches} onClick={handleConfirmAllAccepted}>
              <IconCheck size={14} />
              {confirmingAllBatches ? 'Confirming…' : `Confirm All Accepted (${offers.length})`}
            </button>
          )}
          <TableViewControls
            config={config}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            activeFilterCount={activeFilterCount}
            columnVisibility={columnVisibility}
          />
        </div>
      </div>

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading || (!fixedStatus && requests.isLoading) ? (
          <TableSkeleton columns={8} />
        ) : isError || (!fixedStatus && requests.isError) ? <ListError retry={() => { void refetch(); void requests.refetch(); }} /> : (
          <table className="table offers-table">
            <thead>
              <tr>
                <th className="checkbox-col">{selection.allCheckbox}</th>
                {isVisible('staff') && <th scope="col">Venue</th>}
                {isVisible('venue') && <th scope="col">Offers</th>}
                {isVisible('role') && <th>Role</th>}
                {isVisible('shiftDate') && <th>Shift date</th>}
                {isVisible('time') && <th>Time</th>}
                {isVisible('pay') && <th>Est. pay</th>}
                {isVisible('status') && <th>Status</th>}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {requestOnlyRows.map(request => <tr key={'request-' + request.id} className="offer-parent-row">
                <td className="checkbox-col" />
                <td><div className="offer-parent-name"><span style={{width:18,flexShrink:0}} /><button type="button" className="record-chip object-name-chip" onClick={() => openRequest(request)}><span className="round-avatar" style={recordAvatarStyle(request.venueName)}>{request.venueName?.[0]}</span>{request.venueName}</button></div><RecordOpenAction label={'Open venue request for ' + request.venueName} onOpen={() => openRequest(request)} /></td>
                {isVisible('venue') && <td className="cell-muted">{request.selectedCount} / {request.requiredCount} staff</td>}
                {isVisible('role') && <td className="cell-muted">{request.roleName}</td>}
                {isVisible('shiftDate') && <td>{fmtDate(request.startsAt)}</td>}
                {isVisible('time') && <td>{fmtTime(request.startsAt)}–{fmtTime(request.endsAt)}</td>}
                {isVisible('pay') && <td className="cell-muted">—</td>}
                {isVisible('status') && <td><span className={'badge badge-' + request.status}>{request.displayStatus}</span></td>}
                <td />
              </tr>)}
              {offerGroups.map(([shiftId, rows]) => <Fragment key={shiftId}>
                <tr className="offer-parent-row"><td className="checkbox-col">{selection.groupCheckbox(rows.map(row => row.id), "Select visible offers for " + rows[0].venueName)}</td>
                  {isVisible('staff') && <td><div className="offer-parent-name">
                  <button type="button" className="offer-shift-toggle" aria-expanded={!collapsedShifts.has(shiftId)} aria-label={`Toggle ${rows[0].venueName} shift offers`} onClick={() => setCollapsedShifts(previous => { const next = new Set(previous); if (next.has(shiftId)) next.delete(shiftId); else next.add(shiftId); return next; })}>
                    <IconChevronDown size={16} className={collapsedShifts.has(shiftId) ? 'is-collapsed' : ''} />
                  </button>
                  <button type="button" onClick={() => requestByShift.has(shiftId) ? openRequest(requestByShift.get(shiftId)!) : navigate(`/venue-offers/${shiftId}`)} className="record-chip object-name-chip"><span className="round-avatar" style={recordAvatarStyle(rows[0].venueName)}>{rows[0].venueName?.charAt(0).toUpperCase()}</span>{rows[0].venueName}</button></div>
                  <RecordOpenAction label={`Open ${rows[0].venueName} shift pipeline`} onOpen={() => requestByShift.has(shiftId) ? openRequest(requestByShift.get(shiftId)!) : navigate(`/venue-offers/${shiftId}`)} /></td>}
                  {isVisible('venue') && <td className="cell-muted">{rows.length} {rows.length === 1 ? 'offer' : 'offers'} in view</td>}
                  {isVisible('role') && <td className="cell-muted">{new Set(rows.map(row => row.roleName)).size === 1 ? rows[0].roleName : 'Multiple roles'}</td>}
                  {isVisible('shiftDate') && <td className="cell-muted">{fmtDate(rows[0].startsAt)}</td>}
                  {isVisible('time') && <td>{fmtTime(new Date(Math.min(...rows.map(row => new Date(row.startsAt).getTime()))).toISOString())}–{fmtTime(new Date(Math.max(...rows.map(row => new Date(row.endsAt).getTime()))).toISOString())}</td>}
                  {isVisible('pay') && <td>{fmtMoney(rows.reduce((sum, row) => sum + Number(row.estimatedPayPence), 0))}</td>}
                  {isVisible('status') && <td className="cell-muted">{requestByShift.get(shiftId)?.displayStatus ?? `${rows.filter(row => row.status === 'manager_confirmed').length} confirmed`}</td>}
                  <td />
                </tr>
                <AnimatePresence initial={false}>
                {!collapsedShifts.has(shiftId) && <motion.tr key={shiftId} className="offer-nested-container" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0, transition:{duration:reducedMotion ? 0 : duration.dropdownOut}}} transition={{duration:reducedMotion ? 0 : duration.dropdownIn, ease:ease.out}}><td colSpan={2 + config.columns.filter(column => isVisible(column.key)).length}>
                  <motion.div className="offer-nested-branch" initial={{y:reducedMotion ? 0 : -5}} animate={{y:0}} transition={{duration:reducedMotion ? 0 : duration.dropdownIn, ease:ease.out}}><table className="table offer-staff-table" aria-label={`Staff offers for ${rows[0].venueName}`}>
                    <thead><tr><th className="offer-tree-gutter" aria-hidden="true"/><th className="checkbox-col">{selection.groupCheckbox(rows.map(row => row.id), "Select nested offers for " + rows[0].venueName)}</th>{config.columns.filter(column => isVisible(column.key)).map(column => <th key={column.key} scope="col">{column.label}</th>)}<th style={{width:40}} /></tr></thead>
                    <tbody>
              {rows.map((o) => {
                return (
                  <arcMotion.tr layout="position" initial={false} transition={{layout:{type:"spring",stiffness:340,damping:34}}} key={o.id} className={selection.isSelected(o.id) ? "row-selected" : undefined}>
                  <td className="offer-tree-gutter" aria-hidden="true"/><td className="checkbox-col" onClick={e=>e.stopPropagation()}>{selection.checkbox(o.id,o.staffName)}</td>
                    {isVisible('staff') && (
                      <td>
                        <button type="button" onClick={event => { event.stopPropagation(); document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: o.staffProfileId, type: 'staff' } })); }} className="user-cell record-chip object-name-chip">
                          <span className="round-avatar" style={recordAvatarStyle(o.staffName)}>{o.staffName?.charAt(0).toUpperCase()}</span>
                          {o.staffName}
                        </button>
                        <RecordOpenAction label={`Open staff ${o.staffName}`} onOpen={() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: o.staffProfileId, type: 'staff' } }))}/>
                      </td>
                    )}
                    {isVisible('venue') && (
                      <td>
                        <span className="record-chip object-name-chip">
                          <span className="mini-avatar" style={recordAvatarStyle(o.venueName)}>{o.venueName?.[0]}</span>
                          {o.venueName}
                        </span>
                      </td>
                    )}
                    {isVisible('role') && <td className="cell-muted">{o.roleName}</td>}
                    {isVisible('shiftDate') && <td className="cell-muted">{fmtDate(o.startsAt)}</td>}
                    {isVisible('time') && <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(o.startsAt)}–{fmtTime(o.endsAt)}</span></td>}
                    {isVisible('pay') && <td>{fmtMoney(o.estimatedPayPence)}</td>}
                    {isVisible('status') && (
                      <td>
                        <span className={`badge badge-${o.status}`}>{o.status === 'pending' ? 'Sent' : o.status === 'staff_accepted' ? 'Awaiting confirmation' : OFFER_STATUS_OPTIONS.find(option => option.value === o.status)?.label ?? o.status.replace(/_/g, ' ')}</span>
                        {o.status === 'staff_accepted' && o.staffAcceptedAt && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>Staff accepted {timeAgo(o.staffAcceptedAt)}</span>
                        )}
                        {o.status === 'declined' && o.declineReason && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>{o.declineReason}</span>
                        )}
                        {o.status === 'manager_rejected' && o.rejectionReason && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>{o.rejectionReason}</span>
                        )}
                      </td>
                    )}
                    <td>
                      <OfferActions offer={o} siblings={o.offerBatchId ? batchSiblingCount[o.offerBatchId] ?? 0 : 0} />
                    </td>
                  </arcMotion.tr>
                );
              })}
                    </tbody></table></motion.div>
                </td></motion.tr>}
                </AnimatePresence>
              </Fragment>)}
              {offers.length === 0 && requestOnlyRows.length === 0 && (
                <tr><td colSpan={9}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="offers" title="No offers yet" description={fixedStatus ? "Staff offers matching this view will appear here." : "Venue requests and staff offers will appear here."} />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
<RecordFooter total={total} page={page} onPage={setPage}><span className="muted">{!fixedStatus && `${venueRequests.length} venue requests · `}{offerGroups.length + requestOnlyRows.length} shifts in view</span></RecordFooter>
    </div>
  );
}
