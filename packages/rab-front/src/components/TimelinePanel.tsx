import { useQuery } from '@tanstack/react-query';
import {
  IconX, IconTimelineEvent, IconUserPlus, IconPencil, IconTrash,
  IconChecklist, IconBuildingSkyscraper, IconMapPin, IconLogin, IconLogout, IconBolt,
} from '@tabler/icons-react';
import { api } from '../api';
import { timeAgo } from '../lib/timeAgo';
import RightSidePanel from './RightSidePanel';

const verbIcons: Record<string, { Icon: any; bg: string; color: string }> = {
  created:   { Icon: IconUserPlus, bg: '#d9f0de', color: '#2a8e44' },
  updated:   { Icon: IconPencil,   bg: '#dbe9fe', color: '#1961ed' },
  deleted:   { Icon: IconTrash,    bg: '#fdded9', color: '#d93025' },
  accepted:  { Icon: IconChecklist, bg: '#fdf2d4', color: '#946c00' },
  approved:  { Icon: IconChecklist, bg: '#d9f0de', color: '#2a8e44' },
  cancelled: { Icon: IconTrash,    bg: '#fdded9', color: '#d93025' },
  login:     { Icon: IconLogin,    bg: '#f1e6fd', color: '#7d3bc8' },
  logout:    { Icon: IconLogout,   bg: '#f1f1f1', color: '#666666' },
};

const typeIcons: Record<string, any> = {
  placement: IconBuildingSkyscraper,
  venue: IconMapPin,
  offer: IconChecklist,
};

function describe(log: any): { title: string; desc: string } {
  const [subject = '', verb = ''] = (log.action ?? '').split('.');
  const name = log.metadata?.name ?? '';
  const actor = log.actor?.fullName ?? 'Someone';
  const subjectLabel = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (subject === 'auth') {
    return {
      title: verb === 'login' ? 'Signed in' : 'Signed out',
      desc: `${name || actor} ${verb === 'login' ? 'signed in to' : 'signed out of'} the system`,
    };
  }
  const verbLabel = verb.charAt(0).toUpperCase() + verb.slice(1);
  return {
    title: `${subjectLabel} ${verbLabel}`,
    desc: name ? `${actor} ${verb} ${subject} "${name}"` : `${actor} ${verb} a ${subject}`,
  };
}

export default function TimelinePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', 'timeline'],
    queryFn: async () => {
      const { data } = await api.get('/audit-logs', { params: { page: 1, limit: 100 } });
      return data;
    },
    enabled: open,
  });

  const items = data?.items ?? [];

  return (
    <RightSidePanel open={open} onClose={onClose}>
      <div className="timeline-head">
        <IconTimelineEvent size={16}/>
        Timeline Activities
        <div style={{ flex: 1 }}/>
        <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15}/></button>
      </div>
      <div className="timeline-body">
        {isLoading ? (
          <div className="search-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="search-empty">No activity yet</div>
        ) : (
          items.map((log: any) => {
            const verb = (log.action ?? '').split('.')[1] ?? '';
            const v = verbIcons[verb] ?? { Icon: typeIcons[log.targetType] ?? IconBolt, bg: '#f1f1f1', color: '#666' };
            const { title, desc } = describe(log);
            return (
              <div key={log.id} className="timeline-item">
                <div className="timeline-icon" style={{ background: v.bg, color: v.color }}>
                  <v.Icon size={13}/>
                </div>
                <div className="timeline-content">
                  <p className="timeline-title">{title}</p>
                  <p className="timeline-desc">{desc}</p>
                  <p className="timeline-meta">
                    Performed by {log.actor?.fullName ?? 'Unknown'} • {timeAgo(log.createdAt)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </RightSidePanel>
  );
}
