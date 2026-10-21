import { useEffect, useRef, useState } from 'react';
import { IconBuilding } from '@tabler/icons-react';

import Avatar from '../../shared/components/Avatar';

/** Mirrors the server (FILE_KIND_RULES.VENUE_PHOTO). UX only — the server re-decides type and size from the bytes. */
export const VENUE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const VENUE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Null when acceptable, otherwise the message to show. */
export function validateVenuePhoto(file: File): string | null {
  if (!VENUE_PHOTO_TYPES.includes(file.type)) return 'Choose a JPG, PNG or WebP image.';
  if (file.size > VENUE_PHOTO_MAX_BYTES) return 'The photo must be 5 MB or smaller.';
  return null;
}

/**
 * "Venue profile photo" tile for the Create/Edit venue drawer. Purely presentational state: the drawer owns what is
 * staged (`pendingFile` to upload, `pendingRemove` to clear) and applies it after the venue itself saves, so Cancel
 * discards a staged photo exactly like any other unsaved field. The saved photo is loaded through `Avatar`'s
 * authenticated blob fetch (GET /files/:id with the bearer token); a staged file shows from a local object URL.
 */
export default function VenuePhotoField({
  photoFileId,
  pendingFile,
  pendingRemove,
  disabled,
  onSelect,
  onRemove,
}: {
  photoFileId: string | null;
  pendingFile: File | null;
  pendingRemove: boolean;
  disabled?: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  // A new drawer session (different venue / create) starts without a stale message.
  useEffect(() => { setError(null); }, [photoFileId]);

  const shownFileId = pendingRemove ? null : photoFileId;
  const hasPhoto = !!pendingFile || !!shownFileId;

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = validateVenuePhoto(file);
    setError(problem);
    if (!problem) onSelect(file);
  };

  return (
    <section className="venue-photo-section" aria-labelledby="venue-photo-heading" style={{ marginBottom: 16 }}>
      <h4 id="venue-photo-heading" style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Venue profile photo</h4>
      <div className="avatar-upload">
        <Avatar
          variant="xl"
          imageKey={shownFileId}
          previewUrl={previewUrl}
          label="Venue"
          alt="Venue profile photo"
          fallback={<IconBuilding size={32} stroke={1.5} aria-hidden="true" data-testid="venue-photo-placeholder" />}
        />
        <div>
          <div className="avatar-upload-actions">
            <input
              ref={inputRef}
              type="file"
              accept={VENUE_PHOTO_TYPES.join(',')}
              aria-label="Venue profile photo file"
              style={{ display: 'none' }}
              onChange={onChange}
            />
            {hasPhoto ? (
              <>
                <button type="button" className="btn btn-outline" onClick={() => inputRef.current?.click()} disabled={disabled}>
                  Change
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => { setError(null); onRemove(); }}
                  disabled={disabled}
                >
                  Remove
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-outline" onClick={() => inputRef.current?.click()} disabled={disabled}>
                Upload photo
              </button>
            )}
          </div>
          <p className="field-hint" style={{ margin: '6px 0 0' }}>JPG, PNG or WebP · Up to 5 MB</p>
          {error && <p className="field-hint" role="alert" style={{ margin: '4px 0 0', color: 'var(--feedback-error)' }}>{error}</p>}
        </div>
      </div>
    </section>
  );
}
