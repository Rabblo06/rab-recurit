import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import '../roles/role-editor.css';

/** Explicit parents, rather than browser history, also work when settings opens directly. */
export default function MembersBreadcrumb({ current, onMembers, title }: { current?: string; onMembers?: () => void; title?: string }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector('[data-role-breadcrumb-slot]')); }, []);
  const trail = <nav className="role-editor-breadcrumb" aria-label="Breadcrumb">
    <Link to="/settings/my-workspace">Workspace</Link>
    <span aria-hidden="true">/</span>
    {current ? <>
      <Link to="/settings/workspace/members?tab=team" onClick={event => {
        // Keep the existing list search/page when returning from its detail view.
        if (onMembers) { event.preventDefault(); onMembers(); }
      }}>Members</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page" title={current}>{current}</span>
    </> : <span aria-current="page">Members</span>}
  </nav>;
  return host ? createPortal(<>{trail}<h1 className="members-header-title">{title || current || 'Members'}</h1></>, host) : trail;
}
