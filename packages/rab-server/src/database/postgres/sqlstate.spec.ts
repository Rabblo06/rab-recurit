import { FOREIGN_KEY_REFUSAL_SQLSTATES, isForeignKeyRefusal } from './sqlstate';

describe('foreign-key refusal SQLSTATEs (PostgreSQL 18 reports RESTRICT keys as 23001)', () => {
  it('accepts 23503 and 23001 only', () => {
    expect([...FOREIGN_KEY_REFUSAL_SQLSTATES]).toEqual(['23503', '23001']);
    expect(isForeignKeyRefusal('23503')).toBe(true);
    expect(isForeignKeyRefusal('23001')).toBe(true);
    for (const other of ['23505', '23514', '42501', '40001', '', undefined, null, 23503]) expect(isForeignKeyRefusal(other)).toBe(false);
  });
});
