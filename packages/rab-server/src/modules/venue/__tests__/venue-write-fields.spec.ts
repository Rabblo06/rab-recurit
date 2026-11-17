import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';

import { CreateVenueDto } from '../dto/create-venue.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { UpdateVenueRoleRateDto } from '../dto/update-venue-role-rate.dto';
import { ROLE_RATE_UPDATE_FIELDS, VENUE_WRITE_FIELDS } from '../services/venue.service';

/** Every property the DTO declares to class-validator (what the HTTP ValidationPipe whitelists). */
const declared = (dto: new () => object) =>
  [...new Set(getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false).map((m) => m.propertyName))].sort();

/**
 * SF-7: the explicit field maps must track the DTOs. A field added to a DTO but not to its allow-list would be validated
 * and then silently dropped (never written); a field that must NOT be written has to be named here as an exclusion.
 */
describe('venue explicit field maps cover exactly the DTO fields (SF-7)', () => {
  it('VENUE_WRITE_FIELDS = CreateVenueDto fields = UpdateVenueDto fields (no exclusions)', () => {
    expect([...VENUE_WRITE_FIELDS].sort()).toEqual(declared(CreateVenueDto));
    expect([...VENUE_WRITE_FIELDS].sort()).toEqual(declared(UpdateVenueDto));
  });

  it('ROLE_RATE_UPDATE_FIELDS = UpdateVenueRoleRateDto fields (no exclusions)', () => {
    expect([...ROLE_RATE_UPDATE_FIELDS].sort()).toEqual(declared(UpdateVenueRoleRateDto));
  });
});
