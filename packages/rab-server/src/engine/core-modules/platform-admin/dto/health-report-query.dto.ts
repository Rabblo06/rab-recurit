import { IsIn, IsOptional } from 'class-validator';

/** X2.4: `GET /admin/health/report?refresh=1` = the admin pressed Refresh: skip the 10 s cache and always write the audit row. */
export class HealthReportQueryDto {
  @IsOptional()
  @IsIn(['1'])
  refresh?: '1';
}
