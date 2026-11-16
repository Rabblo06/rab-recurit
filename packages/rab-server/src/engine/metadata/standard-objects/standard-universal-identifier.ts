/**
 * Metadata engine M1 / E2: the stable universal identifier of a standard object, field or inverse relation field.
 *
 * Twenty keys every standard entity by a hand-written `universalIdentifier` constant so a later upgrade matches and updates it
 * instead of recreating it (twentyhq/twenty @ eedb0a73 `engine/workspace-manager/types/workspace-related-entity.type.ts:5-11`,
 * `syncable-entity.interface.ts:9-21`; the sync dispatches on it in
 * `workspace-migration/universal-flat-entity/utils/universal-flat-entity-deleted-created-updated-matrix-dispatcher.util.ts`).
 * Crewflow derives the identifier deterministically from the PHYSICAL key (table + column), which never changes (a physical
 * name is immutable, OB-10), instead of keeping ~340 literal constants: same identity guarantee, nothing to mistype. The
 * derived values are pinned by a golden digest in standard-objects.spec.ts, so a change to this function or to a key fails CI.
 *
 * Format: sha256 of a versioned, namespaced key, the first 16 bytes as an RFC 9562 version-8 (custom) UUID.
 */
import { createHash } from 'node:crypto';

const NAMESPACE = 'crewflow.standard-metadata.v1';

export function standardUniversalIdentifier(key: string): string {
  if (!/^(object|field|inverse):[a-z][a-z0-9_.]{0,120}$/.test(key)) throw new Error(`standard metadata key ${JSON.stringify(key.slice(0, 80))} is malformed`);
  const b = createHash('sha256').update(`${NAMESPACE}:${key}`, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `object:<table>` (core references: `object:core.<table>`). */
export const objectKey = (table: string, coreReference: boolean): string => `object:${coreReference ? 'core.' : ''}${table}`;
/** `field:<table>.<column>` (core references: `field:core.<table>.<column>`). */
export const fieldKey = (table: string, column: string, coreReference: boolean): string => `field:${coreReference ? 'core.' : ''}${table}.${column}`;
/** The ONE_TO_MANY inverse of the relation on `<sourceTable>.<column>`: `inverse:<sourceTable>.<column>`. */
export const inverseKey = (sourceTable: string, column: string): string => `inverse:${sourceTable}.${column}`;
