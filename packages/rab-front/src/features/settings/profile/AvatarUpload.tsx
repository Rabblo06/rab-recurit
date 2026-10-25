import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import Avatar from '../../../shared/components/Avatar';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import type { CurrentProfile } from '../../../shared/hooks/useCurrentProfile';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { useUploadProgress } from '../../../shared/hooks/useUploadProgress';
import { PROFILE_PHOTO_RULE, uploadErrorOptions, uploadHint, validateUploadFile } from '../../../shared/lib/upload';
import { applyConfirmedProfile } from './profile-cache';

/** Generous ceiling for a 10 MB upload on a slow link; past it the user gets "took too long" instead of a spinner forever. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Settings → Profile → Profile photo. `POST /profile/avatar` (multipart `file`) and `DELETE /profile/avatar` both answer
 * with the updated profile, which is written straight into the shared `['profile']` cache (sidebar, onboarding and this
 * page all read it) before a background refetch. The type/size check before sending mirrors the server's real rules
 * (`PROFILE_PHOTO_RULE`); the server still re-checks the bytes and its answer is what the user is told.
 */
export default function AvatarUpload({ avatarKey, firstName }: { avatarKey: string | null; firstName?: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const progress = useUploadProgress('photo');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const applyProfile = (profile: CurrentProfile | undefined) => applyConfirmedProfile(qc, profile);

  const upload = useFeedbackMutation<CurrentProfile, File>({
    mutationFn: async (file) => {
      const form = new FormData();
      form.append('file', file);
      progress.begin(); // also covers "Try again", which re-submits without a new pick
      const res = await api.post<CurrentProfile>('/profile/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: progress.onUploadProgress,
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return res.data;
    },
    successMessage: 'Profile photo updated.',
    errorFeedback: uploadErrorOptions(PROFILE_PHOTO_RULE),
    onSuccess: (profile) => applyProfile(profile),
    onSettled: () => progress.end(),
  });

  const remove = useFeedbackMutation<CurrentProfile>({
    mutationFn: async () => (await api.delete<CurrentProfile>('/profile/avatar')).data,
    successMessage: 'Profile photo removed.',
    errorFeedback: { fallback: 'Could not remove your profile photo. Please try again.' },
    onSuccess: (profile) => applyProfile(profile),
    onSettled: () => setConfirmRemove(false),
  });

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const rejection = validateUploadFile(file, PROFILE_PHOTO_RULE);
    if (rejection) {
      toast.error(rejection.message);
      return;
    }
    if (upload.submit(file)) progress.begin();
  }

  const working = upload.busy || remove.busy;

  return (
    <div className="avatar-upload">
      <Avatar imageKey={avatarKey} label={firstName ?? '·'} alt="Avatar" />
      <div className="avatar-upload-actions">
        <h3>Profile photo</h3>
        <p>{uploadHint(PROFILE_PHOTO_RULE)}</p>
        <input
          ref={inputRef}
          type="file"
          accept={PROFILE_PHOTO_RULE.mimeTypes.filter((t) => t !== 'image/jpg').join(',')}
          style={{ display: 'none' }}
          onChange={onFileSelected}
          aria-label="Choose a profile photo"
          tabIndex={-1}
        />
        <button type="button" className="btn btn-outline" onClick={() => inputRef.current?.click()} disabled={working} aria-busy={upload.busy || undefined}>
          {upload.busy ? progress.label || 'Uploading…' : 'Upload photo'}
        </button>
        {avatarKey && (
          <button type="button" className="btn btn-outline" onClick={() => setConfirmRemove(true)} disabled={working} aria-busy={remove.busy || undefined}>
            {remove.busy ? 'Removing…' : 'Remove'}
          </button>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">{progress.announcement}</span>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove your profile photo?"
        description="Your initials will be shown instead until you upload a new photo."
        confirmLabel="Remove photo"
        destructive
        loading={remove.busy}
        onConfirm={() => remove.submit()}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
