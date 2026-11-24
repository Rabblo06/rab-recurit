import { IsString, Matches } from 'class-validator';

/** `POST /rest/v1/reports/exports/:id/download`: the single-use link token (base64url, 32 random bytes). In the body, never the URL, so it is not logged. */
export class DownloadReportExportDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}
