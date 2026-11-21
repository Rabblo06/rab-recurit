import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import {
  AddPayrollAdditionDto,
  AddPayrollCorrectionDto,
  ListPayrollAdjustmentsDto,
  RejectPayrollAdjustmentDto,
} from '../dto/payroll-adjustment.dto';
import { PayrollAdjustmentService } from '../services/payroll-adjustment.service';

/**
 * Payroll adjustments (owner decision 3). Transport only: `PayrollAdjustmentService` re-checks the flag, the workspace,
 * the Venue Manager exclusion, the approver-is-not-the-creator / not-the-paid-person rule and the step-up, and pins every
 * query to the caller's workspace (404 outside it). Every mutation names its action; no route accepts a status.
 * `@ManagerApplication()`: a mobile session is refused outright.
 */
@Controller('rest/v1/payroll/adjustments')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class PayrollAdjustmentController {
  constructor(private readonly adjustments: PayrollAdjustmentService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListPayrollAdjustmentsDto) {
    return this.adjustments.list(ctx, dto);
  }

  @Post('corrections')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  addCorrection(@AuthUser() ctx: AuthContext, @Body() dto: AddPayrollCorrectionDto) {
    return this.adjustments.addCorrection(ctx, dto);
  }

  @Post('bonuses')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  addBonus(@AuthUser() ctx: AuthContext, @Body() dto: AddPayrollAdditionDto) {
    return this.adjustments.addBonus(ctx, dto);
  }

  @Post('expenses')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  addExpense(@AuthUser() ctx: AuthContext, @Body() dto: AddPayrollAdditionDto) {
    return this.adjustments.addExpense(ctx, dto);
  }

  /** Needs a recent step-up of this session (403 STEP_UP_REQUIRED otherwise: POST /auth/step-up, then retry). */
  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  approve(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.approve(ctx, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  reject(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectPayrollAdjustmentDto) {
    return this.adjustments.reject(ctx, id, dto.reason);
  }
}
