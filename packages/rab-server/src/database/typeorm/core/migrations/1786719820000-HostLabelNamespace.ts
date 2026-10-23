import { MigrationInterface, QueryRunner } from 'typeorm';

import { HOST_LABEL_NAMESPACE_DOWN_SQL, HOST_LABEL_NAMESPACE_TRIGGERS_SQL, HOST_LABEL_NAMESPACE_UP_SQL } from '../host-label-namespace-sql';
import { HOST_LABEL_RESERVED_SEED } from '../host-label-reserved-list';

/**
 * Wave 3 schema for lane H, built by lane S2 (C1 one routing namespace, C2 reserved labels in the DB, C4 rename/reclaim
 * quarantine, C5 pre-auth host → workspace lookup). Dev/test only: deliberately NOT in production-migration-approval.ts.
 * Contract for lane H: docs/evidence/wave2-lane-s2/CONTRACT.md. SQL and design notes: ../host-label-namespace-sql.ts.
 *
 * Existing data is never renamed:
 *  - a label held by two DIFFERENT organisations (a slug of one and a subdomain of another) is ambiguous and makes the
 *    claim registry's exclusion constraint impossible to build: the migration REFUSES and lists the labels; the owner
 *    resolves them, then re-runs;
 *  - a workspace already holding a now-reserved label, an invalid-shape subdomain, or an organisation slug equal to a
 *    reserved label is REPORTED (console + `core.host_label_collision_report()`) and left as is. The resolver never routes
 *    a reserved label, so such a workspace is simply not host-routable until renamed.
 */
export class HostLabelNamespace1786719820000 implements MigrationInterface {
  name = 'HostLabelNamespace1786719820000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'HostLabelNamespace1786719820000 must run as the bootstrap identity (it creates rab_secure_owner-owned objects); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
    await queryRunner.query(HOST_LABEL_NAMESPACE_UP_SQL);

    await queryRunner.query(
      `INSERT INTO core.reserved_host_label (label, category) SELECT * FROM unnest($1::text[], $2::text[])`,
      [HOST_LABEL_RESERVED_SEED.map((r) => r.label), HOST_LABEL_RESERVED_SEED.map((r) => r.category)],
    );

    const report: Array<{ label: string; problem: string; organisation_id: string; workspace_id: string | null }> = await queryRunner.query(
      'SELECT label, problem, organisation_id, workspace_id FROM core.host_label_collision_report()',
    );
    const fatal = report.filter((r) => r.problem.startsWith('CROSS_ORGANISATION_'));
    if (fatal.length) {
      throw new Error(
        `${this.name}: ${new Set(fatal.map((r) => r.label)).size} host label(s) are held by more than one organisation ` +
          `(${[...new Set(fatal.map((r) => r.label))].join(', ')}). Nothing was renamed; resolve them (rename one side) and re-run.`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[${this.name}] existing-label report: ${report.length === 0 ? 'clean' : report.map((r) => `${r.label}:${r.problem}`).join(', ')}`,
    );

    // Backfill the claim registry under each organisation's own RLS binding (FORCE applies to the owner too).
    await queryRunner.query(`
      DO $backfill$
      DECLARE
        o record;
      BEGIN
        FOR o IN SELECT id, slug::text AS slug FROM core.organisation ORDER BY id LOOP
          PERFORM pg_catalog.set_config('rab.organisation_id', o.id::text, true);
          INSERT INTO core.host_label_claim (label, kind, organisation_id, workspace_id)
          VALUES (pg_catalog.lower(o.slug), 'ORGANISATION_SLUG', o.id, NULL);
          INSERT INTO core.host_label_claim (label, kind, organisation_id, workspace_id)
          SELECT pg_catalog.lower(w.subdomain::text), 'WORKSPACE_SUBDOMAIN', w.organisation_id, w.id
            FROM core.manager_workspace w WHERE w.organisation_id = o.id;
        END LOOP;
        PERFORM pg_catalog.set_config('rab.organisation_id', '', true);
      END
      $backfill$;
    `);
    await queryRunner.query(HOST_LABEL_NAMESPACE_TRIGGERS_SQL);

    const [{ claims, expected }] = await queryRunner.query(
      `SELECT (SELECT count(*)::int FROM core.host_label_claim) AS claims,
              (SELECT count(*)::int FROM core.organisation) + (SELECT count(*)::int FROM core.manager_workspace) AS expected`,
    );
    if (claims !== expected) throw new Error(`${this.name}: backfilled ${claims} claim(s), expected ${expected}; refusing`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(HOST_LABEL_NAMESPACE_DOWN_SQL);
  }
}
