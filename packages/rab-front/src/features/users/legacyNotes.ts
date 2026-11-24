/**
 * CF-23: builds before the fix persisted notes about a person in localStorage under `user-notes-<userId>`. Browser storage
 * outlives logout and is shared by every account on the same browser profile, so those keys are deleted, never read.
 * Called once at app start-up (App.tsx) and when the user profile page mounts.
 */
export const LEGACY_NOTES_KEY_PREFIX = 'user-notes-';

export function purgeLegacyNotes(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LEGACY_NOTES_KEY_PREFIX)) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {
    // Storage unavailable (private mode, blocked): nothing was persisted there.
  }
}
