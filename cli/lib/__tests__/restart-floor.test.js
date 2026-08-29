import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { RESTART_FLOOR, applyRestartFloor, parseUptimeMs } from '../restart-policy.js';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../templates/pm2/ecosystem.config.cjs',
);

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('the restart floor', () => {
  it('supplies min_uptime whenever it is missing', () => {
    // The whole point: max_restarts without min_uptime never fires, because pm2
    // only counts restarts that happened sooner than min_uptime (default 1s).
    // Both channels shipped exactly this config and restarted without end.
    const floored = applyRestartFloor({ name: 'yos-feishu', max_restarts: 10 });
    assert.equal(floored.min_uptime, RESTART_FLOOR.min_uptime);
    assert.equal(floored.max_restarts, 10);
  });

  it('raises a min_uptime that is too short to make the cap bite', () => {
    assert.equal(applyRestartFloor({ min_uptime: '1s' }).min_uptime, RESTART_FLOOR.min_uptime);
    assert.equal(applyRestartFloor({ min_uptime: 500 }).min_uptime, RESTART_FLOOR.min_uptime);
  });

  it('leaves a stricter setting alone', () => {
    assert.equal(applyRestartFloor({ min_uptime: '60s' }).min_uptime, '60s');
    assert.equal(applyRestartFloor({ max_restarts: 3 }).max_restarts, 3);
  });

  it('caps a component that asks for more restarts than the floor allows', () => {
    assert.equal(applyRestartFloor({ max_restarts: 999 }).max_restarts, RESTART_FLOOR.max_restarts);
    assert.equal(applyRestartFloor({ max_restarts: 'lots' }).max_restarts, RESTART_FLOOR.max_restarts);
    assert.equal(applyRestartFloor({}).max_restarts, RESTART_FLOOR.max_restarts);
  });

  it('leaves a component that opts out of restarting untouched', () => {
    // autorestart:false cannot loop, and forcing a cap on it would be a lie
    // about what pm2 will do.
    const app = { autorestart: false, max_restarts: 999 };
    assert.deepEqual(applyRestartFloor(app), app);
  });

  it('does not mutate the config it was handed', () => {
    // The ecosystem file applies this to objects that came out of require(),
    // which are cached and shared.
    const app = { name: 'yos-demo', max_restarts: 999 };
    applyRestartFloor(app);
    assert.equal(app.max_restarts, 999);
  });

  it('reads pm2 uptime spellings', () => {
    assert.equal(parseUptimeMs('10s'), 10_000);
    assert.equal(parseUptimeMs('2m'), 120_000);
    assert.equal(parseUptimeMs('1500'), 1500);
    assert.equal(parseUptimeMs(1500), 1500);
    assert.equal(parseUptimeMs('1500ms'), 1500);
    assert.equal(parseUptimeMs('soon'), null);
    assert.equal(parseUptimeMs(undefined), null);
  });
});

/**
 * Build a fake YOS home with one installed component, then evaluate the real
 * ecosystem template against it. This is the path a reboot takes — no CLI
 * involved — so it is the one that has to hold the floor on its own.
 */
function loadTemplateApps(componentFiles) {
  const home = makeTempDir('yos-eco-test-');
  tmpDirs.push(home);

  const skillDir = path.join(home, 'yos', '.claude', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'yos', '.yos'), { recursive: true });
  for (const [name, content] of Object.entries(componentFiles)) {
    fs.writeFileSync(path.join(skillDir, name), content);
  }
  fs.writeFileSync(
    path.join(home, 'yos', '.yos', 'components.json'),
    JSON.stringify({ demo: { skillDir, dataDir: path.join(home, 'yos', 'components', 'demo') } }),
  );

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve(TEMPLATE_PATH)];
    return require(TEMPLATE_PATH).apps;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete require.cache[require.resolve(TEMPLATE_PATH)];
  }
}

describe('the ecosystem file holds the floor for component services', () => {
  it('floors a component that brought its own pm2 config', () => {
    // A component's ecosystem.config.cjs is copied into the process list almost
    // verbatim. That copy is what ran 128 restarts and counting on a customer
    // machine, because the component declared a cap and no min_uptime.
    const apps = loadTemplateApps({
      'ecosystem.config.cjs': `module.exports = { apps: [{ name: 'yos-demo', script: 'src/index.js', autorestart: true, max_restarts: 10 }] };\n`,
    });

    const demo = apps.find((app) => app.name === 'yos-demo');
    assert.ok(demo, 'component service missing from the ecosystem');
    assert.equal(demo.min_uptime, RESTART_FLOOR.min_uptime);
    assert.equal(demo.max_restarts, RESTART_FLOOR.max_restarts);
  });

  it('floors a component that asks for an unbounded-in-practice cap', () => {
    const apps = loadTemplateApps({
      'ecosystem.config.cjs': `module.exports = { apps: [{ name: 'yos-demo', script: 'src/index.js', max_restarts: 5000, min_uptime: '200ms' }] };\n`,
    });

    const demo = apps.find((app) => app.name === 'yos-demo');
    assert.equal(demo.max_restarts, RESTART_FLOOR.max_restarts);
    assert.equal(demo.min_uptime, RESTART_FLOOR.min_uptime);
  });

  it('floors a component that declared its service in SKILL.md only', () => {
    const apps = loadTemplateApps({
      'SKILL.md': [
        '---',
        'name: demo',
        'lifecycle:',
        '  service:',
        '    type: pm2',
        '    name: yos-demo',
        '    entry: src/index.js',
        '---',
        '',
        '# Demo',
      ].join('\n'),
    });

    const demo = apps.find((app) => app.name === 'yos-demo');
    assert.ok(demo, 'component service missing from the ecosystem');
    assert.equal(demo.min_uptime, RESTART_FLOOR.min_uptime);
    assert.equal(demo.max_restarts, RESTART_FLOOR.max_restarts);
  });

  it('keeps the template floor identical to the CLI floor', () => {
    // The template cannot import the CLI — it is a standalone file in the
    // user's home that pm2 evaluates with only builtins. Two copies of the
    // policy drift silently; this is what notices.
    const source = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const match = source.match(/const RESTART_FLOOR = \{([^}]*)\}/);
    assert.ok(match, 'the ecosystem template no longer declares a restart floor');
    assert.match(match[1], new RegExp(`max_restarts:\\s*${RESTART_FLOOR.max_restarts}\\b`));
    assert.match(match[1], new RegExp(`min_uptime:\\s*'${RESTART_FLOOR.min_uptime}'`));
    assert.match(match[1], new RegExp(`min_uptime_ms:\\s*${RESTART_FLOOR.min_uptime_ms}\\b`));
  });
});
