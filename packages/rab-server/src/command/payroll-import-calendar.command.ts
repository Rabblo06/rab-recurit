import { readFileSync } from 'node:fs';
import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { organisationIds } from '../engine/worker-shared/maintenance-catalogue';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { OFFICIAL_CALENDAR_2026 } from '../modules/payroll/constants/official-calendar-2026';
import { ImportCalendarDto } from '../modules/payroll/dto/payroll-runs.dto';
import { CalendarValidationReport, PayrollCalendarService } from '../modules/payroll/services/payroll-calendar.service';

interface Options { org?: string; actor?: string; official2026?: boolean; file?: string; dryRun?: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CalendarImportOutcome =
  | { ok: true; applied: boolean; version: number | null; report: CalendarValidationReport }
  | { ok: false; message: string };

/**
 * The command's whole logic, runnable on the RUNTIME role (`crewflow_app`) with RLS fully in force — no owner
 * connection, no bypass:
 *  1. Organisation: a uuid is bound directly; a slug is resolved by walking the existing pre-auth routing list
 *     (`core.worker_list_organisations`, SECURITY DEFINER, ids only) and reading each candidate's own row inside ITS
 *     tenant context (`organisation_self` RLS) until the slug matches.
 *  2. Actor: read inside the organisation's tenant context (`user_select` RLS), then the Initial Manager designation from
 *     the actor's own `manager_profile` row with the actor's identity bound (`manager_profile_tenant` RLS).
 *  3. Import: `PayrollCalendarService.import` with the actor's context — the same permission, Initial-Manager, validation,
 *     versioning, RLS and audit path as `POST /rest/v1/payroll/calendar/import`.
 */
export async function executeCalendarImport(
  deps: { dataSource: DataSource; tenantContext: TenantContextService; calendars: PayrollCalendarService },
  options: Options,
): Promise<CalendarImportOutcome> {
  if (!options.org || !options.actor || (!options.official2026 && !options.file)) {
    return { ok: false, message: 'Usage: payroll:import-calendar --org <slug|id> --actor <email> (--official-2026 | --file <path>) [--dry-run]' };
  }
  const orgId = await resolveOrganisation(deps, options.org);
  if (!orgId) return { ok: false, message: 'No such organisation.' };

  const bootstrap = { organisationId: orgId, workspaceId: null, userId: '', role: '' } as AuthContext;
  const [actor] = await deps.tenantContext.runInTenantContext(bootstrap, (m) => m.query<Array<{ id: string }>>(
    `SELECT id FROM core."user" WHERE organisation_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL`, [orgId, options.actor]));
  if (!actor) return { ok: false, message: 'No such manager in that organisation.' };
  const ctx = { organisationId: orgId, workspaceId: null, userId: actor.id, role: '' } as AuthContext;
  const isInitial = await deps.tenantContext.runInTenantContext(ctx, (m) => deps.calendars.isInitialManager(m, ctx));
  // Owner decision 2026-10-21: only the organisation's current Initial Manager imports or replaces the calendar. The
  // service (and RLS) re-check this; refusing here gives the operator a clear message before anything runs.
  if (!isInitial) return { ok: false, message: "Refused: --actor must be the organisation's current Initial Manager." };

  const source = options.official2026 ? OFFICIAL_CALENDAR_2026 : JSON.parse(readFileSync(options.file!, 'utf8'));
  const dto = Object.assign(new ImportCalendarDto(), {
    year: source.year, source: source.source, notes: source.notes ?? undefined, dryRun: !!options.dryRun,
    periods: source.periods.map((p: { start: string; end: string; payday: string; note?: string | null; needsConfirmation?: boolean }) => ({
      start: p.start, end: p.end, payday: p.payday, note: p.note ?? undefined, needsConfirmation: p.needsConfirmation ?? false,
    })),
  });
  const result = await deps.calendars.import(ctx, dto);
  return { ok: true, applied: result.applied, version: result.calendar?.version ?? null, report: result.report };
}

async function resolveOrganisation(deps: { dataSource: DataSource; tenantContext: TenantContextService }, org: string): Promise<string | null> {
  const lookup = (id: string) => deps.tenantContext.runInTenantContext(
    { organisationId: id, workspaceId: null, userId: '', role: '' } as AuthContext,
    (m) => m.query<Array<{ id: string }>>(`SELECT id FROM core.organisation WHERE id = $1 AND (slug = $2 OR id::text = $2)`, [id, org]),
  );
  if (UUID.test(org)) return (await lookup(org.toLowerCase()))[0]?.id ?? null;
  for await (const id of organisationIds(deps.dataSource)) {
    const [row] = await lookup(id);
    if (row) return row.id;
  }
  return null;
}

/**
 * Loads an agency payment calendar for ONE organisation (see `executeCalendarImport`). Never runs automatically.
 *
 *   command payroll:import-calendar --org <slug|id> --actor <email> --official-2026 [--dry-run]
 *   command payroll:import-calendar --org <slug|id> --actor <email> --file calendar.json [--dry-run]
 */
@Command({ name: 'payroll:import-calendar', description: 'Import an agency payment calendar for one organisation (versioned, audited)' })
export class PayrollImportCalendarCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly calendars: PayrollCalendarService,
  ) {
    super();
  }

  @Option({ flags: '-o, --org <slugOrId>', description: 'Organisation slug or id (required)' })
  parseOrg(v: string): string { return v; }

  @Option({ flags: '-a, --actor <email>', description: 'Email of the organisation Initial Manager the import is attributed to (required)' })
  parseActor(v: string): string { return v; }

  @Option({ flags: '--official-2026', description: 'Load the published "Adolphus Recruitment Calendar of Payment 2026"' })
  parseOfficial(): boolean { return true; }

  @Option({ flags: '-f, --file <path>', description: 'JSON file: { year, source, notes?, periods: [{ start, end, payday, note?, needsConfirmation? }] }' })
  parseFile(v: string): string { return v; }

  @Option({ flags: '--dry-run', description: 'Validate and report only' })
  parseDryRun(): boolean { return true; }

  async run(_params: string[], options: Options): Promise<void> {
    const outcome = await executeCalendarImport({ dataSource: this.dataSource, tenantContext: this.tenantContext, calendars: this.calendars }, options);
    if (!outcome.ok) {
      console.error(outcome.message);
      process.exit(1);
    }
    console.log(JSON.stringify({ applied: outcome.applied, version: outcome.version, report: outcome.report }, null, 2));
  }
}
