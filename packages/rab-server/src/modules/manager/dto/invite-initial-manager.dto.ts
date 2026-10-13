import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * P2.9C, reversed by the universal-self-service-onboarding checkpoint (docs/HANDOFF.md): the
 * inviter names only the PERSON — workspace name/subdomain are no longer collected here at all.
 * The recipient chooses their own workspace, through the exact same self-service
 * `CreateWorkspaceScreen`/`POST /manager-workspaces` path an ordinary Add-Manager account already
 * uses, after activating. No `organisationId`/`role`/`userId` field exists here — the target
 * organisation comes from the route, and the role is always fixed to Internal Manager by
 * `OrganisationOnboardingService`.
 */
export class InviteInitialManagerDto {
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
