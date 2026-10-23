import { useInfiniteQuery } from '@tanstack/react-query';
import {
  IconX, IconTimelineEvent, IconCalendarPlus, IconRocket, IconSend, IconChecklist, IconUserCheck, IconMapPin,
  IconLogin, IconLogout, IconPencil, IconFileText, IconCash, IconBan, IconArchive, IconBolt,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { timeAgo } from '../../shared/lib/timeAgo';
import RightSidePanel from '../../shared/components/RightSidePanel';
import { EmptyState, ListSkeleton } from '../../shared/components/LoadingState';

/** `GET /rest/v1/timeline/shifts/:id` item — a read model over the immutable audit log (no client-side state). */
export interface TimelineItem {
  id: string;
  action: string;
  step: string | null;
  actor: { fullName: string } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
interface TimelinePage { items: TimelineItem[]; nextCursor: string | null }

/** Presentation for the server's lifecycle step keys. Unknown steps fall back to the raw action — never invented. */
const STEPS: Record<string, { title: string; Icon: typeof IconBolt; bg: string; color: string }> = {
  shift_created: { title: 'Shift created', Icon: IconCalendarPlus, bg: '#dbe9fe', color: '#1961ed' },
  shift_published: { title: 'Shift published', Icon: IconRocket, bg: '#dbe9fe', color: '#1961ed' },
  shift_requested: { title: 'Shift requested', Icon: IconCalendarPlus, bg: '#f1e6fd', color: '#7d3bc8' },
  shift_request_approved: { title: 'Request approved', Icon: IconChecklist, bg: '#d9f0de', color: '#2a8e44' },
  shift_cancelled: { title: 'Shift cancelled', Icon: IconBan, bg: '#fdded9', color: '#d93025' },
  offer_sent: { title: 'Offer sent', Icon: IconSend, bg: '#dbe9fe', color: '#1961ed' },
  offer_accepted: { title: 'Offer accepted', Icon: IconChecklist, bg: '#fdf2d4', color: '#946c00' },
  offer_declined: { title: 'Offer declined', Icon: IconBan, bg: '#f1f1f1', color: '#666666' },
  offer_approved: { title: 'Booking approved', Icon: IconUserCheck, bg: '#d9f0de', color: '#2a8e44' },
  offer_rejected: { title: 'Acceptance rejected', Icon: IconBan, bg: '#fdded9', color: '#d93025' },
  offer_withdrawn: { title: 'Offer withdrawn', Icon: IconBan, bg: '#f1f1f1', color: '#666666' },
  offer_expired: { title: 'Offer expired', Icon: IconBan, bg: '#f1f1f1', color: '#666666' },
  check_in: { title: 'Checked in', Icon: IconMapPin, bg: '#f1e6fd', color: '#7d3bc8' },
  clock_in: { title: 'Clocked in', Icon: IconLogin, bg: '#d9f0de', color: '#2a8e44' },
  clock_out: { title: 'Clocked out', Icon: IconLogout, bg: '#f1f1f1', color: '#666666' },
  attendance_recorded: { title: 'Attendance recorded', Icon: IconPencil, bg: '#fdf2d4', color: '#946c00' },
  attendance_corrected: { title: 'Attendance corrected', Icon: IconPencil, bg: '#fdf2d4', color: '#946c00' },
  review: { title: 'Attendance reviewed', Icon: IconChecklist, bg: '#d9f0de', color: '#2a8e44' },
  no_show: { title: 'No-show confirmed', Icon: IconBan, bg: '#fdded9', color: '#d93025' },
  timesheet: { title: 'Timesheet finalised', Icon: IconFileText, bg: '#dbe9fe', color: '#1961ed' },
  payroll_approved: { title: 'Payroll approved', Icon: IconCash, bg: '#d9f0de', color: '#2a8e44' },
  payroll_rejected: { title: 'Payroll rejected', Icon: IconCash, bg: '#fdded9', color: '#d93025' },
  statement: { title: 'Shift statement issued', Icon: IconFileText, bg: '#dbe9fe', color: '#1961ed' },
  archived: { title: 'Archived', Icon: IconArchive, bg: '#f1f1f1', color: '#666666' },
  restored: { title: 'Restored', Icon: IconArchive, bg: '#d9f0de', color: '#2a8e44' },
};

export function describeTimelineItem(item: TimelineItem): { title: string; Icon: typeof IconBolt; bg: string; color: string } {
  const known = item.step ? STEPS[item.step] : undefined;
  if (known) return known;
  return { title: item.action.replace(/[._]/g, ' '), Icon: IconBolt, bg: '#f1f1f1', color: '#666666' };
}

/**
 * Wave 5 — a shift's lifecycle (created → published → offer sent → accepted → approved → check in → clock in/out →
 * review → timesheet → payroll approved), newest first, keyset-paginated ("Load older"). Read-only. The server decides
 * what the caller may see (scope 404s, money only with payroll access); this panel only renders it.
 */
export default function ShiftTimelinePanel({ shiftId, title, onClose }: { shiftId: string | null; title?: string; onClose: () => void }) {
  const query = useInfiniteQuery({
    queryKey: ['timeline', 'shift', shiftId],
    enabled: !!shiftId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (await api.get<TimelinePage>(`/timeline/shifts/${shiftId}`, { params: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } })).data,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <RightSidePanel open={!!shiftId} onClose={onClose}>
      <div className="timeline-head">
        <IconTimelineEvent size={16} />
        {title ? `Timeline · ${title}` : 'Shift timeline'}
        <div style={{ flex: 1 }} />
        <button className="btn-icon" onClick={onClose} title="Close" aria-label="Close timeline"><IconX size={15} /></button>
      </div>
      <div className="timeline-body" aria-live="polite">
        {query.isLoading ? (
          <ListSkeleton rows={6} />
        ) : query.isError ? (
          <EmptyState compact variant="timeline" title="Timeline unavailable" description="This shift's activity could not be loaded." />
        ) : items.length === 0 ? (
          <EmptyState compact variant="timeline" title="No activity yet" description="Lifecycle events for this shift will appear here." />
        ) : (
          <>
            {items.map((item) => {
              const d = describeTimelineItem(item);
              const reason = typeof item.metadata.reason === 'string' ? item.metadata.reason : null;
              return (
                <div key={item.id} className="timeline-item" data-step={item.step ?? undefined}>
                  <div className="timeline-icon" style={{ background: d.bg, color: d.color }}><d.Icon size={13} /></div>
                  <div className="timeline-content">
                    <p className="timeline-title">{d.title}</p>
                    {reason && <p className="timeline-desc">{reason}</p>}
                    <p className="timeline-meta">{item.actor?.fullName ?? 'System'} • {timeAgo(item.createdAt)}</p>
                  </div>
                </div>
              );
            })}
            {query.hasNextPage && (
              <button className="btn btn-outline" style={{ margin: '8px 16px' }} onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
              </button>
            )}
          </>
        )}
      </div>
    </RightSidePanel>
  );
}
