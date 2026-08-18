import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconMoon, IconSun, IconUserStar, IconBuildingSkyscraper, IconSettings } from '@tabler/icons-react';
import { getTheme, toggleTheme, type Theme } from '../lib/theme';

export default function AdminDropdown({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());

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

  return (
    <div ref={ref} className="dropdown-menu" style={{ top: 44, left: 16 }}>
      <button className="dropdown-item" onClick={() => setTheme(toggleTheme())}>
        {theme === 'light' ? <IconMoon size={15}/> : <IconSun size={15}/>}
        Theme
        <span className="dropdown-hint">{theme === 'light' ? 'Light' : 'Dark'}</span>
      </button>
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => {
        onClose();
        document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'manager', title: 'Create manager' } }));
      }}>
        <IconUserStar size={15}/>
        New Manager
      </button>
      <button className="dropdown-item" onClick={() => {
        onClose();
        document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'manager', title: 'Create hotel manager' } }));
      }}>
        <IconBuildingSkyscraper size={15}/>
        New Hotel Manager
      </button>
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => { onClose(); nav('/settings'); }}>
        <IconSettings size={15}/>
        Settings
      </button>
    </div>
  );
}
