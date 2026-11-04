/**
 * PDF renderer P1 (review finding M-3): the native renderer's memory must fit inside the Worker container.
 *
 * Each native render runs in its own `worker_threads` thread with a V8 old-generation cap
 * (`resourceLimits.maxOldGenerationSizeMb`). Up to `PDF_NATIVE_CONCURRENCY` threads render at once, in the SAME container
 * as the jobs process and the provisioner child. If the threads' caps together could exceed what the container has left,
 * two oversized documents rendering at once would get the whole Worker OOM-killed by the kernel (every consumer, every
 * scan, every tenant) instead of the clean thread-level `error_PDF_NATIVE_OUT_OF_MEMORY` the design promises.
 *
 * Rule (fail closed, checked at boot by env validation for both processes and again by the Worker's render pool before
 * it creates any thread):  PDF_NATIVE_CONCURRENCY × PDF_NATIVE_HEAP_LIMIT_MB  ≤  PDF_NATIVE_MEMORY_BUDGET_MB.
 *
 *  - PDF_NATIVE_HEAP_LIMIT_MB = 384 per thread (was 512). The plan's measurements (§ "Speed / memory"): a 500-row table in
 *    page segments peaked at 423 MB RSS for the WHOLE process, so one render's old generation stays well below 384 MB.
 *  - PDF_NATIVE_MEMORY_BUDGET_MB defaults to 768 = half of the Worker's default `mem_limit` (1536m,
 *    docker-compose.production.yml / docker-compose.image.yml). The other half is the jobs process itself (H6 matrix
 *    M09/M19: Worker peak 471–474 MiB with pre-warmed threads), each thread's young generation, yoga WASM memory and
 *    array buffers, and the provisioner child. Default concurrency 2 × 384 = 768 fits exactly; 3 or 4 threads refuse to
 *    boot until the operator raises the container's `mem_limit` (CREWFLOW_WORKER_MEM_LIMIT) AND this budget together.
 *
 * Pure constants and functions: no Nest, no Node API, no `modules/` import (shared by env validation and the Worker).
 */

/** Per-thread V8 old-generation cap of a native render thread, in MB. */
export const PDF_NATIVE_HEAP_LIMIT_MB = 384;

/** Default total budget for all render threads' old-generation caps: half of the Worker's default 1536 MB mem_limit. */
export const PDF_NATIVE_MEMORY_BUDGET_MB_DEFAULT = 768;

/** Bounds of PDF_NATIVE_MEMORY_BUDGET_MB: at least one thread's cap; at most 16 GiB. */
export const PDF_NATIVE_MEMORY_BUDGET_MB_MIN = PDF_NATIVE_HEAP_LIMIT_MB;
export const PDF_NATIVE_MEMORY_BUDGET_MB_MAX = 16_384;

/** The pool size used when PDF_NATIVE_CONCURRENCY is unset or empty (render-pool.ts applies the same default). */
export const PDF_NATIVE_CONCURRENCY_DEFAULT = 2;

export class PdfNativeMemoryBudgetError extends Error {
  override readonly name = 'PdfNativeMemoryBudgetError';
}

/**
 * `PDF_NATIVE_MEMORY_BUDGET_MB`: unset or empty → 768; a plain decimal integer (no sign, no leading zero, no spaces) from
 * 384 to 16 384 → that many MB; anything else throws.
 */
export function parsePdfNativeMemoryBudgetMb(raw: string | undefined): number {
  if (raw === undefined || raw === '') return PDF_NATIVE_MEMORY_BUDGET_MB_DEFAULT;
  const value = /^[1-9][0-9]{0,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= PDF_NATIVE_MEMORY_BUDGET_MB_MIN && value <= PDF_NATIVE_MEMORY_BUDGET_MB_MAX)) {
    throw new PdfNativeMemoryBudgetError(
      `PDF_NATIVE_MEMORY_BUDGET_MB must be an integer number of MB from ${PDF_NATIVE_MEMORY_BUDGET_MB_MIN} to ${PDF_NATIVE_MEMORY_BUDGET_MB_MAX}`,
    );
  }
  return value;
}

/**
 * Throws `PdfNativeMemoryBudgetError` unless `concurrency` threads at the per-thread cap fit in `budgetMb`. The message
 * names the numbers and the remedy, never a secret.
 */
export function assertPdfNativeMemoryFits(concurrency: number, budgetMb: number): void {
  const needed = concurrency * PDF_NATIVE_HEAP_LIMIT_MB;
  if (needed > budgetMb) {
    throw new PdfNativeMemoryBudgetError(
      `PDF_NATIVE_CONCURRENCY=${concurrency} × ${PDF_NATIVE_HEAP_LIMIT_MB} MB per render thread = ${needed} MB exceeds ` +
        `PDF_NATIVE_MEMORY_BUDGET_MB=${budgetMb} (default ${PDF_NATIVE_MEMORY_BUDGET_MB_DEFAULT}, half of the Worker's default ` +
        `1536m mem_limit). Lower PDF_NATIVE_CONCURRENCY, or raise the Worker container's mem_limit ` +
        `(CREWFLOW_WORKER_MEM_LIMIT) and PDF_NATIVE_MEMORY_BUDGET_MB together.`,
    );
  }
}
