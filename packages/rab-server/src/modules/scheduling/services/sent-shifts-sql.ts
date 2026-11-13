import { keysetTimestampSql } from '../../../engine/dto/keyset-cursor';
import { SentShiftView } from '../dto/list-sent-shifts.dto';
import { SHIFT_ACTION_WINDOW_HOURS } from '../utils/shift-action-window';

/**
 * `GET /shifts/sent` (Venue Manager app): the SQL of `SchedulingService.listSentShifts`, kept in code constants so the
 * service and its row-set equivalence test (sent-shifts-one-statement.integration.spec.ts) compose the same fragments.
 * Parameters: $1 organisation, $2 requesting user, $3 the caller's venue ids, $4 one shift id or NULL; the page adds
 * $5 limit, $6 offset and, with a cursor, $7/$8 (the keyset bound).
 */
// One row per submitted request (shift), classified in SQL so tabs, totals and pagination agree. Offer counts use
// each recipient's LATEST offer; assignment state is authoritative after confirmation (the offer stays historical).
// Phase C1: the counts are computed per request (LATERAL, below) instead of in a CTE over every offer of the
// organisation joined back by shift id: same numbers, but bounded by the caller's own requests. Measured on synthetic
// volume (EXPLAIN ANALYZE, 100k offers in one organisation): the organisation-wide CTE cost ~0.2 s per call, and restricting it by
// a sub-select made the planner (blind to the RLS predicates' selectivity) re-aggregate it once per request (~18 s).
// sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
export const SENT_SHIFT_ROWS_SQL = `WITH rows AS (
    SELECT s.id, s.status, s.required_count AS "requiredCount", s.filled_count AS "filledCount",
      coalesce(s.default_starts_at, s.starts_at) AS "startsAt", coalesce(s.default_ends_at, s.ends_at) AS "endsAt",
      s.created_at AS "submittedAt", ${keysetTimestampSql('s.created_at')} AS keyset_ts, v.name AS "venueName", jr.name AS "roleName",
      s.ends_at + make_interval(hours => ${SHIFT_ACTION_WINDOW_HOURS}) AS "actionExpiresAt",
      now() >= s.ends_at + make_interval(hours => ${SHIFT_ACTION_WINDOW_HOURS}) AS "actionExpired",
      coalesce(c.sent, 0) AS sent, coalesce(c.pending, 0) AS pending, coalesce(c.accepted, 0) AS accepted,
      coalesce(c.confirmed, 0) AS confirmed, coalesce(c.no_show, 0) AS no_show, coalesce(c.cancelled, 0) AS cancelled,
      coalesce(c.declined, 0) AS declined, coalesce(c.expired, 0) AS expired, coalesce(c.withdrawn, 0) AS withdrawn,
      coalesce(c.rejected, 0) AS rejected, coalesce(c.not_confirmed_in_time, 0) AS not_confirmed_in_time,
      s.status IN ('cancelled','completed','declined') AS terminal
    FROM shift s JOIN venue v ON v.id = s.venue_id JOIN job_role jr ON jr.id = s.job_role_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS sent,
        count(*) FILTER (WHERE status = 'pending' AND assignment_status = 'offered')::int AS pending,
        count(*) FILTER (WHERE assignment_status = 'staff_accepted')::int AS accepted,
        count(*) FILTER (WHERE assignment_status IN ('confirmed','completed'))::int AS confirmed,
        count(*) FILTER (WHERE assignment_status = 'no_show')::int AS no_show,
        count(*) FILTER (WHERE assignment_status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE status = 'declined')::int AS declined,
        count(*) FILTER (WHERE status = 'expired')::int AS expired,
        count(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
        count(*) FILTER (WHERE status = 'manager_rejected')::int AS rejected,
        count(*) FILTER (WHERE status = 'manager_rejected' AND rejected_by IS NULL AND rejection_reason = 'confirmation_deadline_passed')::int AS not_confirmed_in_time
      FROM (
        SELECT DISTINCT ON (o.staff_profile_id) o.status, sa.status AS assignment_status, o.rejected_by, o.rejection_reason
          FROM shift_assignment sa JOIN job_offer o ON o.shift_assignment_id = sa.id
         WHERE sa.shift_id = s.id AND sa.organisation_id = $1 AND o.organisation_id = $1
         ORDER BY o.staff_profile_id, o.sent_at DESC, o.id DESC
      ) latest
    ) c ON true
    WHERE s.organisation_id = $1 AND s.requested_by = $2 AND s.venue_id = ANY($3::uuid[]) AND ($4::uuid IS NULL OR s.id = $4)
  ), classified AS (
    SELECT r.*,
      -- Genuinely expired: past the shift action window, or every recipient's latest offer expired with nobody
      -- accepted/confirmed. Terminal requests (cancelled / completed / declined) keep their own state.
      (NOT r.terminal AND (r."actionExpired" OR (r.sent > 0 AND r.expired = r.sent))) AS is_expired
    FROM rows r
  )`;
/** Each tab's predicate over `classified` (the `view` query parameter is validated against these keys by the DTO). */
export const SENT_SHIFT_VIEW_SQL: Readonly<Record<SentShiftView, string>> = Object.freeze({
  all: 'NOT is_expired',
  pending: `NOT is_expired AND NOT terminal AND (status = 'pending_manager_approval' OR pending > 0)`,
  accepted: 'NOT is_expired AND NOT terminal AND accepted + confirmed > 0',
  confirmed: '"requiredCount" > 0 AND confirmed >= "requiredCount" AND NOT terminal AND NOT is_expired',
  declined: `(status = 'declined' OR (NOT terminal AND declined > 0)) AND NOT is_expired`,
  expired: 'is_expired',
});

/**
 * XP-05: ONE statement for the page rows AND the tab counts. `classified` is referenced twice, so PostgreSQL materialises
 * it once (a CTE referenced more than once is never inlined) instead of all of SENT_SHIFT_ROWS_SQL running again in a
 * second statement. The counts come back as one JSON object (`tab_counts`); the page is LEFT JOINed onto the single
 * counts row, so an empty page still returns the counts (one row whose page columns are all NULL). Same predicates,
 * parameters and order as the two statements it replaced (rows, then `count(*) FILTER` per tab); both now read one snapshot.
 * `viewSql` is SENT_SHIFT_VIEW_SQL[view] or 'TRUE'; `bound` is '' or the keyset WHERE built from literal fragments.
 */
export function sentShiftsPageAndCountsSql(viewSql: string, bound: string): string {
  // sql-injection-reviewed: composes code constants only (SENT_SHIFT_ROWS_SQL, SENT_SHIFT_VIEW_SQL keys and predicates, the caller's literal viewSql/bound); every value is a bound $n parameter.
  return `${SENT_SHIFT_ROWS_SQL}, tabs AS (
      SELECT json_build_object(${Object.entries(SENT_SHIFT_VIEW_SQL).map(([k, w]) => `'${k}', count(*) FILTER (WHERE ${w})::int`).join(', ')},
        'submitted', count(*)::int) AS tab_counts FROM classified
    ), page AS (
      SELECT * FROM (SELECT *, count(*) OVER () AS view_total FROM classified WHERE ${viewSql}) v ${bound}
      ORDER BY "submittedAt" DESC, id DESC LIMIT $5 OFFSET $6
    )
    SELECT page.*, tabs.tab_counts FROM tabs LEFT JOIN page ON true ORDER BY page."submittedAt" DESC, page.id DESC`;
}
