import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HostLabelResolution } from './workspace-host.types';

interface ResolvedRow {
  workspace_id: string;
  organisation_id: string;
  status: string;
  canonical_label: string;
  /** Not in lane S2's contract v1 — read if a later revision adds it (requested in WAVE3_LANE_H_REPORT.md). */
  display_name?: string | null;
}

interface ReleasedRow {
  workspace_id: string;
  organisation_id: string;
  canonical_label: string;
  reserved_until: Date | string;
}

/**
 * Wave 3 lane H — the ONLY place the pre-auth host-label registry is read (lane S2's contract,
 * `docs/evidence/wave2-lane-s2/CONTRACT.md` §2). Both functions are narrow SECURITY DEFINER lookups granted to
 * `crewflow_app` only; they return ids and the canonical label, never owner, member or user data, and they collapse
 * unknown / reserved / CREATING / FAILED / suspended into the same "0 rows". No tenant context is bound or needed: this
 * runs before any session exists, and its answer is routing context only — every authorisation decision is still the
 * session's own (guard → service → RLS), never this lookup's.
 *
 * Uncached on purpose; `WorkspaceHostResolverService` owns the cache.
 */
@Injectable()
export class WorkspaceHostLookupService {
  constructor(private readonly dataSource: DataSource) {}

  async lookup(label: string): Promise<HostLabelResolution> {
    const resolved = await this.dataSource.query<ResolvedRow[]>('SELECT * FROM core.resolve_workspace_by_host_label($1)', [label]);
    const row = resolved[0];
    if (row && row.status === 'READY') {
      return {
        kind: 'workspace',
        workspaceId: row.workspace_id,
        organisationId: row.organisation_id,
        canonicalLabel: row.canonical_label.toLowerCase(),
        displayName: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : null,
      };
    }
    const released = await this.dataSource.query<ReleasedRow[]>('SELECT * FROM core.resolve_released_host_label($1)', [label]);
    const old = released[0];
    if (old) {
      return {
        kind: 'renamed',
        workspaceId: old.workspace_id,
        organisationId: old.organisation_id,
        canonicalLabel: old.canonical_label.toLowerCase(),
        reservedUntil: new Date(old.reserved_until).toISOString(),
      };
    }
    return { kind: 'unknown' };
  }
}
