import { Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { FileAccessRegistry } from '../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';

import { PayrollController, StaffShiftStatementsController } from './controllers/payroll.controller';
import { ShiftStatementFilePolicy } from './files/shift-statement-file.policy';
import { PayslipFilePolicy } from './files/payslip-file.policy';
import { NotificationModule } from '../notification/notification.module';
import { PayrollCalendarService } from './services/payroll-calendar.service';
import { PayrollRunService } from './services/payroll-run.service';
import { PayrollService } from './services/payroll.service';

/**
 * Payroll approval (owner rule 2026-10-20). Imports nothing from other domain modules: the attendance module depends on
 * this one (report finalisation creates the pending records in its own transaction), never the other way round.
 */
@Module({
  // AuthModule: JwtAuthGuard's own dependencies (same as every other controller-owning domain module).
  imports: [AuthModule, NotificationModule],
  controllers: [PayrollController, StaffShiftStatementsController],
  providers: [PayrollService, PayrollCalendarService, PayrollRunService],
  exports: [PayrollService, PayrollCalendarService],
})
export class PayrollModule implements OnModuleInit {
  constructor(
    private readonly registry: FileAccessRegistry,
    private readonly permissions: PermissionsService,
    private readonly payroll: PayrollService,
  ) {}

  onModuleInit(): void {
    this.registry.register([FileKind.APPROVED_SHIFT_STATEMENT_PDF], new ShiftStatementFilePolicy(this.permissions, this.payroll));
    this.registry.register([FileKind.PAYSLIP_PDF], new PayslipFilePolicy(this.permissions, this.payroll));
  }
}
