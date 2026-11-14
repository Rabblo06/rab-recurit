import { provisionWorkspaceFunctionV3Sql } from '../database/typeorm/core/provision-workspace-guards-sql';
import { composeServerPathTemplateV1GrantParity } from '../database/typeorm/workspace-schema/v1/server-path-template-grant-parity';
import { composeServerPathTemplateLevel21, provisionWorkspaceFunctionLevelSql } from '../database/typeorm/workspace-schema/structure-level-21';
import { moduleChecksum, modulesThrough } from '../database/typeorm/workspace-schema/workspace-schema-modules';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL as B } from '../database/typeorm/workspace-schema/structure-level-21';
import { VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL as A } from '../database/typeorm/workspace-schema/v1/verify-workspace-schema-v1-policy-aware';
const mods = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
const a = provisionWorkspaceFunctionV3Sql(composeServerPathTemplateV1GrantParity(), mods, EXPECTED_WORKSPACE_FINGERPRINTS[20]!, 'db:provision_workspace@WorkspaceGrantParityGuards1786721430000').split('\n');
const b = provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel21(), mods, 21, 'f'.repeat(64), 'db:provision_workspace@WorkspaceStaffMemberSelect1786721480000').split('\n');
console.log(a.length, b.length);
let i = 0, j = 0;
while (i < a.length || j < b.length) {
  if (a[i] === b[j]) { i++; j++; continue; }
  // find resync
  let found = false;
  for (let k = 1; k < 12 && !found; k++) {
    if (b[j + k] !== undefined && a[i] === b[j + k]) { for (let x = 0; x < k; x++) console.log('+ ' + b[j + x].slice(0, 200)); j += k; found = true; }
    else if (a[i + k] !== undefined && a[i + k] === b[j]) { for (let x = 0; x < k; x++) console.log('- ' + a[i + x].slice(0, 200)); i += k; found = true; }
  }
  if (!found) { console.log('- ' + (a[i] ?? '').slice(0, 200)); console.log('+ ' + (b[j] ?? '').slice(0, 200)); i++; j++; }
}
const va = A.split('\n'), vb = B.split('\n');
for (let k = 0; k < Math.max(va.length, vb.length); k++) if (va[k] !== vb[k]) console.log('VERIFY', k, '\n- ' + va[k] + '\n+ ' + vb[k]);
