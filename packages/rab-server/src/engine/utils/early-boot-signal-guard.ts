import { installBootSignalGuard } from './boot-signal-guard';

/**
 * Import this as the FIRST import of a process entry point (`main.ts`).
 *
 * Importing an entry point's module graph (Nest, TypeORM, every domain module)
 * takes seconds, and CommonJS evaluates all imports before `bootstrap()` runs.
 * A guard installed inside `bootstrap()` would therefore leave that whole
 * window unprotected; installing it as a side effect of the first import
 * covers it. See `installBootSignalGuard` for why a guard is needed at all.
 */
const release = installBootSignalGuard('rab-server process');

export function releaseEarlyBootSignalGuard(): void {
  release();
}
