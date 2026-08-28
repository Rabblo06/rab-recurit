import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn } from '../auth/authStyles';
import AvatarPicker from './AvatarPicker';

export default function CreateProfileScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return;
    setError('');
    setSubmitting(true);
    try {
      let profileRes = await api.patch('/profile', { firstName: firstName.trim(), lastName: lastName.trim(), jobTitle: jobTitle.trim() || undefined });
      if (avatarFile) {
        const form = new FormData();
        form.append('file', avatarFile);
        profileRes = await api.post('/profile/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      const { data: workspace } = await api.post('/manager-workspaces/me/complete-onboarding');
      // Write the responses we already have straight into the cache instead
      // of invalidating and hoping a refetch happens — nothing observes
      // `['manager-workspace']`/`['profile']` while on this route (OnboardingGate
      // isn't mounted here), so `invalidateQueries` alone wouldn't actually
      // refresh the cache before `nav('/')` fires, leaving OnboardingGate to
      // read a stale pre-onboarding `null` on its next mount and bounce back
      // to Create Workspace. Setting the data directly makes it correct the
      // instant navigation happens, no round trip needed.
      qc.setQueryData(['profile'], profileRes.data);
      qc.setQueryData(['manager-workspace'], workspace);
      nav('/');
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Could not save your profile. Please try again.');
      setSubmitting(false);
    }
  }

  const canSubmit = firstName.trim().length > 0 && lastName.trim().length > 0 && !submitting;

  return (
    <div style={s.page}>
      <div style={s.overlay} />
      <motion.div style={{ ...s.modal, width: 380 }} {...fadeIn}>
        <p style={s.title}>Create profile</p>
        <p style={s.subtitle}>How you'll appear to teammates.</p>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 16 }}>
            <AvatarPicker label={firstName || '·'} onChange={setAvatarFile} />
          </div>

          <label style={s.label} htmlFor="p-first">First name</label>
          <input id="p-first" style={s.input} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />

          <label style={s.label} htmlFor="p-last">Last name</label>
          <input id="p-last" style={s.input} value={lastName} onChange={(e) => setLastName(e.target.value)} />

          <label style={s.label} htmlFor="p-title">Job title</label>
          <input id="p-title" style={s.input} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Manager" />

          {error && <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>{error}</motion.p>}

          <button type="submit" style={{ ...s.submitBtn, opacity: canSubmit ? 1 : 0.5 }} disabled={!canSubmit}>
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
