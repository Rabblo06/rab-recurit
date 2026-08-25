import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import AvatarUpload from './AvatarUpload';
import DevicesList from './DevicesList';

interface Profile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarKey: string | null;
}

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await api.get<Profile>('/profile')).data,
  });

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);

  useEffect(() => {
    if (profile) {
      setFirstName(profile.firstName);
      setLastName(profile.lastName);
    }
  }, [profile]);

  const dirty = profile ? (firstName !== profile.firstName || lastName !== profile.lastName) : false;

  const save = useMutation({
    mutationFn: () => api.patch('/profile', { firstName, lastName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['me'] });
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
    return <div className="settings-page"><p className="muted">Loading…</p></div>;
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Picture</h3>
        <p>We support square PNGs, JPGs and WEBPs under 10MB.</p>
        <AvatarUpload avatarKey={profile?.avatarKey ?? null} firstName={profile?.firstName} />
      </div>

      <div className="settings-section">
        <h3>Name</h3>
        <p>Your name as it will be displayed.</p>
        <div className="form-grid">
          <div className="field">
            <label>First Name</label>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="field">
            <label>Last Name</label>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-dark" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Email</h3>
        <p>The email associated with your account.</p>
        <div className="field">
          <input value={profile?.email ?? ''} disabled />
        </div>
      </div>

      <div className="settings-section">
        <h3>Set Password</h3>
        <p>Receive an email containing a password set link.</p>
        <button className="btn btn-outline" onClick={setPassword} disabled={settingPassword}>
          {settingPassword ? 'Sending…' : 'Set Password'}
        </button>
      </div>

      <div className="settings-section">
        <h3>Devices</h3>
        <p>Devices with an active session on your account.</p>
        <DevicesList />
      </div>
    </div>
  );
}
