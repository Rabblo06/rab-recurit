/**
 * Local calendar day (`YYYY-MM-DD`) in `timeZone`; falls back to the UTC day for an unknown zone. Pure, so the API-side
 * prompt preview and the Worker-side turn runner share it without the API importing the runner (p8 merge, R5).
 */
export function localToday(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
