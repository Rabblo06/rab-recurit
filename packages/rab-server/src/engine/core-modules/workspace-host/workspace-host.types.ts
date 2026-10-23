import type { Request } from 'express';

/**
 * Wave 3 lane H — what the registry says about one host label (`core.resolve_workspace_by_host_label` /
 * `core.resolve_released_host_label`, lane S2's contract). Unknown, reserved, CREATING, FAILED and suspended are all the
 * same `unknown` on purpose: the database already collapses them to "0 rows" so no caller can tell them apart.
 */
export type HostLabelResolution =
  | { kind: 'workspace'; workspaceId: string; organisationId: string; canonicalLabel: string; displayName: string | null }
  | { kind: 'renamed'; workspaceId: string; organisationId: string; canonicalLabel: string; reservedUntil: string }
  | { kind: 'unknown' };

/** Which validated request input named the workspace host. */
export type WorkspaceHostSource = 'host' | 'origin';

/**
 * The routing context attached to every request by `WorkspaceHostMiddleware` (`req.workspaceHost`). Routing context only:
 * it never grants access and never selects a session's workspace. `WorkspaceHostConsistencyInterceptor` uses it to REFUSE
 * (never to allow) authenticated requests made from a workspace host that is not the session's own.
 */
export type WorkspaceHostContext =
  /** No workspace host addressed: routing off, the apex/app/accounts/API host, a foreign host, or no host information. */
  | { kind: 'none' }
  | {
      kind: 'workspace';
      source: WorkspaceHostSource;
      label: string;
      workspaceId: string;
      organisationId: string;
      canonicalLabel: string;
      canonicalOrigin: string;
      displayName: string | null;
    }
  /** A label released into rename quarantine; `canonicalOrigin` is built from the DB's current label + env only. */
  | { kind: 'renamed'; source: WorkspaceHostSource; label: string; canonicalOrigin: string }
  /** Under the base domain but not a routable workspace (unknown, reserved, not READY, suspended, malformed, conflicting). */
  | { kind: 'not-found'; source: WorkspaceHostSource; label: string | null }
  /** The registry could not be consulted (database/Redis failure). Treated as "refuse" for authenticated requests. */
  | { kind: 'unavailable'; source: WorkspaceHostSource; label: string };

export interface WorkspaceHostRequest extends Request {
  workspaceHost?: WorkspaceHostContext;
}

/** The public resolver's response (`GET /rest/v1/public/workspace-host`). Never carries owner, member or user data. */
export type PublicWorkspaceHostResponse =
  | { state: 'default'; defaultUrl: string; workspaceBaseDomain: string | null }
  | {
      state: 'workspace';
      defaultUrl: string;
      workspaceBaseDomain: string;
      canonicalUrl: string;
      workspace: { subdomain: string; displayName: string | null };
    }
  | { state: 'renamed'; defaultUrl: string; workspaceBaseDomain: string; canonicalUrl: string }
  | { state: 'not-found'; defaultUrl: string; workspaceBaseDomain: string };

/** Error code of the 404 an authenticated request from the wrong workspace host receives. */
export const WORKSPACE_HOST_MISMATCH = 'WORKSPACE_HOST_MISMATCH';
