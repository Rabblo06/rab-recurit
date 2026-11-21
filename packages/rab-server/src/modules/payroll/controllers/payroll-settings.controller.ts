import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { HOLIDAY_RATE_MAX_BPS, HOLIDAY_RATE_MIN_BPS, HolidayPayService } from '../services/holiday-pay.service';

/** Rolled-up holiday pay at a rate in basis points (12.07% = 1207). The organisation is the session's, never a body field. */
export class UseRolledUpHolidayRateDto {
  @Type(() => Number) @IsInt() @Min(HOLIDAY_RATE_MIN_BPS) @Max(HOLIDAY_RATE_MAX_BPS) rateBps!: number;
}

/**
 * Organisation payroll settings: holiday pay (owner decision 4). Transport only: HolidayPayService re-checks the flag,
 * the Venue Manager exclusion, the current-Initial-Manager rule and the step-up. Two named actions, no free-form mode.
 */
@Controller('rest/v1/payroll/settings/holiday-pay')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class PayrollSettingsController {
  constructor(private readonly holidayPay: HolidayPayService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW))
  get(@AuthUser() ctx: AuthContext) {
    return this.holidayPay.getSetting(ctx);
  }

  /** Needs a recent step-up of this session (403 STEP_UP_REQUIRED otherwise). Applies to records approved from now on. */
  @Post('use-rolled-up-rate')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE))
  useRolledUpRate(@AuthUser() ctx: AuthContext, @Body() dto: UseRolledUpHolidayRateDto) {
    return this.holidayPay.useRolledUpRate(ctx, dto.rateBps);
  }

  /** "Our payroll provider handles holiday pay": no holiday line on records approved from now on. Step-up as above. */
  @Post('use-provider')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE))
  useProvider(@AuthUser() ctx: AuthContext) {
    return this.holidayPay.useProvider(ctx);
  }
}
