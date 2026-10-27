import { MigrationInterface, QueryRunner } from 'typeorm';

import { assertTenantTablePosture } from '../ai-c1-migration-posture';

/**
 * Twenty UI deltas CD-1 / CD-2 (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md, TW-D1..D3): five model levels and data residency.
 *
 * 1. `organisation_ai_model_preference.tier` becomes a LEVEL key: its CHECK widens from ('fast','smart') to the five level
 *    keys. Existing `fast` / `smart` rows stay valid (both are level keys) — no data move; the column keeps its name.
 * 2. `core.organisation_ai_model_policy` (tenant-scoped, ENABLE + FORCE RLS in this migration, owner `crewflow`): one row
 *    per organisation; no row = the defaults (chat `extra_fast`, agent `extra_fast`, allowed {extra_fast, fast},
 *    residency `global`). CHECKs on every enum; `chat_level` must be allowed; `allowed_levels` a non-empty subset.
 *    Residency `global` | `eu` only — there is no `us` (rule 3.7).
 *
 * Policies (same as AiModelPreference1786720250000): SELECT by the bound organisation (availability, submit and the
 * Worker resolve the level from it); INSERT / UPDATE also `core.ai_settings_writer()` (the CEO) and
 * `updated_by = core.current_uid()`; DELETE `core.ai_settings_writer()`. Grants to `crewflow_app`: SELECT; INSERT and
 * UPDATE of the listed columns; DELETE. No TRUNCATE, no UPDATE of `organisation_id`.
 *
 * Dev-time number (range 1786720900000–949999); Agent 9 renumbers at merge (PL-8). Not production-approved (N1).
 */
const TABLE = 'core.organisation_ai_model_policy';
const PREF = 'core.organisation_ai_model_preference';
const ORG = `organisation_id = core.current_org()`;
const WRITER = `${ORG} AND core.ai_settings_writer()`;

export const AI_MODEL_LEVELS_1786720920000 = ['extra_fast', 'fast', 'balanced', 'smart', 'extra_smart'] as const;
const LEVELS = AI_MODEL_LEVELS_1786720920000.map((l) => `'${l}'`).join(', ');

export class AiModelLevelPolicy1786720920000 implements MigrationInterface {
  name = 'AiModelLevelPolicy1786720920000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${PREF} DROP CONSTRAINT organisation_ai_model_preference_tier_check;`);
    await runner.query(`ALTER TABLE ${PREF} ADD CONSTRAINT organisation_ai_model_preference_tier_check CHECK (tier IN (${LEVELS}));`);
    await runner.query(`COMMENT ON COLUMN ${PREF}.tier IS 'Level key (extra_fast | fast | balanced | smart | extra_smart). Named tier for history.';`);

    await runner.query(`
      CREATE TABLE ${TABLE} (
        organisation_id uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        chat_level      text        NOT NULL DEFAULT 'extra_fast',
        agent_level     text        NOT NULL DEFAULT 'extra_fast',
        allowed_levels  text[]      NOT NULL DEFAULT ARRAY['extra_fast', 'fast']::text[],
        data_residency  text        NOT NULL DEFAULT 'global',
        updated_by      uuid        NOT NULL,
        reason          text        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_ai_model_policy_pkey PRIMARY KEY (organisation_id),
        CONSTRAINT organisation_ai_model_policy_chat_level_check CHECK (chat_level IN (${LEVELS})),
        CONSTRAINT organisation_ai_model_policy_agent_level_check CHECK (agent_level IN (${LEVELS})),
        CONSTRAINT organisation_ai_model_policy_allowed_check CHECK (
          cardinality(allowed_levels) BETWEEN 1 AND 5
          AND allowed_levels <@ ARRAY[${LEVELS}]::text[]
          AND array_position(allowed_levels, NULL) IS NULL
          AND chat_level = ANY (allowed_levels)
        ),
        CONSTRAINT organisation_ai_model_policy_residency_check CHECK (data_residency IN ('global', 'eu')),
        CONSTRAINT organisation_ai_model_policy_reason_check CHECK (char_length(reason) BETWEEN 3 AND 500)
      );
    `);
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);

    await runner.query(`CREATE POLICY organisation_ai_model_policy_read ON ${TABLE} FOR SELECT USING (${ORG});`);
    await runner.query(`CREATE POLICY organisation_ai_model_policy_ceo_insert ON ${TABLE} FOR INSERT WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_model_policy_ceo_update ON ${TABLE} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_model_policy_ceo_delete ON ${TABLE} FOR DELETE USING (${WRITER});`);

    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, chat_level, agent_level, allowed_levels, data_residency, updated_by, reason) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (chat_level, agent_level, allowed_levels, data_residency, updated_by, reason, updated_at) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT DELETE ON ${TABLE} TO crewflow_app;`);

    await assertTenantTablePosture(runner, this.name, 'organisation_ai_model_policy', { policies: 4, insertColumn: 'chat_level', updateColumn: 'data_residency', delete: true });
  }

  async down(runner: QueryRunner): Promise<void> {
    const [row] = (await runner.query(`SELECT count(*)::int AS n FROM ${PREF} WHERE tier NOT IN ('fast', 'smart')`)) as Array<{ n: number }>;
    if ((row?.n ?? 0) > 0) {
      throw new Error(`${this.name} down refused: ${row!.n} model pin(s) use a level key other than fast/smart; remove them first (Settings → AI).`);
    }
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
    await runner.query(`COMMENT ON COLUMN ${PREF}.tier IS NULL;`);
    await runner.query(`ALTER TABLE ${PREF} DROP CONSTRAINT organisation_ai_model_preference_tier_check;`);
    await runner.query(`ALTER TABLE ${PREF} ADD CONSTRAINT organisation_ai_model_preference_tier_check CHECK (tier IN ('fast', 'smart'));`);
  }
}
