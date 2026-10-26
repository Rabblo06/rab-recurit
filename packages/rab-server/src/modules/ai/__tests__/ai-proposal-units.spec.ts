import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvalidTransitionError } from '@rab/shared';
import { z } from 'zod';

import { assessImpact, maxImpact } from '../actions/ai-impact';
import { failureCodeFor, proposeActionEnvelope } from '../actions/ai-proposal.service';
import { canonicalJson, snapshotHash } from '../actions/ai-snapshot';
import { AiWriteTool } from '../actions/ai-write-tool.types';
import { addStaffNoteInput, AiWriteToolsService, createDraftShiftInput, updateDraftShiftInput } from '../actions/ai-write-tools';
import { AiProposalStaleError } from '../exceptions/ai-proposal.exceptions';

const uuid = '3f0857d4-3038-4957-9da9-1bef1f774653';
const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86_400_000 + h * 3_600_000).toISOString();

describe('AI proposals — pure units', () => {
  describe('assessImpact (rule 6.4, D3)', () => {
    it('high above 10 people, normal up to 10; pay or delete is always high', () => {
      expect(assessImpact({ affectedCount: 10, touchesPay: false, deletes: false })).toBe('normal');
      expect(assessImpact({ affectedCount: 11, touchesPay: false, deletes: false })).toBe('high');
      expect(assessImpact({ affectedCount: 1, touchesPay: true, deletes: false })).toBe('high');
      expect(assessImpact({ affectedCount: 0, touchesPay: false, deletes: true })).toBe('high');
    });
    it('refuses more than 25, negatives and fractions (fail closed)', () => {
      for (const n of [26, -1, 2.5, Number.NaN]) expect(() => assessImpact({ affectedCount: n, touchesPay: false, deletes: false })).toThrow(RangeError);
    });
    it('maxImpact never lowers', () => {
      expect(maxImpact('high', 'normal')).toBe('high');
      expect(maxImpact('normal', 'normal')).toBe('normal');
    });
  });

  describe('snapshot hash', () => {
    it('is key-order independent, drops undefined and changes with any value', () => {
      expect(canonicalJson({ b: 1, a: { d: [1, null], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":[1,null]},"b":1}');
      expect(snapshotHash({ a: 1, b: 2 })).toBe(snapshotHash({ b: 2, a: 1 }));
      expect(snapshotHash({ a: 1 })).not.toBe(snapshotHash({ a: 2 }));
      expect(snapshotHash(null)).toMatch(/^[0-9a-f]{64}$/);
    });
    it('refuses values with no stable JSON form', () => {
      expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
      expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
      expect(() => canonicalJson({ b: BigInt(1) })).toThrow(TypeError);
    });
  });

  describe('strict write-tool schemas (rule 7.1 / 7.2)', () => {
    const draft = { venueId: uuid, jobRoleId: uuid, startsAt: inDays(2), endsAt: inDays(2, 6), requiredCount: 2 };
    it('create_draft_shift: accepts the documented shape only', () => {
      expect(createDraftShiftInput.safeParse(draft).success).toBe(true);
      for (const extra of [{ organisationId: uuid }, { status: 'open' }, { payRatePence: 100 }, { chargeRatePence: 0 }, { workspaceId: uuid }]) {
        expect(createDraftShiftInput.safeParse({ ...draft, ...extra }).success).toBe(false);
      }
      expect(createDraftShiftInput.safeParse({ ...draft, requiredCount: 26 }).success).toBe(false);
      expect(createDraftShiftInput.safeParse({ ...draft, breakMinutes: 241 }).success).toBe(false);
      expect(createDraftShiftInput.safeParse({ ...draft, notes: 'x'.repeat(501) }).success).toBe(false);
      expect(createDraftShiftInput.safeParse({ ...draft, endsAt: inDays(3, 1) }).success).toBe(false); // > 24 h
      expect(createDraftShiftInput.safeParse({ ...draft, startsAt: inDays(-1), endsAt: inDays(-1, 4) }).success).toBe(false); // past
      expect(createDraftShiftInput.safeParse({ ...draft, startsAt: inDays(94), endsAt: inDays(94, 4) }).success).toBe(false); // > 93 days
      expect(createDraftShiftInput.safeParse({ ...draft, startsAt: '2026-11-01' }).success).toBe(false);
    });
    it('update_draft_shift: needs at least one of the five fields; never status or pay', () => {
      expect(updateDraftShiftInput.safeParse({ shiftId: uuid }).success).toBe(false);
      expect(updateDraftShiftInput.safeParse({ shiftId: uuid, notes: 'x' }).success).toBe(true);
      expect(updateDraftShiftInput.safeParse({ shiftId: uuid, status: 'open' }).success).toBe(false);
      expect(updateDraftShiftInput.safeParse({ shiftId: uuid, payRatePence: 1 }).success).toBe(false);
      expect(updateDraftShiftInput.safeParse({ shiftId: uuid, venueId: uuid }).success).toBe(false);
    });
    it('add_staff_note: 1..2000 characters, not blank', () => {
      expect(addStaffNoteInput.safeParse({ staffProfileId: uuid, body: 'ok' }).success).toBe(true);
      expect(addStaffNoteInput.safeParse({ staffProfileId: uuid, body: 'x'.repeat(2001) }).success).toBe(false);
      expect(addStaffNoteInput.safeParse({ staffProfileId: uuid, body: '   ' }).success).toBe(false);
      expect(addStaffNoteInput.safeParse({ staffProfileId: uuid, body: 'x', userId: uuid }).success).toBe(false);
    });
    it('propose_action envelope: only the three tools, no extra keys', () => {
      expect(proposeActionEnvelope.safeParse({ tool: 'add_staff_note', arguments: {} }).success).toBe(true);
      expect(proposeActionEnvelope.safeParse({ tool: 'send_rota_for_review', arguments: {} }).success).toBe(false);
      expect(proposeActionEnvelope.safeParse({ tool: 'add_staff_note', arguments: {}, approve: true }).success).toBe(false);
    });
  });

  describe('boot check', () => {
    const stubs = () => {
      const svc = new AiWriteToolsService({} as never, {} as never);
      return svc.names().map((n) => svc.get(n)!) as AiWriteTool[];
    };
    it('registers exactly the three tools, none with run(), no editable id or forbidden key', () => {
      expect(stubs().map((t) => t.name)).toEqual(['add_staff_note', 'create_draft_shift', 'update_draft_shift']);
      expect(() => AiWriteToolsService.validate(stubs())).not.toThrow();
      const [first, ...rest] = stubs();
      expect(() => AiWriteToolsService.validate(rest)).toThrow(/exactly/);
      expect(() => AiWriteToolsService.validate([{ ...first!, run: () => undefined } as never, ...rest])).toThrow(/run function/);
      const create = stubs().find((t) => t.name === 'create_draft_shift')!;
      const others = stubs().filter((t) => t.name !== 'create_draft_shift');
      expect(() => AiWriteToolsService.validate([...others, { ...create, editableFields: ['venueId'] } as never])).toThrow();
      expect(() => AiWriteToolsService.validate([...others, { ...create, editableFields: ['status'] } as never])).toThrow();
    });
  });

  describe('failure codes (fixed, mapped from the exception class)', () => {
    it('maps domain refusals', () => {
      expect(failureCodeFor(new AiProposalStaleError())).toBe('stale');
      expect(failureCodeFor(new ForbiddenException())).toBe('not_permitted');
      expect(failureCodeFor(new NotFoundException())).toBe('not_found');
      expect(failureCodeFor(new ConflictException())).toBe('conflict');
      expect(failureCodeFor(new InvalidTransitionError('a', 'b'))).toBe('conflict');
      expect(failureCodeFor(new z.ZodError([]))).toBe('invalid');
      expect(failureCodeFor(new Error('boom'))).toBe('internal');
    });
  });
});
