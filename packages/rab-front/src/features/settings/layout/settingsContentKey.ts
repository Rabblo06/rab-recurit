/**
 * Suspense key for the settings content (fast first navigation, 2026-11-11): a new settings page mounts a new boundary, so
 * the click commits at once and the content area shows a skeleton while that page's code loads (the settings header and
 * sidebar stay). The role editor keeps ONE key for all of its steps: it owns the unsaved draft shared by them, and a new
 * key would remount it and lose that draft.
 */
export function settingsContentKey(pathname: string): string {
  const roleEditor = /^\/settings\/workspace\/members\/roles\/[^/]+/.exec(pathname);
  return roleEditor ? roleEditor[0] : pathname;
}
