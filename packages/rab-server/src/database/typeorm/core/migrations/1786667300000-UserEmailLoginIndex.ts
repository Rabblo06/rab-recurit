import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `AuthService.login`/`forgotPassword` look up `core."user"` by email alone
 * (`WHERE u.email = :email`, no `organisation_id` in the predicate — the
 * org isn't known yet at login time, since one email can log into more than
 * one organisation by this app's own design). The only existing index on
 * this table, `user_org_email_idx`, is `(organisation_id, email)` — a
 * composite index Postgres cannot use for a query that filters on just the
 * second column. Confirmed live via `EXPLAIN (ANALYZE, BUFFERS)`: every
 * login/forgot-password call was a sequential scan across the full table
 * (7277 rows in this dev DB already, actual time ~4ms and rising with table
 * size) — a real, previously-unflagged performance issue that also worsens
 * with growth on the single hottest, most latency-sensitive read path in
 * the app. Not unique (email is deliberately not globally unique across
 * orgs) — a plain btree over `citext` supports the case-insensitive
 * equality lookup this query actually does.
 */
export class UserEmailLoginIndex1786667300000 implements MigrationInterface {
  name = 'UserEmailLoginIndex1786667300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX user_email_idx ON core."user" (email);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.user_email_idx;`);
  }
}
