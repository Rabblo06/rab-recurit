import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconChevronRight, IconPlus, IconAdjustments, IconDatabase } from '@tabler/icons-react';
import { toast } from '../../../shared/lib/toast';
import { ROLES_LIST_PATH, RoleIcon, useRoleEditor } from './RoleEditorLayout';
import { apiError, countConditions, effectiveRead, isFieldVisible, ObjectMeta, roleApi } from './roleEditorModel';

import RoleAccessSelect from './RoleAccessSelect';
import './role-v2.css';

type Tab = 'permissions' | 'settings';

/** The role editor's main view: exactly two tabs, Permissions and Settings (no Assignment tab — members get roles in Team / Invite). */
export default function RoleEditorMain() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'settings' ? 'settings' : 'permissions';
  return (
    <>
      <nav className="member-tabs role-editor-tabs" aria-label="Role sections">
        {([['permissions', 'Permissions'], ['settings', 'Settings']] as const).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={tab === value ? 'active' : ''}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => setParams(value === 'permissions' ? {} : { tab: value }, { replace: true })}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'permissions' ? <PermissionsTab /> : <SettingsTab />}
    </>
  );
}

/** One permission row: label (and optional hint) on the left, control on the right — the reference's row shape. */
function PermissionRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="role-row">
      <span className="role-row-label">
        {label}
        {hint && <span className="role-row-hint">{hint}</span>}
      </span>
      <span className="role-row-control">{children}</span>
    </div>
  );
}

function PermissionsTab() {
  const { draft, setDraft, readOnly, metadata, basePath, definition } = useRoleEditor();
  const reason = metadata.objects[0]?.unsupportedReason ?? 'Workspace members have read-only access.';
  const anyGrantable = metadata.objects.some((o) => o.grantable);

  if (readOnly && definition) {
    return (
      <section className="role-section">
        <h3>Permissions</h3>
        <p className="role-section-description">This system role holds these permissions across the organisation. It can’t be changed here.</p>
        <ul className="role-permission-keys">
          {definition.permissionKeys.length ? definition.permissionKeys.map((key) => <li key={key}><code>{key}</code></li>) : <li>No permissions.</li>}
        </ul>
      </section>
    );
  }

  // "All Objects" can only ever turn on what members may actually have (See). Edit/Delete/Destroy are never offered.
  const setAll = (on: boolean) => setDraft((d) => ({ ...d, readAllObjects: on }));
  const allDisabled = readOnly || (!draft.readAllObjects && !anyGrantable);
  const allTitle = !anyGrantable ? 'You can only grant access you have yourself.' : undefined;

  return (
    <>
      <section className="role-section">
        <h3>Objects</h3>
        <p className="role-section-description">Objects and fields permissions settings</p>
        <div className="role-baseline-card">
          <IconDatabase size={22} aria-hidden="true" />
          <span><strong>All objects</strong><small>Applies to all objects before overrides</small></span>
          <RoleAccessSelect label="All objects access" value={draft.readAllObjects ? 'grant' : 'deny'} disabled={allDisabled} canGrant={anyGrantable} onChange={(value) => setAll(value === 'grant')} />
        </div>
        <p className="role-footnote">{reason}</p>
      </section>

      <section className="role-section">
        <h3>Overrides</h3>
        {draft.objects.length === 0 ? (
          <p className="role-section-description">No permissions have been set for individual objects.</p>
        ) : (
          <ul className="role-rule-list">
            {draft.objects.map((rule) => {
              const object = metadata.objects.find((o) => o.key === rule.object)!;
              return (
                <li key={rule.object}>
                  <div className="role-rule role-v2-rule">
                    <RoleIcon name={object.icon} size={16} />
                    <Link className="role-rule-main" to={`${basePath}/objects/${rule.object}`}>
                      <span className="role-rule-name">{object.labelPlural}</span>
                      <span className="role-rule-summary">{ruleSummary(rule, object, effectiveRead(draft, rule.object))}</span>
                    </Link>
                    <RoleAccessSelect label={`${object.labelPlural} access`} value={rule.read} canGrant={object.grantable} disabled={readOnly}
                      onChange={(read) => setDraft(d => ({ ...d, objects: d.objects.map(item => item.object === rule.object ? { ...item, read } : item) }))} />
                    <Link className="role-advanced-link" aria-label={`Advanced ${object.labelPlural} permissions`} to={`${basePath}/objects/${rule.object}`}><IconAdjustments size={15} /></Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!readOnly && draft.objects.length < metadata.objects.length && (
          <Link className="btn btn-outline role-add-rule" to={`${basePath}/objects`}><IconPlus size={13} />Add rule</Link>
        )}
      </section>

      <section className="role-section">
        <h3>Settings</h3>
        <p className="role-section-description">Settings permissions</p>
        <PermissionRow label="Settings All Access" hint="Workspace settings permissions are not configurable for member roles.">
          <span className="role-switch" role="switch" aria-checked="false" aria-disabled="true" aria-label="Settings All Access (not available)" />
        </PermissionRow>
        <div className="role-preview-list" aria-label="Unavailable settings permissions">
          {['Accounts', 'Workspace', 'Users', 'Roles', 'Security settings'].map(label => <label key={label}><span>{label}</span><span>Unavailable</span><input type="checkbox" disabled aria-label={`${label} settings access unavailable`} /></label>)}
        </div>
      </section>

      <section className="role-section">
        <h3>Actions</h3>
        <p className="role-section-description">Actions available to workspace members</p>
        <PermissionRow label="General All Access" hint="Additional actions are unavailable for member roles.">
          <span className="role-switch" role="switch" aria-checked="false" aria-disabled="true" aria-label="General All Access (not available)" />
        </PermissionRow>
        <div className="role-preview-list" aria-label="Unavailable actions">
          {['Create views', 'Export records'].map(label => <label key={label}><span>{label}</span><span>Unavailable</span><input type="checkbox" disabled aria-label={`${label} unavailable`} /></label>)}
        </div>
      </section>
    </>
  );
}

function ruleSummary(rule: { read: string; fields: Record<string, string>; recordFilter: unknown }, object: ObjectMeta, visible: boolean): string {
  const parts: string[] = [];
  parts.push(rule.read === 'inherit' ? `See: follows All Objects (${visible ? 'yes' : 'no'})` : rule.read === 'grant' ? 'See: granted' : 'See: denied');
  if (visible) {
    const hidden = object.fields.filter((f) => !isFieldVisible(rule as never, f)).length;
    if (hidden) parts.push(`${hidden} hidden field${hidden === 1 ? '' : 's'}`);
    const conditions = countConditions(rule.recordFilter as never);
    if (conditions) parts.push(`${conditions} record filter${conditions === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

function SettingsTab() {
  const { draft, setDraft, readOnly, metadata, roleId, dirty } = useRoleEditor();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => roleApi.remove(roleId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void qc.invalidateQueries({ queryKey: ['member-invitations', 'assignable-roles'] });
      toast.success('Role deleted.');
      navigate(ROLES_LIST_PATH);
    },
    onError: (err) => setDeleteError(apiError(err, 'This role could not be deleted.')),
  });

  return (
    <>
      <section className="role-section role-settings">
        <div className="role-settings-name">
          <div className="role-icon-picker" role="radiogroup" aria-label="Icon">
            {metadata.icons.map((icon) => (
              <button
                type="button"
                key={icon}
                role="radio"
                aria-checked={draft.icon === icon}
                aria-label={icon}
                className={draft.icon === icon ? 'selected' : ''}
                disabled={readOnly}
                onClick={() => setDraft((d) => ({ ...d, icon }))}
              >
                <RoleIcon name={icon} size={14} />
              </button>
            ))}
          </div>
          <label className="visually-hidden" htmlFor="role-name">Name</label>
          <input
            id="role-name"
            className="form-input role-settings-name-input"
            maxLength={80}
            placeholder="Untitled role"
            value={draft.name}
            disabled={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <label className="visually-hidden" htmlFor="role-description">Description</label>
        <textarea
          id="role-description"
          className="form-input"
          rows={2}
          maxLength={500}
          placeholder="Write a description"
          value={draft.description}
          disabled={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
        />
      </section>

      <section className="role-section">
        <h3>Applicability</h3>
        <p className="role-section-description">Control which types of entities this role can be assigned to</p>
        <PermissionRow label="Assignable to Workspace Members" hint="When off, the role isn’t offered in Invite or Team. People who already have it keep it.">
          <input
            type="checkbox"
            aria-label="Assignable to Workspace Members"
            checked={draft.assignableToMembers}
            disabled={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, assignableToMembers: e.target.checked }))}
          />
        </PermissionRow>
      </section>

      {roleId && !readOnly && (
        <section className="role-section role-danger">
          <h3>Delete role</h3>
          <p className="role-section-description">A role can only be deleted when no member has it and no invitation uses it. Move members to another role first.</p>
          {deleteError && <div role="alert" className="role-editor-error feedback-error">{deleteError}</div>}
          <button
            type="button"
            className="btn btn-outline role-delete"
            disabled={remove.isPending}
            onClick={() => {
              setDeleteError(null);
              if (dirty && !window.confirm('You have unsaved changes. Delete this role anyway?')) return;
              if (window.confirm(`Delete the role “${draft.name}”? This cannot be undone.`)) remove.mutate();
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete role'}
          </button>
        </section>
      )}
    </>
  );
}
