import { MigrationInterface, QueryRunner } from 'typeorm';

import { assertTenantTablePosture } from '../ai-c1-migration-posture';

/**
 * Owner decision 2026-10-26 (avatar conflict settled): the assistant avatar is ROUND ONLY for now. The existing round
 * avatar is kept, the `shape` column is kept (so future shapes are a CHECK change, not a schema change), and the stored
 * set narrows to `circle`. Faces, face styles and colours are unchanged.
 *
 *   - Existing non-circle rows (dev / test only; the table is not production-approved, N1) are mapped to `circle`. This
 *     is a cosmetic, presentation-only value: no payroll, permission or retention meaning. The UPDATE runs with
 *     `row_security = off`, so a role that is subject to RLS gets an error instead of a silently filtered zero
 *     (fail closed; same technique as AiActionProposalActivate1786720960000).
 *   - `organisation_ai_assistant_shape_check` becomes `shape IN ('circle')`.
 *   - RLS, FORCE, policies and grants are untouched; the post-condition re-asserts them and the new CHECK.
 *
 * down() restores the 10-value CHECK of AiAssistantProfile1786720900000. It cannot restore the shapes that up() mapped
 * to `circle` (they are not recorded anywhere); `circle` is valid under both CHECKs, so down() never fails on data.
 */
const TABLE = 'core.organisation_ai_assistant';
const CHECK = 'organisation_ai_assistant_shape_check';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

// Frozen copies (a migration never follows later code).
export const AI_ASSISTANT_SHAPES_1786720990000 = ['circle'] as const;
const AI_ASSISTANT_SHAPES_BEFORE_1786720990000 = ['circle', 'squircle', 'scallop', 'cloud', 'clover', 'flower', 'burst', 'pill', 'gem', 'hexagon'] as const;

async function assertShapeCheck(runner: QueryRunner, migration: string, allowed: readonly string[]): Promise<void> {
  const [row] = (await runner.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = 'core.organisation_ai_assistant'::regclass AND c.conname = $1 AND c.contype = 'c'`,
    [CHECK],
  )) as Array<{ def: string }>;
  const found = row ? [...row.def.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]).sort() : [];
  if (found.join(',') !== [...allowed].sort().join(',')) throw new Error(`${migration}: ${CHECK} does not allow exactly ${allowed.join(', ')}`);
  await runner.query(`SET LOCAL row_security = off`);
  const [bad] = (await runner.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE shape <> ALL($1::text[])`, [allowed])) as Array<{ n: number }>;
  await runner.query(`SET LOCAL row_security = on`);
  if (!bad || bad.n !== 0) throw new Error(`${migration}: rows outside the allowed shapes remain`);
}

export class AiAssistantRoundOnly1786720990000 implements MigrationInterface {
  name = 'AiAssistantRoundOnly1786720990000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL row_security = off`);
    await runner.query(`UPDATE ${TABLE} SET shape = 'circle' WHERE shape <> 'circle'`);
    await runner.query(`SET LOCAL row_security = on`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${CHECK}`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (shape IN (${list(AI_ASSISTANT_SHAPES_1786720990000)}))`);

    await assertShapeCheck(runner, this.name, AI_ASSISTANT_SHAPES_1786720990000);
    await assertTenantTablePosture(runner, this.name, 'organisation_ai_assistant', { policies: 4, insertColumn: 'name', updateColumn: 'name', delete: true });
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${CHECK}`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (shape IN (${list(AI_ASSISTANT_SHAPES_BEFORE_1786720990000)}))`);
    await assertShapeCheck(runner, this.name, AI_ASSISTANT_SHAPES_BEFORE_1786720990000);
  }
}
