export function retryAfterSeconds(value: unknown, now = Date.now()): number {
  const numeric = Number(value);
  if (value != null && Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 60;
}

export function loginError(error: any): { message: string; cooldown: number } {
  const status = error.response?.status;
  if (status === 401) return { message: 'Invalid email or password.', cooldown: 0 };
  if (status === 403) return { message: 'This account does not have access to the Manager system.', cooldown: 0 };
  if (status === 429) {
    const cooldown = retryAfterSeconds(error.response.headers?.['retry-after'] ?? error.response.data?.retryAfter);
    const minutes = Math.max(1, Math.ceil(cooldown / 60));
    return { message: `Too many sign-in attempts. Please try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, cooldown };
  }
  return { message: status ? 'Unable to sign in right now. Please try again.' : 'Unable to reach the server. Check your connection and try again.', cooldown: 0 };
}

export type ApplicationTarget = 'manager_web' | 'venue_manager_app' | 'staff_app';
export function safeApplicationTarget(value: unknown): ApplicationTarget | null {
  return value === 'manager_web' || value === 'venue_manager_app' || value === 'staff_app' ? value : null;
}
export function loginDestination(target: ApplicationTarget): string {
  return target === 'manager_web' ? '/login' : 'rab://login';
}
