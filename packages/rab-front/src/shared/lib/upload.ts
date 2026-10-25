import type { AxiosProgressEvent } from 'axios';
import type { ApiErrorOptions } from './apiError';

/**
 * Client-side upload rules: a fast-fail copy of the server's real limits so a user learns "too large" / "wrong type"
 * before waiting for the bytes to travel. The SERVER stays the authority: it caps the size in Multer
 * (`rab-server` engine/core-modules/storage/upload-limits.ts) and decides the type by sniffing the bytes
 * (`FileService.validateContent` + image-sniff.ts, FILE_KIND_RULES in file-kinds.ts). Keep these in step with those files.
 *
 * Note: the server applies `min(kind limit, S3_MAX_UPLOAD_BYTES)` (default 20 MB), so a deployment that lowers
 * S3_MAX_UPLOAD_BYTES below these values is still caught server-side and reported through `uploadErrorOptions`.
 */
export interface UploadRule {
  /** What the file is, in the user's words: "photo", "logo", "payslip". */
  noun: string;
  /** Accepted MIME types (the browser's `file.type`). */
  mimeTypes: readonly string[];
  /** Accepted lower-case extensions, used when the browser reports no MIME type. */
  extensions: readonly string[];
  /** Human list of the accepted types: "PNG, JPG or WebP image". */
  typesLabel: string;
  maxBytes: number;
}

const MB = 1024 * 1024;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'] as const;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'] as const;

/** PROFILE_IMAGE: `POST /profile/avatar`, `/staff/:id/avatar`, `/venue-managers/:id/avatar` (AVATAR_MAX_BYTES = 10 MB). */
export const PROFILE_PHOTO_RULE: UploadRule = { noun: 'photo', mimeTypes: IMAGE_MIME, extensions: IMAGE_EXT, typesLabel: 'PNG, JPG or WebP image', maxBytes: 10 * MB };
/** WORKSPACE_LOGO / ORGANISATION_LOGO: `POST /manager-workspaces/me/logo`, admin organisation logo (LOGO_MAX_BYTES = 10 MB). */
export const LOGO_RULE: UploadRule = { noun: 'logo', mimeTypes: IMAGE_MIME, extensions: IMAGE_EXT, typesLabel: 'PNG, JPG or WebP image', maxBytes: 10 * MB };
/** VENUE_PHOTO: `POST /venues/:id/photo` (VENUE_PHOTO_MAX_BYTES = 5 MB). */
export const VENUE_PHOTO_RULE: UploadRule = { noun: 'photo', mimeTypes: IMAGE_MIME, extensions: IMAGE_EXT, typesLabel: 'PNG, JPG or WebP image', maxBytes: 5 * MB };
/** PAYSLIP_PDF: payroll payslip upload (PAYSLIP_MAX_BYTES = 10 MB; the server checks the %PDF- signature). */
export const PAYSLIP_PDF_RULE: UploadRule = { noun: 'payslip', mimeTypes: ['application/pdf'], extensions: ['pdf'], typesLabel: 'PDF', maxBytes: 10 * MB };

export function formatMegabytes(bytes: number): string {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** "Please choose a PNG, JPG or WebP image smaller than 10 MB." — the one sentence every rejection ends with. */
export function uploadRequirement(rule: UploadRule): string {
  return `Please choose a ${rule.typesLabel} smaller than ${formatMegabytes(rule.maxBytes)}.`;
}

/** The hint under an upload control: "PNG, JPG or WebP · Maximum 10 MB". */
export function uploadHint(rule: UploadRule): string {
  return `${rule.typesLabel.replace(/ image$/, '')} · Maximum ${formatMegabytes(rule.maxBytes)}`;
}

export type UploadRejection = { reason: 'type' | 'size' | 'empty'; message: string };

/** Null when the file may be sent; otherwise why not, with the message to show. Never a substitute for the server check. */
export function validateUploadFile(file: File, rule: UploadRule): UploadRejection | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const typeOk = file.type ? rule.mimeTypes.includes(file.type.toLowerCase()) : rule.extensions.includes(ext);
  if (!typeOk) return { reason: 'type', message: `Upload failed. That file type isn't supported. ${uploadRequirement(rule)}` };
  if (file.size === 0) return { reason: 'empty', message: `Upload failed. That file is empty. ${uploadRequirement(rule)}` };
  if (file.size > rule.maxBytes)
    return { reason: 'size', message: `Upload failed. That file is larger than ${formatMegabytes(rule.maxBytes)}. ${uploadRequirement(rule)}` };
  return null;
}

/**
 * `normalizeApiError` options for a failed upload of `rule`'s kind: what went wrong plus the next action. A 400 with
 * the server's own safe text (e.g. "Unsupported file type. Only PNG, JPG and WEBP images are accepted.") is shown as-is.
 * A 5xx after the bytes arrived is a storage/processing failure: the file was NOT saved.
 */
export function uploadErrorOptions(rule: UploadRule): ApiErrorOptions & { fallback: string } {
  return {
    fallback: `Upload failed. ${uploadRequirement(rule)}`,
    messages: {
      payload_too_large: `Upload failed. That file is larger than ${formatMegabytes(rule.maxBytes)}. ${uploadRequirement(rule)}`,
      server: `Upload failed. Your ${rule.noun} could not be saved. Please try again.`,
      offline: `Upload failed. Connection lost. Check your internet connection and try again.`,
      timeout: `Upload failed. The upload took too long. Please try again.`,
    },
  };
}

export type UploadPhase = 'idle' | 'uploading' | 'processing';

/**
 * Upload phase from axios' `onUploadProgress`. Reaching 100 % means the bytes left the browser, NOT that the file is
 * saved: the server still validates, stores and records it. That waiting time is `processing`; success is only ever
 * the server's response.
 */
export function phaseFromProgress(event: Pick<AxiosProgressEvent, 'loaded' | 'total'>): { phase: UploadPhase; percent: number | null } {
  if (!event.total) return { phase: 'uploading', percent: null };
  const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
  return percent >= 100 ? { phase: 'processing', percent: 100 } : { phase: 'uploading', percent };
}

/** Text for the triggering control: "Uploading 42%…", "Uploading…", "Processing…". */
export function uploadPhaseLabel(phase: UploadPhase, percent: number | null): string {
  if (phase === 'processing') return 'Processing…';
  if (phase === 'uploading') return percent === null ? 'Uploading…' : `Uploading ${percent}%…`;
  return '';
}
