import * as fs from 'fs';
import * as path from 'path';

/**
 * Static repository check: the retired fixture password must never return.
 *
 * The retired fixture password was a constant tracked in git and was accepted by real production accounts (incident
 * 2026-10-05, section 18.1). This check fails the build if that phrase appears in any text file in the repository.
 * The phrase is assembled at runtime so this file does not contain it.
 *
 * Fixture accounts now get a random password per run (helpers/fixture-password.ts). Nothing may store a password literal.
 */
const RETIRED_PHRASE = ['correct', 'horse', 'battery', 'staple'].join(' ');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCAN_ROOTS = ['packages', 'docs', '.github', 'rab-workforce-architecture.md', 'CLAUDE.md'];
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '.yaml', '.yml', '.md', '.sh', '.sql', '.dart', '.html', '.txt', '.env.example']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'build', '.git', '.dart_tool', 'coverage', '.audit']);

function* walk(entry: string): Generator<string> {
  const stat = fs.statSync(entry);
  if (stat.isFile()) {
    yield entry;
    return;
  }
  for (const name of fs.readdirSync(entry)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(path.join(entry, name));
  }
}

describe('no static fixture password in the repository', () => {
  it('contains no file with the retired fixture password phrase', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = path.join(REPO_ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes(RETIRED_PHRASE)) offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
