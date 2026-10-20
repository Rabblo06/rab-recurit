import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  IconMoon, IconSun, IconDeviceDesktop, IconUserPlus, IconUserStar, IconBuildingStore, IconMailPlus, IconSettings, IconLogout,
} from '@tabler/icons-react';
import { cycleTheme, getTheme, type Theme } from '../shared/lib/theme';
import { useQuery } from '@tanstack/react-query';
import { api } from '../shared/api';
import Avatar from '../shared/components/Avatar';
import { useCurrentProfile } from '../shared/hooks/useCurrentProfile';
import { dropdown } from '../shared/motion';

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconDeviceDesktop };
const THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * Bottom-left account menu: who is signed in (real profile name, email and photo or initials), then only the actions this
 * account may take — each opening the EXISTING flow:
 *  - Add Staff → the Staff creation modal (`staff.create`).
 *  - Add venue manager → the workspace Venue Manager creation modal (`venue_manager.create`), never member invitations.
 *  - Add manager → the organisation Manager creation modal (CEO / platform admin, as before).
 *  - Invite member → Settings → Members → Invite (custom workspace members; Managers and CEOs, as on that page).
 *  - Theme (unchanged), Settings, Log out (the normal logout confirmation).
 * Visibility is presentation only; every action's own route re-checks permission. Opens upward from the trigger, closes on
 * Escape / outside click / selection and returns focus to the trigger.
 */
export default function AdminDropdown({ open, onClose, onLogout, triggerRef }: {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<{ roles: string[]; isPlatformAdmin: boolean }>('/auth/me')).data, staleTime: 300_000 });
  const { data: profile } = useCurrentProfile();
  const operational = !!me?.roles?.some((role) => role === 'manager' || role === 'ceo');
  const mayCreateManager = operational && !!(me?.isPlatformAdmin || me?.roles.includes('ceo'));
  const { data: caps } = useQuery({
    queryKey: ['auth', 'capabilities'],
    enabled: open && operational,
    queryFn: async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,
    staleTime: 300_000,
  });
  const mayAddStaff = operational && caps?.['staff.create'] === true;
  const mayAddVenueManager = operational && !mayCreateManager && caps?.['venue_manager.create'] === true;
  const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ');

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus) triggerRef?.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    requestAnimationFrame(() => items()[0]?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The trigger toggles the menu itself; treating its mousedown as "outside" would close-then-reopen it.
      if (ref.current?.contains(t) || triggerRef?.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const ThemeIcon = THEME_ICON[theme];
  const run = (action: () => void) => () => { close(false); action(); };
  const openCreate = (detail: Record<string, string>) => document.dispatchEvent(new CustomEvent('open-create-user', { detail }));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          className="dropdown-menu account-dropdown"
          role="menu"
          aria-label="Account"
          custom={1}
          variants={dropdown}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <div className="account-menu-header">
            <Avatar imageKey={profile?.avatarKey} label={fullName || 'Account'} variant="sidebar" alt={fullName || 'Account'} />
            <div>
              <p className="account-menu-name">{fullName || 'Your account'}</p>
              {profile?.email && <p className="account-menu-email">{profile.email}</p>}
            </div>
          </div>
          <div className="dropdown-divider" />
          {mayAddStaff && (
            <button role="menuitem" className="dropdown-item" onClick={run(() => openCreate({ role: 'staff' }))}>
              <IconUserPlus size={17} stroke={1.6} />Add Staff
            </button>
          )}
          {mayAddVenueManager && (
            <button role="menuitem" className="dropdown-item" onClick={run(() => openCreate({ role: 'manager', scope: 'workspace' }))}>
              <IconBuildingStore size={17} stroke={1.6} />Add venue manager
            </button>
          )}
          {mayCreateManager && (
            <button role="menuitem" className="dropdown-item" onClick={run(() => openCreate({ role: 'manager', title: 'Create manager' }))}>
              <IconUserStar size={17} stroke={1.6} />Add manager
            </button>
          )}
          {operational && (
            <button role="menuitem" className="dropdown-item" onClick={run(() => nav('/settings/workspace/members?tab=invite'))}>
              <IconMailPlus size={17} stroke={1.6} />Invite member
            </button>
          )}
          {operational && <div className="dropdown-divider" />}
          <button role="menuitem" className="dropdown-item" onClick={() => setTheme(cycleTheme())}>
            <ThemeIcon size={17} stroke={1.6} />Theme<span className="dropdown-hint">{THEME_LABEL[theme]}</span>
          </button>
          <button role="menuitem" className="dropdown-item" onClick={run(() => nav('/settings'))}>
            <IconSettings size={17} stroke={1.6} />Settings
          </button>
          <button role="menuitem" className="dropdown-item" onClick={run(onLogout)}>
            <IconLogout size={17} stroke={1.6} />Log out
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
