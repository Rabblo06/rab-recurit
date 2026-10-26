/**
 * S2 record references (Batch 3 contract): `[[record:<type>:<uuid>]]`. `AiRecordRefType` and `AI_RECORD_REF_PATTERN`
 * come from `@rab/shared` (types/ai-turns.ts). The shared pattern is NOT global: build `new RegExp(source, 'g')` per use.
 * The server (Worker) keeps a reference only when that id came from a tool result of the same turn, under its typed key,
 * and strips every other one before the answer is stored.
 *
 * Rules (front): chips render ONLY from stored content (the persisted `done.content` / the loaded message), never from
 * streamed deltas; the label always comes from the record's own route (never from the model's text); a 404 shows
 * "Record unavailable".
 */
import type { AiRecordRefType } from '@rab/shared';

export { AI_RECORD_REF_PATTERN, type AiRecordRefType } from '@rab/shared';

export interface AiRecordRef {
  type: AiRecordRefType;
  id: string;
}
