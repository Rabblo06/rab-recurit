/**
 * The official support channel comes from build configuration only (`VITE_SUPPORT_EMAIL` and/or `VITE_SUPPORT_URL`), never
 * from a guess. Without one, this page says so plainly — it never invents an address, never claims a ticket was sent, and
 * never sends logs or account data anywhere.
 */
export function supportChannels(env: { VITE_SUPPORT_EMAIL?: string; VITE_SUPPORT_URL?: string }): { email: string | null; url: string | null } {
  const email = env.VITE_SUPPORT_EMAIL?.trim() ?? '';
  const rawUrl = env.VITE_SUPPORT_URL?.trim() ?? '';
  let url: string | null = null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'https:' && !u.username && !u.password) url = u.toString();
  } catch { url = null; }
  return { email: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : null, url };
}
