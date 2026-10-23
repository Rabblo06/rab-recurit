import { SETUP_STAGES, setupStageStates, TRANSACTIONAL_STAGES } from './setupStages';

const states = (status: Parameters<typeof setupStageStates>[0]) => SETUP_STAGES.map((s) => setupStageStates(status)[s.key]);

describe('setupStageStates — server-reported stages only', () => {
  it('lists the six stages in order', () => {
    expect(SETUP_STAGES.map((s) => s.label)).toEqual([
      'Validating',
      'Creating workspace',
      'Preparing database',
      'Applying FORCE RLS',
      'Verifying workspace',
      'Ready',
    ]);
  });

  it('before the server has reported a workspace row, only validation is in progress', () => {
    expect(states(undefined)).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(states(null)).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('CREATING: the committed row completes stages 1-2; the one-transaction stages 3-5 are in progress together', () => {
    expect(states('CREATING')).toEqual(['complete', 'complete', 'current', 'current', 'current', 'pending']);
  });

  it('READY: everything complete — and only READY completes the transactional stages or Ready', () => {
    expect(states('READY')).toEqual(['complete', 'complete', 'complete', 'complete', 'complete', 'complete']);
    for (const s of ['CREATING', 'FAILED', 'SUPERSEDED', 'MIGRATING', null, undefined] as const) {
      const r = setupStageStates(s);
      expect([s, r.ready]).not.toEqual([s, 'complete']);
      for (const k of TRANSACTIONAL_STAGES) expect([s, k, r[k]]).not.toEqual([s, k, 'complete']);
    }
  });

  it('FAILED: the transactional stages failed together (rolled back); Ready is never reached', () => {
    expect(states('FAILED')).toEqual(['complete', 'complete', 'failed', 'failed', 'failed', 'pending']);
  });

  it('SUPERSEDED claims nothing beyond the committed row', () => {
    expect(states('SUPERSEDED')).toEqual(['complete', 'complete', 'pending', 'pending', 'pending', 'pending']);
  });
});
