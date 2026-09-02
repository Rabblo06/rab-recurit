export const UserStatus = {
  INVITED: 'invited',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated',
  // Terminal: the account's 3rd invitation attempt expired with no
  // activation. No normal-flow path back to INVITED — see
  // AccountInviteService's own doc comment for why an admin-recovery path
  // is deliberately not built yet.
  INVITE_EXPIRED: 'invite_expired',
} as const;

export type UserStatusType = (typeof UserStatus)[keyof typeof UserStatus];

export const PermissionOverrideEffect = {
  GRANT: 'grant',
  REVOKE: 'revoke',
} as const;

export type PermissionOverrideEffectType =
  (typeof PermissionOverrideEffect)[keyof typeof PermissionOverrideEffect];

export const OrganisationMemberStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;

export type OrganisationMemberStatusType =
  (typeof OrganisationMemberStatus)[keyof typeof OrganisationMemberStatus];
