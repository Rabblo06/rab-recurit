export const EmploymentStatus = {
  PENDING_COMPLIANCE: 'pending_compliance',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
} as const;
export type EmploymentStatusType = (typeof EmploymentStatus)[keyof typeof EmploymentStatus];

export const ManagerType = {
  INTERNAL: 'internal',
  VENUE: 'venue',
} as const;
export type ManagerTypeType = (typeof ManagerType)[keyof typeof ManagerType];

export const VenueType = {
  HOTEL: 'hotel',
  RESTAURANT: 'restaurant',
  WAREHOUSE: 'warehouse',
  EVENT: 'event',
  OTHER: 'other',
} as const;
export type VenueTypeType = (typeof VenueType)[keyof typeof VenueType];

export const VenueStatus = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const;
export type VenueStatusType = (typeof VenueStatus)[keyof typeof VenueStatus];
