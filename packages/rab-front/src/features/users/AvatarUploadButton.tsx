import { useRef } from 'react';
import Avatar from '../../shared/components/Avatar';
import { toast } from '../../shared/lib/toast';

// Mirrors `FileKind.PROFILE_IMAGE`'s real rules
// (packages/rab-server/src/engine/core-modules/storage/file-kinds.ts) —
// nothing in `@rab/shared` exports these today, so this is a duplicated
// client-side fast-fail only; the server re-checks by magic bytes
// regardless, and is the actual authority.
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Hover-to-upload avatar — click the avatar itself (a camera-icon overlay
 * fades in on hover/focus) to pick a new photo. Owns only the interaction
 * (file picker, client-side validation) and reports the chosen `File` back
 * via `onFileSelected`; it deliberately does not know whether the caller
 * will upload it immediately (Staff Detail, the record already exists) or
 * hold it as a local preview until some later save (Create Staff, no
 * record id yet) — that decision belongs to each caller.
 *
 * No hover-click-to-upload interaction existed anywhere in this codebase
 * before this — `AvatarUpload.tsx` (Settings/Profile) uses a plain avatar
 * next to separate Upload/Remove buttons, the exact pattern this one
 * replaces for Staff. That file's upload plumbing (hidden file input,
 * `FormData`, `multipart/form-data`) is still the right shape and is
 * mirrored here — only the interaction differs.
 */
export default function AvatarUploadButton({
  imageKey,
  previewUrl,
  label,
  onFileSelected,
  disabled,
}: {
  imageKey?: string | null;
  previewUrl?: string | null;
  label: string;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      toast.error('Please choose a PNG, JPEG or WEBP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('That image is too large — the limit is 10MB.');
      return;
    }
    onFileSelected(file);
  }

  return (
    <button
      type="button"
      className="avatar-upload-button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      aria-label="Change photo"
    >
      <Avatar imageKey={imageKey} previewUrl={previewUrl} label={label} alt="Avatar" variant="xl" />
      <span className="avatar-upload-button-overlay" aria-hidden="true">Change photo</span>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MIME_TYPES.join(',')}
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </button>
  );
}
