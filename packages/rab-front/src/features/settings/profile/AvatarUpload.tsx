import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';

export default function AvatarUpload({ avatarKey, firstName }: { avatarKey: string | null; firstName?: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  };

  const remove = useMutation({
    mutationFn: () => api.delete('/profile/avatar'),
    onSuccess: () => {
      invalidate();
      toast.success('Picture removed.');
    },
    onError: () => toast.error('Could not remove your picture.'),
  });

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post('/profile/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      invalidate();
      toast.success('Picture updated.');
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? 'Could not upload that file.');
    } finally {
      setUploading(false);
    }
  }

  const src = avatarKey ? `${api.defaults.baseURL}/files/${avatarKey}` : undefined;

  return (
    <div className="avatar-upload">
      <div className="avatar-upload-preview">
        {src ? <img src={src} alt="Avatar" /> : (firstName?.charAt(0) ?? '·')}
      </div>
      <div className="avatar-upload-actions">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onFileSelected} />
        <button className="btn btn-outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {avatarKey && (
          <button className="btn btn-outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
