/**
 * S2 record references (Batch 3 contract, Agent 9, 2026-10-26): `[[record:<type>:<uuid>]]` with
 * `AiRecordRefType = 'shift' | 'venue' | 'staff_profile'`. The server (Worker) keeps a reference only when that id came
 * from a tool result of the same turn and strips every other one before the answer is stored.
 *
 * PENDING CONTRACT: `AiRecordRefType` and `AI_RECORD_REF_PATTERN` are being added to `@rab/shared` (types/ai-turns.ts).
 * Until that lands on this branch they are mirrored here, character for character in meaning; at that merge this file
 * re-exports the shared names and the local copies are deleted.
 *
 * Rules (front): chips render ONLY from stored content (the persisted `done.content` / the loaded message), never from
 * streamed deltas; the label always comes from the record's own route (never from the model's text); a 404 shows
 * "Record unavailable".
 */
export type AiRecordRefType = 'shift' | 'venue' | 'staff_profile';

/** One reference token. Lower-case type, canonical lower/upper-case hex uuid. Global flag: callers clone it per use. */
export const AI_RECORD_REF_PATTERN = /\[\[record:(shift|venue|staff_profile):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;

export interface AiRecordRef {
  type: AiRecordRefType;
  id: string;
}
