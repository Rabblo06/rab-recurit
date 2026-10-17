/**
 * CF-20: tells "a person is using this tab" apart from automatic traffic (polling, refetch-on-focus) so an abandoned tab
 * cannot keep a session alive forever. Requests sent with no real input for BACKGROUND_AFTER_MS carry the
 * `X-Crewflow-Background: 1` marker; the server validates them fully but does not extend the idle window for them.
 *
 * The marker can only shorten this tab's own session, never lengthen it, so it grants nothing if forged.
 */
export const BACKGROUND_REQUEST_HEADER = 'X-Crewflow-Background';
export const BACKGROUND_AFTER_MS = 60_000;

let lastActivityAt = Date.now();
let installed = false;

export function noteUserActivity(at = Date.now()): void {
  lastActivityAt = at;
}

/** Installs the input listeners once (idempotent). Passive and capture-phase, so no component can swallow them. */
export function installUserActivityTracking(target: Pick<Window, 'addEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (installed || !target) return;
  installed = true;
  const opts = { capture: true, passive: true } as const;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) target.addEventListener(type, () => noteUserActivity(), opts);
}

export function isBackgroundRequest(now = Date.now()): boolean {
  return now - lastActivityAt > BACKGROUND_AFTER_MS;
}
