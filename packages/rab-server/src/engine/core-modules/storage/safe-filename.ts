/**
 * Original filenames are DISPLAY METADATA ONLY — they never influence an
 * object key, a path or an authorization decision. This produces a value that
 * is safe to put in a `Content-Disposition` header and to show back to a user:
 * no path separators, no traversal, no CR/LF (header injection), no control or
 * bidi-override characters, bounded length.
 */
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g;
const HOSTILE_CHARS = /["<>:|?*;=\\]/g;

export function sanitiseFilename(input: string | null | undefined, fallback: string): string {
  let name = String(input ?? '');
  // Strip any directory component in either separator style, then traversal remnants.
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(CONTROL_AND_BIDI, '')
    .replace(HOSTILE_CHARS, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .normalize('NFC');
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name.length > 0 ? name : fallback;
}

/** ASCII-only variant for the plain `filename=` parameter; non-ASCII survives in the RFC 5987 `filename*` form. */
export function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_');
}

export function contentDisposition(name: string, inline: boolean): string {
  const safe = sanitiseFilename(name, 'file');
  return `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(safe)}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
