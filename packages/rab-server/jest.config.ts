export default {
  displayName: 'rab-server',
  preset: '../../jest.preset.js',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  setupFiles: ['<rootDir>/src/jest-setup.ts'],
  // Default node_modules exclusion doesn't match workspace packages resolved
  // through a symlink (@rab/shared, @rab/ui) — their real path is outside
  // node_modules, so ts-jest would otherwise try to "compile" their already-built
  // dist-cjs/dist-esm output.
  transformIgnorePatterns: ['/node_modules/', '/dist-cjs/', '/dist-esm/'],
  coverageDirectory: '../../coverage/packages/rab-server',
};
