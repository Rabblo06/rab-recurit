-- D-Q6 realistic journeys: what the Venue Manager journey needs on top of the harness seed (seed/seed.js creates no
-- Venue Manager teams, so `POST /shifts/request` would have nobody to request). Deterministic and idempotent: every
-- organisation's venuemanager1 gets staff01..staff12 of the same organisation and workspace as its team
-- (core.venue_manager_staff; the Venue Manager then requests from that team, the Internal Manager approves).
-- Run by scripts/dq6-bench.sh k6prep as the bootstrap superuser INSIDE costaudit-pg, after the disposable-marker check.
BEGIN;
INSERT INTO core.venue_manager_staff (organisation_id, workspace_id, manager_profile_id, staff_profile_id)
SELECT mp.organisation_id, mp.workspace_id, mp.id, sp.id
  FROM core."user" vu
  JOIN core.manager_profile mp ON mp.user_id = vu.id AND mp.type = 'venue'
 CROSS JOIN generate_series(1, 12) AS g(n)
  JOIN core."user" su ON su.organisation_id = vu.organisation_id
   AND su.email = 'staff' || lpad(g.n::text, 2, '0') || '@' || split_part(vu.email, '@', 2)
  JOIN core.staff_profile sp ON sp.user_id = su.id AND sp.workspace_id = mp.workspace_id
 WHERE vu.email LIKE 'venuemanager1@org%.example.test'
ON CONFLICT DO NOTHING;
COMMIT;
SELECT 'venue_manager_staff=' || count(*) FROM core.venue_manager_staff;
