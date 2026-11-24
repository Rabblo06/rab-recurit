import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { MemberAccessModule } from '../identity/member-access/member-access.module';
import { ReportsController } from './controllers/reports.controller';
import { ReportExportService } from './services/report-export.service';

/**
 * Owner decision 29: the reports page v1 (request, list, link, download). The Worker job
 * (rab-worker queues/rab-reports/report-export.job.ts) builds the files with `report-builders.ts` from this module.
 */
@Module({
  imports: [AuthModule, MemberAccessModule],
  controllers: [ReportsController],
  providers: [ReportExportService],
  exports: [ReportExportService],
})
export class ReportsModule {}
