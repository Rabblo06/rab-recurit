/**
 * What a stored file IS. Drives the content allowlist, size ceiling, object
 * key folder and the download policy — never anything the client sends.
 */
export const FileKind = {
  PROFILE_IMAGE: 'PROFILE_IMAGE',
  ORGANISATION_LOGO: 'ORGANISATION_LOGO',
  WORKSPACE_LOGO: 'WORKSPACE_LOGO',
  SHIFT_ROSTER_PDF: 'SHIFT_ROSTER_PDF',
  FINAL_TIMESHEET_PDF: 'FINAL_TIMESHEET_PDF',
  /** A venue's profile photo. Workspace-scoped; read policy registered by the venue module (VenuePhotoFilePolicy). */
  VENUE_PHOTO: 'VENUE_PHOTO',
  /** The Approved Shift Statement for one approved payroll record (not a payslip). Worker-generated; read policy registered by the payroll module (ShiftStatementFilePolicy). */
  APPROVED_SHIFT_STATEMENT_PDF: 'APPROVED_SHIFT_STATEMENT_PDF',
  /** The payroll provider's official payslip PDF for one staff member in one finalised run (manager upload, versioned). Policy: PayslipFilePolicy. */
  PAYSLIP_PDF: 'PAYSLIP_PDF',
} as const;
export type FileKindType = (typeof FileKind)[keyof typeof FileKind];

export const FileStatus = {
  PENDING: 'PENDING',
  AVAILABLE: 'AVAILABLE',
  FAILED: 'FAILED',
  DELETED: 'DELETED',
} as const;
export type FileStatusType = (typeof FileStatus)[keyof typeof FileStatus];

export interface FileKindRules {
  /** Folder segment in the object key. */
  folder: string;
  content: 'image' | 'pdf';
  maxBytes: number;
  /** Images render inline for the app (proxied bytes); PDFs are always `attachment`. */
  inline: boolean;
}

const MB = 1024 * 1024;

export const FILE_KIND_RULES: Record<FileKindType, FileKindRules> = {
  PROFILE_IMAGE: { folder: 'avatars', content: 'image', maxBytes: 10 * MB, inline: true },
  ORGANISATION_LOGO: { folder: 'logos', content: 'image', maxBytes: 10 * MB, inline: true },
  WORKSPACE_LOGO: { folder: 'logos', content: 'image', maxBytes: 10 * MB, inline: true },
  SHIFT_ROSTER_PDF: { folder: 'reports', content: 'pdf', maxBytes: 20 * MB, inline: false },
  FINAL_TIMESHEET_PDF: { folder: 'reports', content: 'pdf', maxBytes: 20 * MB, inline: false },
  VENUE_PHOTO: { folder: 'venues', content: 'image', maxBytes: 5 * MB, inline: true },
  APPROVED_SHIFT_STATEMENT_PDF: { folder: 'payroll', content: 'pdf', maxBytes: 10 * MB, inline: false },
  PAYSLIP_PDF: { folder: 'payslips', content: 'pdf', maxBytes: 10 * MB, inline: false },
};

/** Kinds a client may ever ask to upload directly. Generated evidence (PDFs) is worker-produced only. */
export const CLIENT_UPLOADABLE_KINDS: readonly FileKindType[] = [FileKind.PROFILE_IMAGE];
