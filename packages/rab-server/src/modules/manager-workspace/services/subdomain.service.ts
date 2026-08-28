import { isValidSubdomainShape, normalizeSubdomain, RESERVED_SUBDOMAINS } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';

import { ManagerWorkspace } from '../entities/manager-workspace.entity';

const MAX_NUMERIC_SUFFIX_ATTEMPTS = 9;
const RANDOM_SUFFIX_LENGTH = 4;
const RANDOM_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface SubdomainAvailability {
  available: boolean;
  normalized: string;
  reserved: boolean;
  suggested?: string;
  alternatives?: string[];
}

function randomSuffix(): string {
  const bytes = randomBytes(RANDOM_SUFFIX_LENGTH);
  let out = '';
  for (let i = 0; i < RANDOM_SUFFIX_LENGTH; i++) {
    out += RANDOM_SUFFIX_ALPHABET[bytes[i]! % RANDOM_SUFFIX_ALPHABET.length];
  }
  return out;
}

/**
 * One shared normalization/validation/reserved-check/availability pipeline,
 * used by both workspace creation and any later subdomain change — never
 * two copies of this logic. The database (`manager_workspace.subdomain`'s
 * `UNIQUE` constraint) is always the final authority; this service's own
 * check is a courtesy for a good UX (live feedback, suggestions), not the
 * actual enforcement — `ManagerWorkspaceService.create`/`updateSubdomain`
 * re-run the equivalent query inside the write transaction and catch the
 * DB's own unique-violation as the real race-condition backstop.
 */
@Injectable()
export class SubdomainService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Deliberately reads via the plain injected `DataSource` — correct here,
   * unlike a tenant-scoped read, because `manager_workspace`'s RLS policy
   * makes SELECT permissive by design (see the migration's SECURITY
   * TRADE-OFF note) precisely so this cross-organisation check works. Never
   * returns owner/name/id/organisation for a taken name — only availability
   * and safe suggestions, matching the anti-enumeration requirement this
   * was built against.
   */
  private async isTaken(subdomain: string, excludeWorkspaceId?: string): Promise<boolean> {
    const existing = await this.dataSource.manager.findOne(ManagerWorkspace, { where: { subdomain } });
    return Boolean(existing && existing.id !== excludeWorkspaceId);
  }

  async checkAvailability(candidate: string, excludeWorkspaceId?: string): Promise<SubdomainAvailability> {
    const normalized = normalizeSubdomain(candidate);

    if (!isValidSubdomainShape(normalized)) {
      return { available: false, normalized, reserved: false };
    }
    if (RESERVED_SUBDOMAINS.has(normalized)) {
      return { available: false, normalized, reserved: true };
    }

    const taken = await this.isTaken(normalized, excludeWorkspaceId);
    if (!taken) {
      return { available: true, normalized, reserved: false };
    }

    const alternatives: string[] = [];
    for (let n = 1; n <= MAX_NUMERIC_SUFFIX_ATTEMPTS; n++) {
      const candidateSuffixed = `${normalized}${String(n).padStart(2, '0')}`;
      if (!isValidSubdomainShape(candidateSuffixed)) continue;
      if (!(await this.isTaken(candidateSuffixed, excludeWorkspaceId))) {
        alternatives.push(candidateSuffixed);
        if (alternatives.length >= 3) break;
      }
    }
    if (alternatives.length === 0) {
      // Bounded numeric range exhausted — fall back to one short random-suffix form.
      for (let attempt = 0; attempt < 5 && alternatives.length === 0; attempt++) {
        const candidateRandom = `${normalized}-${randomSuffix()}`;
        if (isValidSubdomainShape(candidateRandom) && !(await this.isTaken(candidateRandom, excludeWorkspaceId))) {
          alternatives.push(candidateRandom);
        }
      }
    }

    return {
      available: false,
      normalized,
      reserved: false,
      suggested: alternatives[0],
      alternatives: alternatives.slice(1),
    };
  }
}
