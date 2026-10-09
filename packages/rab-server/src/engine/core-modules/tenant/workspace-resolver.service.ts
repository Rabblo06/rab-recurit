import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * The ONLY workspace-authority resolver for the application (Hyper Workspace Phase 3, items 5–7). It reads
 * core.workspace_membership (USER → WORKSPACE) through two SECURITY DEFINER functions. Nothing here reads
 * staff_profile or manager_profile, and nothing accepts a workspace, organisation or schema from a caller.
 *
 * - resolveForSession(sid): PROTECTED requests. The JWT's sid is checked against a live refresh-token family, and
 *   the user and organisation come from that family, never from the token's sub/org claims. Returns null when
 *   the family is not live (revoked, expired, unknown). The guard also requires sub/org to match.
 * - resolveForUser(userId): a VERIFIED user only (password checked, reset/activation token consumed, refresh-token
 *   row read, or an inspect target already authorised). Never a client-supplied id.
 *
 * Both return the workspace id, or null when the user has no ACTIVE membership. The caller decides what null means.
 */
export interface SessionRouting {
  userId: string;
  organisationId: string;
  workspaceId: string | null;
}

@Injectable()
export class WorkspaceResolverService {
  constructor(private readonly dataSource: DataSource) {}

  async resolveForUser(userId: string): Promise<string | null> {
    const [row] = await this.dataSource.query<Array<{ workspace_id: string | null }>>(
      'SELECT workspace_id FROM core.resolve_membership_for_user($1)',
      [userId],
    );
    return row?.workspace_id ?? null;
  }

  async resolveForSession(sid: string): Promise<SessionRouting | null> {
    const [row] = await this.dataSource.query<Array<{ user_id: string; organisation_id: string; workspace_id: string | null }>>(
      'SELECT user_id, organisation_id, workspace_id FROM core.resolve_membership_for_session($1)',
      [sid],
    );
    if (!row) return null;
    return { userId: row.user_id, organisationId: row.organisation_id, workspaceId: row.workspace_id ?? null };
  }
}
