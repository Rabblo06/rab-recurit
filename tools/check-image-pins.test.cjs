'use strict';
// node --test tools/check-image-pins.test.cjs
//
// The image-pin gate: the denials (a tag alone, an expression, an unknown docker option, two digests for one tag, a bad
// manifest), the accepted forms, ref.sh's own refusals, and the real repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, dockerImages } = require('./check-image-pins.cjs');

const ROOT = path.resolve(__dirname, '..');
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const REDIS = `redis:7-alpine@sha256:${D1}`;
const toPosix = (p) => p.split(path.sep).join('/');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-pins-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const manifest = (ref) => `# pinned\nimage: ${ref}\n`;
const wf = (jobBody) =>
  `name: t\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n${jobBody}`;
const services = (image) =>
  `    services:\n      redis:\n        image: ${image}\n    steps:\n      - run: echo\n`;
const runStep = (script, env = '') =>
  `    steps:\n      - name: s\n${env}        run: |\n${script
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n')}\n`;

function problems(files) {
  return check(tree(files)).problems;
}

test('pinned service, container and manifest images pass', () => {
  const p = problems({
    '.github/workflows/a.yaml': wf(
      `    container:\n      image: mcr.microsoft.com/playwright:v1.0.0-noble@sha256:${D2}\n${services(REDIS)}`,
    ),
    '.github/ci-images/redis/image.yaml': manifest(REDIS),
  });
  assert.deepEqual(p, []);
});

test('a service image with only a tag fails (the denial this gate exists for)', () => {
  const p = problems({
    '.github/workflows/a.yaml': wf(services('redis:7-alpine')),
  });
  assert.equal(p.length, 1);
  assert.match(
    p[0],
    /^\.github\/workflows\/a\.yaml:8: \.jobs\.j\.services\.redis\.image redis:7-alpine is not pinned by digest/,
  );
});

test('container shorthand, container.image and expressions fail', () => {
  assert.match(
    problems({
      '.github/workflows/a.yaml': wf(
        '    container: node:22\n    steps:\n      - run: echo\n',
      ),
    })[0],
    /container node:22 is not pinned/,
  );
  assert.match(
    problems({
      '.github/workflows/a.yaml': wf(
        '    container:\n      image: node:22\n    steps:\n      - run: echo\n',
      ),
    })[0],
    /container\.image node:22 is not pinned/,
  );
  assert.match(
    problems({
      '.github/workflows/a.yaml': wf(services('redis:${{ matrix.v }}')),
    })[0],
    /is an expression/,
  );
  // a digest after an expression is still an expression: nothing proves which image it is
  assert.match(
    problems({
      '.github/workflows/a.yaml': wf(services('${{ vars.IMG }}@sha256:' + D1)),
    })[0],
    /is an expression/,
  );
});

test('composite actions are scanned too', () => {
  const action =
    'name: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: docker run -d --name x postgres:16-alpine\n';
  const p = problems({ '.github/actions/x/action.yml': action });
  assert.equal(p.length, 1);
  assert.match(
    p[0],
    /action\.yml:6: docker image postgres:16-alpine is not pinned by digest/,
  );
});

test('docker run/create/pull: literal tags and expressions fail, pinned literals pass', () => {
  const bad = [
    'docker run -d --name r -p 127.0.0.1:6390:6379 redis:7-alpine redis-server',
    'docker pull redis:7-alpine',
    'docker container run --rm redis:7-alpine',
    'docker image pull redis',
    'docker create redis:7-alpine',
    'docker run -d \\\n  -e A=1 \\\n  "postgres:${{ matrix.pg }}-alpine" -c x=1',
    'true && docker run --rm "$UNSET_IMAGE"',
  ];
  for (const s of bad) {
    const p = problems({ '.github/workflows/a.yaml': wf(runStep(s)) });
    assert.equal(p.length, 1, `${s}: ${p}`);
  }
  const ok = [
    `docker run -d --name r -v "/a b:/c:ro" -e X=1 --health-cmd "redis-cli ping" ${REDIS} redis-server --save ""`,
    `docker pull ${REDIS}`,
    `docker run --platform=linux/amd64 --rm ${REDIS}`,
  ];
  for (const s of ok)
    assert.deepEqual(
      problems({ '.github/workflows/a.yaml': wf(runStep(s)) }),
      [],
      s,
    );
});

test('an unknown docker option is refused rather than guessed past', () => {
  const p = problems({
    '.github/workflows/a.yaml': wf(
      runStep(`docker run --mystery value ${REDIS}`),
    ),
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /option --mystery is not known/);
});

test('"$VAR" from ref.sh in the same script passes; a literal name must exist', () => {
  const files = {
    '.github/ci-images/postgres-16/image.yaml': manifest(
      `postgres:16-alpine@sha256:${D1}`,
    ),
  };
  const viaRef =
    'img="$(bash .github/ci-images/ref.sh "postgres-${{ matrix.pg }}")"\ndocker run -d "${img}" -c a=b';
  assert.deepEqual(
    problems({ ...files, '.github/workflows/a.yaml': wf(runStep(viaRef)) }),
    [],
  );
  const ws =
    'img="$(bash "${GITHUB_WORKSPACE}/.github/ci-images/ref.sh" postgres-16)"\ndocker run -d "$img"';
  assert.deepEqual(
    problems({ ...files, '.github/workflows/a.yaml': wf(runStep(ws)) }),
    [],
  );
  const missing =
    'img="$(bash .github/ci-images/ref.sh postgres-99)"\ndocker run -d "$img"';
  assert.match(
    problems({ ...files, '.github/workflows/a.yaml': wf(runStep(missing)) })[0],
    /ref\.sh postgres-99 has no \.github\/ci-images\/postgres-99/,
  );
  const otherScript =
    'img="$(curl -s https://example.invalid/image)"\ndocker run -d "$img"';
  assert.match(
    problems({
      ...files,
      '.github/workflows/a.yaml': wf(runStep(otherScript)),
    })[0],
    /neither set from \.github\/ci-images\/ref\.sh/,
  );
});

test('"$VAR" from env: pinned literal passes, tag or expression fails', () => {
  const s = 'docker pull "$IMG"';
  assert.deepEqual(
    problems({
      '.github/workflows/a.yaml': wf(
        `    env:\n      IMG: postgres@sha256:${D1}\n${runStep(s)}`,
      ),
    }),
    [],
  );
  assert.deepEqual(
    problems({
      '.github/workflows/a.yaml': wf(
        runStep(s, `        env:\n          IMG: ${REDIS}\n`),
      ),
    }),
    [],
  );
  assert.equal(
    problems({
      '.github/workflows/a.yaml': wf(
        `    env:\n      IMG: postgres:16\n${runStep(s)}`,
      ),
    }).length,
    1,
  );
  assert.equal(
    problems({
      '.github/workflows/a.yaml': wf(
        `    env:\n      IMG: \${{ inputs.image }}\n${runStep(s)}`,
      ),
    }).length,
    1,
  );
});

test('two digests for the same tag across .github fail (a partial Dependabot update)', () => {
  const p = problems({
    '.github/workflows/a.yaml': wf(services(REDIS)),
    '.github/ci-images/redis/image.yaml': manifest(
      `redis:7-alpine@sha256:${D2}`,
    ),
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /^redis:7-alpine is pinned to 2 different digests/);
});

test('a ci-images manifest needs exactly one key, image, with a tag and a digest', () => {
  assert.match(
    problems({
      '.github/ci-images/redis/image.yaml': manifest(`redis@sha256:${D1}`),
    })[0],
    /the tag lets Dependabot renew/,
  );
  assert.match(
    problems({
      '.github/ci-images/redis/image.yaml': `image: ${REDIS}\nother: 1\n`,
    })[0],
    /exactly one key, image/,
  );
  assert.match(
    problems({ '.github/ci-images/redis/other.yaml': manifest(REDIS) })[0],
    /exactly one key, image/,
  );
  assert.match(
    problems({ '.github/ci-images/redis/image.yaml': 'image: [unclosed\n' })[0],
    /not parseable YAML/,
  );
});

test('dockerImages ignores docker exec / compose and comments', () => {
  assert.deepEqual(
    dockerImages(
      'docker exec pg pg_isready\ndocker compose pull\n# docker run redis:7\necho docker run-ish',
    ),
    [],
  );
});

test('ref.sh prints the pinned reference and refuses bad names, missing and unpinned manifests', (t) => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.error || bash.status !== 0) {
    if (process.env.CI) assert.fail('bash is on every GitHub runner');
    t.skip('bash not available');
    return;
  }
  const dir = tree({
    '.github/ci-images/redis/image.yaml': manifest(REDIS),
    '.github/ci-images/tagless/image.yaml': manifest(`redis@sha256:${D1}`),
    '.github/ci-images/two/image.yaml': `image: ${REDIS}\nimage: ${REDIS}\n`,
  });
  fs.copyFileSync(
    path.join(ROOT, '.github/ci-images/ref.sh'),
    path.join(dir, '.github/ci-images/ref.sh'),
  );
  const ref = (name) =>
    spawnSync(
      'bash',
      [toPosix(path.join(dir, '.github/ci-images/ref.sh')), name],
      { encoding: 'utf8' },
    );
  const ok = ref('redis');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${REDIS}\n`);
  for (const name of ['', '../redis', 'x;y', 'missing', 'tagless', 'two']) {
    const r = ref(name);
    assert.notEqual(r.status, 0, name);
    assert.equal(r.stdout, '', name);
  }
});

test('the repository passes, and the five CI image manifests exist', () => {
  const r = check(ROOT);
  assert.deepEqual(r.problems, []);
  assert.ok(r.images >= 10 && r.dockerCmds >= 5, JSON.stringify(r));
  for (const name of [
    'redis',
    'postgres-15',
    'postgres-16',
    'postgres-17',
    'postgres-18',
  ]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, '.github/ci-images', name, 'image.yaml')),
      name,
    );
  }
});
