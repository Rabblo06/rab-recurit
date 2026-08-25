import { Matches } from 'class-validator';

/** Lowercase alphanumeric + hyphen, 3-63 chars, no leading/trailing hyphen — standard subdomain-label shape. */
export class UpdateSubdomainDto {
  @Matches(/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/, {
    message: 'Subdomain must be 3-63 lowercase letters, numbers or hyphens, and cannot start or end with a hyphen.',
  })
  slug!: string;
}
