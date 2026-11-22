/**
 * Identity and access tables the platform machinery reads and writes: organisations, users, roles and permissions,
 * sessions and tokens, invitations, the email outbox and the audit log. They live under engine/ because engine
 * services (auth, permissions, audit, email, platform admin, user deletion) need them and engine/ never imports
 * modules/ (CLAUDE.md). modules/identity/entities re-exports this barrel, so domain code keeps its import path.
 */
export * from './organisation.entity';
export * from './user.entity';
export * from './role.entity';
export * from './permission.entity';
export * from './role-permission.entity';
export * from './user-role.entity';
export * from './user-permission-override.entity';
export * from './refresh-token.entity';
export * from './login-history.entity';
export * from './password-reset-token.entity';
export * from './audit-log.entity';
export * from './platform-admin.entity';
export * from './platform-config.entity';
export * from './admin-inspect-session.entity';
export * from './account-invite.entity';
export * from './member-invitation.entity';
export * from './email-outbox.entity';
export * from './user-session.entity';
