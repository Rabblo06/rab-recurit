import * as fs from 'fs';
import * as path from 'path';

/**
 * T4-X1 — static guarantee G1 (docs/ai/PHASE4_TWENTY_PLAN.md §2.5): skills are instructions only and can never reach the
 * tool set. Nothing under `modules/ai/skills/`, and not `services/ai-skill.service.ts`, imports
 *   - the tool registry (`ai-tool-registry.service`), the tool definitions (`ai-tool-definitions`, `tools/read/*`,
 *     `define-tool.decorator`, `ai-meta-tools`, `ai-tool.types`), the AI SDK's `tool()` helper (`from 'ai'`), or
 *   - `PermissionsService` (and does not name `AI_TOOL_PERMISSION_FLAGS` or `userHasPermission`).
 * The CEO-only `ai.settings` re-check lives in `services/ai-settings-authority.service.ts`, which answers one yes/no
 * question and returns nothing. There is no ESLint here ("lint" = tsc), so this is a jest scan of the sources.
 */
const AI_DIR = path.resolve(__dirname, '../../modules/ai');
const SCANNED = [
  ...fs
    .readdirSync(path.join(AI_DIR, 'skills'), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => path.join(d.parentPath, d.name)),
  path.join(AI_DIR, 'services/ai-skill.service.ts'),
];

const FORBIDDEN_IMPORTS: Array<[string, RegExp]> = [
  ['the tool registry', /from\s+['"][^'"]*ai-tool-registry(\.service)?['"]/],
  ['the tool definitions', /from\s+['"][^'"]*(ai-tool-definitions|\/read\/|define-tool\.decorator|ai-meta-tools|ai-tool\.types|ai-tool\.constants)[^'"]*['"]/],
  ['the AI SDK (tool())', /from\s+['"]ai['"]/],
  ['PermissionsService', /from\s+['"][^'"]*permissions\.service['"]/],
  ['PermissionsService (name)', /\bPermissionsService\b/],
  ['the tool permission flags', /\bAI_TOOL_PERMISSION_FLAGS\b/],
  ['a permission resolver', /\buserHasPermission(Tx)?\b/],
  ['a require() escape hatch', /\brequire\s*\(/],
];

describe('T4-X1 skills grant nothing (static)', () => {
  it('finds the skills sources and the service', () => {
    const rel = SCANNED.map((f) => path.relative(AI_DIR, f).replace(/\\/g, '/'));
    expect(rel).toEqual(expect.arrayContaining(['skills/builtin-skills.ts', 'skills/skill-content-rules.ts', 'skills/skill-catalogue.ts', 'skills/load-skills.tool.ts', 'services/ai-skill.service.ts']));
  });

  it.each(SCANNED.map((f) => [path.relative(AI_DIR, f).replace(/\\/g, '/'), f] as const))('%s imports no registry, tool definition or PermissionsService', (_rel, file) => {
    // Code only: comments may (and do) explain the rule by naming what is forbidden.
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = FORBIDDEN_IMPORTS.filter(([, re]) => re.test(text)).map(([what]) => what);
    expect(hits).toEqual([]);
  });

  it('the write gate the service uses exposes one void assertion and nothing else', () => {
    const text = fs.readFileSync(path.join(AI_DIR, 'services/ai-settings-authority.service.ts'), 'utf8');
    const publicMethods = [...text.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z]+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'constructor');
    expect(publicMethods).toEqual(['assertSettingsWriterTx']);
    expect(text).toMatch(/assertSettingsWriterTx\(m: EntityManager, ctx: AuthContext\): Promise<void>/);
  });
});
