import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { OrganisationOnboardingService } from '../services/organisation-onboarding.service';

/**
 * Presentation-only leadership capabilities for Settings → Members → Add (the contract `leadershipCapabilities.ts` reads). Any
 * authenticated web caller may ask about THEMSELVES — the answer is derived server-side from the same checks the onboarding
 * writes enforce, and is never authorization: every write re-checks in `OrganisationOnboardingService`.
 */
@ManagerApplication()
@Controller('rest/v1/leadership')
@UseGuards(JwtAuthGuard)
export class LeadershipCapabilitiesController {
  constructor(private readonly organisationOnboarding: OrganisationOnboardingService) {}

  @Get('capabilities')
  async capabilities(@AuthUser() ctx: AuthContext) {
    return { leadership: await this.organisationOnboarding.getLeadershipCapabilities(ctx) };
  }
}
