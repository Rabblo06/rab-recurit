import { AI_RECORD_REF_PATTERN, AiRecordRefType } from '@rab/shared';

/**
 * Batch 3 (S2) — record references in assistant text (`[[record:<type>:<uuid>]]`, @rab/shared `AI_RECORD_REF_PATTERN`).
 *
 * The model may only point at a record a tool showed it IN THIS TURN: the runner feeds every tool result of the turn (and
 * a continuation's server-written result) through `AiRecordRefAllowlist.collect`, which records a uuid only under a key
 * that names its type (`shiftId` → shift, `venueId` → venue, `staffProfileId` → staff_profile). Before the content is
 * stored (checkpoint and terminal write), `filterRecordRefs` removes EVERY `[[record:…]]`-shaped token that is not a
 * well-formed reference whose (type, uuid) is on that list — an invented, foreign, mistyped or malformed id leaves no
 * trace (no existence leak), and the tool-call offsets are moved with the text. A kept reference is an id only: the chip
 * label is read from the record's own route under the viewer's permissions, never taken from the model.
 */

/** Any `[[record:…]]`-shaped token (bounded, single line): kept only when it is a strict, allow-listed reference. */
const LOOSE_REF = /\[\[record:[^[\]\n]{0,120}\]\]/g;
const STRICT_REF = new RegExp(`^${AI_RECORD_REF_PATTERN.source}$`);

/** The keys under which a tool result names a record's id, and the type each one names. */
export const AI_RECORD_REF_KEYS: Readonly<Record<string, AiRecordRefType>> = Object.freeze({
  shiftId: 'shift',
  venueId: 'venue',
  staffProfileId: 'staff_profile',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;
const MAX_IDS = 2_000;

export class AiRecordRefAllowlist {
  private readonly seen = new Set<string>();

  get size(): number {
    return this.seen.size;
  }

  add(type: AiRecordRefType, id: unknown): void {
    if (typeof id !== 'string' || !UUID.test(id) || this.seen.size >= MAX_IDS) return;
    this.seen.add(`${type}:${id}`);
  }

  has(type: string, id: string): boolean {
    return this.seen.has(`${type}:${id}`);
  }

  /** Walks a tool result (bounded depth and size) and records every typed id it carries. Never throws. */
  collect(value: unknown): void {
    let nodes = 0;
    const walk = (v: unknown, depth: number): void => {
      if (v === null || typeof v !== 'object' || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
      if (Array.isArray(v)) {
        for (const item of v) walk(item, depth + 1);
        return;
      }
      for (const [key, member] of Object.entries(v as Record<string, unknown>)) {
        const type = AI_RECORD_REF_KEYS[key];
        if (type) this.add(type, member);
        else walk(member, depth + 1);
      }
    };
    try {
      walk(value, 0);
    } catch {
      // A malformed tool result adds nothing (fewer references, never more).
    }
  }
}

export interface AiFilteredContent {
  text: string;
  /** Maps an offset into the original content to the same position in the filtered text. */
  offsetOf(offset: number): number;
}

/** Removes every `[[record:…]]` token that is not a strict reference on the allow-list. Pure. */
export function filterRecordRefs(content: string, allowed: AiRecordRefAllowlist): AiFilteredContent {
  const removed: Array<{ start: number; length: number }> = [];
  const text = content.replace(LOOSE_REF, (token: string, start: number) => {
    const strict = STRICT_REF.exec(token);
    if (strict && allowed.has(strict[1]!, strict[2]!)) return token;
    removed.push({ start, length: token.length });
    return '';
  });
  if (removed.length === 0) return { text, offsetOf: (offset) => offset };
  return {
    text,
    offsetOf: (offset) => {
      let shift = 0;
      for (const r of removed) {
        if (offset >= r.start + r.length) shift += r.length;
        else if (offset > r.start) shift += offset - r.start;
        else break;
      }
      return Math.max(0, offset - shift);
    },
  };
}
