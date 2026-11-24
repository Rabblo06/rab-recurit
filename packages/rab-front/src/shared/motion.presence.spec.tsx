import { useState } from 'react';
import { flushSync } from 'react-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Regression for the patched framer-motion 11.18.2 (.yarn/patches/framer-motion-npm-11.18.2-*.patch).
 *
 * `AnimatePresence mode="wait"` (tab content in UserDetailPanel, the Drawer body, Calendar months, NavShortcuts, the auth
 * screens) queues the next child when the exiting one finishes. If the key changes again in a sync render before that
 * queued update renders — a click landing between the exit finishing and React rendering, as the reduced-motion
 * motion-system e2e did on loaded CI runners — the queued child mounts already "not present". Unpatched, its exit never
 * starts (ExitAnimationFeature only reacts to a presence *change*), AnimatePresence waits on it forever and the stale
 * content stays on screen: the Staff reviews tab selected, the Timeline panel still showing.
 */
function Harness({
  onReady,
}: {
  onReady: (api: {
    select: (k: string) => void;
    afterExit: (fn: () => void) => void;
  }) => void;
}) {
  const [key, setKey] = useState('a');
  const [afterExit] = useState<{ fn: (() => void) | null }>({ fn: null });
  onReady({
    select: setKey,
    afterExit: (fn) => {
      afterExit.fn = fn;
    },
  });
  return (
    <AnimatePresence
      mode="wait"
      initial={false}
      onExitComplete={() => {
        const fn = afterExit.fn;
        afterExit.fn = null;
        fn?.();
      }}
    >
      <motion.div
        key={key}
        data-testid="panel"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.02 }}
      >
        {key}
      </motion.div>
    </AnimatePresence>
  );
}

describe('AnimatePresence mode="wait" (patched framer-motion)', () => {
  it('shows the latest child when the key changes again right as the previous exit completes', async () => {
    let api!: {
      select: (k: string) => void;
      afterExit: (fn: () => void) => void;
    };
    render(
      <Harness
        onReady={(a) => {
          api = a;
        }}
      />,
    );
    expect(screen.getByTestId('panel')).toHaveTextContent('a');

    // a -> b starts a's exit. The moment it completes (AnimatePresence has just queued b), switch to c in a sync render,
    // ahead of the queued update: exactly a click arriving between the exit finishing and React rendering b.
    api.afterExit(() => flushSync(() => api.select('c')));
    act(() => api.select('b'));

    await waitFor(
      () => expect(screen.getByTestId('panel')).toHaveTextContent('c'),
      { timeout: 2000 },
    );
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
  });

  it('still waits for the exit before showing the next child (normal switch)', async () => {
    let api!: {
      select: (k: string) => void;
      afterExit: (fn: () => void) => void;
    };
    render(
      <Harness
        onReady={(a) => {
          api = a;
        }}
      />,
    );
    act(() => api.select('b'));
    expect(screen.getByTestId('panel')).toHaveTextContent('a'); // a is exiting; b is not mounted yet
    await waitFor(
      () => expect(screen.getByTestId('panel')).toHaveTextContent('b'),
      { timeout: 2000 },
    );
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
  });
});
