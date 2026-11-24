import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Page-owned actions in the settings header; inline fallback for isolated pages/tests. */
export default function SettingsHeaderActions({
  children,
}: {
  children: ReactNode;
}) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setHost(document.querySelector('[data-settings-actions]'));
  }, []);
  const actions = <div className="settings-header-actions">{children}</div>;
  return host ? createPortal(actions, host) : actions;
}
