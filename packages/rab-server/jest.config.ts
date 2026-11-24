export default {
  displayName: 'rab-server',
  preset: '../../jest.preset.js',
  transform: {
    // CI audit 2026-11-12 (S3): `isolatedModules: true`, i.e. transpile only, exactly as rab-worker's jest.config.ts.
    // Type-safety is `rab-server:lint`'s job: `tsc --noEmit` over BOTH tsconfig.app.json and tsconfig.spec.json
    // (project.json), which ci-server runs before the suites. Full ts-jest type-checking re-checked the app while loading
    // the first test file of every run (about 135 s of a cold first file) and part of every AppModule file after it. The
    // emitted code is what the server already runs on (`ts-node --transpile-only`), decorator metadata included.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', isolatedModules: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // Fails the whole run before any fixture is written unless TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL (or its deprecated
  // name TEST_DATABASE_URL_UNPOOLED) are set and agree
  // (see src/jest-global-setup.ts and src/database/typeorm/core/test-database-guard.ts).
  globalSetup: '<rootDir>/src/jest-global-setup.ts',
  setupFiles: ['<rootDir>/src/jest-setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/jest-probe.ts'],
  // Part C1 (C1b): node, plus dropping the workspace schemas a test file's fixtures created once the file is done, so one
  // shared in-band database does not accumulate hundreds of schemas (CREWFLOW_TEST_KEEP_FIXTURE_SCHEMAS=true keeps them).
  testEnvironment: '<rootDir>/src/__tests__/integration/helpers/fixture-schema-cleanup-environment.ts',
  // Default node_modules exclusion doesn't match workspace packages resolved
  // through a symlink (@rab/shared, @rab/ui) — their real path is outside
  // node_modules, so ts-jest would otherwise try to "compile" their already-built
  // dist-cjs/dist-esm output.
  transformIgnorePatterns: ['/node_modules/', '/dist-cjs/', '/dist-esm/'],
  // Opt-in load tests (RAB_LOAD_TEST=1, see src/__tests__/load) never run in the default suite.
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/load/'],
  coverageDirectory: '../../coverage/packages/rab-server',
};
