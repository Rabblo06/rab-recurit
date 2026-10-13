import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconMoon, IconSun, IconDeviceDesktop, IconUserStar, IconBuildingSkyscraper, IconSettings } from '@tabler/icons-react';
import { cycleTheme, getTheme, type Theme } from '../shared/lib/theme';
import { useQuery } from '@tanstack/react-query';
import { api } from '../shared/api';

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconDeviceDesktop };
const THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };

export default function AdminDropdown({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<{roles:string[];isPlatformAdmin:boolean}>('/auth/me')).data, staleTime: 300_000 });
  const operational = me?.roles?.some(role => role === 'manager' || role === 'ceo');
  const mayInviteManager = operational && (me?.isPlatformAdmin || me?.roles.includes('ceo'));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (!open) return null;
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div ref={ref} className="dropdown-menu account-dropdown" style={{ bottom: 76, left: 16 }}>
      <button className="dropdown-item" onClick={() => setTheme(cycleTheme())}>
        <ThemeIcon size={15}/>
        Theme
        <span className="dropdown-hint">{THEME_LABEL[theme]}</span>
      </button>
      <div className="dropdown-divider"/>
      {mayInviteManager && <button className="dropdown-item" onClick={() => {
        onClose();
        document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'manager', title: 'Create manager' } }));
      }}>
        <IconUserStar size={15}/>
        New Manager
      </button>}
      {operational && <button className="dropdown-item" onClick={() => {
        onClose();
        nav('/settings/workspace/members?tab=invite');
      }}>
        <IconBuildingSkyscraper size={15}/>
        Invite venue manager
      </button>}
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => { onClose(); nav('/settings'); }}>
        <IconSettings size={15}/>
        Settings
      </button>
    </div>
  );
}
