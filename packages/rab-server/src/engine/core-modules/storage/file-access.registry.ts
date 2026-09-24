import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';
import { StoredFile } from './entities/stored-file.entity';
import { FileKindType } from './file-kinds';

/**
 * Layer-2 rule for one kind of file (the guard is JwtAuthGuard, layer 4 is RLS
 * on `stored_file`). `engine/` cannot import the domain, so domain modules
 * REGISTER their rules here at boot. A kind with no registered policy is
 * DENIED — an unregistered file kind fails closed instead of falling through
 * to "RLS was enough".
 */
export interface FileKindPolicy {
  /** Called with the caller's own tenant-scoped manager, after RLS already let the row through. */
  canRead(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<boolean>;
  /** Called after a direct upload of this kind is verified AVAILABLE (e.g. to attach it to its owner). */
  onUploadCompleted?(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<void>;
}

@Injectable()
export class FileAccessRegistry {
  private readonly policies = new Map<FileKindType, FileKindPolicy>();

  register(kinds: readonly FileKindType[], policy: FileKindPolicy): void {
    for (const kind of kinds) this.policies.set(kind, policy);
  }

  get(kind: string): FileKindPolicy | undefined {
    return this.policies.get(kind as FileKindType);
  }
}
