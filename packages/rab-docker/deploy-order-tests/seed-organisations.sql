-- Deploy-order real-container tests (TEST-ONLY): a SYNTHETIC staffing picture written BEFORE an upgrade, so the upgrade
-- runs against an EXISTING database (the fresh-install proof fails) and the driver can compare it afterwards.
--
-- Run by run-upgrade-with-data-tests.cjs as the disposable stack's PostgreSQL superuser (psql -v ON_ERROR_STOP=1), the way a
-- restore or an operator fixture would write it. Two organisations (dot-seed-a, dot-seed-b), each with a CEO, its manager
-- workspace, membership and profile, a role, two venues, a job role, three staff, shifts (completed and upcoming),
-- assignments, offers, attendance (worked minutes from the fixed clock-in/out below: 8 h minus a 30 min break = 450), approved
-- payroll records and a payroll run. Every value is synthetic (.invalid e-mail domain, no real person). Money is bigint pence.
-- Idempotence: refuses to run twice (the slugs are UNIQUE).
\set ON_ERROR_STOP on
DO $seed$
DECLARE
  tag text;
  org uuid; ceo uuid; ws uuid; role_id uuid; staff_role uuid; venue1 uuid; venue2 uuid; jr uuid;
  staff_user uuid; staff_ids uuid[]; sp uuid;
  past_shift uuid; future_shift uuid; asg uuid; att uuid; rec uuid; cal uuid; per uuid; run uuid;
  i int;
  -- A fixed synthetic argon2id-shaped value: nobody can log in with it (no password produces it in this test).
  pw constant text := '$argon2id$v=19$m=19456,t=2,p=1$ZG90c2VlZHNhbHQwMDAwMA$ZG90LXNlZWQtbm90LWEtcmVhbC1oYXNoLTAwMDAwMDA';
  t0 constant timestamptz := date_trunc('day', now()) - interval '2 days' + interval '9 hours';
BEGIN
  FOREACH tag IN ARRAY ARRAY['a', 'b'] LOOP
    INSERT INTO core.organisation (name, slug) VALUES ('Deploy-order seed ' || upper(tag), 'dot-seed-' || tag) RETURNING id INTO org;
    INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status)
      VALUES (org, 'ceo-' || tag || '@dot-seed.invalid', pw, 'Seed', 'Ceo ' || upper(tag), 'active') RETURNING id INTO ceo;
    INSERT INTO core.role (organisation_id, key, name, is_system) VALUES (org, 'ceo', 'CEO', true) RETURNING id INTO role_id;
    INSERT INTO core.role (organisation_id, key, name, is_system) VALUES (org, 'staff', 'Staff', true) RETURNING id INTO staff_role;
    INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES (ceo, role_id, org);
    INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status)
      VALUES (org, ceo, 'Seed workspace ' || upper(tag), 'dot-seed-' || tag, 'active') RETURNING id INTO ws;
    INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES (org, ceo, 'ceo', ws);
    INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES (org, ceo, ws, 'active', 'write_path');
    INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES (org, 'Seed Hall ' || upper(tag), ceo, ws) RETURNING id INTO venue1;
    INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES (org, 'Seed Garden ' || upper(tag), ceo, ws) RETURNING id INTO venue2;
    INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES (org, 'Seed Bartender', 1500, ceo, ws) RETURNING id INTO jr;
    staff_ids := ARRAY[]::uuid[];
    FOR i IN 1..3 LOOP
      INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status)
        VALUES (org, 'staff' || i || '-' || tag || '@dot-seed.invalid', pw, 'Seed', 'Staff ' || i, 'active') RETURNING id INTO staff_user;
      INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES (staff_user, staff_role, org);
      INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id)
        VALUES (org, staff_user, 'DOT-' || upper(tag) || '-' || i, ceo, ws) RETURNING id INTO sp;
      INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES (org, staff_user, ws, 'active', 'write_path');
      staff_ids := staff_ids || sp;
    END LOOP;
    -- A completed shift two days ago (2 needed, 2 worked) and an upcoming one (2 needed: 1 confirmed, 1 offered).
    INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
      VALUES (org, venue1, jr, t0, t0 + interval '8 hours', 30, 2, 2, 1500, 'completed', ceo, ws) RETURNING id INTO past_shift;
    INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
      VALUES (org, venue2, jr, t0 + interval '4 days', t0 + interval '4 days 8 hours', 30, 2, 1, 1500, 'partially_filled', ceo, ws) RETURNING id INTO future_shift;
    INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES (org, 2026, 1, 'deploy-order-seed', ceo) RETURNING id INTO cal;
    INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday)
      VALUES (org, cal, (t0 - interval '7 days')::date, (t0 + interval '6 days')::date, (t0 + interval '10 days')::date) RETURNING id INTO per;
    INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES (org, ws, per, ceo) RETURNING id INTO run;
    FOR i IN 1..2 LOOP
      INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
        VALUES (org, past_shift, staff_ids[i], 'completed', 1500, ceo, t0 - interval '1 day', tstzrange(t0, t0 + interval '8 hours'), ws) RETURNING id INTO asg;
      INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
        VALUES (org, asg, staff_ids[i], 'staff_accepted', t0 - interval '2 days', t0 - interval '1 day', 11250, ceo, ws);
      INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence)
        VALUES (org, asg, past_shift, staff_ids[i], ws, t0, t0 + interval '8 hours', 'approved', 450, 11250) RETURNING id INTO att;
      INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence, approved_at, approved_by)
        VALUES (org, ws, att, past_shift, staff_ids[i], 'approved', 450, 1500, 11250, t0 + interval '1 day', ceo) RETURNING id INTO rec;
      INSERT INTO core.payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence)
        VALUES (org, ws, run, rec, staff_ids[i], t0::date, 450, 1500, 11250);
    END LOOP;
    INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
      VALUES (org, future_shift, staff_ids[1], 'confirmed', 1500, ceo, now(), tstzrange(t0 + interval '4 days', t0 + interval '4 days 8 hours'), ws);
    INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, workspace_id)
      VALUES (org, future_shift, staff_ids[3], 'offered', 1500, ceo, tstzrange(t0 + interval '4 days', t0 + interval '4 days 8 hours'), ws) RETURNING id INTO asg;
    INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
      VALUES (org, asg, staff_ids[3], 'pending', now(), now() + interval '3 days', 11250, ceo, ws);
  END LOOP;
END
$seed$;
