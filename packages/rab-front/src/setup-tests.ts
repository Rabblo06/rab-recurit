// jsdom doesn't provide these, but react-router v7's internals need them.
import { TextDecoder, TextEncoder } from 'node:util';
import { randomUUID } from 'node:crypto';

import '@testing-library/jest-dom';

Object.assign(global, { TextEncoder, TextDecoder });

// jsdom's Crypto predates randomUUID; use Node's real implementation for local draft IDs.
Object.defineProperty(global.crypto, 'randomUUID', { configurable: true, value: randomUUID });

// jsdom doesn't implement ResizeObserver either — recharts' ResponsiveContainer
// (used throughout Dashboard.tsx) needs one to mount at all.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(global, { ResizeObserver: ResizeObserverStub });
