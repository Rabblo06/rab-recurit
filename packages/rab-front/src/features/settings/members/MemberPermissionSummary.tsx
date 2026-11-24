import { SearchField } from '../../../shared/components/arc/search-field/search-field';
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { IconEye, IconLock } from '@tabler/icons-react';
import { roleApi } from '../roles/roleEditorModel';

/** Read-only role definitions; never infer effective access or fabricate field-edit grants. */
export default function MemberPermissionSummary({ roles }: { roles: Array<{ id: string; name: string }> }) {
  const [search, setSearch] = useState('');
  const definitions = useQueries({ queries: roles.map(role => ({
    queryKey: ['member-role-summary', role.id],
    queryFn: () => roleApi.definition(role.id),
    retry: false,
  })) });
  return <section className="member-permission-summary">
    <div className="member-section-heading"><h3>Object Access</h3><p>Saved access rules for each assigned role.</p></div>
    <SearchField label="Search objects" type="text" className="form-input" aria-label="Search objects" placeholder="Search objects…" value={search} onChange={event => setSearch(event.target.value)} />
    {!roles.length && <p>No assigned role definitions are available.</p>}{definitions.some(query => query.isPending) ? <p role="status">Loading permissions…</p> : definitions.some(query => query.isError || !Array.isArray(query.data?.objects)) ? <p role="status">Open the assigned role to inspect its permissions.</p> : definitions.map((query, index) => {
      const definition = query.data!;
      const rules = definition.objects.filter(rule => rule.object.toLowerCase().includes(search.toLowerCase()));
      return <div key={roles[index].id}>
        <p className="role-footnote">{roles[index].name} · Default object access: {definition.readAllObjects ? 'Read' : 'No access'}</p>
        <table className="member-access-table"><thead><tr><th>Object</th><th>Read access</th><th>Fields</th></tr></thead><tbody>
          {rules.map(rule => <tr key={rule.object}><td><IconEye size={14} />{rule.object}</td><td>{rule.read === 'inherit' ? 'Default' : rule.read === 'grant' ? 'Allowed' : 'Denied'}{rule.recordFilter ? ' · Filtered' : ''}</td><td>{Object.values(rule.fields).some(value => value === 'hidden') ? 'Restricted' : 'Default'}</td></tr>)}
          {!rules.length && <tr><td colSpan={3}>No matching object overrides.</td></tr>}
        </tbody></table>
        <div className="member-section-heading member-settings-access"><h3>Role permissions</h3><p>Permission keys supplied by this role.</p></div>
        <table className="member-access-table"><thead><tr><th>Permission</th><th>Access</th></tr></thead><tbody>
          {definition.permissionKeys.map(key => <tr key={key}><td><IconLock size={14} />{key}</td><td>Granted</td></tr>)}
          {!definition.permissionKeys.length && <tr><td colSpan={2}>No additional permission keys.</td></tr>}
        </tbody></table>
      </div>;
    })}
  </section>;
}
