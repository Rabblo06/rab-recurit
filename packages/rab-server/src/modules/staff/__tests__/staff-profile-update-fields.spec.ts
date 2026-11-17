import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';

import { UpdateStaffDto } from '../dto/update-staff.dto';
import { STAFF_PROFILE_UPDATE_FIELDS } from '../services/staff.service';

/**
 * SF-7: STAFF_PROFILE_UPDATE_FIELDS must track UpdateStaffDto. A new DTO field missing from the allow-list would be
 * validated and then silently dropped; the only named exclusions are the three fields `update()` writes to core."user".
 */
describe('StaffService.update explicit field map covers the DTO (SF-7)', () => {
  const USER_TABLE_FIELDS = ['firstName', 'lastName', 'phone'];

  it('STAFF_PROFILE_UPDATE_FIELDS = UpdateStaffDto fields minus the core."user" fields', () => {
    const declared = [...new Set(getMetadataStorage().getTargetValidationMetadatas(UpdateStaffDto, '', true, false).map((m) => m.propertyName))];
    expect([...STAFF_PROFILE_UPDATE_FIELDS].sort()).toEqual(declared.filter((f) => !USER_TABLE_FIELDS.includes(f)).sort());
    expect(USER_TABLE_FIELDS.every((f) => declared.includes(f))).toBe(true);
  });
});
