import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Image-or-first-letter avatar, used for both personal profile pictures and
 * workspace logos. Fetches the image as a blob via `api` (so the
 * Authorization header actually reaches `GET /files/*`, which a plain
 * `<img src>` never would — a bare `<img>` tag can't attach a bearer token,
 * so it silently 401s and shows nothing render-worthy) and falls back to
 * `label`'s first letter on any failure — never a broken-image icon.
 */
export default function Avatar({
  imageKey,
  previewUrl,
  label,
  alt,
  variant = 'large',
}: {
  imageKey?: string | null;
  /** A local object URL (e.g. `URL.createObjectURL(file)`) for an unsaved selection — takes priority over `imageKey`. */
  previewUrl?: string | null;
  label: string;
  alt?: string;
  variant?: 'large' | 'sidebar';
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setBlobUrl(null);
    if (previewUrl || !imageKey) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .get(`/files/${imageKey}`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageKey, previewUrl]);

  const src = previewUrl ?? blobUrl;
  const className = variant === 'sidebar' ? 'workspace-icon' : 'avatar-upload-preview';

  if (src && !failed) {
    return (
      <div className={className}>
        <img src={src} alt={alt ?? label} onError={() => setFailed(true)} />
      </div>
    );
  }
  return <div className={className}>{(label || '·').charAt(0).toUpperCase()}</div>;
}
