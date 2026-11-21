# M9 load test: plans of the ten slowest statements

Companion to [LOAD-TEST.md](LOAD-TEST.md) §5. Each statement was captured by `auto_explain` (with its parameters) during an
unmeasured 0.3x run, then replayed idle as `crewflow_owner` (FORCE RLS) under the console CEO's tenant GUCs with
`EXPLAIN (ANALYZE, BUFFERS)` (`packages/rab-e2e-testing/system/perf/explain-replay.mjs`). Only the plan lines with
timings, buffers, conditions and JIT are kept; the full plans are in the replay JSON on the test host. Identifiers in the
parameters are synthetic rows of the disposable database.

### Q1: SELECT a.id, a.status, a.clock_in_at, a.clock_out_at, a.worked_minutes, a.earned_pence, a....

Calls in the capture run: 54. Slowest captured (0.3x load, JIT on): 11028 ms, of which JIT 7313 ms. Replayed idle, median of 3: JIT on 1982.4 ms, JIT off 598.2 ms, JIT off with the index fix 1.7 ms.

<details><summary>Statement</summary>

```sql
SELECT
    a.id, a.status, a.clock_in_at, a.clock_out_at, a.worked_minutes, a.earned_pence,
    a.break_minutes, a.location_verified, a.clock_out_method, a.clock_in_method,
    sa.check_in_required, sa.checked_in_at, sa.check_in_source,
    s.id AS shift_id, COALESCE(lower(sa.period), s.starts_at) AS starts_at, COALESCE(upper(sa.period), s.ends_at) AS ends_at,
    v.name AS venue_name, v.photo_file_id AS venue_photo_file_id, jr.name AS role_name,
    sp.id AS staff_profile_id, u.first_name, u.last_name,
    pr.status AS payroll_status,
    CASE WHEN pr.status IN ('approved','processing','paid') THEN pr.amount_pence END AS payroll_approved_pence
  FROM "core"."attendance" a
  JOIN "core"."shift_assignment" sa ON sa.id = a.shift_assignment_id
  JOIN "core"."shift" s ON s.id = a.shift_id
  JOIN "core"."venue" v ON v.id = s.venue_id
  JOIN "core"."job_role" jr ON jr.id = s.job_role_id
  JOIN "core"."staff_profile" sp ON sp.id = a.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
  LEFT JOIN "core"."payroll_record" pr ON pr.attendance_id = a.id
 WHERE sp.created_by = $1 ORDER BY a.clock_in_at DESC, a.id DESC LIMIT $2 OFFSET $3
```

Parameters: ["9485f486-77af-4e50-8bf1-50b04af32832","50","0"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Limit  (actual time=1926.421..1926.449 rows=50 loops=1)
  Buffers: shared hit=951984
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
    ->  Seq Scan on manager_profile mp_1  (actual time=0.079..0.080 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur_2.role_id)
                        Index Cond: (id = rp_2.permission_id)
  ->  Sort  (actual time=535.444..535.461 rows=50 loops=1)
        Sort Method: top-N heapsort  Memory: 46kB
        Buffers: shared hit=951984
        ->  Nested Loop  (actual time=7.627..510.477 rows=90180 loops=1)
              Buffers: shared hit=951984
              ->  Seq Scan on job_role jr  (actual time=0.033..0.034 rows=1 loops=1)
                    Buffers: shared hit=1
              ->  Nested Loop Left Join  (actual time=7.583..495.301 rows=90180 loops=1)
                    Buffers: shared hit=951983
                    ->  Nested Loop  (actual time=7.485..352.066 rows=90180 loops=1)
                          Buffers: shared hit=591665
                          ->  Nested Loop  (actual time=7.470..334.075 rows=90180 loops=1)
                                Buffers: shared hit=591623
                                ->  Nested Loop  (actual time=7.448..232.455 rows=90180 loops=1)
...
Planning Time: 11.605 ms
JIT:
  Functions: 434
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 15.335 ms, Inlining 18.318 ms, Optimization 770.606 ms, Emission 608.929 ms, Total 1413.187 ms
Execution Time: 1942.410 ms
```

Same statement, JIT off, with the index fix:

```text
Limit  (actual time=0.202..0.986 rows=50 loops=1)
  Buffers: shared hit=839
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur_2.role_id)
                        Index Cond: (id = rp_2.permission_id)
  ->  Nested Loop Left Join  (actual time=0.202..0.980 rows=50 loops=1)
        Buffers: shared hit=839
        ->  Nested Loop  (actual time=0.196..0.851 rows=50 loops=1)
              Buffers: shared hit=689
              ->  Nested Loop  (actual time=0.191..0.836 rows=50 loops=1)
                    Buffers: shared hit=688
                    ->  Nested Loop  (actual time=0.179..0.781 rows=50 loops=1)
                          Buffers: shared hit=648
                          ->  Nested Loop  (actual time=0.168..0.658 rows=50 loops=1)
                                Buffers: shared hit=536
                                ->  Nested Loop  (actual time=0.159..0.482 rows=50 loops=1)
                                      Buffers: shared hit=336
...
Planning Time: 12.484 ms
Execution Time: 1.327 ms
```

### Q2: WITH base AS ( SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, ...

Calls in the capture run: 28. Slowest captured (0.3x load, JIT on): 7352 ms, of which JIT 3014 ms. Replayed idle, median of 3: JIT on 1310 ms, JIT off 1084.9 ms, JIT off with the index fix 461.8 ms.

<details><summary>Statement</summary>

```sql
WITH base AS (
  SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, s.required_count, s.filled_count,
    v.name AS venue_name, jr.name AS role_name,
    COALESCE(sr.status, 'pending') AS report_status, sr.final_pdf_sent_at AS final_queued_at, sr.final_file_id,
    count(sa.id) AS staff_count,
    count(sa.id) FILTER (WHERE sa.status = 'no_show') AS no_shows,
    count(a.id) FILTER (WHERE a.status IN ('clocked_in','on_break')) AS open_attendance,
    count(a.id) AS any_attendance,
    count(a.id) FILTER (WHERE a.clock_out_at IS NOT NULL) AS clocked_out,
    count(sa.id) FILTER (WHERE sa.status <> 'no_show' AND a.clock_out_at IS NULL) AS unresolved,
    count(sa.id) FILTER (WHERE sa.attendance_reviewed_at IS NULL) AS unreviewed
  FROM "core"."shift" s
  JOIN "core"."venue" v ON v.id = s.venue_id
  JOIN "core"."job_role" jr ON jr.id = s.job_role_id
  LEFT JOIN "core"."shift_assignment" sa ON sa.shift_id = s.id AND sa.status IN ('confirmed','completed','no_show')
  LEFT JOIN "core"."attendance" a ON a.shift_assignment_id = sa.id
  LEFT JOIN "core"."shift_report" sr ON sr.shift_id = s.id
  WHERE s.organisation_id = $1 AND s.created_by = $2
    AND s.status NOT IN ('draft','pending_manager_approval','declined')
  GROUP BY s.id, v.name, jr.name, sr.id
), rows AS (
  SELECT b.*, d.* FROM base b
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE eo.status IN ('PENDING','QUEUED','PROCESSING','RETRY')) AS d_pending,
  count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent, count(*) FILTER (WHERE eo.status = 'FAILED') AS d_failed, max(eo.sent_at) AS d_last_sent_at FROM core.email_outbox eo
    WHERE b.final_file_id IS NOT NULL AND eo.attachment_file_id = b.final_file_id AND eo.status <> 'CANCELLED') d ON true
)
        SELECT r.*, now() AS db_now, count(*) OVER () AS total FROM rows r
        WHERE (CASE WHEN (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) THEN now() >= r.d_last_sent_at + interval '5 hours'
  ELSE now() >= r.ends_at + interval '5 hours' END)
        ORDER BY r.ends_at DESC, r.shift_id
        LIMIT $3 OFFSET $4
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","9485f486-77af-4e50-8bf1-50b04af32832","20","0"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Limit  (actual time=1302.561..1302.579 rows=20 loops=1)
  Buffers: shared hit=1043422, temp read=6765 written=5987
  ->  Sort  (actual time=866.053..866.068 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 34kB
        Buffers: shared hit=1043422, temp read=6765 written=5987
        ->  WindowAgg  (actual time=851.291..856.770 rows=44888 loops=1)
              Buffers: shared hit=1043422, temp read=6765 written=5987
              ->  Nested Loop Left Join  (actual time=294.373..834.294 rows=44888 loops=1)
                    Rows Removed by Filter: 22708
                    Buffers: shared hit=1043422, temp read=4784 written=4791
                    ->  GroupAggregate  (actual time=294.259..347.083 rows=67596 loops=1)
                          Buffers: shared hit=11021, temp read=4784 written=4791
                          ->  Sort  (actual time=294.204..310.002 rows=119346 loops=1)
                                Sort Method: external merge  Disk: 22376kB
                                Buffers: shared hit=11021, temp read=4784 written=4791
                                ->  Result  (actual time=106.027..252.418 rows=119346 loops=1)
                                      Buffers: shared hit=11021, temp read=1987 written=1987
                                      ->  Hash Left Join  (actual time=106.013..246.045 rows=119346 loops=1)
                                            Hash Cond: (s.id = sr.shift_id)
                                            Buffers: shared hit=11021, temp read=1987 written=1987
                                            ->  Hash Right Join  (actual time=82.046..195.663 rows=119346 loops=1)
                                                  Hash Cond: (sa.shift_id = s.id)
                                                  Buffers: shared hit=8842, temp read=1987 written=1987
                                                  ->  Hash Left Join  (actual time=48.558..126.754 rows=103839 loops=1)
...
Planning Time: 1.158 ms
JIT:
  Functions: 75
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 5.074 ms, Inlining 13.349 ms, Optimization 249.864 ms, Emission 173.447 ms, Total 441.734 ms
Execution Time: 1309.998 ms
```

Same statement, JIT off, with the index fix:

```text
Limit  (actual time=449.619..449.635 rows=20 loops=1)
  Buffers: shared hit=55908, temp read=6765 written=5987
  ->  Sort  (actual time=449.617..449.631 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 34kB
        Buffers: shared hit=55908, temp read=6765 written=5987
        ->  WindowAgg  (actual time=433.719..440.636 rows=44888 loops=1)
              Buffers: shared hit=55908, temp read=6765 written=5987
              ->  Nested Loop Left Join  (actual time=320.071..416.169 rows=44888 loops=1)
                    Rows Removed by Filter: 22708
                    Buffers: shared hit=55908, temp read=4784 written=4791
                    ->  GroupAggregate  (actual time=320.038..378.719 rows=67596 loops=1)
                          Buffers: shared hit=11021, temp read=4784 written=4791
                          ->  Sort  (actual time=320.019..334.774 rows=119346 loops=1)
                                Sort Method: external merge  Disk: 22376kB
                                Buffers: shared hit=11021, temp read=4784 written=4791
                                ->  Result  (actual time=112.761..278.172 rows=119346 loops=1)
                                      Buffers: shared hit=11021, temp read=1987 written=1987
                                      ->  Hash Left Join  (actual time=112.758..270.718 rows=119346 loops=1)
                                            Hash Cond: (s.id = sr.shift_id)
                                            Buffers: shared hit=11021, temp read=1987 written=1987
...
Planning Time: 1.146 ms
Execution Time: 451.805 ms
```

### Q3: WITH base AS ( SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, ...

Calls in the capture run: 18. Slowest captured (0.3x load, JIT on): 5811 ms, of which JIT 3562 ms. Replayed idle, median of 3: JIT on 1309.6 ms, JIT off 1120.5 ms, JIT off with the index fix 485.8 ms.

<details><summary>Statement</summary>

```sql
WITH base AS (
  SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, s.required_count, s.filled_count,
    v.name AS venue_name, jr.name AS role_name,
    COALESCE(sr.status, 'pending') AS report_status, sr.final_pdf_sent_at AS final_queued_at, sr.final_file_id,
    count(sa.id) AS staff_count,
    count(sa.id) FILTER (WHERE sa.status = 'no_show') AS no_shows,
    count(a.id) FILTER (WHERE a.status IN ('clocked_in','on_break')) AS open_attendance,
    count(a.id) AS any_attendance,
    count(a.id) FILTER (WHERE a.clock_out_at IS NOT NULL) AS clocked_out,
    count(sa.id) FILTER (WHERE sa.status <> 'no_show' AND a.clock_out_at IS NULL) AS unresolved,
    count(sa.id) FILTER (WHERE sa.attendance_reviewed_at IS NULL) AS unreviewed
  FROM "core"."shift" s
  JOIN "core"."venue" v ON v.id = s.venue_id
  JOIN "core"."job_role" jr ON jr.id = s.job_role_id
  LEFT JOIN "core"."shift_assignment" sa ON sa.shift_id = s.id AND sa.status IN ('confirmed','completed','no_show')
  LEFT JOIN "core"."attendance" a ON a.shift_assignment_id = sa.id
  LEFT JOIN "core"."shift_report" sr ON sr.shift_id = s.id
  WHERE s.organisation_id = $1 AND s.created_by = $2
    AND s.status NOT IN ('draft','pending_manager_approval','declined')
  GROUP BY s.id, v.name, jr.name, sr.id
), rows AS (
  SELECT b.*, d.* FROM base b
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE eo.status IN ('PENDING','QUEUED','PROCESSING','RETRY')) AS d_pending,
  count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent, count(*) FILTER (WHERE eo.status = 'FAILED') AS d_failed, max(eo.sent_at) AS d_last_sent_at FROM core.email_outbox eo
    WHERE b.final_file_id IS NOT NULL AND eo.attachment_file_id = b.final_file_id AND eo.status <> 'CANCELLED') d ON true
)
        SELECT r.*, now() AS db_now, count(*) OVER () AS total FROM rows r
        WHERE (NOT (CASE WHEN (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) THEN now() >= r.d_last_sent_at + interval '5 hours'
  ELSE now() >= r.ends_at + interval '5 hours' END) OR (r.shift_status <> 'cancelled' AND NOT (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) AND (now() >= r.ends_at + interval '5 hours'
  OR (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND (r.d_failed > 0 OR r.d_sent = 0)))))
        ORDER BY (r.shift_status <> 'cancelled' AND NOT (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) AND (now() >= r.ends_at + interval '5 hours'
  OR (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND (r.d_failed > 0 OR r.d_sent = 0)))) DESC, r.starts_at ASC, r.shift_id
        LIMIT $3 OFFSET $4
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","9485f486-77af-4e50-8bf1-50b04af32832","20","0"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Limit  (actual time=1301.571..1301.590 rows=20 loops=1)
  Buffers: shared hit=1043422, temp read=7792 written=6488
  ->  Sort  (actual time=865.122..865.139 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 33kB
        Buffers: shared hit=1043422, temp read=7792 written=6488
        ->  WindowAgg  (actual time=839.295..849.274 rows=67596 loops=1)
              Buffers: shared hit=1043422, temp read=7792 written=6488
              ->  Nested Loop Left Join  (actual time=288.497..813.918 rows=67596 loops=1)
                    Buffers: shared hit=1043422, temp read=4784 written=4791
                    ->  GroupAggregate  (actual time=288.391..341.404 rows=67596 loops=1)
                          Buffers: shared hit=11021, temp read=4784 written=4791
                          ->  Sort  (actual time=288.333..305.299 rows=119346 loops=1)
                                Sort Method: external merge  Disk: 22376kB
                                Buffers: shared hit=11021, temp read=4784 written=4791
                                ->  Result  (actual time=104.649..247.599 rows=119346 loops=1)
                                      Buffers: shared hit=11021, temp read=1987 written=1987
                                      ->  Hash Left Join  (actual time=104.635..241.202 rows=119346 loops=1)
                                            Hash Cond: (s.id = sr.shift_id)
                                            Buffers: shared hit=11021, temp read=1987 written=1987
                                            ->  Hash Right Join  (actual time=80.996..192.496 rows=119346 loops=1)
                                                  Hash Cond: (sa.shift_id = s.id)
                                                  Buffers: shared hit=8842, temp read=1987 written=1987
                                                  ->  Hash Left Join  (actual time=48.338..125.006 rows=103839 loops=1)
                                                        Hash Cond: (sa.id = a.shift_assignment_id)
...
Planning Time: 1.144 ms
JIT:
  Functions: 75
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 5.465 ms, Inlining 13.507 ms, Optimization 251.236 ms, Emission 171.821 ms, Total 442.029 ms
Execution Time: 1309.615 ms
```

Same statement, JIT off, with the index fix:

```text
Limit  (actual time=540.286..540.317 rows=20 loops=1)
  Buffers: shared hit=55908, temp read=7792 written=6488
  ->  Sort  (actual time=540.284..540.312 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 33kB
        Buffers: shared hit=55908, temp read=7792 written=6488
        ->  WindowAgg  (actual time=494.917..516.741 rows=67596 loops=1)
              Buffers: shared hit=55908, temp read=7792 written=6488
              ->  Nested Loop Left Join  (actual time=330.835..461.853 rows=67596 loops=1)
                    Buffers: shared hit=55908, temp read=4784 written=4791
                    ->  GroupAggregate  (actual time=330.803..409.973 rows=67596 loops=1)
                          Buffers: shared hit=11021, temp read=4784 written=4791
                          ->  Sort  (actual time=330.785..353.743 rows=119346 loops=1)
                                Sort Method: external merge  Disk: 22376kB
                                Buffers: shared hit=11021, temp read=4784 written=4791
                                ->  Result  (actual time=120.122..288.056 rows=119346 loops=1)
                                      Buffers: shared hit=11021, temp read=1987 written=1987
                                      ->  Hash Left Join  (actual time=120.119..280.597 rows=119346 loops=1)
                                            Hash Cond: (s.id = sr.shift_id)
                                            Buffers: shared hit=11021, temp read=1987 written=1987
                                            ->  Hash Right Join  (actual time=91.380..224.418 rows=119346 loops=1)
...
Planning Time: 1.153 ms
Execution Time: 543.439 ms
```

### Q4: SELECT a.id AS attendance_id, a.status AS attendance_status, pr.id AS payroll_record_id, p...

Calls in the capture run: 5. Slowest captured (0.3x load, JIT on): 5205 ms, of which JIT 4991 ms. Replayed idle, median of 3: JIT on 1694.3 ms, JIT off 138.7 ms, JIT off with the index fix 224.7 ms.

<details><summary>Statement</summary>

```sql
SELECT a.id AS attendance_id, a.status AS attendance_status, pr.id AS payroll_record_id, pr.status AS payroll_status,
                pr.worked_minutes, pr.pay_rate_pence, pr.amount_pence, pr.status AS statement_payroll_status, pr.statement_status, pr.statement_attempts, pr.statement_file_id, pr.statement_generated_at, pr.statement_notified_at,
    (SELECT f.original_filename FROM core.stored_file f WHERE f.id = pr.statement_file_id AND f.status = 'AVAILABLE') AS statement_filename,
                sp.id AS staff_profile_id, sp.staff_ref, sp.employment_status, sp.default_pay_rate_pence, (sp.user_id = $3) AS own_hours,
                u.first_name, u.last_name, u.email, v.name AS venue_name, jr.name AS role_name,
                COALESCE(lower(sa.period), s.starts_at) AS starts_at, COALESCE(upper(sa.period), s.ends_at) AS ends_at
           FROM "core"."attendance" a
           JOIN "core"."shift_assignment" sa ON sa.id = a.shift_assignment_id
           JOIN "core"."shift" s ON s.id = a.shift_id
           JOIN "core"."venue" v ON v.id = s.venue_id
           JOIN "core"."job_role" jr ON jr.id = s.job_role_id
           JOIN "core"."staff_profile" sp ON sp.id = a.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
           LEFT JOIN "core"."payroll_record" pr ON pr.attendance_id = a.id AND pr.organisation_id = $1 AND pr.workspace_id = $2
          WHERE a.organisation_id = $1 AND a.workspace_id = $2
            AND COALESCE(lower(sa.period), s.starts_at) >= (make_date($4::int, $5::int, 1)::timestamp AT TIME ZONE $6::text)
            AND COALESCE(lower(sa.period), s.starts_at) < ((make_date($4::int, $5::int, 1) + interval '1 month')::timestamp AT TIME ZONE $6::text)
          ORDER BY COALESCE(lower(sa.period), s.starts_at), u.first_name, u.last_name, a.id
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","efc16b22-5bb5-4f92-a818-d96a25821c90","9485f486-77af-4e50-8bf1-50b04af32832","2026","11","Europe/London"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Sort  (actual time=1624.904..1625.071 rows=5250 loops=1)
  Sort Method: quicksort  Memory: 1586kB
  Buffers: shared hit=49095, temp read=938 written=938
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
    ->  Seq Scan on manager_profile mp_1  (actual time=0.266..0.267 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur_2.role_id)
                        Index Cond: (id = rp_2.permission_id)
  ->  Result  (actual time=1593.346..1621.718 rows=5250 loops=1)
        Buffers: shared hit=49095, temp read=938 written=938
        ->  Nested Loop  (actual time=92.741..118.137 rows=5250 loops=1)
              Buffers: shared hit=44148, temp read=938 written=938
              ->  Seq Scan on job_role jr  (actual time=0.034..0.035 rows=1 loops=1)
                    Buffers: shared hit=1
              ->  Hash Join  (actual time=92.698..117.681 rows=5250 loops=1)
                    Hash Cond: (s.venue_id = v.id)
                    Buffers: shared hit=44147, temp read=938 written=938
                    ->  Nested Loop  (actual time=92.655..116.998 rows=5250 loops=1)
                          Buffers: shared hit=44145, temp read=938 written=938
                          ->  Nested Loop Left Join  (actual time=92.630..109.387 rows=5250 loops=1)
                                Buffers: shared hit=29607, temp read=938 written=938
...
Planning Time: 9.151 ms
JIT:
  Functions: 453
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 14.582 ms, Inlining 21.202 ms, Optimization 840.237 ms, Emission 646.290 ms, Total 1522.312 ms
Execution Time: 1640.378 ms
```

Same statement, JIT off, with the index fix:

```text
Sort  (actual time=263.780..264.263 rows=5250 loops=1)
  Sort Method: quicksort  Memory: 1586kB
  Buffers: shared hit=49095, temp read=938 written=938
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
    ->  Seq Scan on manager_profile mp_1  (actual time=0.322..0.324 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur_2.role_id)
                        Index Cond: (id = rp_2.permission_id)
  ->  Result  (actual time=157.188..255.922 rows=5250 loops=1)
        Buffers: shared hit=49095, temp read=938 written=938
        ->  Nested Loop  (actual time=157.163..247.938 rows=5250 loops=1)
              Buffers: shared hit=44148, temp read=938 written=938
              ->  Seq Scan on job_role jr  (actual time=0.006..0.008 rows=1 loops=1)
                    Buffers: shared hit=1
              ->  Hash Join  (actual time=157.152..245.775 rows=5250 loops=1)
                    Hash Cond: (s.venue_id = v.id)
                    Buffers: shared hit=44147, temp read=938 written=938
...
Planning Time: 12.148 ms
Execution Time: 264.972 ms
```

### Q5: WITH cand AS ( SELECT o.id FROM "core"."job_offer" o JOIN "core"."staff_profile" sp ON sp....

Calls in the capture run: 15. Slowest captured (0.3x load, JIT on): 4712 ms, of which JIT 0 ms. Replayed idle, median of 3: JIT on 1208.1 ms, JIT off 1139.2 ms, JIT off with the index fix 1236.4 ms.

<details><summary>Statement</summary>

```sql
WITH cand AS (
         SELECT o.id FROM "core"."job_offer" o
           JOIN "core"."staff_profile" sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
          WHERE (u.search_vector @@ to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1))) OR core.immutable_unaccent(lower(u.first_name || ' ' || u.last_name)) LIKE core.immutable_unaccent(lower($3)))
         UNION
         SELECT o.id FROM "core"."job_offer" o
           JOIN "core"."shift_assignment" sa ON sa.id = o.shift_assignment_id
           JOIN "core"."shift" s ON s.id = sa.shift_id
           JOIN "core"."venue" v ON v.id = s.venue_id
          WHERE (v.search_vector @@ to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1))) OR core.immutable_unaccent(lower(v.name)) LIKE core.immutable_unaccent(lower($3)))
       )
       SELECT o.id, v.name AS venue_name, u.first_name, u.last_name,
              (core.immutable_unaccent(lower(u.first_name || ' ' || u.last_name)) = core.immutable_unaccent(lower($2)) OR core.immutable_unaccent(lower(v.name)) = core.immutable_unaccent(lower($2))) AS exact,
              ts_rank_cd(u.search_vector, to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)))) + ts_rank_cd(v.search_vector, to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)))) AS rank, ($1::text IS NULL AND $2::text IS NULL AND $3::text IS NULL AND $4::text IS NULL) AS _params
         FROM cand
         JOIN "core"."job_offer" o ON o.id = cand.id
         JOIN "core"."shift_assignment" sa ON sa.id = o.shift_assignment_id
         JOIN "core"."shift" s ON s.id = sa.shift_id
         JOIN "core"."venue" v ON v.id = s.venue_id
         JOIN "core"."staff_profile" sp ON sp.id = o.staff_profile_id
         JOIN core."user" u ON u.id = sp.user_id
        WHERE o.organisation_id = $5 AND o.created_by = $6 AND o.workspace_id = $7
        ORDER BY exact DESC, rank DESC, o.sent_at DESC, o.id
        LIMIT $8
```

Parameters: ["perf:*","perf","%perf%","perf%","ef920cad-69ce-4287-bc07-79eed68f7cc8","9485f486-77af-4e50-8bf1-50b04af32832","efc16b22-5bb5-4f92-a818-d96a25821c90","20"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Limit  (actual time=1156.235..1156.271 rows=20 loops=1)
  Buffers: shared hit=804387, temp read=1113 written=1273
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Sort  (actual time=1087.142..1087.172 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=804387, temp read=1113 written=1273
        ->  Result  (actual time=654.426..1061.612 rows=119581 loops=1)
              Buffers: shared hit=804387, temp read=1113 written=1273
              ->  Hash Join  (actual time=654.228..783.971 rows=119581 loops=1)
                    Hash Cond: (sp.user_id = u.id)
                    Buffers: shared hit=804387, temp read=1113 written=1273
                    ->  Nested Loop  (actual time=652.012..766.886 rows=119581 loops=1)
                          Buffers: shared hit=804143, temp read=1113 written=1273
                          ->  Hash Join  (actual time=651.958..742.598 rows=119581 loops=1)
                                Hash Cond: (sa.shift_id = s.id)
                                Buffers: shared hit=804103, temp read=1113 written=1273
                                ->  Hash Join  (actual time=638.125..703.420 rows=119581 loops=1)
                                      Hash Cond: (sa.id = o.shift_assignment_id)
                                      Buffers: shared hit=801306, temp read=1113 written=1273
                                      ->  Seq Scan on shift_assignment sa  (actual time=0.024..33.023 rows=119585 loops=1)
                                            Buffers: shared hit=3489
                                      ->  Hash  (actual time=637.902..637.928 rows=119581 loops=1)
...
Planning Time: 8.175 ms
JIT:
  Functions: 339
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 12.689 ms, Inlining 0.000 ms, Optimization 5.731 ms, Emission 65.826 ms, Total 84.246 ms
Execution Time: 1169.326 ms
```

Same statement, JIT off, with the index fix:

```text
Limit  (actual time=1235.787..1235.819 rows=20 loops=1)
  Buffers: shared hit=804387, temp read=1113 written=1273
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Sort  (actual time=1235.785..1235.811 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=804387, temp read=1113 written=1273
        ->  Result  (actual time=775.407..1210.905 rows=119581 loops=1)
              Buffers: shared hit=804387, temp read=1113 written=1273
              ->  Hash Join  (actual time=775.244..925.889 rows=119581 loops=1)
                    Hash Cond: (sp.user_id = u.id)
                    Buffers: shared hit=804387, temp read=1113 written=1273
                    ->  Nested Loop  (actual time=772.711..905.356 rows=119581 loops=1)
                          Buffers: shared hit=804143, temp read=1113 written=1273
                          ->  Hash Join  (actual time=772.682..880.056 rows=119581 loops=1)
                                Hash Cond: (sa.shift_id = s.id)
                                Buffers: shared hit=804103, temp read=1113 written=1273
                                ->  Hash Join  (actual time=754.475..830.916 rows=119581 loops=1)
                                      Hash Cond: (sa.id = o.shift_assignment_id)
...
Planning Time: 8.439 ms
Execution Time: 1236.364 ms
```

### Q6: SELECT r.id, r.period_id, r.status, count(l.id)::int AS records, COALESCE(sum(l.amount_pen...

Calls in the capture run: 6. Slowest captured (0.3x load, JIT on): 2582 ms, of which JIT 2591 ms. Replayed idle, median of 3: JIT on 1315.1 ms, JIT off 4.3 ms, JIT off with the index fix 4.5 ms.

<details><summary>Statement</summary>

```sql
SELECT r.id, r.period_id, r.status, count(l.id)::int AS records, COALESCE(sum(l.amount_pence), 0) AS gross
           FROM "core"."payroll_run" r LEFT JOIN "core"."payroll_run_line" l ON l.run_id = r.id
          WHERE r.organisation_id = $1 AND r.workspace_id = $2 GROUP BY r.id
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","efc16b22-5bb5-4f92-a818-d96a25821c90"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
GroupAggregate  (actual time=1309.103..1309.119 rows=1 loops=1)
  Buffers: shared hit=153
    ->  Seq Scan on manager_profile mp  (actual time=0.319..0.321 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur.role_id)
                        Index Cond: (id = rp.permission_id)
          Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                              Hash Cond: (rp_2.permission_id = p_2.id)
                              Index Cond: (id = rp_2.role_id)
                        Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_2.role_id))
                              Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                              Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                        Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                      Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                            Index Cond: (role_id = ur_1.role_id)
                                Index Cond: (id = rp_1.permission_id)
    ->  Seq Scan on manager_profile mp_2  (actual time=0.138..0.139 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur_3.role_id)
                        Index Cond: (id = rp_3.permission_id)
  ->  Result  (actual time=1305.359..1308.851 rows=6886 loops=1)
        Buffers: shared hit=153
...
Planning Time: 3.374 ms
JIT:
  Functions: 410
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 13.418 ms, Inlining 14.801 ms, Optimization 706.869 ms, Emission 583.170 ms, Total 1318.258 ms
Execution Time: 1323.042 ms
```

Same statement, JIT off, with the index fix:

```text
GroupAggregate  (actual time=4.030..4.033 rows=1 loops=1)
  Buffers: shared hit=153
    ->  Seq Scan on manager_profile mp  (actual time=0.085..0.085 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur.role_id)
                        Index Cond: (id = rp.permission_id)
          Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                              Hash Cond: (rp_2.permission_id = p_2.id)
                              Index Cond: (id = rp_2.role_id)
                        Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_2.role_id))
                              Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                              Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                        Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                      Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                            Index Cond: (role_id = ur_1.role_id)
                                Index Cond: (id = rp_1.permission_id)
    ->  Seq Scan on manager_profile mp_2  (actual time=0.041..0.041 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
...
Planning Time: 3.205 ms
Execution Time: 4.252 ms
```

### Q7: SELECT count(*)::int AS count FROM "core"."job_offer" o JOIN "core"."shift_assignment" sa ...

Calls in the capture run: 46. Slowest captured (0.3x load, JIT on): 2379 ms, of which JIT 327 ms. Replayed idle, median of 3: JIT on 271.5 ms, JIT off 255.8 ms, JIT off with the index fix 249.2 ms.

<details><summary>Statement</summary>

```sql
SELECT count(*)::int AS count FROM "core"."job_offer" o
           JOIN "core"."shift_assignment" sa ON sa.id = o.shift_assignment_id
           JOIN "core"."shift" s ON s.id = sa.shift_id
           JOIN "core"."venue" v ON v.id = s.venue_id
           JOIN "core"."job_role" jr ON jr.id = s.job_role_id
           JOIN "core"."staff_profile" sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
         WHERE o.created_by = $1
```

Parameters: ["9485f486-77af-4e50-8bf1-50b04af32832"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Aggregate  (actual time=254.956..254.972 rows=1 loops=1)
  Buffers: shared hit=10300
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Nested Loop  (actual time=143.524..251.534 rows=119583 loops=1)
        Buffers: shared hit=10300
        ->  Seq Scan on job_role jr  (actual time=34.304..34.305 rows=1 loops=1)
              Buffers: shared hit=1
        ->  Hash Join  (actual time=109.212..210.064 rows=119583 loops=1)
              Hash Cond: (s.venue_id = v.id)
              Buffers: shared hit=10299
              ->  Hash Join  (actual time=109.151..199.352 rows=119583 loops=1)
                    Hash Cond: (sa.shift_id = s.id)
                    Buffers: shared hit=10297
                    ->  Hash Join  (actual time=81.145..153.538 rows=119583 loops=1)
                          Hash Cond: (sa.id = o.shift_assignment_id)
                          Buffers: shared hit=7535
                          ->  Seq Scan on shift_assignment sa  (actual time=0.018..54.849 rows=119585 loops=1)
                                Buffers: shared hit=3489
                          ->  Hash  (actual time=81.043..81.051 rows=119583 loops=1)
                                Buffers: shared hit=4046
                                ->  Hash Join  (actual time=6.618..72.907 rows=119583 loops=1)
                                      Hash Cond: (sp.user_id = u.id)
...
Planning Time: 3.514 ms
JIT:
  Functions: 173
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 8.253 ms, Inlining 0.000 ms, Optimization 2.599 ms, Emission 31.932 ms, Total 42.784 ms
Execution Time: 263.463 ms
```

Same statement, JIT off, with the index fix:

```text
Aggregate  (actual time=249.018..249.035 rows=1 loops=1)
  Buffers: shared hit=10300
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Nested Loop  (actual time=113.619..245.497 rows=119583 loops=1)
        Buffers: shared hit=10300
        ->  Seq Scan on job_role jr  (actual time=0.004..0.005 rows=1 loops=1)
              Buffers: shared hit=1
        ->  Hash Join  (actual time=113.612..237.653 rows=119583 loops=1)
              Hash Cond: (s.venue_id = v.id)
              Buffers: shared hit=10299
              ->  Hash Join  (actual time=113.588..227.131 rows=119583 loops=1)
                    Hash Cond: (sa.shift_id = s.id)
                    Buffers: shared hit=10297
                    ->  Hash Join  (actual time=82.541..175.467 rows=119583 loops=1)
                          Hash Cond: (sa.id = o.shift_assignment_id)
                          Buffers: shared hit=7535
                          ->  Seq Scan on shift_assignment sa  (actual time=0.010..66.946 rows=119585 loops=1)
                                Buffers: shared hit=3489
...
Planning Time: 3.126 ms
Execution Time: 249.178 ms
```

### Q8: SELECT status, count(*)::int AS n FROM "core"."payroll_record" WHERE organisation_id = $1 ...

Calls in the capture run: 3. Slowest captured (0.3x load, JIT on): 1989 ms, of which JIT 1921 ms. Replayed idle, median of 3: JIT on 845.9 ms, JIT off 26.5 ms, JIT off with the index fix 32.3 ms.

<details><summary>Statement</summary>

```sql
SELECT status, count(*)::int AS n FROM "core"."payroll_record" WHERE organisation_id = $1 AND workspace_id = $2 GROUP BY status
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","efc16b22-5bb5-4f92-a818-d96a25821c90"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
GroupAggregate  (actual time=836.759..839.235 rows=2 loops=1)
  Buffers: shared hit=1229 read=3198 written=1
    ->  Seq Scan on manager_profile mp  (actual time=0.314..0.317 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur.role_id)
                        Index Cond: (id = rp.permission_id)
  ->  Result  (actual time=811.394..835.822 rows=89776 loops=1)
        Buffers: shared hit=1229 read=3198 written=1
        ->  Index Scan using payroll_record_workspace_status_idx on payroll_record  (actual time=0.394..20.254 rows=89776 loops=1)
              Index Cond: (workspace_id = 'efc16b22-5bb5-4f92-a818-d96a25821c90'::uuid)
              Buffers: shared hit=1229 read=3198 written=1
                      Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                          Hash Cond: (rp_2.permission_id = p_2.id)
                                          Index Cond: (id = rp_2.role_id)
                                    Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_2.role_id))
                                          Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                          Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                                    Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                                  Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                                        Index Cond: (role_id = ur_1.role_id)
                                            Index Cond: (id = rp_1.permission_id)
  Buffers: shared hit=56
...
Planning Time: 2.475 ms
JIT:
  Functions: 270
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 11.265 ms, Inlining 12.145 ms, Optimization 438.933 ms, Emission 359.914 ms, Total 822.258 ms
Execution Time: 850.882 ms
```

Same statement, JIT off, with the index fix:

```text
GroupAggregate  (actual time=24.001..26.360 rows=2 loops=1)
  Buffers: shared hit=4427
    ->  Seq Scan on manager_profile mp  (actual time=0.090..0.093 rows=1 loops=1)
          Buffers: shared hit=2
                              Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                    Index Cond: (role_id = ur.role_id)
                        Index Cond: (id = rp.permission_id)
  ->  Result  (actual time=0.097..22.366 rows=89776 loops=1)
        Buffers: shared hit=4427
        ->  Index Scan using payroll_record_workspace_status_idx on payroll_record  (actual time=0.096..17.790 rows=89776 loops=1)
              Index Cond: (workspace_id = 'efc16b22-5bb5-4f92-a818-d96a25821c90'::uuid)
              Buffers: shared hit=4427
                      Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                          Hash Cond: (rp_2.permission_id = p_2.id)
                                          Index Cond: (id = rp_2.role_id)
                                    Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_2.role_id))
                                          Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                          Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                                    Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                                  Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
...
Planning Time: 2.234 ms
Execution Time: 26.545 ms
```

### Q9: SELECT sp.id AS staff_profile_id, u.first_name, u.last_name, sp.job_role_id, sp.available_...

Calls in the capture run: 12. Slowest captured (0.3x load, JIT on): 1731 ms, of which JIT 1431 ms. Replayed idle, median of 3: JIT on 792.8 ms, JIT off 191.9 ms, JIT off with the index fix 176.2 ms.

<details><summary>Statement</summary>

```sql
SELECT sp.id AS staff_profile_id, u.first_name, u.last_name, sp.job_role_id, sp.available_days, sp.other_skills,
          EXISTS (
            SELECT 1 FROM "core"."shift_assignment" sa2
            JOIN "core"."shift" s2 ON s2.id = sa2.shift_id
            WHERE sa2.staff_profile_id = sp.id AND sa2.status IN ('confirmed', 'completed') AND s2.venue_id = $2
          ) AS worked_venue_before,
          NOT EXISTS (
            -- period (a denormalised tstzrange snapshot) lives on
            -- shift_assignment itself, not shift -- matching the identical
            -- overlap check in OfferService.sendOne() (offer.service.ts),
            -- and the GiST exclusion constraint
            -- shift_assignment_no_double_booking it proactively mirrors.
            -- No join to shift is needed for this check at all.
            SELECT 1 FROM "core"."shift_assignment" sa3
            WHERE sa3.staff_profile_id = sp.id AND sa3.status IN ('confirmed', 'completed') AND sa3.period && $3::tstzrange
          ) AS no_overlap,
          NOT EXISTS (
            SELECT 1 FROM "core"."shift_assignment" sa4 WHERE sa4.staff_profile_id = sp.id AND sa4.shift_id = $1
          ) AS not_already_offered,
          (SELECT count(*) FROM "core"."shift_assignment" sa5 WHERE sa5.staff_profile_id = sp.id AND sa5.status IN ('offered', 'staff_accepted', 'confirmed')) AS pending_commitments
        FROM "core"."staff_profile" sp
        JOIN core."user" u ON u.id = sp.user_id
        WHERE sp.organisation_id = $4
          AND sp.employment_status = $5
          AND u.status = $6
          AND sp.id != $7
```

Parameters: ["33f59696-6231-47d0-a8b7-67fe6b0fd703","dbc7bd63-f0e2-402d-9c14-2b3dfa33f7f6","[\"2026-11-24 22:30:28.8+00\",\"2026-11-25 04:30:28.8+00\")","ef920cad-69ce-4287-bc07-79eed68f7cc8","active","active","d5e49354-9eef-48b6-910a-3c67201997ac"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Result  (actual time=770.261..816.453 rows=5002 loops=1)
  Buffers: shared hit=69900
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Hash Join  (actual time=9.473..14.450 rows=5002 loops=1)
        Hash Cond: (sp.user_id = u.id)
        Buffers: shared hit=379
        ->  Seq Scan on staff_profile sp  (actual time=7.255..11.134 rows=5004 loops=1)
              Rows Removed by Filter: 5
              Buffers: shared hit=135
                                  Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                  Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                            Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                ->  Seq Scan on manager_profile mp  (actual time=7.063..7.068 rows=1 loops=1)
                      Rows Removed by Filter: 8
                      Buffers: shared hit=2
                                          Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                                Index Cond: (role_id = ur.role_id)
                                    Index Cond: (id = rp.permission_id)
        ->  Hash  (actual time=2.202..2.202 rows=5006 loops=1)
              Buffers: shared hit=244
              ->  Seq Scan on "user" u  (actual time=0.011..1.837 rows=5006 loops=1)
                    Rows Removed by Filter: 12
...
Planning Time: 1.820 ms
JIT:
  Functions: 181
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 9.299 ms, Inlining 24.157 ms, Optimization 369.924 ms, Emission 272.190 ms, Total 675.570 ms
Execution Time: 825.726 ms
```

Same statement, JIT off, with the index fix:

```text
Result  (actual time=122.823..170.064 rows=5002 loops=1)
  Buffers: shared hit=69900
                      Hash Cond: (rp_1.permission_id = p_1.id)
                      Index Cond: (id = rp_1.role_id)
                Index Cond: ((user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid) AND (role_id = rp_1.role_id))
  ->  Hash Join  (actual time=2.625..7.944 rows=5002 loops=1)
        Hash Cond: (sp.user_id = u.id)
        Buffers: shared hit=379
        ->  Seq Scan on staff_profile sp  (actual time=0.120..4.114 rows=5004 loops=1)
              Rows Removed by Filter: 5
              Buffers: shared hit=135
                                  Index Cond: (shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                                  Index Cond: (staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid)
                            Index Cond: (id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid)
                ->  Seq Scan on manager_profile mp  (actual time=0.103..0.107 rows=1 loops=1)
                      Rows Removed by Filter: 8
                      Buffers: shared hit=2
                                          Index Cond: (user_id = (NULLIF(current_setting('rab.user_id'::text, true), ''::text))::uuid)
                                                Index Cond: (role_id = ur.role_id)
                                    Index Cond: (id = rp.permission_id)
...
Planning Time: 1.805 ms
Execution Time: 170.391 ms
```

### Q10: WITH base AS ( SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, ...

Calls in the capture run: 9. Slowest captured (0.3x load, JIT on): 1172 ms, of which JIT 136 ms. Replayed idle, median of 3: JIT on 174.7 ms, JIT off 155.3 ms, JIT off with the index fix 128.2 ms.

<details><summary>Statement</summary>

```sql
WITH base AS (
  SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, s.required_count, s.filled_count,
    v.name AS venue_name, jr.name AS role_name,
    COALESCE(sr.status, 'pending') AS report_status, sr.final_pdf_sent_at AS final_queued_at, sr.final_file_id,
    count(sa.id) AS staff_count,
    count(sa.id) FILTER (WHERE sa.status = 'no_show') AS no_shows,
    count(a.id) FILTER (WHERE a.status IN ('clocked_in','on_break')) AS open_attendance,
    count(a.id) AS any_attendance,
    count(a.id) FILTER (WHERE a.clock_out_at IS NOT NULL) AS clocked_out,
    count(sa.id) FILTER (WHERE sa.status <> 'no_show' AND a.clock_out_at IS NULL) AS unresolved,
    count(sa.id) FILTER (WHERE sa.attendance_reviewed_at IS NULL) AS unreviewed
  FROM "core"."shift" s
  JOIN "core"."venue" v ON v.id = s.venue_id
  JOIN "core"."job_role" jr ON jr.id = s.job_role_id
  LEFT JOIN "core"."shift_assignment" sa ON sa.shift_id = s.id AND sa.status IN ('confirmed','completed','no_show')
  LEFT JOIN "core"."attendance" a ON a.shift_assignment_id = sa.id
  LEFT JOIN "core"."shift_report" sr ON sr.shift_id = s.id
  WHERE s.organisation_id = $1 AND s.venue_id = ANY($2::uuid[])
    AND s.status NOT IN ('draft','pending_manager_approval','declined')
  GROUP BY s.id, v.name, jr.name, sr.id
), rows AS (
  SELECT b.*, d.* FROM base b
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE eo.status IN ('PENDING','QUEUED','PROCESSING','RETRY')) AS d_pending,
  count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent, count(*) FILTER (WHERE eo.status = 'FAILED') AS d_failed, max(eo.sent_at) AS d_last_sent_at FROM core.email_outbox eo
    WHERE b.final_file_id IS NOT NULL AND eo.attachment_file_id = b.final_file_id AND eo.status <> 'CANCELLED') d ON true
)
        SELECT r.*, now() AS db_now, count(*) OVER () AS total FROM rows r
        WHERE (NOT (CASE WHEN (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) THEN now() >= r.d_last_sent_at + interval '5 hours'
  ELSE now() >= r.ends_at + interval '5 hours' END) OR (r.shift_status <> 'cancelled' AND NOT (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) AND (now() >= r.ends_at + interval '5 hours'
  OR (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND (r.d_failed > 0 OR r.d_sent = 0)))))
        ORDER BY (r.shift_status <> 'cancelled' AND NOT (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0) AND (now() >= r.ends_at + interval '5 hours'
  OR (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND (r.d_failed > 0 OR r.d_sent = 0)))) DESC, r.starts_at ASC, r.shift_id
        LIMIT $3 OFFSET $4
```

Parameters: ["ef920cad-69ce-4287-bc07-79eed68f7cc8","{20039ce6-b29b-406c-82e0-8ff59ee83d78}","20","0"]

</details>

EXPLAIN (ANALYZE, BUFFERS), JIT on (as captured):

```text
Limit  (actual time=158.651..158.664 rows=20 loops=1)
  Buffers: shared hit=80261
  ->  Sort  (actual time=134.566..134.577 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 34kB
        Buffers: shared hit=80261
        ->  WindowAgg  (actual time=133.125..133.677 rows=3386 loops=1)
              Buffers: shared hit=80261
              ->  Nested Loop Left Join  (actual time=102.455..132.187 rows=3386 loops=1)
                    Buffers: shared hit=80261
                    ->  HashAggregate  (actual time=102.361..103.343 rows=3386 loops=1)
                          Buffers: shared hit=28626
                          ->  Result  (actual time=29.246..99.931 rows=5979 loops=1)
                                Buffers: shared hit=28626
                                ->  Hash Join  (actual time=29.232..99.557 rows=5979 loops=1)
                                      Hash Cond: (s.venue_id = v.id)
                                      Buffers: shared hit=28626
                                      ->  Nested Loop Left Join  (actual time=29.182..98.876 rows=5979 loops=1)
                                            Buffers: shared hit=28624
                                            ->  Hash Right Join  (actual time=29.154..88.805 rows=5979 loops=1)
                                                  Hash Cond: (sa.shift_id = s.id)
                                                  Buffers: shared hit=8476
                                                  ->  Seq Scan on shift_assignment sa  (actual time=0.017..52.703 rows=103839 loops=1)
                                                        Rows Removed by Filter: 15746
                                                        Buffers: shared hit=3489
...
Planning Time: 1.299 ms
JIT:
  Functions: 71
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 6.063 ms, Inlining 0.000 ms, Optimization 1.982 ms, Emission 22.149 ms, Total 30.193 ms
Execution Time: 165.006 ms
```

Same statement, JIT off, with the index fix:

```text
Limit  (actual time=128.109..128.121 rows=20 loops=1)
  Buffers: shared hit=30871
  ->  Sort  (actual time=128.107..128.118 rows=20 loops=1)
        Sort Method: top-N heapsort  Memory: 34kB
        Buffers: shared hit=30871
        ->  WindowAgg  (actual time=126.711..127.278 rows=3386 loops=1)
              Buffers: shared hit=30871
              ->  Nested Loop Left Join  (actual time=122.788..125.805 rows=3386 loops=1)
                    Buffers: shared hit=30871
                    ->  HashAggregate  (actual time=122.770..123.749 rows=3386 loops=1)
                          Buffers: shared hit=28626
                          ->  Result  (actual time=29.649..120.383 rows=5979 loops=1)
                                Buffers: shared hit=28626
                                ->  Hash Join  (actual time=29.647..119.943 rows=5979 loops=1)
                                      Hash Cond: (s.venue_id = v.id)
                                      Buffers: shared hit=28626
                                      ->  Nested Loop Left Join  (actual time=29.624..119.193 rows=5979 loops=1)
                                            Buffers: shared hit=28624
                                            ->  Hash Right Join  (actual time=29.610..105.971 rows=5979 loops=1)
                                                  Hash Cond: (sa.shift_id = s.id)
...
Planning Time: 1.180 ms
Execution Time: 128.237 ms
```
