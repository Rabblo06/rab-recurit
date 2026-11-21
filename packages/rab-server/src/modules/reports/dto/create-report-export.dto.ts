import { REPORT_KEYS, ReportKeyType } from '@rab/shared';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `POST /rest/v1/reports/exports`. Names the report and its filter only. The organisation, workspace, scope, and
 * whether pay or hours columns are included are never accepted from the client (forbidNonWhitelisted: a body carrying
 * `organisationId`, `includePay`, `status` or anything else is a 400); the service derives them from the session.
 * Cross-field rules (period vs payroll run, the period length) are checked by the service, so a direct call is checked too.
 */
export class CreateReportExportDto {
  @IsIn(REPORT_KEYS)
  reportKey!: ReportKeyType;

  @IsOptional()
  @Matches(ISO_DATE)
  periodFrom?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  periodTo?: string;

  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @IsUUID()
  payrollRunId?: string;
}
