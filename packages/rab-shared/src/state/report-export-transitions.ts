import { ReportExportStatus, ReportExportStatusType } from '../types/report-export';
import { TransitionTable } from './assert-transition';

/** Owner decision 29: mirrored exactly by `core.report_export_guard()` (ReportExport1786723200000). */
export const REPORT_EXPORT_TRANSITIONS: TransitionTable<ReportExportStatusType> = {
  [ReportExportStatus.PENDING]: [ReportExportStatus.READY, ReportExportStatus.FAILED],
  [ReportExportStatus.READY]: [ReportExportStatus.EXPIRED],
  [ReportExportStatus.FAILED]: [],
  [ReportExportStatus.EXPIRED]: [],
};
