import { PermissionFlag, ShiftStatus, UserStatus, VenueStatus } from '@rab/shared';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService, ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { MemberAccessPolicyService, ObjectAccessPolicy } from '../../identity/member-access/member-access-policy.service';
import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { SearchDto } from '../dto/search.dto';
import { isStatementTimeout, SearchTooBroadException } from '../exceptions/search.exceptions';
import { buildSearchQuery, SearchQuery } from './search-query';
import { offerReadScopeCondition } from '../../offer/services/offer.service';

export interface SearchResult {
  id: string;
  name: string;
  type: 'Staff' | 'Manager' | 'Shift' | 'Offer' | 'Venue';
  group: 'People' | 'Shifts' | 'Offers' | 'Venues';
  to: string;
}

const DEFAULT_LIMIT_PER_TYPE = 8;
const MAX_LIMIT_PER_TYPE = 20;
/**
 * M9 load test §4.4: the most candidates one match branch of the offer search may contribute before ranking. A term that
 * matches every record (every offer of the workspace: 119,581 in the test) was joined and ranked in full to return 20
 * (1.1-1.2 s, then the 5 s timeout under load). The branch stops after this many in-scope matches instead. A term with
 * fewer matches (any real name) is ranked exactly as before; a broader one is ranked over the first matches found.
 */
export const OFFER_SEARCH_CANDIDATE_CAP = 500;

/**
 * SQL fragments shared by every branch. They are SERVER CONSTANTS: the only client-derived values are bound parameters
 * ($1 = prefix tsquery terms, $2 = normalised text, $3 = escaped infix LIKE pattern, $4 = escaped prefix LIKE pattern).
 * The text-search configuration is a literal. Expressions match the indexed ones in ArchiveAndSearchSchema1786719920000
 * exactly (user_name_trgm_idx, venue_name_trgm_idx, job_role_name_trgm_idx, staff_profile_staff_ref_trgm_idx and the
 * `search_vector` GIN indexes), so the planner can use them; `public.` qualifies pg_trgm because the HWS search_path is
 * the workspace schema alone.
 */
const TSQ = `to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)))`;
const NORM_TEXT = `core.immutable_unaccent(lower($2))`;
const INFIX = `core.immutable_unaccent(lower($3))`;
const PREFIX = `core.immutable_unaccent(lower($4))`;
const userName = (u: string) => `core.immutable_unaccent(lower(${u}.first_name || ' ' || ${u}.last_name))`;
const venueName = (v: string) => `core.immutable_unaccent(lower(${v}.name))`;
/**
 * Every query references all four search parameters with an explicit type (PostgreSQL refuses an unreferenced
 * parameter whose type it cannot infer). A select-list column only — it never affects the WHERE clause or the plan.
 */
const PARAMS_ANCHOR = `($1::text IS NULL AND $2::text IS NULL AND $3::text IS NULL AND $4::text IS NULL) AS _params`;

/*
 * SF-6: every branch below applies the SAME scope predicate as the resource's own list (the list is the authority; search
 * may only ever be tighter, never looser), plus explicit `organisation_id` / `workspace_id` pins on top of RLS:
 *  - staff    - `StaffService.list()` (created_by = the scope owner) and, for a Venue Manager, `StaffService.venueDirectory()`
 *               (their saved team at their assigned venues, active accounts only);
 *  - managers - `ManagerService.list()` (organisation-wide);
 *  - venues   - `VenueService.list()` (assigned venues, or created_by = the scope owner);
 *  - shifts   - `SchedulingService.applyShiftReadScope()` with the pending-approval widening `list()` uses;
 *  - offers   - `offerReadScopeCondition()` itself, the one shared offer read scope.
 * Before SF-6 the owner branches keyed on `workspace_id` alone (created_by only for restricted members), so a row in the
 * caller's workspace created by someone else was searchable although every list hid it.
 */

/** Positional parameters: the four search params first, then whatever a branch appends. */
class Params {
  readonly values: unknown[];
  constructor(q: SearchQuery) {
    this.values = [q.tsquery, q.text, q.likePattern, q.likePattern.replace(/^%/, '')];
  }
  push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  get next(): number {
    return this.values.length + 1;
  }
}

/**
 * Wave 5 — ranked full-text search (tsvector + GIN, prefix terms, accent-insensitive via `core.immutable_unaccent`) with
 * a pg_trgm infix fallback for partial names and short identifiers (staff refs), replacing ILIKE-only matching.
 *
 * Authorisation is UNCHANGED and is not derived from the search: every resource type's WHERE clause mirrors the
 * IDENTICAL scoping its own `list()` enforces (staff / manager / venue / scheduling / offer services), plus RLS
 * underneath (indexes never bypass it). A type the caller lacks the view permission for is silently omitted. Archived
 * records (wave 5) are excluded like in the default lists. Hidden fields are never match targets:
 *  - staff email is matched (prefix only, never returned) ONLY when the caller's field policy shows `email`;
 *  - a venue's vector includes `client_name`, so it is used only when `clientName` is visible;
 *  - a shift's own vector (`notes`, `address`) is not searched at all (see searchShifts).
 * Ranking: exact (normalised) match first, then `ts_rank_cd`, then trigram similarity, then name, then id (stable).
 *
 * PERFORMANCE NOTE (benchmark, docs/evidence/w5-data/benchmark): for the runtime role the GIN / pg_trgm indexes are
 * NOT used — `@@`, `LIKE` and `similarity` are not LEAKPROOF, so PostgreSQL evaluates them after the RLS policy quals
 * (security barrier), i.e. as a filter over the tenant's rows. Turning JIT off for the search transaction is what
 * removes the multi-second cost; making the indexes usable needs an owner/DB decision (see WAVE5_LANE_DATA_REPORT.md).
 */
@Injectable()
export class SearchService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly permissions: PermissionsService,
  ) {}

  async search(ctx: AuthContext, dto: SearchDto): Promise<SearchResult[]> {
    const limit = Math.min(dto.limit ?? DEFAULT_LIMIT_PER_TYPE, MAX_LIMIT_PER_TYPE);
    const query = buildSearchQuery(dto.q);
    if (!query.tsquery) return [];

    try {
      return await this.runSearch(ctx, query, limit);
    } catch (error) {
      // M9 load test §4.4: the search's own statement_timeout (below) is a "too broad" answer, not a server error.
      if (isStatementTimeout(error)) throw new SearchTooBroadException();
      throw error;
    }
  }

  private runSearch(ctx: AuthContext, query: SearchQuery, limit: number): Promise<SearchResult[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Transaction-local (is_local = true): RLS policy functions inflate the planner's cost estimates far past
      // jit_above_cost, so JIT compilation (seconds) dwarfed the sub-second query itself in the 50k benchmark
      // (docs/evidence/w5-data/benchmark). A bounded statement_timeout keeps one search from holding a connection.
      await manager.query(`SELECT set_config('jit', 'off', true), set_config('statement_timeout', '5000', true)`);
      // W6-E2E-06: the four view-permission checks run in THIS transaction (same queries, same tenant context, same
      // answers as `userHasPermission`), instead of four extra parallel transactions per keystroke — each one held its own
      // pooled connection and repeated the tenant-context setup, which under load queued behind the search itself.
      const canViewStaff = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFF_VIEW);
      const canViewManagers = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.MANAGER_MANAGE);
      const canViewVenues = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_VIEW);
      const canViewSchedule = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.SCHEDULE_VIEW);
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      // Custom workspace-members: search is the same authorised data as the lists — object denial, record filters and
      // hidden fields (never a match target) all apply. No-op for everyone else.
      const staffPolicy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      const venuePolicy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
      const shiftPolicy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
      const delegated = scope.kind === 'owner' && scope.delegated;

      // Sequential on one connection (a transaction's queries are serialised anyway).
      const staff = canViewStaff && staffPolicy.canRead ? await this.searchStaff(manager, ctx, scope, query, limit, staffPolicy) : [];
      const managers = canViewManagers ? await this.searchManagers(manager, ctx, query, limit) : [];
      const shifts = canViewSchedule && shiftPolicy.canRead ? await this.searchShifts(manager, ctx, scope, query, limit, shiftPolicy, venuePolicy) : [];
      // Offers are not a workspace-member object (members' offer lists are empty too) — never searched for them.
      const offers = canViewSchedule && !delegated ? await this.searchOffers(manager, ctx, scope, query, limit) : [];
      const venues = canViewVenues && venuePolicy.canRead ? await this.searchVenues(manager, ctx, scope, query, limit, venuePolicy) : [];

      return [...staff, ...managers, ...shifts, ...offers, ...venues];
    }, { useReplica: true });
  }

  /** The custom workspace-member record filter, as the lists apply it (nothing at all when the caller is unrestricted). */
  private recordFilter(policy: ObjectAccessPolicy, alias: string, p: Params): string {
    if (!policy.restricted) return '';
    const filter = this.memberAccess.rawWhere(policy, alias, p.next);
    filter.positional.forEach((v) => p.push(v));
    return ` AND (${filter.sql})`;
  }

  private scopeVenueIds(scope: ResourceScope): string[] | null {
    return scope.kind === 'venue' ? scope.venueIds : null;
  }

  /** People (core."user" names) — FTS on the name vector, or trigram infix on the full name. */
  private userMatch(q: SearchQuery, u: string): string {
    return q.useInfix ? `(${u}.search_vector @@ ${TSQ} OR ${userName(u)} LIKE ${INFIX})` : `${u}.search_vector @@ ${TSQ}`;
  }

  /** Venue name (and client name when visible). */
  private venueMatch(q: SearchQuery, v: string, clientNameVisible: boolean): string {
    if (clientNameVisible) {
      return q.useInfix ? `(${v}.search_vector @@ ${TSQ} OR ${venueName(v)} LIKE ${INFIX})` : `${v}.search_vector @@ ${TSQ}`;
    }
    return `${venueName(v)} LIKE ${q.useInfix ? INFIX : PREFIX}`;
  }

  private async searchStaff(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    q: SearchQuery,
    limit: number,
    policy: ObjectAccessPolicy,
  ): Promise<SearchResult[]> {
    const t = businessTables(manager);
    const p = new Params(q);
    const org = p.push(ctx.organisationId);
    const ws = p.push(ctx.workspaceId);
    let extra: string;
    if (scope.kind === 'venue') {
      // StaffService.list() reads created_by = the caller for a Venue Manager; StaffService.venueDirectory() reads their
      // saved team (venue_manager_staff) at their assigned venues, active accounts only. Search is the union of the two.
      const self = p.push(ctx.userId);
      const venues = p.push(scope.venueIds);
      const active = p.push(UserStatus.ACTIVE);
      // sql-injection-reviewed: self / venues / active are $n placeholders returned by Params.push; the tables come from businessTables. Reviewed 2026-11-17.
      extra = ` AND (sp.created_by = ${self} OR (u.status = ${active} AND EXISTS (
            SELECT 1 FROM ${t.venue_manager_staff} vt
              JOIN core.manager_profile vmp ON vmp.id = vt.manager_profile_id
              JOIN ${t.venue} vv ON vv.workspace_id = vt.workspace_id
             WHERE vt.staff_profile_id = sp.id AND vmp.user_id = ${self} AND vv.id = ANY(${venues}::uuid[]))))`;
    } else {
      // StaffService.list(): created_by = the caller, or (custom workspace-member) their workspace owner. Always, not
      // only for restricted members.
      extra = ` AND sp.created_by = ${p.push(scope.ownerUserId)}`;
    }
    extra += this.recordFilter(policy, 'sp', p);
    const emailBranch =
      q.emailPrefix && this.memberAccess.isFieldVisible(policy, 'email')
        // sql-injection-reviewed: dynamic WHERE assembled only from literal fragments and $n / :named placeholders (values pushed to params); identifiers come from allow-lists. Reviewed 2026-11-04.
        ? `UNION SELECT sp.id FROM core."user" u JOIN ${t.staff_profile} sp ON sp.user_id = u.id WHERE u.email::text ILIKE ${p.push(q.emailPrefix)}`
        : '';
    const lim = p.push(limit);
    const rows = await manager.query(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `WITH cand AS (
         SELECT sp.id FROM core."user" u JOIN ${t.staff_profile} sp ON sp.user_id = u.id WHERE ${this.userMatch(q, 'u')}
         UNION
         SELECT sp.id FROM ${t.staff_profile} sp WHERE ${q.useInfix ? `(sp.search_vector @@ ${TSQ} OR lower(sp.staff_ref) LIKE lower($3))` : `sp.search_vector @@ ${TSQ}`}
         ${emailBranch}
       )
       SELECT sp.id, u.first_name, u.last_name,
              (n.full_name = ${NORM_TEXT} OR lower(sp.staff_ref) = lower($2)) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) + ts_rank_cd(sp.search_vector, ${TSQ}) AS rank,
              public.similarity(n.full_name, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM cand
         JOIN ${t.staff_profile} sp ON sp.id = cand.id
         JOIN core."user" u ON u.id = sp.user_id AND u.deleted_at IS NULL
         CROSS JOIN LATERAL (SELECT ${userName('u')} AS full_name) n
        WHERE sp.organisation_id = ${org} AND sp.workspace_id = ${ws} AND sp.archived_at IS NULL${extra}
        ORDER BY exact DESC, rank DESC, sim DESC, u.first_name ASC, u.last_name ASC, sp.id
        LIMIT ${lim}`,
      p.values,
    );
    return rows.map((r: { id: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      type: 'Staff' as const,
      group: 'People' as const,
      to: '/users',
    }));
  }

  private async searchManagers(manager: EntityManager, ctx: AuthContext, q: SearchQuery, limit: number): Promise<SearchResult[]> {
    const p = new Params(q);
    // ManagerService.list() is organisation-wide: the same explicit organisation pin (SF-6), RLS underneath.
    const org = p.push(ctx.organisationId);
    // MANAGER_MANAGE holders already see managers' emails in the list; prefix-only, and only for an email-like query.
    const emailBranch = q.emailPrefix ? `OR u.email::text ILIKE ${p.push(q.emailPrefix)}` : '';
    const lim = p.push(limit);
    const rows = await manager.query(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT mp.id, u.first_name, u.last_name,
              (${userName('u')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) AS rank,
              public.similarity(${userName('u')}, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM core.manager_profile mp
         JOIN core."user" u ON u.id = mp.user_id AND u.deleted_at IS NULL
        WHERE mp.organisation_id = ${org} AND (${this.userMatch(q, 'u')} ${emailBranch}) AND mp.archived_at IS NULL
        ORDER BY exact DESC, rank DESC, sim DESC, u.first_name ASC, u.last_name ASC, mp.id
        LIMIT ${lim}`,
      p.values,
    );
    return rows.map((r: { id: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      type: 'Manager' as const,
      group: 'People' as const,
      to: '/users',
    }));
  }

  private async searchVenues(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    q: SearchQuery,
    limit: number,
    policy: ObjectAccessPolicy,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    const t = businessTables(manager);
    const p = new Params(q);
    let where = `${this.venueMatch(q, 'v', this.memberAccess.isFieldVisible(policy, 'clientName'))}`;
    where += ` AND v.status <> ${p.push(VenueStatus.ARCHIVED)} AND v.archived_at IS NULL`;
    where += ` AND v.organisation_id = ${p.push(ctx.organisationId)}`;
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND v.id = ANY(${p.push(venueIds)}::uuid[])`;
    } else if (scope.kind === 'owner') {
      // VenueService.list(): created_by = the scope owner, always.
      where += ` AND v.workspace_id = ${p.push(ctx.workspaceId)} AND v.created_by = ${p.push(scope.ownerUserId)}`;
      where += this.recordFilter(policy, 'v', p);
    }
    const lim = p.push(limit);
    const rows = await manager.query(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT v.id, v.name,
              (${venueName('v')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(v.search_vector, ${TSQ}) AS rank,
              public.similarity(${venueName('v')}, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM ${t.venue} v
        WHERE ${where}
        ORDER BY exact DESC, rank DESC, sim DESC, v.name ASC, v.id
        LIMIT ${lim}`,
      p.values,
    );
    return rows.map((r: { id: string; name: string }) => ({
      id: r.id,
      name: r.name,
      type: 'Venue' as const,
      group: 'Venues' as const,
      to: '/venues',
    }));
  }

  private async searchShifts(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    q: SearchQuery,
    limit: number,
    policy: ObjectAccessPolicy,
    venuePolicy: ObjectAccessPolicy,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    const t = businessTables(manager);
    const p = new Params(q);
    // A shift's own vector (address + notes) is NOT a global-search target: under RLS its GIN index is unusable for the
    // runtime role (`@@` is not LEAKPROOF) and the full scan cost 250–500 ms per keystroke at 50k shifts (benchmark).
    const clientNameVisible = this.memberAccess.isFieldVisible(venuePolicy, 'clientName');
    let where = `s.archived_at IS NULL AND s.organisation_id = ${p.push(ctx.organisationId)}`;
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND s.venue_id = ANY(${p.push(venueIds)}::uuid[])`;
    } else if (scope.kind === 'owner') {
      where += ` AND s.workspace_id = ${p.push(ctx.workspaceId)}`;
      // SchedulingService.applyShiftReadScope() exactly as list() calls it (widenPendingApproval: true).
      if (scope.delegated) {
        where += ` AND s.created_by = ${p.push(scope.ownerUserId)}`;
        where += this.recordFilter(policy, 's', p);
      } else {
        where += ` AND (s.created_by = ${p.push(ctx.userId)} OR s.status = ${p.push(ShiftStatus.PENDING_MANAGER_APPROVAL)})`;
      }
    }
    const lim = p.push(limit);
    // Venue-driven: venues matched by FTS / trigram (accents, prefixes), then their shifts NEWEST FIRST exactly as before
    // wave 5 — ordering by date lets the planner stop after LIMIT rows (ranking every shift of every matched venue cost
    // ~150 ms at 50k shifts under RLS). Job-role names are not a global-search target for shifts (label = venue · date).
    const rows = await manager.query(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `WITH mv AS (
         SELECT v.id, (${venueName('v')} = ${NORM_TEXT}) AS exact, ts_rank_cd(v.search_vector, ${TSQ}) AS rank
           FROM ${t.venue} v WHERE ${this.venueMatch(q, 'v', clientNameVisible)}
       )
       SELECT s.id, v.name AS venue_name, s.starts_at, mv.exact, mv.rank, ${PARAMS_ANCHOR}
         FROM mv
         JOIN ${t.shift} s ON s.venue_id = mv.id
         JOIN ${t.venue} v ON v.id = s.venue_id
        WHERE ${where}
        ORDER BY s.starts_at DESC, s.id
        LIMIT ${lim}`,
      p.values,
    );
    return rows.map((r: { id: string; venue_name: string; starts_at: Date }) => ({
      id: r.id,
      name: `${r.venue_name} · ${new Date(r.starts_at).toLocaleDateString('en-GB')}`,
      type: 'Shift' as const,
      group: 'Shifts' as const,
      to: '/shifts',
    }));
  }

  private async searchOffers(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    q: SearchQuery,
    limit: number,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    const t = businessTables(manager);
    const p = new Params(q);
    // OfferService.list()'s own scope condition (assigned venues, or offers the caller sent), plus organisation / workspace pins.
    let where = `o.organisation_id = ${p.push(ctx.organisationId)} AND ${offerReadScopeCondition(scope, ctx, (v) => p.push(v))}`;
    if (scope.kind === 'owner') where += ` AND o.workspace_id = ${p.push(ctx.workspaceId)}`;
    const cap = p.push(OFFER_SEARCH_CANDIDATE_CAP);
    const lim = p.push(limit);
    // Each match branch applies the SAME scope as the final query and stops after `cap` matches (M9 §4.4), so the cap can
    // never fill up with rows the caller could not see. Joined like the final query (an offer without its assignment,
    // shift, venue, profile or user was never a result), so the candidates are the result rows, just bounded.
    const branch = (match: string) =>
      // sql-injection-reviewed: tables from businessTables; `where` / `match` are code-constant fragments with $n placeholders (values pushed to params); `cap` is a $n placeholder.
      `SELECT o.id FROM ${t.job_offer} o
           JOIN ${t.shift_assignment} sa ON sa.id = o.shift_assignment_id
           JOIN ${t.shift} s ON s.id = sa.shift_id
           JOIN ${t.venue} v ON v.id = s.venue_id
           JOIN ${t.staff_profile} sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
          WHERE ${where} AND ${match}
          LIMIT ${cap}`;
    const rows = await manager.query(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `WITH cand AS (
         (${branch(this.userMatch(q, 'u'))})
         UNION
         (${branch(this.venueMatch(q, 'v', true))})
       )
       SELECT o.id, v.name AS venue_name, u.first_name, u.last_name,
              (${userName('u')} = ${NORM_TEXT} OR ${venueName('v')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) + ts_rank_cd(v.search_vector, ${TSQ}) AS rank, ${PARAMS_ANCHOR}
         FROM cand
         JOIN ${t.job_offer} o ON o.id = cand.id
         JOIN ${t.shift_assignment} sa ON sa.id = o.shift_assignment_id
         JOIN ${t.shift} s ON s.id = sa.shift_id
         JOIN ${t.venue} v ON v.id = s.venue_id
         JOIN ${t.staff_profile} sp ON sp.id = o.staff_profile_id
         JOIN core."user" u ON u.id = sp.user_id
        WHERE ${where}
        ORDER BY exact DESC, rank DESC, o.sent_at DESC, o.id
        LIMIT ${lim}`,
      p.values,
    );
    return rows.map((r: { id: string; venue_name: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name} → ${r.venue_name}`,
      type: 'Offer' as const,
      group: 'Offers' as const,
      to: '/offers',
    }));
  }
}

// Exported for the unit spec only (the SQL fragments are server constants — asserting they never embed input).
export const SEARCH_SQL_FRAGMENTS = { TSQ, NORM_TEXT, INFIX, PREFIX } as const;
