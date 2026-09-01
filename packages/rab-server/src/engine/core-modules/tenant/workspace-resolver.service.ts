import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Resolves the caller's own Workspace, server-side, on every authenticated
 * request — never trusted from a JWT claim or any client-supplied value
 * (Private Workspace migration, Revision 3 §20's JWT-cutover rule). Uses
 * the same raw-`DataSource.query` pattern as every other pre-auth
 * SECURITY DEFINER call in `AuthService` (`auth_find_users_by_email` etc.)
 * — this runs from `JwtAuthGuard`, before any tenant/workspace context
 * exists to bind, so it can't go through `TenantContextService`.
 */
@Injectable()
export class WorkspaceResolverService {
  constructor(private readonly dataSource: DataSource) {}

  async resolveForUser(userId: string): Promise<string | null> {
    const [row] = await this.dataSource.query<[{ resolve_workspace_for_user: string | null }]>(
      'SELECT core.resolve_workspace_for_user($1)',
      [userId],
    );
    return row?.resolve_workspace_for_user ?? null;
  }
}
