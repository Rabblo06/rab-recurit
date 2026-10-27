import { MigrationInterface, QueryRunner } from 'typeorm';

import { assertTenantTablePosture } from '../ai-c1-migration-posture';

/**
 * Twenty UI deltas CD-4 (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md, TW-D5; security rule 5.3): workspace instructions.
 *
 * `core.organisation_ai_instruction` (tenant-scoped, ENABLE + FORCE RLS in this migration, owner `crewflow`): at most one
 * row per organisation; no row = none. `content` 1..2,000 characters; `content_sha256` must equal the SHA-256 of the
 * content (CHECK, so the audit hash can never drift from the text); `updated_by`, `reason` 3..500.
 *
 * Write-time content rules (Phase 4 `skill-content-rules.ts`) run in the service; this table caps length and refuses
 * control characters as the second net. The text is placed AFTER the fixed system prompt under a fixed header
 * (`AI_INSTRUCTIONS_PROMPT_HEADER`) and is part of the EX-1 outgoing scan; it never changes the tool set.
 *
 * Policies: SELECT `organisation_id = core.current_org() AND core.ai_actor_eligible()` — only the AI-eligible users (the
 * CEO and the current Initial Manager, whose turns include it) read organisation-authored text, as Phase 4 skills
 * (P4-D5); other managers and no-context queries get 0 rows. INSERT / UPDATE: `core.ai_settings_writer()` (the CEO) and
 * `updated_by = core.current_uid()`; DELETE: `core.ai_settings_writer()`. Grants to `crewflow_app`: SELECT; INSERT and
 * UPDATE of the listed columns; DELETE. No TRUNCATE, no UPDATE of `organisation_id`.
 *
 * Dev-time number (range 1786720900000–949999); Agent 9 renumbers at merge (PL-8). Not production-approved (N1).
 */
const TABLE = 'core.organisation_ai_instruction';
const ORG = `organisation_id = core.current_org()`;
const WRITER = `${ORG} AND core.ai_settings_writer()`;

export class AiWorkspaceInstructions1786720910000 implements MigrationInterface {
  name = 'AiWorkspaceInstructions1786720910000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE ${TABLE} (
        organisation_id uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        content         text        NOT NULL,
        content_sha256  text        NOT NULL,
        updated_by      uuid        NOT NULL,
        reason          text        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_ai_instruction_pkey PRIMARY KEY (organisation_id),
        CONSTRAINT organisation_ai_instruction_content_check CHECK (
          char_length(content) BETWEEN 1 AND 2000 AND btrim(content) <> '' AND content !~ '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'
        ),
        CONSTRAINT organisation_ai_instruction_sha_check CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
        CONSTRAINT organisation_ai_instruction_reason_check CHECK (char_length(reason) BETWEEN 3 AND 500)
      );
    `);
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);

    await runner.query(`CREATE POLICY organisation_ai_instruction_read ON ${TABLE} FOR SELECT USING (${ORG} AND core.ai_actor_eligible());`);
    await runner.query(`CREATE POLICY organisation_ai_instruction_ceo_insert ON ${TABLE} FOR INSERT WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_instruction_ceo_update ON ${TABLE} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_instruction_ceo_delete ON ${TABLE} FOR DELETE USING (${WRITER});`);

    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, content, content_sha256, updated_by, reason) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (content, content_sha256, updated_by, reason, updated_at) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT DELETE ON ${TABLE} TO crewflow_app;`);

    await assertTenantTablePosture(runner, this.name, 'organisation_ai_instruction', { policies: 4, insertColumn: 'content', updateColumn: 'content', delete: true });
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
  }
}
