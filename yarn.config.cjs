// @ts-check
/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types');

module.exports = defineConfig({
  constraints: async ({ Yarn }) => {
    // Every workspace must depend on the same version of a given dependency.
    for (const dependency of Yarn.dependencies()) {
      if (dependency.type === 'peerDependencies') continue;

      for (const otherDependency of Yarn.dependencies({ ident: dependency.ident })) {
        if (otherDependency.type === 'peerDependencies') continue;
        dependency.update(otherDependency.range);
      }
    }

    // Workspaces must not depend on prerelease or `workspace:*`-unsafe ranges in prod deps.
    for (const workspace of Yarn.workspaces()) {
      if (workspace.pkg.version == null) {
        workspace.set('version', '0.0.0');
      }
    }
  },
});
