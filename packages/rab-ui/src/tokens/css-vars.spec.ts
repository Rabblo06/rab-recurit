import { toCssVariables } from './css-vars';

describe('toCssVariables', () => {
  it('emits accent as --rab-color-accent without a trailing -DEFAULT', () => {
    const vars = toCssVariables();
    expect(vars['--rab-color-accent']).toBe('#12735A');
    expect(vars['--rab-color-accent-strong']).toBe('#0C5643');
  });

  it('emits spacing and radius scales', () => {
    const vars = toCssVariables();
    expect(vars['--rab-space-5']).toBe('16px');
    expect(vars['--rab-radius-lg']).toBe('16px');
    expect(vars['--rab-radius-full']).toBe('9999px');
  });
});
