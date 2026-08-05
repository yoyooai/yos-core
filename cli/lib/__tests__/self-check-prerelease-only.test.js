/**
 * While YOS is pre-1.0 every release is a prerelease, and `yos upgrade --self
 * --check` answered "No release tags found" and exited 1 — untrue (four
 * releases existed) and dead-ended (it named no way forward). Upgrading onto a
 * prerelease stays opt-in; only the reporting changed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const selfUpgrade = fs.readFileSync(path.join(ROOT, 'cli', 'lib', 'self-upgrade.js'), 'utf8');
const componentCommand = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'component.js'), 'utf8');

describe('a prerelease-only release line is reported, not treated as missing', () => {
  it('looks for a prerelease before reporting that nothing was found', () => {
    const resolver = selfUpgrade.slice(
      selfUpgrade.indexOf('// Default: tag-based detection'),
      selfUpgrade.indexOf('// Public: checkForCoreUpdates'),
    );
    const fallback = resolver.indexOf('includePrerelease: true');
    const giveUp = resolver.indexOf('No releases found in');
    assert.ok(fallback > 0, 'a prerelease lookup must exist');
    assert.ok(giveUp > fallback, 'giving up must come after looking for a prerelease');
    // The old message may only survive as history in a comment.
    const runnable = resolver.split('\n').filter(line => !/^\s*(\/\/|\*)/.test(line)).join('\n');
    assert.doesNotMatch(runnable, /No release tags found/);
    assert.match(resolver, /prereleaseOnly: true/);
  });

  it('keeps upgrading onto a prerelease opt-in', () => {
    // The fallback only reports; it must not flip the beta flag that decides
    // what actually gets installed.
    const resolver = selfUpgrade.slice(
      selfUpgrade.indexOf('// Default: tag-based detection'),
      selfUpgrade.indexOf('// Public: checkForCoreUpdates'),
    );
    assert.match(resolver, /if \(!beta\) \{/);
    assert.match(resolver, /yos upgrade --self --beta/);
  });

  it('names the flag that would actually install what it just reported', () => {
    assert.match(componentCommand, /yos upgrade --self --beta --yes/);
    assert.match(componentCommand, /if \(check\.prereleaseOnly\) console\.log\(dim\(check\.note\)\)/);
  });
});
