import { OpsRunError } from './ops-run';

/**
 * Pure: may `--apply` / `--resume` run? While HWS runtime routing is OFF (production today) the copy is a SNAPSHOT that the
 * HWS cutover must reconcile again anyway, so applying it is only meaningful as part of that cutover: refused unless the
 * operator passes `--hws-cutover` explicitly. Applies in every environment (fail closed; a disposable rehearsal passes the
 * flag too). With HWS on, no flag is needed.
 */
export function assertHwsApplyAllowed(input: { mode: 'dry-run' | 'apply' | 'verify'; hwsRuntimeEnabled: boolean; hwsCutover: boolean; production: boolean }): void {
  if (input.mode !== 'apply') {
    if (input.hwsCutover) throw new OpsRunError('--hws-cutover applies only to --apply / --resume.');
    return;
  }
  if (!input.hwsRuntimeEnabled && !input.hwsCutover) {
    throw new OpsRunError(
      `hws:backfill --apply refused: HWS runtime routing is OFF (HWS_RUNTIME_ENABLED=false)${input.production ? ' in PRODUCTION' : ''}. ` +
        'A copy made now is a snapshot the HWS cutover must reconcile again; do NOT run it in production while HWS is off. ' +
        'Only as an approved step of the HWS cutover (gate G4) or on a disposable rehearsal, pass --hws-cutover explicitly.',
    );
  }
}
