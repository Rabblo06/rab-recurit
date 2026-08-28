import { useEffect, useRef, useState } from 'react';
import Avatar from '../../shared/components/Avatar';
import { toast } from '../../shared/lib/toast';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Local-file-only picker for onboarding — no network call happens here (the
 * workspace/profile row doesn't exist yet when this renders). The parent
 * screen reads `file` off `onChange` and uploads it itself, after the
 * row it belongs to has actually been created.
 */
export default function AvatarPicker({ label, onChange }: { label: string; onChange: (file: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      toast.error('Only PNG, JPG and WEBP images are accepted.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('That file exceeds the 10MB limit.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    onChange(file);
  }

  function clear() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    onChange(null);
  }

  return (
    <div className="avatar-upload">
      <Avatar previewUrl={previewUrl} label={label} alt={label} />
      <div className="avatar-upload-actions">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onFileSelected} />
        <button type="button" className="btn btn-outline" onClick={() => inputRef.current?.click()}>
          {previewUrl ? 'Change' : 'Upload'}
        </button>
        {previewUrl && (
          <button type="button" className="btn btn-outline" onClick={clear}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
