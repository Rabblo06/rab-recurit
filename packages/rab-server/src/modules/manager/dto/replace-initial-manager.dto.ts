import { IsEmail, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * P2.9 gap review, item 2 (owner-approved, corrected, non-destructive design) — replaces a
 * never-activated, genuinely stuck Initial Manager invitation with a fresh one for a different
 * person. The old `User`/`ManagerProfile`/`ManagerWorkspace` rows are NEVER deleted — see
 * `OrganisationOnboardingService.replaceInitialManager`'s own doc comment for the full lifecycle.
 *
 * Reversed by the universal-self-service-onboarding checkpoint (docs/HANDOFF.md): no
 * `workspaceName`/`subdomain` fields — the replacement recipient chooses their own workspace
 * after activating, the same as a fresh Initial Manager invite now does.
 *
 * `expectedProfileId` is an optimistic-concurrency token, not a lookup convenience: the request
 * is refused (409 `STALE_INITIAL_MANAGER`) unless it exactly matches the organisation's current,
 * not-yet-superseded Initial Manager profile at the moment the row lock is acquired — a stale
 * client (one that fetched the page before an earlier replacement, or that raced a concurrent
 * one) can never act on a profile that already moved on.
 */
export class ReplaceInitialManagerDto {
  @IsUUID()
  expectedProfileId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;
}
