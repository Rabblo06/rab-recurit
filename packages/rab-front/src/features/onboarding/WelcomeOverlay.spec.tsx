import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WelcomeOverlay from './WelcomeOverlay';

jest.mock('../../shared/components/Avatar', () => ({
  __esModule: true,
  default: ({ label }: { label: string }) => <div>avatar:{label}</div>,
}));

jest.mock('framer-motion', () => {
  const React = require('react');
  const passthrough = (tag: string) =>
    React.forwardRef(({ children, variants, initial, animate, exit, transition, ...rest }: any, ref: any) =>
      React.createElement(tag, { ...rest, ref }, children));
  return {
    __esModule: true,
    motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: jest.fn(() => false),
  };
});

const { useReducedMotion } = jest.requireMock('framer-motion') as { useReducedMotion: jest.Mock };

beforeEach(() => useReducedMotion.mockReturnValue(false));

/**
 * The welcome heading is animated word-by-word (one `<span>` per word, see WelcomeOverlay.tsx),
 * so its combined text is split across multiple elements — RTL's plain string/regex `getByText`
 * only ever matches a SINGLE element's own text, by design (this is the library's documented
 * "text split up by multiple elements" case). This matcher checks the PARENT's combined,
 * whitespace-normalized text instead, while requiring that none of its own children already
 * match (so it finds the shallowest/outermost matching element, not every ancestor up the tree).
 */
function headingText(text: string) {
  return (_content: string, element: Element | null) => {
    if (!element) return false;
    const normalize = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim();
    if (normalize(element) !== text) return false;
    return Array.from(element.children).every((child) => normalize(child) !== text);
  };
}

it('Platform Super Admin sees generic Crewflow welcome copy, no workspace or organisation mention', () => {
  render(<WelcomeOverlay role="platform_admin" firstName="Sam" onDone={jest.fn()} />);
  expect(screen.getByText(headingText('Welcome to Crewflow'))).toBeInTheDocument();
  expect(screen.getByText('Welcome, Sam')).toBeInTheDocument();
});

it("CEO sees the real organisation name, falling back to generic copy when none is supplied", () => {
  const { rerender } = render(<WelcomeOverlay role="ceo" organisationName="Northside Hospitality" onDone={jest.fn()} />);
  expect(screen.getByText(headingText('Northside Hospitality is ready'))).toBeInTheDocument();

  rerender(<WelcomeOverlay role="ceo" onDone={jest.fn()} />);
  expect(screen.getByText(headingText('Your organisation is ready'))).toBeInTheDocument();
});

it('Manager sees the real workspace name', () => {
  render(<WelcomeOverlay role="manager" workspaceName="Northside Staffing" firstName="Jamie" onDone={jest.fn()} />);
  expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
  expect(screen.getByText('avatar:Jamie')).toBeInTheDocument();
});

it('never renders a name/avatar row when none is supplied — no leaked previous identity', () => {
  render(<WelcomeOverlay role="manager" workspaceName="Northside Staffing" onDone={jest.fn()} />);
  expect(screen.queryByText(/Welcome, /)).toBeNull();
  expect(screen.queryByText(/^avatar:/)).toBeNull();
});

it('calls onDone exactly once, only after the overlay has left', async () => {
  const onDone = jest.fn();
  render(<WelcomeOverlay role="manager" workspaceName="Northside Staffing" autoDismissMs={10} onDone={onDone} />);
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});

it('clicking the overlay dismisses it early instead of waiting for the full auto-dismiss duration', async () => {
  const onDone = jest.fn();
  render(<WelcomeOverlay role="manager" workspaceName="Northside Staffing" autoDismissMs={60_000} onDone={onDone} />);
  fireEvent.click(screen.getByRole('status'));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});

it('reduced motion shortens the auto-dismiss instead of skipping the welcome entirely', async () => {
  useReducedMotion.mockReturnValue(true);
  const onDone = jest.fn();
  render(<WelcomeOverlay role="manager" workspaceName="Northside Staffing" autoDismissMs={60_000} onDone={onDone} />);
  expect(screen.getByText('Northside Staffing is ready')).toBeInTheDocument();
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});
