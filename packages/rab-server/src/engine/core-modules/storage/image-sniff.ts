/**
 * Content-type validated by sniffing magic bytes, never by trusting the
 * client's `Content-Type` header. PNG/JPEG/WEBP allow-list only.
 */
const SIGNATURES: Array<{ ext: string; mimetype: string; check: (buf: Buffer) => boolean }> = [
  {
    ext: 'png',
    mimetype: 'image/png',
    check: (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: 'jpg',
    mimetype: 'image/jpeg',
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    ext: 'webp',
    mimetype: 'image/webp',
    check: (buf) =>
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function sniffImageType(buffer: Buffer): { ext: string; mimetype: string } | null {
  const match = SIGNATURES.find((sig) => sig.check(buffer));
  return match ? { ext: match.ext, mimetype: match.mimetype } : null;
}

export function mimetypeForExt(ext: string): string {
  return SIGNATURES.find((sig) => sig.ext === ext)?.mimetype ?? 'application/octet-stream';
}
