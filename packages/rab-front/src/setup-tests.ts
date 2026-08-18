// jsdom doesn't provide these, but react-router v7's internals need them.
import { TextDecoder, TextEncoder } from 'node:util';

import '@testing-library/jest-dom';

Object.assign(global, { TextEncoder, TextDecoder });

// jsdom doesn't implement ResizeObserver either — recharts' ResponsiveContainer
// (used throughout Dashboard.tsx) needs one to mount at all.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(global, { ResizeObserver: ResizeObserverStub });
