#!/usr/bin/env bash
# Adds what the C1 polling screens need on top of the harness's deterministic seed (seed/seed.js), deterministically:
#   1. Venue requests: the base seed creates no venue-requested shifts, so Sent Shifts (VM), Venue Offers and the venue
#      offer pipeline would be empty. Every second non-draft shift at each Venue Manager's venue (ordered by start, id)
#      becomes that VM's request (`requested_by`), keeping its manager1 owner (`created_by`), its offers and assignments.
#      About half of each venue's 31 days of shifts, i.e. a busy venue's history plus its upcoming requests.
#   2. Platform admins for the admin panel Health tab: ceo@org01 (load generator; the API has no onboarding gate) and
#      manager1@org05 (the real web client: a CEO without an own workspace is sent to /onboarding by the web shell).
# Runs as the bootstrap superuser INSIDE costaudit-pg (never a host client, never another database), only after the
# disposable-database marker check. Idempotent.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
OUT="${OUT:?OUT not set}"; assert_outside_main "the results directory (OUT)" "$OUT"; mkdir -p "$OUT"
[ "$(q "select shobj_description(oid,'pg_database') from pg_database where datname='rab'")" = "crewflow-cost disposable measurement database" ] ||
  die "costaudit-pg does not carry the disposable marker; refusing"
[ "$(q "select count(*) from core.organisation where slug like 'costaudit-%'")" -ge 5 ] || die "seed the harness first (at least orgs 1-5)"

psql_su <<'SQL' > "$OUT/seed-screen-traffic.log"
BEGIN;
WITH vm AS (
  SELECT u.id AS user_id, mv.venue_id
    FROM core."user" u
    JOIN core.manager_profile mp ON mp.user_id = u.id AND mp.type = 'venue'
    JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
   WHERE u.email LIKE 'venuemanager%@org%.example.test'
), ranked AS (
  SELECT s.id, vm.user_id, row_number() OVER (PARTITION BY s.venue_id ORDER BY s.starts_at, s.id) AS n
    FROM core.shift s JOIN vm ON vm.venue_id = s.venue_id
   WHERE s.status <> 'draft'
)
UPDATE core.shift s SET requested_by = r.user_id FROM ranked r WHERE s.id = r.id AND r.n % 2 = 0 AND s.requested_by IS DISTINCT FROM r.user_id;
INSERT INTO core.platform_admin (user_id, granted_at)
  SELECT id, now() FROM core."user" WHERE email IN ('ceo@org01.example.test', 'manager1@org05.example.test')
  ON CONFLICT (user_id) DO NOTHING;
COMMIT;
SELECT 'requested_shifts=' || count(*) FROM core.shift WHERE requested_by IS NOT NULL;
SELECT 'requested_upcoming=' || count(*) FROM core.shift WHERE requested_by IS NOT NULL AND ends_at > now();
SELECT 'platform_admins=' || count(*) FROM core.platform_admin WHERE revoked_at IS NULL;
SQL
q "vacuum analyze core.shift" >/dev/null
log "screen-traffic seed: $(tr '\n' ' ' < "$OUT/seed-screen-traffic.log")"
