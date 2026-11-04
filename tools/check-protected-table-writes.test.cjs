'use strict';
// node --test tools/check-protected-table-writes.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan, scanSource, stripComments, TABLES, ALLOWED } = require('./check-protected-table-writes.cjs');

const ENTITIES = new Map([
  ['UserSession', 'user_session'],
  ['MemberInvitation', 'member_invitation'],
]);
const rules = (src) => scanSource('x.ts', src, ENTITIES).map((s) => `${s.rule}:${s.table}:${s.line}`);

test('the seven protected tables are exactly the owner-accepted BC-18 list', () => {
  assert.deepEqual([...TABLES].sort(), [
    'email_change_request',
    'login_handoff',
    'member_invitation',
    'organisation_invitation',
    'released_host_label',
    'user_auth_identity',
    'user_session',
  ]);
});

test('raw SQL writes are found in every form: qualified, quoted, multi-line, TRUNCATE TABLE, MERGE, COPY', () => {
  assert.deepEqual(rules("q(`INSERT INTO core.member_invitation (a) VALUES ($1)`)"), ['sql-write:member_invitation:1']);
  assert.deepEqual(rules('q(`UPDATE\n   "core"."user_session"\n SET revoked_at = now()`)'), ['sql-write:user_session:1']);
  assert.deepEqual(rules("q('DELETE FROM email_change_request WHERE id = $1')"), ['sql-write:email_change_request:1']);
  assert.deepEqual(rules('q(`TRUNCATE TABLE core.login_handoff`)'), ['sql-write:login_handoff:1']);
  assert.deepEqual(rules('q(`TRUNCATE ONLY core.released_host_label`)'), ['sql-write:released_host_label:1']);
  assert.deepEqual(rules('q(`MERGE INTO core.user_auth_identity t USING x ON true`)'), ['sql-write:user_auth_identity:1']);
  assert.deepEqual(rules('q(`COPY core.organisation_invitation FROM STDIN`)'), ['sql-write:organisation_invitation:1']);
});

test('reads, other tables, look-alike names and comments are not flagged', () => {
  assert.deepEqual(rules('q(`SELECT * FROM core.user_session WHERE id = $1`)'), []);
  assert.deepEqual(rules('q(`UPDATE core.refresh_token SET revoked_at = now()`)'), []);
  assert.deepEqual(rules('q(`UPDATE core.user_session_archive SET x = 1`)'), []);
  assert.deepEqual(rules('// UPDATE core.user_session SET revoked_at = now()\nconst a = 1;'), []);
  assert.deepEqual(rules('/* DELETE FROM core.member_invitation */ const a = 1;'), []);
  assert.equal(stripComments('a // DELETE FROM x\nb').split('\n').length, 2);
});

test('ORM writes on a protected entity are flagged; reads are not', () => {
  assert.deepEqual(rules('manager.delete(UserSession, { id })'), ['orm-write:user_session:1']);
  assert.deepEqual(rules('manager.save(MemberInvitation, row)'), ['orm-write:member_invitation:1']);
  assert.deepEqual(rules('ds.getRepository(UserSession)'), ['orm-write:user_session:1']);
  assert.deepEqual(rules('@InjectRepository(MemberInvitation) private readonly r'), ['orm-write:member_invitation:1']);
  assert.deepEqual(rules('qb.update(UserSession).set({ revokedAt: new Date() })'), ['orm-write:user_session:1']);
  assert.deepEqual(rules('qb.insert().into(MemberInvitation).values(v)'), ['orm-write:member_invitation:1']);
  assert.deepEqual(rules('manager.findOne(UserSession, { where: { id } })'), []);
  assert.deepEqual(rules("manager.createQueryBuilder(UserSession, 'us').where('x')"), []);
});

test('scan(): a write in an allow-listed owning file passes; the same write in a new file fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptw-'));
  const dir = path.join(root, 'packages', 'rab-server', 'src', 'modules', 'x');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'rab-worker', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.service.ts'), 'q(`DELETE FROM core.member_invitation WHERE id = $1`)');
  fs.writeFileSync(path.join(dir, 'rogue.service.ts'), 'q(`DELETE FROM core.member_invitation WHERE id = $1`)');
  fs.writeFileSync(path.join(dir, 'rogue.service.spec.ts'), 'q(`DELETE FROM core.member_invitation`)');
  fs.writeFileSync(
    path.join(dir, 'member-invitation.entity.ts'),
    "@Entity({ name: 'member_invitation', schema: 'core' })\nexport class MemberInvitation {}",
  );
  fs.writeFileSync(path.join(dir, 'orm.service.ts'), 'await manager.remove(MemberInvitation, row);');
  try {
    const allowed = { 'packages/rab-server/src/modules/x/owner.service.ts': ['member_invitation'] };
    const { sites, entities } = scan(root, allowed);
    assert.equal(entities.get('MemberInvitation'), 'member_invitation');
    const verdicts = sites.map((s) => `${s.file.split('/').pop()}:${s.rule}:${s.allowed}`).sort();
    assert.deepEqual(verdicts, ['orm.service.ts:orm-write:false', 'owner.service.ts:sql-write:true', 'rogue.service.ts:sql-write:false']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the committed tree has no write outside the reviewed owning code, and every allow-list entry is still used', () => {
  const { sites } = scan();
  assert.deepEqual(sites.filter((s) => !s.allowed).map((s) => `${s.file}:${s.line}`), []);
  for (const [file, tables] of Object.entries(ALLOWED)) {
    for (const t of tables) assert.ok(sites.some((s) => s.file === file && s.table === t), `stale allow-list entry ${file} → ${t}`);
  }
});
