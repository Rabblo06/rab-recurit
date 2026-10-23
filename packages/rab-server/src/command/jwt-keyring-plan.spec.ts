import { planAddKid, planRetireKid } from './jwt-keyring-plan';

const A = 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA';
const B = 'p9Qw2Er7Ty1Ui8Op3As6Df0Gh5Jk4LzX';

describe('jwt-keyring-plan (wave 2 lane A2 rotation helper)', () => {
  it('add: appends a new kid with a freshly generated strong secret, keeping existing kids (still verifiable)', () => {
    const next = planAddKid(JSON.stringify([{ kid: 'k1', secret: A }]), 'k2');
    expect(next.map((e) => e.kid)).toEqual(['k1', 'k2']);
    expect(next[0].secret).toBe(A);
    expect(next[1].secret.length).toBeGreaterThanOrEqual(64);
    expect(new Set(next[1].secret).size).toBeGreaterThan(8);
  });

  it('add: works with no keyring yet (first dedicated kid)', () => {
    expect(planAddKid(undefined, 'k1', B)).toEqual([{ kid: 'k1', secret: B }]);
  });

  it.each([
    ['reserved legacy', 'legacy', /reserved/],
    ['reserved derived-v1', 'derived-v1', /reserved/],
    ['an existing kid', 'k1', /already exists/],
    ['an unsafe kid', 'bad kid!', /kid must be/],
  ])('add: refuses %s', (_n, kid, pattern) => {
    expect(() => planAddKid(JSON.stringify([{ kid: 'k1', secret: A }]), kid)).toThrow(pattern);
  });

  it('add: refuses a weak supplied secret', () => {
    expect(() => planAddKid(undefined, 'k1', 'x'.repeat(40))).toThrow(/distinct characters/);
  });

  it('retire: removes a non-active kid only', () => {
    const ring = JSON.stringify([{ kid: 'k1', secret: A }, { kid: 'k2', secret: B }]);
    expect(planRetireKid(ring, 'k2', 'k1')).toEqual([{ kid: 'k2', secret: B }]);
    expect(() => planRetireKid(ring, 'k2', 'k2')).toThrow(/flip the active kid first/);
    expect(() => planRetireKid(ring, 'k2', 'k9')).toThrow(/not in APP_JWT_SIGNING_KEYRING/);
    expect(() => planRetireKid(undefined, 'k2', 'k1')).toThrow(/nothing to retire/);
  });
});
