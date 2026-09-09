import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User, UserNote } from '../entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';

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
  async list(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId'>, subjectUserId: string): Promise<UserNoteItem[]> {
    const rows = await manager
      .createQueryBuilder(UserNote, 'n')
      .leftJoin(User, 'a', 'a.id = n.author_user_id')
      .where('n.organisation_id = :orgId', { orgId: ctx.organisationId })
      .andWhere('n.subject_user_id = :subjectUserId', { subjectUserId })
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
    ctx: Pick<AuthContext, 'organisationId' | 'userId'>,
    subjectUserId: string,
    body: string,
  ): Promise<UserNoteItem> {
    const result = await manager.insert(UserNote, {
      organisationId: ctx.organisationId!,
      subjectUserId,
      authorUserId: ctx.userId,
      body,
    });
    const author = await manager.findOne(User, { where: { id: ctx.userId } });
    return {
      id: result.identifiers[0]!.id as string,
      body,
      createdAt: new Date(),
      authorName: author ? `${author.firstName} ${author.lastName}`.trim() : null,
    };
  }
}
