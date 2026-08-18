export const UserStatus = {
  INVITED: 'invited',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated',
} as const;

export type UserStatusType = (typeof UserStatus)[keyof typeof UserStatus];

export const PermissionOverrideEffect = {
  GRANT: 'grant',
  REVOKE: 'revoke',
} as const;

export type PermissionOverrideEffectType =
  (typeof PermissionOverrideEffect)[keyof typeof PermissionOverrideEffect];
