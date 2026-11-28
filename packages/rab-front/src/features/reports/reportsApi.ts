import type { ReportExportSummary, ReportKeyType } from '@rab/shared';
import { api } from '../../shared/api';

/**
 * Owner decision 29: the reports page's calls. The body names the report and its filter only: the server derives the
 * organisation, workspace, scope and whether pay or hours columns are included from the session, and refuses any
 * other field (400).
 */
export interface ReportExportRequest {
  reportKey: ReportKeyType;
  periodFrom?: string;
  periodTo?: string;
  venueId?: string;
  payrollRunId?: string;
}

export async function listExports(): Promise<ReportExportSummary[]> {
  return (await api.get<{ data: ReportExportSummary[] }>('/reports/exports')).data.data;
}

export async function requestExport(body: ReportExportRequest): Promise<ReportExportSummary> {
  return (await api.post<ReportExportSummary>('/reports/exports', body)).data;
}

/**
 * Downloads a ready export: asks for the single-use, 60-second link, uses it at once (token in the POST body, never the
 * URL) and saves the file. A second download needs a new link; the server re-checks permission each time.
 */
export async function downloadExport(id: string, filename: string): Promise<void> {
  const { token } = (await api.post<{ token: string; expiresInSeconds: number }>(`/reports/exports/${id}/link`)).data;
  const res = await api.post(`/reports/exports/${id}/download`, { token }, { responseType: 'blob' });
  const header = String((res.headers as Record<string, unknown>)?.['content-disposition'] ?? '');
  const served = /filename="([^"]+)"/.exec(header)?.[1];
  const href = URL.createObjectURL(res.data as Blob);
  const a = Object.assign(document.createElement('a'), { href, download: served ?? filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}
