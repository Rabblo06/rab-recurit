import { getGeneration, getUserId, subscribeToSession } from '../../../shared/lib/auth-session';

/**
 * P1B.2 — `ProfilePage`'s unsaved-edit draft, held OUTSIDE React state so it survives a
 * component remount (this module is a singleton; a component's own `useState` is not).
 *
 * Root cause this exists to close: `ProfilePage` can genuinely unmount and remount — proven
 * directly, not assumed — while the browser's identity, URL and server data are all completely
 * unchanged (confirmed via instrumented local reproduction: a `TRUE-UNMOUNT`/`TRUE-MOUNT` pair
 * fires on the existing `useEffect(() => {...}, [])` cleanup/effect, `firstName` resets to its
 * `useState('')` INITIAL value before the profile-reseed effect even runs, and `useLocation()`'s
 * `location.key` changes with NO pathname change, NO app-code `navigate()` call, and NO native
 * `pushState`/`replaceState`/`popstate` — a React Router/browser-level remount of the matched
 * route element, reproducible simply by a second tab/page existing in the same browser context,
 * independent of any identity change). A plain `useEffect(() => { if (profile)
 * setFirstName(profile.firstName) }, [profile])` cannot protect against this: by the time that
 * effect runs on the FRESH mount, the component's own local state has already been wiped by the
 * remount itself — there is no "dirty" value left in React state to guard.
 *
 * Fix: lift the draft to this module-level store, stamped with the IDENTITY (userId +
 * generation — the existing P0 identity-epoch mechanism, `auth-session.ts`'s own `generation`,
 * never a second, competing session-generation system) it was written under. A remount of the
 * SAME identity reads its own draft back; a genuine identity TRANSITION (different user,
 * generation bump) can never read a previous identity's draft — the identity check below fails
 * closed on any mismatch, and the `subscribeToSession` listener also proactively clears it the
 * instant the browser's identity changes at all (login, logout, or a cross-tab broadcast
 * adoption), not only lazily on the next mount.
 */
interface ProfileDraft {
  userId: string;
  generation: number;
  firstName: string;
  lastName: string;
  jobTitle: string;
}

let draft: ProfileDraft | null = null;

subscribeToSession(() => {
  if (!draft) return;
  if (draft.userId !== getUserId() || draft.generation !== getGeneration()) draft = null;
});

/** Only ever returns a draft that matches the browser's CURRENT identity — never a stale one. */
export function getProfileDraft(): { firstName: string; lastName: string; jobTitle: string } | null {
  if (draft && draft.userId === getUserId() && draft.generation === getGeneration()) {
    return { firstName: draft.firstName, lastName: draft.lastName, jobTitle: draft.jobTitle };
  }
  return null;
}

/** Called on every keystroke — always stamps the CURRENT identity, so a write can never be
 * mistaken for a later identity's own draft, even defensively (the component itself is torn
 * down across a real identity transition, so this is belt-and-braces, not the primary guard). */
export function setProfileDraft(values: { firstName: string; lastName: string; jobTitle: string }): void {
  const userId = getUserId();
  if (!userId) return;
  draft = { userId, generation: getGeneration(), ...values };
}

/** Called once a save succeeds, and whenever the browser's identity changes (see the
 * subscription above) — a saved draft, or one that no longer belongs to anyone current, is
 * never kept around "just in case". */
export function clearProfileDraft(): void {
  draft = null;
}
