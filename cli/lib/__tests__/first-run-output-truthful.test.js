/**
 * The first screen a new machine shows must not name things that do not exist.
 *
 * Two real defects on a fresh 0.1.10 install (TD-121, TD-122), both found by
 * following the product's own output on a clean machine:
 *
 *   1. `yos init` ended with "Next steps: yos add telegram / yos add lark".
 *      Neither is on the shelf — the shelf holds weixin and feishu — so the
 *      documented first action answered "✗ Unknown component" and exited 1.
 *   2. The same screen advertised "Network: http://<lan-ip>:3456/" while the
 *      console binds 127.0.0.1. Anyone who used the address it printed got
 *      connection refused and reasonably concluded the product was broken.
 *
 * Both are the same failure: the product stating something about itself that
 * is not true. These tests pin the truthfulness, not the wording.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecordedConsoleBind, bindReachableOffBox } from '../web-console-port.js';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Components this repo actually ships. Grow this list when the shelf grows. */
const SHIPPED_COMPONENTS = ['weixin', 'feishu'];

/**
 * Things that name no particular component: flags, paths, URLs, angle-bracket
 * placeholders, and values the code substitutes at runtime (`${name}` — those
 * are whatever the user typed, not a claim this repo is making).
 */
const NOT_A_COMPONENT_NAME = /^(\$|\{|<|-|\.|https?:|[\w.-]+\/)/;

function readCliSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(CLI_DIR);
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

describe('first-run output names only things that exist (TD-121)', () => {
  it('every `yos add/upgrade/remove/uninstall/info <name>` example names a shipped component', () => {
    const offenders = [];
    const pattern = /yos (?:add|upgrade|remove|uninstall|info) ([^\s'`"]+)/g;

    for (const { file, text } of readCliSources()) {
      for (const [, raw] of text.matchAll(pattern)) {
        const name = raw.replace(/@.*$/, '');
        if (NOT_A_COMPONENT_NAME.test(name)) continue;
        if (SHIPPED_COMPONENTS.includes(name)) continue;
        offenders.push(`${path.relative(CLI_DIR, file)}: "yos ... ${raw}"`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('the init Next steps block points at shipped channels', () => {
    const initSource = fs.readFileSync(path.join(CLI_DIR, 'commands', 'init.js'), 'utf8');
    const nextSteps = initSource.slice(initSource.indexOf("heading('Next steps:')"));
    assert.ok(nextSteps.includes('yos add weixin'), 'Next steps must offer weixin');
    assert.ok(nextSteps.includes('yos add feishu'), 'Next steps must offer feishu');
    assert.ok(!nextSteps.includes('yos add telegram'), 'telegram is not on the shelf');
    assert.ok(!nextSteps.includes('yos add lark'), 'lark is not on the shelf');
  });
});

describe('the console URL it prints is one that answers (TD-122)', () => {
  it('a loopback bind is never advertised as reachable off-box', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '']) {
      assert.equal(bindReachableOffBox(host), false, `${host} must not be advertised`);
    }
  });

  it('a bind that does reach off-box is reported as such', () => {
    for (const host of ['0.0.0.0', '::', '10.1.4.5', '192.168.1.7']) {
      assert.equal(bindReachableOffBox(host), true, `${host} does reach off-box`);
    }
  });

  it('the recorded bind defaults to what the server itself defaults to', () => {
    const serverSource = fs.readFileSync(
      path.join(CLI_DIR, '..', 'skills', 'web-console', 'scripts', 'server.js'),
      'utf8',
    );
    // Pin the two to each other: if the server's default bind ever changes,
    // this fails rather than letting init quietly print the wrong advice.
    assert.match(serverSource, /WEB_CONSOLE_BIND\s*\|\|\s*'127\.0\.0\.1'/);
    assert.equal(readRecordedConsoleBind({ envFile: '/nonexistent', env: {} }), '127.0.0.1');
  });

  it('init guards the Network line behind the actual bind', () => {
    const initSource = fs.readFileSync(path.join(CLI_DIR, 'commands', 'init.js'), 'utf8');
    const banner = initSource.slice(initSource.indexOf('Web Console'));
    // The guard, not the wording: printing `Network:` must be conditional on
    // the bind being reachable off-box.
    assert.match(banner, /bindReachableOffBox\([^)]*\)\s*&&[^\n]*\n\s*console\.log\(`\s*Network:/);
  });
});
