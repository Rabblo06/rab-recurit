import { isReservedSubdomainLabel, isValidSubdomainShape, normalizeSubdomain } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { FREE_EMAIL_PROVIDER_DOMAINS, MULTI_PART_PUBLIC_SUFFIXES } from '../constants/free-email-providers';

const RANDOM_SUFFIX_LENGTH = 4;
const RANDOM_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_SUGGESTIONS = 3;
const NUMBERED_VARIANTS = 6;

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

/** The company part of a work email's domain (`jo@mail.acme.co.uk` → `acme`), or null for a free provider / no domain. */
export function companyLabelFromEmail(email: string | null | undefined): string | null {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  if (!domain || FREE_EMAIL_PROVIDER_DOMAINS.has(domain)) return null;
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const suffixLength = MULTI_PART_PUBLIC_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  const registrable = labels.slice(-(suffixLength + 1));
  if (registrable.length < suffixLength + 1 || FREE_EMAIL_PROVIDER_DOMAINS.has(registrable.join('.'))) return null;
  return registrable[0]!;
}

/** A usable base label (normalised, valid shape, not reserved) or null. */
function usableBase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const label = normalizeSubdomain(raw);
  return isValidSubdomainShape(label) && !isReservedSubdomainLabel(label) ? label : null;
}

/** `base`, then numbered variants — every candidate already shape-valid and not reserved. */
function variantsOf(base: string): string[] {
  const out = [base];
  // `acme01`, `acme02`, ... — the numbering format the availability check has always offered.
  for (let n = 1; n <= NUMBERED_VARIANTS; n++) out.push(`${base}${String(n).padStart(2, '0')}`);
  return out.filter((candidate) => isValidSubdomainShape(candidate) && !isReservedSubdomainLabel(candidate));
}

/**
 * One shared normalisation / validation / reserved-check / availability pipeline, used by workspace creation, rename,
 * the live availability check and the suggestions — never two copies.
 *
 * Availability is decided by `core.workspace_subdomain_taken` (lane S2 made it the one-namespace answer: another
 * workspace's subdomain, another organisation's slug, a reserved label, or a live rename quarantine held by a DIFFERENT
 * workspace all read "taken"; the caller's own workspace and its own quarantined labels read "available" when its id
 * is passed). It returns a bare boolean — never owner, name or organisation (anti-enumeration).
 *
 * Every batch of candidates is checked in ONE query (`unnest`), never one round trip per candidate. The answer is a
 * courtesy for live feedback only: `ManagerWorkspaceService` re-checks inside the write transaction and maps the
 * database's own unique / `host_label_*` violations to 409, which is the real race backstop.
 */
@Injectable()
export class SubdomainService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * `label → taken` for every candidate, in one query. `manager` runs it inside the caller's transaction, whose
   * search_path is bound to `core` (or a workspace schema) — hence the schema-qualified `public.citext` (the extension's
   * schema; the function's parameter type).
   */
  private async takenMap(candidates: string[], excludeWorkspaceId?: string | null, manager?: EntityManager): Promise<Map<string, boolean>> {
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return new Map();
    const runner = manager ?? this.dataSource;
    const rows = await runner.query<Array<{ label: string; taken: boolean }>>(
      'SELECT c.label, core.workspace_subdomain_taken(c.label::public.citext, $2::uuid) AS taken FROM unnest($1::text[]) AS c(label)',
      [unique, excludeWorkspaceId ?? null],
    );
    return new Map(rows.map((row) => [row.label, row.taken === true]));
  }

  private async firstAvailable(candidates: string[], limit: number, excludeWorkspaceId?: string | null, manager?: EntityManager): Promise<string[]> {
    const taken = await this.takenMap(candidates, excludeWorkspaceId, manager);
    const out: string[] = [];
    for (const candidate of new Set(candidates)) {
      if (taken.get(candidate) === false) out.push(candidate);
      if (out.length >= limit) break;
    }
    return out;
  }

  async checkAvailability(candidate: string, excludeWorkspaceId?: string | null, manager?: EntityManager): Promise<SubdomainAvailability> {
    const normalized = normalizeSubdomain(candidate);

    if (!isValidSubdomainShape(normalized)) {
      return { available: false, normalized, reserved: false };
    }
    if (isReservedSubdomainLabel(normalized)) {
      return { available: false, normalized, reserved: true };
    }

    // The requested label plus its numbered alternatives and one random fallback: one query.
    const alternativesPool = variantsOf(normalized).slice(1);
    const randomFallback = `${normalized.slice(0, 63 - RANDOM_SUFFIX_LENGTH - 1)}-${randomSuffix()}`;
    const pool = [normalized, ...alternativesPool, ...(isValidSubdomainShape(randomFallback) ? [randomFallback] : [])];
    const taken = await this.takenMap(pool, excludeWorkspaceId, manager);
    if (taken.get(normalized) === false) {
      return { available: true, normalized, reserved: false };
    }

    const alternatives = pool.slice(1).filter((label) => taken.get(label) === false).slice(0, MAX_SUGGESTIONS);
    return {
      available: false,
      normalized,
      reserved: false,
      suggested: alternatives[0],
      alternatives: alternatives.slice(1),
    };
  }

  /**
   * Twenty-style suggestions: the company part of the caller's work email domain (skipped for free providers), the
   * workspace name being typed, and the organisation's display name — each with numbered variants, plus one random
   * fallback — all checked in ONE query. Returns up to three available labels, best first. `email` and
   * `organisationName` are server-derived (the session's own user/organisation), never request fields.
   */
  async suggest(
    input: { email?: string | null; workspaceName?: string | null; organisationName?: string | null },
    excludeWorkspaceId?: string | null,
  ): Promise<string[]> {
    const bases = [companyLabelFromEmail(input.email), usableBase(input.workspaceName), usableBase(input.organisationName)]
      .filter((base): base is string => base !== null)
      .filter((base, index, all) => all.indexOf(base) === index);
    if (bases.length === 0) bases.push('workspace-team');
    const candidates = bases.flatMap(variantsOf);
    for (const base of bases) {
      const fallback = `${base.slice(0, 63 - RANDOM_SUFFIX_LENGTH - 1)}-${randomSuffix()}`;
      if (isValidSubdomainShape(fallback) && !isReservedSubdomainLabel(fallback)) candidates.push(fallback);
    }
    return this.firstAvailable(candidates, MAX_SUGGESTIONS, excludeWorkspaceId);
  }

  /**
   * Lane S2's rename quarantine end for a label released NOW (`now() + core.host_label_quarantine_interval()`), for the
   * service-level audit row. Null before S2's migration is applied (the function is looked up first, never assumed), so a
   * rename never fails because of the audit detail.
   */
  async quarantineUntil(manager: EntityManager): Promise<string | null> {
    const [probe] = await manager.query<Array<{ present: boolean }>>(
      `SELECT to_regprocedure('core.host_label_quarantine_interval()') IS NOT NULL AS present`,
    );
    if (!probe?.present) return null;
    const [row] = await manager.query<Array<{ until: Date }>>('SELECT now() + core.host_label_quarantine_interval() AS until');
    return row?.until ? new Date(row.until).toISOString() : null;
  }
}
