/**
 * Moved to `@rab/server/modules/scheduling/utils/resolve-responsible-manager` (2026-11-06) so the API's lazy
 * manager-confirmation-deadline withdrawal and the Worker resolve the responsible manager with the SAME function.
 * Re-exported here so existing Worker imports keep working; there is still exactly one implementation.
 */
export { resolveResponsibleManager, type ResolvedManager } from '@rab/server/modules/scheduling/utils/resolve-responsible-manager';
