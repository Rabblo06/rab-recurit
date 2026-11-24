export type Shift = {
  id: string;
  venueId?: string;
  startsAt: string;
  endsAt: string;
  status: string;
  venueName?: string;
  requiredCount: number;
  filledCount: number;
  requestedBy?: string | null;
};
export type Offer = {
  id: string;
  staffName?: string;
  venueName?: string;
  startsAt?: string;
  endsAt?: string;
  expiresAt?: string;
  status: string;
  offerKind?: string;
  managerConfirmedAt?: string | null;
  managerRejectedAt?: string | null;
};
export type Request = {
  id: string;
  venueName: string;
  startsAt: string;
  status: string;
  displayStatus?: string;
  requiredCount: number;
  selectedCount: number | string;
};
export type Page<T> = { data: T[]; total: number };
export const rows = <T>(value: Page<T> | T[]): T[] => (Array.isArray(value) ? value : value.data);
export const LONDON = 'Europe/London';
export function londonDate(date: Date) {
  return date.toLocaleDateString('en-CA', { timeZone: LONDON });
}
export function upcomingShifts(shifts: Shift[], now: Date) {
  return shifts
    .filter(
      (shift) =>
        ['open', 'offered', 'partially_filled', 'fully_filled', 'confirmed', 'in_progress'].includes(
          shift.status,
        ) && Date.parse(shift.endsAt) > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
export function awaitingOffers(offers: Offer[], now: Date) {
  return offers
    .filter(
      (offer) =>
        offer.status === 'staff_accepted' &&
        !offer.managerConfirmedAt &&
        !offer.managerRejectedAt &&
        (!offer.expiresAt || Date.parse(offer.expiresAt) > now.getTime()),
    )
    .sort(
      (a, b) => (Date.parse(a.expiresAt ?? '') || Infinity) - (Date.parse(b.expiresAt ?? '') || Infinity),
    );
}
export function when(value?: string, includeTime = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Date unavailable';
  return new Date(value).toLocaleString('en-GB', {
    timeZone: LONDON,
    day: 'numeric',
    month: 'short',
    ...(includeTime ? ({ hour: '2-digit', minute: '2-digit' } as const) : {}),
  });
}
export function isUrgent(deadline: string | undefined, now: Date) {
  const ms = Date.parse(deadline ?? '') - now.getTime();
  return ms > 0 && ms <= 2 * 3600000;
}
export const statusLabel = (status: string) =>
  status.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
