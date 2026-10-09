/**
 * Success line printed by the seed command. It takes only the organisation slug and the account email, and never a password:
 * the password is supplied through SEED_ADMIN_PASSWORD and is not echoed to stdout or logs.
 */
export function seedSuccessMessage(input: { slug: string; email: string }): string {
  return `Seeded organisation "${input.slug}". Admin account "${input.email}" created with its password sourced from SEED_ADMIN_PASSWORD (value not printed).`;
}
