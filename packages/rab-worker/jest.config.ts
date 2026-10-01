export default {
  displayName: 'rab-worker',
  preset: '../../jest.preset.js',
  transform: {
    // `isolatedModules: true` — type-safety is `rab-worker:lint`'s job (plain
    // `tsc --noEmit`, which already passes cleanly); ts-jest's own
    // full-program type-checking does not correctly follow this package's
    // `NodeNext` + `@rab/server` package.json `exports`-map resolution (a
    // known ts-jest limitation with the newer module-resolution modes,
    // distinct from plain `tsc`, which resolves them correctly) — per the
    // same "test = jest, types = tsc" split this monorepo's other packages
    // already use (see rab-server's own README entry for `yarn lint` vs
    // `yarn test`).
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', isolatedModules: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  setupFiles: ['<rootDir>/src/jest-setup.ts'],
  // Same reasoning as rab-server's own jest.config.ts: @rab/shared/@rab/ui
  // resolve through a workspace symlink outside node_modules, so ts-jest
  // must not try to re-"compile" their already-built dist output; @rab/server
  // is the same case for this package specifically (its compiled dist/*.js
  // + dist/*.d.ts is what this package's imports actually resolve to).
  transformIgnorePatterns: ['/node_modules/', '/dist-cjs/', '/dist-esm/', '/rab-server/dist/'],
  // Opt-in load tests (RAB_LOAD_TEST=1, see src/__tests__/load) never run in the default suite — same convention as rab-server's own jest.config.ts.
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/load/'],
  coverageDirectory: '../../coverage/packages/rab-worker',
};
