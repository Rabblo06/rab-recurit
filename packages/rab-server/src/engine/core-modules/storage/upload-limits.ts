import { memoryStorage } from 'multer';

/**
 * PHASE 11 / DEP-01 — `multer` itself is pinned safe in `rab-server`'s own
 * `package.json` (`^2.3.0`, resolving to 2.4.0), but `@nestjs/platform-express`
 * (which `FileInterceptor` below comes from) hard-pins its OWN nested copy
 * to the vulnerable `2.2.0` with no semver range at all — a plain dependency
 * bump in `rab-server` alone does NOT reach the copy `FileInterceptor`
 * actually calls internally. The root `package.json`'s `resolutions` field
 * (`"multer": "2.4.0"`) forces every resolution in the workspace, including
 * that nested one, to the patched version — the "correct parent dependency
 * resolution mechanism" this needed, not a version this app calls directly
 * but must still control.
 *
 * Shared Multer options for every current single-image
 * upload route (profile avatar, workspace logo, manager-workspace logo).
 * All three are identical in shape today (one small image, no other form
 * fields) — extracted so the limits stay in exactly one place rather than
 * drifting across three near-duplicate literals.
 *
 * `fileSize` alone (the only limit this repo set before Phase 11) bounds
 * how large the ONE accepted file may be, but leaves every other multipart
 * dimension at Multer's own default of `Infinity` — including
 * `fieldNestingDepth`/`fieldArrayIndexLimit`, the two fields
 * CVE-2026-77078/CVE-2026-82333 exploit via crafted bracket-notation field
 * names (e.g. `x[4294967294]`) sent alongside (or instead of) the actual
 * file part. None of these routes expect ANY non-file field, still less a
 * nested or array-indexed one, so every one of these is set to the
 * tightest value that still accepts a single plain file part:
 *
 * - `files: 1` — exactly one file part.
 * - `fields: 0` — no non-file form fields at all.
 * - `parts: 2` — `files` and `fields` above already cap each dimension
 *   individually; this is a loose outer bound, not a tight one — Busboy's
 *   own part-counting for a single-file, zero-field request empirically
 *   needs headroom of one beyond the "1 file" a naive reading of `parts`
 *   would suggest (confirmed via this phase's own integration test:
 *   `parts: 1` rejected a genuinely valid single-file upload with "Too many
 *   parts"). `files`/`fields` remain the real, tight controls.
 * - `fieldNestingDepth: 0` / `fieldArrayIndexLimit: 0` — no bracket-notation
 *   field names whatsoever (closes CVE-2026-77078/CVE-2026-82333 for these
 *   routes independently of the Multer version fix, as defense in depth).
 */
export function singleImageUploadOptions(maxBytes: number) {
  return {
    storage: memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 0,
      parts: 2,
      fieldNestingDepth: 0,
      fieldArrayIndexLimit: 0,
    },
  };
}

export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const LOGO_MAX_BYTES = 10 * 1024 * 1024;
