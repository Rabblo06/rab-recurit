import { provisionWorkspaceFunctionSql, ProvisionFunctionCreateVerb } from './provision-workspace-function';

/**
 * FROZEN with migration AttendanceMoneyChecks1786719810000 (never edited after merge).
 *
 * Wave 2 lane S2 (B3): `core.provision_workspace(uuid)` v2 = the v1 body (provision-workspace-function.ts, byte-identical
 * apart from the two insertions below) plus, inside the same sub-transaction and BEFORE the function reports READY:
 *  - one APPLIED `core.workspace_schema_migration` row per module it just applied (ids, versions and checksums frozen
 *    here from the module list at the time of the migration);
 *  - `workspace_schema_registry.module_version` = the last module version;
 *  - the structural fingerprint, which must equal the frozen expected fingerprint for that version — otherwise the
 *    sub-transaction rolls back (zero objects) and the workspace is FAILED ("verification failed: fingerprint …"), so the
 *    server path can never mark a schema READY that differs from what the migrator and the TypeScript provisioner build.
 * The function's owner, SECURITY DEFINER flag, search_path, lock_timeout and ACL are unchanged (CREATE OR REPLACE keeps
 * them; the migration re-verifies).
 */
export interface ProvisionLedgerModule {
  id: string;
  version: number;
  checksum: string;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function provisionWorkspaceFunctionV2Sql(
  template: string,
  verb: ProvisionFunctionCreateVerb,
  modules: readonly ProvisionLedgerModule[],
  expectedFingerprint: string,
  appVersion: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) throw new Error('expected fingerprint must be 64 hex characters');
  if (!/^[A-Za-z0-9._:@+/-]{1,100}$/.test(appVersion)) throw new Error('unsafe app version');
  modules.forEach((m, i) => {
    if (m.version !== i + 1 || !/^v[0-9]+\.[0-9]{3}-[a-z0-9-]{1,48}$/.test(m.id) || !/^[0-9a-f]{64}$/.test(m.checksum)) {
      throw new Error(`module ${i + 1} is not a valid ledger entry`);
    }
  });
  const last = modules[modules.length - 1]!.version;
  const v1 = provisionWorkspaceFunctionSql(template, verb);

  const declareAnchor = '      v_table     text;\n';
  const readyAnchor = "        PERFORM core.mark_workspace_schema_ready(p_workspace_id, 1);\n        RETURN 'READY';\n";
  if (v1.split(declareAnchor).length !== 2 || v1.split(readyAnchor).length !== 2) {
    throw new Error('provision_workspace v1 body anchors not found exactly once; refusing to compose v2');
  }
  const declare = `${declareAnchor}      v_started   timestamptz := pg_catalog.clock_timestamp();\n      v_fp        text;\n`;
  const ready = `        PERFORM core.mark_workspace_schema_ready(p_workspace_id, 1);

        -- Wave 2 lane S2 (B3): record every applied module in the ledger, then the module version and the fingerprint.
        INSERT INTO core.workspace_schema_migration
          (workspace_id, organisation_id, schema_name, module_id, version, checksum, previous_version, target_version, attempt,
           status, started_at, completed_at, error_class, app_version)
        SELECT p_workspace_id, v_org, v_name, m.id, m.version, m.checksum, 0, ${last},
               coalesce((SELECT max(x.attempt) FROM core.workspace_schema_migration x
                          WHERE x.workspace_id = p_workspace_id AND x.module_id = m.id), 0) + 1,
               'APPLIED', v_started, pg_catalog.clock_timestamp(), NULL, ${lit(appVersion)}
          FROM unnest(ARRAY[${modules.map((m) => lit(m.id)).join(', ')}]::text[],
                       ARRAY[${modules.map((m) => String(m.version)).join(', ')}]::integer[],
                       ARRAY[${modules.map((m) => lit(m.checksum)).join(', ')}]::text[]) AS m(id, version, checksum);
        v_fp := core.workspace_schema_fingerprint(p_workspace_id);
        IF v_fp IS DISTINCT FROM ${lit(expectedFingerprint)} THEN
          RAISE EXCEPTION 'fingerprint % does not match the expected fingerprint for module version ${last}', coalesce(v_fp, 'NULL')
            USING ERRCODE = 'CWV01';
        END IF;
        UPDATE core.workspace_schema_registry
           SET module_version = ${last}, expected_fingerprint = v_fp, observed_fingerprint = v_fp,
               fingerprint_checked_at = now(), drift_status = 'OK', drift_detail = NULL
         WHERE workspace_id = p_workspace_id;
        RETURN 'READY';
`;
  return v1.replace(declareAnchor, declare).replace(readyAnchor, ready);
}
