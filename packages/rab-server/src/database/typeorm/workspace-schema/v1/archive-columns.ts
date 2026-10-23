/**
 * FROZEN with migration ArchiveAndSearchSchema1786719920000 (never edited after merge; a later change is a new module).
 *
 * Waves 4+5 lane DB5 (F9 policy, CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.9): named archive / restore, never a
 * soft-delete framework and never on financial, attendance or audit rows. Contract: docs/evidence/w45-db5/CONTRACT.md §3.
 *
 * `archived_at` + `archived_by` on venue, job_role, staff_profile (leaver) and shift (drafts only). `archived_by` is the
 * actor's user id kept as history with NO foreign key — the same reasoning as audit_log's historical identifiers
 * (AuditLogImmutableHistoricalIdentifiers1786692000000): a hard-deleted user must not erase or block the record of who
 * archived something; the authoritative evidence is the audit_log row written by the service in the same transaction.
 *
 *  - `<t>_archived_pair_check`: both set or both NULL.
 *  - `shift_archived_draft_only_check`: only a `draft` shift may be archived, and an archived shift cannot leave `draft`
 *    (no publish while archived — restore first). "Draft" = ShiftStatus.DRAFT only (pending_manager_approval and declined
 *    are not drafts; verified against @rab/shared shift-transitions.ts).
 *  - `<t>_archived_idx` partial indexes serve the "archived" lists; active lists keep their existing indexes.
 *  - No RLS change: history and FK reads must still see archived rows; the default `archived_at IS NULL` filter for list
 *    and search endpoints is a service-layer (layer 2) rule.
 *  - Unique constraints are deliberately left TOTAL (analysis in the contract): restore can never hit a unique conflict.
 *
 * Adding nullable columns with no default is a catalog-only change (no rewrite); the CHECKs scan the table once under the
 * same ALTER (every new value is NULL, so they always hold). Applied to `core` by the migration and to every
 * `workspace_<32 hex>` schema as module `v1.016-archive-columns` (WorkspaceSchemaMigrator + both provisioning paths).
 */
export const ARCHIVABLE_WORKSPACE_TABLES = ['venue', 'job_role', 'staff_profile', 'shift'] as const;

export function archiveColumnsSql(schema: string): string {
  const statements: string[] = [];
  for (const t of ARCHIVABLE_WORKSPACE_TABLES) {
    const extra = t === 'shift' ? `,\n  ADD CONSTRAINT shift_archived_draft_only_check CHECK (archived_at IS NULL OR status = 'draft')` : '';
    statements.push(
      `ALTER TABLE ${schema}.${t}\n  ADD COLUMN archived_at timestamptz,\n  ADD COLUMN archived_by uuid,\n` +
        `  ADD CONSTRAINT ${t}_archived_pair_check CHECK ((archived_at IS NULL) = (archived_by IS NULL))${extra}`,
    );
    statements.push(`CREATE INDEX ${t}_archived_idx ON ${schema}.${t} (organisation_id, archived_at DESC) WHERE archived_at IS NOT NULL`);
  }
  return statements.join(';\n');
}
