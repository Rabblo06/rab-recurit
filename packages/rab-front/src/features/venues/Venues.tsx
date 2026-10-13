import { useRecordSelection } from '../../shared/table-toolbar/useRecordSelection';
import { ListViewSelect, RecordFooter, ListError } from '../../shared/table-toolbar/ListPresentation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArchive, IconPencil, IconPlus } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface Venue {
  id: string;
  name: string;
  clientName: string | null;
  type: string;
  address: { line1?: string; city?: string; postcode?: string };
  instructions: string | null;
  breakPaid: boolean;
  status: string;
}

// Real VenueStatus/VenueType values (@rab/shared) — never invented.
const VENUES_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'venues',
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'archived', label: 'Archived' },
      ],
    },
    {
      key: 'type',
      label: 'Type',
      type: 'select',
      options: [
        { value: 'hotel', label: 'Hotel' },
        { value: 'restaurant', label: 'Restaurant' },
        { value: 'warehouse', label: 'Warehouse' },
        { value: 'event', label: 'Event' },
        { value: 'other', label: 'Other' },
      ],
    },
  ],
  sorts: [
    { key: 'name', label: 'Name', directions: ['asc', 'desc'], directionLabels: { asc: 'A–Z', desc: 'Z–A' } },
    { key: 'createdAt', label: 'Created', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'venue', label: 'Venue', hideable: false },
    { key: 'address', label: 'Address', hideable: true },
    { key: 'client', label: 'Client', hideable: true },
    { key: 'type', label: 'Type', hideable: true },
  ],
  defaultSort: { key: 'name', direction: 'asc' },
  // Reference landing view: All. Active and archived remain explicit server-side filters.
  defaultFilters: {},
};

function editVenue(venue: Venue) {
  document.dispatchEvent(new CustomEvent('open-edit-venue', { detail: { venue } }));
}
function openCreateVenue() {
  document.dispatchEvent(new CustomEvent('open-create-venue'));
}

export default function Venues() {
  const qc = useQueryClient();
  const config = VENUES_TABLE_CONFIG;
  const { search, filters, sort, page, setPage, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { page, q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction };
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['venues', params],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[]; total: number }>('/venues', { params }); return data; },
  });
  const venues = data?.data ?? [];
  const selection = useRecordSelection(venues.map(row=>row.id));
  const total = data?.total ?? 0;

  // Venues are archived, never deleted (rab-workforce-architecture.md §13
  // edge cases — shifts and history keep referencing a venue after it stops
  // taking new bookings).
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/venues/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = Boolean(search) || Object.keys(filters).some((k) => k !== 'status' && filters[k]) || Boolean(filters.status);

  return (
    <div className="page">
      <PageHeader title="Venues" action={<button className="btn btn-dark" onClick={openCreateVenue}>
            <IconPlus size={14}/> New venue
          </button>} />

      <div className="list-tabs-row">
        {[{value:'',label:'All venues'}, {value:'active',label:'Active'}, {value:'archived',label:'Archived'}].map(view => <button key={view.value} className={`tab-link ${(filters.status ?? '') === view.value ? 'active' : ''}`} onClick={() => setFilters({...filters, status:view.value})}>{view.label}{(filters.status ?? '') === view.value && <span className="tab-count"> · {total}</span>}</button>)}
      </div>

      <div className="list-toolbar-row">
        <ListViewSelect label="Venues view" value={filters.status ?? ''} options={[{value:'', label:'All venues'}, ...(config.filters.find(f => f.key === 'status')?.options ?? [])]} onChange={status => setFilters({...filters, status})} />
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {selection.summary}
          <TableViewControls
            config={config}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            activeFilterCount={activeFilterCount}
            columnVisibility={columnVisibility}
          />
        </div>
      </div>

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? (
          <TableSkeleton columns={5} />
        ) : isError ? <ListError retry={refetch} /> : (
          <table className="table venues-table">
            <thead>
              <tr>
                <th className="checkbox-col">{selection.allCheckbox}</th>
                {isVisible('venue') && <th style={{ width: 'auto' }}>Venue</th>}
                {isVisible('address') && <th>Address</th>}
                {isVisible('client') && <th>Client</th>}
                {isVisible('type') && <th>Type</th>}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {venues.map((v) => (
                <tr key={v.id} className={selection.isSelected(v.id) ? "row-selected" : undefined}>
                  <td className="checkbox-col" onClick={e=>e.stopPropagation()}>{selection.checkbox(v.id,v.name)}</td>
                  {isVisible('venue') && (
                    <td style={{ width: 'auto' }}>
                      <span className="record-chip">
                        <span className="mini-avatar" style={{ background: '#fdded9', color: '#d93025' }}>{v.name?.[0]}</span>
                        {v.name}
                      </span>
                    </td>
                  )}
                  {isVisible('address') && <td className="cell-muted">{[v.address?.line1, v.address?.city, v.address?.postcode].filter(Boolean).join(', ') || '–'}</td>}
                  {isVisible('client') && <td className="cell-muted">{v.clientName ?? '–'}</td>}
                  {isVisible('type') && <td><span className="badge badge-active">{v.type}</span></td>}
                  <td>
                    <div className="row-actions">
                      <button className="btn-icon" title="Edit" onClick={() => editVenue(v)}><IconPencil size={14}/></button>
                      <button className="btn-icon danger" title="Archive" onClick={() => archive.mutate(v.id)}><IconArchive size={14}/></button>
                    </div>
                  </td>
                </tr>
              ))}
              {venues.length === 0 && (
                <tr><td colSpan={6}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="venues" title="Make room for your first venue" description="Add a venue to begin scheduling shifts." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
<RecordFooter total={total} page={page} onPage={setPage} />
    </div>
  );
}
