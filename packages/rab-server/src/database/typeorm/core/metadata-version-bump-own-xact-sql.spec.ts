import { createHash } from 'node:crypto';

import {
  functionBodyOf,
  METADATA_VERSION_ANY_ROW_CHECK,
  METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL,
  METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL,
  METADATA_VERSION_OWN_BUMP_CHECK,
} from './metadata-version-bump-own-xact-sql';
import { METADATA_VERSION_BUMP_FUNCTION_SQL } from './metadata-version-sql';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';

/**
 * Static review of MetadataVersionBumpOwnTransaction1786721570000's SQL. The behaviour (no lost step under concurrent first
 * changes) is proven in metadata-cache.integration.spec.ts.
 */
describe('metadata version bump: own-transaction short-circuit (1786721570000)', () => {
  const md5 = (text: string) => createHash('md5').update(text).digest('hex');
  /** semantic-posture.ts hashes `prosrc || '|' || coalesce(pg_get_function_sqlbody, '')`; plpgsql has no sqlbody. */
  const goldenBodyHash = (createSql: string) => md5(`${functionBodyOf(createSql)}|`);

  it('the "already bumped" short-circuit only matches a bump by this transaction', () => {
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL.split(METADATA_VERSION_OWN_BUMP_CHECK)).toHaveLength(2);
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL).not.toContain(METADATA_VERSION_ANY_ROW_CHECK);
    expect(METADATA_VERSION_OWN_BUMP_CHECK).toMatch(/AND s\.last_bump_xact = v_xact;$/);
  });

  it('changes exactly that one predicate of the 1786721560000 function and nothing else', () => {
    const expected = METADATA_VERSION_BUMP_FUNCTION_SQL.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ').replace(
      METADATA_VERSION_ANY_ROW_CHECK,
      METADATA_VERSION_OWN_BUMP_CHECK,
    );
    expect(METADATA_VERSION_BUMP_FUNCTION_SQL.split(METADATA_VERSION_ANY_ROW_CHECK)).toHaveLength(2);
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL).toBe(expected);
  });

  it('replaces in place (same signature, SECURITY INVOKER, pinned search_path); down() restores the 1786721560000 body', () => {
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL.startsWith('CREATE OR REPLACE FUNCTION core.metadata_version_bump()\nRETURNS trigger\n')).toBe(true);
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL).toContain('SET search_path = pg_catalog, pg_temp');
    expect(METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL).toBe(METADATA_VERSION_BUMP_FUNCTION_SQL.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '));
    expect(functionBodyOf(METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL)).toBe(functionBodyOf(METADATA_VERSION_BUMP_FUNCTION_SQL));
  });

  it('the semantic posture golden pins the fixed body, not the 1786721560000 one', () => {
    const line = SEMANTIC_GOLDEN_PG16.find((l) => l.startsWith('function|metadata_version_bump()|'));
    expect(goldenBodyHash(METADATA_VERSION_BUMP_FUNCTION_SQL)).toBe('5f6076dfd94a06cecc78005a3cf86337');
    expect(line).toBe(
      `function|metadata_version_bump()|owner=crewflow|definer=false|lang=plpgsql|vol=v|strict=false|leakproof=false|config=search_path=pg_catalog, pg_temp|body=${goldenBodyHash(METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL)}`,
    );
  });
});
