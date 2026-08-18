/**
 * Semantic colour tokens. No call site — web or mobile — ever writes a raw
 * hex; everything consumes these, or the `StatusBadge` mapping below.
 * See rab-workforce-architecture.md §12.
 */
export const colors = {
  bg: {
    app: '#F2F3F1',
    surface: '#FFFFFF',
    subtle: '#E9EBE8',
  },
  accent: {
    DEFAULT: '#12735A',
    strong: '#0C5643',
    soft: '#CFE7DE',
  },
  text: {
    primary: '#111312',
    secondary: '#6B7270',
    tertiary: '#9AA09E',
  },
  border: '#E3E6E3',
  danger: '#B42318',
  warning: '#B54708',
  info: '#175CD3',
} as const;

export type ShiftStatusColorKey =
  | 'draft'
  | 'open'
  | 'offered'
  | 'partially_filled'
  | 'fully_filled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type AttendanceStatusColorKey =
  | 'scheduled'
  | 'clocked_in'
  | 'on_break'
  | 'clocked_out'
  | 'late'
  | 'missing_clock_out'
  | 'absent'
  | 'under_review'
  | 'approved'
  | 'disputed';

/** Two-step offer flow: pending -> staff_accepted -> manager_confirmed|manager_rejected. */
export type OfferStatusColorKey =
  | 'pending'
  | 'staff_accepted'
  | 'manager_confirmed'
  | 'manager_rejected'
  | 'declined'
  | 'expired'
  | 'withdrawn';

/**
 * The one place status → colour is decided. `StatusBadge` reads this; no
 * other component may branch on a status string to pick a colour.
 */
export const statusColor: Record<
  ShiftStatusColorKey | AttendanceStatusColorKey | OfferStatusColorKey,
  keyof typeof colors | 'accent'
> = {
  draft: 'text',
  open: 'info',
  offered: 'info',
  partially_filled: 'warning',
  fully_filled: 'accent',
  confirmed: 'accent',
  in_progress: 'accent',
  completed: 'accent',
  cancelled: 'danger',
  scheduled: 'text',
  clocked_in: 'accent',
  on_break: 'warning',
  clocked_out: 'accent',
  late: 'warning',
  missing_clock_out: 'danger',
  absent: 'danger',
  under_review: 'warning',
  approved: 'accent',
  disputed: 'danger',
  pending: 'info',
  staff_accepted: 'warning',
  manager_confirmed: 'accent',
  manager_rejected: 'danger',
  declined: 'danger',
  expired: 'text',
  withdrawn: 'text',
};
