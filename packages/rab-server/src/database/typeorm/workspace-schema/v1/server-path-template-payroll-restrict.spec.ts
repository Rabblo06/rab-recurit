import { ServerPathWorkspaceProvisioning1786719500000 } from '../../core/migrations/1786719500000-ServerPathWorkspaceProvisioning';
import { PayrollEvidenceRestrict1786719700000 } from '../../core/migrations/1786719700000-PayrollEvidenceRestrict';
import { WORKSPACE_TEMPLATE_STEPS } from '../provision-workspace-schema';
import { PAYROLL_EVIDENCE_FKS, payrollEvidenceFksSql, payrollEvidenceRestrictSql } from './payroll-evidence-restrict';
import { provisionWorkspaceFunctionSql } from './provision-workspace-function';
import { composeServerPathTemplateV1, SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1PayrollRestrict } from './server-path-template-payroll-restrict';

/**
 * F3 drift guards (PayrollEvidenceRestrict1786719700000). Pure unit tests, no database.
 *
 * 1. The TypeScript provisioner and `core.provision_workspace(uuid)` must build the same schema: the provisioner's
 *    WORKSPACE_TEMPLATE_STEPS, composed for the sentinel schema, must equal the frozen composition the migration embeds.
 * 2. The function body the new migration re-creates must be byte-identical to the one 1786719500000 created, except for
 *    the embedded template: the SQL that migration emits is captured through a fake QueryRunner and compared.
 */
const captureSql = async (up: (runner: never) => Promise<void>): Promise<string[]> => {
  const sql: string[] = [];
  const runner = { query: async (q: string) => { sql.push(q); return []; } };
  await up(runner as never);
  return sql;
};

describe('F3: payroll evidence RESTRICT in both provisioning paths', () => {
  it('the TypeScript provisioner\'s first 14 steps compose exactly the frozen 1786719700000 server-path template', () => {
    // Wave 2 lane S2: WORKSPACE_TEMPLATE_STEPS now follows WORKSPACE_SCHEMA_MODULES (module 15 onwards is covered by
    // workspace-schema-modules.spec.ts); the 1786719700000 composition must remain exactly its first 14 modules.
    const composed = WORKSPACE_TEMPLATE_STEPS.slice(0, 14).map((step) => step(SERVER_PATH_SENTINEL_SCHEMA)).join(';\n');
    expect(composed).toBe(composeServerPathTemplateV1PayrollRestrict());
  });

  it('the new composition is the 1786719500000 composition, unchanged, followed by the RESTRICT step only', () => {
    const before = composeServerPathTemplateV1();
    const after = composeServerPathTemplateV1PayrollRestrict();
    expect(after.startsWith(`${before};\n`)).toBe(true);
    expect(after.slice(before.length + 2)).toBe(payrollEvidenceRestrictSql(SERVER_PATH_SENTINEL_SCHEMA));
  });

  it('the RESTRICT step re-creates exactly the three payroll_record parent FKs with ON DELETE RESTRICT, nothing else', () => {
    const sql = payrollEvidenceRestrictSql('workspace_0123456789abcdef0123456789abcdef');
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql).toMatch(/^ALTER TABLE "workspace_0123456789abcdef0123456789abcdef"\.payroll_record\n/);
    expect(sql.match(/ON DELETE RESTRICT/g)).toHaveLength(3);
    expect(sql).not.toMatch(/CASCADE|SET NULL|NOT VALID|ROW LEVEL SECURITY|GRANT|REVOKE|OWNER|POLICY/i);
    for (const fk of PAYROLL_EVIDENCE_FKS) {
      expect(sql).toContain(`DROP CONSTRAINT ${fk.name},`);
      expect(sql).toContain(
        `ADD CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns}) REFERENCES "workspace_0123456789abcdef0123456789abcdef".${fk.parent}(${fk.parentColumns}) ON DELETE RESTRICT`,
      );
    }
    expect(payrollEvidenceRestrictSql('core')).toContain('REFERENCES core.attendance(id) ON DELETE RESTRICT');
    expect(payrollEvidenceFksSql('core', 'CASCADE').match(/ON DELETE CASCADE/g)).toHaveLength(3);
  });

  it('refuses any schema name that is not core or a canonical workspace schema', () => {
    for (const bad of ['public', 'workspace_XYZ', 'workspace_0123"; DROP TABLE core.user; --', 'core; select 1']) {
      expect(() => payrollEvidenceRestrictSql(bad)).toThrow('Invalid workspace schema');
    }
  });

  it('the re-created core.provision_workspace body is byte-identical to 1786719500000 apart from the embedded template', async () => {
    const original = (await captureSql((r) => new ServerPathWorkspaceProvisioning1786719500000().up(r))).find((q) =>
      q.includes('CREATE FUNCTION core.provision_workspace('),
    );
    expect(original).toBeDefined();
    expect(provisionWorkspaceFunctionSql(composeServerPathTemplateV1(), 'CREATE')).toBe(original);
  });

  it('the migration re-creates the function (CREATE OR REPLACE) with the RESTRICT composition, and down() restores the old one', async () => {
    const restrictTemplate = composeServerPathTemplateV1PayrollRestrict();
    const m = new PayrollEvidenceRestrict1786719700000();
    // A fake runner that reports only core with CASCADE FKs so up() takes the change path without a database.
    const fake = (deltype: 'c' | 'r') => {
      const sql: string[] = [];
      const runner = {
        query: async (q: string) => {
          sql.push(q);
          if (q.includes("c.relname = 'payroll_record'")) return [{ schema_name: 'core' }];
          if (q.includes('FROM pg_constraint k')) {
            const done = sql.some((s) => s.startsWith('ALTER TABLE core.payroll_record'));
            const code = done ? (deltype === 'c' ? 'r' : 'c') : deltype;
            return PAYROLL_EVIDENCE_FKS.map((f) => ({
              conname: f.name, deltype: code, updtype: 'a', matchtype: 's', validated: true, parent_ok: true, cols: f.columns, pcols: f.parentColumns,
            }));
          }
          return [];
        },
      };
      return { sql, runner: runner as never };
    };
    const upRun = fake('c');
    await m.up(upRun.runner);
    expect(upRun.sql).toContain(payrollEvidenceRestrictSql('core'));
    expect(upRun.sql).toContain(provisionWorkspaceFunctionSql(restrictTemplate, 'CREATE OR REPLACE'));
    // Exactly two writes and nothing else (no GRANT/REVOKE/OWNER statement: CREATE OR REPLACE keeps the owner and ACL);
    // every other statement is a catalog read or the read-only DO verification block.
    expect(upRun.sql.filter((q) => !/^\s*(SELECT|DO)\b/.test(q))).toEqual([
      payrollEvidenceRestrictSql('core'),
      provisionWorkspaceFunctionSql(restrictTemplate, 'CREATE OR REPLACE'),
    ]);

    const downRun = fake('r');
    await m.down(downRun.runner);
    expect(downRun.sql).toContain(payrollEvidenceFksSql('core', 'CASCADE'));
    expect(downRun.sql).toContain(provisionWorkspaceFunctionSql(composeServerPathTemplateV1(), 'CREATE OR REPLACE'));
  });
});
