/**
 * `yos add` must not describe two different outcomes with the same words, and
 * must not leave a component on disk that it failed to record.
 *
 * Both were real customer-visible defects on 2026-08-05: a feishu install with
 * no credentials printed "does not stay running" and then "installed
 * successfully!", and an install whose registration write failed left a skill
 * directory that made every later `yos add` refuse to continue.
 *
 * These are source-level guardrails: the surrounding install flow needs a live
 * pm2, a registry and a network, so the wiring is pinned here and the behavior
 * is verified on a real machine per release.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const addSource = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'add.js'), 'utf8');
const componentsSource = fs.readFileSync(path.join(ROOT, 'cli', 'lib', 'components.js'), 'utf8');

describe('yos add reports what actually happened', () => {
  it('does not print "installed successfully" when the service is not running', () => {
    // The success line has to be reachable only when no service failed.
    assert.match(addSource, /serviceRunning = Boolean\(svcResult\.success\)/);
    assert.match(addSource, /if \(serviceRunning === false\) \{/);
    assert.match(addSource, /is installed but not running yet/);

    const successLine = addSource.indexOf('installed successfully!');
    const guard = addSource.indexOf('if (serviceRunning === false)');
    assert.ok(guard > 0 && successLine > guard,
      'the success line must sit inside the outcome check, not before it');
  });

  it('still says "installed successfully" for a component with no service', () => {
    // A component that declares no service has nothing to run; null must not be
    // treated as failure, or every tool install would report a non-existent
    // problem.
    assert.match(addSource, /let serviceRunning = null;/);
    assert.doesNotMatch(addSource, /if \(!serviceRunning\) \{/);
  });
});

describe('a service that cannot run says what is missing and what to type', () => {
  it('names the values the component declared as required', () => {
    // The component's SKILL.md already lists them (FEISHU_APP_ID/SECRET). The
    // old message sent the user to read crash logs for something we knew.
    const branch = addSource.slice(
      addSource.indexOf('} else if (svcResult.crashLooping) {'),
      addSource.indexOf('// "installed successfully" directly under'),
    );
    assert.match(branch, /findUnsetRequiredConfig\(config\.required\)/);
    assert.match(branch, /Required and not set in ~\/yos\/\.env/);
    assert.match(branch, /yos start/);
    // Pin that it is imported from env.js, not the exact list of named imports:
    // the list grew on 2026-08-06 and an exact match would fail for a reason
    // that has nothing to do with what this test is protecting.
    assert.match(addSource, /import \{[^}]*findUnsetRequiredConfig[^}]*\} from '\.\.\/lib\/env\.js'/);
  });

  it('tells the user the loop was stopped, so "not running" is not read as "still trying"', () => {
    const branch = addSource.slice(
      addSource.indexOf('} else if (svcResult.crashLooping) {'),
      addSource.indexOf('// "installed successfully" directly under'),
    );
    assert.match(branch, /svcResult\.stopped/);
    assert.match(branch, /not restarting in the background/);
  });

  it('watches the process name the component declared', () => {
    // serviceName must be computed before the start call and handed to it —
    // registerService otherwise guesses "yos-<name>" and checks the wrong
    // process, which reports a healthy service as missing.
    const block = addSource.slice(
      addSource.indexOf("console.log(`\\n${heading('Starting service...')}`);"),
      addSource.indexOf('serviceRunning = Boolean(svcResult.success)'),
    );
    const nameAt = block.indexOf('const serviceName =');
    const startAt = block.indexOf('registerService({');
    assert.ok(nameAt >= 0 && startAt > nameAt,
      'the service name must be resolved before the service is started');
    assert.match(block, /serviceName,/);
  });
});

describe('a component that cannot be recorded is not left behind', () => {
  it('undoes the install when the registration write fails', () => {
    const registration = addSource.slice(
      addSource.indexOf('components[resolved.name] = componentEntry;'),
      addSource.indexOf('// Step 4: Create bin symlinks'),
    );
    assert.match(registration, /try \{\s*\n\s*saveComponents\(components\);/);
    assert.match(registration, /cleanup\(skillDir\)/);
    assert.match(registration, /fs\.rmSync\(dataDir/);
    assert.match(registration, /registration_failed/);
    assert.match(registration, /process\.exit\(1\)/);
    // The user must be told where to look, not handed a raw ENOENT stack.
    assert.match(registration, /is writable, then retry/);
  });

  it('creates the config directory before writing the registry', () => {
    // The original crash: ~/yos/.yos did not exist because init never finished,
    // and the write blew up after the component was already on disk.
    const save = componentsSource.slice(componentsSource.indexOf('export function saveComponents'));
    const mkdir = save.indexOf('mkdirSync(CONFIG_DIR');
    const write = save.indexOf('writeFileSync(COMPONENTS_FILE');
    assert.ok(mkdir > 0 && write > mkdir, 'the directory must be created before the write');
  });
});
