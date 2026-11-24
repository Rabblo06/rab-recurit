export default {
  displayName: 'rab-front',
  preset: '../../jest.preset.js',
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(?:@blobatar/react|blobatar)/)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/setup-tests.ts'],
  coverageDirectory: '../../coverage/packages/rab-front',
};
