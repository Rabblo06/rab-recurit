import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User, UserNote } from '../entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';

export interface UserNoteItem {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: Date;
}

/**
 * Shared by the Staff and Manager detail panels' "Note" tab — the caller
 * (`StaffService`/`ManagerService`) has already resolved and authorized the
 * subject profile before reaching here, so this trusts `subjectUserId` as
 * given and only adds the organisation-tenant boundary. Takes an
 * already-open, tenant-bound `EntityManager` so a note write lands in the
 * same transaction as whatever authorization check preceded it — same
 * convention `AuditService.record` uses.
 */
@Injectable()
export class UserNoteService {
  constructor(private readonly env: EnvironmentService) {}

  async list(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'workspaceId'>, subjectUserId: string): Promise<UserNoteItem[]> {
    // Workspace-private in HWS mode (V1 difference from legacy core.user_note): filtered here too, not only by RLS — the
    // service-level layer (CLAUDE.md §5.2) must not depend on the policy alone. Legacy `core.user_note` has no
    // `workspace_id` column at all (the entity's own doc comment), so this predicate is only added when HWS runtime mode
    // is actually resolving to the physical, workspace_id-NOT-NULL table — unconditionally adding it broke every legacy
    // deployment (found live: a real `QueryFailedError`, not a theoretical gap).
    const qb = manager
      .createQueryBuilder(UserNote, 'n')
      .leftJoin(User, 'a', 'a.id = n.author_user_id')
      .where('n.organisation_id = :orgId', { orgId: ctx.organisationId })
      .andWhere('n.subject_user_id = :subjectUserId', { subjectUserId });
    if (this.env.get('HWS_RUNTIME_ENABLED')) qb.andWhere('n.workspace_id = :workspaceId', { workspaceId: ctx.workspaceId });
    const rows = await qb
      .select(['n.id AS id', 'n.body AS body', 'n.created_at AS "createdAt"', 'a.first_name AS "authorFirstName"', 'a.last_name AS "authorLastName"'])
      .orderBy('n.created_at', 'DESC')
      .getRawMany<{ id: string; body: string; createdAt: Date; authorFirstName: string | null; authorLastName: string | null }>();

    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      authorName: r.authorFirstName ? `${r.authorFirstName} ${r.authorLastName ?? ''}`.trim() : null,
    }));
  }

  async add(
    manager: EntityManager,
    ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'workspaceId'>,
    subjectUserId: string,
    body: string,
  ): Promise<UserNoteItem> {
    // workspace_id comes only from the verified session context (never the request body, never the subject's own
    // profile) — the same rule every other workspace write in HWS mode follows. A workspace-less caller cannot write a
    // note at all in that mode: the physical table's workspace_id is NOT NULL, so this fails closed rather than
    // attempting a write the database would refuse anyway. In legacy mode `core.user_note` has no such column or
    // constraint (the entity's own doc comment) and a workspace-less actor (CEO/platform admin) is a real, valid
    // caller — found live via a real `QueryFailedError` ("column workspace_id of relation user_note does not exist")
    // when this check and insert were unconditional, which would have 500'd this path on every legacy deployment,
    // including production (still pre-HWS-cutover as of this writing).
    const hwsRuntime = this.env.get('HWS_RUNTIME_ENABLED');
    if (hwsRuntime && !ctx.workspaceId) throw new ConflictException('A workspace is required to add a note.');
    // Plain `manager.insert(UserNote, {...})` was tried first and does NOT work here: TypeORM builds the INSERT from
    // the entity's full column metadata regardless of which keys the partial object supplies, substituting DEFAULT
    // for anything omitted — so `workspace_id` still appeared in the generated SQL even with the key left out of the
    // JS object above, still 500ing against the column-less legacy table (confirmed live, not assumed). Raw SQL is
    // the only way to genuinely vary which columns are referenced between the two physical shapes.
    const id: string = hwsRuntime
      ? (
          await manager.query<Array<{ id: string }>>(
            `INSERT INTO user_note (organisation_id, workspace_id, subject_user_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [ctx.organisationId, ctx.workspaceId, subjectUserId, ctx.userId, body],
          )
        )[0]!.id
      : (
          await manager.query<Array<{ id: string }>>(
            `INSERT INTO user_note (organisation_id, subject_user_id, author_user_id, body) VALUES ($1,$2,$3,$4) RETURNING id`,
            [ctx.organisationId, subjectUserId, ctx.userId, body],
          )
        )[0]!.id;
    const author = await manager.findOne(User, { where: { id: ctx.userId } });
    return {
      id,
      body,
      createdAt: new Date(),
      authorName: author ? `${author.firstName} ${author.lastName}`.trim() : null,
    };
  }
}
