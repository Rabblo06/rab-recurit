import 'reflect-metadata';
import { validate } from 'class-validator';
import { InviteInitialManagerDto } from './invite-initial-manager.dto';
import { ReplaceInitialManagerDto } from './replace-initial-manager.dto';

describe('Initial Manager email-only invitations', () => {
  it('accepts email alone and still accepts existing clients supplying names', async () => {
    expect(await validate(Object.assign(new InviteInitialManagerDto(), { email: 'lead@example.test' }))).toEqual([]);
    expect(await validate(Object.assign(new InviteInitialManagerDto(), { email: 'lead@example.test', firstName: 'Alex', lastName: 'Example' }))).toEqual([]);
  });
  it('rejects malformed email and invalid supplied names', async () => {
    expect(await validate(Object.assign(new InviteInitialManagerDto(), { email: 'invalid' }))).not.toEqual([]);
    expect(await validate(Object.assign(new InviteInitialManagerDto(), { email: 'lead@example.test', firstName: 123 }))).not.toEqual([]);
  });
  it('replacement still requires the concurrency token', async () => {
    expect(await validate(Object.assign(new ReplaceInitialManagerDto(), { email: 'lead@example.test' }))).not.toEqual([]);
    expect(await validate(Object.assign(new ReplaceInitialManagerDto(), { email: 'lead@example.test', expectedProfileId: '11111111-1111-4111-8111-111111111111' }))).toEqual([]);
  });
});
