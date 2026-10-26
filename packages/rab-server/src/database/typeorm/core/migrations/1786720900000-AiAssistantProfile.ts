import { MigrationInterface, QueryRunner } from 'typeorm';

import { assertTenantTablePosture } from '../ai-c1-migration-posture';

/**
 * Twenty UI deltas CD-3 (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md, TW-D4): the organisation's assistant name and avatar.
 *
 * `core.organisation_ai_assistant` (tenant-scoped, ENABLE + FORCE RLS in this migration, owner `crewflow`): one row per
 * organisation; no row = the default preset. PRESENTATION ONLY: the name is never sent to a model or placed in a prompt.
 * Not on `organisation_ai_setting`, which only platform administrators write (rule 1.2, as AiModelPreference1786720250000).
 *
 *   - `preset` NULL (customised) or one of the Crewflow preset keys (`AI_ASSISTANT_PRESET_KEYS`, rab-shared);
 *   - `name` 1..24 characters, no control, bidi-override or zero-width characters (CHECK; the service applies the same
 *     rules first, so a refused write is a clean 400);
 *   - `shape` / `colour` / `face` CHECK enums (10 / 10 / 6, `AI_ASSISTANT_SHAPES` / `_COLOURS` / `_FACES`); `animate`.
 *
 * Policies: SELECT `organisation_id = core.current_org()` (every eligible user's chat header reads it through
 * `/ai/availability`); INSERT / UPDATE also `core.ai_settings_writer()` (the CEO) and `updated_by = core.current_uid()`;
 * DELETE ("Reset to default") `core.ai_settings_writer()`. Grants to `crewflow_app`: SELECT; INSERT and UPDATE of the
 * listed columns; DELETE. No TRUNCATE, no UPDATE of `organisation_id`. Post-condition refuses to record on drift.
 *
 * Dev-time number (range 1786720900000–949999); Agent 9 renumbers at merge (PL-8). Not production-approved (N1).
 */
const TABLE = 'core.organisation_ai_assistant';
const ORG = `organisation_id = core.current_org()`;
const WRITER = `${ORG} AND core.ai_settings_writer()`;
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

// Frozen copies of the rab-shared enums AT THIS MIGRATION (a later enum change is a new migration, never an edit).
export const AI_ASSISTANT_PRESETS_1786720900000 = ['crewflow', 'amber', 'sky', 'clover', 'violet', 'rosa', 'teal'] as const;
export const AI_ASSISTANT_SHAPES_1786720900000 = ['circle', 'squircle', 'scallop', 'cloud', 'clover', 'flower', 'burst', 'pill', 'gem', 'hexagon'] as const;
export const AI_ASSISTANT_COLOURS_1786720900000 = ['orange', 'amber', 'green', 'teal', 'sky', 'blue', 'violet', 'rose', 'red', 'grey'] as const;
export const AI_ASSISTANT_FACES_1786720900000 = ['classic', 'smile', 'tall', 'round', 'calm', 'warm'] as const;
/** Zero-width, bidi embedding/override/isolate and BOM code points (PostgreSQL ARE `\uXXXX` escapes). */
export const AI_HIDDEN_UNICODE_SQL_CLASS = '[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]';

export class AiAssistantProfile1786720900000 implements MigrationInterface {
  name = 'AiAssistantProfile1786720900000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE ${TABLE} (
        organisation_id uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        preset          text,
        name            text        NOT NULL,
        shape           text        NOT NULL,
        colour          text        NOT NULL,
        face            text        NOT NULL,
        animate         boolean     NOT NULL DEFAULT true,
        updated_by      uuid        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_ai_assistant_pkey PRIMARY KEY (organisation_id),
        CONSTRAINT organisation_ai_assistant_preset_check CHECK (preset IS NULL OR preset IN (${list(AI_ASSISTANT_PRESETS_1786720900000)})),
        CONSTRAINT organisation_ai_assistant_name_check CHECK (
          char_length(name) BETWEEN 1 AND 24 AND btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND name !~ '${AI_HIDDEN_UNICODE_SQL_CLASS}'
        ),
        CONSTRAINT organisation_ai_assistant_shape_check CHECK (shape IN (${list(AI_ASSISTANT_SHAPES_1786720900000)})),
        CONSTRAINT organisation_ai_assistant_colour_check CHECK (colour IN (${list(AI_ASSISTANT_COLOURS_1786720900000)})),
        CONSTRAINT organisation_ai_assistant_face_check CHECK (face IN (${list(AI_ASSISTANT_FACES_1786720900000)}))
      );
    `);
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);

    await runner.query(`CREATE POLICY organisation_ai_assistant_read ON ${TABLE} FOR SELECT USING (${ORG});`);
    await runner.query(`CREATE POLICY organisation_ai_assistant_ceo_insert ON ${TABLE} FOR INSERT WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_assistant_ceo_update ON ${TABLE} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_assistant_ceo_delete ON ${TABLE} FOR DELETE USING (${WRITER});`);

    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, preset, name, shape, colour, face, animate, updated_by) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (preset, name, shape, colour, face, animate, updated_by, updated_at) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT DELETE ON ${TABLE} TO crewflow_app;`);

    await assertTenantTablePosture(runner, this.name, 'organisation_ai_assistant', { policies: 4, insertColumn: 'name', updateColumn: 'name', delete: true });
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
  }
}
