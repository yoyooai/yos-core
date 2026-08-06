/**
 * `yos self-uninstall` ran `npm uninstall -g @anthropic-ai/claude-code` and
 * deleted ~/.claude, then reported success. But the runtime is normally put
 * there by claude.ai/install.sh, which npm has never heard of — so the binary
 * was still in the account and still on PATH after an "uninstall". (TD-62 ④)
 *
 * These tests pin the artifact list, and pin that the uninstall command actually
 * consults it and then checks the machine instead of trusting itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { claudeNativeArtifacts } from '../runtime-setup.js';

describe('claudeNativeArtifacts', () => {
  it('names the launcher on PATH and the versioned payload it points at', () => {
    const paths = claudeNativeArtifacts('/home/cust');
    assert.deepEqual(paths, [
      '/home/cust/.local/bin/claude',
      '/home/cust/.local/share/claude',
    ]);
  });

  it('is rooted in the home it is given, not the current process home', () => {
    // The uninstall runs as the account being removed; hardcoding os.homedir()
    // inside the helper would make it untestable and wrong under sudo.
    for (const p of claudeNativeArtifacts('/tmp/probe-home')) {
      assert.ok(p.startsWith('/tmp/probe-home/'), `${p} must live under the given home`);
    }
  });

  it('⭐ includes the launcher itself — this is the file that stays on PATH', () => {
    // Removing only the payload directory leaves a dangling symlink named
    // `claude` on PATH, which is the same "uninstalled but still there"
    // complaint in a different shape.
    assert.ok(claudeNativeArtifacts('/home/cust').some((p) => p.endsWith('/.local/bin/claude')));
  });
});

describe('self-uninstall actually uses it', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'commands', 'self-uninstall.js'), 'utf8',
  );

  it('imports the artifact list from the module that installs the runtime', () => {
    // One source of truth: whoever adds a native install path edits one file.
    assert.match(source, /import \{ claudeNativeArtifacts \} from '\.\.\/lib\/runtime-setup\.js'/);
  });

  it('removes every path the list returns', () => {
    assert.match(source, /for \(const target of claudeNativeArtifacts\(os\.homedir\(\)\)\)/);
  });

  it('uses a remover that copes with a dangling symlink', () => {
    // existsSync() follows a symlink and answers false for a dangling one —
    // precisely the state a half-removed native install leaves behind — so the
    // removal must not be guarded by an existence check.
    const fn = source.slice(source.indexOf('function removePath'), source.indexOf('function whichSilent'));
    assert.ok(fn.length > 0, 'removePath must exist');
    assert.match(fn, /rmSync\([^)]*force: true/);
    assert.doesNotMatch(fn, /existsSync/);
  });

  it('⭐ checks the machine afterwards instead of trusting its own exit codes', () => {
    assert.match(source, /whichSilent\('claude'\)/);
    assert.match(source, /still resolves to/);
  });
});
