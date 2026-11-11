import { expect, test } from '@playwright/test';

// The idle-window classifier shared by run-system.sh `idle` and the cost harness (cost/lib/sql-families.js). Plain
// CommonJS, so it is required, not imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { family, summarize } = require('../../cost/lib/sql-families.js') as {
  family: (q: string) => string;
  summarize: (rows: Row[], seconds: number, harnessRoles?: string[]) => any;
};

interface Row {
  role: string;
  toplevel: boolean;
  calls: number;
  ms: number;
  query: string;
}

/**
 * Statement texts as pg_stat_statements records them on an owner-login stack (one crewflow_owner login for the API and the
 * Worker; nested SECURITY DEFINER statements as rab_secure_owner). Shapes taken from an idle O20 window of the 4c38aa1a
 * image (Phase X0 XP §1.3); synthetic, no data.
 */
const ROWS: Row[] = [
  { role: 'crewflow_owner', toplevel: true, calls: 3197, ms: 10, query: 'RESET ROLE' },
  { role: 'crewflow_owner', toplevel: true, calls: 1656, ms: 5, query: 'COMMIT' },
  { role: 'crewflow_owner', toplevel: true, calls: 1656, ms: 5, query: 'START TRANSACTION' },
  { role: 'crewflow_owner', toplevel: true, calls: 1520, ms: 5, query: 'SELECT set_config($2, $1, $3)' },
  { role: 'crewflow_owner', toplevel: true, calls: 1496, ms: 5, query: 'SET TRANSACTION READ ONLY' },
  { role: 'crewflow_owner', toplevel: true, calls: 960, ms: 47, query: 'SELECT id, organisation_id, workspace_id, statement_status FROM payroll_record WHERE status IN ($1,$2,$3)' },
  { role: 'crewflow_owner', toplevel: true, calls: 160, ms: 3, query: 'SELECT id, organisation_id, status FROM core.email_outbox WHERE status = $1' },
  { role: 'crewflow_owner', toplevel: true, calls: 136, ms: 180, query: 'SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)' },
  { role: 'rab_secure_owner', toplevel: false, calls: 136, ms: 100, query: 'SELECT mw.id, mw.organisation_id FROM core.manager_workspace mw WHERE (p_after IS NULL OR mw.id > p_after)' },
  { role: 'crewflow_owner', toplevel: true, calls: 80, ms: 4, query: 'SELECT id AS offer_id, organisation_id, workspace_id FROM job_offer WHERE status = $1 AND expires_at < now()' },
  { role: 'crewflow_owner', toplevel: true, calls: 76, ms: 1, query: 'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked' },
  { role: 'crewflow_owner', toplevel: true, calls: 20, ms: 1, query: 'SELECT id, organisation_id, workspace_id FROM attendance WHERE workspace_id IS NOT NULL' },
  { role: 'crewflow_owner', toplevel: true, calls: 20, ms: 1, query: 'SELECT s.id AS shift_id FROM shift s LEFT JOIN shift_report sr ON sr.shift_id = s.id' },
  { role: 'crewflow_owner', toplevel: true, calls: 4, ms: 9, query: 'SELECT * FROM core.worker_claim_due_work($1, $2, $3)' },
  // The API's health ping, as pg_stat_statements normalises it.
  { role: 'crewflow_owner', toplevel: true, calls: 48, ms: 1, query: 'SELECT $1' },
  // The in-process provisioner runs on a crewflow_owner session after SET ROLE: recorded under `crewflow`.
  { role: 'crewflow', toplevel: true, calls: 24, ms: 1, query: 'SELECT workspace_id FROM core.worker_list_pending_workspace_schemas($1)' },
  { role: 'crewflow_owner', toplevel: true, calls: 2, ms: 1, query: 'SELECT something_new FROM some_new_table' },
  // The harness's own reset/dump: never counted.
  { role: 'rab', toplevel: true, calls: 1, ms: 1, query: 'select pg_stat_statements_reset()' },
];

test('each Worker scan, the framing and the API health ping get their own family', () => {
  expect(family('RESET ROLE')).toBe('framing');
  expect(family('SET TRANSACTION READ ONLY')).toBe('framing');
  expect(family('SELECT set_config($6, $1, $7), set_config($8, $2, $9)')).toBe('framing');
  expect(family('SELECT 1')).toBe('api-health-ping');
  expect(family('SELECT $1')).toBe('api-health-ping');
  expect(family('SELECT workspace_id FROM core.worker_list_pending_workspace_schemas($1)')).toBe('provisioner');
  expect(family('SELECT id FROM payroll_record WHERE status IN ($1)')).toBe('statement-dispatch');
  expect(family('SELECT id FROM core.email_outbox')).toBe('email-outbox');
  expect(family('SELECT * FROM core.worker_claim_due_work($1, $2, $3)')).toBe('timer-triggers');
  expect(family('SELECT workspace_id FROM core.worker_list_workspaces($1::uuid, $2::integer)')).toBe('workspace-discovery');
  expect(family('SELECT something_new FROM some_new_table')).toBe('other');
});

test('summary counts the application top-level rows (SET ROLE included); nested definer rows and the harness are separate', () => {
  const s = summarize(ROWS, 240);
  const top = ROWS.filter((r) => r.toplevel && r.role !== 'rab').reduce((n, r) => n + r.calls, 0);
  expect(s.topLevelCalls).toBe(top);
  expect(s.topLevelByRole.crewflow.calls).toBe(24);
  expect(s.topLevelByRole.rab).toBeUndefined();
  expect(s.families.provisioner.calls).toBe(24);
  expect(s.topLevelPerMin).toBe(+(top / 4).toFixed(1));
  expect(s.nestedDefinerPerMin).toBe(34); // 136 / 4 min, rab_secure_owner only (the harness's `rab` row excluded)
  expect(s.apiHealthPingPerMin).toBe(12);
  expect(s.workerScanUpperBoundPerMin).toBe(+((top - 48) / 4).toFixed(1));
  expect(s.families['statement-dispatch'].calls).toBe(960);
  expect(s.families.framing.calls).toBe(3197 + 1656 + 1656 + 1520 + 1496);
  // A statement no rule knows is listed, never folded silently into a scan.
  expect(s.unclassified).toEqual([{ role: 'crewflow_owner', calls: 2, query: 'SELECT something_new FROM some_new_table' }]);
});

test('the harness roles are configurable (a cluster whose superuser has another name)', () => {
  const rows = [...ROWS, { role: 'ci_bootstrap', toplevel: true, calls: 7, ms: 1, query: 'select pg_stat_statements_reset()' }];
  expect(summarize(rows, 240, ['rab', 'ci_bootstrap']).topLevelCalls).toBe(summarize(ROWS, 240).topLevelCalls);
});
