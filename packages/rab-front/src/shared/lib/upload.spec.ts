import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { normalizeApiError } from './apiError';
import {
  LOGO_RULE,
  PAYSLIP_PDF_RULE,
  PROFILE_PHOTO_RULE,
  VENUE_PHOTO_RULE,
  phaseFromProgress,
  uploadErrorOptions,
  uploadHint,
  uploadPhaseLabel,
  validateUploadFile,
} from './upload';

const MB = 1024 * 1024;
function file(name: string, type: string, size: number): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}
function httpError(status: number, data?: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('x', 'ERR_BAD_RESPONSE', config, {}, { status, statusText: '', headers: {}, config, data } as AxiosResponse);
}

describe('upload rules mirror the server (rab-server upload-limits.ts / file-kinds.ts)', () => {
  it('profile photo and logos: PNG/JPEG/WebP up to 10 MB; venue photo 5 MB; payslip PDF 10 MB', () => {
    expect(PROFILE_PHOTO_RULE.maxBytes).toBe(10 * MB);
    expect(LOGO_RULE.maxBytes).toBe(10 * MB);
    expect(VENUE_PHOTO_RULE.maxBytes).toBe(5 * MB);
    expect(PAYSLIP_PDF_RULE.maxBytes).toBe(10 * MB);
    expect(uploadHint(PROFILE_PHOTO_RULE)).toBe('PNG, JPG or WebP · Maximum 10 MB');
  });

  it('accepts the real types at and below the limit, by MIME type or (when the browser gives none) by extension', () => {
    expect(validateUploadFile(file('a.png', 'image/png', 10 * MB), PROFILE_PHOTO_RULE)).toBeNull();
    expect(validateUploadFile(file('a.jpg', 'image/jpeg', 1), PROFILE_PHOTO_RULE)).toBeNull();
    expect(validateUploadFile(file('a.webp', '', 1), PROFILE_PHOTO_RULE)).toBeNull();
    expect(validateUploadFile(file('p.pdf', 'application/pdf', 1), PAYSLIP_PDF_RULE)).toBeNull();
  });

  it('refuses the wrong type, an empty file and one byte over the limit, each with the full requirement', () => {
    expect(validateUploadFile(file('a.gif', 'image/gif', 1), PROFILE_PHOTO_RULE)).toEqual({
      reason: 'type',
      message: "Upload failed. That file type isn't supported. Please choose a PNG, JPG or WebP image smaller than 10 MB.",
    });
    expect(validateUploadFile(file('a.png', 'image/png', 0), PROFILE_PHOTO_RULE)?.reason).toBe('empty');
    expect(validateUploadFile(file('a.png', 'image/png', 10 * MB + 1), PROFILE_PHOTO_RULE)?.message).toBe(
      'Upload failed. That file is larger than 10 MB. Please choose a PNG, JPG or WebP image smaller than 10 MB.',
    );
    expect(validateUploadFile(file('v.png', 'image/png', 5 * MB + 1), VENUE_PHOTO_RULE)?.reason).toBe('size');
    expect(validateUploadFile(file('p.png', 'image/png', 1), PAYSLIP_PDF_RULE)?.message).toBe(
      "Upload failed. That file type isn't supported. Please choose a PDF smaller than 10 MB.",
    );
  });

  it('server failures: 413 states the limit, 5xx says the file was not saved, the sniff 400 is shown as written', () => {
    const opts = uploadErrorOptions(PROFILE_PHOTO_RULE);
    expect(normalizeApiError(httpError(413, { message: 'File too large' }), opts).message).toMatch(/larger than 10 MB/);
    expect(normalizeApiError(httpError(400, { message: 'File too large' }), opts).kind).toBe('payload_too_large');
    expect(normalizeApiError(httpError(500, { message: 'Internal server error' }), opts).message).toBe(
      'Upload failed. Your photo could not be saved. Please try again.',
    );
    expect(normalizeApiError(httpError(400, { message: 'Unsupported file type. Only PNG, JPG and WEBP images are accepted.' }), opts).message).toBe(
      'Unsupported file type. Only PNG, JPG and WEBP images are accepted.',
    );
  });
});

describe('upload progress', () => {
  it('100 % of the bytes sent is "processing", never success; unknown totals show no percentage', () => {
    expect(phaseFromProgress({ loaded: 30, total: 120 })).toEqual({ phase: 'uploading', percent: 25 });
    expect(phaseFromProgress({ loaded: 120, total: 120 })).toEqual({ phase: 'processing', percent: 100 });
    expect(phaseFromProgress({ loaded: 5, total: undefined })).toEqual({ phase: 'uploading', percent: null });
    expect(uploadPhaseLabel('uploading', 25)).toBe('Uploading 25%…');
    expect(uploadPhaseLabel('uploading', null)).toBe('Uploading…');
    expect(uploadPhaseLabel('processing', 100)).toBe('Processing…');
    expect(uploadPhaseLabel('idle', null)).toBe('');
  });
});
