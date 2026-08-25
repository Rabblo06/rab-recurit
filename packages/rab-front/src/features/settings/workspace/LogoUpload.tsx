import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';

export default function LogoUpload({ logoKey }: { logoKey: string | null }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete('/workspace/logo'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace'] });
      toast.success('Logo removed.');
    },
    onError: () => toast.error('Could not remove the logo.'),
  });

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post('/workspace/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      qc.invalidateQueries({ queryKey: ['workspace'] });
      toast.success('Logo updated.');
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? 'Could not upload that file.');
    } finally {
      setUploading(false);
    }
  }

  const src = logoKey ? `${api.defaults.baseURL}/files/${logoKey}` : undefined;

  return (
    <div className="avatar-upload">
      <div className="avatar-upload-preview">{src ? <img src={src} alt="Workspace logo" /> : 'R'}</div>
      <div className="avatar-upload-actions">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onFileSelected} />
        <button className="btn btn-outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {logoKey && (
          <button className="btn btn-outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
