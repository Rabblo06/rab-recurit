import { IconUsersPlus, IconX } from '@tabler/icons-react';
import type { RequestedStaff } from './StaffSelectionPage';

/**
 * The drawer side of the full-page staff picker: a "Select staff" button and the staff chosen there. Selecting happens
 * in `StaffSelectionPage` (draft mode); this only shows and trims the result. Nothing is sent until the drawer's own
 * Send action.
 */
export default function SelectedStaffField({ staff, onOpenPicker, onChange, error }: {
  staff: RequestedStaff[];
  onOpenPicker: () => void;
  onChange: (staff: RequestedStaff[]) => void;
  error?: React.ReactNode;
}) {
  return (
    <div className="field field-full selected-staff-field">
      <label>Staff members</label>
      <div className="selected-staff-toolbar">
        <button type="button" className="btn btn-outline" onClick={onOpenPicker}>
          <IconUsersPlus size={14} /> {staff.length ? 'Change staff' : 'Select staff'}
        </button>
        <span className="selected-staff-count" role="status">{staff.length} staff selected</span>
        {staff.length > 0 && <button type="button" className="btn-link-muted" onClick={() => onChange([])}>Clear all</button>}
      </div>
      {staff.length > 0 && (
        <ul className="selected-staff-list" aria-label="Selected staff">
          {staff.map((s) => (
            <li key={s.staffProfileId}>
              <span className="mini-avatar" aria-hidden="true">{s.firstName[0]}</span>
              <span className="selected-staff-text">
                <span className="selected-staff-name">{s.firstName} {s.lastName}</span>
                <span className="selected-staff-email">{s.email}</span>
              </span>
              <button type="button" className="btn-icon" aria-label={`Remove ${s.firstName} ${s.lastName}`}
                onClick={() => onChange(staff.filter((x) => x.staffProfileId !== s.staffProfileId))}>
                <IconX size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error}
    </div>
  );
}
