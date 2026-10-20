import { act, render, screen } from '@testing-library/react';
import AnimatedNumber from './AnimatedNumber';

const reduceMotion = (on: boolean) => {
  window.matchMedia = jest.fn().mockImplementation((q: string) => ({
    matches: on && q.includes('prefers-reduced-motion'), media: q, onchange: null,
    addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
  }));
};

afterEach(() => jest.useRealTimers());

it('renders the real value immediately — never a count-up from zero on first load', () => {
  reduceMotion(false);
  render(<AnimatedNumber value={42} />);
  expect(screen.getByText('42')).toHaveAttribute('data-value', '42');
});

it('tweens from the previous real value to the new one and lands exactly on it', async () => {
  reduceMotion(false);
  const { rerender, container } = render(<AnimatedNumber value={4} />);
  rerender(<AnimatedNumber value={5} durationS={0.05} />);
  const el = container.querySelector('[data-value]')!;
  expect(el).toHaveAttribute('data-value', '5'); // the target is known immediately
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(el).toHaveTextContent(/^5$/);
});

it('keeps whole numbers whole and honours custom formats (money / one decimal)', async () => {
  reduceMotion(false);
  const { rerender, container } = render(<AnimatedNumber value={4.5} format={(n) => n.toFixed(1)} />);
  expect(container).toHaveTextContent('4.5');
  rerender(<AnimatedNumber value={4.7} format={(n) => n.toFixed(1)} durationS={0.05} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(container).toHaveTextContent('4.7');
  rerender(<AnimatedNumber value={125050} format={(p) => `£${(Math.round(p) / 100).toFixed(2)}`} durationS={0.05} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(container).toHaveTextContent('£1250.50');
});

it('reduced motion: jumps straight to the new value', () => {
  reduceMotion(true);
  const { rerender, container } = render(<AnimatedNumber value={4} />);
  rerender(<AnimatedNumber value={9} />);
  expect(container).toHaveTextContent(/^9$/);
});

describe('reveal (dashboard count-up, 2026-10-20)', () => {
  const visible = (c: HTMLElement) => (c.querySelector('[data-animating]') ?? c.querySelector('[data-value]'))!.textContent ?? '';
  const sample = async (c: HTMLElement, ms: number) => {
    const seen: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      seen.push(visible(c));
      await act(async () => { await new Promise((r) => setTimeout(r, 16)); });
    }
    return seen;
  };

  it('counts up from 0 through intermediate values, monotonically, and lands exactly on the real value', async () => {
    reduceMotion(false);
    const { container } = render(<AnimatedNumber value={84} reveal revealDurationS={0.5} />);
    const seen = (await sample(container, 800)).map(Number);
    const distinct = [...new Set(seen)];
    expect(distinct[0]).toBe(0);
    expect(distinct.filter((n) => n > 0 && n < 84).length).toBeGreaterThan(2);
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(84);
    expect(container.querySelector('[data-value]')).toHaveTextContent(/^84$/);
  });

  it('keeps decimals and units on every frame (hours)', async () => {
    reduceMotion(false);
    const { container } = render(<AnimatedNumber value={6.6} format={(n) => `${n.toFixed(1)} h`} reveal revealDurationS={0.4} />);
    const seen = await sample(container, 700);
    expect(seen.every((t) => /^\d+\.\d h$/.test(t))).toBe(true);
    expect(new Set(seen).size).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe('6.6 h');
  });

  it('a new target mid-flight continues from the displayed value (no reset to 0) and only the newest completes', async () => {
    reduceMotion(false);
    const { container, rerender } = render(<AnimatedNumber value={100} reveal revealDurationS={0.6} durationS={0.3} />);
    await sample(container, 250);
    const mid = Number(visible(container));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    rerender(<AnimatedNumber value={40} reveal revealDurationS={0.6} durationS={0.3} />);
    const after = (await sample(container, 700)).map(Number);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(40); // decreasing from where it was, never via 0
    expect(after.at(-1)).toBe(40);
  });

  it('an unchanged value (background poll) does not restart anything; zero is a real value', async () => {
    reduceMotion(false);
    const { container, rerender } = render(<AnimatedNumber value={0} reveal />);
    expect(visible(container)).toBe('0');
    expect(container.querySelector('[data-animating]')).toBeNull();
    rerender(<AnimatedNumber value={0} reveal />);
    expect(container.querySelector('[data-animating]')).toBeNull();
  });

  it('assistive technology reads only the final value while frames are painted', async () => {
    reduceMotion(false);
    const { container } = render(<AnimatedNumber value={84} reveal revealDurationS={0.5} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(container.querySelector('[data-animating]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('84')).toHaveClass('visually-hidden');
  });

  it('reduced motion: the real value immediately, no count-up', () => {
    reduceMotion(true);
    const { container } = render(<AnimatedNumber value={84} reveal />);
    expect(container).toHaveTextContent(/^84$/);
    expect(container.querySelector('[data-animating]')).toBeNull();
  });
});
