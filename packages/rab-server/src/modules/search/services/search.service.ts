import { PermissionFlag, VenueStatus } from '@rab/shared';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService, ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { MemberAccessPolicyService, ObjectAccessPolicy } from '../../identity/member-access/member-access-policy.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { SearchDto } from '../dto/search.dto';
import { buildSearchQuery, SearchQuery } from './search-query';

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

// Step 7 (Private Workspace migration): the `owner` scope's real boundary is `workspace_id`, matching the DB-level RLS
// dimension exactly — see `dashboard.service.ts`'s identical constant for the full rationale.
function ownerWorkspacePredicate(workspaceCol: string, paramIdx: number): string {
  return `${workspaceCol} = $${paramIdx}`;
}

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

    const [canViewStaff, canViewManagers, canViewVenues, canViewSchedule] = await Promise.all([
      this.permissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE),
      this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.SCHEDULE_VIEW),
    ]);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Transaction-local (is_local = true): RLS policy functions inflate the planner's cost estimates far past
      // jit_above_cost, so JIT compilation (seconds) dwarfed the sub-second query itself in the 50k benchmark
      // (docs/evidence/w5-data/benchmark). A bounded statement_timeout keeps one search from holding a connection.
      await manager.query(`SELECT set_config('jit', 'off', true), set_config('statement_timeout', '5000', true)`);
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      // Custom workspace-members: search is the same authorised data as the lists — object denial, record filters and
      // hidden fields (never a match target) all apply. No-op for everyone else.
      const staffPolicy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      const venuePolicy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
      const shiftPolicy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
      const delegated = scope.kind === 'owner' && scope.delegated;

      // Sequential on one connection (a transaction's queries are serialised anyway).
      const staff = canViewStaff && staffPolicy.canRead ? await this.searchStaff(manager, ctx, scope, query, limit, staffPolicy) : [];
      const managers = canViewManagers ? await this.searchManagers(manager, query, limit) : [];
      const shifts = canViewSchedule && shiftPolicy.canRead ? await this.searchShifts(manager, ctx, scope, query, limit, shiftPolicy, venuePolicy) : [];
      // Offers are not a workspace-member object (members' offer lists are empty too) — never searched for them.
      const offers = canViewSchedule && !delegated ? await this.searchOffers(manager, ctx, scope, query, limit) : [];
      const venues = canViewVenues && venuePolicy.canRead ? await this.searchVenues(manager, ctx, scope, query, limit, venuePolicy) : [];

      return [...staff, ...managers, ...shifts, ...offers, ...venues];
    });
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
    const p = new Params(q);
    const ws = p.push(ctx.workspaceId);
    let extra = '';
    if (policy.restricted && scope.kind === 'owner') {
      extra += ` AND sp.created_by = ${p.push(scope.ownerUserId)}`;
      const filter = this.memberAccess.rawWhere(policy, 'sp', p.next);
      filter.positional.forEach((v) => p.push(v));
      extra += ` AND (${filter.sql})`;
    }
    const emailBranch =
      q.emailPrefix && this.memberAccess.isFieldVisible(policy, 'email')
        ? `UNION SELECT sp.id FROM core."user" u JOIN staff_profile sp ON sp.user_id = u.id WHERE u.email::text ILIKE ${p.push(q.emailPrefix)}`
        : '';
    const lim = p.push(limit);
    const rows = await manager.query(
      `WITH cand AS (
         SELECT sp.id FROM core."user" u JOIN staff_profile sp ON sp.user_id = u.id WHERE ${this.userMatch(q, 'u')}
         UNION
         SELECT sp.id FROM staff_profile sp WHERE ${q.useInfix ? `(sp.search_vector @@ ${TSQ} OR lower(sp.staff_ref) LIKE lower($3))` : `sp.search_vector @@ ${TSQ}`}
         ${emailBranch}
       )
       SELECT sp.id, u.first_name, u.last_name,
              (n.full_name = ${NORM_TEXT} OR lower(sp.staff_ref) = lower($2)) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) + ts_rank_cd(sp.search_vector, ${TSQ}) AS rank,
              public.similarity(n.full_name, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM cand
         JOIN staff_profile sp ON sp.id = cand.id
         JOIN core."user" u ON u.id = sp.user_id
         CROSS JOIN LATERAL (SELECT ${userName('u')} AS full_name) n
        WHERE sp.workspace_id = ${ws} AND sp.archived_at IS NULL${extra}
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

  private async searchManagers(manager: EntityManager, q: SearchQuery, limit: number): Promise<SearchResult[]> {
    const p = new Params(q);
    // MANAGER_MANAGE holders already see managers' emails in the list; prefix-only, and only for an email-like query.
    const emailBranch = q.emailPrefix ? `OR u.email::text ILIKE ${p.push(q.emailPrefix)}` : '';
    const lim = p.push(limit);
    const rows = await manager.query(
      `SELECT mp.id, u.first_name, u.last_name,
              (${userName('u')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) AS rank,
              public.similarity(${userName('u')}, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM core.manager_profile mp
         JOIN core."user" u ON u.id = mp.user_id
        WHERE (${this.userMatch(q, 'u')} ${emailBranch}) AND mp.archived_at IS NULL
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

    const p = new Params(q);
    let where = `${this.venueMatch(q, 'v', this.memberAccess.isFieldVisible(policy, 'clientName'))}`;
    where += ` AND v.status <> ${p.push(VenueStatus.ARCHIVED)} AND v.archived_at IS NULL`;
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND v.id = ANY(${p.push(venueIds)}::uuid[])`;
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('v.workspace_id', p.next)}`;
      p.push(ctx.workspaceId);
      if (policy.restricted) {
        where += ` AND v.created_by = ${p.push(scope.ownerUserId)}`;
        const filter = this.memberAccess.rawWhere(policy, 'v', p.next);
        filter.positional.forEach((v) => p.push(v));
        where += ` AND (${filter.sql})`;
      }
    }
    const lim = p.push(limit);
    const rows = await manager.query(
      `SELECT v.id, v.name,
              (${venueName('v')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(v.search_vector, ${TSQ}) AS rank,
              public.similarity(${venueName('v')}, ${NORM_TEXT}) AS sim, ${PARAMS_ANCHOR}
         FROM venue v
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

    const p = new Params(q);
    // A shift's own vector (address + notes) is NOT a global-search target: under RLS its GIN index is unusable for the
    // runtime role (`@@` is not LEAKPROOF) and the full scan cost 250–500 ms per keystroke at 50k shifts (benchmark).
    const clientNameVisible = this.memberAccess.isFieldVisible(venuePolicy, 'clientName');
    let where = `s.archived_at IS NULL`;
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND s.venue_id = ANY(${p.push(venueIds)}::uuid[])`;
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('s.workspace_id', p.next)}`;
      p.push(ctx.workspaceId);
      if (policy.restricted) {
        where += ` AND s.created_by = ${p.push(scope.ownerUserId)}`;
        const filter = this.memberAccess.rawWhere(policy, 's', p.next);
        filter.positional.forEach((v) => p.push(v));
        where += ` AND (${filter.sql})`;
      }
    }
    const lim = p.push(limit);
    // Venue-driven: venues matched by FTS / trigram (accents, prefixes), then their shifts NEWEST FIRST exactly as before
    // wave 5 — ordering by date lets the planner stop after LIMIT rows (ranking every shift of every matched venue cost
    // ~150 ms at 50k shifts under RLS). Job-role names are not a global-search target for shifts (label = venue · date).
    const rows = await manager.query(
      `WITH mv AS (
         SELECT v.id, (${venueName('v')} = ${NORM_TEXT}) AS exact, ts_rank_cd(v.search_vector, ${TSQ}) AS rank
           FROM venue v WHERE ${this.venueMatch(q, 'v', clientNameVisible)}
       )
       SELECT s.id, v.name AS venue_name, s.starts_at, mv.exact, mv.rank, ${PARAMS_ANCHOR}
         FROM mv
         JOIN shift s ON s.venue_id = mv.id
         JOIN venue v ON v.id = s.venue_id
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

    const p = new Params(q);
    let where = 'TRUE';
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND s.venue_id = ANY(${p.push(venueIds)}::uuid[])`;
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('o.workspace_id', p.next)}`;
      p.push(ctx.workspaceId);
    }
    const lim = p.push(limit);
    const rows = await manager.query(
      `WITH cand AS (
         SELECT o.id FROM job_offer o
           JOIN staff_profile sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
          WHERE ${this.userMatch(q, 'u')}
         UNION
         SELECT o.id FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
           JOIN venue v ON v.id = s.venue_id
          WHERE ${this.venueMatch(q, 'v', true)}
       )
       SELECT o.id, v.name AS venue_name, u.first_name, u.last_name,
              (${userName('u')} = ${NORM_TEXT} OR ${venueName('v')} = ${NORM_TEXT}) AS exact,
              ts_rank_cd(u.search_vector, ${TSQ}) + ts_rank_cd(v.search_vector, ${TSQ}) AS rank, ${PARAMS_ANCHOR}
         FROM cand
         JOIN job_offer o ON o.id = cand.id
         JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
         JOIN shift s ON s.id = sa.shift_id
         JOIN venue v ON v.id = s.venue_id
         JOIN staff_profile sp ON sp.id = o.staff_profile_id
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
