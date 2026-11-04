/**
 * PDF renderer migration harness (Chromium → native). Separate from the Worker's default Jest config because these
 * suites need no database (the default config's globalSetup demands the TEST_* database pair) and render dozens of PDFs.
 *
 *   npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts            # self-test + hostile + native
 *   RAB_PDF_LOAD=1 npx jest -c … pdf-render.load                                            # load test (opt-in)
 *
 * (or `npx nx run rab-worker:test-pdf-equality`). Every switch is documented at the top of each spec.
 */
export default {
  displayName: 'rab-worker-pdf-equality',
  rootDir: '../../..',
  preset: '../../jest.preset.js',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', isolatedModules: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // The native renderer's @react-pdf/renderer is ESM-only: same mapping as the Worker's own config on
  // worker/pdf-without-chromium (Node's require(esm) through a test helper). Inert until something imports it.
  moduleNameMapper: { '^@react-pdf/renderer$': '<rootDir>/src/__tests__/helpers/react-pdf-node-loader.ts' },
  setupFiles: ['<rootDir>/src/__tests__/pdf-equality/setup.ts'],
  transformIgnorePatterns: ['/node_modules/', '/dist-cjs/', '/dist-esm/', '/rab-server/dist/'],
  testMatch: ['<rootDir>/src/__tests__/pdf-equality/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
