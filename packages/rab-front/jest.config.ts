export default {
  displayName: 'rab-front',
  preset: '../../jest.preset.js',
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/setup-tests.ts'],
  moduleNameMapper: {
    // import.meta.env is Vite-only syntax ts-jest can't parse — see the comment in api-base-url.ts.
    'config/api-base-url$': '<rootDir>/src/config/api-base-url.test-stub.ts',
  },
  coverageDirectory: '../../coverage/packages/rab-front',
};
