import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconBuildingStore, IconCalendarEvent } from '@tabler/icons-react';

import { api } from '../../shared/api';
import { getApiErrorStatus } from '../../shared/lib/apiError';
import { aiKeys } from './aiApi';
import { useAiChat } from './AiChatProvider';
import type { AiRecordRef } from './aiRecordRefs';

/**
 * S2 record chip. The assistant's text only says WHICH record (a server-validated id from this turn's tool results); the
 * label is read from the record's OWN route under the person's own permissions — never from the model's words. A record
 * the person cannot see (or that no longer exists) answers 404 → "Record unavailable", the same for every reason. A
 * chip navigates inside Crewflow only.
 *
 * `staff_profile` (S2, Batch 3): no read tool returns a staff profile id yet and there is no web read route, so such a
 * reference renders as the plain words "a staff member" — no chip, no fetch.
 */
const SHIFT_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function shiftLabel(startsAt: string): string {
  const parts = Object.fromEntries(SHIFT_FORMAT.formatToParts(new Date(startsAt)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} · ${parts.hour}:${parts.minute}`;
}

async function readLabel(ref: AiRecordRef): Promise<string> {
  if (ref.type === 'shift') return shiftLabel((await api.get<{ startsAt: string }>(`/shifts/${encodeURIComponent(ref.id)}`)).data.startsAt);
  return (await api.get<{ name: string }>(`/venues/${encodeURIComponent(ref.id)}`)).data.name;
}

export default function AiRecordChip({ recordRef }: { recordRef: AiRecordRef }) {
  const { scope } = useAiChat();
  const fetchable = recordRef.type === 'shift' || recordRef.type === 'venue';
  const label = useQuery({
    queryKey: [...aiKeys.all(scope), 'record', recordRef.type, recordRef.id],
    queryFn: () => readLabel(recordRef),
    enabled: fetchable,
    retry: (count, error) => getApiErrorStatus(error) !== 404 && getApiErrorStatus(error) !== 403 && count < 1,
    staleTime: 60_000,
    meta: { silent: true },
  });
  // S2 (Batch 3): chips for shifts and venues only — no read tool returns a staff profile id yet, so a staff reference is
  // plain text, never a chip, never a fetch.
  if (!fetchable) return <span data-type={recordRef.type}>a staff member</span>;
  const Icon = recordRef.type === 'shift' ? IconCalendarEvent : IconBuildingStore;
  if (label.isLoading) return <span className="ai-record-chip" data-type={recordRef.type} aria-busy="true"><Icon size={12} aria-hidden="true" />…</span>;
  if (label.isError || !label.data) {
    return (
      <span className="ai-record-chip" data-type={recordRef.type} data-unavailable="true">
        <Icon size={12} aria-hidden="true" />Record unavailable
      </span>
    );
  }
  const to = recordRef.type === 'shift' ? `/venue-offers/${encodeURIComponent(recordRef.id)}` : '/venues';
  return (
    <Link className="ai-record-chip" data-type={recordRef.type} to={to} aria-label={`${recordRef.type === 'shift' ? 'Shift' : 'Venue'}: ${label.data}`}>
      <Icon size={12} aria-hidden="true" />{label.data}
    </Link>
  );
}
