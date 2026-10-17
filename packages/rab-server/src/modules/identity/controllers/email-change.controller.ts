import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CredentialRequestProvenanceGuard } from '../../../engine/core-modules/auth/guards/credential-request-provenance.guard';
import { RateLimitRequired } from '../../../engine/core-modules/throttler/rab-throttler.guard';
import { ConfirmEmailChangeDto } from '../dto/change-email.dto';
import { EmailChangeService } from '../services/email-change.service';

/**
 * CF-04: the public confirmation of a pending email change, redeemed by whoever controls the NEW address. Pre-auth by
 * design (the token is the credential), so it carries the credential-route protections: JSON only with a trusted-or-absent
 * Origin, a tight rate limit, and fail-closed when the rate-limit store is unavailable.
 */
@Controller('rest/v1/email-change')
export class EmailChangeController {
  constructor(private readonly emailChange: EmailChangeService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RateLimitRequired()
  @UseGuards(CredentialRequestProvenanceGuard)
  confirm(@Body() dto: ConfirmEmailChangeDto) {
    return this.emailChange.confirm(dto.token);
  }
}
