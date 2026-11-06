import { isSafeServerMessage } from '../../shared/lib/apiError';

/** `POST /offers/batches/:id/confirm-all` answers per offer; turn that into one honest line ("2 of 3 confirmed"). */
export type ConfirmAllResult = { results?: Array<{ ok: boolean; message?: string }> };
export function confirmAllSummary(results: Array<{ ok: boolean; message?: string }>): { text: string; partial: boolean } {
  const ok = results.filter((r) => r.ok).length;
  if (results.length === 0) return { text: 'There were no accepted offers left to confirm.', partial: false };
  if (ok === results.length) return { text: ok === 1 ? '1 shift confirmed.' : `${ok} shifts confirmed.`, partial: false };
  // The server says why each one failed (e.g. the manager-confirmation deadline has passed). When every failure carries
  // the same safe reason, that reason is shown; otherwise the general one.
  const reasons = new Set(results.filter((r) => !r.ok).map((r) => (isSafeServerMessage(r.message) ? r.message.trim() : '')));
  const [only] = [...reasons];
  const reason = reasons.size === 1 && only ? only : 'The rest could not be confirmed (the shift may be full or the offer changed).';
  return { text: `${ok} of ${results.length} accepted offers confirmed. ${reason}`, partial: true };
}
