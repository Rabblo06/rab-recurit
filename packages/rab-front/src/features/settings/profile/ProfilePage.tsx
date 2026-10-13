import { useEffect, useState } from 'react';
import { IconLock } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { useCurrentProfile } from '../../../shared/hooks/useCurrentProfile';
import { clearProfileDraft, getProfileDraft, setProfileDraft } from './profile-draft';
import AvatarUpload from './AvatarUpload';
import DevicesList from './DevicesList';
import { FormSkeleton } from '../../../shared/components/LoadingState';

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: profile, isLoading } = useCurrentProfile();

  // Seeded once, synchronously, from `profile-draft.ts`'s identity-scoped store — see that
  // file's own doc comment for the remount this closes: a draft only comes back here if it was
  // written under the EXACT SAME identity (userId + the existing P0 generation epoch) this
  // mount is running under; a genuine identity transition always starts both of these from
  // their "nothing yet" defaults instead.
  const [firstName, setFirstNameState] = useState(() => getProfileDraft()?.firstName ?? '');
  const [lastName, setLastNameState] = useState(() => getProfileDraft()?.lastName ?? '');
  const [jobTitle, setJobTitleState] = useState(() => getProfileDraft()?.jobTitle ?? '');
  // `touched` is the "has the user started editing" signal the reseed effect below gates on —
  // deliberately NOT derived from "does the local value differ from the CURRENT profile", which
  // would wrongly read as "dirty" the instant an unrelated background refetch changes `profile`
  // out from under an untouched form (confirmed directly: a same-user background refetch with
  // nothing typed must still reseed, see this file's own spec). Seeded `true` when a draft was
  // restored — a remount, mid-edit, is exactly as "touched" as the instance before it.
  const [touched, setTouched] = useState(() => getProfileDraft() !== null);
  const [settingPassword, setSettingPassword] = useState(false);

  const dirty =
    touched && profile
      ? firstName !== profile.firstName || lastName !== profile.lastName || jobTitle !== (profile.jobTitle ?? '')
      : false;

  useEffect(() => {
    // Same-identity rule: a background `profile` update (first real load, or any later
    // refetch) reseeds the form ONLY while it's untouched. An in-progress edit is never
    // clobbered — whether `profile` changed because of a genuine refetch, or because this very
    // component instance is a remount of the one the user was just typing into (the draft
    // restored above already marked it `touched`, so this correctly no-ops on that remount's
    // first run too).
    if (profile && !touched) {
      setFirstNameState(profile.firstName);
      setLastNameState(profile.lastName);
      setJobTitleState(profile.jobTitle ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: fires on `profile`
    // change, reads the latest `touched` via closure, not on every keystroke.
  }, [profile]);

  function setFirstName(value: string): void {
    setFirstNameState(value);
    setTouched(true);
    setProfileDraft({ firstName: value, lastName, jobTitle });
  }
  function setLastName(value: string): void {
    setLastNameState(value);
    setTouched(true);
    setProfileDraft({ firstName, lastName: value, jobTitle });
  }
  function setJobTitle(value: string): void {
    setJobTitleState(value);
    setTouched(true);
    setProfileDraft({ firstName, lastName, jobTitle: value });
  }

  const save = useMutation({
    mutationFn: () => api.patch('/profile', { firstName, lastName, jobTitle }),
    onSuccess: () => {
      setTouched(false);
      clearProfileDraft();
      qc.invalidateQueries({ queryKey: ['profile'] });
      toast.success('Profile updated.');
    },
    onError: () => toast.error('Could not save your profile. Please try again.'),
  });

  async function setPassword() {
    if (!profile) return;
    setSettingPassword(true);
    try {
      await api.post('/auth/forgot-password', { email: profile.email });
      toast.success('Check your email for a link to set a new password.');
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setSettingPassword(false);
    }
  }

  if (isLoading) {
    return <FormSkeleton sections={4} />;
  }

  return (
    <div className="settings-page profile-settings">
      <div className="settings-page-heading"><h2>Profile</h2><p>Your personal details and how you appear to others.</p></div>
      <div className="profile-settings-grid">
        <div>
          <section className="settings-section profile-picture-card"><AvatarUpload avatarKey={profile?.avatarKey ?? null} firstName={profile?.firstName} /></section>
          <section className="settings-section personal-details-card"><h3>Personal details</h3>
            <div className="form-grid"><div className="field"><label htmlFor="profile-first">First name</label><input id="profile-first" value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
              <div className="field"><label htmlFor="profile-last">Last name</label><input id="profile-last" value={lastName} onChange={e => setLastName(e.target.value)} /></div></div>
            <div className="field"><label htmlFor="profile-job">Job title</label><input id="profile-job" value={jobTitle} onChange={e => setJobTitle(e.target.value)} placeholder="e.g. Operations manager" /></div>
            <div className="settings-save-row"><button className="btn btn-dark" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save changes'}</button></div>
          </section>
          <section className="settings-section"><h3>Email address</h3><p>The email associated with your account.</p><div className="field"><input aria-label="Email address" id="profile-email" value={profile?.email ?? ''} disabled /></div></section>
        </div>
        <div>
          <section className="settings-section password-access-card"><IconLock aria-hidden="true" className="settings-security-icon" size={22} stroke={1.5} /><h3>Password &amp; access</h3><p>Receive an email with a secure link to set your account password.</p><button className="btn btn-outline" onClick={setPassword} disabled={settingPassword}>{settingPassword ? 'Sending…' : 'Set password'}</button></section>
          <section className="settings-section"><h3>Active sessions</h3><p>Devices currently signed into your account.</p><DevicesList /></section>
          <aside className="profile-sharing-note">Your profile is shared with your workspace. Keep your details up to date so your team can reach you.</aside>
        </div>
      </div>
    </div>
  );
}
