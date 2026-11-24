import { motion, LayoutGroup, useReducedMotion } from 'framer-motion';
import { useId } from 'react';
import { spring } from '../shared/motion';
import { IconHome, IconMessageCircle, IconSettings } from '@tabler/icons-react';

export type NavigationMode = 'home' | 'ai' | 'settings';
export function navigationMode(pathname: string): NavigationMode {
  return pathname === '/chat' ? 'ai' : pathname === '/settings' || pathname.startsWith('/settings/') ? 'settings' : 'home';
}
const modes = [{ mode: 'home', label: 'Home', Icon: IconHome }, { mode: 'ai', label: 'AI', Icon: IconMessageCircle }, { mode: 'settings', label: 'Settings', Icon: IconSettings }] as const;

/** `showAi`: the AI mode appears only for a user the server confirms as eligible (GET /ai/availability). */
export default function NavigationModes({ mode, expanded, onSelect, onIntent, showAi = false }: { mode: NavigationMode; expanded: boolean; onSelect: (mode: NavigationMode) => void; /** Hover/focus: the shell preloads that mode's first page. */ onIntent?: (mode: NavigationMode) => void; showAi?: boolean }) {
  const reduced = useReducedMotion();
  const scopeId = useId();
  return <LayoutGroup id={scopeId}><div className="sidebar-shortcuts sidebar-modes" role="group" aria-label="Navigation modes">
    {modes.filter(item => item.mode !== 'ai' || showAi).map(item => {
      const selected = mode === item.mode;
      return <button key={item.mode} type="button" className={`sidebar-mode${selected ? ' active' : ''}`} aria-label={item.label} title={item.label} aria-current={selected ? 'page' : undefined} onClick={() => onSelect(item.mode)} onMouseEnter={() => onIntent?.(item.mode)} onFocus={() => onIntent?.(item.mode)}>
        {selected && (reduced ? <i className="sidebar-mode-pill" aria-hidden="true" /> : <motion.i className="sidebar-mode-pill" aria-hidden="true" layoutId="sidebar-mode-pill" transition={spring} />)}
        <item.Icon size={16} stroke={1.8}/>
        <motion.span initial={false} aria-hidden="true" animate={{ width: selected && expanded ? 'auto' : 0, opacity: selected && expanded ? 1 : 0, marginInlineStart: selected && expanded ? '6px' : '0px' }} transition={{ duration: reduced ? 0 : .2, ease: 'easeInOut' }}>{item.label}</motion.span>
      </button>;
    })}
  </div></LayoutGroup>;
}
