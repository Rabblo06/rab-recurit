import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSearch, IconX } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { DetailSkeleton } from '../../shared/components/LoadingState';

interface Shift {
  id: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  requiredCount: number;
  filledCount: number;
  payRatePence: number;
  notes?: string;
  status: string;
  declinedReason?: string | null;
}
interface Venue {
  id: string;
  name: string;
  clientName: string | null;
  type: string;
  address: { line1?: string; city?: string; postcode?: string };
  breakPaid: boolean;
}
interface JobRole { id: string; name: string }
interface RequestedStaff { staffProfileId: string; firstName: string; lastName: string; email: string; stillActive: boolean }
interface StaffSearchRow { id: string; firstName: string; lastName: string; email: string; accountStatus: string }

// A stable, module-level reference — `useQuery`'s own `data: x = []` default
// creates a brand-new array literal on every render for as long as the
// query has no data yet, which turns "depend on that array" into an
// infinite render loop the moment it's also a `useEffect` dependency (each
// render's fresh `[]` never `===` the previous one, so the effect fires,
// calls `setStaffIds`, which re-renders, which creates a new `[]`, ...).
const EMPTY_REQUESTED_STAFF: RequestedStaff[] = [];
const EMPTY_STAFF_RESULTS: StaffSearchRow[] = [];
const isPendingStatus = (status: string | undefined) => status === 'pending_manager_approval';

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--font-secondary)', marginBottom: 2 }}>
      {children}
    </span>
  );
}

/**
 * Shift Approval detail — a Venue Manager's `pending_manager_approval`
 * request opens here from the Shifts page row click. Read-only for every
 * other status (an already-approved/declined shift still opens this same
 * drawer to show its history, just without the staff picker/action footer).
 * Global drawer, same mount/event pattern as CreateVenueDrawer/BatchOfferDrawer:
 *   document.dispatchEvent(new CustomEvent('open-shift-approval', { detail: { shiftId } }))
 */
export default function ShiftApprovalDrawer() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [addQuery, setAddQuery] = useState('');

  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.shiftId as string | undefined;
      if (!id) return;
      setShiftId(id);
      setDeclining(false);
      setDeclineReason('');
      setAddQuery('');
      setOpen(true);
    };
    document.addEventListener('open-shift-approval', handler);
    return () => document.removeEventListener('open-shift-approval', handler);
  }, []);

  const { data: shift, isLoading: loadingShift } = useQuery({
    queryKey: ['shift', shiftId],
    queryFn: async () => { const { data } = await api.get<Shift>(`/shifts/${shiftId}`); return data; },
    enabled: open && !!shiftId,
  });
  const { data: venue } = useQuery({
    queryKey: ['venue', shift?.venueId],
    queryFn: async () => { const { data } = await api.get<Venue>(`/venues/${shift!.venueId}`); return data; },
    enabled: open && !!shift?.venueId,
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
    enabled: open,
  });
  // The pending request's persisted recipient list (`shift_request_staff`)
  // — the Venue Manager's original picks PLUS whatever the Internal Manager
  // has since added/removed here. This is the single source of truth the
  // backend also reads from at approval time (`OfferService
  // .approveShiftRequest` re-derives from the same table, never trusts a
  // client-supplied list) — there is no separate "which ones are checked"
  // UI state to keep in sync with it.
  const requestedStaffKey = ['shift-requested-staff', shiftId];
  const { data: requestedStaff = EMPTY_REQUESTED_STAFF } = useQuery({
    queryKey: requestedStaffKey,
    queryFn: async () => { const { data } = await api.get<RequestedStaff[]>(`/shifts/${shiftId}/requested-staff`); return data; },
    enabled: open && !!shiftId && shift?.status === 'pending_manager_approval',
  });

  const trimmedAddQuery = addQuery.trim();
  const { data: staffResults = EMPTY_STAFF_RESULTS } = useQuery({
    queryKey: ['staff-search', trimmedAddQuery],
    queryFn: async () => { const { data } = await api.get<{ data: StaffSearchRow[] }>('/staff', { params: { q: trimmedAddQuery, page: 1 } }); return data.data; },
    enabled: open && isPendingStatus(shift?.status) && trimmedAddQuery.length >= 2,
  });
  const requestedIds = new Set(requestedStaff.map((s) => s.staffProfileId));
  const addableResults = staffResults.filter((s) => s.accountStatus === 'active' && !requestedIds.has(s.id));

  const roleName = jobRoles.find((r) => r.id === shift?.jobRoleId)?.name ?? '–';

  const removeStaff = useMutation({
    mutationFn: (staffProfileId: string) => api.delete(`/shifts/${shiftId}/requested-staff/${staffProfileId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: requestedStaffKey }),
  });
  const addStaff = useMutation({
    mutationFn: (staffProfileId: string) => api.post(`/shifts/${shiftId}/requested-staff/${staffProfileId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: requestedStaffKey });
      setAddQuery('');
    },
  });
  const approve = useMutation({
    mutationFn: () => api.post(`/shifts/${shiftId}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['venue-offers'] });
      setOpen(false);
    },
  });
  const decline = useMutation({
    mutationFn: () => api.post(`/shifts/${shiftId}/decline`, { reason: declineReason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['venue-offers'] });
      setOpen(false);
    },
  });

  const isPending = isPendingStatus(shift?.status);
  const requiredCount = shift?.requiredCount ?? 0;
  const selectedCount = requestedStaff.length;
  const openCount = Math.max(requiredCount - selectedCount, 0);

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title="Shift Approval"
      loading={loadingShift}
      footer={
        !isPending ? undefined : declining ? (
          <>
            <button className="btn btn-outline" onClick={() => setDeclining(false)}>Back</button>
            <button className="btn btn-danger" onClick={() => decline.mutate()} disabled={decline.isPending}>
              {decline.isPending ? 'Declining…' : 'Confirm decline'}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-outline" onClick={() => setDeclining(true)}>Decline</button>
            <button className="btn btn-dark" onClick={() => approve.mutate()} disabled={approve.isPending || selectedCount === 0}>
              {approve.isPending ? 'Approving…' : `Approve & send offers${selectedCount ? ` to ${selectedCount}` : ''}`}
            </button>
          </>
        )
      }
    >
      {loadingShift || !shift ? (
        <DetailSkeleton />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44', width: 40, height: 40, fontSize: 16 }}>
              {venue?.name?.[0] ?? '?'}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{venue?.name ?? '—'}</div>
              <div style={{ fontSize: 12, color: 'var(--font-secondary)' }}>
                {venue?.clientName ? `${venue.clientName} · ` : ''}{venue?.type}
              </div>
            </div>
          </div>

          {venue?.address && (venue.address.line1 || venue.address.city) && (
            <p style={{ fontSize: 13, color: 'var(--font-secondary)', margin: '0 0 16px' }}>
              {[venue.address.line1, venue.address.city, venue.address.postcode].filter(Boolean).join(', ')}
            </p>
          )}

          <div className="form-grid" style={{ marginBottom: 16, rowGap: 12 }}>
            <div><Label>Role</Label>{roleName}</div>
            <div><Label>Status</Label><span className={`badge badge-${shift.status}`}>{shift.status.replace(/_/g, ' ')}</span></div>
            <div><Label>Date</Label>{fmtDate(shift.startsAt)}</div>
            <div><Label>Time</Label>{fmtTime(shift.startsAt)}–{fmtTime(shift.endsAt)}</div>
            <div><Label>Rate</Label>{fmtMoney(shift.payRatePence)}/hr</div>
            <div><Label>Break</Label>{shift.breakMinutes} min{venue?.breakPaid ? ' (paid)' : ''}</div>
            <div>
              <Label>Staffing</Label>
              {isPending
                ? `${selectedCount} selected / ${requiredCount} required (${openCount} open)`
                : `${shift.filledCount} confirmed / ${shift.requiredCount} required`}
            </div>
          </div>

          {shift.notes && (
            <div style={{ marginBottom: 16 }}>
              <Label>Note</Label>
              <p style={{ fontSize: 13, margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{shift.notes}</p>
            </div>
          )}

          {shift.status === 'declined' && shift.declinedReason && (
            <div style={{ marginBottom: 16 }}>
              <Label>Decline reason</Label>
              <p style={{ fontSize: 13, margin: '4px 0 0' }}>{shift.declinedReason}</p>
            </div>
          )}

          {isPending && !declining && (
            <div style={{ marginTop: 8 }}>
              <Label>Selected staff</Label>
              {requestedStaff.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--font-secondary)', margin: '4px 0 0' }}>No staff selected — add someone below before approving.</p>
              ) : (
                <div style={{ border: '1px solid var(--border-color, #e5e5e5)', borderRadius: 10, overflow: 'hidden' }}>
                  {requestedStaff.map((s) => (
                    <div
                      key={s.staffProfileId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                        borderBottom: '1px solid var(--border-color, #e5e5e5)',
                        opacity: s.stillActive ? 1 : 0.55,
                      }}
                    >
                      <span className="mini-avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{s.firstName?.[0]}{s.lastName?.[0]}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{s.firstName} {s.lastName}</div>
                        <div style={{ fontSize: 12, color: 'var(--font-secondary)' }}>{s.email}</div>
                      </div>
                      {!s.stillActive && <span className="badge badge-declined">No longer active</span>}
                      <button
                        className="btn-icon"
                        title="Remove from this request"
                        onClick={() => removeStaff.mutate(s.staffProfileId)}
                        disabled={removeStaff.isPending}
                      >
                        <IconX size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 12, position: 'relative' }}>
                <Label>Add staff</Label>
                <div style={{ position: 'relative' }}>
                  <IconSearch size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--font-secondary)' }} />
                  <input
                    type="text"
                    value={addQuery}
                    onChange={(e) => setAddQuery(e.target.value)}
                    placeholder="Search active staff by name or email…"
                    style={{ width: '100%', padding: '8px 10px 8px 30px' }}
                  />
                </div>
                {trimmedAddQuery.length >= 2 && (
                  <div style={{ border: '1px solid var(--border-color, #e5e5e5)', borderRadius: 10, marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
                    {addableResults.length === 0 ? (
                      <p style={{ fontSize: 13, color: 'var(--font-secondary)', margin: 0, padding: '10px 12px' }}>No matching active staff found.</p>
                    ) : (
                      addableResults.map((s) => (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border-color, #e5e5e5)' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{s.firstName} {s.lastName}</div>
                            <div style={{ fontSize: 12, color: 'var(--font-secondary)' }}>{s.email}</div>
                          </div>
                          <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => addStaff.mutate(s.id)} disabled={addStaff.isPending}>
                            Add
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              {removeStaff.isError && <p className="error" style={{ marginTop: 8 }}>Could not remove this staff member.</p>}
              {addStaff.isError && <p className="error" style={{ marginTop: 8 }}>Could not add this staff member — they may no longer be eligible.</p>}
            </div>
          )}

          {isPending && declining && (
            <div style={{ marginTop: 8 }}>
              <Label>Reason (optional)</Label>
              <textarea rows={3} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} style={{ width: '100%' }} />
            </div>
          )}

          {approve.isError && <p className="error" style={{ marginTop: 12 }}>Could not approve this request. It may already have been actioned.</p>}
          {decline.isError && <p className="error" style={{ marginTop: 12 }}>Could not decline this request. It may already have been actioned.</p>}
        </>
      )}
    </Drawer>
  );
}
