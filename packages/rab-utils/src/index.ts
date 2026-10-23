/**
 * Explicit, intentionally empty entry point for `@rab/utils`.
 *
 * The package currently holds no TypeScript (only `src/seed/README.md`, the owner's placeholder for future seeders).
 * Its `lint` target runs `tsc --noEmit -p packages/rab-utils/tsconfig.json`, and tsc refuses a project with zero
 * inputs (TS18003), which failed `yarn lint` on every run. This module gives that type-check one real input, so the
 * target stays meaningful (it will check the first helper added here) instead of being removed or special-cased.
 * Delete this file once the package has real sources.
 */
export {};
