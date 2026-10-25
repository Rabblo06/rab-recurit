/** `POST /offers/batches/:id/confirm-all` answers per offer; turn that into one honest line ("2 of 3 confirmed"). */
export type ConfirmAllResult = { results?: Array<{ ok: boolean }> };
export function confirmAllSummary(results: Array<{ ok: boolean }>): { text: string; partial: boolean } {
  const ok = results.filter((r) => r.ok).length;
  if (results.length === 0) return { text: 'There were no accepted offers left to confirm.', partial: false };
  if (ok === results.length) return { text: ok === 1 ? '1 shift confirmed.' : `${ok} shifts confirmed.`, partial: false };
  return { text: `${ok} of ${results.length} accepted offers confirmed. The rest could not be confirmed (the shift may be full or the offer changed).`, partial: true };
}
