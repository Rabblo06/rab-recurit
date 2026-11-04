/* eslint-disable @typescript-eslint/no-require-imports -- loaded inside a render thread, after its guard */
/**
 * TEST-ONLY: the test registry, after ~2 s of busy work at module load INSIDE the render thread. Used by the F3 spec
 * that proves the Worker's health heartbeat keeps beating while pre-warmed threads are still starting.
 * (`performance.now()`, not `Date`: the thread's Date is the frozen render clock.)
 */
const end = performance.now() + 2_000;
while (performance.now() < end) {
  /* simulate a slow module load */
}

export const { NATIVE_DOCUMENT_REGISTRY } =
  require('./native-render-test-documents') as typeof import('./native-render-test-documents');
