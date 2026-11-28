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

/**
 * Pure (payroll review G-follow-up): `--apply --hws-cutover` copies a workspace only while ITS cutover is in progress
 * (core.hws_cutover_state = 'started'). Run before the cutover started (no row) the copy is a stale snapshot; run after it
 * verified it would rewrite rows the workspace schema now owns. Either can leave a workspace copy that disagrees with the
 * live data (e.g. a payroll run read back as 'prepared' after it was finalised), so both are refused. Returns the refusal
 * message, or null when the copy may run. Not used without `--hws-cutover` (HWS on: the runtime already routes there).
 */
export function hwsCutoverCopyRefusal(state: string | null | undefined): string | null {
  if (state === 'started') return null;
  return state === 'verified'
    ? 'refused: this workspace\'s HWS cutover is already verified; its workspace schema is authoritative and must not be re-copied from core.'
    : 'refused: this workspace\'s HWS cutover has not started (core.hws_cutover_state is not \'started\'); a copy now would be a stale snapshot.';
}
