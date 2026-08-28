import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import Avatar from '../../../shared/components/Avatar';

export default function LogoUpload({ logoKey, name = 'Workspace' }: { logoKey: string | null; name?: string }) {
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

  return (
    <div className="avatar-upload">
      <Avatar imageKey={logoKey} label={name} alt="Workspace logo" />
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
