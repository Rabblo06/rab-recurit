import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import Avatar from '../../../shared/components/Avatar';
import { FormSkeleton } from '../../../shared/components/LoadingState';
import ManagedByPlatformAdminNotice from './ManagedByPlatformAdminNotice';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

/** The organisation's general settings — READ-ONLY since W6-E2E-04 (a platform administrator changes them). */
export default function WorkspaceGeneralPage() {
  const { data: workspace, isLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: async () => (await api.get<Workspace>('/workspace')).data,
  });

  if (isLoading || !workspace) {
    return <FormSkeleton />;
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Organisation</h3>
        <ManagedByPlatformAdminNotice />
        <div className="avatar-upload">
          <Avatar imageKey={workspace.logoKey} label={workspace.name} alt="Organisation logo" />
        </div>
        <div className="settings-row">
          <span>Name</span>
          <span style={{ color: 'var(--font-primary)' }}>{workspace.name}</span>
        </div>
        <div className="settings-row">
          <span>Timezone</span>
          <span style={{ color: 'var(--font-primary)' }}>{workspace.timezone}</span>
        </div>
        <div className="settings-row">
          <span>Identifier</span>
          <span style={{ color: 'var(--font-primary)' }}>{workspace.slug}</span>
        </div>
      </div>
    </div>
  );
}
