/**
 * Test-only module mapping (jest.config.ts `moduleNameMapper`): @react-pdf/renderer is published as ESM only, and Jest
 * 29's own CommonJS module runtime cannot load an ES module. Production needs no such step — the Worker's compiled
 * CommonJS `require('@react-pdf/renderer')` is served by Node's require(esm) (Node >= 22.12; the image runs Node 24).
 * Here the SAME, untransformed package is loaded by Node's real loader (not Jest's), so the specs exercise exactly the
 * code production runs. `process.getBuiltinModule` is used because Jest replaces the `module` builtin it hands to tests.
 *
 * Caveat: the package then runs in Node's realm while the spec (and the layout code it imports) runs in Jest's, so an
 * `instanceof` check inside react-pdf/pdfkit against a test-realm built-in fails. MEASURED for `Date`: a creationDate
 * built in the test realm is written as `Date.toString()` instead of `(D:…Z)`. Buffers are unaffected (Jest shares
 * Node's Buffer). Assert such values outside Jest (the Worker-image run) or through the worker-thread entry.
 */
const nodeModule = process.getBuiltinModule('node:module') as typeof import('module');

export = nodeModule.createRequire(__filename)('@react-pdf/renderer');
