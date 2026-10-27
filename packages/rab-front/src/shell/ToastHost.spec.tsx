import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToastHost from './ToastHost';
import { defaultToastDuration, toast, TOAST_DURATION_MS, TOAST_MAX_VISIBLE } from '../shared/lib/toast';

// Framer's exit animation runs on its own frame loop, which fake timers stall; render plain elements instead (same
// approach as WelcomeOverlay.spec). The host's timer, queue and dedupe logic is what these tests cover.
jest.mock('framer-motion', () => {
  const React = require('react');
  // Cached per tag: a fresh component type on every render would remount the card (losing hover/focus).
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    (cache[tag] ??= React.forwardRef(({ children, variants, initial, animate, exit, transition, layout, ...rest }: any, ref: any) =>
      React.createElement(tag, { ...rest, ref }, children)));
  return {
    __esModule: true,
    motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: jest.fn(() => false),
  };
});

const NOT_READY = "Timesheet isn't ready yet. Wait until all required staff have clocked out.";
const READY = 'Timesheet is ready. All required staff have clocked out.';

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => toast.dismiss());
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('ToastHost variants and roles', () => {
  it('error: assertive alert, red variant class, 7 s countdown, auto-dismisses', async () => {
    const { container } = render(<ToastHost />);
    act(() => void toast.error(NOT_READY));
    const card = screen.getByRole('alert');
    expect(card).toHaveClass('toast', 'toast-error');
    expect(card).toHaveAttribute('aria-live', 'assertive');
    expect(card).toHaveTextContent(`Error: ${NOT_READY}`);
    expect(container.querySelector<HTMLElement>('.toast-progress')!.style.animationDuration).toBe('7000ms');
    advance(TOAST_DURATION_MS.error - 50);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(100);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('success and info: polite status, 4 s', () => {
    const { container } = render(<ToastHost />);
    act(() => {
      toast.success(READY);
      toast.info('Draft saved.');
    });
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(2);
    statuses.forEach((s) => expect(s).toHaveAttribute('aria-live', 'polite'));
    expect(container.querySelector<HTMLElement>('.toast-success .toast-progress')!.style.animationDuration).toBe('4000ms');
    expect(container.querySelector<HTMLElement>('.toast-info .toast-progress')!.style.animationDuration).toBe('4000ms');
  });

  it('warning: polite status with the amber variant and a 7 s countdown', () => {
    const { container } = render(<ToastHost />);
    act(() => void toast.warning('2 invitations could not be sent.'));
    const card = screen.getByRole('status');
    expect(card).toHaveClass('toast-warning');
    expect(card).toHaveTextContent('Warning: 2 invitations could not be sent.');
    expect(container.querySelector<HTMLElement>('.toast-warning .toast-progress')!.style.animationDuration).toBe('7000ms');
  });

  it('a custom duration is honoured (and clamped)', () => {
    const { container } = render(<ToastHost />);
    act(() => void toast.info('Long one', { duration: 60000 }));
    expect(container.querySelector<HTMLElement>('.toast-progress')!.style.animationDuration).toBe('15000ms');
  });

  it('ignores empty messages', () => {
    const { container } = render(<ToastHost />);
    let id = -1;
    act(() => {
      id = toast.error('   ');
    });
    expect(id).toBe(0);
    expect(container.querySelector('.toast')).toBeNull();
  });
});

describe('dismissal', () => {
  it('the ✕ is a real, labelled button reachable by keyboard and dismisses only its toast', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<ToastHost />);
    act(() => {
      toast.success('Staff member removed from this venue manager.');
      toast.info('Draft saved.');
    });
    const [first] = screen.getAllByRole('button', { name: 'Dismiss notification' });
    first!.focus();
    expect(first).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('Staff member removed from this venue manager.')).toBeNull());
    expect(screen.getByText('Draft saved.')).toBeInTheDocument();
  });

  it('showing a toast never moves focus', () => {
    render(
      <>
        <input aria-label="Name" />
        <ToastHost />
      </>,
    );
    const input = screen.getByLabelText('Name');
    input.focus();
    act(() => void toast.error('Could not save.'));
    expect(input).toHaveFocus();
  });

  it('hover pauses the countdown; leaving resumes it with the remaining time', async () => {
    render(<ToastHost />);
    act(() => void toast.success('Profile updated.'));
    const card = screen.getByRole('status');
    advance(1000);
    fireEvent.mouseEnter(card);
    expect(card).toHaveClass('is-paused');
    advance(20000);
    expect(screen.getByText('Profile updated.')).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    advance(2900);
    expect(screen.getByText('Profile updated.')).toBeInTheDocument();
    advance(200);
    await waitFor(() => expect(screen.queryByText('Profile updated.')).toBeNull());
  });

  it('keyboard focus inside the card pauses it too', () => {
    render(<ToastHost />);
    act(() => void toast.success('Logo updated.'));
    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).focus());
    advance(10000);
    expect(screen.getByText('Logo updated.')).toBeInTheDocument();
  });

  it('toast.dismiss(id) removes one; toast.dismiss() clears all', async () => {
    render(<ToastHost />);
    let id = 0;
    act(() => {
      id = toast.info('One');
      toast.info('Two');
    });
    act(() => toast.dismiss(id));
    await waitFor(() => expect(screen.queryByText('One')).toBeNull());
    expect(screen.getByText('Two')).toBeInTheDocument();
    act(() => toast.dismiss());
    await waitFor(() => expect(screen.queryByText('Two')).toBeNull());
  });
});

describe('stacking and de-duplication', () => {
  it(`shows at most ${TOAST_MAX_VISIBLE}; the rest queue and appear as earlier ones leave`, async () => {
    render(<ToastHost />);
    act(() => {
      for (let i = 1; i <= 5; i++) toast.info(`Message ${i}`);
    });
    expect(screen.getAllByRole('status')).toHaveLength(TOAST_MAX_VISIBLE);
    expect(screen.queryByText('Message 4')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0]!);
    await waitFor(() => expect(screen.getByText('Message 4')).toBeInTheDocument());
    expect(screen.queryByText('Message 1')).toBeNull();
    expect(screen.queryByText('Message 5')).toBeNull();
  });

  it('a queued toast only starts its countdown once visible', async () => {
    render(<ToastHost />);
    act(() => {
      toast.error('E1');
      toast.error('E2');
      toast.error('E3');
      toast.success('Queued success');
    });
    advance(TOAST_DURATION_MS.error + 10); // E1–E3 expire; the success becomes visible now
    await waitFor(() => expect(screen.getByText('Queued success')).toBeInTheDocument());
    advance(TOAST_DURATION_MS.success - 200);
    expect(screen.getByText('Queued success')).toBeInTheDocument();
  });

  it('the same variant + message collapses into one card and refreshes its timer', async () => {
    render(<ToastHost />);
    act(() => void toast.error(NOT_READY));
    advance(5000);
    act(() => void toast.error(NOT_READY));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    advance(5000); // 10 s after the first: would have expired without the refresh
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(2100);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('the same text with a different variant is a separate toast', () => {
    render(<ToastHost />);
    act(() => {
      toast.success('Saved.');
      toast.info('Saved.');
    });
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
});

describe('layout and motion', () => {
  it('long text is rendered in full inside the wrapping message element', () => {
    const long = 'Venue saved, but the photo could not be uploaded because the storage service did not respond in time. '.repeat(3).trim();
    const { container } = render(<ToastHost />);
    act(() => void toast.error(long));
    const message = container.querySelector('.toast-message .toast-text')!;
    expect(message.textContent).toBe(long);
  });

  it('reduced motion: the fill is held still but the toast still dismisses after its display time', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
    const { container } = render(<ToastHost />);
    act(() => void toast.success('Picture updated.'));
    expect(container.querySelector('.toast-progress')).toHaveClass('toast-progress-static');
    advance(TOAST_DURATION_MS.success + 10);
    await waitFor(() => expect(screen.queryByText('Picture updated.')).toBeNull());
  });
});

describe('next-step actions, persistence and reading time (feedback pass 2026-10-25)', () => {
  it('an action button runs its callback and dismisses the toast', async () => {
    const onClick = jest.fn();
    render(<ToastHost />);
    act(() => void toast.error('Could not save your profile. Please try again.', { action: { label: 'Try again', onClick } }));
    const card = screen.getByRole('alert');
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a persistent error has no countdown: it is still there a minute later and leaves only when dismissed', async () => {
    const { container } = render(<ToastHost />);
    act(() => void toast.error('Your session has expired. Please sign in again.', { persistent: true }));
    expect(screen.getByRole('alert')).toHaveAttribute('data-persistent', 'true');
    expect(container.querySelector('.toast-progress')).toHaveClass('toast-progress-static');
    advance(60_000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('success auto-dismisses at 4 s while a long error stays long enough to read (longer than 7 s, capped at 15 s)', async () => {
    const long = 'Venue saved, but the photo could not be uploaded. Your photo could not be saved. Please choose a PNG, JPG or WebP image smaller than 5 MB and try again.';
    const { container } = render(<ToastHost />);
    act(() => {
      toast.success('Profile updated.');
      toast.error(long);
    });
    const errorMs = parseInt(container.querySelector<HTMLElement>('.toast-error .toast-progress')!.style.animationDuration, 10);
    expect(errorMs).toBe(defaultToastDuration('error', long));
    expect(errorMs).toBeGreaterThan(TOAST_DURATION_MS.error);
    expect(errorMs).toBeLessThanOrEqual(15_000);
    advance(TOAST_DURATION_MS.success + 50);
    await waitFor(() => expect(screen.queryByText('Profile updated.')).toBeNull());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(errorMs);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('short messages keep the existing defaults (backwards compatible)', () => {
    expect(defaultToastDuration('error', 'Could not save.')).toBe(TOAST_DURATION_MS.error);
    expect(defaultToastDuration('success', 'x'.repeat(200))).toBe(TOAST_DURATION_MS.success);
  });
});
